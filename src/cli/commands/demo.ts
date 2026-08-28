/**
 * `lounge demo` — one command, zero arguments, ends with a picture.
 *
 * This is the front door. From a clean checkout `npm run demo` must run setup
 * if it has not been run, choose a Pick worth looking at, generate the scene,
 * render it, print the dialogue as text and open the image. Nothing about it
 * may require the reader to have discovered another command first.
 *
 * Why a PNG by default: it takes ~3 seconds and needs no ffmpeg. `--format mp4`
 * is there for when you already know you want the animation.
 *
 * Running it twice is not an error. The second run finds the Pick already has a
 * Reaction, re-renders that Reaction instead of generating a new one —
 * identical, and still ending in a picture. That is the §14 idempotency rule
 * doing something useful rather than something obstructive.
 */
import { loadPicks } from '../../import/picks.js';
import type { PlayerIndex } from '../../import/players.js';
import type { PersistOptions } from '../../lounge/persist.js';
import { selectedDraftFile } from '../../paths.js';
import type { LoungeDirector, Pick, RenderFormat, SelectedDraft } from '../../types.js';
import { readJsonIfExists } from '../../util/json.js';
import { log } from '../../util/log.js';
import {
  formatDialogue,
  loadEnrichedPlayers,
  processPick as defaultProcessPick,
  processedEventIds,
  type ProcessPickOptions,
  type ProcessPickResult,
} from '../pipeline.js';
import { runSetup } from './setup.js';

// ---------------------------------------------------------------------------
// Which Pick is worth showing a stranger
// ---------------------------------------------------------------------------

/**
 * The three required Regulars, in the order they make the best first
 * impression. All three are confirmed present in the Simulation draft
 * (`docs/sleeper-facts.md`), so this is a real preference, not a hope.
 */
export const DEMO_REGULARS: readonly { playerId: string; reason: string }[] = [
  {
    playerId: '7553',
    reason: 'Kyle Pitts carries permanent league bust lore — the Lounge never lets it go',
  },
  {
    playerId: '1466',
    reason: 'Travis Kelce is a Regular with a pop-culture voice and teammates in the room',
  },
  {
    playerId: '96',
    reason: 'Aaron Rodgers is a Regular, and a round-17 quarterback has opinions',
  },
];

export interface DemoChoice {
  pick: Pick;
  /** Human-readable justification, printed so the choice is never mysterious. */
  reason: string;
}

export interface ChoosePickOptions {
  /** `--pick <n>` — an explicit choice always wins. */
  pickNo?: number;
  /** Prefer a Pick that has no Reaction yet, so the demo shows fresh dialogue. */
  processed?: ReadonlySet<string>;
}

/**
 * Choose the Pick to demo, preferring in order:
 * a required Regular, the biggest ADP slide, the biggest reach, pick 1.
 *
 * Within that ordering, a Pick that has not been processed yet wins over one
 * that has — a second `npm run demo` should show something new if anything new
 * is available.
 */
export function choosePick(
  picks: readonly Pick[],
  players: Readonly<PlayerIndex> = {},
  opts: ChoosePickOptions = {},
): DemoChoice {
  if (picks.length === 0) {
    throw new Error('No stored Picks to demo. Run `npm run lounge -- setup` first.');
  }

  if (typeof opts.pickNo === 'number') {
    const found = picks.find((pick) => pick.pickNo === opts.pickNo);
    if (!found) {
      throw new Error(
        `No stored Pick #${opts.pickNo}. This draft has picks 1..${
          picks[picks.length - 1]?.pickNo ?? 0
        }.`,
      );
    }
    return { pick: found, reason: `you asked for pick #${opts.pickNo}` };
  }

  const candidates: DemoChoice[] = [];

  // 1. A required Regular.
  for (const regular of DEMO_REGULARS) {
    const found = picks.find((pick) => pick.playerId === regular.playerId);
    if (found) candidates.push({ pick: found, reason: regular.reason });
  }

  // 2. The biggest slide, then 3. the biggest reach. ADP comes from the
  //    precomputed artifact (ADR 0004); absent ADP means no claim, so those
  //    picks simply do not compete.
  const slide = extremeAdpGap(picks, players, 'slide');
  if (slide) candidates.push(slide);
  const reach = extremeAdpGap(picks, players, 'reach');
  if (reach) candidates.push(reach);

  // 4. Pick 1 — there is always a pick 1.
  const first = picks[0];
  if (first) {
    candidates.push({ pick: first, reason: 'the first pick of the draft, and nothing louder' });
  }

  const processed = opts.processed;
  const unseen = processed
    ? candidates.find((candidate) => !processed.has(candidate.pick.eventId))
    : undefined;
  const chosen = unseen ?? candidates[0];
  if (!chosen) throw new Error('No stored Picks to demo.');
  return chosen;
}

