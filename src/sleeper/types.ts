/**
 * Raw Sleeper wire shapes.
 *
 * These are snake_case exactly as the public API returns them and must stay
 * inside `src/sleeper/`. Everything outside this directory works with the
 * normalized domain types in `src/types.ts`.
 *
 * Sleeper's API is loosely typed and adds fields freely, so every field that is
 * not guaranteed by the endpoints we call is optional and/or nullable.
 */

export interface SleeperUser {
  user_id: string;
  username?: string | null;
  display_name?: string | null;
  avatar?: string | null;
  metadata?: Record<string, string | null> | null;
  is_owner?: boolean | null;
}

export interface SleeperLeague {
  league_id: string;
  name: string;
  /** Sleeper returns the season as a string, e.g. `"2026"`. */
  season: string;
  season_type?: string | null;
  sport?: string | null;
  status: string;
  total_rosters: number;
  previous_league_id?: string | null;
  draft_id?: string | null;
  settings?: Record<string, number> | null;
  scoring_settings?: Record<string, number> | null;
  roster_positions?: string[] | null;
  metadata?: Record<string, string | null> | null;
  avatar?: string | null;
}

export interface SleeperRoster {
  roster_id: number;
  owner_id: string | null;
  league_id: string;
  co_owners?: string[] | null;
  players?: string[] | null;
  starters?: string[] | null;
  reserve?: string[] | null;
  taxi?: string[] | null;
  settings?: Record<string, number> | null;
  metadata?: Record<string, string | null> | null;
}

export interface SleeperDraft {
  draft_id: string;
  league_id: string | null;
  /** `pre_draft` | `drafting` | `paused` | `complete` */
  status: string;
  /** `snake` | `linear` | `auction` */
  type: string;
  /** Season as a string, e.g. `"2026"`. */
  season: string;
  season_type?: string | null;
  sport?: string | null;
  start_time?: number | null;
  created?: number | null;
  last_picked?: number | null;
  settings?: {
    rounds?: number;
    teams?: number;
    slots_qb?: number;
    [key: string]: number | undefined;
  } | null;
  /** Draft slot number (as string) -> Sleeper user id. */
  draft_order?: Record<string, number> | null;
  /** Sleeper user id -> draft slot number. */
  slot_to_roster_id?: Record<string, number> | null;
  metadata?: Record<string, string | null> | null;
}

export interface SleeperDraftPickMetadata {
  first_name?: string;
  last_name?: string;
  position?: string;
  team?: string;
  status?: string;
  years_exp?: string;
  player_id?: string;
  [key: string]: string | undefined;
}

export interface SleeperDraftPick {
  draft_id: string;
  player_id: string;
  /** Overall pick number, 1-based. */
  pick_no: number;
  round: number;
  draft_slot: number;
  roster_id?: number | null;
  /** Sleeper user id of the drafting Manager. Null in some auto-drafted rows. */
  picked_by?: string | null;
  is_keeper?: boolean | null;
  metadata?: SleeperDraftPickMetadata | null;
}

/** One node of `/league/{id}/winners_bracket`. */
export interface SleeperBracketMatch {
  /** Match id within the bracket. */
  m: number;
  /** Round number. */
  r: number;
  /** Roster id of team 1, or a reference to another match. */
  t1?: number | { w?: number; l?: number } | null;
  t2?: number | { w?: number; l?: number } | null;
  /** Winning roster id, once decided. */
  w?: number | null;
  /** Losing roster id, once decided. */
  l?: number | null;
  /** Placement this match decides, e.g. 1 for the championship. */
  p?: number | null;
  t1_from?: { w?: number; l?: number } | null;
  t2_from?: { w?: number; l?: number } | null;
}

/** One roster's line in `/league/{id}/matchups/{week}`. */
export interface SleeperMatchup {
  roster_id: number;
  matchup_id: number | null;
  points: number | null;
  custom_points?: number | null;
  players?: string[] | null;
  starters?: string[] | null;
  /** Exact per-player points in this league's own scoring. */
  players_points?: Record<string, number> | null;
  starters_points?: number[] | null;
}
