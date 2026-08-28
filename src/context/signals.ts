/**
 * Draft signals — the cheap, deterministic observations the Director may riff on
 * (implementation_plan.md §9: "basic draft signals such as position run / stack /
 * obvious fall when available").
 *
 * Every field is optional and every field is *omitted* when the signal is not
 * genuinely present. A guessed signal becomes a fabricated joke, so silence is
 * always the correct answer when the data does not support a claim.
 */
import type { DraftSignals, Pick, SleeperPlayer } from '../types.js';

/** Tuning for the three detectors. Defaults match the demo scenarios in §15. */
export interface DraftSignalOptions {
  /** M — how many recent Picks form the window. Default 5. */
  positionRunWindow?: number;
  /** N — how many of those must share the position. Default 3. */
  positionRunThreshold?: number;
  /**
   * How far from his `search_rank` a Pick must land before it is worth
   * remarking on, expressed in ROUNDS rather than picks.
   *
   * A flat pick count means different things in different leagues: 12 picks is
   * a round and a half in an 8-team league but under a full round in a
   * 14-team one. Expressing the threshold in rounds keeps "he fell" meaning
   * the same thing to everyone at the table. Default 1.25 rounds.
   */
  surpriseRounds?: number;
  /**
   * Teams in the league, used to convert `surpriseRounds` into picks.
   * hotelkit Fantasies is an 8-team league; the simulation draft is 14.
   */
  teams?: number;
}

export const DEFAULT_SIGNAL_OPTIONS: Required<DraftSignalOptions> = {
  positionRunWindow: 5,
  positionRunThreshold: 3,
  surpriseRounds: 1.25,
  teams: 12,
};

/** Picks of slack allowed before a Pick counts as a fall or a reach. */
export function surpriseThreshold(opts: Required<DraftSignalOptions>): number {
  const teams = Number.isFinite(opts.teams) && opts.teams > 0 ? opts.teams : 12;
  return Math.max(3, Math.round(teams * opts.surpriseRounds));
}

/** A richer read on the same Pick, for callers that want the detail. */
export interface DraftSignalDetail extends DraftSignals {
  /** How many of the windowed Picks shared the run's position. */
  positionRunCount?: number;
  /** The window size the run was measured over. */
  positionRunWindow?: number;
  /** Names already on this Manager's roster that share the drafted player's NFL team. */
  stackWith?: string[];
  /** The `search_rank` the fall or reach was measured against. */
  expectedRank?: number;
  /** Picks of slack that were required before calling it. */
  surpriseThreshold?: number;
}

/**
 * Detect a position run, a stack and an obvious fall for one Pick.
 *
 * `priorPicks` are the Picks made before this one; order does not matter, they
 * are sorted by `pickNo` here. `players` is the cached Sleeper `/players/nfl`
 * dataset, used only for `search_rank` and for filling in a missing position.
 */
export function computeDraftSignals(
  pick: Pick,
  priorPicks: readonly Pick[] = [],
  players: Record<string, SleeperPlayer> = {},
  options: DraftSignalOptions = {},
): DraftSignals {
  const detail = computeDraftSignalDetail(pick, priorPicks, players, options);
  const signals: DraftSignals = {};
  if (detail.positionRun !== undefined) signals.positionRun = detail.positionRun;
  if (detail.isStack !== undefined) signals.isStack = detail.isStack;
  if (detail.fellBelowRank !== undefined) signals.fellBelowRank = detail.fellBelowRank;
  if (detail.reachedAboveRank !== undefined) signals.reachedAboveRank = detail.reachedAboveRank;
  return signals;
}

