/**
 * Simulation draft selection (implementation_plan.md §6, §14).
 *
 * Two of these are explicit product rules from §14:
 *   - a pre-draft target league is never selected for simulation
 *   - a completed alternate 2026 draft can be replayed
 */
import { describe, expect, it } from 'vitest';

import {
  compareCandidates,
  completionKey,
  discoverSimulationDraft,
  findTargetLeague,
} from '../../sleeper/discovery.js';
import type { SleeperDraft } from '../../sleeper/types.js';
import {
  AFFC_DRAFT_ID,
  AFFC_LEAGUE_ID,
  BROS_DRAFT_ID,
  BROS_LEAGUE_ID,
  HOTELKIT_DRAFT_ID,
  HOTELKIT_LEAGUE_ID,
  USER_ID,
  brosDraft,
  brosPicks,
  draft,
  league,
  leagues2026,
  testClient,
  testConfig,
} from './fixtures.js';

const LEAGUES_PATH = `/user/${USER_ID}/leagues/nfl/2026`;

/** The routes the happy path needs: three leagues, their drafts, and the picks. */
function defaultRoutes(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    [LEAGUES_PATH]: leagues2026(),
    [`/league/${HOTELKIT_LEAGUE_ID}/drafts`]: [
      draft({ draft_id: HOTELKIT_DRAFT_ID, league_id: HOTELKIT_LEAGUE_ID, status: 'pre_draft' }),
    ],
    [`/league/${BROS_LEAGUE_ID}/drafts`]: [brosDraft()],
    [`/league/${AFFC_LEAGUE_ID}/drafts`]: [
      draft({ draft_id: AFFC_DRAFT_ID, league_id: AFFC_LEAGUE_ID, status: 'pre_draft' }),
    ],
    [`/draft/${BROS_DRAFT_ID}/picks`]: brosPicks(),
    ...overrides,
  };
}

describe('discoverSimulationDraft', () => {
  it('selects the completed alternate 2026 draft', async () => {
    const { client } = await testClient(defaultRoutes());
    const selected = await discoverSimulationDraft(client, testConfig());

    expect(selected.draftId).toBe(BROS_DRAFT_ID);
    expect(selected.leagueId).toBe(BROS_LEAGUE_ID);
    expect(selected.leagueName).toBe('Defensive Bros');
    expect(selected.status).toBe('complete');
    expect(selected.rounds).toBe(17);
    expect(selected.teams).toBe(14);
    expect(selected.totalPicks).toBe(brosPicks().length);
  });

  it('coerces the season from Sleeper\'s string to a number', async () => {
    const { client } = await testClient(defaultRoutes());
    const selected = await discoverSimulationDraft(client, testConfig());

    expect(selected.season).toBe(2026);
    expect(typeof selected.season).toBe('number');
  });

  it('never selects the target league while it is pre_draft, even with a completed draft', async () => {
    // hotelkit Fantasies is pre_draft but is given a *completed* draft with picks.
    const routes = defaultRoutes({
      [`/league/${HOTELKIT_LEAGUE_ID}/drafts`]: [
        draft({
          draft_id: HOTELKIT_DRAFT_ID,
          league_id: HOTELKIT_LEAGUE_ID,
          status: 'complete',
          last_picked: 9_999_999_999_999,
          settings: { rounds: 15, teams: 8 },
        }),
      ],
      [`/draft/${HOTELKIT_DRAFT_ID}/picks`]: brosPicks(),
    });
    const { client, calls } = await testClient(routes);

    const selected = await discoverSimulationDraft(client, testConfig());

    expect(selected.draftId).toBe(BROS_DRAFT_ID);
    // The excluded league's drafts are never even listed.
    expect(calls).not.toContain(`/league/${HOTELKIT_LEAGUE_ID}/drafts`);
  });

  it('throws an actionable error when only the pre-draft target league exists', async () => {
    const routes = {
      [LEAGUES_PATH]: [
        league({
          league_id: HOTELKIT_LEAGUE_ID,
          name: 'hotelkit Fantasies',
          status: 'pre_draft',
          total_rosters: 8,
        }),
      ],
    };
    const { client } = await testClient(routes);

    await expect(discoverSimulationDraft(client, testConfig())).rejects.toThrow(
      /No completed 2026 draft is available to simulate/,
    );
    await expect(discoverSimulationDraft(client, testConfig())).rejects.toThrow(
      /target league, still pre_draft/,
    );
  });

  it('ignores completed drafts that have no picks', async () => {
    const routes = defaultRoutes({ [`/draft/${BROS_DRAFT_ID}/picks`]: [] });
    const { client } = await testClient(routes);

    await expect(discoverSimulationDraft(client, testConfig())).rejects.toThrow(
      /complete but has no picks/,
    );
  });

  it('prefers the most recently completed draft', async () => {
    const olderId = '1000000000000000001';
    const routes = defaultRoutes({
      [`/league/${AFFC_LEAGUE_ID}/drafts`]: [
        draft({
          draft_id: olderId,
          league_id: AFFC_LEAGUE_ID,
          status: 'complete',
          last_picked: 1_700_000_000_000,
          settings: { rounds: 15, teams: 12 },
        }),
      ],
      [`/draft/${olderId}/picks`]: brosPicks(),
    });
    const { client } = await testClient(routes);

    const selected = await discoverSimulationDraft(client, testConfig());
    // Defensive Bros' last_picked (1_755_000_000_000) is newer.
    expect(selected.draftId).toBe(BROS_DRAFT_ID);
  });

  it('errors when the user has no leagues for the season', async () => {
    const { client } = await testClient({ [LEAGUES_PATH]: [] });
    await expect(discoverSimulationDraft(client, testConfig())).rejects.toThrow(
      /No 2026 NFL leagues found/,
    );
  });
});

describe('completionKey', () => {
  const base = (overrides: Partial<SleeperDraft>): SleeperDraft =>
    draft({ draft_id: 'd', league_id: 'l', ...overrides });

  it('keys on last_picked when present', () => {
    expect(completionKey(base({ last_picked: 5, start_time: 1, created: 2 }))).toBe(5);
  });

  it('falls back to start_time then created', () => {
    expect(completionKey(base({ last_picked: null, start_time: 3, created: 2 }))).toBe(3);
    expect(completionKey(base({ last_picked: null, start_time: null, created: 2 }))).toBe(2);
    expect(completionKey(base({ last_picked: null, start_time: null, created: null }))).toBe(0);
  });

  it('breaks ties on the higher draft id', () => {
    const a = { league: leagues2026()[1]!, draft: base({ draft_id: '900' }), pickCount: 1, completedAt: 0 };
    const b = { league: leagues2026()[1]!, draft: base({ draft_id: '1000' }), pickCount: 1, completedAt: 0 };
    expect([a, b].sort(compareCandidates)[0]?.draft.draft_id).toBe('1000');
  });
});

describe('findTargetLeague', () => {
  it('returns the target league regardless of its status', async () => {
    const { client } = await testClient({ [LEAGUES_PATH]: leagues2026() });
    const target = await findTargetLeague(client, testConfig());

    expect(target?.league_id).toBe(HOTELKIT_LEAGUE_ID);
    expect(target?.status).toBe('pre_draft');
  });

  it('returns null when the operator is not in the target league', async () => {
    const { client } = await testClient({
      [LEAGUES_PATH]: leagues2026().filter((entry) => entry.name !== 'hotelkit Fantasies'),
    });
    expect(await findTargetLeague(client, testConfig())).toBeNull();
  });
});
