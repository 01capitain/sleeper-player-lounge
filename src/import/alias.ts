/**
 * Manager Alias — the optional deterministic overlay described in CONTEXT.md
 * and ADR 0002.
 *
 * The Simulation draft belongs to `Defensive Bros`, whose Managers are not
 * `hotelkit Fantasies` Managers. The alias maps Simulation draft slots onto
 * target-league Managers so target-league Fantasy Memory (and Kyle Pitts' League
 * Lore) has somewhere to land during a Simulation.
 *
 * It is **off by default**: an unaliased Simulation uses the real
 * Simulation-league Managers. Nothing in this module mutates a Pick in place.
 */
import { managerAliasFile } from '../paths.js';
import type { SleeperClient } from '../sleeper/client.js';
import type { SleeperUser } from '../sleeper/types.js';
import type { ManagerAliasMap, Pick, SelectedDraft } from '../types.js';
import { readJsonIfExists, writeJson } from '../util/json.js';
import { log } from '../util/log.js';

/** Bumped whenever the mapping rule changes, so stale files can be spotted. */
export const ALIAS_MAP_VERSION = 1;

export interface BuildAliasOptions {
  /** `0` forces a live fetch of the target league and its users. */
  ttlMs?: number;
  /** Override the target league's display name (saves a `/league/{id}` call). */
  targetLeagueName?: string;
}

/** `metadata.team_name`, then `display_name`, then `username`. */
function preferredName(user: SleeperUser, index: number): string {
  const teamName = user.metadata?.['team_name']?.trim();
  if (teamName) return teamName;
  const display = user.display_name?.trim();
  if (display) return display;
  const username = user.username?.trim();
  if (username) return username;
  return `Manager ${index + 1}`;
}

/**
 * Sleeper user ids are numeric snowflake strings of varying length, so a plain
 * lexicographic sort would order `9…` before `10…`. Comparing by length first
 * gives numeric order without risking `Number` precision loss on 19-digit ids.
 */
export function compareUserIds(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Build the slot -> target-Manager overlay.
 *
 * Mapping rule (deterministic and total):
 *
 *   targetManagers = target league users, sorted ascending by `user_id`
 *   alias(slot)    = targetManagers[slot % targetManagers.length]
 *
 * Sorting by `user_id` rather than by name or list order makes the map stable
 * across runs even though Sleeper returns `/league/{id}/users` in arbitrary
 * order. The modulo is required because the slot counts differ — the Simulation
 * draft has 14 slots and the target league has 8 Managers — and it guarantees
 * every slot from 1..teams receives exactly one Manager (several slots share a
 * Manager, which is expected and harmless: a Manager simply drafts twice).
 */
export async function buildAliasMap(
  client: SleeperClient,
  selectedDraft: SelectedDraft,
  targetLeagueId: string,
  opts: BuildAliasOptions = {},
): Promise<ManagerAliasMap> {
  const users = await client.getLeagueUsers(targetLeagueId, { ttlMs: opts.ttlMs });

  let leagueName = opts.targetLeagueName;
  if (!leagueName) {
    try {
      const league = await client.getLeague(targetLeagueId, { ttlMs: opts.ttlMs });
      leagueName = league.name;
    } catch (error) {
      log.warn('could not read target league name', targetLeagueId, error);
      leagueName = targetLeagueId;
    }
  }

  return aliasMapFromUsers(users, selectedDraft, targetLeagueId, leagueName);
}

/** The pure core of `buildAliasMap`, so the rule can be tested without a client. */
export function aliasMapFromUsers(
  users: SleeperUser[],
  selectedDraft: SelectedDraft,
  targetLeagueId: string,
  targetLeagueName: string,
): ManagerAliasMap {
  const managers = [...users]
    .filter((user) => Boolean(user?.user_id))
    .sort((a, b) => compareUserIds(a.user_id, b.user_id));

  if (managers.length === 0) {
    throw new Error(
      `Cannot build a Manager Alias map: target league ${targetLeagueId} returned no users.`,
    );
  }

  const slotCount = selectedDraft.teams > 0 ? selectedDraft.teams : managers.length;
  const slots: ManagerAliasMap['slots'] = {};

  for (let slot = 1; slot <= slotCount; slot += 1) {
    const manager = managers[slot % managers.length] as SleeperUser;
    slots[String(slot)] = {
      managerId: manager.user_id,
      managerName: preferredName(manager, slot % managers.length),
    };
  }

  return {
    version: ALIAS_MAP_VERSION,
    sourceDraftId: selectedDraft.draftId,
    targetLeagueId,
    targetLeagueName,
    slots,
  };
}

/**
 * Return a copy of `pick` with its Manager replaced by the aliased one.
 * A Pick whose slot is unknown to the map is returned unchanged (as a copy), so
 * a partial map can never drop Picks from a replay.
 */
export function applyAlias(pick: Pick, aliasMap: ManagerAliasMap): Pick {
  const slot = pick.draftSlot;
  if (slot === null || slot === undefined) return { ...pick };
  const alias = aliasMap.slots[String(slot)];
  if (!alias) return { ...pick };
  return { ...pick, managerId: alias.managerId, managerName: alias.managerName };
}

/** The stored alias map, or `null` when none has been built yet. */
export async function loadAliasMap(
  filePath: string = managerAliasFile,
): Promise<ManagerAliasMap | null> {
  return readJsonIfExists<ManagerAliasMap>(filePath);
}

/** Persist the alias map (pretty-printed, key-sorted) to `manager-alias.json`. */
export async function saveAliasMap(
  aliasMap: ManagerAliasMap,
  filePath: string = managerAliasFile,
): Promise<void> {
  await writeJson(filePath, aliasMap);
}
