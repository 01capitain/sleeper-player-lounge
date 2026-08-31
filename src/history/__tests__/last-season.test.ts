import { describe, expect, it } from 'vitest';

import {
  LAST_SEASON,
  MissingLastSeasonError,
  importLastSeason,
  placementsFromBracket,
} from '../last-season.js';
import {
  D2025,
  HOTELKIT_2025_BRACKET,
  L2024,
  L2025,
  L2026,
  U_JONAS,
  U_MARTA,
  U_STEPHAN,
  league,
  makeClient,
  singleSeasonChain,
  threeSeasonChain,
} from './harness.js';

const NOW = new Date('2026-08-28T09:00:00.000Z');

describe('placementsFromBracket', () => {
  it('awards p to the winner and p+1 to the loser', () => {
    const finishes = placementsFromBracket(HOTELKIT_2025_BRACKET);
    expect(finishes[1]).toBe(1); // p:1 winner
    expect(finishes[2]).toBe(2); // p:1 loser
    expect(finishes[9]).toBe(3); // p:3 winner
    expect(finishes[6]).toBe(4);
    expect(finishes[5]).toBe(5);
    expect(finishes[3]).toBe(6);
  });

  it('never derives a finish from a non-placement match', () => {
    const finishes = placementsFromBracket([{ m: 1, r: 1, w: 9, l: 3, t1: 3, t2: 9 }]);
    expect(finishes).toEqual({});
  });

  it('tolerates a missing bracket', () => {
    expect(placementsFromBracket(null)).toEqual({});
    expect(placementsFromBracket(undefined)).toEqual({});
  });
});

