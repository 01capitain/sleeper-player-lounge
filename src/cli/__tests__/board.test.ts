/**
 * `lounge board`.
 *
 * The command is deliberately the thinnest thing in `src/cli/commands`: it
 * resolves an output path, resolves the model once, hands both to the builder
 * and prints. So these tests inject the builder and assert on the seam —
 * nothing here writes a real 4MB page, launches chromium, or reads `data/`.
 *
 * The one behaviour worth guarding hard is the summary: it must be counted
 * from the model that was actually written, so `board` can never claim scenes
 * the page does not contain.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { exportCommandFor, type BuildBoardOptions } from '../../render/desktop.js';
import type { Pick, Reaction } from '../../types.js';
import { buildProgram } from '../index.js';
import { DEFAULT_BOARD_FILE, buildPlayerMeta, runBoard } from '../commands/board.js';
import { makePick } from './harness.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lounge-board-cli-'));
  dirs.push(dir);
  return dir;
}

const PICKS: Pick[] = [
  makePick({ pickNo: 1, playerId: '9221', playerName: 'Jahmyr Gibbs', round: 1, draftSlot: 1 }),
  makePick({ pickNo: 2, playerId: '9509', playerName: 'Bijan Robinson', round: 1, draftSlot: 2 }),
  makePick({ pickNo: 74, playerId: '7553', playerName: 'Kyle Pitts', round: 6, draftSlot: 4 }),
];

const REACTION: Reaction = {
  eventId: (PICKS[2] as Pick).eventId,
  pick: {
    season: 2026,
    pickNo: 74,
    round: 6,
    playerId: '7553',
    playerName: 'Kyle Pitts',
    managerName: 'The Isotones',
  },
  reactions: [
    {
      speakerPlayerId: '7553',
      speakerName: 'Kyle Pitts',
      text: 'Round six. Sure.',
      delayMs: 0,
      reason: 'drafted_player',
    },
  ],
};

/** A builder that records what it was asked for and writes nothing. */
function recorder() {
  const calls: { outPath: string; opts: BuildBoardOptions }[] = [];
  return {
    calls,
    render: async (outPath: string, opts: BuildBoardOptions) => {
      calls.push({ outPath, opts });
      return outPath;
    },
  };
}

function deps(extra: Partial<Parameters<typeof runBoard>[1]> = {}) {
  const lines: string[] = [];
  const stub = recorder();
  return {
    lines,
    stub,
    deps: {
      build: {
        picks: PICKS,
        reactions: [REACTION],
        draft: null,
        headshotOptions: { download: false },
      } satisfies BuildBoardOptions,
      players: {},
      render: stub.render,
      stdout: (line: string) => lines.push(line),
      open: () => undefined,
      ...extra,
    },
  };
}

// ---------------------------------------------------------------------------

