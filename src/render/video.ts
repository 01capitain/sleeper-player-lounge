/**
 * Animated render — MP4 and GIF.
 *
 * docs/render_spec.md's timeline, in order:
 *   1. previous Lounge messages dimmed above the fold   (LOUNGE.reset)
 *   2. centered draft status card                        (LOUNGE.reset)
 *   3. pause ~500-900ms                                  STATUS_PAUSE_MS
 *   4. optional typing indicator                         LOUNGE.showTyping
 *   5. reveal messages one by one per `delayMs`          LOUNGE.revealNext
 *   6. hold the final state 1.0-1.5s                     HOLD_MS
 *
 * The whole animation is first compiled into an immutable list of
 * `{ atMs, action }` events (`buildTimeline`, pure and unit-tested), and only
 * then played back. Frames are captured at a fixed fps rather than in real time:
 * at each frame timestamp every due action is applied, the 150ms reveal
 * transition is allowed to settle, and `#stage` is screenshotted. Wall-clock
 * time therefore has no influence on the output — the same Reaction always
 * produces byte-comparable frames.
 *
 * Duration: the Director's `delayMs` values (0..7000 per the schema) express
 * *rhythm*, not wall-clock intent, so they are scaled by a single factor -
 * clamped to [0.5, 2.5] so the pacing is never distorted beyond recognition -
 * to land the total near `rendering.defaultDurationSeconds`.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadConfig } from '../config.js';
import type { Reaction } from '../types.js';
import { log } from '../util/log.js';
import {
  SETTLE_MS,
  withLoungePage,
  type LoungeBrowser,
  type LoungeBrowserOptions,
} from './browser.js';
import { run } from './exec.js';
import { preparePayload, type PreparePayloadOptions, type RenderPayload } from './payload.js';

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

export type TimelineAction =
  | { kind: 'reset' }
  | { kind: 'showTyping'; speakerPlayerId: string }
  | { kind: 'hideTyping' }
  | { kind: 'reveal'; index: number };

export interface TimelineEvent {
  /** Milliseconds from the first frame. */
  atMs: number;
  action: TimelineAction;
}

export interface Timeline {
  events: TimelineEvent[];
  /** Total animation length, including the closing hold. */
  durationMs: number;
}

/** Spec step 3: "pause ~500-900ms". */
export const STATUS_PAUSE_MS = 700;
/** Spec step 6: "hold the final state 1.0-1.5 seconds". */
export const MIN_HOLD_MS = 1000;
export const MAX_HOLD_MS = 1500;
export const DEFAULT_HOLD_MS = 1200;
/** How long the typing indicator precedes the bubble it announces. */
export const TYPING_LEAD_MS = 600;
/** Never let two bubbles land close enough to read as one beat. */
export const MIN_REVEAL_GAP_MS = 400;
/** Bounds on the `delayMs` scale factor, so director pacing survives the fit. */
const MIN_SCALE = 0.5;
const MAX_SCALE = 2.5;
/** A typing beat shorter than this is a flicker; skip it instead. */
const MIN_TYPING_VISIBLE_MS = 250;

export interface TimelineOptions {
  /** Target total length. Defaults to `rendering.defaultDurationSeconds` (8). */
  durationSeconds?: number;
  /** Spec step 4. Defaults to `rendering.showTypingIndicators`. */
  showTypingIndicators?: boolean;
  statusPauseMs?: number;
  holdMs?: number;
  typingLeadMs?: number;
}

export const DEFAULT_DURATION_SECONDS = 8;

/**
 * Compile a payload into the spec's animation timeline. Pure: no browser, no
 * clock, no filesystem — the same input always yields the same events.
 */
