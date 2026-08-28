/**
 * Sleeper headshot cache.
 *
 * Headshots are a nice-to-have: the template already falls back to a coloured
 * monogram avatar whenever `headshotUrl` is absent or fails to load. So every
 * failure here — offline, 404, timeout, unwritable cache — degrades silently to
 * "no URL" and the render still succeeds. This module never throws.
 *
 * docs/render_spec.md: "Do not store binary NFL imagery in Git unless
 * licensing/usage has been intentionally reviewed." The cache therefore lives in
 * `data/cache/headshots`, which is gitignored, and is fetched at runtime only.
 *
 * `LOUNGE_NO_HEADSHOTS=1` bypasses the network entirely (cached files are still
 * used, since they cost nothing) — set it in sandboxes and CI.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { headshotCacheDir } from '../paths.js';
import { log } from '../util/log.js';

/** Sleeper's public headshot CDN. `{id}` is a Sleeper player id. */
export const HEADSHOT_URL_TEMPLATE = 'https://sleepercdn.com/content/nfl/players/{id}.jpg';

/** Bytes below this are a placeholder or an error page, never a usable headshot. */
const MIN_IMAGE_BYTES = 1024;
const FETCH_TIMEOUT_MS = 5000;

/**
 * Downloads one image. Returns its bytes, or `null` for "not available".
 * Injected by tests so the suite never touches the network.
 */
export type HeadshotFetch = (url: string) => Promise<Uint8Array | null>;

export interface ResolveHeadshotsOptions {
  /** Cache directory. Defaults to `paths.headshotCacheDir`. */
  cacheDir?: string;
  /** Downloader. Defaults to `fetch` with a 5s timeout. */
  fetchImage?: HeadshotFetch;
  /** Environment used for the `LOUNGE_NO_HEADSHOTS` check. */
  env?: NodeJS.ProcessEnv;
  /** Explicit override of the env flag. `false` skips all downloads. */
  download?: boolean;
}

/** Ids that failed this process; retrying them inside one render is pure latency. */
const failedThisProcess = new Set<string>();

/** True when headshot downloads are switched off for this environment. */
export function headshotsDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env['LOUNGE_NO_HEADSHOTS']?.trim().toLowerCase();
  return flag === '1' || flag === 'true' || flag === 'yes';
}

/**
 * Resolve local `file://` headshot URLs for the given Sleeper player ids.
 *
 * Cached files are reused forever (a player's headshot does not change during a
 * draft). Ids with no usable image are simply absent from the result.
 */
export async function resolveHeadshots(
  playerIds: readonly string[],
  opts: ResolveHeadshotsOptions = {},
): Promise<Record<string, string>> {
  const cacheDir = opts.cacheDir ?? headshotCacheDir;
  const allowDownload = opts.download ?? !headshotsDisabled(opts.env);
  const fetchImage = opts.fetchImage ?? defaultFetchImage;
  const unique = [...new Set(playerIds.filter((id) => id && id.trim().length > 0))];
  const resolved: Record<string, string> = {};
  if (unique.length === 0) return resolved;

  try {
    await fs.mkdir(cacheDir, { recursive: true });
  } catch (error) {
    log.debug('headshots: cache directory unavailable, skipping', error);
    return resolved;
  }

  await Promise.all(
    unique.map(async (id) => {
      const file = path.join(cacheDir, `${sanitizeId(id)}.jpg`);
      if (await isUsableFile(file)) {
        resolved[id] = pathToFileURL(file).href;
        return;
      }
      if (!allowDownload || failedThisProcess.has(id)) return;
      const bytes = await safeFetch(fetchImage, id);
      if (!bytes || !looksLikeImage(bytes)) {
        failedThisProcess.add(id);
        return;
      }
      if (await writeAtomic(file, bytes)) {
        resolved[id] = pathToFileURL(file).href;
      }
    }),
  );

  return resolved;
}

/** The CDN URL for one player id. */
export function headshotUrlFor(playerId: string): string {
  return HEADSHOT_URL_TEMPLATE.replace('{id}', encodeURIComponent(playerId));
}

/** Forget this process's negative cache. Tests use this; nothing else should need it. */
export function clearHeadshotFailureCache(): void {
  failedThisProcess.clear();
}

// ---------------------------------------------------------------------------
// internals — every one of these swallows its own failures
// ---------------------------------------------------------------------------

async function safeFetch(fetchImage: HeadshotFetch, id: string): Promise<Uint8Array | null> {
  try {
    return await fetchImage(headshotUrlFor(id));
  } catch (error) {
    log.debug(`headshots: fetch failed for ${id}`, error);
    return null;
  }
}

const defaultFetchImage: HeadshotFetch = async (url) => {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: 'follow',
  });
  if (!response.ok) return null;
  return new Uint8Array(await response.arrayBuffer());
};

async function isUsableFile(file: string): Promise<boolean> {
  try {
    const stat = await fs.stat(file);
    return stat.isFile() && stat.size >= MIN_IMAGE_BYTES;
  } catch {
    return false;
  }
}

async function writeAtomic(file: string, bytes: Uint8Array): Promise<boolean> {
  const temp = `${file}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temp, bytes);
    await fs.rename(temp, file);
    return true;
  } catch (error) {
    log.debug(`headshots: could not cache ${file}`, error);
    await fs.rm(temp, { force: true }).catch(() => undefined);
    return false;
  }
}

/**
 * Magic-byte check, guarding against caching an HTML error page as an image.
 *
 * Sleeper serves headshots from a `.jpg` URL with `content-type: image/jpeg`
 * but the bytes are frequently **PNG** (`89 50 4E 47`). Checking only the JPEG
 * SOI marker silently rejected every real headshot and fell back to monograms,
 * so accept any format Chromium will render — it sniffs content, not extension.
 */
function looksLikeImage(bytes: Uint8Array): boolean {
  if (bytes.length < MIN_IMAGE_BYTES) return false;
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return true;
  // GIF87a / GIF89a
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return true;
  // WebP: "RIFF" .... "WEBP"
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return true;
  return false;
}

function sanitizeId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_');
}
