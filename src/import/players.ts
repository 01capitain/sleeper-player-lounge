/**
 * Current NFL player metadata — implementation_plan.md §7.
 *
 * Sleeper's `/players/nfl` dataset (~5MB) is the single source for display name,
 * position, NFL team and teammate selection. The client already handles caching
 * it to `data/cache/sleeper-players.json` with a 24h TTL; this module is the
 * thin domain-facing layer everything else reads through, so no other file has
 * to know the dataset's wire quirks.
 */
import type { SleeperClient } from '../sleeper/client.js';
import type { NflTeammate, SleeperPlayer } from '../types.js';
import { log } from '../util/log.js';
import { enrichWithAdp, loadAdp } from './adp.js';

/** A players dataset keyed by Sleeper player id. */
export type PlayerIndex = Record<string, SleeperPlayer>;

/**
 * The domain reference to a player. `NflTeammate` is the shape the Context
 * carries (`src/types.ts`), so the selection helpers below hand back domain
 * references rather than raw dataset rows — callers that need the extra dataset
 * fields still have the index and can look the id back up.
 */
export type PlayerRef = NflTeammate;

/** Project a dataset row onto the domain player reference. */
export function toPlayerRef(player: SleeperPlayer): PlayerRef {
  return {
    playerId: player.player_id,
    name: displayName(player),
    position: player.position ?? null,
    nflTeam: player.team ?? null,
  };
}

export interface EnsurePlayerCacheOptions {
  /** `0` forces a fresh download. Defaults to the client's 24h TTL. */
  ttlMs?: number;
}

/**
 * Load the players dataset, downloading it only when the local cache is stale.
 * Returns the dataset keyed by Sleeper player id.
 */
export async function ensurePlayerCache(
  client: SleeperClient,
  opts: EnsurePlayerCacheOptions = {},
): Promise<PlayerIndex> {
  const players = await client.getAllPlayers(opts);

  // ADP is a precomputed artifact (`data/players/adp.json`, built by
  // scripts/build-adp.mjs). Merge it in here so every consumer sees one
  // enriched player record rather than joining two sources. A missing artifact
  // is not an error — draft-surprise signals simply go silent.
  const artifact = await loadAdp();
  if (artifact) {
    enrichWithAdp(players, artifact);
    log.debug('adp merged', `${artifact.rankedCount} ranked · ${artifact.field} · ${artifact.season}`);
  } else {
    log.debug('adp artifact absent', 'run `node scripts/build-adp.mjs` to enable reach/fall signals');
  }

  log.debug('players dataset ready', `${Object.keys(players).length} entries`);
  return players;
}

/**
 * The name to show for a player: `full_name` when Sleeper provides it, otherwise
 * first + last, otherwise the bare player id so the renderer never prints
 * `undefined`.
 */
export function displayName(player: SleeperPlayer | null | undefined): string {
  if (!player) return '';
  const full = player.full_name?.trim();
  if (full) return full;
  const parts = [player.first_name, player.last_name]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));
  if (parts.length > 0) return parts.join(' ');
  return player.player_id ?? '';
}

/** True for a player who is currently rostered somewhere and not flagged inactive. */
function isCastable(player: SleeperPlayer | undefined): player is SleeperPlayer {
  if (!player) return false;
  // Free agents carry `team: null`. They are excluded deliberately: a Speaker
  // with no team cannot be anyone's current NFL teammate or on-field rival.
  if (player.team === null || player.team === undefined || player.team === '') return false;
  if (player.active === false) return false;
  return true;
}

/** Better-known players first. Sleeper's `search_rank` is ascending; null sorts last. */
function byProminence(a: SleeperPlayer, b: SleeperPlayer): number {
  const rankA = typeof a.search_rank === 'number' ? a.search_rank : Number.MAX_SAFE_INTEGER;
  const rankB = typeof b.search_rank === 'number' ? b.search_rank : Number.MAX_SAFE_INTEGER;
  if (rankA !== rankB) return rankA - rankB;
  return displayName(a).localeCompare(displayName(b));
}

/**
 * Current NFL teammates of `playerId`: same `team`, excluding the player
 * himself, players Sleeper flags inactive, and anyone with `team === null`
 * (free agents). Ordered by prominence so callers can take the first few.
 *
 * Returns `[]` when the player is unknown or has no team.
 */
export function teammatesOf(
  playerId: string,
  players: PlayerIndex,
  limit?: number,
): PlayerRef[] {
  const self = players[playerId];
  if (!isCastable(self)) return [];
  const team = self.team;

  const out: SleeperPlayer[] = [];
  for (const [id, player] of Object.entries(players)) {
    if (id === playerId) continue;
    if (!isCastable(player)) continue;
    if (player.team !== team) continue;
    out.push(player);
  }
  out.sort(byProminence);
  const selected = typeof limit === 'number' ? out.slice(0, Math.max(0, limit)) : out;
  return selected.map(toPlayerRef);
}

/** Positions a player can be cast at: his primary position plus fantasy positions. */
function positionsOf(player: SleeperPlayer): Set<string> {
  const positions = new Set<string>();
  if (player.position) positions.add(player.position);
  for (const position of player.fantasy_positions ?? []) {
    if (position) positions.add(position);
  }
  return positions;
}

/**
 * Other active players at the same position, most prominent first — the pool the
 * context builder draws `position_rival` Speakers from. Excludes the player
 * himself, inactive players and free agents (`team === null`), same as
 * `teammatesOf`.
 */
export function positionRivals(
  playerId: string,
  players: PlayerIndex,
  limit = 5,
): PlayerRef[] {
  const self = players[playerId];
  if (!self) return [];
  const positions = positionsOf(self);
  if (positions.size === 0) return [];

  const out: SleeperPlayer[] = [];
  for (const [id, player] of Object.entries(players)) {
    if (id === playerId) continue;
    if (!isCastable(player)) continue;
    const shares = [...positionsOf(player)].some((position) => positions.has(position));
    if (!shares) continue;
    out.push(player);
  }
  out.sort(byProminence);
  return out.slice(0, Math.max(0, limit)).map(toPlayerRef);
}
