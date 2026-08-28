/**
 * Offline fixtures for the import layer.
 *
 * Ids, statuses and shapes come from `docs/sleeper-facts.md` (fetched live on
 * 2026-08-28 and recorded because this sandbox has no network). NFL team codes
 * on the player entries are illustrative — the facts file records ids, not
 * rosters — but every id, league status, draft id, pick number and `picked_by`
 * below is real.
 *
 * Nothing in the test suite may reach the network: `stubFetch` below is the only
 * transport the tests give `SleeperClient`.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { SleeperClient } from '../../sleeper/client.js';
import type {
  SleeperDraft,
  SleeperDraftPick,
  SleeperLeague,
  SleeperUser,
} from '../../sleeper/types.js';
import type { AppConfig, SelectedDraft, SleeperPlayer } from '../../types.js';

export const USER_ID = '471439689564286976';

export const HOTELKIT_LEAGUE_ID = '1389387602825576448';
export const HOTELKIT_DRAFT_ID = '1389387602825576449';
export const BROS_LEAGUE_ID = '1389356983177465856';
export const BROS_DRAFT_ID = '1389356983177465857';
export const AFFC_LEAGUE_ID = '1383332770389958656';
export const AFFC_DRAFT_ID = '1383332771358867456';

// --- config -----------------------------------------------------------------

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    appName: 'Players Lounge',
    season: 2026,
    sleeper: {
      username: '01capitain',
      userId: USER_ID,
      targetLeagueName: 'hotelkit Fantasies',
      targetLeagueStatus: 'pre_draft',
      simulationStrategy: 'auto_select_completed_2026_draft',
    },
    historyRules: {
      lastSeason: 2025,
      ignoreRosterHistoryBefore: 2025,
      preserveChampionshipRostersAllYears: true,
      explicitSeasonMentionRequired: true,
    },
    reactionRules: {
      draftedPlayerMustReact: true,
      includeRelevantCurrentTeammates: true,
      minMessages: 2,
      targetMessages: 4,
      maxMessages: 6,
      maxRegularsPerReaction: 3,
      allowNoOptionalStarReaction: true,
    },
    rendering: {
      defaultFormat: 'mp4',
      supportedFormats: ['png', 'gif', 'mp4'],
      defaultAspectRatio: '9:16',
      defaultDurationSeconds: 8,
      showTypingIndicators: true,
      fictionalInterfaceBranding: true,
      watermark: 'Players Lounge • Fantasy parody',
    },
    ...overrides,
  };
}

// --- leagues ----------------------------------------------------------------

export function league(overrides: Partial<SleeperLeague> & Pick<SleeperLeague, 'league_id' | 'name'>): SleeperLeague {
  return {
    season: '2026',
    sport: 'nfl',
    status: 'pre_draft',
    total_rosters: 12,
    previous_league_id: null,
    draft_id: null,
    ...overrides,
  };
}

/** The operator's three real 2026 leagues. */
export function leagues2026(): SleeperLeague[] {
  return [
    league({
      league_id: HOTELKIT_LEAGUE_ID,
      name: 'hotelkit Fantasies',
      status: 'pre_draft',
      total_rosters: 8,
      draft_id: HOTELKIT_DRAFT_ID,
      previous_league_id: '1257418705789272064',
    }),
    league({
      league_id: BROS_LEAGUE_ID,
      name: 'Defensive Bros',
      status: 'in_season',
      total_rosters: 14,
      draft_id: BROS_DRAFT_ID,
      previous_league_id: '1250143800488120320',
    }),
    league({
      league_id: AFFC_LEAGUE_ID,
      name: 'AFFC Conference League 4',
      status: 'pre_draft',
      total_rosters: 12,
      draft_id: AFFC_DRAFT_ID,
    }),
  ];
}

// --- drafts -----------------------------------------------------------------

export function draft(
  overrides: Partial<SleeperDraft> & Pick<SleeperDraft, 'draft_id' | 'league_id'>,
): SleeperDraft {
  return {
    status: 'pre_draft',
    type: 'snake',
    season: '2026',
    sport: 'nfl',
    start_time: null,
    last_picked: null,
    created: null,
    settings: { rounds: 15, teams: 12 },
    ...overrides,
  };
}

/** Draft slot -> roster id, 14 entries, as Defensive Bros really has. */
export function slotToRosterId(teams = 14): Record<string, number> {
  const map: Record<string, number> = {};
  for (let slot = 1; slot <= teams; slot += 1) map[String(slot)] = slot;
  return map;
}

