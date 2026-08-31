/**
 * The live slow-draft poller — implementation_plan.md §6 "Live slow-draft
 * detection" and Milestone E.
 *
 * A slow draft can run for weeks, so this is deliberately dull: fetch the
 * draft's picks every 20-30 seconds, take the ones we have not seen, process
 * them in order, sleep, repeat.
 *
 * TWO FACTS SHAPE EVERYTHING HERE.
 *
 * 1. `docs/sleeper-facts.md`: **a Sleeper pick carries no timestamp.** The only
 *    time-like field on a pick is `metadata.news_updated`, which is about the
 *    player's news feed. Ordering therefore keys on `pick_no` and nothing else —
 *    there is no "arrival time" to sort by, and inventing one would reorder the
 *    Lounge's conversation.
 * 2. The target league is still `pre_draft`. Polling a draft that has not
 *    started is the normal case for days on end, so it is a quiet no-op, not an
 *    error.
 *
 * Duplicate suppression is two-layered and both layers survive a restart:
 * `state.lastProcessedPickNo` is the cheap high-water mark, and `hasProcessed`
 * on the `eventId` is the authoritative check. Neither lives in memory.
 */
import { normalizePicks } from '../import/picks.js';
import type { PlayerIndex } from '../import/players.js';
import { hasProcessed, loadState, type PersistOptions } from '../lounge/persist.js';
import { liveDraftFile, livePicksFile } from '../paths.js';
import { coerceSeason } from '../sleeper/discovery.js';
import { writeJson } from '../util/json.js';
import { writeJsonl } from '../util/jsonl.js';
import type {
  SleeperDraft,
  SleeperDraftPick,
  SleeperLeague,
  SleeperUser,
} from '../sleeper/types.js';
import type { AppConfig, DraftStatus, DraftType, Pick, SelectedDraft } from '../types.js';
import { log } from '../util/log.js';
import type { ProcessPickResult } from '../cli/pipeline.js';

/** The default poll interval. The plan's band is 20-30 seconds. */
export const DEFAULT_INTERVAL_SECONDS = 25;
/** Below this the poller warns: Sleeper is a public API and this is a slow draft. */
export const MIN_POLITE_INTERVAL_SECONDS = 20;

/** Draft statuses that mean "nothing has happened yet". */
const NOT_STARTED = new Set(['pre_draft', 'scheduled']);

/**
 * Overwrite `data/lounge/picks.jsonl` with the draft as it currently stands.
 *
 * Overwrite rather than append: the API hands back the whole draft on every
 * poll, which makes this the one file in the Lounge that needs no dedupe.
 * Exported so `runWatch` can wire it in — `pollOnce` never reaches for it
 * itself, so a test that forgets to stub it still cannot write to `data/`.
 */
export function recordLivePicks(picks: readonly Pick[]): Promise<void> {
  return writeJsonl(livePicksFile, [...picks]);
}

/**
 * Write the watched draft's identity to `data/lounge/draft.json`.
 *
 * The board reads it to answer two questions it cannot ask Sleeper: whose draft
 * is this, and is a live draft being followed at all. The second matters most at
 * pick zero — the live picks file is still empty then, and without this the
 * board silently falls back to the Simulation and shows the wrong league's
 * draft. Recorded on every poll, so `status` and `totalPicks` stay current.
 */
export function recordLiveDraft(
  draft: SleeperDraft,
  target: WatchTarget,
  totalPicks = 0,
): Promise<void> {
  return writeJson(liveDraftFile, toLiveDraft(draft, target, totalPicks));
}

