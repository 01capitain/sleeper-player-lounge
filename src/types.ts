/**
 * Domain types for the Players Lounge.
 *
 * Terminology follows CONTEXT.md exactly: Pick, Reaction, Message, Speaker,
 * Manager, Director, Context, Regular, Fantasy Memory, Championship Membership,
 * Simulation, Manager Alias, League Lore.
 *
 * The JSON-schema-backed types (`Pick`, `Reaction`, `PlayerHistory`) mirror
 * `schemas/*.schema.json`. Raw Sleeper wire shapes live in `src/sleeper/types.ts`
 * and must not leak in here; the single exception is `SleeperPlayer`, which is the
 * cached players dataset entry every layer reads.
 */

/** Allows a known literal union while still accepting future values from data files. */
type Open<T extends string> = T | (string & {});

// ---------------------------------------------------------------------------
// Pick — schemas/pick.schema.json
// ---------------------------------------------------------------------------

/**
 * A single normalized selection made in a Sleeper draft.
 * `eventId` is always `{draftId}:{pickNo}:{playerId}`.
 */
export interface Pick {
  eventId: string;
  season: number;
  leagueId: string;
  draftId: string;
  pickNo: number;
  round?: number | null;
  draftSlot?: number | null;
  playerId: string;
  playerName: string;
  position?: string | null;
  nflTeam?: string | null;
  managerId: string;
  managerName: string;
  pickedAt?: string | null;
  /** True when this Pick comes from a replayed Simulation draft. */
  simulated?: boolean;
  /** True when this Pick was fabricated for renderer/director testing only. */
  synthetic?: boolean;
}

// ---------------------------------------------------------------------------
// Reaction — schemas/reaction.schema.json
// ---------------------------------------------------------------------------

/** Why a Message is present. Mirrors the schema's `reason` enum exactly. */
export type ReactionReason =
  | 'drafted_player'
  | 'nfl_teammate'
  | 'star_regular'
  | 'position_rival'
  | 'fantasy_2025_history'
  | 'championship_history'
  | 'running_joke'
  | 'stack'
  | 'reach'
  | 'fall'
  | 'other';

/** The condensed Pick echoed back inside a Reaction. */
export interface ReactionPick {
  season: number;
  pickNo: number;
  round?: number | null;
  playerId: string;
  playerName: string;
  managerName: string;
}

/** One chat bubble inside a Reaction. `text` is capped at 280 chars by the schema. */
export interface ReactionMessage {
  speakerPlayerId: string;
  speakerName: string;
  text: string;
  /** Reveal offset in ms, 0..7000. */
  delayMs: number;
  reason: ReactionReason;
  historyRefs?: string[];
}

/** The Director's complete answer to one Pick. 1..6 Messages. */
export interface Reaction {
  eventId: string;
  pick: ReactionPick;
  reactions: ReactionMessage[];
}

// ---------------------------------------------------------------------------
// Fantasy Memory — schemas/player-history.schema.json
// ---------------------------------------------------------------------------

/** Deterministic 2025 performance classification. */
export type PerformanceLabel =
  | 'excellent'
  | 'good'
  | 'neutral'
  | 'disappointing'
  | 'disaster';

/** A player's 2025 fantasy-roster history. 2025 is the only ordinary-history season. */
export interface LastSeasonHistory {
  season: 2025;
  managerId: string;
  managerName: string;
  performance: PerformanceLabel;
  teamFinish?: number | null;
  champion?: boolean;
  sharedRosterPlayerIds?: string[];
}

/** Championship Membership: the only pre-2025 fact that survives into Fantasy Memory. */
export interface ChampionshipEntry {
  season: number;
  managerId: string;
  managerName: string;
  sharedChampionPlayerIds?: string[];
}

/** The complete Fantasy Memory available to one Speaker. */
export interface PlayerHistory {
  playerId: string;
  lastSeason: LastSeasonHistory | null;
  championships: ChampionshipEntry[];
}

/** `data/fantasy-history/last-season.json` — the 2025 import, keyed by player id. */
export interface LastSeasonFile {
  season: number;
  sourceLeagueId: string | null;
  generatedAt: string | null;
  players: Record<
    string,
    {
      managerId: string;
      managerName: string;
      teamFinish?: number | null;
      champion?: boolean;
      performance: PerformanceLabel;
      sharedRosterPlayerIds?: string[];
    }
  >;
}

