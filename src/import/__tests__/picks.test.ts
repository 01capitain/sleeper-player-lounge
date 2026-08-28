/**
 * Pick normalization and persistence.
 *
 * The idempotency case is the §14 product rule "repeated processing of same pick
 * creates no duplicate event".
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Pick } from '../../types.js';
import { isValidPick, validatePick } from '../../validate.js';
import {
  buildManagerNames,
  findPick,
  loadPicks,
  normalizePicks,
  pickEventId,
  savePicks,
  type PickContext,
} from '../picks.js';
import {
  BROS_DRAFT_ID,
  BROS_LEAGUE_ID,
  brosPicks,
  brosUsers,
  playerIndex,
  rawPick,
  user,
} from './fixtures.js';

let dir: string;
let picksFile: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'lounge-picks-'));
  picksFile = path.join(dir, 'picks.jsonl');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function ctx(overrides: Partial<PickContext> = {}): PickContext {
  return {
    leagueId: BROS_LEAGUE_ID,
    draftId: BROS_DRAFT_ID,
    season: 2026,
    players: playerIndex(),
    users: brosUsers(),
    simulated: true,
    ...overrides,
  };
}

describe('pickEventId', () => {
  it('is exactly {draftId}:{pickNo}:{playerId}', () => {
    expect(pickEventId(BROS_DRAFT_ID, 74, '7553')).toBe(`${BROS_DRAFT_ID}:74:7553`);
  });
});

describe('normalizePicks', () => {
  it('builds the eventId as {draftId}:{pickNo}:{playerId} for every pick', () => {
    const picks = normalizePicks(brosPicks(), ctx());
    for (const pick of picks) {
      expect(pick.eventId).toBe(`${pick.draftId}:${pick.pickNo}:${pick.playerId}`);
    }
    // Kyle Pitts, pick 74, round 6 — the real Defensive Bros pick.
    expect(picks.find((pick) => pick.playerId === '7553')?.eventId).toBe(
      `${BROS_DRAFT_ID}:74:7553`,
    );
  });

  it('produces picks that all pass validatePick', () => {
    const picks = normalizePicks(brosPicks(), ctx());
    expect(picks).toHaveLength(brosPicks().length);
    for (const pick of picks) {
      expect(isValidPick(pick)).toBe(true);
      expect(() => validatePick(pick)).not.toThrow();
    }
  });

  it('returns picks sorted ascending by pickNo', () => {
    const shuffled = [...brosPicks()].reverse();
    const picks = normalizePicks(shuffled, ctx());
    expect(picks.map((pick) => pick.pickNo)).toEqual([1, 2, 3, 74, 119, 229]);
  });

  it('takes name, position and NFL team from the players dataset', () => {
    const kelce = normalizePicks(brosPicks(), ctx()).find((pick) => pick.playerId === '1466');
    expect(kelce).toMatchObject({
      playerName: 'Travis Kelce',
      position: 'TE',
      nflTeam: 'KC',
      pickNo: 119,
      round: 9,
      season: 2026,
      leagueId: BROS_LEAGUE_ID,
      simulated: true,
    });
  });

  it('falls back to the pick metadata when the player is not in the dataset', () => {
    const picks = normalizePicks(brosPicks(), ctx({ players: {} }));
    const pitts = picks.find((pick) => pick.playerId === '7553');
    expect(pitts?.playerName).toBe('Kyle Pitts');
    expect(pitts?.position).toBe('TE');
  });

  it('prefers metadata.team_name, then display_name, for the manager name', () => {
    const picks = normalizePicks(brosPicks(), ctx());
    expect(picks.find((pick) => pick.pickNo === 1)?.managerName).toBe('Pitts Stop');
    expect(picks.find((pick) => pick.pickNo === 2)?.managerName).toBe('swiftie_te');
  });

  it('falls back to a stable placeholder when the manager is missing from the user list', () => {
    // `docs/sleeper-facts.md`: the league user list is not 1:1 with rosters.
    const picks = normalizePicks(brosPicks(), ctx());
    const rodgers = picks.find((pick) => pick.playerId === '96');

    expect(rodgers?.managerId).toBe('851531953642532864');
    expect(rodgers?.managerName).toBe('Manager 11'); // draft_slot 11
    expect(isValidPick(rodgers)).toBe(true);
  });

  it('never crashes when the league returns no users at all', () => {
    const picks = normalizePicks(brosPicks(), ctx({ users: undefined }));
    expect(picks).toHaveLength(6);
    for (const pick of picks) expect(pick.managerName).toMatch(/^Manager \d+$/);
  });

  it('recovers the manager from draft_order when picked_by is null', () => {
    const raw = [rawPick({ player_id: '7553', pick_no: 74, round: 6, draft_slot: 5, picked_by: null })];
    const picks = normalizePicks(
      raw,
      ctx({ draftOrder: { '609109430927175680': 5 } }),
    );
    expect(picks[0]?.managerId).toBe('609109430927175680');
    expect(picks[0]?.managerName).toBe('Pitts Stop');
  });

  it('uses a slot placeholder id when there is no manager to be found', () => {
    const raw = [rawPick({ player_id: '7553', pick_no: 74, round: 6, draft_slot: 5, picked_by: null })];
    const picks = normalizePicks(raw, ctx());
    expect(picks[0]?.managerId).toBe('slot-5');
    expect(picks[0]?.managerName).toBe('Manager 5');
    expect(isValidPick(picks[0])).toBe(true);
  });

  it('drops rows without a player id rather than emitting an invalid Pick', () => {
    const raw = [
      ...brosPicks(),
      { draft_id: BROS_DRAFT_ID, player_id: '', pick_no: 240, round: 17, draft_slot: 12 },
    ];
    expect(normalizePicks(raw, ctx())).toHaveLength(6);
  });

  it('collapses duplicate rows returned by a single response', () => {
    const raw = [...brosPicks(), ...brosPicks()];
    expect(normalizePicks(raw, ctx())).toHaveLength(6);
  });
});

describe('savePicks', () => {
  it('writes every pick, one JSON object per line, ascending by pickNo', async () => {
    const picks = normalizePicks(brosPicks(), ctx());
    const result = await savePicks(picks, picksFile);

    expect(result).toMatchObject({ added: 6, duplicates: 0, total: 6, rewritten: false });
    const lines = (await readFile(picksFile, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(6);
    expect(lines.map((line) => (JSON.parse(line) as Pick).pickNo)).toEqual([1, 2, 3, 74, 119, 229]);
  });

  it('re-importing the same draft produces no duplicates', async () => {
    const picks = normalizePicks(brosPicks(), ctx());

    await savePicks(picks, picksFile);
    const second = await savePicks(picks, picksFile);
    const third = await savePicks(normalizePicks(brosPicks(), ctx()), picksFile);

    expect(second).toMatchObject({ added: 0, duplicates: 6, total: 6 });
    expect(third).toMatchObject({ added: 0, duplicates: 6, total: 6 });

    const stored = await loadPicks(picksFile);
    expect(stored).toHaveLength(6);
    expect(new Set(stored.map((pick) => pick.eventId)).size).toBe(6);
  });

  it('appends only the genuinely new picks of a partial re-import', async () => {
    const all = normalizePicks(brosPicks(), ctx());
    await savePicks(all.slice(0, 3), picksFile);

    const result = await savePicks(all, picksFile);

    expect(result).toMatchObject({ added: 3, duplicates: 3, total: 6, rewritten: false });
    expect((await loadPicks(picksFile)).map((pick) => pick.pickNo)).toEqual([1, 2, 3, 74, 119, 229]);
  });

  it('rewrites the file instead of appending when a backfilled pick would break the order', async () => {
    const all = normalizePicks(brosPicks(), ctx());
    await savePicks(all.slice(3), picksFile); // 74, 119, 229 first

    const result = await savePicks(all.slice(0, 3), picksFile); // then 1, 2, 3

    expect(result).toMatchObject({ added: 3, total: 6, rewritten: true });
    const lines = (await readFile(picksFile, 'utf8')).trim().split('\n');
    expect(lines.map((line) => (JSON.parse(line) as Pick).pickNo)).toEqual([1, 2, 3, 74, 119, 229]);
  });

  it('repairs an out-of-order file even when nothing new arrives', async () => {
    const all = normalizePicks(brosPicks(), ctx());
    await writeFile(
      picksFile,
      `${[...all].reverse().map((pick) => JSON.stringify(pick)).join('\n')}\n`,
      'utf8',
    );

    const result = await savePicks(all, picksFile);

    expect(result).toMatchObject({ added: 0, duplicates: 6, total: 6, rewritten: true });
    const lines = (await readFile(picksFile, 'utf8')).trim().split('\n');
    expect(lines.map((line) => (JSON.parse(line) as Pick).pickNo)).toEqual([1, 2, 3, 74, 119, 229]);
  });
});

describe('loadPicks / findPick', () => {
  it('reads a missing file as an empty draft', async () => {
    expect(await loadPicks(picksFile)).toEqual([]);
    expect(await findPick(1, picksFile)).toBeNull();
  });

  it('finds a stored pick by overall pick number', async () => {
    await savePicks(normalizePicks(brosPicks(), ctx()), picksFile);

    const pitts = await findPick(74, picksFile);
    expect(pitts?.playerName).toBe('Kyle Pitts');
    expect(pitts?.round).toBe(6);
    expect(await findPick(9999, picksFile)).toBeNull();
  });
});

describe('buildManagerNames', () => {
  it('prefers team_name, then display_name, then username', () => {
    const names = buildManagerNames(brosUsers());
    expect(names.get('609109430927175680')).toBe('Pitts Stop');
    expect(names.get('1253837548522844160')).toBe('swiftie_te');
    expect(names.get('1111111111111111111')).toBe('lurker');
  });

  it('skips users with no usable name at all', () => {
    expect(buildManagerNames([user({ user_id: 'x' })]).has('x')).toBe(false);
  });
});