export function brosDraft(overrides: Partial<SleeperDraft> = {}): SleeperDraft {
  return draft({
    draft_id: BROS_DRAFT_ID,
    league_id: BROS_LEAGUE_ID,
    status: 'complete',
    type: 'snake',
    season: '2026',
    start_time: 1_753_000_000_000,
    last_picked: 1_755_000_000_000,
    created: 1_752_000_000_000,
    settings: { rounds: 17, teams: 14 },
    slot_to_roster_id: slotToRosterId(14),
    ...overrides,
  });
}

// --- picks ------------------------------------------------------------------

export function rawPick(
  overrides: Partial<SleeperDraftPick> &
    Pick<SleeperDraftPick, 'player_id' | 'pick_no' | 'round' | 'draft_slot'>,
): SleeperDraftPick {
  return {
    draft_id: BROS_DRAFT_ID,
    picked_by: null,
    is_keeper: null,
    metadata: null,
    ...overrides,
  };
}

/**
 * A representative slice of the real 241-pick Defensive Bros draft: the first
 * three picks plus the three required Regulars, with their real `picked_by`
 * user ids from `docs/sleeper-facts.md`.
 */
export function brosPicks(): SleeperDraftPick[] {
  return [
    rawPick({
      player_id: '9221',
      pick_no: 1,
      round: 1,
      draft_slot: 1,
      picked_by: '609109430927175680',
      metadata: { first_name: 'Jahmyr', last_name: 'Gibbs', position: 'RB', team: 'DET' },
    }),
    rawPick({
      player_id: '9509',
      pick_no: 2,
      round: 1,
      draft_slot: 2,
      picked_by: '1253837548522844160',
      metadata: { first_name: 'Bijan', last_name: 'Robinson', position: 'RB', team: 'ATL' },
    }),
    rawPick({
      player_id: '6813',
      pick_no: 3,
      round: 1,
      draft_slot: 3,
      picked_by: '851531953642532864',
      metadata: { first_name: 'Jonathan', last_name: 'Taylor', position: 'RB', team: 'IND' },
    }),
    rawPick({
      player_id: '7553',
      pick_no: 74,
      round: 6,
      draft_slot: 5,
      picked_by: '609109430927175680',
      metadata: { first_name: 'Kyle', last_name: 'Pitts', position: 'TE', team: 'ATL' },
    }),
    rawPick({
      player_id: '1466',
      pick_no: 119,
      round: 9,
      draft_slot: 8,
      picked_by: '1253837548522844160',
      metadata: { first_name: 'Travis', last_name: 'Kelce', position: 'TE', team: 'KC' },
    }),
    rawPick({
      player_id: '96',
      pick_no: 229,
      round: 17,
      draft_slot: 11,
      // This manager is deliberately absent from `brosUsers()`.
      picked_by: '851531953642532864',
      metadata: { first_name: 'Aaron', last_name: 'Rodgers', position: 'QB', team: 'PIT' },
    }),
  ];
}

// --- users ------------------------------------------------------------------

export function user(
  overrides: Partial<SleeperUser> & Pick<SleeperUser, 'user_id'>,
): SleeperUser {
  return {
    username: null,
    display_name: null,
    avatar: null,
    metadata: null,
    ...overrides,
  };
}

/**
 * Defensive Bros users. Note `851531953642532864` (who drafted Aaron Rodgers)
 * is missing on purpose: `docs/sleeper-facts.md` records that a league's user
 * list is not 1:1 with its rosters, so the join must degrade, not crash.
 */
export function brosUsers(): SleeperUser[] {
  return [
    user({
      user_id: '609109430927175680',
      display_name: 'pittsbeliever',
      metadata: { team_name: 'Pitts Stop' },
    }),
    // No team_name — must fall back to display_name.
    user({ user_id: '1253837548522844160', display_name: 'swiftie_te' }),
    // Neither — must fall back to username.
    user({ user_id: '1111111111111111111', username: 'lurker' }),
  ];
}

/** Eight hotelkit Fantasies managers, returned in deliberately arbitrary order. */
export function hotelkitUsers(): SleeperUser[] {
  return [
    user({ user_id: '471439689564286976', display_name: '01capitain', metadata: { team_name: 'Capitain' } }),
    user({ user_id: '998877665544332211', display_name: 'hk_two' }),
    user({ user_id: '112233445566778899', display_name: 'hk_three' }),
    user({ user_id: '223344556677889900', display_name: 'hk_four', metadata: { team_name: 'Four Horsemen' } }),
    user({ user_id: '334455667788990011', display_name: 'hk_five' }),
    user({ user_id: '445566778899001122', display_name: 'hk_six' }),
    user({ user_id: '556677889900112233', display_name: 'hk_seven' }),
    user({ user_id: '667788990011223344', display_name: 'hk_eight' }),
  ];
}