describe('runBoard', () => {
  it('defaults to output/board.html and prints the path last', async () => {
    const { lines, stub, deps: d } = deps();
    const result = await runBoard({}, d);

    expect(result.outputPath).toBe(DEFAULT_BOARD_FILE);
    expect(stub.calls[0]?.outPath).toBe(DEFAULT_BOARD_FILE);
    // stdout is content: the path is the last line, so `| tail -1` works.
    expect(lines[lines.length - 1]).toBe(DEFAULT_BOARD_FILE);
  });

  it('reports the pick and scene counts of the page it actually wrote', async () => {
    const { lines, deps: d } = deps();
    const result = await runBoard({}, d);

    expect(result).toMatchObject({ pickCount: 3, sceneCount: 1 });
    expect(lines[0]).toBe('board: 3 picks · 1 Lounge scene');
  });

  it('says what to run when nothing has been directed yet', async () => {
    const { lines, deps: d } = deps();
    d.build = { ...d.build, reactions: [] };
    const result = await runBoard({}, d);

    expect(result.sceneCount).toBe(0);
    expect(lines[0]).toBe('board: 3 picks · 0 Lounge scenes');
    expect(lines[1]).toContain('simulate --next');
  });

  it('hands the builder one resolved model, so the summary cannot drift', async () => {
    const { stub, deps: d } = deps();
    await runBoard({}, d);
    const model = stub.calls[0]?.opts.model;
    expect(model?.rows).toHaveLength(3);
    expect(model?.scenes).toHaveLength(1);
    expect(model?.scenes[0]?.exportCommand).toBe(exportCommandFor(74));
  });

  it('passes --limit through to the builder', async () => {
    const { stub, deps: d } = deps();
    const result = await runBoard({ limit: 2 }, d);
    expect(stub.calls[0]?.opts.limit).toBe(2);
    // The Reaction for pick 74 survives; picks 1 and 2 fall off the board.
    expect(result.pickCount).toBe(2);
    expect(result.sceneCount).toBe(1);
  });

  it('rejects a --limit that cannot mean anything', async () => {
    const { deps: d } = deps();
    await expect(runBoard({ limit: 0 }, d)).rejects.toThrow(/--limit must be a positive/);
    await expect(runBoard({ limit: -3 }, d)).rejects.toThrow(/--limit must be a positive/);
  });

  it('resolves --out to an absolute path', async () => {
    const dir = await tempDir();
    const { deps: d } = deps();
    const target = path.join(dir, 'draft.html');
    const result = await runBoard({ out: target }, d);
    expect(result.outputPath).toBe(target);
    expect(path.isAbsolute(result.outputPath)).toBe(true);
  });

  it('opens the file only when asked, and never during a plain build', async () => {
    const opened: string[] = [];
    const { deps: d } = deps({ open: (file: string) => opened.push(file) });
    await runBoard({}, d);
    expect(opened).toEqual([]);
    await runBoard({ open: true }, d);
    expect(opened).toEqual([DEFAULT_BOARD_FILE]);
  });

  it('really does write a self-contained file end to end', async () => {
    const dir = await tempDir();
    const target = path.join(dir, 'board.html');
    const { deps: d } = deps();
    const { render: _ignored, ...rest } = d;
    await runBoard({ out: target }, rest);

    const html = await fs.readFile(target, 'utf8');
    expect(html).not.toMatch(/<link[^>]+stylesheet/);
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).toContain('Kyle Pitts');
    expect(html).toContain(exportCommandFor(74));
  });
});

describe('buildPlayerMeta', () => {
  it('maps the whole dataset, since the card colours key off the team chip', () => {
    const meta = buildPlayerMeta({
      '7553': { player_id: '7553', position: 'TE', team: 'ATL' },
      '96': { player_id: '96', position: 'QB', team: null },
    });
    expect(meta['7553']).toEqual({ position: 'TE', nflTeam: 'ATL' });
    expect(meta['96']).toEqual({ position: 'QB', nflTeam: null });
  });
});

describe('the `board` command surface', () => {
  const board = () => {
    const found = buildProgram().commands.find((cmd) => cmd.name() === 'board');
    if (!found) throw new Error("no 'board' command is registered");
    return found;
  };

  it('is registered alongside the other commands', () => {
    expect(board().description()).toContain('desktop draft board');
  });

  it('offers --limit, --out and --open, and nothing mandatory', () => {
    const cmd = board();
    expect(cmd.options.map((option) => option.long)).toEqual(
      expect.arrayContaining(['--limit', '--out', '--open', '--verbose']),
    );
    // Zero arguments must be a valid invocation.
    expect(cmd.registeredArguments).toHaveLength(0);
    expect(cmd.options.every((option) => !option.mandatory)).toBe(true);
  });

  it('describes each flag the way the README does', () => {
    const help = board().helpInformation();
    expect(help).toContain('show only the last N picks');
    expect(help).toContain('output/board.html');
    expect(help).toContain('open the built board');
  });
});