export function buildTimeline(
  payload: RenderPayload,
  options: TimelineOptions = {},
): Timeline {
  const statusPause = options.statusPauseMs ?? STATUS_PAUSE_MS;
  const typingLead = options.typingLeadMs ?? TYPING_LEAD_MS;
  const typingEnabled = options.showTypingIndicators ?? true;
  const requestedHold = options.holdMs ?? DEFAULT_HOLD_MS;
  const targetMs = Math.round((options.durationSeconds ?? DEFAULT_DURATION_SECONDS) * 1000);

  const reactions = payload.reactions ?? [];
  const events: TimelineEvent[] = [{ atMs: 0, action: { kind: 'reset' } }];

  if (reactions.length === 0) {
    const hold = clamp(requestedHold, MIN_HOLD_MS, MAX_HOLD_MS);
    return { events, durationMs: statusPause + hold };
  }

  // Step 4 needs room before the first bubble, so the reveal phase starts one
  // typing lead after the status pause when the indicator is enabled.
  const base = statusPause + (typingEnabled ? typingLead : 0);
  const hold = clamp(requestedHold, MIN_HOLD_MS, MAX_HOLD_MS);
  const available = Math.max(targetMs - base - hold, MIN_REVEAL_GAP_MS);

  const rawSpan = Math.max(...reactions.map((message) => Math.max(0, message.delayMs)));
  const scale = rawSpan > 0 ? clamp(available / rawSpan, MIN_SCALE, MAX_SCALE) : 1;

  // Monotonic, minimum-gap reveal offsets. Directors do occasionally emit equal
  // or out-of-order delays; the timeline must still read as a conversation.
  const offsets: number[] = [];
  let previous = -Infinity;
  for (const message of reactions) {
    const scaled = Math.round(Math.max(0, message.delayMs) * scale);
    const next = offsets.length === 0 ? scaled : Math.max(scaled, previous + MIN_REVEAL_GAP_MS);
    offsets.push(next);
    previous = next;
  }

  let lastEventAt = 0;
  reactions.forEach((message, index) => {
    const revealAt = base + (offsets[index] ?? 0);
    if (typingEnabled) {
      const typingAt = Math.max(revealAt - typingLead, lastEventAt + SETTLE_MS);
      if (revealAt - typingAt >= MIN_TYPING_VISIBLE_MS) {
        events.push({
          atMs: typingAt,
          action: { kind: 'showTyping', speakerPlayerId: message.speakerPlayerId },
        });
        lastEventAt = typingAt;
      }
    }
    // `revealNext()` hides the typing indicator itself — a bubble arriving is
    // what ends "typing" — so no explicit hideTyping is scheduled here.
    events.push({ atMs: revealAt, action: { kind: 'reveal', index } });
    lastEventAt = revealAt;
  });

  const lastReveal = base + (offsets[offsets.length - 1] ?? 0);
  return { events, durationMs: lastReveal + hold };
}

// ---------------------------------------------------------------------------
// Frame capture
// ---------------------------------------------------------------------------

export const DEFAULT_FPS = 12;
const FRAME_PREFIX = 'frame-';
const FRAME_PATTERN = `${FRAME_PREFIX}%05d.png`;

