/**
 * The WebP sidecar, without a browser.
 *
 * `renderPng`'s own test covers the end-to-end shape. What matters here is the
 * contract that lets `src/render/png.ts` keep promising a still needs no
 * ffmpeg: this module never throws, whatever ffmpeg does.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hasFfmpeg } from '../video.js';
import {
  WEBP_COMPRESSION_LEVEL,
  WEBP_QUALITY,
  webpPathFor,
  writeWebpBeside,
} from '../webp.js';

const ffmpegAvailable = await hasFfmpeg();

let workDir: string;

beforeAll(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lounge-webp-test-'));
});

afterAll(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

describe('webpPathFor', () => {
  it('swaps the extension and keeps the directory', () => {
    expect(webpPathFor(path.join('output', 'scene.png'))).toBe(
      path.join('output', 'scene.webp'),
    );
  });

  it('replaces any extension, not only .png', () => {
    expect(webpPathFor(path.join('output', 'scene.jpeg'))).toBe(
      path.join('output', 'scene.webp'),
    );
  });

  it('adds one when the file has none', () => {
    expect(webpPathFor(path.join('output', 'scene'))).toBe(path.join('output', 'scene.webp'));
  });

  it('keeps a dotted stem intact', () => {
    expect(webpPathFor(path.join('output', '1389-1-9221.png'))).toBe(
      path.join('output', '1389-1-9221.webp'),
    );
  });
});

describe('writeWebpBeside', () => {
  it('writes nothing when the sidecar is switched off', async () => {
    const source = path.join(workDir, 'off.png');
    await fs.writeFile(source, 'not a real png');

    expect(await writeWebpBeside(source, { enabled: false })).toBeNull();
    await expect(fs.access(webpPathFor(source))).rejects.toThrow();
  });

  it('returns null rather than throwing when ffmpeg cannot be run', async () => {
    const source = path.join(workDir, 'no-binary.png');
    await fs.writeFile(source, 'not a real png');

    // The whole point: the PNG is already written by the time this runs, and a
    // machine with no ffmpeg is the documented `--format png` fallback.
    expect(
      await writeWebpBeside(source, { ffmpegPath: 'definitely-not-ffmpeg-xyz' }),
    ).toBeNull();
  });

  it('returns null rather than throwing when the input is not an image', async () => {
    const source = path.join(workDir, 'garbage.png');
    await fs.writeFile(source, 'not a real png');

    expect(await writeWebpBeside(source)).toBeNull();
  });

  it.skipIf(!ffmpegAvailable)('encodes a real image and reports the path', async () => {
    const source = path.join(workDir, 'real.png');
    // A 2x2 red PNG, so the test needs no fixture file on disk.
    await fs.writeFile(
      source,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg==',
        'base64',
      ),
    );

    const written = await writeWebpBeside(source);

    expect(written).toBe(webpPathFor(source));
    const bytes = await fs.readFile(written as string);
    expect(bytes.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(bytes.subarray(8, 12).toString('ascii')).toBe('WEBP');
  });
});

describe('the encoder defaults', () => {
  it('are the settings validated by hand against a draft-night screenshot', () => {
    expect(WEBP_QUALITY).toBe(85);
    expect(WEBP_COMPRESSION_LEVEL).toBe(6);
  });
});
