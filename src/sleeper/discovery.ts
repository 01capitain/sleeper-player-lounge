/**
 * Simulation draft discovery — implementation_plan.md §6.
 *
 * The target league (`hotelkit Fantasies`) is `pre_draft`, so it produces no
 * Picks to react to. Rather than hardcoding a Simulation league id, we ask
 * Sleeper which of the operator's leagues for the configured season already has
 * a finished draft and replay that one (ADR 0002).
 *
 * Nothing here writes to disk; `src/cli/commands/setup.ts` owns persistence.
 */
import type { AppConfig, DraftStatus, DraftType, SelectedDraft } from '../types.js';
import { log } from '../util/log.js';
import type { SleeperClient } from './client.js';
import type { SleeperDraft, SleeperDraftPick, SleeperLeague } from './types.js';

/** Freshness for discovery calls. `0` forces a live fetch (used by `setup --force`). */
export interface DiscoveryOptions {
  ttlMs?: number;
}

/** A completed draft that survived every filter, kept together with its picks. */
export interface DraftCandidate {
  league: SleeperLeague;
  draft: SleeperDraft;
  pickCount: number;
  /** The epoch-ms timestamp this candidate is ranked by. See `completionKey`. */
  completedAt: number;
}

/**
 * The timestamp a completed draft is ranked by, most-recent-first.
 *
 * Preference order, and why:
 * 1. `last_picked` — epoch ms of the final pick, i.e. the moment the draft
 *    actually finished. This is the only field that means "completed at".
 * 2. `start_time` — epoch ms the draft opened. A slow draft can run for weeks,
 *    so this is a weaker signal, but it still orders drafts sensibly.
 * 3. `created` — epoch ms the draft object was created.
 * 4. `0` — no timestamp at all; the draft_id tie-break below decides.
 *
 * Ties (equal keys, or several drafts with no timestamps) are broken by
 * descending `draft_id`: Sleeper ids are monotonically increasing snowflakes,
 * so the larger id is the newer draft. That keeps selection deterministic.
 */