/** Frames rendered for a timeline at `fps`. Always at least one. */
export function frameCountFor(durationMs: number, fps: number): number {
  return Math.max(1, Math.ceil((durationMs * fps) / 1000));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type VideoFormat = 'mp4' | 'gif';

export interface RenderVideoOptions
  extends PreparePayloadOptions,
    LoungeBrowserOptions,
    TimelineOptions {
  format?: VideoFormat;
  /** Capture frame rate. 12 is plenty for chat animation and keeps files small. */
  fps?: number;
  /** Output width in px; height follows the 9:16 master. GIFs default to 540. */
  scale?: number;
  /** Reuse a batch render's chromium. */
  browser?: LoungeBrowser;
  /** Settle time after each timeline action. Defaults to the template's 220ms. */
  settleMs?: number;
  /** Keep the frame directory for debugging instead of deleting it. */
  keepFrames?: boolean;
  /** ffmpeg binary. Defaults to `LOUNGE_FFMPEG`, then `ffmpeg` on PATH. */
  ffmpegPath?: string;
}

/** Default GIF width — 1080px GIFs are unshareable. */
const DEFAULT_GIF_WIDTH = 540;

/**
 * Render one Reaction to an animated file at `outPath`. Returns the path written.
 * Frames go to a temp directory that is always removed afterwards.
 */
export async function renderVideo(
  reaction: Reaction,
  outPath: string,
  opts: RenderVideoOptions = {},
): Promise<string> {
  const format: VideoFormat = opts.format ?? 'mp4';
  const fps = Math.max(1, Math.round(opts.fps ?? DEFAULT_FPS));
  const ffmpeg = await resolveFfmpeg(opts.ffmpegPath);

  const payload = await preparePayload(reaction, opts);
  const timelineOptions = await resolveTimelineOptions(opts);
  const timeline = buildTimeline(payload, timelineOptions);

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  const framesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lounge-frames-'));
  try {
    const frames = await captureFrames(payload, timeline, framesDir, fps, opts);
    log.debug(
      `render: captured ${frames} frames at ${fps}fps for ${Math.round(timeline.durationMs)}ms`,
    );
    const pattern = path.join(framesDir, FRAME_PATTERN);
    if (format === 'gif') {
      await encodeGif(ffmpeg, pattern, outPath, fps, opts.scale ?? DEFAULT_GIF_WIDTH, framesDir);
    } else {
      await encodeMp4(ffmpeg, pattern, outPath, fps, opts.scale);
    }
    return outPath;
  } finally {
    if (!opts.keepFrames) {
      await fs.rm(framesDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/** Timeline options with the config defaults (duration, typing) filled in. */
async function resolveTimelineOptions(opts: RenderVideoOptions): Promise<TimelineOptions> {
  const config = opts.config ?? (await loadConfig().catch(() => undefined));
  const resolved: TimelineOptions = {
    durationSeconds:
      opts.durationSeconds ?? config?.rendering.defaultDurationSeconds ?? DEFAULT_DURATION_SECONDS,
    showTypingIndicators:
      opts.showTypingIndicators ?? config?.rendering.showTypingIndicators ?? true,
  };
  if (opts.statusPauseMs !== undefined) resolved.statusPauseMs = opts.statusPauseMs;
  if (opts.holdMs !== undefined) resolved.holdMs = opts.holdMs;
  if (opts.typingLeadMs !== undefined) resolved.typingLeadMs = opts.typingLeadMs;
  return resolved;
}

/**
 * Play the timeline at a fixed frame rate, writing one settled PNG per frame.
 * Returns the number of frames written.
 */
async function captureFrames(
  payload: RenderPayload,
  timeline: Timeline,
  framesDir: string,
  fps: number,
  opts: RenderVideoOptions,
): Promise<number> {
  const frameMs = 1000 / fps;
  const total = frameCountFor(timeline.durationMs, fps);
  const settleMs = opts.settleMs ?? SETTLE_MS;

  const pageOptions: LoungeBrowserOptions & { browser?: LoungeBrowser } = {};
  if (opts.browser) pageOptions.browser = opts.browser;
  if (opts.headless !== undefined) pageOptions.headless = opts.headless;
  if (opts.templateFile) pageOptions.templateFile = opts.templateFile;
  if (opts.deviceScaleFactor !== undefined) {
    pageOptions.deviceScaleFactor = opts.deviceScaleFactor;
  }

  return withLoungePage(pageOptions, async (page) => {
    let cursor = 0;
    for (let frame = 0; frame < total; frame += 1) {
      const at = frame * frameMs;
      let applied = false;
      while (cursor < timeline.events.length) {
        const event = timeline.events[cursor];
        if (!event || event.atMs > at) break;
        cursor += 1;
        applied = true;
        switch (event.action.kind) {
          case 'reset':
            await page.reset(payload);
            break;
          case 'showTyping':
            await page.showTyping(event.action.speakerPlayerId);
            break;
          case 'hideTyping':
            await page.hideTyping();
            break;
          case 'reveal':
            await page.revealNext();
            break;
        }
      }
      // Only pay the settle cost on frames where something actually moved.
      if (applied) await page.settle(settleMs);
      await page.screenshotStage(path.join(framesDir, frameName(frame)));
    }
    return total;
  });
}

function frameName(index: number): string {
  return `${FRAME_PREFIX}${String(index + 1).padStart(5, '0')}.png`;
}

// ---------------------------------------------------------------------------
// ffmpeg
// ---------------------------------------------------------------------------

/** `LOUNGE_FFMPEG` overrides the binary; otherwise `ffmpeg` from PATH. */
export function ffmpegBinary(env: NodeJS.ProcessEnv = process.env): string {
  return env['LOUNGE_FFMPEG']?.trim() || 'ffmpeg';
}

/** True when an ffmpeg binary is callable. Tests use it to skip cleanly. */
export async function hasFfmpeg(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  try {
    await run(ffmpegBinary(env), ['-version']);
    return true;
  } catch {
    return false;
  }
}

async function resolveFfmpeg(override?: string): Promise<string> {
  const binary = override?.trim() || ffmpegBinary();
  try {
    await run(binary, ['-version']);
    return binary;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `ffmpeg is required to render MP4/GIF but could not be run ('${binary}': ${reason}).\n` +
        '  - macOS:  brew install ffmpeg\n' +
        '  - Debian: sudo apt install ffmpeg\n' +
        '  - or set LOUNGE_FFMPEG to the full path of an ffmpeg binary.\n' +
        'PNG rendering needs no ffmpeg: retry with --format png.',
    );
  }
}

/**
 * H.264 in MP4. `yuv420p` and even dimensions are mandatory for playback in
 * chat clients and Quick Look; `+faststart` moves the moov atom to the front so
 * the file previews without a full download. Output is forced to at least 24fps
 * (duplicating frames, which costs almost nothing in H.264) because some mobile
 * clients refuse very low frame rates.
 */
async function encodeMp4(
  ffmpeg: string,
  pattern: string,
  outPath: string,
  fps: number,
  scale: number | undefined,
): Promise<void> {
  const filter = scale
    ? `scale=${evenWidth(scale)}:-2:flags=lanczos`
    : 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
  await run(ffmpeg, [
    '-y',
    '-loglevel', 'error',
    '-framerate', String(fps),
    '-start_number', '1',
    '-i', pattern,
    '-vf', filter,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-r', String(Math.max(fps, 24)),
    outPath,
  ]);
}

/**
 * Two-pass GIF: `palettegen` over the whole clip, then `paletteuse`. A single
 * pass would quantise to the generic 216-colour web palette and band the dark
 * plum gradient badly. `stats_mode=diff` weights the moving bubbles over the
 * static background, which is where the colour budget matters.
 */
async function encodeGif(
  ffmpeg: string,
  pattern: string,
  outPath: string,
  fps: number,
  width: number,
  workDir: string,
): Promise<void> {
  const palette = path.join(workDir, 'palette.png');
  const scale = `scale=${evenWidth(width)}:-2:flags=lanczos`;
  await run(ffmpeg, [
    '-y',
    '-loglevel', 'error',
    '-framerate', String(fps),
    '-start_number', '1',
    '-i', pattern,
    '-vf', `${scale},palettegen=stats_mode=diff`,
    palette,
  ]);
  await run(ffmpeg, [
    '-y',
    '-loglevel', 'error',
    '-framerate', String(fps),
    '-start_number', '1',
    '-i', pattern,
    '-i', palette,
    '-lavfi', `${scale}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle`,
    '-loop', '0',
    outPath,
  ]);
}

function evenWidth(width: number): number {
  const rounded = Math.max(2, Math.round(width));
  return rounded % 2 === 0 ? rounded : rounded + 1;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}
