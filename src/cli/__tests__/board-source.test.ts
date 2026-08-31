/**
 * Which draft the board renders.
 *
 * The bug this pins: `lounge board` used to always read the Simulation picks
 * file. During a live draft that produces a board of the wrong 238 picks whose
 * eventIds match none of the live Reactions — 0 scenes, forever, with no error.
 *
 * The second half of that bug is the one draft morning hits: keying off the
 * live *picks* file alone still boards the Simulation while the live draft sits
 * at zero picks, which is precisely the hour somebody opens the board. So
 * `lounge watch` claims its draft in `data/lounge/draft.json` before the first
 * poll, and the claim outranks both picks files.
 */
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { liveDraftFile, livePicksFile, simulationPicksFile } from '../../paths.js';
import { pollOnce, toLiveDraft } from '../../watch/poller.js';
import { resolvePickSource, runBoard } from '../commands/board.js';
import { writeJson } from '../../util/json.js';
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
    const ws = await workspace();
    const source = await resolvePickSource(undefined, {
      draftFile: path.join(ws.dir, 'draft.json'),
      livePicksFile: path.join(ws.dir, 'live.jsonl'),
      simulationPicksFile,
    });
    expect(source.label).toBe('simulation');
    expect(source.file).toBe(simulationPicksFile);
  });

  it('boards the claimed live draft even before its first pick lands', async () => {
    const ws = await workspace();
    const draftFile = path.join(ws.dir, 'draft.json');
    const live = path.join(ws.dir, 'live.jsonl');
    // Claimed, but not one pick made yet: draft morning.
    await writeJson(
      draftFile,
      toLiveDraft({ status: 'drafting', settings: { rounds: 14, teams: 8 } } as never, {
        leagueId: LEAGUE_ID,
        leagueName: 'hotelkit Fantasies',
        draftId: DRAFT_ID,
        season: 2026,
      }),
    );

    const source = await resolvePickSource(undefined, {
      draftFile,
      livePicksFile: live,
      simulationPicksFile,
    });

    expect(source).toEqual({ label: 'live', file: live });
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
        pickSource: () =>
          Promise.resolve({ label: 'simulation' as const, file: simulationPicksFile }),
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
    const recordDraft = vi.fn(() => Promise.resolve());

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
      recordDraft,
    });

    expect(result.started).toBe(false);
    expect(recordPicks).not.toHaveBeenCalled();
    // But the draft is still claimed: the board has to name the right league
    // while everyone is still waiting for pick one.
    expect(recordDraft).toHaveBeenCalledOnce();
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

describe('the live draft files live inside the --sync pathspec', () => {
  it('are under data/lounge, so a handoff carries the board too', () => {
    const loungeDir = `${path.sep}data${path.sep}lounge${path.sep}`;
    expect(livePicksFile.includes(loungeDir)).toBe(true);
    expect(liveDraftFile.includes(loungeDir)).toBe(true);
  });

  it('are not the Simulation files', () => {
    expect(livePicksFile).not.toBe(simulationPicksFile);
    expect(liveDraftFile).not.toBe(livePicksFile);
  });
});
