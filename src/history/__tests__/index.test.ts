import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ChampionsFile, LastSeasonFile, PlayerHistory } from '../../types.js';
import { validatePlayerHistory } from '../../validate.js';
import { writeJson } from '../../util/json.js';
import { importChampions } from '../champions.js';
import { importLastSeason } from '../last-season.js';
import {
  ForbiddenHistoryError,
  assertNoForbiddenHistory,
  buildHistoryStore,
  clearHistoryCache,
  historyFor,
  loadHistory,
  setHistoryStore,
  sharedChampionship,
  sharedRoster2025,
  type HistoryStore,
} from '../index.js';
import { L2026, U_STEPHAN, makeClient, threeSeasonChain } from './harness.js';

const NOW = new Date('2026-08-28T09:00:00.000Z');
const tempDirs: string[] = [];

afterEach(async () => {
  clearHistoryCache();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function importedStore(): Promise<HistoryStore> {
  const { client } = makeClient(threeSeasonChain());
  const [lastSeason, champions] = await Promise.all([
    importLastSeason(client, L2026, { now: NOW, overrides: {} }),
    importChampions(client, L2026, { now: NOW }),
  ]);
  return buildHistoryStore(lastSeason, champions);
}

describe('loadHistory', () => {
  it('tolerates both files being absent', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lounge-history-'));
    tempDirs.push(dir);
    const store = await loadHistory({
      lastSeasonFile: path.join(dir, 'last-season.json'),
      championsFile: path.join(dir, 'champions.json'),
    });
    expect(store.lastSeason).toBeNull();
    expect(store.champions).toBeNull();
    expect(store.championshipsByPlayer).toEqual({});
  });

  it('reads both files and derives the reverse championship lookup', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lounge-history-'));
    tempDirs.push(dir);
    const source = await importedStore();
    const lastSeasonFile = path.join(dir, 'last-season.json');
    const championsFile = path.join(dir, 'champions.json');
    await writeJson(lastSeasonFile, source.lastSeason);
    await writeJson(championsFile, source.champions);

    const store = await loadHistory({ lastSeasonFile, championsFile });
    expect(store.lastSeason?.season).toBe(2025);
    expect(store.championshipsByPlayer['OLD1']?.[0]?.season).toBe(2024);
  });

  it('refuses a last-season file whose season is not 2025', () => {
    const corrupt = { season: 2024, sourceLeagueId: 'L', generatedAt: null, players: {} } as LastSeasonFile;
    expect(() => buildHistoryStore(corrupt, null)).toThrow(ForbiddenHistoryError);
  });
});

describe('historyFor', () => {
  it('emits histories that pass validatePlayerHistory', async () => {
    const store = await importedStore();
    const playerIds = new Set([
      ...Object.keys(store.lastSeason?.players ?? {}),
      ...Object.keys(store.championshipsByPlayer),
    ]);
    expect(playerIds.size).toBeGreaterThan(0);
    for (const playerId of playerIds) {
      const history = historyFor(playerId, store);
      expect(history).not.toBeNull();
      expect(() => validatePlayerHistory(history)).not.toThrow();
      expect(() => assertNoForbiddenHistory(history)).not.toThrow();
    }
  });

  it('combines the 2025 record with the championship list', async () => {
    const store = await importedStore();
    const history = historyFor('A', store);
    expect(history?.lastSeason).toMatchObject({
      season: 2025,
      managerId: U_STEPHAN,
      champion: true,
    });
    expect(history?.championships.map((entry) => entry.season)).toEqual([2025, 2024]);
  });

  it('keeps a pre-2025 championship-only player, with a null lastSeason', async () => {
    const store = await importedStore();
    const history = historyFor('OLD1', store);
    // The deliberate exception: 2024 membership survives even though OLD1 has no
    // 2025 roster history at all.
    expect(history?.lastSeason).toBeNull();
    expect(history?.championships).toEqual([
      expect.objectContaining({ season: 2024, managerId: U_STEPHAN }),
    ]);
    expect(() => validatePlayerHistory(history)).not.toThrow();
  });

  it('drops a player who only appeared on a losing pre-2025 roster', async () => {
    const store = await importedStore();
    expect(historyFor('X', store)).toBeNull();
  });

  it('returns null for a player with no memory at all', async () => {
    const store = await importedStore();
    expect(historyFor('nobody', store)).toBeNull();
  });

  it('uses the memoized store when none is passed', async () => {
    const store = await importedStore();
    setHistoryStore(store);
    expect(historyFor('A')?.playerId).toBe('A');
    clearHistoryCache();
    expect(() => historyFor('A')).toThrow(/loadHistory/);
  });
});

