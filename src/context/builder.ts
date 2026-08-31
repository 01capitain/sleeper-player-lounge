/**
 * The Context builder.
 *
 * Assembles exactly what implementation_plan.md §9 lists for one Pick:
 * the Pick, the Manager plus their already-drafted roster, the drafted player's
 * current NFL teammates, the selected Regulars, the drafted player's 2025
 * history, 2025 shared-roster relationships among candidate Speakers,
 * championship memberships of relevant Speakers, the last ~20 Lounge Messages,
 * active running jokes, and draft signals.
 *
 * THE CONTEXT IS A BOUNDARY.
 * CONTEXT.md: "What is absent from the Context cannot be said." This module is
 * therefore the enforcement point for the Fantasy Memory rules, not the prompt:
 *
 *  - `assertNoForbiddenHistory` from `src/history/index.ts` runs before we return
 *    (guarded — that module is owned by another agent and may not exist yet);
 *  - `assertContextClean` throws if any history entry carries a season < 2025
 *    unless it is a championship record (§14: "no non-championship roster
 *    history before 2025 reaches the prompt");
 *  - `recentMessages` is hard-capped at 20.
 *
 * Modules owned by other agents (`src/history`, `src/import`) are imported
 * lazily behind the narrow interfaces declared here, and every dependency can be
 * injected so tests never touch the filesystem or those modules.
 */
import {
  livePicksFile,
  loungeMessagesFile,
  loungeStateFile,
  playersCacheFile,
  relationshipsSeedFile,
  simulationPicksFile,
  starPlayersFile,
} from '../paths.js';
import type {
  AppConfig,
  ChampionshipEntry,
  ContextManager,
  DraftSignals,
  LoungeContext,
  LoungeMessage,
  LoungeState,
  NflTeammate,
  Pick,
  PlayerHistory,
  ReactionRulesConfig,
  RelationshipsSeed,
  RunningJoke,
  SleeperPlayer,
  StarPlayer,
  StarPlayersFile,
} from '../types.js';
import { readJsonIfExists } from '../util/json.js';
import { readJsonl, readJsonlTail } from '../util/jsonl.js';
import { log } from '../util/log.js';
import {
  normalizeName,
  selectActors,
  starPseudoId,
  type ActorRef,
  type ActorRelevance,
  type SelectedActor,
} from './actors.js';
import {
  computeDraftSignalDetail,
  type DraftSignalDetail,
  type DraftSignalOptions,
} from './signals.js';

/** §9: "last ~20 Lounge messages". Hard cap, enforced on the way out. */
export const MAX_RECENT_MESSAGES = 20;

/** The first season whose ordinary roster history is allowed into the Context. */
export const FIRST_ALLOWED_HISTORY_SEASON = 2025;

// ---------------------------------------------------------------------------
// Narrow interfaces for modules owned by other agents
// ---------------------------------------------------------------------------

/**
 * The slice of `src/history/index.ts` this module uses. Every member is optional
 * so a partially-built history module still works; anything missing degrades to
 * "no fantasy history", which is always a safe answer.
 */
export interface HistoryModuleLike {
  /** Must be awaited before `historyFor` works: the store is module-level state. */
  loadHistory?: () => unknown;
  historyFor?: (playerId: string) => PlayerHistory | null | undefined;
  /** Truthy (boolean or non-empty array) when the two players are linked. */
  sharedRoster2025?: (a: string, b: string) => unknown;
  sharedChampionship?: (a: string, b: string) => unknown;
  /** Throws when a `PlayerHistory` carries roster memory the rules forbid. */
  assertNoForbiddenHistory?: (
    history: PlayerHistory | readonly PlayerHistory[] | null | undefined,
  ) => void;
}

/** The slice of `src/import/players.ts` this module uses. */
export type TeammatesOf = (
  playerId: string,
  players: Record<string, SleeperPlayer>,
  limit?: number,
) => NflTeammate[] | undefined;

/** `positionRivals` from `src/import/players.ts`. */
export type PositionRivalsOf = (
  playerId: string,
  players: Record<string, SleeperPlayer>,
  limit?: number,
) => NflTeammate[] | undefined;

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/** A 2025 or championship roster tie between two candidate Speakers. */
export interface SharedRosterLink {
  season: number;
  kind: 'roster_2025' | 'championship';
  aPlayerId: string;
  aName: string;
  bPlayerId: string;
  bName: string;
  managerName?: string;
}