/** `data/fantasy-history/champions.json` — championship rosters for every available season. */
export interface ChampionsFile {
  generatedAt: string | null;
  championshipRosters: Record<
    string,
    {
      season: number;
      leagueId?: string;
      managerId: string;
      managerName: string;
      playerIds: string[];
    }
  >;
}

/** `data/fantasy-history/performance-overrides.json` — manual classifier overrides. */
export type PerformanceOverrides = Record<string, PerformanceLabel>;

// ---------------------------------------------------------------------------
// Regulars — data/players/star-players.json
// ---------------------------------------------------------------------------

/**
 * A Regular: a recurring cast member with a persistent personality profile.
 * `leagueLore` and `guardrails` are present on some entries only.
 */
export interface StarPlayer {
  /** Stable snake_case handle, e.g. `kyle_pitts`. Not a Sleeper player id. */
  key: string;
  name: string;
  position: Open<'QB' | 'RB' | 'WR' | 'TE'>;
  /** Required Regulars (Rodgers, Kelce, Pitts) must always be castable. */
  required: boolean;
  /** 0..1 chattiness weight used by actor selection. */
  activity: number;
  voice: string[];
  hooks: string[];
  /** League-specific running lore, e.g. Kyle Pitts' bust reputation. */
  leagueLore?: string[];
  guardrails?: string[];
}

/** The whole `star-players.json` file. */
export interface StarPlayersFile {
  version: number;
  description?: string;
  players: StarPlayer[];
}

// ---------------------------------------------------------------------------
// Relationships — data/players/relationships.seed.json
// ---------------------------------------------------------------------------

export type RelationshipType = Open<'nfl_teammates' | 'position_rivals' | 'lounge_banter'>;

/** A seeded relationship between two (or more) Regulars, keyed by StarPlayer.key. */
export interface Relationship {
  players: string[];
  types: RelationshipType[];
  /** 0..1 — how much they like each other. */
  affinity: number;
  /** 0..1 — how much they wind each other up. */
  banter: number;
  topics: string[];
}

export interface RelationshipsSeed {
  version: number;
  relationships: Relationship[];
  note?: string;
}

// ---------------------------------------------------------------------------
// Lounge state — data/lounge/state.json
// ---------------------------------------------------------------------------

export interface RunningJoke {
  id: string;
  topic: string;
  /** 0..1 — how live the joke currently is. */
  strength: number;
  /** StarPlayer keys or Sleeper player ids. */
  participants: string[];
  /** Persistent jokes (e.g. League Lore) never decay out of the Context. */
  persistent?: boolean;
}

export interface Rivalry {
  id: string;
  participants: string[];
  topic?: string;
  strength?: number;
  persistent?: boolean;
}

export interface LoungeState {
  season: number;
  lastProcessedPickNo: number;
  activeRunningJokes: RunningJoke[];
  activeRivalries: Rivalry[];
  recentTone: string;
}

// ---------------------------------------------------------------------------
// App config — data/config/app.json
// ---------------------------------------------------------------------------

export interface SleeperConfig {
  username: string;
  userId: string;
  targetLeagueName: string;
  targetLeagueStatus: Open<'pre_draft' | 'drafting' | 'in_season' | 'complete'>;
  simulationStrategy: string;
}

export interface HistoryRulesConfig {
  lastSeason: number;
  ignoreRosterHistoryBefore: number;
  preserveChampionshipRostersAllYears: boolean;
  explicitSeasonMentionRequired: boolean;
}

export interface ReactionRulesConfig {
  draftedPlayerMustReact: boolean;
  includeRelevantCurrentTeammates: boolean;
  minMessages: number;
  targetMessages: number;
  maxMessages: number;
  maxRegularsPerReaction: number;
  allowNoOptionalStarReaction: boolean;
}

export type RenderFormat = 'png' | 'gif' | 'mp4' | 'html';

export interface RenderingConfig {
  defaultFormat: RenderFormat;
  supportedFormats: RenderFormat[];
  defaultAspectRatio: string;
  defaultDurationSeconds: number;
  showTypingIndicators: boolean;
  fictionalInterfaceBranding: boolean;
  watermark: string;
}

export interface AppConfig {
  appName: string;
  season: number;
  sleeper: SleeperConfig;
  historyRules: HistoryRulesConfig;
  reactionRules: ReactionRulesConfig;
  rendering: RenderingConfig;
}

// ---------------------------------------------------------------------------
// Simulation — data/simulation/*
// ---------------------------------------------------------------------------

