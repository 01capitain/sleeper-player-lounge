/**
 * Every filesystem path the Players Lounge app uses, in one place.
 *
 * All paths are absolute and derived from this module's own location, never
 * from `process.cwd()`, so the CLI behaves identically no matter where it is
 * invoked from. This file lives at `<repoRoot>/src/paths.ts` in source form and
 * at `<repoRoot>/dist/paths.js` once compiled — both are exactly one directory
 * below the repo root, so the same `..` resolution is correct in either mode.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const thisDir = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path of the repository root. */
export const repoRoot = path.resolve(thisDir, '..');

/** Root of all committed and cached local data. */
export const dataDir = path.join(repoRoot, 'data');

// --- config -----------------------------------------------------------------
export const configDir = path.join(dataDir, 'config');
export const configFile = path.join(configDir, 'app.json');

// --- players ----------------------------------------------------------------
export const playersDir = path.join(dataDir, 'players');
export const starPlayersFile = path.join(playersDir, 'star-players.json');
/** Precomputed ADP artifact, built by `scripts/build-adp.mjs`. */
export const adpFile = path.join(playersDir, 'adp.json');
export const relationshipsSeedFile = path.join(playersDir, 'relationships.seed.json');

// --- lounge state and transcripts -------------------------------------------
export const loungeDir = path.join(dataDir, 'lounge');
export const loungeStateFile = path.join(loungeDir, 'state.json');
export const loungeMessagesFile = path.join(loungeDir, 'messages.jsonl');
export const loungeReactionsFile = path.join(loungeDir, 'reactions.jsonl');
/**
 * The live draft's Picks, as last seen by `lounge watch`.
 *
 * The watcher reads Picks from the API and never needed them on disk — but the
 * board does, and it cannot ask Sleeper. Writing them here (rather than beside
 * the simulation) puts them inside the `data/lounge` pathspec that `--sync`
 * commits, so a board built on the second machine shows the same draft.
 */
export const livePicksFile = path.join(loungeDir, 'picks.jsonl');
/**
 * The live draft's identity, as last seen by `lounge watch`.
 *
 * Same shape as `selected-draft.json` and written for the same reason the live
 * Picks are: the board cannot ask Sleeper which league it is looking at, and
 * without this it borrows the Simulation's heading. It sits inside the
 * `data/lounge` pathspec `--sync` commits, so both machines title it alike.
 */
export const liveDraftFile = path.join(loungeDir, 'draft.json');

// --- simulation -------------------------------------------------------------
export const simulationDir = path.join(dataDir, 'simulation');
export const selectedDraftFile = path.join(simulationDir, 'selected-draft.json');
export const simulationPicksFile = path.join(simulationDir, 'picks.jsonl');
export const managerAliasFile = path.join(simulationDir, 'manager-alias.json');

// --- fantasy history --------------------------------------------------------
export const fantasyHistoryDir = path.join(dataDir, 'fantasy-history');
export const lastSeasonFile = path.join(fantasyHistoryDir, 'last-season.json');
export const championsFile = path.join(fantasyHistoryDir, 'champions.json');
export const performanceOverridesFile = path.join(
  fantasyHistoryDir,
  'performance-overrides.json',
);

// --- caches (gitignored) ----------------------------------------------------
export const cacheDir = path.join(dataDir, 'cache');
export const httpCacheDir = path.join(cacheDir, 'http');
export const playersCacheFile = path.join(cacheDir, 'sleeper-players.json');
export const headshotCacheDir = path.join(cacheDir, 'headshots');

// --- generated output (gitignored) ------------------------------------------
export const outputDir = path.join(repoRoot, 'output');

// --- schemas ----------------------------------------------------------------
export const schemasDir = path.join(repoRoot, 'schemas');
export const pickSchemaFile = path.join(schemasDir, 'pick.schema.json');
export const reactionSchemaFile = path.join(schemasDir, 'reaction.schema.json');
export const playerHistorySchemaFile = path.join(schemasDir, 'player-history.schema.json');

// --- docs -------------------------------------------------------------------
export const docsDir = path.join(repoRoot, 'docs');
export const directorPromptFile = path.join(docsDir, 'director_prompt.md');
export const renderSpecFile = path.join(docsDir, 'render_spec.md');

/** Convenience bundle for code that would rather pass one object around. */
export const paths = {
  repoRoot,
  dataDir,
  configDir,
  configFile,
  playersDir,
  starPlayersFile,
  relationshipsSeedFile,
  loungeDir,
  loungeStateFile,
  loungeMessagesFile,
  loungeReactionsFile,
  livePicksFile,
  liveDraftFile,
  simulationDir,
  selectedDraftFile,
  simulationPicksFile,
  managerAliasFile,
  fantasyHistoryDir,
  lastSeasonFile,
  championsFile,
  performanceOverridesFile,
  cacheDir,
  httpCacheDir,
  playersCacheFile,
  headshotCacheDir,
  outputDir,
  schemasDir,
  pickSchemaFile,
  reactionSchemaFile,
  playerHistorySchemaFile,
  docsDir,
  directorPromptFile,
  renderSpecFile,
} as const;

export type LoungePaths = typeof paths;