describe('sharedRoster2025', () => {
  it('is true only for players on the same 2025 roster', async () => {
    const store = await importedStore();
    expect(sharedRoster2025('A', 'B', store)).toBe(true);
    expect(sharedRoster2025('A', 'D', store)).toBe(false);
    expect(sharedRoster2025('A', 'A', store)).toBe(false);
    expect(sharedRoster2025('A', 'OLD1', store)).toBe(false);
  });

  it('is false when there is no 2025 file', () => {
    expect(sharedRoster2025('A', 'B', buildHistoryStore(null, null))).toBe(false);
  });
});

describe('sharedChampionship', () => {
  it('reports every season two players won together, newest first', async () => {
    const store = await importedStore();
    expect(sharedChampionship('A', 'OLD1', store)).toEqual([
      { season: 2024, managerName: 'Stephan' },
    ]);
    // 'Stephan', not the 2025 'Salzburg Slowpokes': the fixture's 2026 head
    // league is where the current name comes from. See `applyCurrentNames`.
    expect(sharedChampionship('A', 'B', store)).toEqual([
      { season: 2025, managerName: 'Stephan' },
    ]);
    expect(sharedChampionship('A', 'D', store)).toEqual([]);
    expect(sharedChampionship('A', 'A', store)).toEqual([]);
  });

  it('is empty when there is no champions file', () => {
    expect(sharedChampionship('A', 'B', buildHistoryStore(null, null))).toEqual([]);
  });
});

describe('assertNoForbiddenHistory', () => {
  const forbidden = {
    playerId: '7553',
    lastSeason: {
      season: 2024,
      managerId: 'u1',
      managerName: 'Stephan',
      performance: 'disappointing',
    },
    championships: [],
  } as unknown as PlayerHistory;

  it('throws for ordinary roster history before 2025', () => {
    expect(() => assertNoForbiddenHistory(forbidden)).toThrow(ForbiddenHistoryError);
    expect(() => assertNoForbiddenHistory(forbidden)).toThrow(/7553/);
  });

  it('checks every element of an array', () => {
    const ok: PlayerHistory = { playerId: 'ok', lastSeason: null, championships: [] };
    expect(() => assertNoForbiddenHistory([ok, forbidden])).toThrow(ForbiddenHistoryError);
    expect(() => assertNoForbiddenHistory([ok])).not.toThrow();
  });

  it('permits championships from any season', () => {
    const history: PlayerHistory = {
      playerId: 'p',
      lastSeason: null,
      championships: [
        { season: 2019, managerId: 'u1', managerName: 'Stephan' },
        { season: 2023, managerId: 'u1', managerName: 'Stephan' },
      ],
    };
    expect(() => assertNoForbiddenHistory(history)).not.toThrow();
    expect(() => validatePlayerHistory(history)).not.toThrow();
  });

  it('is a no-op for null and undefined', () => {
    expect(() => assertNoForbiddenHistory(null)).not.toThrow();
    expect(() => assertNoForbiddenHistory(undefined)).not.toThrow();
  });
});

describe('champions file shape', () => {
  it('keys championshipRosters by season string', async () => {
    const store = await importedStore();
    const champions = store.champions as ChampionsFile;
    expect(Object.keys(champions.championshipRosters).sort()).toEqual(['2024', '2025']);
    expect(champions.championshipRosters['2024']?.season).toBe(2024);
  });
});
