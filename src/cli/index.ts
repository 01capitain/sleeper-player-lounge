#!/usr/bin/env node
/**
 * The `lounge` CLI — the command surface from implementation_plan.md §12.
 *
 * This file is wiring only. Every command's behaviour lives in
 * `src/cli/commands/*.ts` and the shared pipeline in `src/cli/pipeline.ts`, so
 * the surface can be read in one screen and each command stays testable without
 * commander.
 *
 * Two conventions hold everywhere:
 *
 *  - **stdout is content.** Summaries, dialogue and file paths go to stdout;
 *    every diagnostic goes to stderr through `src/util/log.ts`. `lounge react
 *    --latest | tail -1` is therefore a usable way to get a path.
 *  - **`--stub` never invokes the Director.** Any command that would call the
 *    Director accepts `--stub`, which swaps in `StubDirector`: no subprocess,
 *    offline, deterministic output.
 */
import { pathToFileURL } from 'node:url';

import { Command, InvalidArgumentError, Option } from 'commander';

import { FORMATS } from '../render/index.js';
import type { RenderFormat } from '../types.js';
import { log, setLogLevel } from '../util/log.js';
import { runDemo, type DemoOptions } from './commands/demo.js';
import { runHistoryImport, type HistoryImportOptions } from './commands/history.js';
import { runBoard, type BoardOptions } from './commands/board.js';
import { runReact, type ReactOptions } from './commands/react.js';
import { runScreenshot, type ScreenshotOptions } from './commands/screenshot.js';
import { runSetup, type RunSetupOptions } from './commands/setup.js';
import { runSimulate, type SimulateOptions } from './commands/simulate.js';
import {
  runWatch,
  DEFAULT_BOARD_REFRESH_SECONDS,
  type WatchOptions,
} from './commands/watch.js';
import { DEFAULT_INTERVAL_SECONDS } from '../watch/poller.js';

export { runBoard, runDemo, runHistoryImport, runReact, runScreenshot, runSetup, runSimulate, runWatch };
export type {
  BoardOptions,
  DemoOptions,
  HistoryImportOptions,
  ReactOptions,
  ScreenshotOptions,
  RunSetupOptions,
  SimulateOptions,
  WatchOptions,
};

// ---------------------------------------------------------------------------
// Option parsers
// ---------------------------------------------------------------------------



function parseIntOption(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new InvalidArgumentError(`expected an integer, got '${value}'`);
  }
  return parsed;
}

/** `--format <fmt>`, worded the same way everywhere it appears. */
function formatOption(description = 'output format'): Option {
  return new Option('--format <fmt>', description).choices([...FORMATS]);
}

/** `--stub`, worded the same way everywhere it appears. */
function stubOption(): Option {
  return new Option('--stub', 'run the pipeline without invoking the Director (deterministic, offline)');
}

/**
 * `--verbose`, added to the program *and* every subcommand.
 *
 * A first-time reader types `npm run demo -- --verbose`, which puts the flag
 * after the subcommand name; commander would otherwise reject it there.
 */
function verboseOption(): Option {
  return new Option('-v, --verbose', 'debug logging on stderr (same as LOUNGE_LOG_LEVEL=debug)');
}