/** Project a live `SleeperDraft` onto the same shape `selected-draft.json` uses. */
export function toLiveDraft(
  draft: SleeperDraft,
  target: WatchTarget,
  totalPicks = 0,
): SelectedDraft {
  const settings = draft.settings ?? {};
  const slotCount = Object.keys(draft.slot_to_roster_id ?? {}).length;
  return {
    leagueId: target.leagueId,
    leagueName: target.leagueName,
    draftId: target.draftId,
    season: coerceSeason(draft.season, target.season),
    status: (draft.status ?? 'unknown') as DraftStatus,
    type: (draft.type ?? 'snake') as DraftType,
    rounds: settings.rounds ?? 0,
    teams: settings.teams ?? slotCount,
    selectedAt: new Date().toISOString(),
    totalPicks,
  };
}

/**
 * The slice of `SleeperClient` the poller needs. Narrow on purpose: a test
 * satisfies it with three functions and no network.
 */
export interface DraftSource {
  getDraft(draftId: string, opts?: { ttlMs?: number }): Promise<SleeperDraft>;
  getDraftPicks(draftId: string, opts?: { ttlMs?: number }): Promise<SleeperDraftPick[]>;
  getLeagueUsers(leagueId: string, opts?: { ttlMs?: number }): Promise<SleeperUser[]>;
}

/** What `resolveWatchTarget` additionally needs. */
export interface LeagueSource extends DraftSource {
  getLeague(leagueId: string, opts?: { ttlMs?: number }): Promise<SleeperLeague>;
  getLeagueDrafts(leagueId: string, opts?: { ttlMs?: number }): Promise<SleeperDraft[]>;
  getUserLeagues(
    userId: string,
    sport: string,
    season: string,
    opts?: { ttlMs?: number },
  ): Promise<SleeperLeague[]>;
}

/** The draft being watched. */
export interface WatchTarget {
  leagueId: string;
  leagueName: string;
  draftId: string;
  season: number;
}

export interface PollOnceOptions {
  client: DraftSource;
  target: WatchTarget;
  /** The high-water mark from `state.json`. */
  lastProcessedPickNo: number;
  /** Runs one Pick through the pipeline. Injected so tests never spend money. */
  process: (pick: Pick) => Promise<ProcessPickResult>;
  /** ADP-enriched players dataset, for names, positions and draft signals. */
  players?: PlayerIndex;
  /** League users, so Managers have names. Fetched once per poll when omitted. */
  users?: SleeperUser[];
  /** Defaults to the persistence layer's `hasProcessed`. */
  isProcessed?: (eventId: string) => Promise<boolean>;
  persist?: PersistOptions;
  /**
   * Records the draft's Picks so `lounge board` can render the live draft.
   *
   * There is deliberately NO default: `pollOnce` is called by tests that must
   * not touch `data/`, so the filesystem side effect is the caller's to opt
   * into. `runWatch` wires in `recordLivePicks`.
   */
  recordPicks?: (picks: readonly Pick[]) => Promise<void>;
  /**
   * Records which draft is being watched, so `lounge board` boards it from
   * pick zero instead of falling back to the Simulation. No default, for the
   * same reason `recordPicks` has none: `pollOnce` must not touch `data/`
   * unless the caller asked it to. `runWatch` wires in `recordLiveDraft`.
   */
  recordDraft?: (draft: SleeperDraft, target: WatchTarget, totalPicks: number) => Promise<void>;
}

export interface PollResult {
  /** The draft's Sleeper status, verbatim. */
  status: string;
  /** False while the draft is `pre_draft` — the ordinary case before draft day. */
  started: boolean;
  /** Total picks the draft has made so far. */
  totalPicks: number;
  /** Picks above the high-water mark that had not been processed yet. */
  newPicks: Pick[];
  results: ProcessPickResult[];
  /** Picks above the high-water mark that were already on disk. */
  duplicates: number;
  /** The high-water mark after this poll. */
  lastProcessedPickNo: number;
}

/**
 * One poll. Fetch, diff, process in ascending `pick_no` order, return.
 * Every read bypasses the HTTP cache (`ttlMs: 0`) — a cached draft is a draft
 * that never appears to progress.
 */
