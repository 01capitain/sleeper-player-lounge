#!/usr/bin/env node
/**
 * Build the ADP artifact from Sleeper's projections route.
 *
 * ADP is a PRECOMPUTED artifact, not something the app resolves at runtime:
 * this script writes `data/players/adp.json`, which is committed and read
 * directly by the context builder. Re-run it to refresh; it overwrites in place.
 *
 *   node scripts/build-adp.mjs                  # 2026, half-PPR
 *   node scripts/build-adp.mjs --season 2026
 *   node scripts/build-adp.mjs --field adp_dd_ppr
 *   node scripts/build-adp.mjs --dry-run        # inspect without writing
 *
 * Sentinel handling: Sleeper parks undrafted players at 1000.0. Those, and any
 * missing value, are treated as UNRANKED and omitted from the artifact entirely
 * rather than stored as a huge number — a fake ADP becomes a fabricated joke.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'data/players/adp.json');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const season = arg('season', '2026');
const week = arg('week', '1');
const field = arg('field', 'adp_dd_half_ppr');
const dryRun = process.argv.includes('--dry-run');
const SENTINEL = 1000;

const url =
  `https://api.sleeper.com/projections/nfl/${season}/${week}` +
  `?season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE` +
  `&order_by=${field}`;

process.stderr.write(`fetching ${url}\n`);
const res = await fetch(url);
if (!res.ok) throw new Error(`Sleeper returned ${res.status} ${res.statusText}`);
const rows = await res.json();
if (!Array.isArray(rows)) throw new Error(`expected an array, got ${typeof rows}`);
process.stderr.write(`received ${rows.length} rows\n`);

// --- self-diagnosis: which adp_* fields does this payload actually carry? -----
const adpFields = new Map();
for (const row of rows) {
  for (const key of Object.keys(row?.stats ?? {})) {
    if (!key.startsWith('adp')) continue;
    const v = row.stats[key];
    const e = adpFields.get(key) ?? { present: 0, usable: 0, min: Infinity };
    e.present += 1;
    if (typeof v === 'number' && v > 0 && v < SENTINEL) {
      e.usable += 1;
      e.min = Math.min(e.min, v);
    }
    adpFields.set(key, e);
  }
}
console.log('\n  adp_* fields present in this payload');
console.log('  field                     rows   usable   best');
console.log('  ------------------------  -----  -------  -----');
for (const [k, e] of [...adpFields].sort()) {
  const best = Number.isFinite(e.min) ? e.min.toFixed(1) : '—';
  console.log(`  ${k.padEnd(24)}  ${String(e.present).padStart(5)}  ${String(e.usable).padStart(7)}  ${best.padStart(5)}`);
}
if (!adpFields.has(field)) {
  console.error(`\n  ERROR: requested field "${field}" is not present.`);
  console.error(`  Re-run with --field <one of the above>.\n`);
  process.exit(1);
}

// --- extract -----------------------------------------------------------------
const adp = {};
const meta = {};
let unranked = 0;
let noPlayerId = 0;
for (const row of rows) {
  const playerId = row?.player_id;
  if (typeof playerId !== 'string' || playerId.length === 0) { noPlayerId += 1; continue; }
  const value = row?.stats?.[field];
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value >= SENTINEL) {
    unranked += 1;
    continue;
  }
  adp[playerId] = Number(value.toFixed(2));
  const p = row.player ?? {};
  const name = [p.first_name, p.last_name].filter(Boolean).join(' ') || playerId;
  meta[playerId] = { name, position: p.position ?? null, team: row.team ?? null };
}

const ranked = Object.entries(adp).sort((a, b) => a[1] - b[1]);
console.log(`\n  ranked ${ranked.length} players · ${unranked} unranked (missing or >= ${SENTINEL}) · ${noPlayerId} without a player_id`);

console.log('\n  Top 15 by ' + field);
console.log('   #   adp   player                     pos  team');
console.log('  ---  ----  -------------------------  ---  ----');
ranked.slice(0, 15).forEach(([id, v], i) => {
  const m = meta[id] ?? {};
  console.log(
    `  ${String(i + 1).padStart(3)}  ${v.toFixed(1).padStart(4)}  ` +
    `${(m.name ?? id).padEnd(25)}  ${(m.position ?? '').padEnd(3)}  ${m.team ?? '—'}`,
  );
});

// --- validation: Josh Allen must land in the 20s-40s, not near 4 -------------
const allen = ranked.find(([id]) => (meta[id]?.name ?? '') === 'Josh Allen' && meta[id]?.position === 'QB');
console.log('');
if (!allen) {
  console.log('  CHECK  Josh Allen: not found in the ranked set.');
} else {
  const [, v] = allen;
  const overall = ranked.findIndex(([id]) => id === allen[0]) + 1;
  const ok = v >= 15 && v <= 60;
  console.log(`  CHECK  Josh Allen  adp=${v.toFixed(1)}  overall #${overall}  ${ok ? 'PLAUSIBLE ✓' : 'SUSPICIOUS ✗ (expected roughly 20-40)'}`);
}

if (dryRun) {
  console.log('\n  --dry-run: nothing written.\n');
  process.exit(0);
}

const artifact = {
  source: url,
  season: Number(season),
  week: Number(week),
  field,
  unrankedSentinel: SENTINEL,
  generatedAt: new Date().toISOString(),
  rankedCount: ranked.length,
  adp: Object.fromEntries(ranked),
};
await mkdir(dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(artifact, null, 2) + '\n');
console.log(`\n  wrote ${out}\n`);
