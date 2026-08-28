/**
 * `lounge history import` — build Fantasy Memory from Sleeper.
 *
 * Writes both history files described in implementation_plan.md §8/§11:
 * `data/fantasy-history/last-season.json` (2025 rosters only) and
 * `data/fantasy-history/champions.json` (winning rosters for every season the
 * league chain reaches).
 *
 * By default it imports the **Simulation** league's chain, read from
 * `data/simulation/selected-draft.json`, because per ADR 0002 the target league
 * is still pre-draft and Defensive Bros is the league with real history to
 * validate against. `--target` switches to the configured target league.
 *
 * stdout carries the human summary; every diagnostic goes to stderr via the
 * logger, so the two never interleave.
 */
import path from 'node:path';

import { loadConfig } from '../../config.js';
import { importChampions } from '../../history/champions.js';
import { walkLeagueChain } from '../../history/chain.js';
import { LAST_SEASON, importLastSeason } from '../../history/last-season.js';
import { PERFORMANCE_LABELS } from '../../history/performance.js';
import {
  championsFile as championsPath,
  fantasyHistoryDir,
  lastSeasonFile as lastSeasonPath,
  selectedDraftFile,
} from '../../paths.js';
import { SleeperClient, sleeper } from '../../sleeper/client.js';
import type { ChampionsFile, LastSeasonFile, PerformanceLabel, SelectedDraft } from '../../types.js';
import { readJsonIfExists, writeJson } from '../../util/json.js';
import { log } from '../../util/log.js';

export interface HistoryImportOptions {
  /** Import this league id's chain directly, skipping discovery. */
  league?: string;
  /** Use the configured target league instead of the Simulation league. */
  target?: boolean;
}

/** Injectable seams so the command is testable without network or real paths. */
export interface HistoryImportDeps {
  client?: SleeperClient;
  lastSeasonFile?: string;
  championsFile?: string;
  selectedDraftFile?: string;
  stdout?: (line: string) => void;
}

/** The static `rules` blocks the templates carry, preserved on every rewrite. */
const LAST_SEASON_TEMPLATE = path.join(fantasyHistoryDir, 'last-season.template.json');
const CHAMPIONS_TEMPLATE = path.join(fantasyHistoryDir, 'champions.template.json');

export async function runHistoryImport(
  opts: HistoryImportOptions = {},
  deps: HistoryImportDeps = {},
): Promise<void> {
  const client = deps.client ?? sleeper;
  const write = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));

  const leagueId = await resolveLeagueId(client, opts, deps);
  log.info(`importing Fantasy Memory from league ${leagueId}`);

  const chain = await walkLeagueChain(client, leagueId);
  const [lastSeason, champions] = await Promise.all([
    importLastSeason(client, leagueId),
    importChampions(client, leagueId),
  ]);

  const lastSeasonOut = deps.lastSeasonFile ?? lastSeasonPath;
  const championsOut = deps.championsFile ?? championsPath;
  await writeJson(lastSeasonOut, await withTemplateRules(lastSeason, LAST_SEASON_TEMPLATE));
  await writeJson(championsOut, await withTemplateRules(champions, CHAMPIONS_TEMPLATE));

  for (const line of summarize(leagueId, chain, lastSeason, champions, lastSeasonOut, championsOut)) {
    write(line);
  }
}

// ---------------------------------------------------------------------------
// League resolution
// ---------------------------------------------------------------------------

async function resolveLeagueId(
  client: SleeperClient,
  opts: HistoryImportOptions,
  deps: HistoryImportDeps,
): Promise<string> {
  const explicit = opts.league?.trim();
  if (explicit !== undefined && explicit !== '') return explicit;

  if (opts.target === true) return resolveTargetLeagueId(client);

  const selectedPath = deps.selectedDraftFile ?? selectedDraftFile;
  const selected = await readJsonIfExists<SelectedDraft>(selectedPath);
  const simulationLeagueId = selected?.leagueId?.trim();
  if (simulationLeagueId === undefined || simulationLeagueId === '') {
    throw new Error(
      `No Simulation league selected (${selectedPath} is missing or has no leagueId). ` +
        'Run `lounge setup` first, or pass --league <id> / --target.',
    );
  }
  return simulationLeagueId;
}

/** The target league is configured by *name*, so it has to be looked up by name. */
async function resolveTargetLeagueId(client: SleeperClient): Promise<string> {
  const config = await loadConfig();
  const wanted = config.sleeper.targetLeagueName.trim().toLowerCase();
  const leagues = await client.getUserLeagues(config.sleeper.userId, 'nfl', config.season);
  const match = (Array.isArray(leagues) ? leagues : []).find(
    (league) => league?.name?.trim().toLowerCase() === wanted,
  );
  if (match === undefined) {
    throw new Error(
      `Target league '${config.sleeper.targetLeagueName}' not found among ` +
        `${config.sleeper.username}'s ${config.season} leagues`,
    );
  }
  return match.league_id;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/**
 * Carry the template's `rules` block onto the generated file. Those rules (the
 * Season Literal requirement, the "championship membership only" note) are read
 * alongside the data by the Director prompt and must survive every re-import.
 */
async function withTemplateRules<T extends object>(value: T, templatePath: string): Promise<T> {
  const template = await readJsonIfExists<{ rules?: unknown }>(templatePath);
  const rules = template?.rules;
  if (rules === undefined || rules === null) return value;
  return { ...value, rules } as T;
}

function summarize(
  leagueId: string,
  chain: readonly { league_id: string; name: string; season: string }[],
  lastSeason: LastSeasonFile,
  champions: ChampionsFile,
  lastSeasonOut: string,
  championsOut: string,
): string[] {
  const lines: string[] = [];
  lines.push(`Fantasy Memory imported from league ${leagueId}`);

  lines.push(`Seasons found: ${chain.length}`);
  for (const league of chain) lines.push(`  ${league.season}  ${league.name}  (${league.league_id})`);

  const seasons = Object.keys(champions.championshipRosters).sort((a, b) => Number(b) - Number(a));
  lines.push(`Champions: ${seasons.length}`);
  if (seasons.length === 0) {
    lines.push('  (none — no season in this chain has a decided championship yet)');
  }
  for (const season of seasons) {
    const entry = champions.championshipRosters[season];
    if (entry === undefined) continue;
    lines.push(`  ${season}  ${entry.managerName}  (${entry.playerIds.length} players)`);
  }

  const players = Object.values(lastSeason.players);
  lines.push(`${LAST_SEASON} roster records: ${players.length}`);
  const counts = new Map<PerformanceLabel, number>(PERFORMANCE_LABELS.map((label) => [label, 0]));
  for (const player of players) {
    counts.set(player.performance, (counts.get(player.performance) ?? 0) + 1);
  }
  lines.push('Performance labels:');
  for (const label of PERFORMANCE_LABELS) {
    lines.push(`  ${label.padEnd(14)} ${counts.get(label) ?? 0}`);
  }

  lines.push(`Wrote ${lastSeasonOut}`);
  lines.push(`Wrote ${championsOut}`);
  return lines;
}

export default runHistoryImport;
