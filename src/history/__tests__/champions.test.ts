import { describe, expect, it } from 'vitest';

import {
  buildChampionshipIndex,
  findChampionRosterId,
  importChampions,
  managerIdentity,
  managerNameIndex,
} from '../champions.js';
import {
  HOTELKIT_2025_BRACKET,
  L2026,
  U_MARTA,
  U_STEPHAN,
  makeClient,
  roster,
  singleSeasonChain,
  threeSeasonChain,
  user,
  D2025,
} from './harness.js';

describe('findChampionRosterId', () => {
  it('reads the champion from the real hotelkit 2025 winners bracket', () => {
    // The trap: match m:6 has r:3 and w:1. `r` is the round, `w` is the winner.
    expect(findChampionRosterId(HOTELKIT_2025_BRACKET)).toBe(1);
  });

  it('ignores rounds and other placement matches', () => {
    const bracket = HOTELKIT_2025_BRACKET.filter((match) => match.p !== 1);
    expect(findChampionRosterId(bracket)).toBeNull();
  });

  it('returns null for an empty, missing or undecided bracket', () => {
    expect(findChampionRosterId([])).toBeNull();
    expect(findChampionRosterId(null)).toBeNull();
    expect(findChampionRosterId(undefined)).toBeNull();
    expect(findChampionRosterId([{ p: 1, m: 6, r: 3, t1: 1, t2: 2 }])).toBeNull();
  });
});

describe('managerNameIndex / managerIdentity', () => {
  it('prefers team_name, then display_name, then username', () => {
    const names = managerNameIndex([
      user('u1', 'Stephan', 'Salzburg Slowpokes'),
      user('u2', 'Marta'),
    ]);
    expect(names['u1']).toBe('Salzburg Slowpokes');
    expect(names['u2']).toBe('Marta');
  });

  it('resolves a roster to its owner user_id, not its roster_id', () => {
    const names = managerNameIndex([user('u1', 'Stephan')]);
    expect(managerIdentity(roster(11, 'u1', []), names)).toEqual({
      managerId: 'u1',
      managerName: 'Stephan',
    });
  });

  it('falls back to a stable synthetic id for an unowned roster', () => {
    const identity = managerIdentity(roster(4, null, [], 'LX'), {});
    expect(identity.managerId).toBe('unowned:LX:4');
  });
});

describe('importChampions', () => {
  it('keeps championship membership from every season, including pre-2025', async () => {
    const { client } = makeClient(threeSeasonChain());
    const file = await importChampions(client, L2026, { now: new Date('2026-08-28T00:00:00.000Z') });

    expect(Object.keys(file.championshipRosters).sort()).toEqual(['2024', '2025']);
    // The deliberate exception to the memory cutoff.
    expect(file.championshipRosters['2024']).toMatchObject({
      season: 2024,
      managerId: U_STEPHAN,
      managerName: 'Stephan',
    });
    expect(file.championshipRosters['2024']?.playerIds).toEqual(['A', 'OLD1', 'OLD2']);
    expect(file.generatedAt).toBe('2026-08-28T00:00:00.000Z');
  });

  it('skips a season whose championship has not been decided', async () => {
    const { client } = makeClient(threeSeasonChain());
    const file = await importChampions(client, L2026);
    expect(file.championshipRosters['2026']).toBeUndefined();
  });

  it('resolves the same manager across a roster-count change', async () => {
    const { client } = makeClient(threeSeasonChain());
    const file = await importChampions(client, L2026);
    // Stephan is roster 11 in the 14-team 2024 season and roster 3 in the
    // 10-team 2025 season; only user_id carries identity across.
    expect(file.championshipRosters['2024']?.managerId).toBe(U_STEPHAN);
    expect(file.championshipRosters['2025']?.managerId).toBe(U_STEPHAN);
  });

  it('imports a chain of length 1 without error', async () => {
    const { client } = makeClient(singleSeasonChain());
    const file = await importChampions(client, D2025);
    expect(Object.keys(file.championshipRosters)).toEqual(['2025']);
    expect(file.championshipRosters['2025']?.managerId).toBe(U_MARTA);
  });
});

describe('buildChampionshipIndex', () => {
  it('reverses rosters into a player -> championships lookup, newest first', async () => {
    const { client } = makeClient(threeSeasonChain());
    const index = buildChampionshipIndex(await importChampions(client, L2026));

    expect(index['A']?.map((entry) => entry.season)).toEqual([2025, 2024]);
    expect(index['OLD1']?.map((entry) => entry.season)).toEqual([2024]);
    expect(index['OLD1']?.[0]?.sharedChampionPlayerIds).toEqual(['A', 'OLD2']);
    // A non-championship 2024 roster contributes nothing.
    expect(index['X']).toBeUndefined();
  });

  it('tolerates a missing champions file', () => {
    expect(buildChampionshipIndex(null)).toEqual({});
    expect(buildChampionshipIndex(undefined)).toEqual({});
  });
});
