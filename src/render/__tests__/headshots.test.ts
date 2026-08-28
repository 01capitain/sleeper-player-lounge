/**
 * The fetch is always injected here: the suite must never touch the network,
 * and the production path must be provably silent about every failure mode.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearHeadshotFailureCache,
  headshotUrlFor,
  headshotsDisabled,
  resolveHeadshots,
  type HeadshotFetch,
} from '../headshots.js';

/** A byte string that passes the JPEG magic + minimum size checks. */
function fakeJpeg(size = 4096): Uint8Array {
  const bytes = new Uint8Array(size).fill(0x41);
  bytes.set([0xff, 0xd8, 0xff], 0);
  return bytes;
}

/**
 * A PNG. Sleeper serves headshots from a `.jpg` URL with `content-type:
 * image/jpeg` but the bytes are frequently PNG, so this must be accepted.
 */
function fakePng(size = 4096): Uint8Array {
  const bytes = new Uint8Array(size).fill(0x41);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return bytes;
}

let cacheDir: string;

beforeEach(async () => {
  clearHeadshotFailureCache();
  cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lounge-headshots-test-'));
});

afterEach(async () => {
  await fs.rm(cacheDir, { recursive: true, force: true });
});

describe('headshotUrlFor', () => {
  it('builds the Sleeper CDN URL for a player id', () => {
    expect(headshotUrlFor('4046')).toBe(
      'https://sleepercdn.com/content/nfl/players/4046.jpg',
    );
  });
});

describe('headshotsDisabled', () => {
  it.each(['1', 'true', 'yes', 'TRUE'])('is true for LOUNGE_NO_HEADSHOTS=%s', (value) => {
    expect(headshotsDisabled({ LOUNGE_NO_HEADSHOTS: value })).toBe(true);
  });

  it.each([{}, { LOUNGE_NO_HEADSHOTS: '' }, { LOUNGE_NO_HEADSHOTS: '0' }])(
    'is false otherwise',
    (env) => {
      expect(headshotsDisabled(env)).toBe(false);
    },
  );
});

describe('resolveHeadshots', () => {
  it('downloads, caches and returns file:// URLs', async () => {
    const fetchImage = vi.fn<HeadshotFetch>(async () => fakeJpeg());
    const result = await resolveHeadshots(['4046', '96'], { cacheDir, fetchImage });

    expect(Object.keys(result).sort()).toEqual(['4046', '96']);
    expect(result['4046']).toMatch(/^file:\/\/.*4046\.jpg$/);
    await expect(fs.stat(path.join(cacheDir, '4046.jpg'))).resolves.toBeTruthy();
    expect(fetchImage).toHaveBeenCalledTimes(2);
  });

  it('reuses the cache instead of downloading again', async () => {
    await fs.writeFile(path.join(cacheDir, '4046.jpg'), fakeJpeg());
    const fetchImage = vi.fn<HeadshotFetch>(async () => fakeJpeg());

    const result = await resolveHeadshots(['4046'], { cacheDir, fetchImage });

    expect(result['4046']).toBeDefined();
    expect(fetchImage).not.toHaveBeenCalled();
  });

  it('degrades silently when the fetch throws', async () => {
    const fetchImage = vi.fn<HeadshotFetch>(async () => {
      throw new Error('getaddrinfo ENOTFOUND sleepercdn.com');
    });
    await expect(resolveHeadshots(['4046'], { cacheDir, fetchImage })).resolves.toEqual({});
  });

  it('degrades silently when the image is missing', async () => {
    const result = await resolveHeadshots(['4046'], { cacheDir, fetchImage: async () => null });
    expect(result).toEqual({});
  });

  it('rejects responses that are not real JPEGs', async () => {
    const html = new TextEncoder().encode('<!doctype html><title>404</title>'.repeat(64));
    const result = await resolveHeadshots(['4046'], { cacheDir, fetchImage: async () => html });
    expect(result).toEqual({});
    await expect(fs.stat(path.join(cacheDir, '4046.jpg'))).rejects.toThrow();
  });

  it('rejects truncated placeholder images', async () => {
    const tiny = fakeJpeg(128);
    const result = await resolveHeadshots(['4046'], { cacheDir, fetchImage: async () => tiny });
    expect(result).toEqual({});
  });

  it('never downloads when LOUNGE_NO_HEADSHOTS is set', async () => {
    const fetchImage = vi.fn<HeadshotFetch>(async () => fakeJpeg());
    const result = await resolveHeadshots(['4046'], {
      cacheDir,
      fetchImage,
      env: { LOUNGE_NO_HEADSHOTS: '1' },
    });
    expect(result).toEqual({});
    expect(fetchImage).not.toHaveBeenCalled();
  });

  it('still serves cached files when downloads are disabled', async () => {
    await fs.writeFile(path.join(cacheDir, '4046.jpg'), fakeJpeg());
    const result = await resolveHeadshots(['4046'], { cacheDir, download: false });
    expect(result['4046']).toMatch(/4046\.jpg$/);
  });

  it('does not retry an id that already failed in this process', async () => {
    const fetchImage = vi.fn<HeadshotFetch>(async () => null);
    await resolveHeadshots(['4046'], { cacheDir, fetchImage });
    await resolveHeadshots(['4046'], { cacheDir, fetchImage });
    expect(fetchImage).toHaveBeenCalledTimes(1);
  });

  it('dedupes ids and ignores blank ones', async () => {
    const fetchImage = vi.fn<HeadshotFetch>(async () => fakeJpeg());
    await resolveHeadshots(['4046', '4046', '', '   '], { cacheDir, fetchImage });
    expect(fetchImage).toHaveBeenCalledTimes(1);
  });

  it('returns an empty map for no ids without touching the disk', async () => {
    expect(await resolveHeadshots([], { cacheDir: '/nope/not/writable' })).toEqual({});
  });

  it('sanitises ids so they cannot escape the cache directory', async () => {
    const fetchImage = vi.fn<HeadshotFetch>(async () => fakeJpeg());
    await resolveHeadshots(['../../etc/passwd'], { cacheDir, fetchImage });
    const entries = await fs.readdir(cacheDir);
    expect(entries).toEqual(['.._.._etc_passwd.jpg']);
  });
});


describe('image format sniffing', () => {
  it('accepts PNG bytes served from a .jpg URL', async () => {
    // Regression: Sleeper's headshots are PNG despite the .jpg extension and
    // the image/jpeg content-type. Checking only the JPEG SOI marker rejected
    // every real headshot and silently fell back to monogram avatars.
    const fetchImage: HeadshotFetch = async () => fakePng();
    const resolved = await resolveHeadshots(['96'], { cacheDir, fetchImage });
    expect(resolved['96']).toBeDefined();
  });

  it('still accepts real JPEG bytes', async () => {
    const fetchImage: HeadshotFetch = async () => fakeJpeg();
    const resolved = await resolveHeadshots(['1466'], { cacheDir, fetchImage });
    expect(resolved['1466']).toBeDefined();
  });

  it('still rejects an HTML error page', async () => {
    const html = new TextEncoder().encode('<!doctype html>' + 'x'.repeat(4096));
    const fetchImage: HeadshotFetch = async () => html;
    const resolved = await resolveHeadshots(['7553'], { cacheDir, fetchImage });
    expect(resolved['7553']).toBeUndefined();
  });
});