export async function pollOnce(opts: PollOnceOptions): Promise<PollResult> {
  const { client, target } = opts;
  const fresh = { ttlMs: 0 };

  const draft = await client.getDraft(target.draftId, fresh);
  const status = draft.status ?? 'unknown';

  // Before the status branch returns: a draft nobody has picked in yet is still
  // the draft being followed, and the board has to know that to title itself.
  if (opts.recordDraft) await recordDraftQuietly(opts.recordDraft, draft, target, 0);

  if (NOT_STARTED.has(status)) {
    log.info(
      `${target.leagueName} draft ${target.draftId} is still '${status}' — nothing to do yet`,
    );
    return {
      status,
      started: false,
      totalPicks: 0,
      newPicks: [],
      results: [],
      duplicates: 0,
      lastProcessedPickNo: opts.lastProcessedPickNo,
    };
  }

  const rawPicks = await client.getDraftPicks(target.draftId, fresh);
  const users =
    opts.users ??
    (await client.getLeagueUsers(target.leagueId, fresh).catch((error: unknown) => {
      log.warn('could not read league users; Manager names will fall back', error);
      return [] as SleeperUser[];
    }));

  // `normalizePicks` validates every Pick and returns them ascending by pickNo.
  const picks = normalizePicks(rawPicks, {
    leagueId: target.leagueId,
    draftId: target.draftId,
    season: target.season,
    ...(opts.players ? { players: opts.players } : {}),
    users,
    draftOrder: draft.draft_order ?? null,
  });

  // Before processing, not after: with `--sync` the per-Pick commit happens
  // inside `process`, so recording first is what keeps the board and the
  // transcript in the same commit rather than one poll apart.
  if (opts.recordDraft) await recordDraftQuietly(opts.recordDraft, draft, target, picks.length);

  if (picks.length > 0 && opts.recordPicks) {
    await opts.recordPicks(picks).catch((error: unknown) => {
      // The board is a viewing surface; failing to update it must not stop a draft.
      log.warn('could not record live picks for the board', error);
    });
  }

  const candidates = picks
    .filter((pick) => pick.pickNo > opts.lastProcessedPickNo)
    .sort((a, b) => a.pickNo - b.pickNo);

  const isProcessed =
    opts.isProcessed ?? ((eventId: string) => hasProcessed(eventId, opts.persist ?? {}));

  const newPicks: Pick[] = [];
  const results: ProcessPickResult[] = [];
  let duplicates = 0;
  let highWater = opts.lastProcessedPickNo;

  for (const pick of candidates) {
    if (await isProcessed(pick.eventId)) {
      duplicates += 1;
      // Still advance the mark: this pick is genuinely done.
      highWater = Math.max(highWater, pick.pickNo);
      continue;
    }
    log.info(`new pick #${pick.pickNo}: ${pick.playerName} -> ${pick.managerName}`);
    const result = await opts.process(pick);
    newPicks.push(pick);
    results.push(result);
    highWater = Math.max(highWater, pick.pickNo);
  }

  return {
    status,
    started: true,
    totalPicks: picks.length,
    newPicks,
    results,
    duplicates,
    lastProcessedPickNo: highWater,
  };
}

