import { describe, expect, it } from 'vitest';

import {
  findLeagueForSeason,
  normalizePreviousLeagueId,
  seasonOf,
  walkLeagueChain,
} from '../chain.js';
import { D2025, L2024, L2025, L2026, league, makeClient, singleSeasonChain, threeSeasonChain } from './harness.js';

describe('normalizePreviousLeagueId', () => {
  it('treats every Sleeper spelling of "no predecessor" as null', () => {
    expect(normalizePreviousLeagueId(null)).toBeNull();
    expect(normalizePreviousLeagueId(undefined)).toBeNull();
    expect(normalizePreviousLeagueId('')).toBeNull();
    expect(normalizePreviousLeagueId('  ')).toBeNull();
    expect(normalizePreviousLeagueId('0')).toBeNull();
    expect(normalizePreviousLeagueId('null')).toBeNull();
    expect(normalizePreviousLeagueId(' 123 ')).toBe('123');
  });
});

describe('walkLeagueChain', () => {
  it('follows previous_league_id backwards, newest season first', async () => {
    const { client } = makeClient(threeSeasonChain());
    const chain = await walkLeagueChain(client, L2026);
    expect(chain.map((entry) => entry.league_id)).toEqual([L2026, L2025, L2024]);
    expect(chain.map(seasonOf)).toEqual([2026, 2025, 2024]);
  });

  it('accepts a chain of length 1 when previous_league_id is null', async () => {
    // docs/sleeper-facts.md: Defensive Bros 2025 has previous_league_id null.
    const { client } = makeClient(singleSeasonChain());
    const chain = await walkLeagueChain(client, D2025);
    expect(chain).toHaveLength(1);
    expect(chain[0]?.previous_league_id).toBeNull();
  });

  it('stops on a cycle instead of looping forever', async () => {
    const { client } = makeClient({
      '/league/A': league({ league_id: 'A', season: '2026', previous_league_id: 'B' }),
      '/league/B': league({ league_id: 'B', season: '2025', previous_league_id: 'A' }),
    });
    const chain = await walkLeagueChain(client, 'A');
    expect(chain.map((entry) => entry.league_id)).toEqual(['A', 'B']);
  });

  it('honours maxSeasons', async () => {
    const { client } = makeClient(threeSeasonChain());
    const chain = await walkLeagueChain(client, L2026, 2);
    expect(chain.map((entry) => entry.league_id)).toEqual([L2026, L2025]);
  });

  it('truncates rather than throwing when a predecessor is unreachable', async () => {
    const { client } = makeClient({
      '/league/A': league({ league_id: 'A', season: '2026', previous_league_id: 'GONE' }),
    });
    const chain = await walkLeagueChain(client, 'A');
    expect(chain.map((entry) => entry.league_id)).toEqual(['A']);
  });

  it('propagates a failure on the head league', async () => {
    const { client } = makeClient({});
    await expect(walkLeagueChain(client, 'MISSING')).rejects.toThrow(/404/);
  });

  it('finds a league by season', async () => {
    const { client } = makeClient(threeSeasonChain());
    const chain = await walkLeagueChain(client, L2026);
    expect(findLeagueForSeason(chain, 2025)?.league_id).toBe(L2025);
    expect(findLeagueForSeason(chain, 2024)?.league_id).toBe(L2024);
    expect(findLeagueForSeason(chain, 2019)).toBeNull();
  });
});