describe('importLastSeason', () => {
  it('imports the 2025 season of a chain reached from its 2026 head', async () => {
    const { client } = makeClient(threeSeasonChain());
    const file = await importLastSeason(client, L2026, { now: NOW, overrides: {} });

    expect(file.season).toBe(LAST_SEASON);
    expect(file.sourceLeagueId).toBe(L2025);
    expect(file.generatedAt).toBe('2026-08-28T09:00:00.000Z');
    expect(Object.keys(file.players).sort()).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'W2']);
  });

  it('lets no non-championship pre-2025 roster reach the output', async () => {
    // implementation_plan.md §14: no non-championship roster history before 2025
    // may reach the prompt. X sat on the losing 2024 roster.
    const { client } = makeClient(threeSeasonChain());
    const file = await importLastSeason(client, L2026, { now: NOW, overrides: {} });

    expect(file.players['X']).toBeUndefined();
    expect(file.players['OLD1']).toBeUndefined();
    expect(file.players['OLD2']).toBeUndefined();
    expect(file.season).toBe(2025);
  });

  it('resolves managers by user_id across a roster-count change', async () => {
    const { client } = makeClient(threeSeasonChain());
    const file = await importLastSeason(client, L2026, { now: NOW, overrides: {} });

    // Stephan is roster 3 in the 10-team 2025 season and roster 11 in the
    // 14-team 2024 season; the record must carry his user_id either way.
    expect(file.players['A']?.managerId).toBe(U_STEPHAN);
    expect(file.players['D']?.managerId).toBe(U_MARTA);
    expect(file.players['F']?.managerId).toBe(U_JONAS);
  });

  describe('the name a memory calls a manager', () => {
    it('uses the name he goes by now, not the one that season held', async () => {
      // The bug: Sleeper scopes `team_name` per league, so renaming a team
      // mid-draft leaves 2025 calling the same manager something else — and a
      // scene that says 'Salzburg Slowpokes drafted him' while the board says
      // 'Stephan' reads as two different people. The fixture's 2026 head league
      // has no team name for him, so 'Stephan' is what Sleeper shows today.
      const { client } = makeClient(threeSeasonChain());
      const file = await importLastSeason(client, L2026, { now: NOW, overrides: {} });

      expect(file.players['A']?.managerName).toBe('Stephan');
      expect(file.players['A']?.managerId).toBe(U_STEPHAN);
    });

    it('keeps that season\'s own name when no current names are supplied', async () => {
      const { client } = makeClient(threeSeasonChain());
      const file = await importLastSeason(client, L2026, {
        now: NOW,
        overrides: {},
        currentNames: {},
      });

      expect(file.players['A']?.managerName).toBe('Salzburg Slowpokes');
    });

    it('never trades a real name for a bare user id', async () => {
      const { client } = makeClient(threeSeasonChain());
      const file = await importLastSeason(client, L2026, {
        now: NOW,
        overrides: {},
        // What `managerNameIndex` emits for a user with no name at all.
        currentNames: { [U_STEPHAN]: U_STEPHAN },
      });

      expect(file.players['A']?.managerName).toBe('Salzburg Slowpokes');
    });
  });

  it('derives teamFinish and champion from the winners bracket', async () => {
    const { client } = makeClient(threeSeasonChain());
    const file = await importLastSeason(client, L2026, { now: NOW, overrides: {} });

    expect(file.players['A']).toMatchObject({ teamFinish: 1, champion: true });
    expect(file.players['D']).toMatchObject({ teamFinish: 2, champion: false });
    expect(file.players['F']).toMatchObject({ teamFinish: 3, champion: false });
  });

  it('records 2025 fantasy teammates', async () => {
    const { client } = makeClient(threeSeasonChain());
    const file = await importLastSeason(client, L2026, { now: NOW, overrides: {} });

    expect(file.players['A']?.sharedRosterPlayerIds).toEqual(['B', 'C']);
    expect(file.players['D']?.sharedRosterPlayerIds).toEqual(['E']);
  });

  it('classifies deterministically from draft cost and league-scored points', async () => {
    const { client } = makeClient(threeSeasonChain());
    const file = await importLastSeason(client, L2026, { now: NOW, overrides: {} });

    expect(file.players['A']?.performance).toBe('disaster'); // WR1 cost, WR8 finish
    expect(file.players['W2']?.performance).toBe('excellent'); // WR8 cost, WR1 finish
    expect(file.players['C']?.performance).toBe('neutral'); // met expectation
  });

  it('lets overrides beat the computed label', async () => {
    const { client } = makeClient(threeSeasonChain());
    const file = await importLastSeason(client, L2026, {
      now: NOW,
      overrides: { A: 'good' },
    });
    expect(file.players['A']?.performance).toBe('good');
  });

  it('imports a chain of length 1 without error and stays neutral without a draft', async () => {
    const { client } = makeClient(singleSeasonChain());
    const file = await importLastSeason(client, D2025, { now: NOW, overrides: {} });

    expect(file.sourceLeagueId).toBe(D2025);
    expect(Object.keys(file.players).sort()).toEqual(['P1', 'P2']);
    // No draft picks and no matchups: nothing may be invented.
    expect(file.players['P1']?.performance).toBe('neutral');
    expect(file.players['P2']?.performance).toBe('neutral');
    expect(file.players['P1']?.champion).toBe(true);
  });

  it('throws a named error when the chain has no 2025 season', async () => {
    const { client } = makeClient({
      '/league/ONLY2026': league({ league_id: 'ONLY2026', season: '2026', previous_league_id: null }),
    });
    await expect(importLastSeason(client, 'ONLY2026', { overrides: {} })).rejects.toBeInstanceOf(
      MissingLastSeasonError,
    );
  });

  it('never fetches an older league than 2025 for roster history', async () => {
    const { client, requested } = makeClient(threeSeasonChain());
    await importLastSeason(client, L2026, { now: NOW, overrides: {} });
    // The chain walk reads the 2024 league object, but nothing else about it.
    expect(requested).toContain(`/league/${L2024}`);
    expect(requested.some((entry) => entry.startsWith(`/league/${L2024}/`))).toBe(false);
  });
});
