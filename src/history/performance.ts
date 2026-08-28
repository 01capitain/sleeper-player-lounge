/**
 * Deterministic 2025 performance classification.
 *
 * implementation_plan.md §8 is explicit: *"the importer must never invent
 * 'disappointing' purely from vibes"*. So this module never guesses. It compares
 * two rankings that both come straight off the Sleeper wire:
 *
 * - **actual finish** — each player's total 2025 points, summed from
 *   `/league/{id}/matchups/{week}`.`players_points`, which
 *   `docs/sleeper-facts.md` confirms is a `player_id -> points` map *in that
 *   league's own scoring*. No projections, no external rankings.
 * - **expected finish** — the player's position among his positional peers in
 *   that league's own 2025 draft, ordered by overall pick number. Draft cost is
 *   the league's own collective opinion of a player, which is exactly the
 *   expectation we want to measure a season against.
 *
 * Both rankings are computed over the *same* graded pool per position (players
 * who have both a draft cost and points data), so `expectedRank - actualRank` is
 * a like-for-like delta. Dividing by the pool size normalizes across positions:
 * finishing six spots below expectation means something very different for a
 * 20-deep QB pool than for an 80-deep WR pool.
 *
 * Anything the data cannot decide is `neutral`. That is the whole safety story.
 */
import { performanceOverridesFile as defaultOverridesFile } from '../paths.js';
import type { SleeperClient } from '../sleeper/client.js';
import type { PerformanceLabel, PerformanceOverrides } from '../types.js';
import { readJsonIfExists } from '../util/json.js';
import { log } from '../util/log.js';

// ---------------------------------------------------------------------------
// Tunable constants
// ---------------------------------------------------------------------------

/** Every label the classifier may produce, worst to best. */
export const PERFORMANCE_LABELS: readonly PerformanceLabel[] = [
  'disaster',
  'disappointing',
  'neutral',
  'good',
  'excellent',
];

/** First week of the fantasy regular season summed into a player's total. */
export const REGULAR_SEASON_FIRST_WEEK = 1;
/** Last week summed. 17 covers every common regular-season length. */
export const REGULAR_SEASON_LAST_WEEK = 17;

/**
 * Classification thresholds, expressed as `(expectedRank - actualRank) / poolSize`.
 * Positive means the player finished *better* than his draft cost implied.
 *
 * The bands are deliberately wide. A player has to beat or miss his expectation
 * by roughly a sixth of his positional draft pool before he is labelled at all,
 * which in a 14-team league is about 3 spots at QB and about 12 at WR. That is
 * the point at which a league actually talks about a pick, and it keeps ordinary
 * draft-day noise in `neutral` where it belongs.
 */
export const EXCELLENT_THRESHOLD = 0.35;
/** @see EXCELLENT_THRESHOLD */
export const GOOD_THRESHOLD = 0.15;
/** @see EXCELLENT_THRESHOLD */
export const DISAPPOINTING_THRESHOLD = -0.15;
/** @see EXCELLENT_THRESHOLD */
export const DISASTER_THRESHOLD = -0.35;

/**
 * Smallest graded pool that yields a label. Below this a rank delta is noise —
 * in a three-man pool one injury swings the normalized score by 0.33 — so tiny
 * positions (K, DEF, or a league with almost no draft data) stay `neutral`.
 */
export const MIN_POOL_SIZE = 6;

/** Bucket used for players whose position Sleeper did not report. */
export const UNKNOWN_POSITION = 'UNK';

// ---------------------------------------------------------------------------
// Season points
// ---------------------------------------------------------------------------

/** The inclusive week range summed by `collectSeasonPoints`. */
export function regularSeasonWeeks(
  first: number = REGULAR_SEASON_FIRST_WEEK,
  last: number = REGULAR_SEASON_LAST_WEEK,
): number[] {
  const weeks: number[] = [];
  for (let week = first; week <= last; week += 1) weeks.push(week);
  return weeks;
}

