/**
 * Which draft the board renders.
 *
 * The bug this pins: `lounge board` used to always read the Simulation picks
 * file. During a live draft that produces a board of the wrong 238 picks whose
 * eventIds match none of the live Reactions — 0 scenes, forever, with no error.
 * `lounge watch` now records the live draft to `data/lounge/picks.jsonl`, and
 * the board prefers it whenever it exists.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { livePicksFile, simulationPicksFile } from '../../paths.js';
import { pollOnce } from '../../watch/poller.js';
import { resolvePickSource, runBoard } from '../commands/board.js';
import { cleanWorkspaces, makePick, workspace, DRAFT_ID, LEAGUE_ID } from './harness.js';

afterEach(async () => {
  await cleanWorkspaces();
  vi.restoreAllMocks();
});

describe('resolvePickSource', () => {
  it('uses an explicit --picks file over anything else', async () => {
    const source = await resolvePickSource('/tmp/somewhere/picks.jsonl');
    expect(source).toEqual({ label: 'explicit', file: path.resolve('/tmp/somewhere/picks.jsonl') });
  });

  it('falls back to the Simulation when no live draft has been recorded', async () => {
    // The repo's committed state: a Simulation draft, no live picks yet.
    const source = await resolvePickSource();
    expect(source.label).toBe('simulation');
    expect(source.file).toBe(simulationPicksFile);
  });
});

describe('the board reports which draft it drew', () => {
  it('names the source on the summary line, so the wrong draft is never silent', async () => {
    const lines: string[] = [];
    await runBoard(
      {},
      {
        players: {},
        stdout: (line) => lines.push(line),
        render: (outPath) => Promise.resolve(outPath),
      },
    );

    expect(lines[0]).toMatch(/· simulation draft$/);
  });
});

describe('the watcher records the live draft for the board', () => {
  it('writes every pick it saw, not only the new ones', async () => {
    const ws = await workspace();
    const recorded: (readonly unknown[])[] = [];

    const rawPicks = [1, 2, 3].map((pickNo) => ({
      pick_no: pickNo,
      round: 1,
      draft_slot: pickNo,
      player_id: `${1000 + pickNo}`,
      picked_by: 'u-1',
      metadata: { first_name: 'Player', last_name: `${pickNo}`, position: 'RB', team: 'KC' },
    }));

    await pollOnce({
      client: {
        getDraft: () => Promise.resolve({ status: 'drafting', draft_order: null }) as never,
        getDraftPicks: () => Promise.resolve(rawPicks) as never,
        getLeagueUsers: () => Promise.resolve([{ user_id: 'u-1', display_name: 'Skunk' }]) as never,
      },
      target: {
        leagueId: LEAGUE_ID,
        leagueName: 'hotelkit Fantasies',
        draftId: DRAFT_ID,
        season: 2026,
      },
      // Two already done: the board still needs all three rows.
      lastProcessedPickNo: 2,
      persist: ws.persist,
      process: () => Promise.resolve({ pick: makePick(), reaction: null, outputPath: null } as never),
      recordPicks: (picks) => {
        recorded.push(picks);
        return Promise.resolve();
      },
    });

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.map((pick) => (pick as { pickNo: number }).pickNo)).toEqual([1, 2, 3]);
  });

  it('records nothing while the draft is still pre_draft', async () => {
    const recordPicks = vi.fn(() => Promise.resolve());

    const result = await pollOnce({
      client: {
        getDraft: () => Promise.resolve({ status: 'pre_draft' }) as never,
        getDraftPicks: () => Promise.resolve([]) as never,
        getLeagueUsers: () => Promise.resolve([]) as never,
      },
      target: {
        leagueId: LEAGUE_ID,
        leagueName: 'hotelkit Fantasies',
        draftId: DRAFT_ID,
        season: 2026,
      },
      lastProcessedPickNo: 0,
      process: () => Promise.resolve({} as never),
      recordPicks,
    });

    expect(result.started).toBe(false);
    expect(recordPicks).not.toHaveBeenCalled();
  });

  it('keeps drafting when the board file cannot be written', async () => {
    const ws = await workspace();
    const processed: number[] = [];

    const result = await pollOnce({
      client: {
        getDraft: () => Promise.resolve({ status: 'drafting', draft_order: null }) as never,
        getDraftPicks: () =>
          Promise.resolve([
            {
              pick_no: 1,
              round: 1,
              draft_slot: 1,
              player_id: '1001',
              picked_by: 'u-1',
              metadata: { first_name: 'A', last_name: 'B', position: 'RB', team: 'KC' },
            },
          ]) as never,
        getLeagueUsers: () => Promise.resolve([{ user_id: 'u-1', display_name: 'Skunk' }]) as never,
      },
      target: {
        leagueId: LEAGUE_ID,
        leagueName: 'hotelkit Fantasies',
        draftId: DRAFT_ID,
        season: 2026,
      },
      lastProcessedPickNo: 0,
      persist: ws.persist,
      process: (pick) => {
        processed.push(pick.pickNo);
        return Promise.resolve({ pick, reaction: null, outputPath: null } as never);
      },
      recordPicks: () => Promise.reject(new Error('disk full')),
    });

    // The board is a viewing surface. Losing it must not lose the draft.
    expect(processed).toEqual([1]);
    expect(result.newPicks).toHaveLength(1);
  });
});

describe('the live picks file lives inside the --sync pathspec', () => {
  it('is under data/lounge, so a handoff carries the board too', () => {
    expect(livePicksFile.includes(`${path.sep}data${path.sep}lounge${path.sep}`)).toBe(true);
  });

  it('is not the Simulation picks file', async () => {
    expect(livePicksFile).not.toBe(simulationPicksFile);
    // And it genuinely is absent right now, which is why the board says "simulation".
    await expect(fs.access(livePicksFile)).rejects.toThrow();
  });
});
