/**
 * Tiny leveled logger.
 *
 * Everything goes to stderr with a `[players-lounge]` prefix so stdout stays
 * clean for machine-readable CLI output (JSON, file paths).
 * Level comes from `LOUNGE_LOG_LEVEL`; default `info`.
 */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

const PREFIX = '[players-lounge]';

export const DEFAULT_LOG_LEVEL: LogLevel = 'info';

/** True when `value` is one of the supported level names. */
export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value);
}

/** Resolve a level from an arbitrary string, falling back to `info`. */
export function parseLogLevel(value: string | undefined): LogLevel {
  const normalized = value?.trim().toLowerCase();
  return isLogLevel(normalized) ? normalized : DEFAULT_LOG_LEVEL;
}

let currentLevel: LogLevel = parseLogLevel(process.env['LOUNGE_LOG_LEVEL']);

export function getLogLevel(): LogLevel {
  return currentLevel;
}

/** Override the level at runtime (e.g. from a CLI flag). */
export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function emit(level: Exclude<LogLevel, 'silent'>, args: unknown[]): void {
  if (RANK[level] < RANK[currentLevel]) return;
  const parts = args.map((arg) =>
    typeof arg === 'string' ? arg : inspect(arg),
  );
  process.stderr.write(`${PREFIX} ${level.padEnd(5)} ${parts.join(' ')}\n`);
}

function inspect(value: unknown): string {
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export const log = {
  debug: (...args: unknown[]): void => emit('debug', args),
  info: (...args: unknown[]): void => emit('info', args),
  warn: (...args: unknown[]): void => emit('warn', args),
  error: (...args: unknown[]): void => emit('error', args),
};

export default log;
