/**
 * The real pipeline: chromium, the finished template, ffmpeg.
 *
 * Nothing here touches the network — headshot downloads are switched off, so
 * every avatar falls back to the template's monogram, exactly as it would in a
 * sandbox. One chromium instance is shared across the whole file, which is also
 * the batch-render path this wrapper exists to support.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../../config.js';
import type { AppConfig } from '../../types.js';
import { launchLoungeBrowser, STAGE_HEIGHT, STAGE_WIDTH, type LoungeBrowser } from '../browser.js';
import { render } from '../index.js';
import { preparePayload } from '../payload.js';
import { renderPng } from '../png.js';
import { hasFfmpeg, renderVideo } from '../video.js';
import { LONG_SPEAKER_NAME, loungeMessage, shortReaction, stubReaction } from './fixtures.js';

const LAUNCH_TIMEOUT = 60_000;
const RENDER_TIMEOUT = 120_000;

let browser: LoungeBrowser;
let workDir: string;
let config: AppConfig;

/** Resolved at collection time so the encoder tests can skip cleanly. */
const ffmpegAvailable = await hasFfmpeg();

/** Never hit the network, and never let a chip depend on a real players file. */
const renderOptions = () => ({
  browser,
  config,
  headshotOptions: { download: false },
  recentMessages: [loungeMessage(1), loungeMessage(2), loungeMessage(3), loungeMessage(4)],
  playerMeta: {
    '4046': { nflTeam: 'KC', position: 'TE' },
    '96': { nflTeam: 'PIT', position: 'QB' },
  },
});

beforeAll(async () => {
  browser = await launchLoungeBrowser();
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lounge-render-test-'));
  config = await loadConfig();
}, LAUNCH_TIMEOUT);

afterAll(async () => {
  await browser?.close().catch(() => undefined);
  await fs.rm(workDir, { recursive: true, force: true });
});

/** Temp frame directories currently on disk, for the cleanup assertion. */
async function loungeFrameDirs(): Promise<string[]> {
  const entries = await fs.readdir(os.tmpdir());
  return entries.filter((entry) => entry.startsWith('lounge-frames-')).sort();
}

/** Width/height straight out of the PNG IHDR chunk. */
function pngSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG');
  expect(bytes.subarray(12, 16).toString('ascii')).toBe('IHDR');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe('renderPng', () => {
  it(
    'writes a 1080x1920 PNG of the final chat state',
    async () => {
      const outPath = path.join(workDir, 'nested', 'reaction.png');
      const written = await renderPng(stubReaction(), outPath, renderOptions());

      expect(written).toBe(outPath);
      const bytes = await fs.readFile(outPath);
      // A blank stage compresses to a few KB; a populated one never does.
      expect(bytes.byteLength).toBeGreaterThan(50_000);
      expect(pngSize(bytes)).toEqual({ width: STAGE_WIDTH, height: STAGE_HEIGHT });
    },
    RENDER_TIMEOUT,
  );

  it(
    'keeps #stage at exactly 1080x1920 with a 280-char message and a very long name',
    async () => {
      const payload = await preparePayload(stubReaction(), renderOptions());
      expect(payload.reactions[1]?.text).toHaveLength(280);
      expect(payload.reactions[2]?.speakerName).toBe(LONG_SPEAKER_NAME);

      const page = await browser.newPage();
      try {
        await page.render(payload);
        await page.settle();
        expect(await page.stageBox()).toEqual({
          x: 0,
          y: 0,
          width: STAGE_WIDTH,
          height: STAGE_HEIGHT,
        });
        expect(await page.messageCount()).toBe(4);
        expect(await page.revealedCount()).toBe(4);
      } finally {
        await page.close();
      }
    },
    RENDER_TIMEOUT,
  );
});

describe('the reveal contract', () => {
  it(
    'reveals one bubble per call after a reset, and reports when none remain',
    async () => {
      const payload = await preparePayload(stubReaction(), renderOptions());
      const page = await browser.newPage();
      try {
        await page.reset(payload);
        expect(await page.revealedCount()).toBe(0);

        await page.showTyping(payload.reactions[0]?.speakerPlayerId ?? '');
        for (let i = 1; i <= 4; i += 1) {
          expect(await page.revealNext()).toBe(true);
          expect(await page.revealedCount()).toBe(i);
        }
        expect(await page.revealNext()).toBe(false);
      } finally {
        await page.close();
      }
    },
    RENDER_TIMEOUT,
  );
});

describe('render', () => {
  it(
    'dispatches png to the still renderer and returns the path written',
    async () => {
      const outPath = path.join(workDir, 'dispatch.png');
      await expect(
        render(stubReaction(), { ...renderOptions(), format: 'png', out: outPath }),
      ).resolves.toBe(outPath);
      await expect(fs.stat(outPath)).resolves.toBeTruthy();
    },
    RENDER_TIMEOUT,
  );

  it('rejects an unsupported format before launching anything', async () => {
    await expect(
      render(stubReaction(), { format: 'webm' as 'png', out: path.join(workDir, 'x.webm') }),
    ).rejects.toThrow(/Unsupported render format 'webm'/);
  });
});

describe('renderVideo', () => {
  it('fails with an actionable message when ffmpeg is missing', async () => {
    await expect(
      renderVideo(shortReaction(), path.join(workDir, 'missing.mp4'), {
        ...renderOptions(),
        ffmpegPath: '/nonexistent/ffmpeg-does-not-exist',
      }),
    ).rejects.toThrow(/ffmpeg is required/);
  });

  it.skipIf(!ffmpegAvailable)(
    'encodes a short MP4 and cleans up its frame directory',
    async () => {
      const outPath = path.join(workDir, 'short.mp4');
      const framesBefore = await loungeFrameDirs();

      await renderVideo(shortReaction(), outPath, {
        ...renderOptions(),
        format: 'mp4',
        fps: 4,
        durationSeconds: 3,
      });

      const bytes = await fs.readFile(outPath);
      expect(bytes.byteLength).toBeGreaterThan(10_000);
      // An ftyp box, i.e. a real MP4 container rather than a truncated write.
      expect(bytes.subarray(4, 8).toString('ascii')).toBe('ftyp');
      expect(await loungeFrameDirs()).toEqual(framesBefore);
    },
    RENDER_TIMEOUT,
  );

  it.skipIf(!ffmpegAvailable)(
    'encodes a short downscaled GIF',
    async () => {
      const outPath = path.join(workDir, 'short.gif');
      await renderVideo(shortReaction(), outPath, {
        ...renderOptions(),
        format: 'gif',
        fps: 3,
        durationSeconds: 3,
        scale: 360,
      });
      const bytes = await fs.readFile(outPath);
      expect(bytes.subarray(0, 3).toString('ascii')).toBe('GIF');
      expect(bytes.byteLength).toBeGreaterThan(5_000);
    },
    RENDER_TIMEOUT,
  );
});
