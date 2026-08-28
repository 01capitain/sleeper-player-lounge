/**
 * The Fantasy Memory read API.
 *
 * This is the boundary the Context builder consumes. It joins the two importer
 * outputs — `last-season.json` (2025 only) and `champions.json` (every available
 * season) — into the `PlayerHistory` shape defined by
 * `schemas/player-history.schema.json`, and it carries the guardrail that keeps
 * the memory cutoff honest: `assertNoForbiddenHistory`.
 *
 * CONTEXT.md: *"What is absent from the Context cannot be said."* Everything here
 * exists so that pre-2025 non-championship history is absent by construction, not
 * by the Director's good behaviour.
 */
import { championsFile as defaultChampionsFile, lastSeasonFile as defaultLastSeasonFile } from '../paths.js';
import type {
  ChampionsFile,
  ChampionshipEntry,
  LastSeasonFile,
  LastSeasonHistory,
  PlayerHistory,
} from '../types.js';
import { readJsonIfExists } from '../util/json.js';
import { buildChampionshipIndex } from './champions.js';
import { LAST_SEASON } from './last-season.js';

export { MAX_CHAIN_LENGTH, findLeagueForSeason, seasonOf, walkLeagueChain } from './chain.js';
export {
  CHAMPIONSHIP_PLACEMENT,
  buildChampionshipIndex,
  findChampionRosterId,
  importChampions,
  managerIdentity,
  managerNameIndex,
} from './champions.js';
export {
  LAST_SEASON,
  MissingLastSeasonError,
  importLastSeason,
  placementsFromBracket,
} from './last-season.js';
export {
  DISAPPOINTING_THRESHOLD,
  DISASTER_THRESHOLD,
  EXCELLENT_THRESHOLD,
  GOOD_THRESHOLD,
  MIN_POOL_SIZE,
  PERFORMANCE_LABELS,
  buildPositionRanks,
  classify,
  collectSeasonPoints,
  labelForScore,
  loadPerformanceOverrides,
  performanceScore,
  regularSeasonWeeks,
} from './performance.js';

/** Both history files plus the derived reverse championship lookup. */
export interface HistoryStore {
  /** `last-season.json`, or null when it has not been imported yet. */
  lastSeason: LastSeasonFile | null;
  /** `champions.json`, or null when it has not been imported yet. */
  champions: ChampionsFile | null;
  /** player id -> every championship roster he was on, newest season first. */
  championshipsByPlayer: Record<string, ChampionshipEntry[]>;
}

/** Thrown when a history record would smuggle pre-2025 roster memory into the Context. */
export class ForbiddenHistoryError extends Error {
  readonly playerId: string;
  readonly season: number;
  constructor(playerId: string, season: number) {
    super(
      `Forbidden Fantasy Memory for player ${playerId}: non-championship history for season ` +
        `${season}, but only ${LAST_SEASON} ordinary roster history may reach the Context`,
    );
    this.name = 'ForbiddenHistoryError';
    this.playerId = playerId;
    this.season = season;
  }
}

export interface LoadHistoryOptions {
  lastSeasonFile?: string;
  championsFile?: string;
}

let cached: HistoryStore | null = null;

/** Join two already-parsed files into a store. Pure; used by `loadHistory` and tests. */
export function buildHistoryStore(
  lastSeason: LastSeasonFile | null,
  champions: ChampionsFile | null,
): HistoryStore {
  if (lastSeason !== null && lastSeason.season !== LAST_SEASON) {
    // A last-season file for any other year is a corrupt import, not a nuance.
    throw new ForbiddenHistoryError('*', lastSeason.season);
  }
  return {
    lastSeason,
    champions,
    championshipsByPlayer: buildChampionshipIndex(champions),
  };
}

/**
 * Read both history files, tolerating either being absent — the Lounge runs fine
 * before `lounge history import` has ever been executed. Memoized; call
 * `clearHistoryCache()` to force a re-read.
 */
