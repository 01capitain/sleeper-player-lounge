/**
 * Shared offline fixtures for the context and director tests.
 *
 * Nothing here touches the network, the `claude` binary, or the real data files:
 * every test builds its own tiny cast so the ambient-Regular behaviour can be
 * asserted precisely rather than inferred from production data.
 */
import type {
  LoungeMessage,
  Pick,
  PlayerHistory,
  SleeperPlayer,
  StarPlayer,
} from '../../types.js';

export function makePick(overrides: Partial<Pick> = {}): Pick {
  const draftId = overrides.draftId ?? 'draft1';
  const pickNo = overrides.pickNo ?? 42;
  const playerId = overrides.playerId ?? '9001';
  return {
    eventId: overrides.eventId ?? `${draftId}:${pickNo}:${playerId}`,
    season: 2026,
    leagueId: 'league1',
    draftId,
    pickNo,
    round: 4,
    draftSlot: 6,
    playerId,
    playerName: 'Cameron Dicker',
    position: 'K',
    nflTeam: 'LAC',
    managerId: 'mgr1',
    managerName: 'Max',
    pickedAt: '2026-08-01T10:00:00.000Z',
    simulated: true,
    ...overrides,
  };
}

/**
 * Three Regulars with no connection whatsoever to the fixture Pick: different
 * NFL teams, different positions, no relationships, no shared history.
 */
export const unconnectedRegulars: StarPlayer[] = [
  {
    key: 'aaron_rodgers',
    name: 'Aaron Rodgers',
    position: 'QB',
    required: true,
    activity: 0.92,
    voice: ['veteran', 'dry'],
    hooks: ['remembers the good old days in Green Bay'],
  },
  {
    key: 'travis_kelce',
    name: 'Travis Kelce',
    position: 'TE',
    required: true,
    activity: 0.95,
    voice: ['loud', 'pop-culture-heavy'],
    hooks: ['Taylor Swift references without quoting lyrics'],
    guardrails: ['Do not quote copyrighted Taylor Swift lyrics.'],
  },
  {
    key: 'kyle_pitts',
    name: 'Kyle Pitts',
    position: 'TE',
    required: true,
    activity: 0.9,
    voice: ['deadpan', 'defensive'],
    hooks: ['knows the league remembers him as a bust'],
    leagueLore: ['Kyle Pitts is a recurring symbol of draft disappointment in this league.'],
  },
];

export const starMetaFixture: Record<string, { playerId: string; nflTeam: string; position: string }> =
  {
    aaron_rodgers: { playerId: '96', nflTeam: 'PIT', position: 'QB' },
    travis_kelce: { playerId: '1466', nflTeam: 'KC', position: 'TE' },
    kyle_pitts: { playerId: '7553', nflTeam: 'ATL', position: 'TE' },
  };

export function makePlayers(
  entries: Partial<SleeperPlayer>[],
): Record<string, SleeperPlayer> {
  const out: Record<string, SleeperPlayer> = {};
  for (const entry of entries) {
    const playerId = entry.player_id ?? 'unknown';
    out[playerId] = {
      player_id: playerId,
      full_name: entry.full_name ?? playerId,
      position: entry.position ?? null,
      team: entry.team ?? null,
      active: entry.active ?? true,
      search_rank: entry.search_rank ?? null,
      ...entry,
    };
  }
  return out;
}

export function makeMessage(seq: number, overrides: Partial<LoungeMessage> = {}): LoungeMessage {
  return {
    eventId: `draft1:${seq}:x`,
    seq,
    speakerPlayerId: '1466',
    speakerName: 'Travis Kelce',
    text: `message ${seq}`,
    reason: 'star_regular',
    createdAt: '2026-08-01T09:00:00.000Z',
    simulated: true,
    ...overrides,
  };
}

/** 2025 roster history — the only ordinary history the rules allow. */
export function history2025(
  playerId: string,
  overrides: Partial<PlayerHistory> = {},
): PlayerHistory {
  return {
    playerId,
    lastSeason: {
      season: 2025,
      managerId: 'mgr1',
      managerName: 'Max',
      performance: 'disappointing',
      teamFinish: 7,
      champion: false,
      sharedRosterPlayerIds: [],
    },
    championships: [],
    ...overrides,
  };
}