/**
 * A player already selected earlier in this draft, and the Pick that took him.
 *
 * A Regular does not stop being ambient when he is drafted — he is still in the
 * Lounge for every Pick. What changes is what he can honestly say: a receiver
 * taken at pick 12 cannot spend pick 18 complaining that nobody has called his
 * name. Without this fact in the Context he does exactly that, because his
 * profile tells him to react to receivers going ahead of him and nothing
 * contradicts it.
 */
export interface OffTheBoardRef extends ActorRef {
  /** Overall pick number he went at. */
  pickNo: number;
  /** The Manager who took him. */
  managerName: string;
}

/**
 * Extra material the Director prompt uses. Purely additive: a `BuiltContext` is
 * a `LoungeContext`, so nothing downstream has to know about these fields.
 */
export interface LoungeContextExtras {
  /** Every candidate Speaker in §9 order, with the reason each is eligible. */
  actors: SelectedActor[];
  /**
   * The Manager's roster so far with position and NFL team resolved, so the
   * prompt can show who the new pick actually competes with. Same players and
   * same order as `manager.roster`, which stays a plain name list.
   */
  managerRosterDetail: ActorRef[];
  /**
   * Everyone already taken earlier in this draft, oldest Pick first — every
   * Manager's roster, not just this one's. The prompt marks anyone in the room
   * who appears here, so a drafted Regular cannot play the overlooked man.
   */
  offTheBoard: OffTheBoardRef[];
  /** The draft signals plus their supporting detail (counts, stack partners). */
  signalDetail: DraftSignalDetail;
  /** Shared 2025 rosters and championship rosters among candidate Speakers. */
  sharedRosters: SharedRosterLink[];
  /** The seed actor selection ran with, for reproducing a Reaction exactly. */
  seed: number;
}

export type BuiltContext = LoungeContext & LoungeContextExtras;

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface BuildContextDeps {
  config?: AppConfig;
  rules?: Partial<ReactionRulesConfig>;
  /** Cached Sleeper `/players/nfl` dataset. */
  players?: Record<string, SleeperPlayer>;
  starPlayers?: readonly StarPlayer[];
  relationships?: RelationshipsSeed;
  state?: LoungeState;
  /** Already-loaded transcript tail; capped at 20 regardless. */
  recentMessages?: readonly LoungeMessage[];
  /** Picks made before this one, in the same draft. */
  priorPicks?: readonly Pick[];
  /**
   * Where to look for those Picks when `priorPicks` is not supplied. Defaults to
   * the live board then the Simulation board; `draftId` decides which one
   * answers. Tests point this at temp files.
   */
  pickFiles?: readonly string[];
  /** Player names the Manager has already drafted, oldest first. */
  managerRoster?: readonly string[];
  /** `src/history/index.ts`, or `null` to run with no Fantasy Memory at all. */
  history?: HistoryModuleLike | null;
  /** `teammatesOf` from `src/import/players.ts`. */
  teammatesOf?: TeammatesOf | null;
  /** `positionRivals` from `src/import/players.ts`. */
  positionRivalsOf?: PositionRivalsOf | null;
  signalOptions?: DraftSignalOptions;
  /** Overrides the `eventId`-derived seed. Tests use this. */
  seed?: number | string;
}

// ---------------------------------------------------------------------------
// buildContext
// ---------------------------------------------------------------------------

