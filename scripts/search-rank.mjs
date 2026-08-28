#!/usr/bin/env node
/**
 * Inspect Sleeper's `search_rank` — the closest thing the public API exposes to
 * an average draft position. Used to sanity-check the draft-surprise signal.
 *
 * NOTE: search_rank is a single global ordering. It is NOT scoring-format aware,
 * so there is no 0.5-PPR variant of it. Treat it as a consensus board, not as
 * format-specific ADP.
 *
 *   node scripts/search-rank.mjs              # top 10 overall
 *   node scripts/search-rank.mjs 25           # top 25 overall
 *   node scripts/search-rank.mjs 15 TE        # top 15 tight ends
 *   node scripts/search-rank.mjs 10 ALL --fantasy-only=false
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cache = resolve(root, 'data/cache/sleeper-players.json');
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

const limit = Number(process.argv[2] ?? 10);
const position = (process.argv[3] ?? 'ALL').toUpperCase();

async function load() {
  try {
    const s = await stat(cache);
    if (Date.now() - s.mtimeMs < MAX_AGE_MS) {
      process.stderr.write(`using cache (${(s.size / 1e6).toFixed(1)} MB)\n`);
      return JSON.parse(await readFile(cache, 'utf8'));
    }
  } catch { /* fall through to fetch */ }

  process.stderr.write('fetching https://api.sleeper.app/v1/players/nfl (~5 MB)…\n');
  const res = await fetch('https://api.sleeper.app/v1/players/nfl');
  if (!res.ok) throw new Error(`Sleeper returned ${res.status}`);
  const body = await res.text();
  await mkdir(dirname(cache), { recursive: true });
  await writeFile(cache, body);
  process.stderr.write(`cached ${(body.length / 1e6).toFixed(1)} MB\n`);
  return JSON.parse(body);
}

const players = await load();
const FANTASY = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'DEF']);

const ranked = Object.values(players)
  .filter((p) => typeof p?.search_rank === 'number' && p.search_rank > 0 && p.search_rank < 10000)
  .filter((p) => p.active !== false)
  .filter((p) => FANTASY.has(p.position))
  .filter((p) => position === 'ALL' || p.position === position)
  .sort((a, b) => a.search_rank - b.search_rank)
  .slice(0, limit);

const w = String(limit).length;
console.log(`\n  Top ${ranked.length}${position === 'ALL' ? '' : ` ${position}`} by Sleeper search_rank\n`);
console.log(`  ${'#'.padStart(w)}  rank   player                        pos  team  id`);
console.log(`  ${'-'.repeat(w)}  -----  ----------------------------  ---  ----  --------`);
ranked.forEach((p, i) => {
  const name = (p.full_name ?? `${p.first_name ?? ''} ${p.last_name ?? ''}`).trim();
  console.log(
    `  ${String(i + 1).padStart(w)}  ${String(p.search_rank).padStart(5)}  ` +
    `${name.padEnd(28)}  ${(p.position ?? '').padEnd(3)}  ${(p.team ?? '—').padEnd(4)}  ${p.player_id}`,
  );
});
console.log(`\n  search_rank is format-agnostic — no 0.5-PPR variant exists.\n`);
