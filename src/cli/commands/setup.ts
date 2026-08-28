/**
 * `lounge setup` — implementation_plan.md §6.
 *
 * Discovers a completed 2026 draft to simulate, normalizes its Picks and builds
 * the Manager Alias overlay. Everything it learns lands in files
 * (`selected-draft.json`, `picks.jsonl`, `manager-alias.json`) so every later
 * command can run without re-discovering anything.
 *
 * stdout carries the human-readable summary only; all diagnostics go to stderr
 * through `src/util/log.ts`.
 */
import { loadConfig } from '../../config.js';
import { managerAliasFile, selectedDraftFile, simulationPicksFile } from '../../paths.js';
import { SleeperClient } from '../../sleeper/client.js';
import { discoverSimulationDraft, findTargetLeague } from '../../sleeper/discovery.js';
import { buildAliasMap, saveAliasMap } from '../../import/alias.js';
import { loadPicks, normalizePicks, replacePicks, savePicks } from '../../import/picks.js';
import { ensurePlayerCache } from '../../import/players.js';
import type { Pick, SelectedDraft } from '../../types.js';
import { writeJson } from '../../util/json.js';
import { log } from '../../util/log.js';

export interface RunSetupOptions {
  /** Bypass every cache and re-fetch from Sleeper. */
  force?: boolean;
  /** Injectable for tests; defaults to a real cached client. */
  client?: SleeperClient;
}

function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

/**
 * Run the whole setup flow. Resilient by design: a missing target league
 * disables only the Manager Alias step, never the Simulation import.
 */
export async function runSetup(opts: RunSetupOptions = {}): Promise<void> {
  const force = opts.force === true;
  // `ttlMs: 0` means "ignore the on-disk cache and fetch".
  const fetchOpts = force ? { ttlMs: 0 } : {};

  // 1. Config.
  const config = await loadConfig();
  const client = opts.client ?? new SleeperClient();
  log.info(`setup for ${config.appName}, season ${config.season}${force ? ' (forced refresh)' : ''}`);

  // 2. Players dataset (~5MB, cached for 24h).
  const players = await ensurePlayerCache(client, force ? { ttlMs: 0 } : {});
  log.info(`players dataset: ${Object.keys(players).length} entries`);

  // 3. Discover and store the Simulation draft.
  const selected = await discoverSimulationDraft(client, config, fetchOpts);
  await writeJson(selectedDraftFile, selected);
  log.info(`selected draft ${selected.draftId} from ${selected.leagueName}`);

  // 4. Normalize its picks.
  const [rawPicks, draft, users] = await Promise.all([
    client.getDraftPicks(selected.draftId, fetchOpts),
    client.getDraft(selected.draftId, fetchOpts).catch((error: unknown) => {
      log.warn('could not read draft metadata; draft_order fallback unavailable', error);
      return null;
    }),
    client.getLeagueUsers(selected.leagueId, fetchOpts).catch((error: unknown) => {
      log.warn('could not read league users; manager names will fall back', error);
      return [];
    }),
  ]);

  const picks = normalizePicks(rawPicks, {
    leagueId: selected.leagueId,
    draftId: selected.draftId,
    season: selected.season,
    players,
    users,
    draftOrder: draft?.draft_order ?? null,
    simulated: true,
  });

  const stored = await persistPicks(picks, selected, force);

  // 5. Manager Alias against the target league. Optional by design.
  const targetLeague = await findTargetLeague(client, config, fetchOpts).catch((error: unknown) => {
    log.warn('could not list leagues while looking for the target league', error);
    return null;
  });

  let aliasSummary = `skipped — target league '${config.sleeper.targetLeagueName}' not found`;
  if (targetLeague) {
    try {
      const aliasMap = await buildAliasMap(client, selected, targetLeague.league_id, {
        ttlMs: force ? 0 : undefined,
        targetLeagueName: targetLeague.name,
      });
      await saveAliasMap(aliasMap);
      aliasSummary = `${Object.keys(aliasMap.slots).length} slots -> ${
        new Set(Object.values(aliasMap.slots).map((slot) => slot.managerId)).size
      } managers in ${aliasMap.targetLeagueName}`;
    } catch (error) {
      log.warn('Manager Alias step failed; simulation will use real simulation-league managers', error);
      aliasSummary = 'skipped — alias build failed (see log)';
    }
  } else {
    log.warn(
      `target league '${config.sleeper.targetLeagueName}' not found for ${config.season}; skipping the Manager Alias step`,
    );
  }

  // 6. Summary on stdout.
  printSummary({
    selected,
    picks: stored,
    aliasSummary,
    targetLeagueStatus: targetLeague?.status ?? null,
    targetLeagueName: targetLeague?.name ?? config.sleeper.targetLeagueName,
  });
}

/**
 * Write the normalized Picks. If the file holds picks from a different draft
 * (setup re-run after a new draft completed) it is replaced wholesale; otherwise
 * `savePicks` dedupes by `eventId` so re-running setup adds nothing.
 */
async function persistPicks(
  picks: Pick[],
  selected: SelectedDraft,
  force: boolean,
): Promise<Pick[]> {
  const existing = await loadPicks();
  const foreign = existing.filter((pick) => pick.draftId !== selected.draftId);

  if (foreign.length > 0 || (force && existing.length > 0)) {
    if (foreign.length > 0) {
      log.warn(
        `picks.jsonl held ${foreign.length} pick(s) from another draft; rewriting for ${selected.draftId}`,
      );
    }
    await replacePicks(picks);
    return picks;
  }

  const result = await savePicks(picks);
  log.info(
    `picks: +${result.added} new, ${result.duplicates} already present, ${result.total} total${
      result.rewritten ? ' (file rewritten to restore pick order)' : ''
    }`,
  );
  return loadPicks();
}

function printSummary(args: {
  selected: SelectedDraft;
  picks: Pick[];
  aliasSummary: string;
  targetLeagueStatus: string | null;
  targetLeagueName: string;
}): void {
  const { selected, picks, aliasSummary, targetLeagueStatus, targetLeagueName } = args;
  const first = picks[0];
  const last = picks[picks.length - 1];

  out('Players Lounge — setup complete');
  out();
  out(`  Simulation league : ${selected.leagueName} (${selected.leagueId})`);
  out(`  Draft             : ${selected.draftId} — ${selected.type}, ${selected.status}`);
  out(`  Season            : ${selected.season}`);
  out(`  Format            : ${selected.rounds} rounds x ${selected.teams} teams`);
  out(`  Picks imported    : ${picks.length}`);
  if (first) out(`  First pick        : ${describePick(first)}`);
  if (last) out(`  Last pick         : ${describePick(last)}`);
  out(`  Manager Alias     : ${aliasSummary}`);
  out(
    `  Target league     : ${targetLeagueName}${
      targetLeagueStatus === null ? ' (not found)' : ` — ${targetLeagueStatus}`
    }${targetLeagueStatus === 'pre_draft' ? ' (still pre-draft, so simulation is used)' : ''}`,
  );
  out();
  out('  Files written:');
  out(`    ${selectedDraftFile}`);
  out(`    ${simulationPicksFile}`);
  if (!aliasSummary.startsWith('skipped')) out(`    ${managerAliasFile}`);
  out();
  out('  Next: lounge simulate --next');
}

function describePick(pick: Pick): string {
  const round = pick.round === null || pick.round === undefined ? '?' : pick.round;
  return `#${pick.pickNo} (round ${round}) ${pick.playerName} -> ${pick.managerName}`;
}

export default runSetup;
