/**
 * Championship Membership importer.
 *
 * Championship Membership is the *one* deliberate exception to the memory cutoff
 * (CONTEXT.md, implementation_plan.md §4): ordinary roster history stops at 2025,
 * but being on a season's winning roster is remembered from **every** season the
 * league chain reaches. So this module walks the entire chain, pre-2025 included,
 * while `last-season.ts` looks at 2025 and nothing else.
 *
 * ## Bracket parsing
 *
 * `docs/sleeper-facts.md` flags `/league/{id}/winners_bracket` as a trap. Each
 * match object has `m` (match id), `r` (**round number**), `t1`/`t2` (the two
 * entrants), `w` (winning **roster_id**), `l` (losing roster_id) and an optional
 * `p` (the placement this match decides). The championship is the match with
 * `p === 1`, and its champion is `w`. `r` is *not* a result — the recorded real
 * hotelkit 2025 championship match `{"p":1,"m":6,"r":3,"l":2,"w":1,...}` is round
 * 3 and was won by roster 1.
 */
import type { SleeperClient } from '../sleeper/client.js';
import type { SleeperBracketMatch, SleeperLeague, SleeperRoster, SleeperUser } from '../sleeper/types.js';
import type { ChampionsFile, ChampionshipEntry } from '../types.js';
import { log } from '../util/log.js';
import { MAX_CHAIN_LENGTH, seasonOf, walkLeagueChain } from './chain.js';

/** The placement value that identifies the championship match. */
export const CHAMPIONSHIP_PLACEMENT = 1;

// ---------------------------------------------------------------------------
// Manager identity
// ---------------------------------------------------------------------------

/**
 * Sleeper `user_id` -> display name for one league.
 *
 * `docs/sleeper-facts.md`: `/league/{id}/users` returned **15 users for 10
 * rosters** in hotelkit 2025, so the user list is not 1:1 with rosters and must
 * be joined through `roster.owner_id`. `metadata.team_name` is frequently absent,
 * so the fallback chain is team name -> display name -> username -> the raw id.
 */
export function managerNameIndex(
  users: readonly SleeperUser[] | null | undefined,
  current: Record<string, string> = {},
): Record<string, string> {
  const index: Record<string, string> = {};
  if (Array.isArray(users)) {
    for (const user of users) {
      if (user === null || typeof user.user_id !== 'string') continue;
      const teamName = user.metadata?.['team_name'];
      index[user.user_id] =
        nonEmpty(teamName) ?? nonEmpty(user.display_name) ?? nonEmpty(user.username) ?? user.user_id;
    }
  }
  return applyCurrentNames(index, current);
}

/**
 * Overlay the names those same managers use *today* onto one season's index.
 *
 * Sleeper scopes `metadata.team_name` per league, so a manager who renames his
 * team mid-draft leaves every prior season holding the old name — verified: the
 * 2026 hotelkit league returns 'Gibbs Doch Gar Nicht' for the user whose 2025
 * league still returns 'Ja’Marr-io Kart Chase'. The Lounge is a live
 * draft-night chat and names people the way Sleeper names them right now, so a
 * memory that calls the same manager something else reads as a different
 * person.
 *
 * Only names win, never ids: a current entry that fell all the way back to the
 * raw `user_id` carries no name, so the season's own name is the better one.
 * Managers who have since left the league appear in no current index and keep
 * the name they had, which is the right answer for them.
 */
export function applyCurrentNames(
  index: Record<string, string>,
  current: Record<string, string>,
): Record<string, string> {
  for (const [userId, name] of Object.entries(current)) {
    if (name === userId) continue;
    index[userId] = name;
  }
  return index;
}

/** The names a league's managers go by now, for `managerNameIndex`'s overlay. */
export async function currentManagerNames(
  client: SleeperClient,
  leagueId: string,
): Promise<Record<string, string>> {
  try {
    return managerNameIndex(await client.getLeagueUsers(leagueId, { ttlMs: 0 }));
  } catch (error) {
    log.warn(`could not read current manager names for league ${leagueId}`, error);
    return {};
  }
}

/**
 * The Manager who owns a roster, resolved by Sleeper `user_id`.
 *
 * Roster counts change between seasons (hotelkit: 8 / 10 / 14 across
 * 2026 / 2025 / 2024), so `roster_id` and draft slot are meaningless across
 * seasons and only `owner_id` carries identity forward. Co-owned or orphaned
 * rosters fall back to a stable synthetic id so the record stays well-formed.
 */
export function managerIdentity(
  roster: SleeperRoster,
  names: Record<string, string>,
): { managerId: string; managerName: string } {
  const ownerId = nonEmpty(roster.owner_id) ?? nonEmpty(roster.co_owners?.[0]);
  if (ownerId === undefined) {
    return {
      managerId: `unowned:${roster.league_id}:${roster.roster_id}`,
      managerName: `Roster ${roster.roster_id}`,
    };
  }
  return { managerId: ownerId, managerName: names[ownerId] ?? ownerId };
}

