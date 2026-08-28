/**
 * App configuration.
 *
 * `data/config/app.json` is committed and holds every product decision the code
 * needs (league identity, history rules, reaction limits, render defaults).
 * Only Director overrides come from the environment — see ADR 0001: the Director
 * is a `claude -p` subprocess and needs no API key, so there are no secrets here.
 */
import { configFile } from './paths.js';
import type { AppConfig } from './types.js';
import { readJson } from './util/json.js';
import { parseLogLevel, type LogLevel } from './util/log.js';

/** Dotted paths of every field the app refuses to start without. */
const REQUIRED_FIELDS = [
  'appName',
  'season',
  'sleeper.username',
  'sleeper.userId',
  'sleeper.targetLeagueName',
  'historyRules.lastSeason',
  'historyRules.ignoreRosterHistoryBefore',
  'reactionRules.minMessages',
  'reactionRules.maxMessages',
  'reactionRules.maxRegularsPerReaction',
  'rendering.defaultFormat',
  'rendering.supportedFormats',
] as const;

let cached: AppConfig | null = null;

/** Load, validate and memoize `data/config/app.json`. */
export async function loadConfig(filePath: string = configFile): Promise<AppConfig> {
  if (cached !== null && filePath === configFile) return cached;
  const raw = await readJson<unknown>(filePath);
  const config = assertValidConfig(raw, filePath);
  if (filePath === configFile) cached = config;
  return config;
}

/** Drop the memoized config. Tests and long-running watchers use this. */
export function clearConfigCache(): void {
  cached = null;
}

/** Validate a parsed config object, throwing an error that names the first missing field. */
export function assertValidConfig(raw: unknown, source = configFile): AppConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`Invalid config in ${source}: expected a JSON object`);
  }
  const missing: string[] = [];
  for (const field of REQUIRED_FIELDS) {
    if (readPath(raw as Record<string, unknown>, field) === undefined) {
      missing.push(field);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Invalid config in ${source}: missing required field${missing.length > 1 ? 's' : ''} ${missing
        .map((field) => `'${field}'`)
        .join(', ')}`,
    );
  }
  return raw as AppConfig;
}

function readPath(root: Record<string, unknown>, dotted: string): unknown {
  let cursor: unknown = root;
  for (const segment of dotted.split('.')) {
    if (typeof cursor !== 'object' || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
    if (cursor === undefined || cursor === null) return undefined;
  }
  return cursor;
}

/** Optional environment overrides. Everything here is genuinely optional. */
export interface LoungeEnv {
  /** Model passed to `claude -p --model`. Defaults are the Director's business. */
  directorModel?: string;
  /** Parsed `LOUNGE_LOG_LEVEL`, or undefined when unset/blank. */
  logLevel?: LogLevel;
  /** Raw `LOUNGE_LOG_LEVEL` as provided, for diagnostics. */
  rawLogLevel?: string;
}

/** Read the optional Director/logging environment overrides. */
export function loadEnv(env: NodeJS.ProcessEnv = process.env): LoungeEnv {
  const result: LoungeEnv = {};
  const model = env['LOUNGE_DIRECTOR_MODEL']?.trim();
  if (model) result.directorModel = model;
  const rawLogLevel = env['LOUNGE_LOG_LEVEL']?.trim();
  if (rawLogLevel) {
    result.rawLogLevel = rawLogLevel;
    result.logLevel = parseLogLevel(rawLogLevel);
  }
  return result;
}
