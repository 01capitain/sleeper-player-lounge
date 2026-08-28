/**
 * `lounge board` — build the desktop draft board and print its path.
 *
 * The board is a *viewing* surface, not an export. It never calls the
 * Director, never launches chromium and never touches the PNG/MP4 pipeline:
 * it reads the Picks and the Reactions that are already on disk and writes one
 * self-contained HTML file you can open, move or share. Because it only reads,
 * running it twice is free and running it mid-draft is safe.
 *
 * What it prints is deliberately the same shape the other commands print:
 * a summary line, then the path, last, so `npm run lounge -- board | tail -1`
 * is a usable way to get it.
 */
import path from 'node:path';

import { loadEnrichedPlayers, openFile } from '../pipeline.js';
import type { PlayerIndex } from '../../import/players.js';
import { outputDir } from '../../paths.js';
import {
  buildBoardModel,
  renderBoardHtml,
  type BuildBoardOptions,
} from '../../render/desktop.js';
import type { PlayerChipMeta } from '../../render/payload.js';
import type { SleeperPlayer } from '../../types.js';

/** The default output path — `output/` is gitignored. */
export const DEFAULT_BOARD_FILE = path.join(outputDir, 'board.html');

export interface BoardOptions {
  /** Show only the last N Picks. */
  limit?: number;
  /** Write here instead of `output/board.html`. */
  out?: string;
  /** Open the built file with the platform opener. */
  open?: boolean;
}

export interface BoardDeps {
  /** Extra builder options; tests inject picks, reactions and ADP here. */
  build?: BuildBoardOptions;
  /** ADP-enriched players dataset, for the chat's team/position chips. */
  players?: PlayerIndex;
  /** Injected renderer, so a test never has to write a real file. */
  render?: (outPath: string, opts: BuildBoardOptions) => Promise<string>;
  stdout?: (line: string) => void;
  /** Injected opener, so a test never spawns a window. */
  open?: (filePath: string) => void;
}

export interface BoardResult {
  outputPath: string;
  /** Picks on the board. */
  pickCount: number;
  /** Picks that have a stored Reaction, and therefore a scene. */
  sceneCount: number;
}

export async function runBoard(
  opts: BoardOptions = {},
  deps: BoardDeps = {},
): Promise<BoardResult> {
  const out = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const draw = deps.render ?? renderBoardHtml;
  const outPath = path.resolve(opts.out ?? DEFAULT_BOARD_FILE);

  const build: BuildBoardOptions = { ...(deps.build ?? {}) };
  if (typeof opts.limit === 'number') {
    if (!Number.isFinite(opts.limit) || opts.limit < 1) {
      throw new Error(`--limit must be a positive whole number, got '${opts.limit}'.`);
    }
    build.limit = Math.trunc(opts.limit);
  }
  if (build.playerMeta === undefined) {
    const players = deps.players ?? (await loadEnrichedPlayers());
    build.playerMeta = buildPlayerMeta(players);
  }

  // Headshots are copied into `<outDir>/headshots/` and referenced relatively,
  // so the model has to know where the page will land. `renderBoardHtml` fills
  // this in by default, but we build the model ourselves below and would
  // otherwise hand it a model whose avatars had already fallen back to
  // monograms.
  if (build.assetDir === undefined) build.assetDir = path.dirname(outPath);

  // Resolve the model once and hand it to the builder, so the summary below
  // is counted from exactly the page that was written — not a second read of
  // files a concurrent `simulate` may have appended to in between.
  const model = await buildBoardModel(build);
  const written = await draw(outPath, { ...build, model });

  const pickCount = model.rows.length;
  const sceneCount = model.scenes.length;
  out(
    `board: ${pickCount} pick${pickCount === 1 ? '' : 's'} · ` +
      `${sceneCount} Lounge scene${sceneCount === 1 ? '' : 's'}`,
  );
  if (sceneCount === 0) {
    out('  no Reactions yet — direct one with `npm run lounge -- simulate --next`');
  }
  out(written);

  if (opts.open === true) (deps.open ?? openFile)(written);

  return { outputPath: written, pickCount, sceneCount };
}

/**
 * `playerId -> { position, nflTeam }` for the whole dataset.
 *
 * The chat's team/position chip is what keys the announcement card's team
 * colours (`teamAbbrev` in templates/render.js), so a board built without this
 * would silently fall back to the house accent for every pick.
 */
export function buildPlayerMeta(
  players: Readonly<Record<string, SleeperPlayer>>,
): Record<string, PlayerChipMeta> {
  const meta: Record<string, PlayerChipMeta> = {};
  for (const [playerId, player] of Object.entries(players)) {
    if (!player) continue;
    meta[playerId] = { position: player.position ?? null, nflTeam: player.team ?? null };
  }
  return meta;
}

export default runBoard;
