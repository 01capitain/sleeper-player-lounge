/**
 * Append-only JSONL helpers.
 *
 * JSONL is the chronological event log for Picks, Reactions and Lounge Messages
 * (implementation_plan.md §11): one compact JSON object per line, always
 * newline-terminated so concurrent appends can never merge two records.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

/** Read every record from a JSONL file. A missing file reads as `[]`; blank lines are skipped. */
export async function readJsonl<T>(filePath: string): Promise<T[]> {
  const raw = await readFileOrNull(filePath);
  if (raw === null) return [];
  return parseLines<T>(raw, filePath);
}

/** Append one record or an array of records, one compact JSON object per line. */
export async function appendJsonl<T>(filePath: string, rows: T | T[]): Promise<void> {
  const list = Array.isArray(rows) ? rows : [rows];
  if (list.length === 0) return;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const text = `${list.map((row) => JSON.stringify(row)).join('\n')}\n`;
  await fs.appendFile(filePath, text, 'utf8');
}

/** Read the last `n` records. Returns fewer if the file is shorter, `[]` if it is missing. */
export async function readJsonlTail<T>(filePath: string, n: number): Promise<T[]> {
  if (n <= 0) return [];
  const rows = await readJsonl<T>(filePath);
  return rows.slice(Math.max(0, rows.length - n));
}

/** Overwrite a JSONL file with exactly these records. Used when rebuilding derived logs. */
export async function writeJsonl<T>(filePath: string, rows: T[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const text = rows.length === 0 ? '' : `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
  await fs.writeFile(filePath, text, 'utf8');
}

function parseLines<T>(raw: string, filePath: string): T[] {
  const out: T[] = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = (lines[i] ?? '').trim();
    if (line === '') continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch (error) {
      throw new Error(
        `Invalid JSONL at ${filePath}:${i + 1}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return out;
}

async function readFileOrNull(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return null;
    }
    throw error;
  }
}