export async function loadHistory(options: LoadHistoryOptions = {}): Promise<HistoryStore> {
  const lastSeasonPath = options.lastSeasonFile ?? defaultLastSeasonFile;
  const championsPath = options.championsFile ?? defaultChampionsFile;
  const isDefault = lastSeasonPath === defaultLastSeasonFile && championsPath === defaultChampionsFile;
  if (cached !== null && isDefault) return cached;

  const [lastSeason, champions] = await Promise.all([
    readJsonIfExists<LastSeasonFile>(lastSeasonPath),
    readJsonIfExists<ChampionsFile>(championsPath),
  ]);

  const store = buildHistoryStore(lastSeason, champions);
  if (isDefault) cached = store;
  return store;
}

/** Drop the memoized store. */
export function clearHistoryCache(): void {
  cached = null;
}

/** Install a store directly, e.g. from an in-memory import. */
export function setHistoryStore(store: HistoryStore | null): void {
  cached = store;
}

function requireStore(): HistoryStore {
  if (cached === null) {
    throw new Error('History not loaded: call loadHistory() before reading Fantasy Memory');
  }
  return cached;
}

/**
 * One Speaker's complete Fantasy Memory, or null when he has none.
 *
 * The returned value always satisfies `validatePlayerHistory`: `lastSeason` is
 * either null or a season-2025 record, and `championships` may span any season.
 */
export function historyFor(playerId: string, store: HistoryStore = requireStore()): PlayerHistory | null {
  const record = store.lastSeason?.players[playerId];
  const championships = store.championshipsByPlayer[playerId] ?? [];
  if (record === undefined && championships.length === 0) return null;

  const lastSeason: LastSeasonHistory | null =
    record === undefined
      ? null
      : {
          season: LAST_SEASON,
          managerId: record.managerId,
          managerName: record.managerName,
          performance: record.performance,
          teamFinish: record.teamFinish ?? null,
          champion: record.champion ?? false,
          sharedRosterPlayerIds: record.sharedRosterPlayerIds ?? [],
        };

  return { playerId, lastSeason, championships: championships.map((entry) => ({ ...entry })) };
}

/** True when both players were on the same 2025 fantasy roster. */
export function sharedRoster2025(
  playerIdA: string,
  playerIdB: string,
  store: HistoryStore = requireStore(),
): boolean {
  if (playerIdA === playerIdB) return false;
  const players = store.lastSeason?.players;
  if (players === undefined) return false;
  const a = players[playerIdA];
  const b = players[playerIdB];
  if (a === undefined || b === undefined) return false;
  return a.managerId === b.managerId;
}

/**
 * Every season in which both players were on the same winning roster.
 *
 * This is the one lookup allowed to reach before 2025 — Championship Membership
 * is the sole pre-2025 fact in Fantasy Memory. Newest season first.
 */
export function sharedChampionship(
  playerIdA: string,
  playerIdB: string,
  store: HistoryStore = requireStore(),
): { season: number; managerName: string }[] {
  if (playerIdA === playerIdB) return [];
  const rosters = store.champions?.championshipRosters;
  if (rosters === undefined || rosters === null) return [];

  const shared: { season: number; managerName: string }[] = [];
  for (const roster of Object.values(rosters)) {
    if (roster === null || roster === undefined) continue;
    const ids = roster.playerIds ?? [];
    if (ids.includes(playerIdA) && ids.includes(playerIdB)) {
      shared.push({ season: roster.season, managerName: roster.managerName });
    }
  }
  shared.sort((a, b) => b.season - a.season);
  return shared;
}

/**
 * The memory-cutoff guardrail. Throws when a `PlayerHistory` carries ordinary
 * (non-championship) roster history from before 2025.
 *
 * The Context builder calls this on everything it is about to hand the Director,
 * so implementation_plan.md §14's *"no non-championship roster history before
 * 2025 reaches the prompt"* is enforced at the boundary rather than trusted.
 * Championship entries are exempt by design and may name any season.
 */
export function assertNoForbiddenHistory(
  history: PlayerHistory | readonly PlayerHistory[] | null | undefined,
): void {
  if (history === null || history === undefined) return;
  if (Array.isArray(history)) {
    for (const entry of history) assertNoForbiddenHistory(entry);
    return;
  }

  const single = history as PlayerHistory;
  const lastSeason = single.lastSeason;
  if (lastSeason === null || lastSeason === undefined) return;
  if (lastSeason.season !== LAST_SEASON) {
    throw new ForbiddenHistoryError(single.playerId, lastSeason.season);
  }
}
