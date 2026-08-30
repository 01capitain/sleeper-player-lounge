/**
 * `lounge watch` — Milestone E.
 *
 * Points the poller at the live target-league draft and runs every new Pick
 * through the same `processPick` spine `simulate` uses. The interesting
 * behaviour all lives in `src/watch/poller.ts`; this file is the wiring:
 * resolve the draft, own one chromium, print what happened, and shut down
 * cleanly on Ctrl-C.
 *
 * Chromium is launched lazily. The target league is `pre_draft` and may stay
 * that way for days, and a watcher that opens a browser it never uses is a
 * watcher nobody leaves running.
 */
import { loadConfig } from '../../config.js';
import type { PlayerIndex } from '../../import/players.js';
import type { PersistOptions } from '../../lounge/persist.js';
import { launchLoungeBrowser, type LoungeBrowser } from '../../render/browser.js';
import { sleeper } from '../../sleeper/client.js';
import type { LoungeDirector, Pick, RenderFormat } from '../../types.js';
import { log } from '../../util/log.js';
import {
  DEFAULT_INTERVAL_SECONDS,
  MIN_POLITE_INTERVAL_SECONDS,
  resolveWatchTarget,
  watchDraft,
  type LeagueSource,
  type PollResult,
  type WatchSummary,
  type WatchTarget,
} from '../../watch/poller.js';
import { publish as defaultPublish, pull as defaultPull, type SyncResult } from '../../watch/sync.js';
import {
  describePick,
  formatDialogue,
  loadEnrichedPlayers,
  processPick as defaultProcessPick,
  type ProcessPickOptions,
  type ProcessPickResult,
} from '../pipeline.js';

/** The slice of `src/watch/sync.ts` the watcher uses. Narrow so a test is two functions. */
export interface LoungeSync {
  pull(): Promise<SyncResult>;
  publish(label: string): Promise<SyncResult>;
}

export interface WatchOptions {
  /** Watch this league id instead of the configured target league. */
  league?: string;
  /** Poll interval in seconds. Default 25. */
  interval?: number;
  /** Poll once and exit. */
  once?: boolean;
  /** `--no-render` sets this to false. */
  render?: boolean;
  format?: RenderFormat;
  /** Use `StubDirector` — deterministic, offline, no LLM. */
  stub?: boolean;
  /**
   * Commit and push `data/lounge` after every Pick, and pull before starting.
   * This is what lets a multi-day draft move between machines.
   */
  sync?: boolean;
}

export interface WatchDeps {
  client?: LeagueSource;
  players?: PlayerIndex;
  director?: LoungeDirector;
  persist?: PersistOptions;
  processPick?: (pick: Pick, opts: ProcessPickOptions) => Promise<ProcessPickResult>;
  launchBrowser?: () => Promise<LoungeBrowser>;
  target?: WatchTarget;
  stdout?: (line: string) => void;
  /** Injected in tests so `--sync` never touches a real repository. */
  sync?: LoungeSync;
  /** Pre-built abort signal. The CLI wires SIGINT into this. */
  signal?: AbortSignal;
}

export async function runWatch(
  opts: WatchOptions = {},
  deps: WatchDeps = {},
): Promise<WatchSummary> {
  const out = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const config = await loadConfig();
  const client = deps.client ?? (sleeper as unknown as LeagueSource);
  const target = deps.target ?? (await resolveWatchTarget(client, config, opts.league));

  const seconds = opts.interval ?? DEFAULT_INTERVAL_SECONDS;
  if (seconds < MIN_POLITE_INTERVAL_SECONDS) {
    log.warn(
      `poll interval ${seconds}s is below the ${MIN_POLITE_INTERVAL_SECONDS}s the plan asks for; ` +
        'Sleeper is a free public API and this is a slow draft',
    );
  }

  // --- handoff: catch up with whatever the other machine drafted -------------
  // Before anything else, and before the high-water mark is first read. Starting
  // on stale state is the one failure this feature exists to prevent, so a
  // failed pull stops the watcher rather than quietly drafting over the gap.
  const sync: LoungeSync | undefined =
    deps.sync ?? (opts.sync === true ? { pull: () => defaultPull(), publish: defaultPublish } : undefined);
  if (sync) {
    const pulled = await sync.pull();
    if (!pulled.ok) {
      throw new Error(
        `--sync could not pull the Lounge forward: ${pulled.detail}. ` +
          'Resolve the repository by hand before watching, or run without --sync.',
      );
    }
    out(`Lounge sync: ${pulled.detail}`);
  }

  const players = deps.players ?? (await loadEnrichedPlayers());
  const wantsRender = opts.render !== false;
  const run = deps.processPick ?? defaultProcessPick;

  // --- Ctrl-C: finish the pick in flight, then stop ---------------------------
  const controller = new AbortController();
  const signal = deps.signal ?? controller.signal;
  const onInterrupt = (): void => {
    if (!controller.signal.aborted) {
      log.info('interrupt received — finishing the pick in flight, then shutting down');
      controller.abort();
    }
  };
  const ownsSignal = deps.signal === undefined;
  if (ownsSignal) process.on('SIGINT', onInterrupt).on('SIGTERM', onInterrupt);

  // --- one chromium for the whole session, opened on first use ---------------
  const launch = deps.launchBrowser ?? (() => launchLoungeBrowser());
  let browser: LoungeBrowser | undefined;
  const browserFor = async (): Promise<LoungeBrowser | undefined> => {
    if (!wantsRender) return undefined;
    browser ??= await launch();
    return browser;
  };

  out(
    `Watching ${target.leagueName} draft ${target.draftId} — polling every ${seconds}s` +
      `${opts.once === true ? ' (once)' : ''}. Ctrl-C to stop.`,
  );

  try {
    return await watchDraft({
      client,
      target,
      players,
      signal,
      intervalMs: seconds * 1000,
      ...(opts.once === true ? { once: true } : {}),
      ...(deps.persist ? { persist: deps.persist } : {}),
      onPoll: (result) => {
        for (const line of describePoll(result)) out(line);
      },
      process: async (pick) => {
        const result = await run(pick, {
          render: wantsRender,
          stub: opts.stub === true,
          persist: deps.persist ?? {},
          players,
          ...(opts.format ? { format: opts.format } : {}),
          ...(deps.director ? { director: deps.director } : {}),
          ...((await browserFor()) ? { browser: browser as LoungeBrowser } : {}),
        });
        // After the Reaction is on disk, never before: the commit is a snapshot
        // of persisted state, and a push that raced the write would hand the
        // other machine a Lounge that is one Pick ahead of its own transcript.
        if (sync) {
          const published = await sync.publish(describePick(pick));
          // Deliberately not fatal — see the header of `src/watch/sync.ts`.
          if (published.ok) log.info(`lounge sync: ${published.detail}`);
          else log.warn(`lounge sync failed: ${published.detail}`);
        }
        return result;
      },
    });
  } finally {
    if (ownsSignal) {
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onInterrupt);
    }
    if (browser) await browser.close().catch(() => undefined);
  }
}

function describePoll(result: PollResult): string[] {
  if (!result.started) {
    return [`  draft status '${result.status}' — not started yet, waiting`];
  }
  if (result.newPicks.length === 0) {
    return [`  ${result.totalPicks} picks made, nothing new`];
  }
  const lines: string[] = [];
  for (const entry of result.results) {
    lines.push('');
    lines.push(describePick(entry.pick));
    if (entry.reaction) lines.push(...formatDialogue(entry.reaction));
    if (entry.outputPath) lines.push(`  rendered: ${entry.outputPath}`);
  }
  return lines;
}

export default runWatch;
