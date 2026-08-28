/**
 * Offline test harness for the Fantasy Memory importers.
 *
 * The sandbox has no network (`docs/sleeper-facts.md`), so every test drives a
 * real `SleeperClient` with a stubbed `fetchImpl` backed by a path -> body map.
 * Unmapped paths answer 404, which is exactly how Sleeper reports "this league
 * has no bracket / no matchups for that week".
 */
import os from 'node:os';
import path from 'node:path';

import { SleeperClient } from '../../sleeper/client.js';
import type {
  SleeperBracketMatch,
  SleeperDraftPick,
  SleeperLeague,
  SleeperMatchup,
  SleeperRoster,
  SleeperUser,
} from '../../sleeper/types.js';

export const SLEEPER_BASE = 'https://api.sleeper.app/v1';

/** Sleeper request path (e.g. `/league/123/rosters`) -> JSON body. */
export type Routes = Record<string, unknown>;

export interface Harness {
  client: SleeperClient;
  /** Every path requested, in order. */
  requested: string[];
}

let cacheCounter = 0;

/** A `SleeperClient` that only ever sees `routes`, with disk caching disabled. */
export function makeClient(routes: Routes): Harness {
  process.env['LOUNGE_NO_CACHE'] = '1';
  const requested: string[] = [];

  const fetchImpl: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : String(input);
    const requestPath = url.startsWith(SLEEPER_BASE) ? url.slice(SLEEPER_BASE.length) : url;
    requested.push(requestPath);
    const body = routes[requestPath];
    if (body === undefined) {
      return new Response('not found', { status: 404 });
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  cacheCounter += 1;
  const client = new SleeperClient({
    fetchImpl,
    cacheDir: path.join(os.tmpdir(), `lounge-history-test-${process.pid}-${cacheCounter}`),
    sleepImpl: async () => {},
  });

  return { client, requested };
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

export function league(partial: Partial<SleeperLeague> & Pick<SleeperLeague, 'league_id' | 'season'>): SleeperLeague {
  return {
    name: `League ${partial.league_id}`,
    status: 'complete',
    total_rosters: 10,
    previous_league_id: null,
    draft_id: null,
    ...partial,
  };
}

export function user(userId: string, displayName: string, teamName?: string): SleeperUser {
  return {
    user_id: userId,
    username: displayName.toLowerCase(),
    display_name: displayName,
    metadata: teamName === undefined ? null : { team_name: teamName },
  };
}

export function roster(
  rosterId: number,
  ownerId: string | null,
  players: string[],
  leagueId = 'L',
): SleeperRoster {
  return { roster_id: rosterId, owner_id: ownerId, league_id: leagueId, players };
}

export function pick(
  pickNo: number,
  playerId: string,
  position: string,
  draftId = 'D',
): SleeperDraftPick {
  return {
    draft_id: draftId,
    player_id: playerId,
    pick_no: pickNo,
    round: Math.ceil(pickNo / 12),
    draft_slot: ((pickNo - 1) % 12) + 1,
    metadata: { position },
  };
}

export function matchupRow(rosterId: number, playersPoints: Record<string, number>): SleeperMatchup {
  return {
    roster_id: rosterId,
    matchup_id: 1,
    points: 0,
    players: Object.keys(playersPoints),
    starters: [],
    players_points: playersPoints,
  };
}

/**
 * The real hotelkit Fantasies 2025 winners bracket, recorded live in
 * `docs/sleeper-facts.md`. Roster 1 is the champion.
 */
export const HOTELKIT_2025_BRACKET: SleeperBracketMatch[] = [
  { m: 1, r: 1, l: 3, w: 9, t1: 3, t2: 9 },
  { m: 2, r: 1, l: 5, w: 6, t1: 5, t2: 6 },
  { m: 3, r: 2, l: 9, w: 1, t1: 1, t2: 9 },
  { m: 4, r: 2, l: 6, w: 2, t1: 2, t2: 6 },
  { p: 5, m: 5, r: 2, l: 3, w: 5, t1: 3, t2: 5 },
  { p: 1, m: 6, r: 3, l: 2, w: 1, t1: 1, t2: 2 },
  { p: 3, m: 7, r: 3, l: 6, w: 9, t1: 9, t2: 6 },
];

// ---------------------------------------------------------------------------
// A three-season chain shaped like hotelkit Fantasies
// ---------------------------------------------------------------------------

export const L2026 = 'L2026';
export const L2025 = 'L2025';
export const L2024 = 'L2024';
export const D2025 = 'D2025';

/** Stephan, Marta, Jonas — resolved by `user_id` in every season. */
export const U_STEPHAN = 'user-stephan';
export const U_MARTA = 'user-marta';
export const U_JONAS = 'user-jonas';

/**
 * 2026 (8 rosters, in progress) -> 2025 (10 rosters) -> 2024 (14 rosters).
 *
 * Stephan owns `roster_id` 3 in 2025 and `roster_id` 11 in 2024 — the roster-count
 * change that makes `user_id` the only usable identity across seasons.
 */
export function threeSeasonChain(): Routes {
  return {
    [`/league/${L2026}`]: league({
      league_id: L2026,
      season: '2026',
      name: 'hotelkit Fantasies',
      status: 'in_season',
      total_rosters: 8,
      previous_league_id: L2025,
    }),
    [`/league/${L2025}`]: league({
      league_id: L2025,
      season: '2025',
      name: 'hotelkit Fantasies',
      total_rosters: 10,
      previous_league_id: L2024,
      draft_id: 'D2025DRAFT',
    }),
    [`/league/${L2024}`]: league({
      league_id: L2024,
      season: '2024',
      name: 'hotelkit Fantasies',
      total_rosters: 14,
      previous_league_id: null,
      draft_id: 'D2024DRAFT',
    }),

    // 2026 is still being played: no championship decided.
    [`/league/${L2026}/winners_bracket`]: [],
    [`/league/${L2026}/rosters`]: [roster(1, U_STEPHAN, ['A'], L2026)],
    [`/league/${L2026}/users`]: [user(U_STEPHAN, 'Stephan')],

    [`/league/${L2025}/users`]: [
      user(U_STEPHAN, 'Stephan', 'Salzburg Slowpokes'),
      user(U_MARTA, 'Marta'),
      user(U_JONAS, 'Jonas'),
      // Sleeper returns more users than rosters; the extra must be ignored.
      user('user-ghost', 'Ghost'),
    ],
    [`/league/${L2025}/rosters`]: [
      roster(3, U_STEPHAN, ['A', 'B', 'C'], L2025),
      roster(7, U_MARTA, ['D', 'E'], L2025),
      roster(9, U_JONAS, ['F', 'W2'], L2025),
    ],
    [`/league/${L2025}/winners_bracket`]: [
      { m: 1, r: 1, l: 9, w: 3, t1: 3, t2: 9 },
      { p: 1, m: 2, r: 2, l: 7, w: 3, t1: 3, t2: 7 },
      { p: 3, m: 3, r: 2, l: 5, w: 9, t1: 9, t2: 5 },
    ] satisfies SleeperBracketMatch[],
    ['/draft/D2025DRAFT/picks']: [
      pick(1, 'A', 'WR', 'D2025DRAFT'),
      pick(2, 'B', 'WR', 'D2025DRAFT'),
      pick(3, 'C', 'WR', 'D2025DRAFT'),
      pick(4, 'D', 'WR', 'D2025DRAFT'),
      pick(5, 'E', 'WR', 'D2025DRAFT'),
      pick(6, 'F', 'WR', 'D2025DRAFT'),
      pick(7, 'W1', 'WR', 'D2025DRAFT'),
      pick(8, 'W2', 'WR', 'D2025DRAFT'),
    ] satisfies SleeperDraftPick[],
    // Only week 1 exists; weeks 2..17 answer 404 and must be tolerated.
    [`/league/${L2025}/matchups/1`]: [
      matchupRow(3, { A: 0, B: 30, C: 28, D: 26, E: 24, F: 22, W1: 20, W2: 40 }),
    ],

    [`/league/${L2024}/users`]: [user(U_STEPHAN, 'Stephan'), user(U_MARTA, 'Marta')],
    [`/league/${L2024}/rosters`]: [
      // Stephan is roster 11 here but roster 3 in 2025.
      roster(11, U_STEPHAN, ['OLD1', 'OLD2', 'A'], L2024),
      roster(2, U_MARTA, ['X'], L2024),
    ],
    [`/league/${L2024}/winners_bracket`]: [
      { p: 1, m: 1, r: 3, l: 2, w: 11, t1: 11, t2: 2 },
    ] satisfies SleeperBracketMatch[],
    ['/draft/D2024DRAFT/picks']: [],
  };
}

/**
 * Defensive Bros: a single 2025 season whose `previous_league_id` is null.
 * `docs/sleeper-facts.md` records this exact shape — a chain of length 1.
 */
export function singleSeasonChain(): Routes {
  return {
    [`/league/${D2025}`]: league({
      league_id: D2025,
      season: '2025',
      name: 'Defensive Bros',
      total_rosters: 14,
      previous_league_id: null,
      draft_id: 'DB2025DRAFT',
    }),
    [`/league/${D2025}/users`]: [user(U_MARTA, 'Marta')],
    [`/league/${D2025}/rosters`]: [roster(4, U_MARTA, ['P1', 'P2'], D2025)],
    [`/league/${D2025}/winners_bracket`]: [
      { p: 1, m: 1, r: 3, l: 6, w: 4, t1: 4, t2: 6 },
    ] satisfies SleeperBracketMatch[],
    ['/draft/DB2025DRAFT/picks']: [],
  };
}
