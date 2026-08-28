/**
 * Pick normalization and persistence.
 *
 * Turns raw Sleeper draft picks into the normalized `Pick` records the rest of
 * the pipeline speaks (CONTEXT.md), and stores them in
 * `data/simulation/picks.jsonl`.
 *
 * Two rules here are load-bearing:
 *
 * - `eventId` is exactly `{draftId}:{pickNo}:{playerId}` (implementation_plan.md
 *   §6). It is the idempotency key for the whole pipeline — Reactions, Messages
 *   and the live watcher all key off it.
 * - Re-importing a draft must never duplicate a Pick (§14). `savePicks` dedupes
 *   by `eventId` and rewrites the file when appending alone cannot preserve
 *   ascending `pickNo` order.
 *
 * A league's user list is not 1:1 with its rosters — `docs/sleeper-facts.md`
 * records hotelkit 2025 returning 15 users for 10 rosters — so the manager join
 * is defensive throughout and never throws on a missing user.
 */
import { simulationPicksFile } from '../paths.js';
import type { SleeperDraftPick, SleeperUser } from '../sleeper/types.js';
import type { Pick, SleeperPlayer } from '../types.js';
import { appendJsonl, readJsonl, writeJsonl } from '../util/jsonl.js';
import { log } from '../util/log.js';
import { validatePick } from '../validate.js';
import { displayName, type PlayerIndex } from './players.js';

/** Everything `normalizePicks` needs that a raw pick does not carry itself. */
export interface PickContext {
  leagueId: string;
  draftId: string;
  /** Already coerced to a number — Sleeper reports the season as `"2026"`. */
  season: number;
  /** The `/players/nfl` dataset, for name, position and NFL team. */
  players?: PlayerIndex;
  /** `/league/{id}/users`. Not 1:1 with rosters; joined defensively. */
  users?: SleeperUser[];
  /**
   * The draft's `draft_order` (Sleeper user id -> draft slot). Used only to
   * recover a Manager when a pick's `picked_by` is null, as happens on some
   * autodrafted rows.
   */
  draftOrder?: Record<string, number> | null;
  /** True for everything replayed from a Simulation draft. */
  simulated?: boolean;
  /** True only for picks fabricated for renderer/director testing (§15). */
  synthetic?: boolean;
}

/** The idempotency key. Never build this string anywhere else. */
export function pickEventId(draftId: string, pickNo: number, playerId: string): string {
  return `${draftId}:${pickNo}:${playerId}`;
}

/** Sleeper user id -> the Manager name we display. */
export type ManagerNames = Map<string, string>;

/**
 * Build the manager-name lookup from a league's user list.
 * Preference is `metadata.team_name` then `display_name` then `username`;
 * `docs/sleeper-facts.md` notes `team_name` is frequently absent.
 */
export function buildManagerNames(users: SleeperUser[] | undefined): ManagerNames {
  const names: ManagerNames = new Map();
  for (const user of users ?? []) {
    if (!user?.user_id) continue;
    const name = preferredName(user);
    if (name) names.set(user.user_id, name);
  }
  return names;
}

function preferredName(user: SleeperUser): string | null {
  const teamName = user.metadata?.['team_name']?.trim();
  if (teamName) return teamName;
  const display = user.display_name?.trim();
  if (display) return display;
  const username = user.username?.trim();
  if (username) return username;
  return null;
}

/** Invert `draft_order` (user id -> slot) into slot -> user id. */
function invertDraftOrder(draftOrder: Record<string, number> | null | undefined): Map<number, string> {
  const bySlot = new Map<number, string>();
  for (const [userId, slot] of Object.entries(draftOrder ?? {})) {
    if (typeof slot === 'number' && !bySlot.has(slot)) bySlot.set(slot, userId);
  }
  return bySlot;
}

/** The player's name: dataset first, then the pick's own metadata, then the id. */
export function resolvePlayerName(
  raw: SleeperDraftPick,
  player: SleeperPlayer | undefined,
): string {
  const fromDataset = displayName(player);
  if (fromDataset) return fromDataset;
  const parts = [raw.metadata?.first_name, raw.metadata?.last_name]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));
  if (parts.length > 0) return parts.join(' ');
  return raw.player_id;
}

/**
 * Normalize raw Sleeper picks into validated `Pick` records, ascending by
 * `pickNo`. Every returned Pick has passed `validatePick`.
 */