/**
 * Sum every player's points across a season, in the league's own scoring.
 *
 * Missing, empty or malformed weeks are skipped rather than fatal: a league that
 * ended in week 14, or a week Sleeper 404s, must not sink the whole import.
 * A player absent from the result simply has no points data — see `classify`,
 * which treats that as `neutral` and never as `disappointing`.
 */
export async function collectSeasonPoints(
  client: SleeperClient,
  leagueId: string,
  weeks: readonly number[] = regularSeasonWeeks(),
): Promise<Record<string, number>> {
  const totals: Record<string, number> = {};

  for (const week of weeks) {
    let matchups;
    try {
      matchups = await client.getMatchups(leagueId, week);
    } catch (error) {
      log.debug(`no matchups for league ${leagueId} week ${week}`, error);
      continue;
    }
    if (!Array.isArray(matchups) || matchups.length === 0) continue;

    for (const matchup of matchups) {
      const points = matchup?.players_points;
      if (points === null || points === undefined || typeof points !== 'object') continue;
      for (const [playerId, value] of Object.entries(points)) {
        if (typeof value !== 'number' || !Number.isFinite(value)) continue;
        totals[playerId] = (totals[playerId] ?? 0) + value;
      }
    }
  }

  // Round away float-accumulation noise so the written file diffs cleanly.
  for (const playerId of Object.keys(totals)) {
    totals[playerId] = Math.round((totals[playerId] ?? 0) * 100) / 100;
  }
  return totals;
}

// ---------------------------------------------------------------------------
// Positional ranking
// ---------------------------------------------------------------------------

/** One player's raw inputs to the classifier. */
export interface PlayerSeasonInput {
  playerId: string;
  /** Position from the league's own draft-pick metadata. Null when unknown. */
  position?: string | null;
  /** Total 2025 points in league scoring. Null means *no data*, not zero. */
  totalPoints?: number | null;
  /** Overall 2025 draft pick number — the draft cost. Null means undrafted. */
  draftPickNo?: number | null;
}

/** A player's place in both rankings, plus the pool both were computed over. */
export interface PositionRankEntry {
  playerId: string;
  position: string;
  totalPoints: number | null;
  draftPickNo: number | null;
  /** 1-based finish within the graded pool by points. Null when ungraded. */
  actualRank: number | null;
  /** 1-based finish within the graded pool by draft cost. Null when ungraded. */
  expectedRank: number | null;
  /** Size of the graded pool at this position. 0 when the player is ungraded. */
  poolSize: number;
}

/** Every player's ranks, keyed by Sleeper player id. */
export interface PositionRanks {
  byPlayer: Record<string, PositionRankEntry>;
  /** Graded pool size per position, for diagnostics. */
  poolSizeByPosition: Record<string, number>;
}

function normalizePosition(position: string | null | undefined): string {
  const trimmed = position?.trim().toUpperCase();
  return trimmed !== undefined && trimmed !== '' ? trimmed : UNKNOWN_POSITION;
}

function isGraded(input: PlayerSeasonInput): boolean {
  return (
    typeof input.draftPickNo === 'number' &&
    Number.isFinite(input.draftPickNo) &&
    typeof input.totalPoints === 'number' &&
    Number.isFinite(input.totalPoints)
  );
}

/**
 * Rank every player within his own position, twice: by points scored and by
 * draft cost, over the identical graded pool. Ties break on player id so the
 * output is byte-stable across runs.
 */