/** Assemble the bounded Context for one Pick. */
export async function buildContext(
  pick: Pick,
  deps: BuildContextDeps = {},
): Promise<BuiltContext> {
  const config = deps.config ?? (await loadConfigSafely());
  const rules: Partial<ReactionRulesConfig> = { ...config?.reactionRules, ...deps.rules };

  const players = deps.players ?? (await loadPlayers());
  const starPlayers = deps.starPlayers ?? (await loadStarPlayers());
  const relationships = deps.relationships ?? (await loadRelationships());
  const state = deps.state ?? (await loadState());
  const runningJokes: RunningJoke[] = state?.activeRunningJokes ?? [];

  const recentMessages = (
    deps.recentMessages ?? (await readJsonlTail<LoungeMessage>(loungeMessagesFile, MAX_RECENT_MESSAGES))
  ).slice(-MAX_RECENT_MESSAGES);

  // Filtered rather than trusted: a caller handing over the whole draft must not
  // be able to leak a future Pick into the roster or the signals, which is how a
  // Message ends up referring to something that has not happened yet.
  const priorPicks = (deps.priorPicks ?? (await loadPriorPicks(pick, deps.pickFiles))).filter(
    (prior) => prior.draftId === pick.draftId && prior.pickNo < pick.pickNo,
  );
  const history = deps.history === undefined ? await loadHistoryModule() : deps.history;
  const playersModule = await loadPlayersModule(deps);
  const teammatesOf = playersModule.teammatesOf;
  const positionRivalsOf = playersModule.positionRivalsOf;

  // --- manager + roster so far ---------------------------------------------
  const manager: ContextManager = {
    managerId: pick.managerId,
    managerName: pick.managerName,
    roster: [
      ...(deps.managerRoster ??
        priorPicks
          .filter((prior) => prior.managerId === pick.managerId)
          .sort((a, b) => a.pickNo - b.pickNo)
          .map((prior) => prior.playerName)),
    ],
  };

  // --- who the Manager already owns in THIS draft ---------------------------
  // Their own fantasy team just changed, so they are candidate Speakers rather
  // than only a list of names in the prompt.
  const managerRosterDetail = currentRosterRefs(pick, priorPicks, players, manager.roster);

  // --- who is already off the board -----------------------------------------
  // Every Manager's picks, not just this one's: a drafted Regular is still in
  // the room, and this is the fact that keeps him from playing the passed-over
  // man for the rest of the draft.
  const offTheBoard = offTheBoardRefs(pick, priorPicks, players);

  // --- current NFL teammates of the drafted player --------------------------
  const nflTeammates = resolveNflTeammates(pick, players, teammatesOf);

  // --- Fantasy Memory --------------------------------------------------------
  const draftedPlayerHistory = safeHistoryFor(history, pick.playerId);

  const starMeta = resolveStarMeta(starPlayers, players);
  const relevance = buildRelevanceTable({
    pick,
    starPlayers,
    starMeta,
    relationships,
    history,
  });

  const fantasyTeammates2025 = historyRefs(
    draftedPlayerHistory?.lastSeason?.sharedRosterPlayerIds ?? [],
    players,
    pick.playerId,
  );
  const championshipTeammates = historyRefs(
    (draftedPlayerHistory?.championships ?? []).flatMap(
      (entry) => entry.sharedChampionPlayerIds ?? [],
    ),
    players,
    pick.playerId,
  );
  const positionRivals = mergeRefs(
    seededPositionRivals(pick, starPlayers, starMeta, relationships),
    datasetPositionRivals(pick, players, positionRivalsOf),
  );

  // --- draft signals ---------------------------------------------------------
  // Computed before actor selection: `positionDraftIndex` is what an Appearance
  // Gate such as "only the first few tight ends" is measured against.
  const signalDetail = computeDraftSignalDetail(pick, priorPicks, players, deps.signalOptions);

  // --- who is eligible to speak ---------------------------------------------
  const actors = selectActors({
    pick,
    seed: deps.seed ?? pick.eventId,
    regulars: starPlayers,
    starMeta,
    nflTeammates,
    currentRosterTeammates: managerRosterDetail,
    fantasyTeammates2025,
    championshipTeammates,
    positionRivals,
    runningJokes,
    relevance,
    rules,
    ...(signalDetail.positionDraftIndex !== undefined
      ? { positionDraftIndex: signalDetail.positionDraftIndex }
      : {}),
  });

  // --- Fantasy Memory for every candidate Speaker ---------------------------
  const speakerHistories: Record<string, PlayerHistory> = {};
  for (const actor of actors) {
    const entry = safeHistoryFor(history, actor.playerId);
    if (entry && hasAnyMemory(entry)) speakerHistories[actor.playerId] = entry;
  }
  if (draftedPlayerHistory && hasAnyMemory(draftedPlayerHistory)) {
    speakerHistories[pick.playerId] = draftedPlayerHistory;
  }

  const sharedRosters = computeSharedRosters(actors, speakerHistories);

  const draftSignals: DraftSignals = {};
  if (signalDetail.positionRun !== undefined) draftSignals.positionRun = signalDetail.positionRun;
  if (signalDetail.isStack !== undefined) draftSignals.isStack = signalDetail.isStack;
  if (signalDetail.fellBelowRank !== undefined) {
    draftSignals.fellBelowRank = signalDetail.fellBelowRank;
  }

  // `role === 'regular'` only, so this stays inside `maxRegularsPerReaction`.
  // A Regular selected as the NFL teammate is listed under `nflTeammates`.
  const regulars = actors
    .filter((actor): actor is SelectedActor & { star: StarPlayer } =>
      actor.role === 'regular' && actor.star !== undefined,
    )
    .map((actor) => actor.star);

  const context: BuiltContext = {
    pick,
    manager,
    nflTeammates: actors
      .filter((actor) => actor.role === 'nfl_teammate')
      .map((actor) => ({
        playerId: actor.playerId,
        name: actor.name,
        position: actor.position ?? null,
        nflTeam: actor.nflTeam ?? null,
      })),
    regulars,
    draftedPlayerHistory: draftedPlayerHistory ?? null,
    speakerHistories,
    recentMessages: [...recentMessages],
    runningJokes: relevantJokes(runningJokes, actors, starPlayers),
    draftSignals,
    simulated: pick.simulated === true,
    actors,
    managerRosterDetail,
    offTheBoard,
    signalDetail,
    sharedRosters,
    seed: typeof deps.seed === 'number' ? deps.seed : hashOf(deps.seed ?? pick.eventId),
  };

  // --- the boundary is enforced here, not in the prompt ---------------------
  // `assertNoForbiddenHistory` takes the histories themselves, so hand it every
  // record that is about to reach the prompt.
  history?.assertNoForbiddenHistory?.([
    ...(draftedPlayerHistory ? [draftedPlayerHistory] : []),
    ...Object.values(speakerHistories),
  ]);
  assertContextClean(context, {
    firstAllowedSeason:
      config?.historyRules.ignoreRosterHistoryBefore ?? FIRST_ALLOWED_HISTORY_SEASON,
  });

  return context;
}

