import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DISAPPOINTING_THRESHOLD,
  DISASTER_THRESHOLD,
  EXCELLENT_THRESHOLD,
  GOOD_THRESHOLD,
  MIN_POOL_SIZE,
  buildPositionRanks,
  classify,
  collectSeasonPoints,
  labelForScore,
  loadPerformanceOverrides,
  performanceScore,
  regularSeasonWeeks,
  type PlayerSeasonInput,
} from '../performance.js';
import { L2025, makeClient, matchupRow, threeSeasonChain } from './harness.js';

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tempFile(name: string, contents: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lounge-overrides-'));
  tempDirs.push(dir);
  const file = path.join(dir, name);
  await fs.writeFile(file, contents, 'utf8');
  return file;
}

/** Ten WRs, drafted 1..10, so the pool clears MIN_POOL_SIZE. */
function tenWideReceivers(pointsByPlayer: Record<string, number>): PlayerSeasonInput[] {
  return Object.keys(pointsByPlayer)
    .sort()
    .map((playerId, index) => ({
      playerId,
      position: 'WR',
      totalPoints: pointsByPlayer[playerId] ?? null,
      draftPickNo: index + 1,
    }));
}

describe('regularSeasonWeeks', () => {
  it('defaults to weeks 1..17 and is configurable', () => {
    expect(regularSeasonWeeks()).toHaveLength(17);
    expect(regularSeasonWeeks()[0]).toBe(1);
    expect(regularSeasonWeeks(1, 14)).toHaveLength(14);
  });
});

describe('collectSeasonPoints', () => {
  it('sums players_points across weeks and tolerates missing weeks', async () => {
    const { client } = makeClient({
      '/league/L/matchups/1': [matchupRow(1, { A: 10.5, B: 3 })],
      '/league/L/matchups/2': [matchupRow(1, { A: 4.25 })],
      // weeks 3..17 answer 404
    });
    const totals = await collectSeasonPoints(client, 'L');
    expect(totals['A']).toBeCloseTo(14.75, 5);
    expect(totals['B']).toBeCloseTo(3, 5);
    expect(totals['C']).toBeUndefined();
  });

  it('returns an empty map when no week has data', async () => {
    const { client } = makeClient({});
    expect(await collectSeasonPoints(client, 'L', [1, 2])).toEqual({});
  });

  it('reads the 2025 league in its own scoring', async () => {
    const { client } = makeClient(threeSeasonChain());
    const totals = await collectSeasonPoints(client, L2025);
    expect(totals['W2']).toBe(40);
    expect(totals['A']).toBe(0);
  });
});

describe('buildPositionRanks', () => {
  it('ranks within position over the same graded pool', () => {
    const ranks = buildPositionRanks(
      tenWideReceivers({ P1: 10, P2: 20, P3: 30, P4: 40, P5: 50, P6: 60, P7: 70, P8: 80, P9: 90, PA: 100 }),
    );
    const p1 = ranks.byPlayer['P1'];
    expect(p1?.expectedRank).toBe(1);
    expect(p1?.actualRank).toBe(10);
    expect(p1?.poolSize).toBe(10);
    expect(ranks.poolSizeByPosition['WR']).toBe(10);
  });

  it('excludes players without a draft cost or without points from the pool', () => {
    const ranks = buildPositionRanks([
      { playerId: 'drafted', position: 'RB', totalPoints: 100, draftPickNo: 1 },
      { playerId: 'undrafted', position: 'RB', totalPoints: 100, draftPickNo: null },
      { playerId: 'nopoints', position: 'RB', totalPoints: null, draftPickNo: 2 },
    ]);
    expect(ranks.poolSizeByPosition['RB']).toBe(1);
    expect(ranks.byPlayer['undrafted']?.actualRank).toBeNull();
    expect(ranks.byPlayer['nopoints']?.actualRank).toBeNull();
  });

  it('is deterministic on ties', () => {
    const inputs: PlayerSeasonInput[] = [
      { playerId: 'b', position: 'TE', totalPoints: 5, draftPickNo: 1 },
      { playerId: 'a', position: 'TE', totalPoints: 5, draftPickNo: 2 },
    ];
    const first = buildPositionRanks(inputs);
    const second = buildPositionRanks([...inputs].reverse());
    expect(first.byPlayer['a']?.actualRank).toBe(second.byPlayer['a']?.actualRank);
  });
});