export function buildPositionRanks(inputs: readonly PlayerSeasonInput[]): PositionRanks {
  const byPosition = new Map<string, PlayerSeasonInput[]>();
  const byPlayer: Record<string, PositionRankEntry> = {};
  const poolSizeByPosition: Record<string, number> = {};

  for (const input of inputs) {
    const position = normalizePosition(input.position);
    byPlayer[input.playerId] = {
      playerId: input.playerId,
      position,
      totalPoints: input.totalPoints ?? null,
      draftPickNo: input.draftPickNo ?? null,
      actualRank: null,
      expectedRank: null,
      poolSize: 0,
    };
    if (!isGraded(input)) continue;
    const bucket = byPosition.get(position);
    if (bucket === undefined) byPosition.set(position, [input]);
    else bucket.push(input);
  }

  for (const [position, pool] of byPosition) {
    const poolSize = pool.length;
    poolSizeByPosition[position] = poolSize;

    const byPoints = [...pool].sort(
      (a, b) => (b.totalPoints ?? 0) - (a.totalPoints ?? 0) || a.playerId.localeCompare(b.playerId),
    );
    const byCost = [...pool].sort(
      (a, b) =>
        (a.draftPickNo ?? 0) - (b.draftPickNo ?? 0) || a.playerId.localeCompare(b.playerId),
    );

    byPoints.forEach((input, index) => {
      const entry = byPlayer[input.playerId];
      if (entry !== undefined) {
        entry.actualRank = index + 1;
        entry.poolSize = poolSize;
      }
    });
    byCost.forEach((input, index) => {
      const entry = byPlayer[input.playerId];
      if (entry !== undefined) entry.expectedRank = index + 1;
    });
  }

  return { byPlayer, poolSizeByPosition };
}

/**
 * Normalized outperformance, positive when the player beat his draft cost.
 * Null when the player is not in a usable graded pool.
 */
export function performanceScore(entry: PositionRankEntry | undefined): number | null {
  if (entry === undefined) return null;
  if (entry.actualRank === null || entry.expectedRank === null) return null;
  if (entry.poolSize < MIN_POOL_SIZE) return null;
  return (entry.expectedRank - entry.actualRank) / entry.poolSize;
}

/** Bucket a normalized score into a label. Exported so thresholds stay testable. */
export function labelForScore(score: number): PerformanceLabel {
  if (score >= EXCELLENT_THRESHOLD) return 'excellent';
  if (score >= GOOD_THRESHOLD) return 'good';
  if (score <= DISASTER_THRESHOLD) return 'disaster';
  if (score <= DISAPPOINTING_THRESHOLD) return 'disappointing';
  return 'neutral';
}

// ---------------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------------

function isPerformanceLabel(value: unknown): value is PerformanceLabel {
  return typeof value === 'string' && (PERFORMANCE_LABELS as readonly string[]).includes(value);
}

/**
 * Read `data/fantasy-history/performance-overrides.json`.
 * A missing file is the normal case and yields `{}`; unknown labels are dropped
 * with a warning rather than silently trusted.
 */
export async function loadPerformanceOverrides(
  filePath: string = defaultOverridesFile,
): Promise<PerformanceOverrides> {
  const raw = await readJsonIfExists<unknown>(filePath);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};

  const overrides: PerformanceOverrides = {};
  for (const [playerId, label] of Object.entries(raw as Record<string, unknown>)) {
    if (isPerformanceLabel(label)) overrides[playerId] = label;
    else log.warn(`ignoring invalid performance override for ${playerId}:`, label);
  }
  return overrides;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Classify one player's 2025 season.
 *
 * Order of precedence:
 * 1. a manual override always wins;
 * 2. **no draft cost or no points data means `neutral`** — never `disappointing`,
 *    because absence of evidence is not evidence of a bad season;
 * 3. otherwise, bucket the normalized positional rank delta.
 *
 * @param draftSlot the player's overall 2025 draft pick number (his draft cost)
 */
export function classify(
  playerId: string,
  totalPoints: number | null | undefined,
  draftSlot: number | null | undefined,
  positionRanks: PositionRanks,
  overrides: PerformanceOverrides = {},
): PerformanceLabel {
  const override = overrides[playerId];
  if (isPerformanceLabel(override)) return override;

  if (typeof draftSlot !== 'number' || !Number.isFinite(draftSlot)) return 'neutral';
  if (typeof totalPoints !== 'number' || !Number.isFinite(totalPoints)) return 'neutral';

  const score = performanceScore(positionRanks.byPlayer[playerId]);
  if (score === null) return 'neutral';
  return labelForScore(score);
}
