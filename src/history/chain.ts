/**
 * League-chain walking.
 *
 * Sleeper models league history as a singly linked list: every league object
 * carries `previous_league_id` pointing at the same league's previous season.
 * Walking that list backwards is the only way to reach older seasons, and it is
 * the sole entry point the Fantasy Memory importers use — see ADR 0002, which
 * makes the importer league-agnostic so both `hotelkit Fantasies` (three seasons
 * deep) and `Defensive Bros` (one season deep) work unchanged.
 *
 * `docs/sleeper-facts.md` records that Defensive Bros' 2025 league has
 * `previous_league_id: null`, so **a chain of length 1 is normal** and must never
 * be treated as an error.
 */
import { SleeperNotFoundError } from '../sleeper/client.js';
import type { SleeperClient } from '../sleeper/client.js';
import type { SleeperLeague } from '../sleeper/types.js';
import { log } from '../util/log.js';

/**
 * Hard stop on how far back the walker will follow `previous_league_id`.
 * Sleeper has existed since 2017, so anything past this is a data problem.
 */
export const MAX_CHAIN_LENGTH = 20;

/**
 * Sleeper reports "no predecessor" inconsistently: `null`, an absent key, an
 * empty string and the literal string `"0"` all occur in the wild.
 */
export function normalizePreviousLeagueId(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === '0' || trimmed === 'null') return null;
  return trimmed;
}

/**
 * Follow `previous_league_id` backwards from `leagueId`, newest season first.
 *
 * Stops on a null predecessor, on `maxSeasons` leagues, or on a cycle (guarded
 * by a seen-set — a self-referencing league would otherwise loop forever).
 * A failure fetching the *head* league propagates; a failure fetching an older
 * predecessor only truncates the chain, because partial history is still useful.
 */
export async function walkLeagueChain(
  client: SleeperClient,
  leagueId: string,
  maxSeasons: number = MAX_CHAIN_LENGTH,
): Promise<SleeperLeague[]> {
  const chain: SleeperLeague[] = [];
  const seen = new Set<string>();
  let cursor: string | null = normalizePreviousLeagueId(leagueId);

  while (cursor !== null && chain.length < maxSeasons) {
    if (seen.has(cursor)) {
      log.warn('league chain cycle detected, stopping at', cursor);
      break;
    }
    seen.add(cursor);

    let league: SleeperLeague | null;
    try {
      league = await client.getLeague(cursor);
    } catch (error) {
      if (chain.length === 0) throw error;
      const why = error instanceof SleeperNotFoundError ? 'not found' : 'fetch failed';
      log.warn(`league chain truncated: predecessor ${cursor} ${why}`);
      break;
    }

    if (league === null || typeof league.league_id !== 'string') {
      log.warn('league chain truncated: empty league response for', cursor);
      break;
    }

    chain.push(league);
    cursor = normalizePreviousLeagueId(league.previous_league_id);
  }

  return chain;
}

/** The league in a chain for one season, or null. Seasons are strings on the wire. */
export function findLeagueForSeason(
  chain: readonly SleeperLeague[],
  season: number,
): SleeperLeague | null {
  return chain.find((league) => seasonOf(league) === season) ?? null;
}

/** A league's season as a number. Returns `NaN` when Sleeper sends something odd. */
export function seasonOf(league: SleeperLeague): number {
  return Number.parseInt(String(league.season), 10);
}
