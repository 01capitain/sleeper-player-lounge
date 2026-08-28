/**
 * `lounge simulate` — replay stored Picks from the selected Simulation draft.
 *
 * Three modes, one pipeline:
 *
 *   --next        the next Pick after `state.lastProcessedPickNo`
 *   --pick <n>    one specific overall pick number
 *   --all         the whole draft, `--limit <n>` at a time
 *
 * `--all` shares a single chromium across every render. Launching one browser
 * per Pick means ~300ms each and 238 chromium processes over a full replay, so
 * the batch path opens one and hands it to every `processPick` call.
 *
 * stdout carries the human-readable summary and the generated dialogue; every
 * diagnostic goes to stderr through the logger.
 */
import { loadPicks } from '../../import/picks.js';
import type { PlayerIndex } from '../../import/players.js';
import { loadState, type PersistOptions } from '../../lounge/persist.js';
import { launchLoungeBrowser, type LoungeBrowser } from '../../render/browser.js';
import type { LoungeDirector, Pick, RenderFormat } from '../../types.js';
import { log } from '../../util/log.js';
import {
  describePick,
  formatDialogue,
  processPick as defaultProcessPick,
  processedEventIds,
  type ProcessPickOptions,
  type ProcessPickResult,
} from '../pipeline.js';

export interface SimulateOptions {
  /** Process only the next unprocessed Pick. The default when nothing is given. */
  next?: boolean;
  /** Process one specific overall pick number. */
  pick?: number;
  /** Replay every stored Pick that has not been processed yet. */
  all?: boolean;
  /** Cap on how many Picks `--all` processes in this run. */
  limit?: number;
  /** Apply the Manager Alias overlay. */
  alias?: boolean;
  /** `--no-render` sets this to false. */
  render?: boolean;
  format?: RenderFormat;
  /** Use `StubDirector` — deterministic, offline, no LLM. */
  stub?: boolean;
  /** Open each rendered asset with the platform opener. */
  open?: boolean;
}

/** Injectable seams. Tests replace all of them; nothing here touches the network. */
export interface SimulateDeps {
  picksFile?: string;
  persist?: PersistOptions;
  players?: PlayerIndex;
  director?: LoungeDirector;
  processPick?: (pick: Pick, opts: ProcessPickOptions) => Promise<ProcessPickResult>;
  /** Called once per run when a batch needs a shared browser. */
  launchBrowser?: () => Promise<LoungeBrowser>;
  stdout?: (line: string) => void;
  processOptions?: Partial<ProcessPickOptions>;
}

export interface SimulateSummary {
  results: ProcessPickResult[];
  processed: number;
  skipped: number;
  rendered: number;
  /** True when a single chromium was launched and shared across the batch. */
  sharedBrowser: boolean;
}

export async function runSimulate(
  opts: SimulateOptions = {},
  deps: SimulateDeps = {},
): Promise<SimulateSummary> {
  const out = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const run = deps.processPick ?? defaultProcessPick;
  const persist = deps.persist ?? {};

  const picks = await loadPicks(deps.picksFile);
  if (picks.length === 0) {
    throw new Error(
      'No stored Picks. Run `npm run lounge -- setup` first — it imports the Simulation draft.',
    );
  }

  const targets = await selectPicks(picks, opts, persist);
  if (targets.length === 0) {
    out(describeNothingToDo(opts));
    return { results: [], processed: 0, skipped: 0, rendered: 0, sharedBrowser: false };
  }

  const wantsRender = opts.render !== false;
  const needsSharedBrowser = wantsRender && targets.length > 1;
  const launch = deps.launchBrowser ?? (() => launchLoungeBrowser());
  const browser = needsSharedBrowser ? await launch() : undefined;
  if (browser) log.info(`sharing one chromium across ${targets.length} renders`);

  const results: ProcessPickResult[] = [];
  try {
    for (const pick of targets) {
      const options: ProcessPickOptions = {
        render: wantsRender,
        alias: opts.alias === true,
        open: opts.open === true,
        stub: opts.stub === true,
        persist,
        ...(opts.format ? { format: opts.format } : {}),
        ...(deps.director ? { director: deps.director } : {}),
        ...(deps.players ? { players: deps.players } : {}),
        ...(browser ? { browser } : {}),
        ...(deps.processOptions ?? {}),
      };
      const result = await run(pick, options);
      results.push(result);
      for (const line of describeResult(result)) out(line);
    }
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }

  const summary: SimulateSummary = {
    results,
    processed: results.filter((result) => !result.skipped).length,
    skipped: results.filter((result) => result.skipped).length,
    rendered: results.filter((result) => result.outputPath !== null).length,
    sharedBrowser: browser !== undefined,
  };

  if (targets.length > 1) {
    out('');
    out(
      `Done: ${summary.processed} processed, ${summary.skipped} already had a Reaction, ` +
        `${summary.rendered} rendered`,
    );
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Which Picks
// ---------------------------------------------------------------------------

/**
 * Resolve the Picks this invocation should process.
 * `--pick` wins, then `--all`, then `--next` (which is also the default).
 */
export async function selectPicks(
  picks: readonly Pick[],
  opts: SimulateOptions,
  persist: PersistOptions = {},
): Promise<Pick[]> {
  if (typeof opts.pick === 'number') {
    const found = picks.find((pick) => pick.pickNo === opts.pick);
    if (!found) {
      throw new Error(
        `No stored Pick #${opts.pick}. The draft has picks 1..${picks[picks.length - 1]?.pickNo ?? 0}.`,
      );
    }
    return [found];
  }

  const processed = await processedEventIds(persist);

  if (opts.all === true) {
    const pending = picks.filter((pick) => !processed.has(pick.eventId));
    const limit = opts.limit;
    return typeof limit === 'number' && limit > 0 ? pending.slice(0, limit) : pending;
  }

  // --next, and the no-flag default.
  const state = await loadState(persist);
  const next = picks.find(
    (pick) => pick.pickNo > state.lastProcessedPickNo && !processed.has(pick.eventId),
  );
  return next ? [next] : [];
}

function describeNothingToDo(opts: SimulateOptions): string {
  if (opts.all === true) return 'Nothing to do — every stored Pick already has a Reaction.';
  return 'Nothing to do — no unprocessed Pick after the last one processed.';
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function describeResult(result: ProcessPickResult): string[] {
  const lines: string[] = [''];
  lines.push(describePick(result.pick));

  if (result.skipped) {
    lines.push('  already processed — no duplicate Reaction was created');
    if (result.outputPath) lines.push(`  re-rendered: ${result.outputPath}`);
    return lines;
  }

  if (result.reaction) lines.push(...formatDialogue(result.reaction));
  lines.push(result.outputPath ? `  rendered: ${result.outputPath}` : '  not rendered (--no-render)');
  return lines;
}

export default runSimulate;