/** The board is a viewing surface; failing to describe it must not stop a draft. */
async function recordDraftQuietly(
  record: NonNullable<PollOnceOptions['recordDraft']>,
  draft: SleeperDraft,
  target: WatchTarget,
  totalPicks: number,
): Promise<void> {
  await record(draft, target, totalPicks).catch((error: unknown) => {
    log.warn('could not record the live draft for the board', error);
  });
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

export interface WatchDraftOptions extends Omit<PollOnceOptions, 'lastProcessedPickNo'> {
  /** Poll interval in milliseconds. Defaults to 25s. */
  intervalMs?: number;
  /** Poll exactly once and return. This is how the watcher is tested by hand. */
  once?: boolean;
  /** Stop after this many polls. Tests use it to bound the loop. */
  maxPolls?: number;
  /** Aborting finishes the poll in flight, then returns cleanly. */
  signal?: AbortSignal;
  /** Reads the high-water mark before every poll. Defaults to `state.json`. */
  loadLastProcessed?: () => Promise<number>;
  /** Injected clock for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onPoll?: (result: PollResult) => void;
}

export interface WatchSummary {
  polls: number;
  picksProcessed: number;
  results: ProcessPickResult[];
  /** The status of the last poll. */
  status: string;
  /** True when the loop ended because it was aborted. */
  aborted: boolean;
}

/**
 * Poll until aborted (or `once`/`maxPolls` says otherwise).
 *
 * The high-water mark is re-read from `state.json` before every poll rather
 * than tracked in memory, so a second watcher — or a `simulate` run in another
 * terminal — cannot make this one re-process a Pick.
 */
export async function watchDraft(opts: WatchDraftOptions): Promise<WatchSummary> {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_SECONDS * 1000;
  const nap = opts.sleep ?? sleep;
  const readMark =
    opts.loadLastProcessed ??
    (async () => (await loadState(opts.persist ?? {})).lastProcessedPickNo);

  // A function, not an expression: `AbortSignal.aborted` is a readonly boolean
  // and the compiler would otherwise narrow it to `false` for the whole loop.
  const aborted = (): boolean => opts.signal?.aborted === true;

  const results: ProcessPickResult[] = [];
  let polls = 0;
  let status = 'unknown';

  for (;;) {
    if (aborted()) break;

    const lastProcessedPickNo = await readMark();
    const result = await pollOnce({ ...opts, lastProcessedPickNo });
    polls += 1;
    status = result.status;
    results.push(...result.results);
    opts.onPoll?.(result);

    if (opts.once === true) break;
    if (typeof opts.maxPolls === 'number' && polls >= opts.maxPolls) break;
    if (aborted()) break;

    await nap(intervalMs, opts.signal);
  }

  return {
    polls,
    picksProcessed: results.length,
    results,
    status,
    aborted: aborted(),
  };
}

/** `setTimeout` that resolves early when the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

/**
 * Work out which draft to watch.
 *
 * With no `--league` this is the configured target league (`hotelkit
 * Fantasies`), looked up by name because that is how it is configured. A league
 * id short-circuits the lookup, which is what lets the watcher be pointed at a
 * completed draft for a dry run.
 */
export async function resolveWatchTarget(
  client: LeagueSource,
  config: AppConfig,
  leagueId?: string,
): Promise<WatchTarget> {
  const league = leagueId
    ? await client.getLeague(leagueId)
    : await findLeagueByName(client, config);

  if (!league) {
    throw new Error(
      `Target league '${config.sleeper.targetLeagueName}' not found among ` +
        `${config.sleeper.username}'s ${config.season} leagues. ` +
        'Pass --league <id> to watch a specific league.',
    );
  }

  const draftId = league.draft_id ?? (await latestDraftId(client, league.league_id));
  if (!draftId) {
    throw new Error(`League ${league.league_id} (${league.name}) has no draft to watch.`);
  }

  return {
    leagueId: league.league_id,
    leagueName: league.name,
    draftId,
    season: Number.parseInt(league.season, 10) || config.season,
  };
}

/** The configured target league, matched by name — that is how it is configured. */
async function findLeagueByName(
  client: LeagueSource,
  config: AppConfig,
): Promise<SleeperLeague | null> {
  const wanted = config.sleeper.targetLeagueName.trim().toLowerCase();
  const leagues = await client.getUserLeagues(
    config.sleeper.userId,
    'nfl',
    String(config.season),
  );
  return leagues.find((league) => league.name?.trim().toLowerCase() === wanted) ?? null;
}

async function latestDraftId(client: LeagueSource, leagueId: string): Promise<string | null> {
  const drafts = await client.getLeagueDrafts(leagueId).catch(() => [] as SleeperDraft[]);
  const newest = [...drafts].sort(
    (a, b) => (b.created ?? 0) - (a.created ?? 0),
  )[0];
  return newest?.draft_id ?? null;
}
