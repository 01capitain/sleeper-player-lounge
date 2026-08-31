/**
 * Static PNG render — the final chat state, everything visible.
 *
 * This is the simplest possible use of the template: one `LOUNGE.render()`, one
 * settle, one `#stage` screenshot. It deliberately depends on nothing but a
 * validated `Reaction`, so it works with a hand-written stub and no Director,
 * no network and no ffmpeg.
 *
 * A WebP sidecar is written beside the PNG, because a sixth of the bytes is
 * worth having when the file is going into a chat. That step needs ffmpeg and
 * this one does not, so the sidecar is best-effort and the sentence above still
 * holds: no ffmpeg, no sidecar, same PNG. See `src/render/webp.ts`.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { loadConfig } from '../config.js';
import type { Reaction } from '../types.js';
import {
  SETTLE_MS,
  withLoungePage,
  type LoungeBrowser,
  type LoungeBrowserOptions,
} from './browser.js';
import { preparePayload, type PreparePayloadOptions } from './payload.js';
import { writeWebpBeside, type WriteWebpOptions } from './webp.js';

export interface RenderPngOptions extends PreparePayloadOptions, LoungeBrowserOptions {
  /** Reuse a batch render's chromium instead of launching a new one. */
  browser?: LoungeBrowser;
  /** Settle time before the screenshot. Defaults to the template's 220ms. */
  settleMs?: number;
  /**
   * Encoder settings for the WebP sidecar, overriding `rendering.webp` in the
   * config. `{ enabled: false }` writes the PNG and nothing else.
   */
  webp?: WriteWebpOptions;
}

/**
 * Render one Reaction to a PNG at `outPath`. Returns the path written — the
 * PNG, never the sidecar. Parent directories are created as needed.
 */
export async function renderPng(
  reaction: Reaction,
  outPath: string,
  opts: RenderPngOptions = {},
): Promise<string> {
  // Resolved here rather than left to `preparePayload`, which loads the same
  // config for the watermark and does not hand it back. One read, two readers.
  const config = opts.config ?? (await loadConfig().catch(() => undefined));
  const payload = await preparePayload(reaction, config ? { ...opts, config } : opts);
  await fs.mkdir(path.dirname(outPath), { recursive: true });

  const pageOptions: LoungeBrowserOptions & { browser?: LoungeBrowser } = {};
  if (opts.browser) pageOptions.browser = opts.browser;
  if (opts.headless !== undefined) pageOptions.headless = opts.headless;
  if (opts.templateFile) pageOptions.templateFile = opts.templateFile;
  if (opts.deviceScaleFactor !== undefined) {
    pageOptions.deviceScaleFactor = opts.deviceScaleFactor;
  }

  const written = await withLoungePage(pageOptions, async (page) => {
    await page.render(payload);
    await page.settle(opts.settleMs ?? SETTLE_MS);
    return page.screenshotStage(outPath);
  });

  await writeWebpBeside(written, { ...config?.rendering.webp, ...opts.webp });
  return written;
}
