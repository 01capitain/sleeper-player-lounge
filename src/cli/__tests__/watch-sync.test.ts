/**
 * `lounge watch --sync` — the wiring that makes a multi-day draft portable.
 *
 * The sync module itself is tested in `src/watch/__tests__/sync.test.ts`. What
 * matters here is the two ordering guarantees the watcher is responsible for,
 * both of which are invisible in the git argv:
 *
 *  - the pull happens BEFORE the high-water mark is read, or the watcher drafts
 *    over picks the other machine already made;
 *  - the publish happens AFTER the Reaction is persisted, or the other machine
 *    inherits a state file that is ahead of its own transcript.
 *
 * Nothing here touches git, the network, or the real `data/` directory.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SyncResult } from '../../watch/sync.js';
import { runWatch, type LoungeSync } from '../commands/watch.js';
import type { ProcessPickResult } from '../pipeline.js';
import { cleanWorkspaces, makePick, workspace, DRAFT_ID, LEAGUE_ID } from './harness.js';

afterEach(cleanWorkspaces);

const target = {
  leagueId: LEAGUE_ID,
  leagueName: 'hotelkit Fantasies',
  draftId: DRAFT_ID,
  season: 2026,
};

const ok = (detail: string): SyncResult => ({ ok: true, noop: false, detail });

/** A Sleeper stand-in serving a draft that has made `count` picks. */
function draftWith(count: number): {
  getDraft: () => Promise<{ status: string; draft_order: null }>;
  getDraftPicks: () => Promise<unknown[]>;
  getLeagueUsers: () => Promise<unknown[]>;
} {
  const picks = Array.from({ length: count }, (_, index) => ({
    pick_no: index + 1,
    round: 1,
    draft_slot: index + 1,
    player_id: `${1000 + index}`,
    picked_by: 'u-1',
    metadata: { first_name: 'Player', last_name: `${index + 1}`, position: 'RB', team: 'KC' },
  }));
  return {
    getDraft: () => Promise.resolve({ status: 'drafting', draft_order: null }),
    getDraftPicks: () => Promise.resolve(picks),
    getLeagueUsers: () => Promise.resolve([{ user_id: 'u-1', display_name: 'Skunk Works' }]),
  };
}

/** Records the order in which sync and pick-processing happened. */
function tracingSync(order: string[]): LoungeSync {
  return {
    pull: () => {
      order.push('pull');
      return Promise.resolve(ok('already up to date'));
    },
    publish: (label) => {
      order.push(`publish ${label.split(' ')[0]}`);
      return Promise.resolve(ok('pushed'));
    },
  };
}

const noResult = (): Promise<ProcessPickResult> =>
  Promise.resolve({ pick: makePick(), reaction: null, outputPath: null } as ProcessPickResult);

describe('--sync ordering', () => {
  it('pulls before the first pick is ever looked at', async () => {
    const ws = await workspace();
    const order: string[] = [];

    await runWatch(
      { once: true, render: false, stub: true },
      {
        client: draftWith(1) as never,
        target,
        players: {},
        persist: ws.persist,
        sync: tracingSync(order),
        processPick: (pick) => {
          order.push(`process #${pick.pickNo}`);
          return noResult();
        },
        stdout: () => undefined,
      },
    );

    expect(order[0]).toBe('pull');
  });

  it('publishes after each pick is processed, one commit per pick', async () => {
    const ws = await workspace();
    const order: string[] = [];

    await runWatch(
      { once: true, render: false, stub: true },
      {
        client: draftWith(3) as never,
        target,
        players: {},
        persist: ws.persist,
        sync: tracingSync(order),
        processPick: (pick) => {
          order.push(`process #${pick.pickNo}`);
          return noResult();
        },
        stdout: () => undefined,
      },
    );

    // A catch-up burst still publishes pick by pick, so an interrupted burst
    // leaves the other machine with everything that actually completed.
    expect(order).toEqual([
      'pull',
      'process #1',
      'publish #1',
      'process #2',
      'publish #2',
      'process #3',
      'publish #3',
    ]);
  });

  it('does not publish when a poll found nothing new', async () => {
    const ws = await workspace();
    const publish = vi.fn(() => Promise.resolve(ok('pushed')));

    await runWatch(
      { once: true, render: false, stub: true },
      {
        client: draftWith(0) as never,
        target,
        players: {},
        persist: ws.persist,
        sync: { pull: () => Promise.resolve(ok('up to date')), publish },
        processPick: noResult,
        stdout: () => undefined,
      },
    );

    expect(publish).not.toHaveBeenCalled();
  });
});

describe('--sync failure handling', () => {
  it('refuses to start when the pull fails, rather than drafting over the gap', async () => {
    const ws = await workspace();
    const processPick = vi.fn(noResult);

    await expect(
      runWatch(
        { once: true, render: false, stub: true },
        {
          client: draftWith(2) as never,
          target,
          players: {},
          persist: ws.persist,
          sync: {
            pull: () =>
              Promise.resolve({ ok: false, noop: false, detail: 'CONFLICT in state.json' }),
            publish: () => Promise.resolve(ok('pushed')),
          },
          processPick,
          stdout: () => undefined,
        },
      ),
    ).rejects.toThrow(/could not pull the Lounge forward/);

    expect(processPick).not.toHaveBeenCalled();
  });

  it('keeps drafting when a publish fails — the Reaction is already on disk', async () => {
    const ws = await workspace();
    const processed: number[] = [];

    const summary = await runWatch(
      { once: true, render: false, stub: true },
      {
        client: draftWith(3) as never,
        target,
        players: {},
        persist: ws.persist,
        sync: {
          pull: () => Promise.resolve(ok('up to date')),
          publish: () => Promise.resolve({ ok: false, noop: false, detail: 'push rejected' }),
        },
        processPick: (pick) => {
          processed.push(pick.pickNo);
          return noResult();
        },
        stdout: () => undefined,
      },
    );

    expect(processed).toEqual([1, 2, 3]);
    expect(summary.picksProcessed).toBe(3);
  });
});

describe('without --sync', () => {
  it('never touches git', async () => {
    const ws = await workspace();
    const pull = vi.fn(() => Promise.resolve(ok('up to date')));
    const publish = vi.fn(() => Promise.resolve(ok('pushed')));

    await runWatch(
      { once: true, render: false, stub: true },
      {
        client: draftWith(2) as never,
        target,
        players: {},
        persist: ws.persist,
        processPick: noResult,
        stdout: () => undefined,
      },
    );

    expect(pull).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
});
