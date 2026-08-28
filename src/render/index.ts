/**
 * The renderer's public surface.
 *
 * `render()` is the one entry point the CLI needs: hand it a validated Reaction
 * and a format, get back the path of the file that was written. Everything else
 * exported here exists for tests, batch callers that want to reuse a browser,
 * and the CLI's `screenshot` command.
 */
import path from 'node:path';

import { loadConfig } from '../config.js';
import { outputDir } from '../paths.js';
import type { Reaction, RenderFormat } from '../types.js';
import { renderHtml } from './html.js';
import { renderPng, type RenderPngOptions } from './png.js';
import { renderVideo, type RenderVideoOptions } from './video.js';

export interface RenderOptions extends RenderPngOptions, Omit<RenderVideoOptions, 'format'> {
  /** Defaults to `rendering.defaultFormat` (mp4). */
  format?: RenderFormat;
  /** Output path. Defaults to `output/{eventId}.{ext}`. */
  out?: string;
}

/**
 * Render one Reaction in the requested format. Returns the path written.
 * Unknown formats fail before chromium is launched.
 */
export async function render(reaction: Reaction, opts: RenderOptions = {}): Promise<string> {
  const config = opts.config ?? (await loadConfig().catch(() => undefined));
  const format = opts.format ?? config?.rendering.defaultFormat ?? 'mp4';
  assertSupportedFormat(format, config?.rendering.supportedFormats);

  const outPath = opts.out ?? defaultOutputPath(reaction.eventId, format);
  const shared: RenderOptions = { ...opts };
  if (config) shared.config = config;

  if (format === 'png') return renderPng(reaction, outPath, shared);
  if (format === 'html') return renderHtml(reaction, outPath, shared);
  return renderVideo(reaction, outPath, { ...shared, format });
}

/**
 * Every format `render()` can produce. The single source of truth — the CLI
 * imports this rather than keeping its own copy, so a new format cannot be
 * renderable but unselectable (or the reverse).
 */
export const FORMATS: readonly RenderFormat[] = ['png', 'gif', 'mp4', 'html'];

function assertSupportedFormat(
  format: string,
  supported: readonly RenderFormat[] | undefined,
): asserts format is RenderFormat {
  const allowed = supported && supported.length > 0 ? supported : FORMATS;
  if (!FORMATS.includes(format as RenderFormat) || !allowed.includes(format as RenderFormat)) {
    throw new Error(
      `Unsupported render format '${format}'. Supported formats: ${allowed.join(', ')}.`,
    );
  }
}

/**
 * `output/{eventId}.{ext}`, with the eventId's `:` separators (and anything else
 * a filesystem would object to) flattened to `-`. `output/` is gitignored.
 */
export function defaultOutputPath(eventId: string, format: RenderFormat): string {
  return path.join(outputDir, `${safeFileStem(eventId)}.${format}`);
}

/** `1234:31:4046` -> `1234-31-4046`. Never empty, never path-traversing. */
export function safeFileStem(eventId: string): string {
  const cleaned = eventId
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return cleaned.length > 0 ? cleaned : 'reaction';
}

export {
  toRenderPayload,
  preparePayload,
  buildTeamChip,
  selectPreviousMessages,
  speakerIdsFor,
  MIN_PREVIOUS_MESSAGES,
  MAX_PREVIOUS_MESSAGES,
} from './payload.js';
export type {
  RenderPayload,
  RenderPayloadPick,
  RenderPayloadReaction,
  RenderPayloadPreviousMessage,
  PlayerChipMeta,
  ToRenderPayloadOptions,
  PreparePayloadOptions,
} from './payload.js';

export {
  resolveHeadshots,
  headshotsDisabled,
  headshotUrlFor,
  clearHeadshotFailureCache,
  HEADSHOT_URL_TEMPLATE,
} from './headshots.js';
export type { HeadshotFetch, ResolveHeadshotsOptions } from './headshots.js';

export {
  launchLoungeBrowser,
  withLoungeBrowser,
  withLoungePage,
  LoungeBrowser,
  LoungePage,
  loungeTemplateFile,
  templatesDir,
  STAGE_WIDTH,
  STAGE_HEIGHT,
  SETTLE_MS,
} from './browser.js';
export type { LoungeBrowserOptions, StageBox } from './browser.js';

export { renderPng } from './png.js';
export type { RenderPngOptions } from './png.js';

export {
  renderVideo,
  buildTimeline,
  frameCountFor,
  hasFfmpeg,
  ffmpegBinary,
  DEFAULT_FPS,
  DEFAULT_DURATION_SECONDS,
  STATUS_PAUSE_MS,
  TYPING_LEAD_MS,
  MIN_REVEAL_GAP_MS,
} from './video.js';
export type {
  RenderVideoOptions,
  Timeline,
  TimelineEvent,
  TimelineAction,
  TimelineOptions,
  VideoFormat,
} from './video.js';
