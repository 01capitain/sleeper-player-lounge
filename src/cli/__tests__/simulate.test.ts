/**
 * `lounge simulate`.
 *
 * The two properties worth protecting are that `--next` genuinely advances
 * (otherwise a replay loops forever on one Pick) and that `--all` launches
 * chromium once rather than 238 times.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { StubDirector } from '../../director/index.js';
import { loadState } from '../../lounge/persist.js';
import type { Pick } from '../../types.js';
import { runSimulate, selectPicks } from '../commands/simulate.js';
import { processPick, type ProcessPickOptions, type ProcessPickResult } from '../pipeline.js';
import { cleanWorkspaces, fakeBrowser, inertContextDeps, makePick, workspace } from './harness.js';

afterEach(cleanWorkspaces);

const director = new StubDirector();

function draft(count: number): Pick[] {
  return Array.from({ length: count }, (_, index) =>
    makePick({
      pickNo: index + 1,
      playerId: String(9000 + index),
      playerName: `Player ${index + 1}`,
      round: 1,
      draftSlot: index + 1,
    }),
  );
}

/** A `processPick` stand-in that records the options it was handed. */
function recorder(): {
  calls: { pick: Pick; opts: ProcessPickOptions }[];
  fn: (pick: Pick, opts: ProcessPickOptions) => Promise<ProcessPickResult>;
} {
  const calls: { pick: Pick; opts: ProcessPickOptions }[] = [];
  return {
    calls,
    fn: (pick, opts) => {
      calls.push({ pick, opts });
      return Promise.resolve({
        eventId: pick.eventId,
        pick,
        reaction: null,
        outputPath: '/tmp/out.png',
        skipped: false,
        usage: [],
      });
    },
  };
}

describe('simulate --next', () => {
  it('advances lastProcessedPickNo and moves on to the following Pick', async () => {
    const ws = await workspace();
    await ws.writePicks(draft(3));
    const deps = {
      picksFile: ws.picksFile,
      persist: ws.persist,
      director,
      stdout: () => {},
      processOptions: { contextDeps: inertContextDeps() },
    };

    await runSimulate({ next: true, render: false }, deps);
    expect((await loadState(ws.persist)).lastProcessedPickNo).toBe(1);

    await runSimulate({ next: true, render: false }, deps);
    expect((await loadState(ws.persist)).lastProcessedPickNo).toBe(2);
  });

  it('reports that there is nothing to do once the draft is exhausted', async () => {
    const ws = await workspace();
    await ws.writePicks(draft(1));
    const lines: string[] = [];
    const deps = {
      picksFile: ws.picksFile,
      persist: ws.persist,
      director,
      stdout: (line: string) => lines.push(line),
      processOptions: { contextDeps: inertContextDeps() },
    };

    await runSimulate({ next: true, render: false }, deps);
    const summary = await runSimulate({ next: true, render: false }, deps);

    expect(summary.results).toHaveLength(0);
    expect(lines.join('\n')).toContain('Nothing to do');
  });

  it('is the default when no mode flag is given', async () => {
    const ws = await workspace();
    const picks = draft(2);
    const chosen = await selectPicks(picks, {}, ws.persist);
    expect(chosen.map((pick) => pick.pickNo)).toEqual([1]);
  });
});

describe('simulate --all', () => {
  it('shares one chromium across the whole batch', async () => {
    const ws = await workspace();
    await ws.writePicks(draft(4));
    const { browser, closed } = fakeBrowser();
    let launches = 0;
    const seen = recorder();

    const summary = await runSimulate(
      { all: true },
      {
        picksFile: ws.picksFile,
        persist: ws.persist,
        processPick: seen.fn,
        launchBrowser: () => {
          launches += 1;
          return Promise.resolve(browser);
        },
        stdout: () => {},
      },
    );

    expect(launches).toBe(1);
    expect(summary.sharedBrowser).toBe(true);
    expect(seen.calls).toHaveLength(4);
    expect(seen.calls.every((call) => call.opts.browser === browser)).toBe(true);
    expect(closed()).toBe(1);
  });

  it('does not launch a browser at all with --no-render', async () => {
    const ws = await workspace();
    await ws.writePicks(draft(3));
    let launches = 0;
    const seen = recorder();

    await runSimulate(
      { all: true, render: false },
      {
        picksFile: ws.picksFile,
        persist: ws.persist,
        processPick: seen.fn,
        launchBrowser: () => {
          launches += 1;
          return Promise.resolve(fakeBrowser().browser);
        },
        stdout: () => {},
      },
    );

    expect(launches).toBe(0);
    expect(seen.calls.every((call) => call.opts.render === false)).toBe(true);
  });

  it('honours --limit and processes in ascending pick order', async () => {
    const ws = await workspace();
    await ws.writePicks(draft(10));
    const seen = recorder();

    await runSimulate(
      { all: true, limit: 3, render: false },
      { picksFile: ws.picksFile, persist: ws.persist, processPick: seen.fn, stdout: () => {} },
    );

    expect(seen.calls.map((call) => call.pick.pickNo)).toEqual([1, 2, 3]);
  });

  it('leaves out Picks that already have a Reaction', async () => {
    const ws = await workspace();
    const picks = draft(4);
    await ws.writePicks(picks);
    await processPick(picks[1] as Pick, {
      director,
      render: false,
      persist: ws.persist,
      contextDeps: inertContextDeps(),
    });

    const pending = await selectPicks(picks, { all: true }, ws.persist);
    expect(pending.map((pick) => pick.pickNo)).toEqual([1, 3, 4]);
  });
});

describe('simulate --pick', () => {
  it('processes exactly that Pick', async () => {
    const ws = await workspace();
    await ws.writePicks(draft(5));
    const seen = recorder();

    await runSimulate(
      { pick: 4, render: false },
      { picksFile: ws.picksFile, persist: ws.persist, processPick: seen.fn, stdout: () => {} },
    );

    expect(seen.calls.map((call) => call.pick.pickNo)).toEqual([4]);
  });

  it('names the available range when the Pick does not exist', async () => {
    const ws = await workspace();
    await ws.writePicks(draft(5));
    await expect(
      runSimulate({ pick: 99 }, { picksFile: ws.picksFile, persist: ws.persist, stdout: () => {} }),
    ).rejects.toThrow(/picks 1\.\.5/);
  });
});

describe('simulate with no stored Picks', () => {
  it('points at setup instead of failing obscurely', async () => {
    const ws = await workspace();
    await ws.writePicks([]);
    await expect(
      runSimulate({ next: true }, { picksFile: ws.picksFile, persist: ws.persist, stdout: () => {} }),
    ).rejects.toThrow(/lounge -- setup/);
  });
});

describe('simulate --stub', () => {
  it('passes the stub flag down to the pipeline', async () => {
    const ws = await workspace();
    await ws.writePicks(draft(1));
    const seen = recorder();
    await runSimulate(
      { next: true, stub: true, render: false },
      { picksFile: ws.picksFile, persist: ws.persist, processPick: seen.fn, stdout: () => {} },
    );
    expect(seen.calls[0]?.opts.stub).toBe(true);
  });
});
