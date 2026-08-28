/**
 * The live slow-draft poller.
 *
 * Three properties are load-bearing and all three are tested against a fake
 * Sleeper client — nothing here touches the network or the `claude` binary.
 *
 *  1. Ordering keys on `pick_no`. Picks carry no timestamp (docs/sleeper-facts.md),
 *     and Sleeper does not promise the array is sorted.
 *  2. A Pick is processed once, and that survives a restart: the high-water mark
 *     and the `eventId` check are both consulted, and neither lives in memory.
 *  3. A `pre_draft` draft is the ordinary case, not an error.
 */
import { describe, expect, it } from 'vitest';

import type { ProcessPickResult } from '../../cli/pipeline.js';
import type {
  SleeperDraft,
  SleeperDraftPick,
  SleeperLeague,
  SleeperUser,
} from '../../sleeper/types.js';
import type { AppConfig, Pick } from '../../types.js';
import {
  DEFAULT_INTERVAL_SECONDS,
  pollOnce,
  resolveWatchTarget,
  sleep,
  watchDraft,
  type DraftSource,
  type LeagueSource,
  type WatchTarget,
} from '../poller.js';

const DRAFT_ID = '1389387602825576449';
const LEAGUE_ID = '1389387602825576448';

const TARGET: WatchTarget = {
  leagueId: LEAGUE_ID,
  leagueName: 'hotelkit Fantasies',
  draftId: DRAFT_ID,
  season: 2026,
};

function draft(status: string): SleeperDraft {
  return {
    draft_id: DRAFT_ID,
    league_id: LEAGUE_ID,
    status,
    type: 'snake',
    season: '2026',
    settings: { rounds: 17, teams: 8 },
    draft_order: { 'u-1': 1, 'u-2': 2, 'u-3': 3 },
  };
}

function rawPick(pickNo: number, playerId: string): SleeperDraftPick {
  return {
    draft_id: DRAFT_ID,
    player_id: playerId,
    pick_no: pickNo,
    round: Math.ceil(pickNo / 3),
    draft_slot: ((pickNo - 1) % 3) + 1,
    picked_by: `u-${((pickNo - 1) % 3) + 1}`,
    metadata: { first_name: 'Player', last_name: String(pickNo) },
  };
}

const USERS: SleeperUser[] = [
  { user_id: 'u-1', display_name: 'one' },
  { user_id: 'u-2', display_name: 'two' },
  { user_id: 'u-3', display_name: 'three' },
];

/** A Sleeper client with no network behind it. */
function fakeClient(
  status: string,
  picks: SleeperDraftPick[],
): DraftSource & { draftReads: number } {
  const client = {
    draftReads: 0,
    getDraft: () => {
      client.draftReads += 1;
      return Promise.resolve(draft(status));
    },
    getDraftPicks: () => Promise.resolve(picks),
    getLeagueUsers: () => Promise.resolve(USERS),
  };
  return client;
}

function collector(): { seen: Pick[]; process: (pick: Pick) => Promise<ProcessPickResult> } {
  const seen: Pick[] = [];
  return {
    seen,
    process: (pick) => {
      seen.push(pick);
      return Promise.resolve({
        eventId: pick.eventId,
        pick,
        reaction: null,
        outputPath: null,
        skipped: false,
      });
    },
  };
}

describe('pollOnce ordering', () => {
  it('processes new picks in ascending pick_no even when the API returns them shuffled', async () => {
    const shuffled = [
      rawPick(3, 'c'),
      rawPick(1, 'a'),
      rawPick(5, 'e'),
      rawPick(2, 'b'),
      rawPick(4, 'd'),
    ];
    const take = collector();

    const result = await pollOnce({
      client: fakeClient('drafting', shuffled),
      target: TARGET,
      lastProcessedPickNo: 0,
      isProcessed: () => Promise.resolve(false),
      process: take.process,
    });

    expect(take.seen.map((pick) => pick.pickNo)).toEqual([1, 2, 3, 4, 5]);
    expect(result.lastProcessedPickNo).toBe(5);
    expect(result.newPicks).toHaveLength(5);
  });

  it('builds the eventId as {draftId}:{pickNo}:{playerId}', async () => {
    const take = collector();
    await pollOnce({
      client: fakeClient('drafting', [rawPick(7, '7553')]),
      target: TARGET,
      lastProcessedPickNo: 0,
      isProcessed: () => Promise.resolve(false),
      process: take.process,
    });
    expect(take.seen[0]?.eventId).toBe(`${DRAFT_ID}:7:7553`);
  });

  it('ignores picks at or below the high-water mark', async () => {
    const take = collector();
    const result = await pollOnce({
      client: fakeClient('drafting', [rawPick(1, 'a'), rawPick(2, 'b'), rawPick(3, 'c')]),
      target: TARGET,
      lastProcessedPickNo: 2,
      isProcessed: () => Promise.resolve(false),
      process: take.process,
    });
    expect(take.seen.map((pick) => pick.pickNo)).toEqual([3]);
    expect(result.totalPicks).toBe(3);
  });
});

