/**
 * ADP — average draft position, read from a precomputed artifact.
 *
 * ADP is deliberately NOT resolved at runtime. `scripts/build-adp.mjs` fetches
 * Sleeper's projections route once and writes `data/players/adp.json`, which is
 * committed; the app only ever reads it. That keeps draft reactions reproducible
 * (the same pick always sees the same ADP) and keeps a live HTTP dependency out
 * of the hot path during a draft.
 *
 * Sleeper parks undrafted players at TWO sentinels: 1000, and an undocumented
 * 999 used by 11 players. The builder drops anything at or above 900 — well
 * past any real draft, since the actual board tops out around 456 — so a player
 * absent from the artifact is genuinely UNRANKED, never a huge number that
 * would read as a 900-pick fall.
 *
 * The values are an ordinal consensus board (contiguous integers 1..N), not
 * true averages, so "30 picks early" means 30 board positions.
 */
import { readJsonIfExists } from '../util/json.js';
import { adpFile } from '../paths.js';
import type { SleeperPlayer } from '../types.js';

export interface AdpArtifact {
  source: string;
  season: number;
  week: number;
  /** The projections stat the artifact was built from, e.g. `adp_dd_half_ppr`. */
  field: string;
  unrankedSentinel: number;
  generatedAt: string;
  rankedCount: number;
  /** playerId -> average draft position. Unranked players are absent. */
  adp: Record<string, number>;
}

let cached: AdpArtifact | null | undefined;

/** Read the artifact. Returns null when it has not been built yet. */
export async function loadAdp(): Promise<AdpArtifact | null> {
  if (cached !== undefined) return cached;
  cached = await readJsonIfExists<AdpArtifact>(adpFile);
  return cached;
}

/** Test seam — drop the memoized artifact. */
export function clearAdpCache(): void {
  cached = undefined;
}

/**
 * ADP for one player, or null when he is unranked or the artifact is missing.
 * Never falls back to `search_rank`: that is a talent ordering, not a draft
 * position, and conflating the two is what put Josh Allen near pick 4.
 */
export function adpFor(playerId: string, artifact: AdpArtifact | null): number | null {
  if (!artifact) return null;
  const value = artifact.adp[playerId];
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  if (value >= artifact.unrankedSentinel) return null;
  return value;
}

/**
 * Merge ADP into a players dataset, so downstream code sees one enriched record
 * per player instead of having to join two sources.
 */
export function enrichWithAdp(
  players: Record<string, SleeperPlayer>,
  artifact: AdpArtifact | null,
): Record<string, SleeperPlayer> {
  if (!artifact) return players;
  for (const [playerId, player] of Object.entries(players)) {
    const value = adpFor(playerId, artifact);
    if (value !== null) player.adp = value;
  }
  return players;
}
