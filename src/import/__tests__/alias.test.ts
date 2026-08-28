/**
 * Manager Alias (CONTEXT.md, ADR 0002).
 *
 * The mapping must be deterministic (same input, same file, every run) and total
 * across all 14 Simulation slots even though the target league has 8 Managers.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ManagerAliasMap } from '../../types.js';
import {
  aliasMapFromUsers,
  applyAlias,
  buildAliasMap,
  compareUserIds,
  loadAliasMap,
  saveAliasMap,
} from '../alias.js';
import { normalizePicks } from '../picks.js';
import {
  BROS_DRAFT_ID,
  BROS_LEAGUE_ID,
  HOTELKIT_LEAGUE_ID,
  brosPicks,
  brosUsers,
  hotelkitUsers,
  league,
  playerIndex,
  selectedDraft,
  testClient,
  user,
} from './fixtures.js';

let dir: string;
let aliasFile: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'lounge-alias-'));
  aliasFile = path.join(dir, 'manager-alias.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function map(users = hotelkitUsers()): ManagerAliasMap {
  return aliasMapFromUsers(users, selectedDraft(), HOTELKIT_LEAGUE_ID, 'hotelkit Fantasies');
}

describe('aliasMapFromUsers', () => {
  it('covers every one of the 14 simulation slots', () => {
    const aliasMap = map();
    expect(Object.keys(aliasMap.slots)).toHaveLength(14);
    for (let slot = 1; slot <= 14; slot += 1) {
      const entry = aliasMap.slots[String(slot)];
      expect(entry, `slot ${slot}`).toBeDefined();
      expect(entry?.managerId).toBeTruthy();
      expect(entry?.managerName).toBeTruthy();
    }
  });

  it('maps slot % managerCount over managers sorted by user_id', () => {
    const aliasMap = map();
    const sorted = [...hotelkitUsers()].sort((a, b) => compareUserIds(a.user_id, b.user_id));

    for (let slot = 1; slot <= 14; slot += 1) {
      expect(aliasMap.slots[String(slot)]?.managerId).toBe(sorted[slot % sorted.length]?.user_id);
    }
    // 8 managers: slot 8 wraps to the first manager, slot 9 to the second.
    expect(aliasMap.slots['8']?.managerId).toBe(sorted[0]?.user_id);
    expect(aliasMap.slots['9']?.managerId).toBe(sorted[1]?.user_id);
    expect(aliasMap.slots['1']?.managerId).toBe(aliasMap.slots['9']?.managerId);
  });

  it('is deterministic no matter what order Sleeper returns the users in', () => {
    const forwards = map(hotelkitUsers());
    const backwards = map([...hotelkitUsers()].reverse());
    const rotated = map([...hotelkitUsers().slice(3), ...hotelkitUsers().slice(0, 3)]);

    expect(backwards.slots).toEqual(forwards.slots);
    expect(rotated.slots).toEqual(forwards.slots);
  });

  it('uses all 8 target managers across the 14 slots', () => {
    const aliasMap = map();
    const distinct = new Set(Object.values(aliasMap.slots).map((entry) => entry.managerId));
    expect(distinct.size).toBe(8);
  });

  it('prefers team_name over display_name for the manager name', () => {
    const aliasMap = map();
    const names = new Set(Object.values(aliasMap.slots).map((entry) => entry.managerName));
    expect(names).toContain('Capitain');
    expect(names).toContain('Four Horsemen');
    expect(names).toContain('hk_two');
  });

  it('falls back to a placeholder for a nameless manager', () => {
    const aliasMap = aliasMapFromUsers(
      [user({ user_id: '1' }), user({ user_id: '2' })],
      selectedDraft({ teams: 2 }),
      HOTELKIT_LEAGUE_ID,
      'hotelkit Fantasies',
    );
    expect(Object.values(aliasMap.slots).every((entry) => /^Manager \d+$/.test(entry.managerName))).toBe(true);
  });

  it('refuses to build a map for a league with no users', () => {
    expect(() =>
      aliasMapFromUsers([], selectedDraft(), HOTELKIT_LEAGUE_ID, 'hotelkit Fantasies'),
    ).toThrow(/returned no users/);
  });
});

describe('compareUserIds', () => {
  it('orders shorter (numerically smaller) snowflake ids first', () => {
    expect(['1000', '999', '1001'].sort(compareUserIds)).toEqual(['999', '1000', '1001']);
  });
});

describe('buildAliasMap', () => {
  it('reads the target league users through the Sleeper client', async () => {
    const { client } = await testClient({
      [`/league/${HOTELKIT_LEAGUE_ID}/users`]: hotelkitUsers(),
      [`/league/${HOTELKIT_LEAGUE_ID}`]: league({
        league_id: HOTELKIT_LEAGUE_ID,
        name: 'hotelkit Fantasies',
        total_rosters: 8,
      }),
    });

    const aliasMap = await buildAliasMap(client, selectedDraft(), HOTELKIT_LEAGUE_ID);

    expect(aliasMap.sourceDraftId).toBe(BROS_DRAFT_ID);
    expect(aliasMap.targetLeagueId).toBe(HOTELKIT_LEAGUE_ID);
    expect(aliasMap.targetLeagueName).toBe('hotelkit Fantasies');
    expect(Object.keys(aliasMap.slots)).toHaveLength(14);
  });
});

describe('applyAlias', () => {
  const picks = () =>
    normalizePicks(brosPicks(), {
      leagueId: BROS_LEAGUE_ID,
      draftId: BROS_DRAFT_ID,
      season: 2026,
      players: playerIndex(),
      users: brosUsers(),
      simulated: true,
    });

  it('replaces only the manager, leaving the rest of the Pick intact', () => {
    const aliasMap = map();
    const original = picks().find((pick) => pick.playerId === '7553')!;
    const aliased = applyAlias(original, aliasMap);

    expect(aliased.managerId).toBe(aliasMap.slots['5']?.managerId);
    expect(aliased.managerName).toBe(aliasMap.slots['5']?.managerName);
    expect(aliased.managerId).not.toBe(original.managerId);
    expect({ ...aliased, managerId: '', managerName: '' }).toEqual({
      ...original,
      managerId: '',
      managerName: '',
    });
  });

  it('does not mutate the input Pick', () => {
    const aliasMap = map();
    const original = picks()[0]!;
    const before = { ...original };
    applyAlias(original, aliasMap);
    expect(original).toEqual(before);
  });

  it('returns the Pick unchanged when its slot is not in the map', () => {
    const aliasMap = aliasMapFromUsers(
      hotelkitUsers(),
      selectedDraft({ teams: 2 }),
      HOTELKIT_LEAGUE_ID,
      'hotelkit Fantasies',
    );
    const original = picks().find((pick) => pick.draftSlot === 11)!;
    expect(applyAlias(original, aliasMap)).toEqual(original);
  });
});

describe('loadAliasMap / saveAliasMap', () => {
  it('round-trips through the manager-alias file', async () => {
    expect(await loadAliasMap(aliasFile)).toBeNull();

    const aliasMap = map();
    await saveAliasMap(aliasMap, aliasFile);

    expect(await loadAliasMap(aliasFile)).toEqual(aliasMap);
  });
});