describe('labelForScore', () => {
  it('buckets on the exported thresholds', () => {
    expect(labelForScore(EXCELLENT_THRESHOLD)).toBe('excellent');
    expect(labelForScore(GOOD_THRESHOLD)).toBe('good');
    expect(labelForScore(0)).toBe('neutral');
    expect(labelForScore(DISAPPOINTING_THRESHOLD)).toBe('disappointing');
    expect(labelForScore(DISASTER_THRESHOLD)).toBe('disaster');
    expect(labelForScore(GOOD_THRESHOLD - 0.001)).toBe('neutral');
    expect(labelForScore(DISAPPOINTING_THRESHOLD + 0.001)).toBe('neutral');
  });
});

describe('classify', () => {
  const ranks = buildPositionRanks(
    tenWideReceivers({ P1: 10, P2: 95, P3: 90, P4: 85, P5: 80, P6: 75, P7: 70, P8: 65, P9: 60, PA: 100 }),
  );

  it('classifies a player with no points and no draft cost as neutral, never disappointing', () => {
    const empty = buildPositionRanks([{ playerId: 'ghost', position: null, totalPoints: null, draftPickNo: null }]);
    expect(classify('ghost', null, null, empty)).toBe('neutral');
    expect(classify('ghost', undefined, undefined, empty)).toBe('neutral');
    // and the same player is neutral even inside a fully graded league
    expect(classify('ghost', null, null, ranks)).toBe('neutral');
  });

  it('is neutral when only one of the two inputs is present', () => {
    expect(classify('P1', 10, null, ranks)).toBe('neutral');
    expect(classify('P1', null, 1, ranks)).toBe('neutral');
  });

  it('labels a first-round pick who finished last a disaster', () => {
    // P1 drafted WR1, finished WR10 of 10 -> (1 - 10) / 10 = -0.9
    expect(performanceScore(ranks.byPlayer['P1'])).toBeCloseTo(-0.9, 5);
    expect(classify('P1', 10, 1, ranks)).toBe('disaster');
  });

  it('labels a late pick who finished first excellent', () => {
    // PA drafted WR10, finished WR1 -> (10 - 1) / 10 = 0.9
    expect(classify('PA', 100, 10, ranks)).toBe('excellent');
  });

  it('leaves a player who met expectation neutral', () => {
    // P5 drafted WR5, finished WR5 -> 0
    expect(classify('P5', 80, 5, ranks)).toBe('neutral');
  });

  it('stays neutral when the positional pool is too small to be meaningful', () => {
    const tiny = buildPositionRanks(
      Array.from({ length: MIN_POOL_SIZE - 1 }, (_unused, index) => ({
        playerId: `k${index}`,
        position: 'K',
        totalPoints: index,
        draftPickNo: index + 1,
      })),
    );
    expect(classify('k0', 0, 1, tiny)).toBe('neutral');
  });

  it('lets an override beat the computed label', () => {
    expect(classify('P1', 10, 1, ranks)).toBe('disaster');
    expect(classify('P1', 10, 1, ranks, { P1: 'excellent' })).toBe('excellent');
    // overrides also beat a computed neutral, and apply without any data at all
    expect(classify('ghost', null, null, ranks, { ghost: 'disappointing' })).toBe('disappointing');
  });

  it('ignores an override that is not a known label', () => {
    const bogus = { P1: 'terrible' } as unknown as Record<string, never>;
    expect(classify('P1', 10, 1, ranks, bogus)).toBe('disaster');
  });
});

describe('loadPerformanceOverrides', () => {
  it('returns {} when the file is absent', async () => {
    expect(await loadPerformanceOverrides(path.join(os.tmpdir(), 'nope-does-not-exist.json'))).toEqual({});
  });

  it('reads valid labels and drops invalid ones', async () => {
    const file = await tempFile(
      'performance-overrides.json',
      JSON.stringify({ '7553': 'disappointing', '1466': 'nonsense', '96': 'good' }),
    );
    expect(await loadPerformanceOverrides(file)).toEqual({ '7553': 'disappointing', '96': 'good' });
  });
});
