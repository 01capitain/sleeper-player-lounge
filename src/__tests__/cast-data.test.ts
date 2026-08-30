/**
 * The committed cast data, held to the invariants other code silently depends on.
 *
 * `data/players/star-players.json` is creative data humans edit by hand, and it
 * is also merged from `data/players/research/star-players-research.json` by a
 * research pass that does not know what the rest of the app keys on. These tests
 * are the contract between the two: `key`, `required`, `activity` and
 * `leagueLore` are ours and must survive any merge, while the research-derived
 * fields are allowed to be replaced wholesale.
 *
 * Everything here reads the REAL files, read-only. Nothing touches the network.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { relationshipsSeedFile, starPlayersFile } from '../paths.js';
import type { RelationshipsSeed, StarPlayersFile } from '../types.js';

function readJsonFile<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

const cast = readJsonFile<StarPlayersFile>(starPlayersFile);
const seed = readJsonFile<RelationshipsSeed>(relationshipsSeedFile);
const byKey = new Map(cast.players.map((star) => [star.key, star]));

// ---------------------------------------------------------------------------
// Identity — the fields other modules key on
// ---------------------------------------------------------------------------

describe('the cast keeps the identity other code depends on', () => {
  it('every entry has a unique key', () => {
    const keys = cast.players.map((star) => star.key);
    const duplicates = keys.filter((key, index) => keys.indexOf(key) !== index);
    expect(duplicates, `duplicate keys: ${duplicates.join(', ')}`).toEqual([]);
    expect(byKey.size).toBe(cast.players.length);
  });

  it('every key is snake_case, so `star:${key}` stays a stable pseudo-id', () => {
    for (const star of cast.players) {
      expect(star.key, star.name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it('Rodgers, Kelce and Pitts are still the required Regulars', () => {
    for (const key of ['aaron_rodgers', 'travis_kelce', 'kyle_pitts']) {
      expect(byKey.get(key)?.required, key).toBe(true);
    }
    const required = cast.players.filter((star) => star.required).map((star) => star.key);
    expect(required.sort()).toEqual(['aaron_rodgers', 'kyle_pitts', 'travis_kelce']);
  });

  it('every activity is inside the ambient band actor selection was tuned for', () => {
    for (const star of cast.players) {
      expect(star.activity, star.key).toBeGreaterThanOrEqual(0.7);
      expect(star.activity, star.key).toBeLessThanOrEqual(0.95);
    }
  });
});

// ---------------------------------------------------------------------------
// League-specific material the research pass cannot know about
// ---------------------------------------------------------------------------

describe('local creative data survives the research merge', () => {
  it('Kyle Pitts keeps his League Lore verbatim', () => {
    expect(byKey.get('kyle_pitts')?.leagueLore).toEqual([
      'Kyle Pitts is a recurring symbol of draft disappointment in this league.',
    ]);
  });

  it('Travis Kelce keeps the no-lyrics guardrail', () => {
    const guardrails = byKey.get('travis_kelce')?.guardrails ?? [];
    expect(guardrails).toContain('Do not quote copyrighted Taylor Swift lyrics.');
  });
});

// ---------------------------------------------------------------------------
// Research payload
// ---------------------------------------------------------------------------

describe('the research payload is either present and complete, or explicitly pending', () => {
  it('a researched entry carries a Sleeper id, a speech pattern and sourced facts', () => {
    const researched = cast.players.filter((star) => star.researchPending !== true);
    expect(researched.length).toBeGreaterThan(0);
    for (const star of researched) {
      expect(star.sleeperPlayerId, star.key).toMatch(/^\d+$/);
      expect(star.speechPattern?.length ?? 0, star.key).toBeGreaterThan(0);
      expect(star.facts?.length ?? 0, star.key).toBeGreaterThan(0);
      for (const fact of star.facts ?? []) {
        expect(fact.fact.length, star.key).toBeGreaterThan(0);
        expect(fact.angle.length, `${star.key}: "${fact.fact}"`).toBeGreaterThan(0);
        expect(fact.source, `${star.key}: "${fact.fact}"`).toMatch(/^https?:\/\//);
      }
    }
  });

  it('a pending entry is flagged rather than silently thin', () => {
    for (const star of cast.players) {
      const thin = star.speechPattern === undefined || (star.facts?.length ?? 0) === 0;
      expect(thin, star.key).toBe(star.researchPending === true);
    }
  });
});

// ---------------------------------------------------------------------------
// Relationships reference the cast by key, so a rename breaks them silently
// ---------------------------------------------------------------------------

describe('relationships.seed.json only names Regulars that exist', () => {
  it('every referenced key resolves to a cast entry', () => {
    const unknown = seed.relationships
      .flatMap((relationship) => relationship.players)
      .filter((key) => !byKey.has(key));
    expect(unknown, `unknown keys: ${unknown.join(', ')}`).toEqual([]);
  });

  it('no pair is seeded twice', () => {
    const pairs = seed.relationships.map((relationship) =>
      [...relationship.players].sort().join('+'),
    );
    expect(new Set(pairs).size).toBe(pairs.length);
  });
});
