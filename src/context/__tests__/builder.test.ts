import { describe, expect, it, vi } from 'vitest';

import type { PlayerHistory } from '../../types.js';
import {
  ForbiddenHistoryError,
  MAX_RECENT_MESSAGES,
  assertContextClean,
  buildContext,
  type BuildContextDeps,
  type HistoryModuleLike,
} from '../builder.js';
import {
  history2025,
  makeMessage,
  makePick,
  makePlayers,
  starMetaFixture,
  unconnectedRegulars,
} from './fixtures.js';

const players = makePlayers([
  { player_id: '9001', full_name: 'Cameron Dicker', position: 'K', team: 'LAC', search_rank: 180 },
  { player_id: 't1', full_name: 'Ladd McConkey', position: 'WR', team: 'LAC', search_rank: 40 },
  { player_id: '96', full_name: 'Aaron Rodgers', position: 'QB', team: 'PIT', search_rank: 120 },
  { player_id: '1466', full_name: 'Travis Kelce', position: 'TE', team: 'KC', search_rank: 60 },
  { player_id: '7553', full_name: 'Kyle Pitts', position: 'TE', team: 'ATL', search_rank: 95 },
]);

const baseDeps: BuildContextDeps = {
  players,
  starPlayers: unconnectedRegulars,
  state: {
    season: 2026,
    lastProcessedPickNo: 0,
    activeRunningJokes: [
      {
        id: 'kyle-pitts-draft-bust',
        topic: 'Kyle Pitts is remembered by the league as a great draft bust.',
        strength: 1,
        participants: ['kyle_pitts'],
        persistent: true,
      },
    ],
    activeRivalries: [],
    recentTone: 'pre_draft',
  },
  recentMessages: [],
  priorPicks: [],
  history: null,
  teammatesOf: () => [{ playerId: 't1', name: 'Ladd McConkey', position: 'WR', nflTeam: 'LAC' }],
};

describe('assertContextClean — the §14 memory boundary', () => {
  it('throws on a 2024 non-championship roster record', () => {
    const dirty: PlayerHistory = {
      playerId: '9001',
      lastSeason: {
        season: 2024 as unknown as 2025,
        managerId: 'mgr1',
        managerName: 'Max',
        performance: 'good',
        champion: false,
      },
      championships: [],
    };
    expect(() => assertContextClean({ draftedPlayerHistory: dirty })).toThrow(ForbiddenHistoryError);
    expect(() => assertContextClean({ draftedPlayerHistory: dirty })).toThrow(/2024/);
  });

  it('throws when a forbidden record hides in speakerHistories', () => {
    const dirty: PlayerHistory = {
      playerId: '1466',
      lastSeason: {
        season: 2023 as unknown as 2025,
        managerId: 'mgr2',
        managerName: 'Anna',
        performance: 'excellent',
      },
      championships: [],
    };
    expect(() => assertContextClean({ speakerHistories: { '1466': dirty } })).toThrow(
      ForbiddenHistoryError,
    );
  });

  it('passes a 2024 CHAMPIONSHIP record — the one pre-2025 fact that survives', () => {
    const clean: PlayerHistory = {
      playerId: '1466',
      lastSeason: null,
      championships: [
        { season: 2024, managerId: 'mgr2', managerName: 'Anna', sharedChampionPlayerIds: ['96'] },
      ],
    };
    expect(() => assertContextClean({ speakerHistories: { '1466': clean } })).not.toThrow();
  });

  it('passes a pre-2025 roster record that IS the championship roster', () => {
    const clean: PlayerHistory = {
      playerId: '1466',
      lastSeason: {
        season: 2024 as unknown as 2025,
        managerId: 'mgr2',
        managerName: 'Anna',
        performance: 'excellent',
        champion: true,
      },
      championships: [{ season: 2024, managerId: 'mgr2', managerName: 'Anna' }],
    };
    expect(() => assertContextClean({ speakerHistories: { '1466': clean } })).not.toThrow();
  });

  it('passes ordinary 2025 history', () => {
    expect(() =>
      assertContextClean({ draftedPlayerHistory: history2025('9001') }),
    ).not.toThrow();
  });

  it('rejects a championship record with no explicit season (Season Literal rule)', () => {
    const dirty = {
      playerId: '1466',
      lastSeason: null,
      championships: [{ managerId: 'mgr2', managerName: 'Anna' } as never],
    } as PlayerHistory;
    expect(() => assertContextClean({ speakerHistories: { '1466': dirty } })).toThrow(
      /Season Literal/,
    );
  });

  it('rejects a transcript longer than the 20-message cap', () => {
    const tooMany = Array.from({ length: 21 }, (_, index) => makeMessage(index + 1));
    expect(() => assertContextClean({ recentMessages: tooMany })).toThrow(/cap is 20/);
  });
});