// ---------------------------------------------------------------------------
// The §14 product rule, as an assertion
// ---------------------------------------------------------------------------

export class ForbiddenHistoryError extends Error {
  readonly violations: string[];
  constructor(violations: string[]) {
    super(
      `Context carries forbidden Fantasy Memory:\n${violations.map((v) => `  - ${v}`).join('\n')}`,
    );
    this.name = 'ForbiddenHistoryError';
    this.violations = violations;
  }
}

export interface AssertContextCleanOptions {
  /** Ordinary roster history before this season is forbidden. Default 2025. */
  firstAllowedSeason?: number;
}

/**
 * Throw if any history entry in the Context carries a season before 2025 unless
 * it is a championship record.
 *
 * §14 product rule: "no non-championship roster history before 2025 reaches the
 * prompt". Championship Membership is the single pre-2025 fact that survives
 * (CONTEXT.md), and every championship entry must carry a four-digit season so
 * the Director can satisfy the Season Literal rule.
 */
export function assertContextClean(
  context: ContextHistoryView,
  options: AssertContextCleanOptions = {},
): void {
  const firstAllowed = options.firstAllowedSeason ?? FIRST_ALLOWED_HISTORY_SEASON;
  const violations: string[] = [];

  const check = (label: string, entry: PlayerHistory | null | undefined): void => {
    if (!entry) return;
    const last = entry.lastSeason;
    if (last) {
      const season = Number(last.season);
      if (!Number.isFinite(season)) {
        violations.push(`${label}: roster history with a non-numeric season`);
      } else if (season < firstAllowed && last.champion !== true) {
        violations.push(
          `${label}: non-championship roster history from ${season} (only ${firstAllowed}+ is allowed)`,
        );
      }
    }
    for (const championship of entry.championships ?? []) {
      const season = Number((championship as ChampionshipEntry).season);
      if (!Number.isFinite(season) || season <= 0) {
        violations.push(
          `${label}: championship record without an explicit season (the Season Literal rule needs one)`,
        );
      }
    }
  };

  check(`drafted player`, context.draftedPlayerHistory);
  for (const [playerId, entry] of Object.entries(context.speakerHistories ?? {})) {
    check(`speaker ${playerId}`, entry);
  }

  if (context.recentMessages !== undefined && context.recentMessages.length > MAX_RECENT_MESSAGES) {
    violations.push(
      `recentMessages holds ${context.recentMessages.length} entries, the cap is ${MAX_RECENT_MESSAGES}`,
    );
  }

  if (violations.length > 0) throw new ForbiddenHistoryError(violations);
}