export function completionKey(draft: SleeperDraft): number {
  const candidates = [draft.last_picked, draft.start_time, draft.created];
  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

/** Descending by completion time, then by draft id. Newest qualifying draft first. */
export function compareCandidates(a: DraftCandidate, b: DraftCandidate): number {
  if (b.completedAt !== a.completedAt) return b.completedAt - a.completedAt;
  return compareIdsDesc(a.draft.draft_id, b.draft.draft_id);
}

/** Snowflake ids are numeric strings: longer wins, then lexicographic. */
function compareIdsDesc(a: string, b: string): number {
  if (a.length !== b.length) return b.length - a.length;
  return b < a ? -1 : b > a ? 1 : 0;
}

function sameLeagueName(a: string | null | undefined, b: string): boolean {
  return (a ?? '').trim().toLowerCase() === b.trim().toLowerCase();
}

/** Sleeper reports the season as the string `"2026"`; the domain type wants a number. */
export function coerceSeason(value: string | number | null | undefined, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/**
 * The target league for `config.season`, or `null` when the operator is not in
 * it yet. The live watcher uses this; discovery uses it only to know which
 * league to exclude.
 */
export async function findTargetLeague(
  client: SleeperClient,
  config: AppConfig,
  opts: DiscoveryOptions = {},
): Promise<SleeperLeague | null> {
  const leagues = await client.getUserLeagues(
    config.sleeper.userId,
    'nfl',
    String(config.season),
    opts,
  );
  return (
    leagues.find((league) => sameLeagueName(league.name, config.sleeper.targetLeagueName)) ?? null
  );
}

/**
 * Pick the Simulation draft, following implementation_plan.md §6 exactly:
 *
 * 1. the user's leagues for `config.season`
 * 2. every draft of every league
 * 3. keep `status === 'complete'` drafts that have at least one pick
 * 4. drop the target league while it is still `pre_draft`
 * 5. prefer the most recently completed draft (see `completionKey`)
 *
 * Throws an error naming every league it looked at when nothing qualifies.
 */
export async function discoverSimulationDraft(
  client: SleeperClient,
  config: AppConfig,
  opts: DiscoveryOptions = {},
): Promise<SelectedDraft> {
  const { userId, targetLeagueName } = config.sleeper;
  const leagues = await client.getUserLeagues(userId, 'nfl', String(config.season), opts);

  if (leagues.length === 0) {
    throw new Error(
      `No ${config.season} NFL leagues found for Sleeper user ${userId} ` +
        `(${config.sleeper.username}). Check 'sleeper.userId' and 'season' in data/config/app.json.`,
    );
  }

  const candidates: DraftCandidate[] = [];
  const rejections: string[] = [];

  for (const league of leagues) {
    const isTarget = sameLeagueName(league.name, targetLeagueName);

    // Step 4: the target league is excluded for as long as it is pre-draft. Once
    // it starts drafting it is a legitimate source like any other league.
    if (isTarget && league.status === 'pre_draft') {
      rejections.push(`${league.name}: target league, still pre_draft`);
      continue;
    }

    let drafts: SleeperDraft[];
    try {
      drafts = await client.getLeagueDrafts(league.league_id, opts);
    } catch (error) {
      log.warn('could not list drafts for league', league.name, error);
      rejections.push(`${league.name}: drafts could not be listed`);
      continue;
    }

    for (const draft of drafts) {
      if (draft.status !== 'complete') {
        rejections.push(`${league.name} draft ${draft.draft_id}: status '${draft.status}'`);
        continue;
      }

      let picks: SleeperDraftPick[];
      try {
        picks = await client.getDraftPicks(draft.draft_id, opts);
      } catch (error) {
        log.warn('could not fetch picks for draft', draft.draft_id, error);
        rejections.push(`${league.name} draft ${draft.draft_id}: picks could not be fetched`);
        continue;
      }

      if (picks.length === 0) {
        rejections.push(`${league.name} draft ${draft.draft_id}: complete but has no picks`);
        continue;
      }

      candidates.push({
        league,
        draft,
        pickCount: picks.length,
        completedAt: completionKey(draft),
      });
    }
  }

  if (candidates.length === 0) {
    throw new Error(
      `No completed ${config.season} draft is available to simulate.\n` +
        `Looked at ${leagues.length} league(s):\n` +
        rejections.map((line) => `  - ${line}`).join('\n') +
        `\nEither wait for a draft to complete, or run setup again once ` +
        `'${targetLeagueName}' has started drafting.`,
    );
  }

  candidates.sort(compareCandidates);
  const chosen = candidates[0] as DraftCandidate;

  if (candidates.length > 1) {
    log.info(
      `selected the most recently completed of ${candidates.length} drafts:`,
      `${chosen.league.name} (${chosen.draft.draft_id})`,
    );
  }

  return toSelectedDraft(chosen, config);
}

/** Project a winning candidate onto the persisted `selected-draft.json` shape. */
export function toSelectedDraft(candidate: DraftCandidate, config: AppConfig): SelectedDraft {
  const { league, draft } = candidate;
  const settings = draft.settings ?? {};
  const slotCount = Object.keys(draft.slot_to_roster_id ?? {}).length;

  return {
    leagueId: league.league_id,
    leagueName: league.name,
    draftId: draft.draft_id,
    // Sleeper returns "2026"; SelectedDraft.season is a number.
    season: coerceSeason(draft.season, coerceSeason(league.season, config.season)),
    status: draft.status as DraftStatus,
    type: draft.type as DraftType,
    rounds: settings.rounds ?? 0,
    teams: settings.teams ?? (slotCount > 0 ? slotCount : (league.total_rosters ?? 0)),
    selectedAt: new Date().toISOString(),
    totalPicks: candidate.pickCount,
  };
}
