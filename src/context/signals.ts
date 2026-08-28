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
  /** How many picks past his `search_rank` counts as an obvious fall. Default 12. */
  fallThreshold?: number;
}

export const DEFAULT_SIGNAL_OPTIONS: Required<DraftSignalOptions> = {
  positionRunWindow: 5,
  positionRunThreshold: 3,
  fallThreshold: 12,
};

/** A richer read on the same Pick, for callers that want the detail. */
export interface DraftSignalDetail extends DraftSignals {
  /** How many of the windowed Picks shared the run's position. */
  positionRunCount?: number;
  /** The window size the run was measured over. */
  positionRunWindow?: number;
  /** Names already on this Manager's roster that share the drafted player's NFL team. */
  stackWith?: string[];
  /** The `search_rank` the fall was measured against. */
  expectedRank?: number;
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

  const fall = detectFall(pick, players, opts);
  if (fall) {
    detail.fellBelowRank = fall.fellBelowRank;
    detail.expectedRank = fall.expectedRank;
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

interface Fall {
  fellBelowRank: number;
  expectedRank: number;
}

/**
 * An obvious fall exists when the player's Sleeper `search_rank` is far ahead of
 * the pick number he actually went at. No `search_rank`, no claim.
 */
function detectFall(
  pick: Pick,
  players: Record<string, SleeperPlayer>,
  opts: Required<DraftSignalOptions>,
): Fall | null {
  const rank = players[pick.playerId]?.search_rank;
  if (typeof rank !== 'number' || !Number.isFinite(rank) || rank <= 0) return null;
  // Sleeper parks unranked players at absurd sentinel ranks; those are not falls.
  if (rank > 10000) return null;
  const fellBelowRank = pick.pickNo - rank;
  if (fellBelowRank < opts.fallThreshold) return null;
  return { fellBelowRank, expectedRank: rank };
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