function nonEmpty(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

// ---------------------------------------------------------------------------
// Bracket parsing
// ---------------------------------------------------------------------------

/**
 * The champion's `roster_id`, or null when the bracket has not resolved yet.
 *
 * Reads `w` from the match whose `p` is 1. Never reads `r`, which is the round.
 */
export function findChampionRosterId(
  bracket: readonly SleeperBracketMatch[] | null | undefined,
): number | null {
  if (!Array.isArray(bracket)) return null;
  for (const match of bracket) {
    if (match === null || typeof match !== 'object') continue;
    if (match.p !== CHAMPIONSHIP_PLACEMENT) continue;
    if (typeof match.w === 'number' && Number.isFinite(match.w)) return match.w;
    // The championship exists but has not been played out yet.
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export interface ImportChampionsOptions {
  /** How far back to follow `previous_league_id`. */
  maxSeasons?: number;
  /**
   * The names managers go by today, overlaid onto every season. Defaults to the
   * users of `leagueId` — the head of the chain, i.e. the season being drafted.
   * Pass `{}` to keep each season's own names.
   */
  currentNames?: Record<string, string>;
  /** Injectable clock so tests get a stable `generatedAt`. */
  now?: Date;
}

/**
 * Walk the whole league chain and record the winning roster of every season that
 * has one. Seasons still in progress (no `p:1` winner yet) are skipped silently —
 * Defensive Bros' 2026 season is exactly that case.
 */
export async function importChampions(
  client: SleeperClient,
  leagueId: string,
  options: ImportChampionsOptions = {},
): Promise<ChampionsFile> {
  const chain = await walkLeagueChain(client, leagueId, options.maxSeasons ?? MAX_CHAIN_LENGTH);
  const current = options.currentNames ?? (await currentManagerNames(client, leagueId));
  const championshipRosters: ChampionsFile['championshipRosters'] = {};

  for (const league of chain) {
    const entry = await championshipFor(client, league, current);
    if (entry === null) continue;
    const key = String(entry.season);
    // Newest wins: the chain is walked newest-first, so never overwrite.
    if (championshipRosters[key] !== undefined) continue;
    championshipRosters[key] = entry;
  }

  return {
    generatedAt: (options.now ?? new Date()).toISOString(),
    championshipRosters,
  };
}

async function championshipFor(
  client: SleeperClient,
  league: SleeperLeague,
  current: Record<string, string>,
): Promise<ChampionsFile['championshipRosters'][string] | null> {
  const season = seasonOf(league);
  if (!Number.isFinite(season)) {
    log.warn('skipping league with unparseable season', league.league_id);
    return null;
  }

  let bracket: SleeperBracketMatch[];
  try {
    bracket = await client.getWinnersBracket(league.league_id);
  } catch (error) {
    log.debug(`no winners bracket for league ${league.league_id}`, error);
    return null;
  }

  const championRosterId = findChampionRosterId(bracket);
  if (championRosterId === null) {
    log.info(`no champion yet for ${league.name} ${season}`);
    return null;
  }

  let rosters: SleeperRoster[];
  let users: SleeperUser[];
  try {
    [rosters, users] = await Promise.all([
      client.getLeagueRosters(league.league_id),
      client.getLeagueUsers(league.league_id),
    ]);
  } catch (error) {
    log.warn(`could not load rosters/users for league ${league.league_id}`, error);
    return null;
  }

  const roster = (Array.isArray(rosters) ? rosters : []).find(
    (candidate) => candidate?.roster_id === championRosterId,
  );
  if (roster === undefined) {
    log.warn(`champion roster ${championRosterId} missing from league ${league.league_id}`);
    return null;
  }

  const { managerId, managerName } = managerIdentity(roster, managerNameIndex(users, current));
  const playerIds = [...new Set(roster.players ?? [])].sort();

  return { season, leagueId: league.league_id, managerId, managerName, playerIds };
}

// ---------------------------------------------------------------------------
// Reverse lookup
// ---------------------------------------------------------------------------

/**
 * Reverse `player_id -> championships` index (implementation_plan.md §8 step 3).
 *
 * Each entry carries `sharedChampionPlayerIds`: the player's *other* teammates on
 * that winning roster, which is what lets two Speakers recognize a shared title.
 * Newest season first.
 */
export function buildChampionshipIndex(
  file: ChampionsFile | null | undefined,
): Record<string, ChampionshipEntry[]> {
  const index: Record<string, ChampionshipEntry[]> = {};
  const rosters = file?.championshipRosters;
  if (rosters === null || rosters === undefined) return index;

  for (const roster of Object.values(rosters)) {
    if (roster === null || roster === undefined) continue;
    const playerIds = Array.isArray(roster.playerIds) ? roster.playerIds : [];
    for (const playerId of playerIds) {
      const entry: ChampionshipEntry = {
        season: roster.season,
        managerId: roster.managerId,
        managerName: roster.managerName,
        sharedChampionPlayerIds: playerIds.filter((other) => other !== playerId),
      };
      const bucket = index[playerId];
      if (bucket === undefined) index[playerId] = [entry];
      else bucket.push(entry);
    }
  }

  for (const entries of Object.values(index)) entries.sort((a, b) => b.season - a.season);
  return index;
}
