/**
 * The 2025 roster-history importer.
 *
 * 2025 is the *only* ordinary fantasy-roster history the Lounge may use
 * (CONTEXT.md "Fantasy Memory", implementation_plan.md §4). This module therefore
 * looks at exactly one league in the chain — the one whose season is 2025 — and
 * never reads an older one. Championship Membership, the single exception, is
 * `champions.ts`' job.
 *
 * Manager identity is resolved by Sleeper `user_id` throughout: roster counts
 * change every season (hotelkit ran 8 / 10 / 14 rosters in 2026 / 2025 / 2024),
 * so `roster_id` and draft slot mean nothing across seasons.
 */
import type { SleeperClient } from '../sleeper/client.js';
import type {
  SleeperBracketMatch,
  SleeperDraftPick,
  SleeperLeague,
  SleeperRoster,
  SleeperUser,
} from '../sleeper/types.js';
import type { LastSeasonFile, PerformanceLabel, PerformanceOverrides } from '../types.js';
import { log } from '../util/log.js';
import { MAX_CHAIN_LENGTH, findLeagueForSeason, walkLeagueChain } from './chain.js';
import { currentManagerNames, managerIdentity, managerNameIndex } from './champions.js';
import {
  buildPositionRanks,
  classify,
  collectSeasonPoints,
  loadPerformanceOverrides,
  regularSeasonWeeks,
  type PlayerSeasonInput,
} from './performance.js';

/** The one season of ordinary roster history the product allows. */
export const LAST_SEASON = 2025;

/** Thrown when the chain contains no 2025 season to import. */
export class MissingLastSeasonError extends Error {
  readonly leagueId: string;
  readonly seasonsFound: number[];
  constructor(leagueId: string, seasonsFound: number[]) {
    super(
      `No ${LAST_SEASON} season in the league chain starting at ${leagueId}` +
        (seasonsFound.length > 0 ? ` (found ${seasonsFound.join(', ')})` : ' (empty chain)'),
    );
    this.name = 'MissingLastSeasonError';
    this.leagueId = leagueId;
    this.seasonsFound = seasonsFound;
  }
}

/**
 * Final placements per `roster_id`, derived from the winners bracket.
 *
 * A match with placement `p` awards `p` to its winner (`w`) and `p + 1` to its
 * loser (`l`) — so the `p:1` match yields 1st and 2nd, `p:3` yields 3rd and 4th,
 * and so on. Rosters that never reached a placement match get no entry, and
 * `teamFinish` stays null: "where derivable, else null".
 *
 * `r` is the round number and is never consulted.
 */
export function placementsFromBracket(
  bracket: readonly SleeperBracketMatch[] | null | undefined,
): Record<number, number> {
  const finishes: Record<number, number> = {};
  if (!Array.isArray(bracket)) return finishes;

  for (const match of bracket) {
    if (match === null || typeof match !== 'object') continue;
    const placement = match.p;
    if (typeof placement !== 'number' || !Number.isFinite(placement)) continue;
    if (typeof match.w === 'number' && Number.isFinite(match.w)) finishes[match.w] = placement;
    if (typeof match.l === 'number' && Number.isFinite(match.l)) finishes[match.l] = placement + 1;
  }
  return finishes;
}

export interface ImportLastSeasonOptions {
  /** Weeks summed for the performance classifier. Defaults to 1..17. */
  weeks?: readonly number[];
  /** Overrides to apply directly, bypassing the overrides file. */
  overrides?: PerformanceOverrides;
  /** Alternative overrides file. Defaults to `paths.performanceOverridesFile`. */
  overridesFile?: string;
  maxSeasons?: number;
  /**
   * The names managers go by today. Defaults to the users of `leagueId` — the
   * head of the chain, i.e. the season being drafted. See `applyCurrentNames`.
   */
  currentNames?: Record<string, string>;
  /** Injectable clock so tests get a stable `generatedAt`. */
  now?: Date;
}

/**
 * Build `data/fantasy-history/last-season.json` for the 2025 season of a chain.
 *
 * Accepts any league id in the chain — the 2026 head or the 2025 league itself —
 * and walks backwards to find 2025. Every emitted record carries season 2025 by
 * construction; nothing older can reach the output.
 */