/** The Pick that fell furthest below, or was taken furthest above, its ADP. */
function extremeAdpGap(
  picks: readonly Pick[],
  players: Readonly<PlayerIndex>,
  direction: 'slide' | 'reach',
): DemoChoice | null {
  let best: { pick: Pick; gap: number; adp: number } | null = null;
  for (const pick of picks) {
    const adp = players[pick.playerId]?.adp;
    if (typeof adp !== 'number' || !Number.isFinite(adp)) continue;
    const gap = direction === 'slide' ? pick.pickNo - adp : adp - pick.pickNo;
    if (gap <= 0) continue;
    if (best === null || gap > best.gap) best = { pick, gap, adp };
  }
  if (best === null) return null;
  const gap = Math.round(best.gap);
  return {
    pick: best.pick,
    reason:
      direction === 'slide'
        ? `the biggest slide of the draft — ${best.pick.playerName} went ${gap} picks past his ADP of ${Math.round(best.adp)}`
        : `the biggest reach of the draft — ${best.pick.playerName} went ${gap} picks ahead of his ADP of ${Math.round(best.adp)}`,
  };
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

export interface DemoOptions {
  /** Force a specific overall pick number. */
  pick?: number;
  /** png (default) | gif | mp4. */
  format?: RenderFormat;
  /** `--no-open` sets this to false. */
  open?: boolean;
  /** Use `StubDirector` — deterministic, offline, no LLM. */
  stub?: boolean;
}

export interface DemoDeps {
  picksFile?: string;
  persist?: PersistOptions;
  players?: PlayerIndex;
  director?: LoungeDirector;
  processPick?: (pick: Pick, opts: ProcessPickOptions) => Promise<ProcessPickResult>;
  /** Runs `lounge setup` when the workspace is empty. */
  setup?: () => Promise<void>;
  /** Overrides the "has setup run?" probe. */
  isSetUp?: () => Promise<boolean>;
  stdout?: (line: string) => void;
  processOptions?: Partial<ProcessPickOptions>;
}

export interface DemoResult extends ProcessPickResult {
  reason: string;
  ranSetup: boolean;
}

export async function runDemo(opts: DemoOptions = {}, deps: DemoDeps = {}): Promise<DemoResult> {
  const out = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const run = deps.processPick ?? defaultProcessPick;
  const persist = deps.persist ?? {};

  // 1. Setup, if it has not been run. Nobody should have to discover `setup`.
  const ready = deps.isSetUp ? await deps.isSetUp() : await isSetUp(deps.picksFile);
  let ranSetup = false;
  if (!ready) {
    out('No local draft data yet — running setup first. This takes a moment.');
    out('');
    await (deps.setup ?? (() => runSetup()))();
    ranSetup = true;
    out('');
  }

  const picks = await loadPicks(deps.picksFile);
  const players = deps.players ?? (await loadEnrichedPlayers());

  // 2. Choose something worth looking at, and say why.
  const choice = choosePick(picks, players, {
    ...(typeof opts.pick === 'number' ? { pickNo: opts.pick } : {}),
    processed: await processedEventIds(persist),
  });

  const format: RenderFormat = opts.format ?? 'png';
  const wantsOpen = opts.open !== false;

  out(banner(choice, format, opts.stub === true));

  // 3-5. The full pipeline, with the real Director unless --stub.
  const result = await run(choice.pick, {
    render: true,
    format,
    open: wantsOpen,
    stub: opts.stub === true,
    rerenderSkipped: true,
    persist,
    players,
    ...(deps.director ? { director: deps.director } : {}),
    ...(deps.processOptions ?? {}),
  });

  // 6. The dialogue as text, so it is readable even if nothing opened.
  for (const line of report(result, format, wantsOpen)) out(line);

  return { ...result, reason: choice.reason, ranSetup };
}

/** True when `setup` has already produced the files the demo needs. */
async function isSetUp(picksFile?: string): Promise<boolean> {
  const [picks, selected] = await Promise.all([
    loadPicks(picksFile).catch(() => []),
    readJsonIfExists<SelectedDraft>(selectedDraftFile).catch(() => null),
  ]);
  return picks.length > 0 && selected !== null;
}

// ---------------------------------------------------------------------------
// Output — this is the first thing anyone sees, so it gets some care
// ---------------------------------------------------------------------------

const RULE = '─'.repeat(72);

function banner(choice: DemoChoice, format: RenderFormat, stub: boolean): string {
  const pick = choice.pick;
  const round = pick.round ?? '?';
  const where = [pick.position, pick.nflTeam].filter(Boolean).join(', ');
  const lines = [
    '',
    RULE,
    '  PLAYERS LOUNGE — demo',
    RULE,
    '',
    `  Pick        #${pick.pickNo} · round ${round}`,
    `  Player      ${pick.playerName}${where ? ` (${where})` : ''}`,
    `  Manager     ${pick.managerName}`,
    `  Why         ${choice.reason}`,
    `  Director    ${stub ? 'StubDirector (deterministic, no LLM)' : 'claude -p'}`,
    `  Format      ${format}`,
    '',
    '  Directing the scene…',
  ];
  return lines.join('\n');
}

function report(result: ProcessPickResult, format: RenderFormat, wantsOpen: boolean): string[] {
  const lines: string[] = [''];

  if (result.reaction === null) {
    lines.push('  The Director produced nothing and nothing was stored.');
    return lines;
  }

  if (result.skipped) {
    lines.push('  This pick already had a Reaction — showing it again rather than directing it twice.');
    lines.push('');
  }

  lines.push('  THE LOUNGE');
  lines.push('');
  lines.push(...formatDialogue(result.reaction, '    '));
  lines.push('');

  if (result.skipped) {
    lines.push('  Director        not called (re-rendered from disk)');
  }

  if (result.outputPath) {
    lines.push(`  Rendered        ${result.outputPath}`);
    lines.push('');
    lines.push(wantsOpen ? '  Opening it now.' : `  Open it with: open ${result.outputPath}`);
  } else {
    lines.push('  Nothing was rendered.');
  }

  lines.push('');
  lines.push(RULE);
  lines.push('  Next:');
  lines.push('    npm run lounge -- simulate --next            one more pick');
  lines.push(`    npm run lounge -- react --latest --format mp4  the same scene, animated`);
  lines.push('    npm run lounge -- watch                     follow the live draft');
  lines.push(RULE);
  return lines;
}

/** Exported for the CLI's error path, which prefers a hint over a stack trace. */
export function demoHint(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  log.debug('demo failed', error);
  return message;
}

export default runDemo;