describe('pollOnce deduplication', () => {
  it('never processes the same pick twice across repeated polls', async () => {
    const client = fakeClient('drafting', [rawPick(1, 'a'), rawPick(2, 'b')]);
    const take = collector();
    const done = new Set<string>();

    let mark = 0;
    for (let poll = 0; poll < 3; poll += 1) {
      const result = await pollOnce({
        client,
        target: TARGET,
        lastProcessedPickNo: mark,
        isProcessed: (eventId) => Promise.resolve(done.has(eventId)),
        process: async (pick) => {
          done.add(pick.eventId);
          return take.process(pick);
        },
      });
      mark = result.lastProcessedPickNo;
    }

    expect(take.seen.map((pick) => pick.pickNo)).toEqual([1, 2]);
  });

  it('never re-processes across a restart — the eventId check alone is enough', async () => {
    const client = fakeClient('drafting', [rawPick(1, 'a'), rawPick(2, 'b'), rawPick(3, 'c')]);
    const take = collector();
    // A fresh process: nothing in memory, and the high-water mark was lost.
    // The durable record is the reactions log, reached through `isProcessed`.
    const alreadyOnDisk = new Set([`${DRAFT_ID}:1:a`, `${DRAFT_ID}:2:b`]);

    const result = await pollOnce({
      client,
      target: TARGET,
      lastProcessedPickNo: 0,
      isProcessed: (eventId) => Promise.resolve(alreadyOnDisk.has(eventId)),
      process: take.process,
    });

    expect(take.seen.map((pick) => pick.pickNo)).toEqual([3]);
    expect(result.duplicates).toBe(2);
    // The mark still advances past the picks that were already done.
    expect(result.lastProcessedPickNo).toBe(3);
  });
});

describe('pollOnce before the draft starts', () => {
  it('treats pre_draft as a quiet no-op, not an error', async () => {
    const take = collector();
    const result = await pollOnce({
      client: fakeClient('pre_draft', [rawPick(1, 'a')]),
      target: TARGET,
      lastProcessedPickNo: 0,
      isProcessed: () => Promise.resolve(false),
      process: take.process,
    });

    expect(result.started).toBe(false);
    expect(result.status).toBe('pre_draft');
    expect(result.newPicks).toEqual([]);
    expect(take.seen).toEqual([]);
  });

  it('picks the draft up as soon as it flips to drafting', async () => {
    let status = 'pre_draft';
    const client: DraftSource = {
      getDraft: () => Promise.resolve(draft(status)),
      getDraftPicks: () => Promise.resolve([rawPick(1, 'a')]),
      getLeagueUsers: () => Promise.resolve(USERS),
    };
    const take = collector();
    const base = {
      client,
      target: TARGET,
      lastProcessedPickNo: 0,
      isProcessed: () => Promise.resolve(false),
      process: take.process,
    };

    expect((await pollOnce(base)).started).toBe(false);
    status = 'drafting';
    expect((await pollOnce(base)).started).toBe(true);
    expect(take.seen).toHaveLength(1);
  });
});

