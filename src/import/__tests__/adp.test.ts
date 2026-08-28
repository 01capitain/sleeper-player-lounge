import { describe, expect, it } from 'vitest';

import { adpFor, enrichWithAdp, type AdpArtifact } from '../adp.js';
import type { SleeperPlayer } from '../../types.js';

function artifact(adp: Record<string, number>): AdpArtifact {
  return {
    source: 'https://api.sleeper.com/projections/nfl/2026/1',
    season: 2026,
    week: 1,
    field: 'adp_dd_half_ppr',
    unrankedSentinel: 1000,
    generatedAt: '2026-08-28T00:00:00.000Z',
    rankedCount: Object.keys(adp).length,
    adp,
  };
}

function player(playerId: string, extra: Partial<SleeperPlayer> = {}): SleeperPlayer {
  return {
    player_id: playerId,
    full_name: playerId,
    position: 'QB',
    team: 'BUF',
    ...extra,
  } as SleeperPlayer;
}

describe('adpFor', () => {
  it('returns the ADP for a ranked player', () => {
    expect(adpFor('4984', artifact({ '4984': 31.4 }))).toBe(31.4);
  });

  it('treats an absent player as unranked rather than very late', () => {
    expect(adpFor('nobody', artifact({ '4984': 31.4 }))).toBeNull();
  });

  it('treats the 1000 sentinel as unranked', () => {
    expect(adpFor('x', artifact({ x: 1000 }))).toBeNull();
  });

  it('rejects non-positive and non-finite values', () => {
    expect(adpFor('a', artifact({ a: 0 }))).toBeNull();
    expect(adpFor('b', artifact({ b: -3 }))).toBeNull();
    expect(adpFor('c', artifact({ c: Number.NaN }))).toBeNull();
  });

  it('returns null when the artifact has not been built', () => {
    expect(adpFor('4984', null)).toBeNull();
  });
});

describe('enrichWithAdp', () => {
  it('merges ADP onto the players dataset', () => {
    const players = { '4984': player('4984'), '96': player('96') };
    enrichWithAdp(players, artifact({ '4984': 31.4 }));
    expect(players['4984']?.adp).toBe(31.4);
    expect(players['96']?.adp).toBeUndefined();
  });

  it('leaves the dataset untouched when no artifact exists', () => {
    const players = { '4984': player('4984') };
    enrichWithAdp(players, null);
    expect(players['4984']?.adp).toBeUndefined();
  });

  it('does not import search_rank as a stand-in for ADP', () => {
    // search_rank ranks Josh Allen around 4th overall; ADP puts him in the 20s-40s.
    // Conflating them would fabricate a ~30-pick "fall" on an ordinary pick.
    const players = { '4984': player('4984', { search_rank: 4 }) };
    enrichWithAdp(players, artifact({}));
    expect(players['4984']?.adp).toBeUndefined();
  });
});
