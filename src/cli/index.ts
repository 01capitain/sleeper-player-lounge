#!/usr/bin/env node
/**
 * `lounge` CLI — the command surface from implementation_plan.md §12.
 *
 * This file only wires commander to handlers and keeps stdout clean (all
 * diagnostics go through the logger to stderr). Every handler below is a stub
 * that throws; the setup, simulate, react, screenshot, watch and history-import
 * implementations replace the bodies without touching the wiring.
 */
import { pathToFileURL } from 'node:url';

import { Command, InvalidArgumentError } from 'commander';

import { log } from '../util/log.js';

// ---------------------------------------------------------------------------
// Option shapes — the contracts the real handlers will receive.
// ---------------------------------------------------------------------------

export interface SetupOptions {
  [key: string]: unknown;
}

export interface SimulateOptions {
  /** Process only the next unprocessed Pick. */
  next?: boolean;
  /** Process one specific overall pick number. */
  pick?: number;
  /** Replay the entire stored draft. */
  all?: boolean;
  /** Apply the Manager Alias overlay for this target league. */
  alias?: string;
  /** `--no-render` sets this to false. */
  render: boolean;
  format?: string;
}

export interface ReactOptions {
  latest?: boolean;
  pick?: number;
  format?: string;
}

export interface ScreenshotOptions {
  latest?: boolean;
  pick?: number;
}

export interface WatchOptions {
  /** Poll interval in seconds. */
  interval: number;
  /** `--no-render` sets this to false. */
  render: boolean;
  format?: string;
}

export interface HistoryImportOptions {
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Handlers — stubs, one per command.
// ---------------------------------------------------------------------------

export async function runSetup(_options: SetupOptions): Promise<void> {
  throw new Error('not implemented: setup');
}

export async function runSimulate(_options: SimulateOptions): Promise<void> {
  throw new Error('not implemented: simulate');
}

export async function runReact(_options: ReactOptions): Promise<void> {
  throw new Error('not implemented: react');
}

export async function runScreenshot(_options: ScreenshotOptions): Promise<void> {
  throw new Error('not implemented: screenshot');
}

export async function runWatch(_options: WatchOptions): Promise<void> {
  throw new Error('not implemented: watch');
}

export async function runHistoryImport(_options: HistoryImportOptions): Promise<void> {
  throw new Error('not implemented: history import');
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function parseIntOption(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new InvalidArgumentError(`expected an integer, got '${value}'`);
  }
  return parsed;
}

/** Build the commander program. Exported so tests can inspect the surface. */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name('lounge')
    .description('Players Lounge — turn Sleeper draft picks into fictional group-chat scenes')
    .showHelpAfterError();

  program
    .command('setup')
    .description('Discover leagues, auto-select a completed Simulation draft and normalize its picks')
    .action(async (options: SetupOptions) => {
      await runSetup(options);
    });

  program
    .command('simulate')
    .description('Replay stored Picks from the selected Simulation draft')
    .option('--next', 'process the next unprocessed pick')
    .option('--pick <n>', 'process one specific overall pick number', parseIntOption)
    .option('--all', 'replay every stored pick')
    .option('--alias <league>', 'apply the Manager Alias overlay for a target league')
    .option('--no-render', 'skip rendering; only generate and persist the Reaction')
    .option('--format <fmt>', 'output format: png | gif | mp4')
    .action(async (options: SimulateOptions) => {
      await runSimulate(options);
    });

  program
    .command('react')
    .description('Render an asset for an existing Reaction')
    .option('--latest', 'use the most recent Reaction')
    .option('--pick <n>', 'use the Reaction for a specific overall pick number', parseIntOption)
    .option('--format <fmt>', 'output format: png | gif | mp4')
    .action(async (options: ReactOptions) => {
      await runReact(options);
    });

  program
    .command('screenshot')
    .description('Render a static PNG of a Reaction')
    .option('--latest', 'use the most recent Reaction')
    .option('--pick <n>', 'use the Reaction for a specific overall pick number', parseIntOption)
    .action(async (options: ScreenshotOptions) => {
      await runScreenshot(options);
    });

  program
    .command('watch')
    .description('Poll the live slow draft and process new Picks as they land')
    .option('--interval <sec>', 'poll interval in seconds', parseIntOption, 25)
    .option('--no-render', 'skip rendering; only generate and persist Reactions')
    .option('--format <fmt>', 'output format: png | gif | mp4')
    .action(async (options: WatchOptions) => {
      await runWatch(options);
    });

  const history = program
    .command('history')
    .description('Fantasy Memory maintenance');

  history
    .command('import')
    .description('Import 2025 roster history and championship rosters from Sleeper')
    .action(async (options: HistoryImportOptions) => {
      await runHistoryImport(options);
    });

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