/** The subset of a Context `assertContextClean` actually inspects. */
export interface ContextHistoryView {
  draftedPlayerHistory?: PlayerHistory | null;
  speakerHistories?: Record<string, PlayerHistory>;
  recentMessages?: readonly LoungeMessage[];
}

// ---------------------------------------------------------------------------
// loading (all lazy, all optional)
// ---------------------------------------------------------------------------

async function loadConfigSafely(): Promise<AppConfig | undefined> {
  try {
    const { loadConfig } = await import('../config.js');
    return await loadConfig();
  } catch (error) {
    log.debug('context: no app config available', error);
    return undefined;
  }
}

async function loadPlayers(): Promise<Record<string, SleeperPlayer>> {
  const cached = await readJsonIfExists<Record<string, SleeperPlayer>>(playersCacheFile);
  return cached ?? {};
}

async function loadStarPlayers(): Promise<StarPlayer[]> {
  const file = await readJsonIfExists<StarPlayersFile>(starPlayersFile);
  return file?.players ?? [];
}

async function loadRelationships(): Promise<RelationshipsSeed | undefined> {
  return (await readJsonIfExists<RelationshipsSeed>(relationshipsSeedFile)) ?? undefined;
}

async function loadState(): Promise<LoungeState | undefined> {
  return (await readJsonIfExists<LoungeState>(loungeStateFile)) ?? undefined;
}

/**
 * Every Pick made before this one, from whichever board this Pick belongs to.
 *
 * BOTH FILES, ALWAYS. A live draft is recorded to `data/lounge/picks.jsonl` by
 * the watcher; a Simulation replays `data/simulation/picks.jsonl`. Reading only
 * one of them does not fail loudly — the `draftId` filter simply matches nothing
 * and the Context comes out as if this were the Manager's first pick of the
 * draft. That silently empties the roster, pins `positionDraftIndex` at 1 (so
 * the eighth receiver is announced as the first) and switches off every draft
 * signal, which leaves Fantasy Memory as the only material in the room. Read
 * both and let `draftId` decide.
 */
async function loadPriorPicks(
  pick: Pick,
  files: readonly string[] = [livePicksFile, simulationPicksFile],
): Promise<Pick[]> {
  const rows: Pick[] = [];
  for (const file of files) rows.push(...(await readJsonl<Pick>(file)));
  const byEvent = new Map<string, Pick>();
  for (const row of rows) {
    if (row.draftId !== pick.draftId || row.pickNo >= pick.pickNo) continue;
    // Both files can hold the same board after a handoff; first write wins.
    if (!byEvent.has(row.eventId)) byEvent.set(row.eventId, row);
  }
  return [...byEvent.values()].sort((a, b) => a.pickNo - b.pickNo);
}

/**
 * `src/history/index.ts` keeps its store in module-level state, so `loadHistory()`
 * must be awaited before `historyFor` will answer. Absence of the module — or of
 * the history files — is not an error: no Fantasy Memory is always a safe Context.
 */
async function loadHistoryModule(): Promise<HistoryModuleLike | null> {
  try {
    const mod = (await import('../history/index.js')) as HistoryModuleLike;
    await mod.loadHistory?.();
    return mod;
  } catch (error) {
    log.debug('context: history module unavailable, running without Fantasy Memory', error);
    return null;
  }
}

