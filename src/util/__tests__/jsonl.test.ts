import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { appendJsonl, readJsonl, readJsonlTail, writeJsonl } from '../jsonl.js';
import { readJson, readJsonIfExists, writeJson } from '../json.js';

interface Row {
  eventId: string;
  seq: number;
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'lounge-jsonl-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('readJsonl', () => {
  it('returns [] for a missing file', async () => {
    expect(await readJsonl<Row>(path.join(dir, 'nope.jsonl'))).toEqual([]);
  });

  it('returns [] for an empty file (the committed messages.jsonl case)', async () => {
    const file = path.join(dir, 'messages.jsonl');
    await writeFile(file, '', 'utf8');
    expect(await readJsonl<Row>(file)).toEqual([]);
  });

  it('skips blank and whitespace-only lines', async () => {
    const file = path.join(dir, 'gaps.jsonl');
    await writeFile(
      file,
      '{"eventId":"a","seq":1}\n\n   \n{"eventId":"b","seq":2}\n\n',
      'utf8',
    );
    expect(await readJsonl<Row>(file)).toEqual([
      { eventId: 'a', seq: 1 },
      { eventId: 'b', seq: 2 },
    ]);
  });

  it('reports the offending line number for malformed JSON', async () => {
    const file = path.join(dir, 'broken.jsonl');
    await writeFile(file, '{"eventId":"a","seq":1}\n{nope}\n', 'utf8');
    await expect(readJsonl<Row>(file)).rejects.toThrow(/broken\.jsonl:2/);
  });
});

describe('appendJsonl', () => {
  it('creates parent directories and writes one compact object per line', async () => {
    const file = path.join(dir, 'nested', 'deep', 'reactions.jsonl');
    await appendJsonl<Row>(file, { eventId: 'a', seq: 1 });
    await appendJsonl<Row>(file, [
      { eventId: 'b', seq: 2 },
      { eventId: 'c', seq: 3 },
    ]);

    const raw = await readFile(file, 'utf8');
    expect(raw).toBe(
      '{"eventId":"a","seq":1}\n{"eventId":"b","seq":2}\n{"eventId":"c","seq":3}\n',
    );
    expect(raw.endsWith('\n')).toBe(true);
    expect(await readJsonl<Row>(file)).toHaveLength(3);
  });

  it('is a no-op for an empty array', async () => {
    const file = path.join(dir, 'empty.jsonl');
    await appendJsonl<Row>(file, []);
    expect(await readJsonl<Row>(file)).toEqual([]);
  });

  it('keeps appended records intact across many appends', async () => {
    const file = path.join(dir, 'picks.jsonl');
    for (let i = 1; i <= 50; i += 1) {
      await appendJsonl<Row>(file, { eventId: `e${i}`, seq: i });
    }
    const rows = await readJsonl<Row>(file);
    expect(rows).toHaveLength(50);
    expect(rows[0]).toEqual({ eventId: 'e1', seq: 1 });
    expect(rows.at(-1)).toEqual({ eventId: 'e50', seq: 50 });
  });
});

describe('readJsonlTail', () => {
  it('returns the last n records in order', async () => {
    const file = path.join(dir, 'tail.jsonl');
    await appendJsonl<Row>(
      file,
      Array.from({ length: 25 }, (_, i) => ({ eventId: `e${i + 1}`, seq: i + 1 })),
    );
    const tail = await readJsonlTail<Row>(file, 20);
    expect(tail).toHaveLength(20);
    expect(tail[0]?.seq).toBe(6);
    expect(tail.at(-1)?.seq).toBe(25);
  });

  it('returns everything when n exceeds the record count', async () => {
    const file = path.join(dir, 'short.jsonl');
    await appendJsonl<Row>(file, [{ eventId: 'a', seq: 1 }]);
    expect(await readJsonlTail<Row>(file, 20)).toHaveLength(1);
  });

  it('returns [] for a missing file or n <= 0', async () => {
    expect(await readJsonlTail<Row>(path.join(dir, 'missing.jsonl'), 5)).toEqual([]);
    const file = path.join(dir, 'some.jsonl');
    await appendJsonl<Row>(file, [{ eventId: 'a', seq: 1 }]);
    expect(await readJsonlTail<Row>(file, 0)).toEqual([]);
  });
});

describe('writeJsonl', () => {
  it('replaces the file and stays newline-terminated', async () => {
    const file = path.join(dir, 'rewrite.jsonl');
    await appendJsonl<Row>(file, [{ eventId: 'old', seq: 1 }]);
    await writeJsonl<Row>(file, [{ eventId: 'new', seq: 2 }]);
    expect(await readFile(file, 'utf8')).toBe('{"eventId":"new","seq":2}\n');
  });

  it('truncates to an empty file for an empty array', async () => {
    const file = path.join(dir, 'cleared.jsonl');
    await appendJsonl<Row>(file, [{ eventId: 'old', seq: 1 }]);
    await writeJsonl<Row>(file, []);
    expect(await readFile(file, 'utf8')).toBe('');
    expect(await readJsonl<Row>(file)).toEqual([]);
  });
});

describe('json helpers', () => {
  it('writes sorted keys, 2-space indent and a trailing newline', async () => {
    const file = path.join(dir, 'state', 'app.json');
    await writeJson(file, {
      season: 2026,
      appName: 'Players Lounge',
      nested: { zebra: 1, alpha: [{ b: 2, a: 1 }] },
    });

    expect(await readFile(file, 'utf8')).toBe(
      [
        '{',
        '  "appName": "Players Lounge",',
        '  "nested": {',
        '    "alpha": [',
        '      {',
        '        "a": 1,',
        '        "b": 2',
        '      }',
        '    ],',
        '    "zebra": 1',
        '  },',
        '  "season": 2026',
        '}',
        '',
      ].join('\n'),
    );
  });

  it('produces byte-identical output for differently ordered inputs', async () => {
    const a = path.join(dir, 'a.json');
    const b = path.join(dir, 'b.json');
    await writeJson(a, { one: 1, two: 2, three: { x: 1, y: 2 } });
    await writeJson(b, { three: { y: 2, x: 1 }, two: 2, one: 1 });
    expect(await readFile(a, 'utf8')).toBe(await readFile(b, 'utf8'));
  });

  it('round-trips through readJson and returns null for missing files', async () => {
    const file = path.join(dir, 'round.json');
    await writeJson(file, { eventId: 'x', seq: 3 });
    expect(await readJson<Row>(file)).toEqual({ eventId: 'x', seq: 3 });
    expect(await readJsonIfExists<Row>(path.join(dir, 'absent.json'))).toBeNull();
  });

  it('throws a path-bearing error for malformed JSON', async () => {
    const file = path.join(dir, 'bad.json');
    await writeFile(file, '{nope}', 'utf8');
    await expect(readJson(file)).rejects.toThrow(/bad\.json/);
  });
});