describe('buildContext', () => {
  it('assembles everything §9 lists', async () => {
    const context = await buildContext(makePick(), baseDeps);

    expect(context.pick.eventId).toBe('draft1:42:9001');
    expect(context.manager.managerName).toBe('Max');
    expect(context.nflTeammates.map((mate) => mate.name)).toContain('Ladd McConkey');
    expect(context.actors[0]?.role).toBe('drafted_player');
    expect(context.regulars.length).toBeGreaterThan(0);
    expect(context.runningJokes.map((joke) => joke.id)).toContain('kyle-pitts-draft-bust');
    expect(context.simulated).toBe(true);
    expect(context.seed).toBeTypeOf('number');
  });

  it('derives the manager roster from their earlier picks only', async () => {
    const context = await buildContext(makePick({ pickNo: 42 }), {
      ...baseDeps,
      priorPicks: [
        makePick({ pickNo: 6, playerId: 'a', playerName: 'Bijan Robinson', managerId: 'mgr1' }),
        makePick({ pickNo: 7, playerId: 'b', playerName: 'Somebody Else', managerId: 'mgr2', managerName: 'Anna' }),
        makePick({ pickNo: 18, playerId: 'c', playerName: 'Drake London', managerId: 'mgr1' }),
      ],
    });
    expect(context.manager.roster).toEqual(['Bijan Robinson', 'Drake London']);
  });

  it('caps recentMessages at 20', async () => {
    const context = await buildContext(makePick(), {
      ...baseDeps,
      recentMessages: Array.from({ length: 45 }, (_, index) => makeMessage(index + 1)),
    });
    expect(context.recentMessages).toHaveLength(MAX_RECENT_MESSAGES);
    expect(context.recentMessages[0]?.seq).toBe(26);
    expect(context.recentMessages.at(-1)?.seq).toBe(45);
  });

  it('calls assertNoForbiddenHistory from the history module', async () => {
    const assertNoForbiddenHistory = vi.fn();
    const history: HistoryModuleLike = {
      historyFor: () => null,
      assertNoForbiddenHistory,
    };
    await buildContext(makePick(), { ...baseDeps, history });
    expect(assertNoForbiddenHistory).toHaveBeenCalledTimes(1);
    expect(assertNoForbiddenHistory.mock.calls[0]?.[0]).toHaveProperty('speakerHistories');
  });

  it('refuses to return a Context carrying pre-2025 roster history', async () => {
    const history: HistoryModuleLike = {
      historyFor: (playerId) =>
        playerId === '9001'
          ? {
              playerId,
              lastSeason: {
                season: 2024 as unknown as 2025,
                managerId: 'mgr1',
                managerName: 'Max',
                performance: 'good',
              },
              championships: [],
            }
          : null,
    };
    await expect(buildContext(makePick(), { ...baseDeps, history })).rejects.toThrow(
      ForbiddenHistoryError,
    );
  });

  it('carries 2025 history and the shared-roster links between speakers', async () => {
    const shared: Record<string, PlayerHistory> = {
      '9001': history2025('9001', {
        lastSeason: {
          season: 2025,
          managerId: 'mgr1',
          managerName: 'Max',
          performance: 'disappointing',
          teamFinish: 7,
          champion: false,
          sharedRosterPlayerIds: ['1466'],
        },
      }),
      '1466': history2025('1466'),
    };
    const history: HistoryModuleLike = {
      historyFor: (playerId) => shared[playerId] ?? null,
      sharedRoster2025: (a, b) => a === '9001' && b === '1466',
    };
    const context = await buildContext(makePick(), { ...baseDeps, history, seed: 3 });

    expect(context.draftedPlayerHistory?.lastSeason?.season).toBe(2025);
    expect(Object.keys(context.speakerHistories)).toContain('9001');
    if (context.actors.some((actor) => actor.playerId === '1466')) {
      expect(context.sharedRosters.some((link) => link.season === 2025)).toBe(true);
    }
  });

  it('survives a missing history module', async () => {
    const context = await buildContext(makePick(), { ...baseDeps, history: null });
    expect(context.draftedPlayerHistory).toBeNull();
    expect(context.speakerHistories).toEqual({});
  });

  it('derives NFL teammates locally when the importer is unavailable', async () => {
    const context = await buildContext(makePick(), { ...baseDeps, teammatesOf: null });
    expect(context.nflTeammates.map((mate) => mate.name)).toEqual(['Ladd McConkey']);
  });

  it('is deterministic for a given eventId', async () => {
    const a = await buildContext(makePick(), baseDeps);
    const b = await buildContext(makePick(), baseDeps);
    expect(a.actors.map((actor) => actor.playerId)).toEqual(b.actors.map((actor) => actor.playerId));
  });

  it('resolves Regulars onto their live Sleeper ids', async () => {
    const context = await buildContext(makePick(), baseDeps);
    for (const actor of context.actors) {
      if (!actor.starKey) continue;
      const expected = starMetaFixture[actor.starKey]?.playerId;
      if (expected) expect(actor.playerId).toBe(expected);
    }
  });
});