export async function importLastSeason(
  client: SleeperClient,
  leagueId: string,
  options: ImportLastSeasonOptions = {},
): Promise<LastSeasonFile> {
  const chain = await walkLeagueChain(client, leagueId, options.maxSeasons ?? MAX_CHAIN_LENGTH);
  const league = findLeagueForSeason(chain, LAST_SEASON);
  if (league === null) {
    throw new MissingLastSeasonError(
      leagueId,
      chain.map((entry) => Number.parseInt(String(entry.season), 10)),
    );
  }

  const [rosters, users, bracket, picks] = await Promise.all([
    safe(() => client.getLeagueRosters(league.league_id), [] as SleeperRoster[], 'rosters'),
    safe(() => client.getLeagueUsers(league.league_id), [] as SleeperUser[], 'users'),
    safe(() => client.getWinnersBracket(league.league_id), [] as SleeperBracketMatch[], 'winners bracket'),
    fetchDraftPicks(client, league),
  ]);

  const points = await collectSeasonPoints(
    client,
    league.league_id,
    options.weeks ?? regularSeasonWeeks(),
  );
  const overrides =
    options.overrides ?? (await loadPerformanceOverrides(options.overridesFile));

  const current = options.currentNames ?? (await currentManagerNames(client, leagueId));
  const names = managerNameIndex(users, current);
  const finishes = placementsFromBracket(bracket);
  const ranks = buildPositionRanks(seasonInputs(rosters, picks, points));

  const players: LastSeasonFile['players'] = {};

  for (const roster of Array.isArray(rosters) ? rosters : []) {
    if (roster === null || typeof roster !== 'object') continue;
    const { managerId, managerName } = managerIdentity(roster, names);
    const teamFinish = finishes[roster.roster_id] ?? null;
    const rosterPlayerIds = [...new Set(roster.players ?? [])].sort();

    for (const playerId of rosterPlayerIds) {
      const draftPickNo = pickNumberFor(picks, playerId);
      const performance: PerformanceLabel = classify(
        playerId,
        points[playerId] ?? null,
        draftPickNo,
        ranks,
        overrides,
      );
      players[playerId] = {
        managerId,
        managerName,
        teamFinish,
        champion: teamFinish === 1,
        performance,
        sharedRosterPlayerIds: rosterPlayerIds.filter((other) => other !== playerId),
      };
    }
  }

  return {
    season: LAST_SEASON,
    sourceLeagueId: league.league_id,
    generatedAt: (options.now ?? new Date()).toISOString(),
    players,
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * The classifier's input set is the union of every final-roster player and every
 * drafted player, so the positional pools reflect the whole draft rather than
 * only the players who survived to the end of the season.
 */
function seasonInputs(
  rosters: readonly SleeperRoster[],
  picks: readonly SleeperDraftPick[],
  points: Record<string, number>,
): PlayerSeasonInput[] {
  const positions = new Map<string, string | null>();
  const draftPickNos = new Map<string, number>();

  for (const pick of picks) {
    if (pick === null || typeof pick.player_id !== 'string') continue;
    positions.set(pick.player_id, pick.metadata?.position ?? null);
    if (typeof pick.pick_no === 'number' && Number.isFinite(pick.pick_no)) {
      const existing = draftPickNos.get(pick.player_id);
      // Keepers can appear twice; the earliest cost is the real expectation.
      if (existing === undefined || pick.pick_no < existing) {
        draftPickNos.set(pick.player_id, pick.pick_no);
      }
    }
  }

  const playerIds = new Set<string>(draftPickNos.keys());
  for (const roster of Array.isArray(rosters) ? rosters : []) {
    for (const playerId of roster?.players ?? []) playerIds.add(playerId);
  }

  return [...playerIds].sort().map((playerId) => ({
    playerId,
    position: positions.get(playerId) ?? null,
    totalPoints: points[playerId] ?? null,
    draftPickNo: draftPickNos.get(playerId) ?? null,
  }));
}

function pickNumberFor(picks: readonly SleeperDraftPick[], playerId: string): number | null {
  let best: number | null = null;
  for (const pick of picks) {
    if (pick?.player_id !== playerId) continue;
    if (typeof pick.pick_no !== 'number' || !Number.isFinite(pick.pick_no)) continue;
    if (best === null || pick.pick_no < best) best = pick.pick_no;
  }
  return best;
}

async function fetchDraftPicks(
  client: SleeperClient,
  league: SleeperLeague,
): Promise<SleeperDraftPick[]> {
  let draftId = league.draft_id ?? null;
  if (draftId === null || draftId === '') {
    const drafts = await safe(() => client.getLeagueDrafts(league.league_id), [], 'drafts');
    draftId = drafts[0]?.draft_id ?? null;
  }
  if (draftId === null || draftId === '') {
    log.warn(`no ${LAST_SEASON} draft for league ${league.league_id}; every player stays neutral`);
    return [];
  }
  const picks = await safe(() => client.getDraftPicks(draftId), [] as SleeperDraftPick[], 'draft picks');
  return Array.isArray(picks) ? picks : [];
}

/** Run a fetch, degrading to `fallback` on any failure. History is best-effort. */
async function safe<T>(fn: () => Promise<T>, fallback: T, what: string): Promise<T> {
  try {
    const value = await fn();
    return value ?? fallback;
  } catch (error) {
    log.warn(`could not load ${what}`, error);
    return fallback;
  }
}