/** Every command in the tree, including nested ones like `history import`. */
function allCommands(command: Command): Command[] {
  return command.commands.flatMap((child) => [child, ...allCommands(child)]);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

/** Build the commander program. Exported so tests can inspect the surface. */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name('lounge')
    .description(
      'Players Lounge — turn Sleeper draft picks into fictional NFL group-chat scenes.\n\n' +
        'Start here:\n' +
        '  npm run demo                      set up if needed, generate one scene, open the image\n\n' +
        'Then:\n' +
        '  npm run lounge -- simulate --next      the next pick of the stored draft\n' +
        '  npm run lounge -- react --latest --format mp4   re-render that scene as video\n' +
        '  npm run lounge -- watch                follow the live slow draft\n\n' +
        'The Director shells out to `claude -p` and needs no API key — it reuses your\n' +
        'existing Claude Code authentication. Add --stub anywhere to run the same\n' +
        'pipeline without invoking the Director at all.',
    )
    .addOption(verboseOption())
    .showHelpAfterError();

  program.hook('preAction', (thisCommand, actionCommand) => {
    if (thisCommand.opts()['verbose'] === true || actionCommand.opts()['verbose'] === true) {
      process.env['LOUNGE_LOG_LEVEL'] = 'debug';
      setLogLevel('debug');
    }
  });

  // --- demo -----------------------------------------------------------------
  program
    .command('demo')
    .description('THE ONE TO RUN FIRST: set up if needed, direct one scene, render it and open it')
    .addHelpText(
      'after',
      '\nExamples:\n' +
        '  npm run demo\n' +
        '  npm run demo -- --stub --no-open      deterministic, offline, no window opens\n' +
        '  npm run demo -- --pick 119 --format mp4\n',
    )
    .option('--pick <n>', 'demo one specific overall pick number', parseIntOption)
    .addOption(formatOption('output format; png is the fastest').default('png'))
    .option('--no-open', 'do not open the rendered file')
    .addOption(stubOption())
    .action(async (options: DemoOptions) => {
      await runDemo(options);
    });

  // --- setup ----------------------------------------------------------------
  program
    .command('setup')
    .description('Discover leagues, select a completed Simulation draft and normalize its picks')
    .option('--force', 'ignore every cache and re-fetch from Sleeper')
    .action(async (options: RunSetupOptions) => {
      await runSetup(options);
    });

  // --- simulate -------------------------------------------------------------
  program
    .command('simulate')
    .description('Replay stored Picks from the Simulation draft through the full pipeline')
    .addHelpText(
      'after',
      '\nExamples:\n' +
        '  npm run lounge -- simulate --next\n' +
        '  npm run lounge -- simulate --pick 74            Kyle Pitts\n' +
        '  npm run lounge -- simulate --all --limit 5 --stub\n' +
        '  npm run lounge -- simulate --next --alias       map slots onto hotelkit managers\n',
    )
    .option('--next', 'process the next pick after state.lastProcessedPickNo (the default)')
    .option('--pick <n>', 'process one specific overall pick number', parseIntOption)
    .option('--all', 'process every pick that has no Reaction yet, sharing one browser')
    .option('--limit <n>', 'with --all, stop after this many picks', parseIntOption)
    .option('--alias', 'apply the Manager Alias overlay onto target-league managers')
    .option('--no-render', 'generate and persist the Reaction, but render nothing')
    .addOption(formatOption())
    .option('--open', 'open each rendered file')
    .addOption(stubOption())
    .action(async (options: SimulateOptions) => {
      await runSimulate(options);
    });

  // --- react ----------------------------------------------------------------
  program
    .command('react')
    .description('Re-render an existing Reaction in another format — never calls the Director')
    .addHelpText(
      'after',
      '\nExamples:\n' +
        '  npm run lounge -- react --latest --format mp4\n' +
        '  npm run lounge -- react --pick 74 --format gif\n',
    )
    .option('--latest', 'use the most recent Reaction (the default)')
    .option('--pick <n>', 'use the Reaction for a specific overall pick number', parseIntOption)
    .addOption(formatOption())
    .option('--out <file>', 'write to this path instead of output/{eventId}.{ext}')
    .option('--open', 'open the rendered file')
    .action(async (options: ReactOptions) => {
      await runReact(options);
    });

  // --- screenshot -----------------------------------------------------------
  program
    .command('screenshot')
    .description('Render an existing Reaction as a PNG — `react --format png`')
    .option('--latest', 'use the most recent Reaction (the default)')
    .option('--pick <n>', 'use the Reaction for a specific overall pick number', parseIntOption)
    .option('--out <file>', 'write to this path instead of output/{eventId}.png')
    .option('--open', 'open the rendered file')
    .action(async (options: ScreenshotOptions) => {
      await runScreenshot(options);
    });

  // --- board ----------------------------------------------------------------
  program
    .command('board')
    .description('Build the desktop draft board — every pick beside the whole Lounge transcript')
    .addHelpText(
      'after',
      '\nBoards the live draft once `watch` has recorded one, otherwise the Simulation.\n' +
        'The summary line says which. Without --refresh it is a still page: rebuild it to\n' +
        'see new picks. With --refresh, and `watch --board` rewriting the file underneath,\n' +
        'a browser left open on it keeps itself current.\n\n' +
        'Writes output/board.html plus a headshots/ folder it references — keep the\n' +
        'two together. No server and no network, but not a single file: each photo is\n' +
        'stored once and shared across every scene, which keeps a full board small.\n' +
        'Every pick is listed; the ones that have a Reaction jump the transcript to\n' +
        'that scene when clicked, and it can be replayed on the same beats the MP4\n' +
        'uses. This never calls the Director and never re-renders an export.\n\n' +
        'Examples:\n' +
        '  npm run lounge -- board --open\n' +
        '  npm run lounge -- board --limit 60          the last 60 picks only\n' +
        '  npm run lounge -- board --out /tmp/draft.html\n',
    )
    .option('--picks <file>', 'board this picks file instead of the auto-detected draft')
    .option(
      '--refresh <sec>',
      'make the page reload itself every N seconds (min 10); pair with `watch --board`',
      parseIntOption,
    )
    .option('--limit <n>', 'show only the last N picks', parseIntOption)
    .option('--out <file>', 'write to this path instead of output/board.html')
    .option('--open', 'open the built board')
    .action(async (options: BoardOptions) => {
      await runBoard(options);
    });

  // --- watch ----------------------------------------------------------------
  program
    .command('watch')
    .description('Poll the live slow draft and process new Picks as they land')
    .addHelpText(
      'after',
      '\nPicks carry no timestamp, so new picks are ordered by pick number and deduped by\n' +
        'eventId. A pre-draft league is not an error — the watcher waits.\n\n' +
        'Examples:\n' +
        '  npm run lounge -- watch\n' +
        '  npm run lounge -- watch --once --stub      one poll, then exit\n' +
        '  npm run lounge -- watch --league 1389387602825576448\n' +
        '  npm run lounge -- watch --sync            hand the draft between machines\n' +
        '  npm run lounge -- watch --board --sync    live board, portable between machines\n\n' +
        '--sync commits and pushes data/lounge after every pick and pulls before it starts,\n' +
        'so you can stop on one machine and resume on another. Run it on BOTH machines and\n' +
        'only ever one at a time: the transcripts are append-only, so two live watchers\n' +
        'conflict. Rendered files live in output/ and are gitignored — they do not travel.\n\n' +
        '--board rewrites output/board.html after every pick, and the page it writes\n' +
        'reloads itself, so a browser left open on it stays current.\n',
    )
    .option('--league <id>', 'watch this league instead of the configured target league')
    .option(
      '--interval <sec>',
      'poll interval in seconds',
      parseIntOption,
      DEFAULT_INTERVAL_SECONDS,
    )
    .option('--once', 'poll a single time and exit')
    .option('--no-render', 'generate and persist Reactions, but render nothing')
    .option(
      '--sync',
      'pull data/lounge before starting and commit+push it after every pick, so a multi-day draft can move between machines (one at a time)',
    )
    .option('--board', 'rebuild output/board.html after every pick, as a live view')
    .option(
      '--board-refresh <sec>',
      'how often the live board reloads itself (min 10)',
      parseIntOption,
      DEFAULT_BOARD_REFRESH_SECONDS,
    )
    .addOption(formatOption())
    .addOption(stubOption())
    .action(async (options: WatchOptions) => {
      await runWatch(options);
    });

  // --- history --------------------------------------------------------------
  const history = program.command('history').description('Fantasy Memory maintenance');

  history
    .command('import')
    .description('Import 2025 roster history and championship rosters from Sleeper')
    .addHelpText(
      'after',
      '\nWithout flags this imports the Simulation league chain, because that is the\n' +
        'league with real history. --target switches to hotelkit Fantasies.\n\n' +
        'Examples:\n' +
        '  npm run lounge -- history import\n' +
        '  npm run lounge -- history import --target\n' +
        '  npm run lounge -- history import --league 1250143800488120320\n',
    )
    .option('--league <id>', 'import this league chain directly, skipping discovery')
    .option('--target', 'import the configured target league instead of the Simulation league')
    .action(async (options: HistoryImportOptions) => {
      await runHistoryImport(options);
    });

  for (const command of allCommands(program)) command.addOption(verboseOption());

  return program;
}

export async function main(argv: string[] = process.argv): Promise<void> {
  await buildProgram().parseAsync(argv);
}

const entry = process.argv[1];
const invokedDirectly = entry !== undefined && import.meta.url === pathToFileURL(entry).href;

if (invokedDirectly) {
  main().catch((error: unknown) => {
    log.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
