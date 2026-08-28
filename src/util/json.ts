/**
 * JSON file helpers.
 *
 * `writeJson` deliberately sorts object keys recursively and pretty-prints with a
 * two-space indent plus a trailing newline. Both are git-friendliness requirements
 * from implementation_plan.md §11: derived state files are rewritten constantly and
 * must produce minimal, stable diffs.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

/** Read and parse a JSON file. Throws if it is missing or malformed. */
export async function readJson<T>(filePath: string): Promise<T> {
  const raw = await fs.readFile(filePath, 'utf8');
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(
      `Invalid JSON in ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Read and parse a JSON file, or return `null` if it does not exist. */
export async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  try {
    return await readJson<T>(filePath);
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

/**
 * Write a JSON file with recursively sorted keys, 2-space indent and a trailing
 * newline. Parent directories are created as needed.
 */
export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const text = `${JSON.stringify(sortKeysDeep(value), null, 2)}\n`;
  await fs.writeFile(filePath, text, 'utf8');
}

/** Serialize to the exact string `writeJson` would write, without touching disk. */
export function stringifyStable(value: unknown): string {
  return `${JSON.stringify(sortKeysDeep(value), null, 2)}\n`;
}

/** Recursively sort plain-object keys; array order is meaningful and preserved. */
export function sortKeysDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => sortKeysDeep(entry)) as unknown as T;
  }
  if (value !== null && typeof value === 'object' && isPlainObject(value)) {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortKeysDeep(source[key]);
    }
    return sorted as unknown as T;
  }
  return value;
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
