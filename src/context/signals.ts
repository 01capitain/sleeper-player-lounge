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
   * Hard cap on how many picks early still counts as ordinary. Default 24.
   */
  reachCapPicks?: number;
  /**
   * The other half of the reach rule: a fraction of the player's own ADP.
   * The effective threshold is the LOWER of this and `reachCapPicks`, so early
   * picks are reached more easily — taking the consensus 6th player 4 picks
   * early is a statement, while taking the 200th player 4 picks early is noise.
   * Default 0.5.
   */
  reachFraction?: number;
  /**
   * How many picks past his ADP a player must slide before he is disappointed.
   * Players expect to go around their ADP; a fixed 8-pick line means the same
   * thing everywhere on the board. Default 8.
   */
  disappointmentPicks?: number;
}

export const DEFAULT_SIGNAL_OPTIONS: Required<DraftSignalOptions> = {
  positionRunWindow: 5,
  positionRunThreshold: 3,
  reachCapPicks: 24,
  reachFraction: 0.5,
  disappointmentPicks: 8,
};

/**
 * How many picks early a player must go before it reads as a reach.
 *
 * `min(reachCapPicks, adp * reachFraction)` — the fraction dominates at the top
 * of the board and the cap takes over deeper down. Taking the consensus 6th
 * player 4 picks early is a statement; taking the 200th player 4 picks early is
 * nothing at all.
 */
export function reachThreshold(adp: number, opts: Required<DraftSignalOptions>): number {
  return Math.min(opts.reachCapPicks, adp * opts.reachFraction);
}

/** A richer read on the same Pick, for callers that want the detail. */
export interface DraftSignalDetail extends DraftSignals {
  /** How many of the windowed Picks shared the run's position. */
  positionRunCount?: number;
  /** The window size the run was measured over. */
  positionRunWindow?: number;
  /** Names already on this Manager's roster that share the drafted player's NFL team. */
  stackWith?: string[];
  /** The ADP the fall or reach was measured against. */
  expectedRank?: number;
  /** Picks of slack that were required before calling it. */
  surpriseThreshold?: number;
  /** True when the player slid past his ADP far enough to be disappointed. */
  disappointed?: boolean;
}

/**
 * Detect a position run, a stack and an obvious fall for one Pick.
 *
 * `priorPicks` are the Picks made before this one; order does not matter, they
 * are sorted by `pickNo` here. `players` is the cached Sleeper `/players/nfl`
 * dataset enriched with ADP, used only for `adp` and for filling in a missing position.
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
    if (surprise.fellBelowRank !== undefined) {
      detail.fellBelowRank = surprise.fellBelowRank;
      detail.disappointed = true;
    }
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
 * Compare where a player actually went against his average draft position,
 * merged in from the precomputed `data/players/adp.json` artifact.
 *
 * The comparison is symmetric: going far LATER than his ADP is a fall, going far
 * EARLIER is a reach. Both are things a group chat notices, and a reach is
 * usually the funnier of the two because somebody has to defend it.
 *
 * `search_rank` is deliberately NOT used as a fallback. It is a talent/search
 * ordering, not a draft position — it ranks Josh Allen around 4th overall, which
 * would manufacture a nonsense "he fell 30 picks" on a completely normal pick.
 * A wrong signal is worse than a missing one, so: no ADP, no claim.
 *
 * ADP reflects the CURRENT season only. That is exactly what a draft signal
 * wants, and it is why it never grades past seasons: a player who busted last
 * year carries a depressed ADP this year, so scoring history against it would
 * quietly cancel the very disappointment worth talking about.
 */
function detectSurprise(
  pick: Pick,
  players: Record<string, SleeperPlayer>,
  opts: Required<DraftSignalOptions>,
): Surprise | null {
  const rank = players[pick.playerId]?.adp;
  if (typeof rank !== 'number' || !Number.isFinite(rank) || rank <= 0) return null;
  // The artifact drops Sleeper's 1000 sentinel, but guard anyway: an unranked
  // player must produce no claim rather than an enormous fabricated fall.
  if (rank >= 1000) return null;

  const delta = pick.pickNo - rank;

  // Slid past his ADP: players expect to go around it, so falling more than
  // `disappointmentPicks` past consensus is something he takes personally.
  if (delta > opts.disappointmentPicks) {
    return { fellBelowRank: delta, expectedRank: rank, threshold: opts.disappointmentPicks };
  }

  // Taken ahead of his ADP.
  const early = -delta;
  const threshold = reachThreshold(rank, opts);
  if (early > threshold) {
    return { reachedAboveRank: early, expectedRank: rank, threshold };
  }
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
