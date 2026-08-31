/**
 * The WebP sidecar written beside every still.
 *
 * A shared scene is a 1080x1920 chat: flat panels, rounded avatars and a lot of
 * text. WebP is good at exactly that, and on this repo's own renders it lands at
 * roughly a sixth of the PNG at quality 85 while staying good enough to paste
 * into the league chat. So a still render writes both, and you pick the one the
 * destination wants.
 *
 * THE PNG IS STILL THE RENDER. This is a sidecar and nothing more:
 *
 *  - `renderPng` returns the PNG path, unchanged. Every caller that already
 *    knew where its file landed still does.
 *  - **A failed conversion is never fatal.** `src/render/png.ts` promises a
 *    still needs no ffmpeg, and the MP4 encoder tells people to fall back to
 *    `--format png` when ffmpeg is missing. Breaking that to save a few hundred
 *    kilobytes would be a bad trade, so a missing binary warns and moves on.
 *
 * The encoder settings are the ones validated by hand against a real draft-night
 * screenshot, and they live in `data/config/app.json` so tuning them needs no
 * code change.
 */
import path from 'node:path';

import type { WebpConfig } from '../types.js';
import { log } from '../util/log.js';
import { run } from './exec.js';
import { ffmpegBinary } from './video.js';

/** Lossy, and deliberately so: 85 is where the text still reads clean. */
export const WEBP_QUALITY = 85;

/**
 * How hard libwebp looks for a smaller file, 0-6. A 1080x1920 still encodes in
 * well under a second even at 6, so there is nothing to buy by going lower.
 */
export const WEBP_COMPRESSION_LEVEL = 6;

export interface WriteWebpOptions extends WebpConfig {
  /** ffmpeg binary. Defaults to `LOUNGE_FFMPEG`, then `ffmpeg` on PATH. */
  ffmpegPath?: string;
}

/** `output/scene.png` -> `output/scene.webp`. Any other extension gains one. */
export function webpPathFor(imagePath: string): string {
  const dir = path.dirname(imagePath);
  const ext = path.extname(imagePath);
  const stem = ext === '' ? path.basename(imagePath) : path.basename(imagePath, ext);
  return path.join(dir, `${stem}.webp`);
}

/**
 * Convert `imagePath` to a WebP beside it. Returns the path written, or `null`
 * when the sidecar is switched off or the conversion could not run.
 *
 * Never throws: the caller has already produced the real output by the time this
 * is reached, and losing the sidecar must not lose the render.
 */
export async function writeWebpBeside(
  imagePath: string,
  opts: WriteWebpOptions = {},
): Promise<string | null> {
  if (opts.enabled === false) return null;

  const outPath = webpPathFor(imagePath);
  const binary = opts.ffmpegPath?.trim() || ffmpegBinary();

  try {
    await run(binary, [
      '-y',
      '-loglevel',
      'error',
      '-i',
      imagePath,
      // One frame in, one frame out: a still, never an animated container.
      '-frames:v',
      '1',
      '-c:v',
      'libwebp',
      '-quality',
      String(opts.quality ?? WEBP_QUALITY),
      '-compression_level',
      String(opts.compressionLevel ?? WEBP_COMPRESSION_LEVEL),
      outPath,
    ]);
  } catch (error) {
    log.warn(
      `could not write the WebP sidecar for ${path.basename(imagePath)} ` +
        `('${binary}': ${error instanceof Error ? error.message : String(error)}). ` +
        'The PNG is unaffected.',
    );
    return null;
  }

  log.info(`webp sidecar: ${outPath}`);
  return outPath;
}
