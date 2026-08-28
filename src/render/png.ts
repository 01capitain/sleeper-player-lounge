/**
 * Static PNG render — the final chat state, everything visible.
 *
 * This is the simplest possible use of the template: one `LOUNGE.render()`, one
 * settle, one `#stage` screenshot. It deliberately depends on nothing but a
 * validated `Reaction`, so it works with a hand-written stub and no Director,
 * no network and no ffmpeg.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import type { Reaction } from '../types.js';
import {
  SETTLE_MS,
  withLoungePage,
  type LoungeBrowser,
  type LoungeBrowserOptions,
} from './browser.js';
import { preparePayload, type PreparePayloadOptions } from './payload.js';

export interface RenderPngOptions extends PreparePayloadOptions, LoungeBrowserOptions {
  /** Reuse a batch render's chromium instead of launching a new one. */
  browser?: LoungeBrowser;
  /** Settle time before the screenshot. Defaults to the template's 220ms. */
  settleMs?: number;
}

/**
 * Render one Reaction to a PNG at `outPath`. Returns the path written.
 * Parent directories are created as needed.
 */
export async function renderPng(
  reaction: Reaction,
  outPath: string,
  opts: RenderPngOptions = {},
): Promise<string> {
  const payload = await preparePayload(reaction, opts);
  await fs.mkdir(path.dirname(outPath), { recursive: true });

  const pageOptions: LoungeBrowserOptions & { browser?: LoungeBrowser } = {};
  if (opts.browser) pageOptions.browser = opts.browser;
  if (opts.headless !== undefined) pageOptions.headless = opts.headless;
  if (opts.templateFile) pageOptions.templateFile = opts.templateFile;
  if (opts.deviceScaleFactor !== undefined) {
    pageOptions.deviceScaleFactor = opts.deviceScaleFactor;
  }

  return withLoungePage(pageOptions, async (page) => {
    await page.render(payload);
    await page.settle(opts.settleMs ?? SETTLE_MS);
    return page.screenshotStage(outPath);
  });
}