/** `src/import/players.ts` is owned by another agent; absence is not an error. */
async function loadPlayersModule(
  deps: BuildContextDeps,
): Promise<{ teammatesOf: TeammatesOf | null; positionRivalsOf: PositionRivalsOf | null }> {
  const needsTeammates = deps.teammatesOf === undefined;
  const needsRivals = deps.positionRivalsOf === undefined;
  let loaded: { teammatesOf?: TeammatesOf; positionRivals?: PositionRivalsOf } = {};
  if (needsTeammates || needsRivals) {
    try {
      loaded = (await import('../import/players.js')) as typeof loaded;
    } catch (error) {
      log.debug('context: players importer unavailable, deriving teammates locally', error);
    }
  }
  return {
    teammatesOf: needsTeammates ? loaded.teammatesOf ?? null : deps.teammatesOf ?? null,
    positionRivalsOf: needsRivals ? loaded.positionRivals ?? null : deps.positionRivalsOf ?? null,
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function resolveNflTeammates(
  pick: Pick,
  players: Record<string, SleeperPlayer>,
  teammatesOf: TeammatesOf | null,
): NflTeammate[] {
  if (teammatesOf) {
    try {
      const result = teammatesOf(pick.playerId, players, 8);
      if (Array.isArray(result)) {
        return result.filter((mate) => mate.playerId !== pick.playerId);
      }
    } catch (error) {
      log.debug('context: teammatesOf failed, falling back to local derivation', error);
    }
  }
  const team = pick.nflTeam?.trim().toUpperCase() ?? players[pick.playerId]?.team?.trim().toUpperCase();
  if (!team) return [];
  return Object.values(players)
    .filter(
      (entry) =>
        entry.player_id !== pick.playerId &&
        entry.active !== false &&
        (entry.team ?? '').toUpperCase() === team &&
        typeof displayName(entry) === 'string',
    )
    .sort((a, b) => (a.search_rank ?? 99999) - (b.search_rank ?? 99999))
    .slice(0, 8)
    .map((entry) => ({
      playerId: entry.player_id,
      name: displayName(entry),
      position: entry.position ?? null,
      nflTeam: entry.team ?? null,
    }));
}

function displayName(entry: SleeperPlayer): string {
  return (
    entry.full_name ??
    [entry.first_name, entry.last_name].filter(Boolean).join(' ') ??
    entry.player_id
  );
}

/** Map each Regular onto their live Sleeper metadata, by name. */
export function resolveStarMeta(
  starPlayers: readonly StarPlayer[],
  players: Record<string, SleeperPlayer>,
): Record<string, Partial<ActorRef>> {
  const byName = new Map<string, SleeperPlayer>();
  for (const entry of Object.values(players)) {
    const name = displayName(entry);
    if (!name) continue;
    const key = normalizeName(name);
    const existing = byName.get(key);
    // Prefer the better-ranked, active entry when Sleeper has duplicates.
    if (!existing || (entry.search_rank ?? 99999) < (existing.search_rank ?? 99999)) {
      byName.set(key, entry);
    }
  }
  const out: Record<string, Partial<ActorRef>> = {};
  for (const star of starPlayers) {
    const match = byName.get(normalizeName(star.name));
    out[star.key] = match
      ? {
          playerId: match.player_id,
          name: star.name,
          position: match.position ?? star.position,
          nflTeam: match.team ?? null,
        }
      : { playerId: starPseudoId(star.key), name: star.name, position: star.position };
  }
  return out;
}

interface RelevanceInput {
  pick: Pick;
  starPlayers: readonly StarPlayer[];
  starMeta: Record<string, Partial<ActorRef>>;
  relationships: RelationshipsSeed | undefined;
  history: HistoryModuleLike | null;
}

/**
 * Relevance flags per Regular. Every flag here can only *raise* a Regular's
 * odds — none of them decides whether a Regular is considered at all.
 */
function buildRelevanceTable(input: RelevanceInput): Record<string, Partial<ActorRelevance>> {
  const { pick, starPlayers, starMeta, relationships, history } = input;
  const draftedStarKey = starPlayers.find(
    (star) => normalizeName(star.name) === normalizeName(pick.playerName),
  )?.key;

  const table: Record<string, Partial<ActorRelevance>> = {};
  for (const star of starPlayers) {
    const meta = starMeta[star.key];
    const playerId = meta?.playerId ?? starPseudoId(star.key);
    const entry: Partial<ActorRelevance> = {
      isRequiredRegular: star.required,
    };
    if (truthy(history?.sharedRoster2025?.(pick.playerId, playerId))) {
      entry.sharedRoster2025 = true;
    }
    if (truthy(history?.sharedChampionship?.(pick.playerId, playerId))) {
      entry.sharedChampionship = true;
    }
    if (draftedStarKey && isSeededRival(relationships, draftedStarKey, star.key)) {
      entry.isPositionRival = true;
    }
    table[star.key] = entry;
    table[playerId] = entry;
  }
  return table;
}

function isSeededRival(
  relationships: RelationshipsSeed | undefined,
  a: string,
  b: string,
): boolean {
  if (!relationships || a === b) return false;
  return relationships.relationships.some(
    (rel) =>
      rel.types.includes('position_rivals') &&
      rel.players.includes(a) &&
      rel.players.includes(b),
  );
}

function seededPositionRivals(
  pick: Pick,
  starPlayers: readonly StarPlayer[],
  starMeta: Record<string, Partial<ActorRef>>,
  relationships: RelationshipsSeed | undefined,
): ActorRef[] {
  const draftedStarKey = starPlayers.find(
    (star) => normalizeName(star.name) === normalizeName(pick.playerName),
  )?.key;
  if (!draftedStarKey || !relationships) return [];
  const rivalKeys = new Set<string>();
  for (const rel of relationships.relationships) {
    if (!rel.types.includes('position_rivals')) continue;
    if (!rel.players.includes(draftedStarKey)) continue;
    for (const key of rel.players) if (key !== draftedStarKey) rivalKeys.add(key);
  }
  const out: ActorRef[] = [];
  for (const key of rivalKeys) {
    const star = starPlayers.find((entry) => entry.key === key);
    if (!star) continue;
    const meta = starMeta[key];
    out.push({
      playerId: meta?.playerId ?? starPseudoId(key),
      name: star.name,
      position: meta?.position ?? star.position,
      nflTeam: meta?.nflTeam ?? null,
    });
  }
  return out;
}

/** Position rivals drawn from the live Sleeper dataset, when the importer offers them. */
function datasetPositionRivals(
  pick: Pick,
  players: Record<string, SleeperPlayer>,
  positionRivalsOf: PositionRivalsOf | null,
): ActorRef[] {
  if (!positionRivalsOf) return [];
  try {
    const rivals = positionRivalsOf(pick.playerId, players, 5);
    if (!Array.isArray(rivals)) return [];
    return rivals
      .filter((rival) => rival.playerId !== pick.playerId)
      .map((rival) => ({
        playerId: rival.playerId,
        name: rival.name,
        position: rival.position ?? null,
        nflTeam: rival.nflTeam ?? null,
      }));
  } catch (error) {
    log.debug('context: positionRivals failed', error);
    return [];
  }
}

/** Concatenate ActorRef lists, keeping the first entry for each player id. */
function mergeRefs(...lists: ActorRef[][]): ActorRef[] {
  const seen = new Set<string>();
  const out: ActorRef[] = [];
  for (const list of lists) {
    for (const ref of list) {
      if (seen.has(ref.playerId)) continue;
      seen.add(ref.playerId);
      out.push(ref);
    }
  }
  return out;
}

/**
 * Resolve the Manager's roster so far into candidate Speakers.
 *
 * Prior Picks already carry name, position and NFL team, so this needs no
 * Sleeper lookup; `players` only fills a gap. `rosterNames` is the authority on
 * order and membership, so an injected `managerRoster` (tests, replays) behaves
 * exactly like one derived from the Picks.
 */
/** Every prior Pick as an `OffTheBoardRef`, oldest first. */
function offTheBoardRefs(
  pick: Pick,
  priorPicks: readonly Pick[],
  players: Record<string, SleeperPlayer>,
): OffTheBoardRef[] {
  const out: OffTheBoardRef[] = [];
  for (const prior of priorPicks) {
    if (prior.playerId === pick.playerId) continue;
    const entry = players[prior.playerId];
    out.push({
      playerId: prior.playerId,
      name: prior.playerName,
      position: prior.position ?? entry?.position ?? null,
      nflTeam: prior.nflTeam ?? entry?.team ?? null,
      pickNo: prior.pickNo,
      managerName: prior.managerName,
    });
  }
  return out.sort((a, b) => a.pickNo - b.pickNo);
}

function currentRosterRefs(
  pick: Pick,
  priorPicks: readonly Pick[],
  players: Record<string, SleeperPlayer>,
  rosterNames: readonly string[],
): ActorRef[] {
  const wanted = rosterNames.map((name) => normalizeName(name));
  if (wanted.length === 0) return [];
  const byName = new Map<string, ActorRef>();
  for (const prior of priorPicks) {
    if (prior.managerId !== pick.managerId) continue;
    if (prior.playerId === pick.playerId) continue;
    const entry = players[prior.playerId];
    byName.set(normalizeName(prior.playerName), {
      playerId: prior.playerId,
      name: prior.playerName,
      position: prior.position ?? entry?.position ?? null,
      nflTeam: prior.nflTeam ?? entry?.team ?? null,
    });
  }
  const out: ActorRef[] = [];
  for (const key of wanted) {
    const ref = byName.get(key);
    if (ref) out.push(ref);
  }
  return out;
}

function historyRefs(
  playerIds: readonly string[],
  players: Record<string, SleeperPlayer>,
  excludePlayerId: string,
): ActorRef[] {
  const seen = new Set<string>([excludePlayerId]);
  const out: ActorRef[] = [];
  for (const playerId of playerIds) {
    if (seen.has(playerId)) continue;
    seen.add(playerId);
    const entry = players[playerId];
    if (!entry) continue;
    out.push({
      playerId,
      name: displayName(entry),
      position: entry.position ?? null,
      nflTeam: entry.team ?? null,
    });
  }
  return out;
}

/**
 * Only jokes with a live participant in the room, plus persistent jokes.
 *
 * The one exception is a persistent joke that belongs to a gated Regular: when
 * the gate kept him out, his lore stays out with him. Leaving it in the Context
 * hands the joke to whoever else is in the room, which is the same over-exposure
 * the gate exists to stop — Justin Jefferson counting tight ends on Kyle Pitts'
 * behalf is still a Kyle Pitts joke.
 */
function relevantJokes(
  jokes: readonly RunningJoke[],
  actors: readonly SelectedActor[],
  starPlayers: readonly StarPlayer[] = [],
): RunningJoke[] {
  const present = new Set<string>();
  for (const actor of actors) {
    present.add(actor.playerId);
    if (actor.starKey) present.add(actor.starKey);
  }
  const gatedKeys = new Set(
    starPlayers.filter((star) => star.appearance !== undefined).map((star) => star.key),
  );
  return jokes.filter((joke) => {
    if (joke.participants.some((participant) => present.has(participant))) return true;
    if (joke.persistent !== true) return false;
    // Persistent, but nobody is here to carry it: drop it if every participant
    // is a gated Regular the gate excluded from this Pick.
    const gatedOut =
      joke.participants.length > 0 &&
      joke.participants.every((participant) => gatedKeys.has(participant));
    return !gatedOut;
  });
}

/** 2025 and championship roster ties between the candidate Speakers themselves. */
function computeSharedRosters(
  actors: readonly SelectedActor[],
  histories: Record<string, PlayerHistory>,
): SharedRosterLink[] {
  const links: SharedRosterLink[] = [];
  const nameOf = new Map(actors.map((actor) => [actor.playerId, actor.name]));
  for (let i = 0; i < actors.length; i += 1) {
    for (let j = i + 1; j < actors.length; j += 1) {
      const a = actors[i];
      const b = actors[j];
      if (!a || !b) continue;
      const ha = histories[a.playerId];
      const hb = histories[b.playerId];
      if (!ha || !hb) continue;
      if (
        ha.lastSeason &&
        hb.lastSeason &&
        ha.lastSeason.managerId === hb.lastSeason.managerId
      ) {
        links.push({
          season: ha.lastSeason.season,
          kind: 'roster_2025',
          aPlayerId: a.playerId,
          aName: nameOf.get(a.playerId) ?? a.name,
          bPlayerId: b.playerId,
          bName: nameOf.get(b.playerId) ?? b.name,
          managerName: ha.lastSeason.managerName,
        });
      }
      for (const ca of ha.championships ?? []) {
        for (const cb of hb.championships ?? []) {
          if (ca.season === cb.season && ca.managerId === cb.managerId) {
            links.push({
              season: ca.season,
              kind: 'championship',
              aPlayerId: a.playerId,
              aName: a.name,
              bPlayerId: b.playerId,
              bName: b.name,
              managerName: ca.managerName,
            });
          }
        }
      }
    }
  }
  return links;
}

function hasAnyMemory(entry: PlayerHistory): boolean {
  return entry.lastSeason !== null || (entry.championships ?? []).length > 0;
}

function safeHistoryFor(
  history: HistoryModuleLike | null,
  playerId: string,
): PlayerHistory | null {
  if (!history?.historyFor) return null;
  try {
    return history.historyFor(playerId) ?? null;
  } catch (error) {
    log.debug(`context: historyFor(${playerId}) failed`, error);
    return null;
  }
}

function truthy(value: unknown): boolean {
  if (value === true) return true;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object' && value !== null) return true;
  if (typeof value === 'number') return value > 0;
  return false;
}

function hashOf(value: number | string): number {
  if (typeof value === 'number') return value;
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