describe('watchDraft', () => {
  it('--once polls a single time and returns', async () => {
    const client = fakeClient('pre_draft', []);
    const summary = await watchDraft({
      client,
      target: TARGET,
      once: true,
      process: collector().process,
      loadLastProcessed: () => Promise.resolve(0),
      sleep: () => Promise.reject(new Error('--once must not sleep')),
    });
    expect(summary.polls).toBe(1);
    expect(client.draftReads).toBe(1);
  });

  it('loops until it is aborted, finishing the poll in flight', async () => {
    const controller = new AbortController();
    const client = fakeClient('drafting', [rawPick(1, 'a'), rawPick(2, 'b')]);
    const take = collector();
    let mark = 0;

    const summary = await watchDraft({
      client,
      target: TARGET,
      signal: controller.signal,
      intervalMs: 1,
      sleep: () => Promise.resolve(),
      loadLastProcessed: () => Promise.resolve(mark),
      isProcessed: () => Promise.resolve(false),
      process: async (pick) => {
        // Interrupt mid-poll: the rest of this poll must still complete.
        controller.abort();
        return take.process(pick);
      },
      onPoll: (result) => {
        mark = result.lastProcessedPickNo;
      },
    });

    expect(summary.aborted).toBe(true);
    expect(summary.polls).toBe(1);
    expect(take.seen.map((pick) => pick.pickNo)).toEqual([1, 2]);
  });

  it('re-reads the high-water mark before every poll', async () => {
    const client = fakeClient('drafting', [rawPick(1, 'a'), rawPick(2, 'b')]);
    const marks: number[] = [];
    const take = collector();
    let mark = 0;

    await watchDraft({
      client,
      target: TARGET,
      maxPolls: 3,
      intervalMs: 1,
      sleep: () => Promise.resolve(),
      loadLastProcessed: () => {
        marks.push(mark);
        return Promise.resolve(mark);
      },
      isProcessed: () => Promise.resolve(false),
      process: take.process,
      onPoll: (result) => {
        mark = result.lastProcessedPickNo;
      },
    });

    expect(marks).toEqual([0, 2, 2]);
    expect(take.seen.map((pick) => pick.pickNo)).toEqual([1, 2]);
  });

  it('defaults to a polite 25 second interval', () => {
    expect(DEFAULT_INTERVAL_SECONDS).toBe(25);
  });
});

describe('sleep', () => {
  it('resolves immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();
    await sleep(10_000, controller.signal);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('resolves early when the signal aborts during the wait', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const waiting = sleep(10_000, controller.signal);
    controller.abort();
    await waiting;
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('resolveWatchTarget', () => {
  const config = {
    season: 2026,
    sleeper: {
      username: '01capitain',
      userId: '471439689564286976',
      targetLeagueName: 'hotelkit Fantasies',
    },
  } as AppConfig;

  const league: SleeperLeague = {
    league_id: LEAGUE_ID,
    name: 'hotelkit Fantasies',
    season: '2026',
    status: 'pre_draft',
    total_rosters: 8,
    draft_id: DRAFT_ID,
  };

  function leagueClient(overrides: Partial<LeagueSource> = {}): LeagueSource {
    return {
      getDraft: () => Promise.resolve(draft('pre_draft')),
      getDraftPicks: () => Promise.resolve([]),
      getLeagueUsers: () => Promise.resolve(USERS),
      getLeague: () => Promise.resolve(league),
      getLeagueDrafts: () => Promise.resolve([draft('pre_draft')]),
      getUserLeagues: () => Promise.resolve([league]),
      ...overrides,
    };
  }

  it('finds the configured target league by name', async () => {
    const target = await resolveWatchTarget(leagueClient(), config);
    expect(target).toEqual({
      leagueId: LEAGUE_ID,
      leagueName: 'hotelkit Fantasies',
      draftId: DRAFT_ID,
      season: 2026,
    });
  });

  it('--league short-circuits the name lookup', async () => {
    let listed = 0;
    const client = leagueClient({
      getUserLeagues: () => {
        listed += 1;
        return Promise.resolve([]);
      },
    });
    const target = await resolveWatchTarget(client, config, LEAGUE_ID);
    expect(target.draftId).toBe(DRAFT_ID);
    expect(listed).toBe(0);
  });

  it('falls back to the league drafts list when draft_id is absent', async () => {
    const client = leagueClient({
      getLeague: () => Promise.resolve({ ...league, draft_id: null }),
    });
    const target = await resolveWatchTarget(client, config, LEAGUE_ID);
    expect(target.draftId).toBe(DRAFT_ID);
  });

  it('explains itself when the target league is not in the account', async () => {
    const client = leagueClient({ getUserLeagues: () => Promise.resolve([]) });
    await expect(resolveWatchTarget(client, config)).rejects.toThrow(/hotelkit Fantasies/);
  });
});