export function normalizePicks(rawPicks: SleeperDraftPick[], ctx: PickContext): Pick[] {
  const names = buildManagerNames(ctx.users);
  const slotOwners = invertDraftOrder(ctx.draftOrder);
  const players = ctx.players ?? {};

  const picks: Pick[] = [];
  const seen = new Set<string>();

  for (const raw of rawPicks) {
    if (!raw || typeof raw.player_id !== 'string' || raw.player_id === '') {
      log.warn('skipping draft pick without a player_id', raw?.pick_no ?? '?');
      continue;
    }

    const draftId = raw.draft_id || ctx.draftId;
    const eventId = pickEventId(draftId, raw.pick_no, raw.player_id);
    // A draft can hand back the same pick twice across paginated/retried reads.
    if (seen.has(eventId)) continue;
    seen.add(eventId);

    const player = players[raw.player_id];
    const draftSlot = typeof raw.draft_slot === 'number' ? raw.draft_slot : null;

    // Manager join. `picked_by` is the Sleeper user id; when it is missing we
    // fall back to the draft order, and finally to a stable slot placeholder so
    // a partially populated league can never crash the import.
    const pickedBy =
      raw.picked_by ?? (draftSlot !== null ? slotOwners.get(draftSlot) : undefined) ?? null;
    const slotLabel = draftSlot !== null ? String(draftSlot) : String(raw.pick_no);
    const managerId = pickedBy ?? `slot-${slotLabel}`;
    const managerName =
      (pickedBy ? names.get(pickedBy) : undefined) ?? `Manager ${slotLabel}`;

    const pick: Pick = {
      eventId,
      season: ctx.season,
      leagueId: ctx.leagueId,
      draftId,
      pickNo: raw.pick_no,
      round: typeof raw.round === 'number' ? raw.round : null,
      draftSlot,
      playerId: raw.player_id,
      playerName: resolvePlayerName(raw, player),
      position: player?.position ?? raw.metadata?.position ?? null,
      nflTeam: player?.team ?? raw.metadata?.team ?? null,
      managerId,
      managerName,
    };

    if (ctx.simulated) pick.simulated = true;
    if (ctx.synthetic) pick.synthetic = true;

    picks.push(validatePick(pick));
  }

  picks.sort(byPickNo);
  return picks;
}

function byPickNo(a: Pick, b: Pick): number {
  return a.pickNo - b.pickNo;
}

/** What `savePicks` did, so the CLI can report it honestly. */
export interface SavePicksResult {
  /** Picks that were not already on disk. */
  added: number;
  /** Picks already present under the same `eventId`, skipped. */
  duplicates: number;
  /** Total records in the file afterwards. */
  total: number;
  /** True when the file had to be rewritten to keep `pickNo` order. */
  rewritten: boolean;
}

/**
 * Persist Picks to `data/simulation/picks.jsonl`, deduped by `eventId` and
 * sorted ascending by `pickNo`.
 *
 * The happy path is a plain `appendJsonl` of the new records. When the merge
 * would break ascending order — a backfilled earlier pick, or a hand-edited
 * file — the whole file is rewritten instead of blindly appended to, because
 * order is part of the contract for `simulate --next`.
 */
export async function savePicks(
  picks: Pick[],
  filePath: string = simulationPicksFile,
): Promise<SavePicksResult> {
  const existing = await readJsonl<Pick>(filePath);
  const existingIds = new Set(existing.map((pick) => pick.eventId));

  const incoming: Pick[] = [];
  let duplicates = 0;
  const seen = new Set<string>();
  for (const pick of picks) {
    if (existingIds.has(pick.eventId)) {
      duplicates += 1;
      continue;
    }
    if (seen.has(pick.eventId)) {
      duplicates += 1;
      continue;
    }
    seen.add(pick.eventId);
    incoming.push(pick);
  }

  if (incoming.length === 0) {
    // Nothing new. Only touch the file if what is already there is out of order.
    const sorted = [...existing].sort(byPickNo);
    if (!sameOrder(existing, sorted)) {
      await writeJsonl(filePath, sorted);
      return { added: 0, duplicates, total: sorted.length, rewritten: true };
    }
    return { added: 0, duplicates, total: existing.length, rewritten: false };
  }

  const merged = [...existing, ...incoming].sort(byPickNo);
  const appendOnly = sameOrder(merged.slice(0, existing.length), existing);

  if (appendOnly) {
    await appendJsonl(filePath, merged.slice(existing.length));
  } else {
    await writeJsonl(filePath, merged);
  }

  return {
    added: incoming.length,
    duplicates,
    total: merged.length,
    rewritten: !appendOnly,
  };
}

function sameOrder(a: Pick[], b: Pick[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]?.eventId !== b[i]?.eventId) return false;
  }
  return true;
}

/** Replace the stored Picks wholesale. Used when setup selects a different draft. */
export async function replacePicks(
  picks: Pick[],
  filePath: string = simulationPicksFile,
): Promise<number> {
  const sorted = [...picks].sort(byPickNo);
  await writeJsonl(filePath, sorted);
  return sorted.length;
}

/** Every stored Pick, ascending by `pickNo`. A missing file reads as `[]`. */
export async function loadPicks(filePath: string = simulationPicksFile): Promise<Pick[]> {
  const picks = await readJsonl<Pick>(filePath);
  return picks.sort(byPickNo);
}

/** One stored Pick by overall pick number, or `null`. */
export async function findPick(
  pickNo: number,
  filePath: string = simulationPicksFile,
): Promise<Pick | null> {
  const picks = await loadPicks(filePath);
  return picks.find((pick) => pick.pickNo === pickNo) ?? null;
}
