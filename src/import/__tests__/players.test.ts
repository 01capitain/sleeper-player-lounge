/**
 * The players dataset helpers (implementation_plan.md §7).
 */
import { describe, expect, it } from 'vitest';

import { displayName, ensurePlayerCache, positionRivals, teammatesOf } from '../players.js';
import { player, playerIndex, testClient } from './fixtures.js';
import type { SleeperPlayer } from '../../types.js';

describe('displayName', () => {
  it('prefers full_name', () => {
    expect(displayName(playerIndex()['1466'])).toBe('Travis Kelce');
  });

  it('falls back to first + last', () => {
    expect(displayName(playerIndex()['7777'])).toBe('Split Name');
  });

  it('falls back to the player id, and never returns undefined', () => {
    expect(displayName(player({ player_id: '404' }))).toBe('404');
    expect(displayName(undefined)).toBe('');
  });
});

describe('teammatesOf', () => {
  it('returns domain player references, not raw dataset rows', () => {
    expect(teammatesOf('7553', playerIndex())[0]).toEqual({
      playerId: '9509',
      name: 'Bijan Robinson',
      position: 'RB',
      nflTeam: 'ATL',
    });
  });

  it('returns current NFL teammates, most prominent first', () => {
    const teammates = teammatesOf('7553', playerIndex()).map((entry) => entry.playerId);
    expect(teammates).toEqual(['9509', '8112', '8140']);
  });

  it('excludes the player himself', () => {
    expect(teammatesOf('7553', playerIndex()).map((p) => p.playerId)).not.toContain('7553');
  });

  it('excludes inactive players', () => {
    expect(teammatesOf('7553', playerIndex()).map((p) => p.playerId)).not.toContain('9999');
  });

  it('excludes free agents (team === null) on both sides of the join', () => {
    const players = playerIndex();
    // A null-team player has no teammates at all...
    expect(teammatesOf('8888', players)).toEqual([]);
    // ...and is never returned as one.
    expect(teammatesOf('7553', players).map((p) => p.playerId)).not.toContain('8888');
  });

  it('returns nothing for an unknown player id', () => {
    expect(teammatesOf('does-not-exist', playerIndex())).toEqual([]);
  });

  it('honours the optional limit', () => {
    expect(teammatesOf('7553', playerIndex(), 2)).toHaveLength(2);
  });
});

describe('positionRivals', () => {
  it('returns other active players at the same position', () => {
    const rivals = positionRivals('7553', playerIndex()).map((entry) => entry.playerId);
    expect(rivals).toContain('1466'); // Travis Kelce, the other TE
    expect(rivals).not.toContain('7553');
    expect(rivals).not.toContain('8888'); // free-agent TE
    expect(rivals).not.toContain('9509'); // an RB, not a TE
  });

  it('respects the limit and orders by prominence', () => {
    const rivals = positionRivals('7553', playerIndex(), 1);
    expect(rivals).toHaveLength(1);
    expect(rivals[0]?.playerId).toBe('1466');
  });

  it('returns nothing for an unknown or position-less player', () => {
    expect(positionRivals('nope', playerIndex(), 5)).toEqual([]);
    expect(positionRivals('x', { x: player({ player_id: 'x', team: 'KC' }) }, 5)).toEqual([]);
  });
});

describe('ensurePlayerCache', () => {
  it('loads the dataset through the client, keyed by player id', async () => {
    const { client, calls } = await testClient({ '/players/nfl': playerIndex() });

    const players = await ensurePlayerCache(client);

    expect(players['1466']?.full_name).toBe('Travis Kelce');
    expect(calls).toEqual(['/players/nfl']);
  });

  it('serves the second call from the local cache', async () => {
    const { client, calls } = await testClient({ '/players/nfl': playerIndex() });

    await ensurePlayerCache(client);
    await ensurePlayerCache(client);

    expect(calls).toHaveLength(1);
  });
});

describe('retired players are not current teammates', () => {
  // Regression: Sleeper reports Ben Roethlisberger as active:true, status:"Active",
  // team:"PIT" years after he retired, so he appeared in the Lounge as one of
  // Aaron Rodgers' current Steelers teammates. `active` cannot be trusted;
  // `depth_chart_order` is the signal that actually tracks the roster.
  function steelers(): Record<string, SleeperPlayer> {
    const entries = [
      player({ player_id: '96', full_name: 'Aaron Rodgers', position: 'QB', team: 'PIT', depth_chart_order: 1, search_rank: 195 }),
      player({ player_id: '138', full_name: 'Ben Roethlisberger', position: 'QB', team: 'PIT', depth_chart_order: null, search_rank: 176 }),
      player({ player_id: '9999', full_name: 'Mason Rudolph', position: 'QB', team: 'PIT', depth_chart_order: 2 }),
      player({ player_id: '8888', full_name: 'Just Signed', position: 'WR', team: 'PIT', depth_chart_order: null, adp: 210 }),
    ];
    return Object.fromEntries(entries.map((e) => [e.player_id, e]));
  }

  it('excludes a retired player Sleeper still flags active', () => {
    expect(teammatesOf('96', steelers()).map((m) => m.name)).not.toContain('Ben Roethlisberger');
  });

  it('keeps players who are on the depth chart', () => {
    expect(teammatesOf('96', steelers()).map((m) => m.name)).toContain('Mason Rudolph');
  });

  it('keeps a fantasy-relevant player with an ADP but no depth chart entry yet', () => {
    expect(teammatesOf('96', steelers()).map((m) => m.name)).toContain('Just Signed');
  });
});