export type DraftStatus = Open<'pre_draft' | 'drafting' | 'paused' | 'complete'>;
export type DraftType = Open<'snake' | 'linear' | 'auction'>;

/** `data/simulation/selected-draft.json` — the auto-selected Simulation draft. */
export interface SelectedDraft {
  leagueId: string;
  leagueName: string;
  draftId: string;
  season: number;
  status: DraftStatus;
  type: DraftType;
  rounds: number;
  teams: number;
  /** ISO timestamp of when the selection was made. */
  selectedAt: string;
  totalPicks: number;
}

/**
 * Manager Alias: the optional deterministic overlay mapping Simulation draft
 * slots onto target-league Managers. Keys are draft slot numbers as strings.
 */
export interface ManagerAliasMap {
  version: number;
  sourceDraftId: string;
  targetLeagueId: string;
  targetLeagueName: string;
  slots: Record<string, { managerId: string; managerName: string }>;
}

// ---------------------------------------------------------------------------
// Sleeper players dataset (the only wire-shaped type we keep here)
// ---------------------------------------------------------------------------

/** The fields we use from Sleeper's `/players/nfl` dataset. */
export interface SleeperPlayer {
  player_id: string;
  full_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  position?: string | null;
  team?: string | null;
  active?: boolean;
  fantasy_positions?: string[] | null;
  search_rank?: number | null;
  /**
   * Average draft position, merged in from `data/players/adp.json`.
   * Absent means UNRANKED, never "very late".
   */
  adp?: number;
  /**
   * Position on the team's current depth chart. Null for players no longer on a
   * roster — the only trustworthy "is he still on the team" signal, since
   * `active` and `status` stay true for retired players.
   */
  depth_chart_order?: number | null;
}

// ---------------------------------------------------------------------------
// Lounge transcript — data/lounge/messages.jsonl
// ---------------------------------------------------------------------------

/** One persisted line of Lounge dialogue. */
export interface LoungeMessage {
  eventId: string;
  /** Monotonic sequence across the whole transcript, for stable ordering. */
  seq: number;
  speakerPlayerId: string;
  speakerName: string;
  text: string;
  reason: ReactionReason;
  historyRefs?: string[];
  createdAt: string;
  simulated: boolean;
}

// ---------------------------------------------------------------------------
// Context — the bundle handed to the Director
// ---------------------------------------------------------------------------

/** The drafting Manager plus the roster they have already drafted, as player names. */
export interface ContextManager {
  managerId: string;
  managerName: string;
  /** Player names already drafted by this Manager, most recent last. */
  roster: string[];
}

/** A current NFL teammate of the drafted player, offered as a candidate Speaker. */
export interface NflTeammate {
  playerId: string;
  name: string;
  position?: string | null;
  nflTeam?: string | null;
}

/** Cheap, deterministic draft observations the Director may riff on. */
export interface DraftSignals {
  /** e.g. `"RB"` when several backs went in a row. */
  positionRun?: string;
  /** True when the Pick stacks with a QB the Manager already owns. */
  isStack?: boolean;
  /** How far the player fell below his `search_rank`, in picks. */
  fellBelowRank?: number;
  /** How far ahead of his `search_rank` the player was taken, in picks. */
  reachedAboveRank?: number;
}

/**
 * The compact, deliberately bounded bundle assembled for one Pick.
 * What is absent from the Context cannot be said.
 */
export interface LoungeContext {
  pick: Pick;
  manager: ContextManager;
  nflTeammates: NflTeammate[];
  /** 0–3 selected Regulars. */
  regulars: StarPlayer[];
  draftedPlayerHistory: PlayerHistory | null;
  /** Fantasy Memory for every candidate Speaker, keyed by Sleeper player id. */
  speakerHistories: Record<string, PlayerHistory>;
  /** The last ~20 Lounge Messages. */
  recentMessages: LoungeMessage[];
  runningJokes: RunningJoke[];
  draftSignals: DraftSignals;
  simulated: boolean;
}

// ---------------------------------------------------------------------------
// Director
// ---------------------------------------------------------------------------

/**
 * Turns a Context into a validated Reaction.
 * Implemented today by a `claude -p` subprocess (see ADR 0001); the interface
 * exists so an HTTP adapter can replace it without touching the context builder.
 */
export interface LoungeDirector {
  generateReaction(context: LoungeContext): Promise<Reaction>;
}