/** As `computeDraftSignals`, but keeps the supporting detail for the prompt. */
export function computeDraftSignalDetail(
  pick: Pick,
  priorPicks: readonly Pick[] = [],
  players: Record<string, SleeperPlayer> = {},
  options: DraftSignalOptions = {},
): DraftSignalDetail {
  const opts = { ...DEFAULT_SIGNAL_OPTIONS, ...options };
  const before = [...priorPicks]
    .filter((prior) => prior.pickNo < pick.pickNo && prior.draftId === pick.draftId)
    .sort((a, b) => a.pickNo - b.pickNo);

  const detail: DraftSignalDetail = {};

  const run = detectPositionRun(pick, before, players, opts);
  if (run) {
    detail.positionRun = run.position;
    detail.positionRunCount = run.count;
    detail.positionRunWindow = run.window;
  }

  const stack = detectStack(pick, before);
  if (stack.length > 0) {
    detail.isStack = true;
    detail.stackWith = stack;
  }

  const surprise = detectSurprise(pick, players, opts);
  if (surprise) {
    if (surprise.fellBelowRank !== undefined) detail.fellBelowRank = surprise.fellBelowRank;
    if (surprise.reachedAboveRank !== undefined) detail.reachedAboveRank = surprise.reachedAboveRank;
    detail.expectedRank = surprise.expectedRank;
    detail.surpriseThreshold = surprise.threshold;
  }

  return detail;
}

// ---------------------------------------------------------------------------
// detectors
// ---------------------------------------------------------------------------

interface PositionRun {
  position: string;
  count: number;
  window: number;
}

/**
 * A run exists when at least N of the last M Picks (this one included) share the
 * drafted player's position. Only the drafted player's own position can be
 * reported — `DraftSignals.positionRun` describes *this* Pick's context.
 */
function detectPositionRun(
  pick: Pick,
  before: readonly Pick[],
  players: Record<string, SleeperPlayer>,
  opts: Required<DraftSignalOptions>,
): PositionRun | null {
  const position = positionOf(pick, players);
  if (!position) return null;
  const windowPicks = [...before.slice(-(opts.positionRunWindow - 1)), pick];
  if (windowPicks.length < opts.positionRunThreshold) return null;
  let count = 0;
  for (const entry of windowPicks) {
    if (positionOf(entry, players) === position) count += 1;
  }
  if (count < opts.positionRunThreshold) return null;
  return { position, count, window: windowPicks.length };
}

/**
 * A stack exists when the drafted player shares an NFL team with someone the
 * same Manager has already drafted.
 */
function detectStack(pick: Pick, before: readonly Pick[]): string[] {
  const team = normalizeTeam(pick.nflTeam);
  if (!team) return [];
  return before
    .filter(
      (prior) =>
        prior.managerId === pick.managerId &&
        prior.playerId !== pick.playerId &&
        normalizeTeam(prior.nflTeam) === team,
    )
    .map((prior) => prior.playerName);
}

interface Surprise {
  fellBelowRank?: number;
  reachedAboveRank?: number;
  expectedRank: number;
  threshold: number;
}

/**
 * Compare where a player actually went against Sleeper's `search_rank`, which is
 * the closest thing the public API exposes to an average draft position.
 *
 * The comparison is symmetric: going far LATER than his rank is a fall, going
 * far EARLIER is a reach. Both are things a group chat notices, and a reach is
 * usually the funnier of the two because somebody has to defend it.
 *
 * `search_rank` reflects the CURRENT season only. That is exactly what a draft
 * signal wants, and it is why this is never used to grade past seasons: a player
 * who busted last year carries a depressed rank this year, so scoring history
 * against it would quietly cancel the very disappointment worth talking about.
 *
 * No `search_rank`, no claim.
 */
function detectSurprise(
  pick: Pick,
  players: Record<string, SleeperPlayer>,
  opts: Required<DraftSignalOptions>,
): Surprise | null {
  const rank = players[pick.playerId]?.search_rank;
  if (typeof rank !== 'number' || !Number.isFinite(rank) || rank <= 0) return null;
  // Sleeper parks unranked players at absurd sentinel ranks; those are not falls.
  if (rank > 10000) return null;

  const threshold = surpriseThreshold(opts);
  const delta = pick.pickNo - rank;

  if (delta >= threshold) return { fellBelowRank: delta, expectedRank: rank, threshold };
  if (-delta >= threshold) return { reachedAboveRank: -delta, expectedRank: rank, threshold };
  return null;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function positionOf(pick: Pick, players: Record<string, SleeperPlayer>): string | null {
  const fromPick = pick.position?.trim();
  if (fromPick) return fromPick.toUpperCase();
  const fromDataset = players[pick.playerId]?.position?.trim();
  return fromDataset ? fromDataset.toUpperCase() : null;
}

function normalizeTeam(team: string | null | undefined): string | null {
  const trimmed = team?.trim();
  return trimmed ? trimmed.toUpperCase() : null;
}