// --- players dataset --------------------------------------------------------

export function player(
  overrides: Partial<SleeperPlayer> & Pick<SleeperPlayer, 'player_id'>,
): SleeperPlayer {
  return {
    active: true,
    team: null,
    position: null,
    first_name: null,
    last_name: null,
    full_name: null,
    fantasy_positions: null,
    search_rank: null,
    ...overrides,
  };
}

/** A tiny stand-in for `/players/nfl`, keyed by Sleeper player id. */
export function playerIndex(): Record<string, SleeperPlayer> {
  const entries: SleeperPlayer[] = [
    player({ player_id: '9221', full_name: 'Jahmyr Gibbs', position: 'RB', team: 'DET', search_rank: 2 }),
    player({ player_id: '9509', full_name: 'Bijan Robinson', position: 'RB', team: 'ATL', search_rank: 1 }),
    player({ player_id: '6813', full_name: 'Jonathan Taylor', position: 'RB', team: 'IND', search_rank: 5 }),
    player({ player_id: '7553', full_name: 'Kyle Pitts', position: 'TE', team: 'ATL', search_rank: 60 }),
    player({ player_id: '1466', full_name: 'Travis Kelce', position: 'TE', team: 'KC', search_rank: 45 }),
    player({ player_id: '96', full_name: 'Aaron Rodgers', position: 'QB', team: 'PIT', search_rank: 150 }),
    // More Falcons, for teammate selection.
    player({ player_id: '8112', full_name: 'Drake London', position: 'WR', team: 'ATL', search_rank: 20 }),
    player({ player_id: '8140', full_name: 'Michael Penix Jr.', position: 'QB', team: 'ATL', search_rank: 120 }),
    // Inactive Falcon — never a teammate.
    player({ player_id: '9999', full_name: 'Benched Falcon', position: 'WR', team: 'ATL', active: false }),
    // Free agent: `team === null` — never a teammate or rival.
    player({ player_id: '8888', full_name: 'Free Agent TE', position: 'TE', team: null }),
    // First/last only — exercises the displayName fallback.
    player({ player_id: '7777', first_name: 'Split', last_name: 'Name', position: 'TE', team: 'KC', search_rank: 300 }),
  ];
  const index: Record<string, SleeperPlayer> = {};
  for (const entry of entries) index[entry.player_id] = entry;
  return index;
}

// --- transport --------------------------------------------------------------

export interface StubRoutes {
  [pathSuffix: string]: unknown;
}

export interface StubFetch {
  fetchImpl: typeof fetch;
  /** Every path requested, in order, for asserting what was and was not fetched. */
  calls: string[];
}

/**
 * A `fetch` that answers only from `routes` (keyed by the API path, e.g.
 * `/league/123/users`) and throws on anything else, so a missing fixture surfaces
 * as a loud test failure rather than a silent network call.
 */
export function stubFetch(routes: StubRoutes): StubFetch {
  const calls: string[] = [];
  type FetchInput = Parameters<typeof fetch>[0];
  const fetchImpl = (async (input: FetchInput): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const requestPath = url.replace(/^https?:\/\/[^/]+(\/v1)?/, '');
    calls.push(requestPath);
    if (!(requestPath in routes)) {
      throw new Error(`stubFetch: no fixture for ${requestPath}`);
    }
    return new Response(JSON.stringify(routes[requestPath]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** A client wired to `stubFetch` with caches pointed at a throwaway directory. */
export async function testClient(routes: StubRoutes): Promise<{
  client: SleeperClient;
  calls: string[];
  cacheDir: string;
}> {
  const dir = await mkdtemp(path.join(tmpdir(), 'lounge-sleeper-'));
  const stub = stubFetch(routes);
  const client = new SleeperClient({
    cacheDir: path.join(dir, 'http'),
    playersCacheFile: path.join(dir, 'sleeper-players.json'),
    fetchImpl: stub.fetchImpl,
    sleepImpl: async () => undefined,
  });
  return { client, calls: stub.calls, cacheDir: dir };
}

/** The `SelectedDraft` the real Defensive Bros draft produces. */
export function selectedDraft(overrides: Partial<SelectedDraft> = {}): SelectedDraft {
  return {
    leagueId: BROS_LEAGUE_ID,
    leagueName: 'Defensive Bros',
    draftId: BROS_DRAFT_ID,
    season: 2026,
    status: 'complete',
    type: 'snake',
    rounds: 17,
    teams: 14,
    selectedAt: '2026-08-28T00:00:00.000Z',
    totalPicks: 241,
    ...overrides,
  };
}
