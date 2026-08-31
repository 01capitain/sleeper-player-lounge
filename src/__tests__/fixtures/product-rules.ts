/**
 * Shared fixtures for the product-rule conformance suite.
 *
 * Everything here is loaded from the REAL committed data files — the 238-pick
 * Defensive Bros 2026 draft, the 15 Regular profiles, the precomputed ADP
 * artifact, the seeded relationships and the live app config. The suite is meant
 * to hold the product to its promises against reality, not against invented
 * shapes, so the fixtures deliberately avoid hand-rolled players and picks.
 *
 * Two hard constraints:
 *   - nothing here touches the network, and nothing spawns the `claude` binary;
 *   - nothing here writes to `data/` — every file is opened read-only.
 *
 * `data/cache/sleeper-players.json` is a 15MB gitignored cache, so it is never
 * read. `realPlayers()` reconstructs an equivalent Sleeper players dataset from
 * the real picks (which carry name, position and NFL team) enriched with the
 * real ADP artifact. Every one of the 15 Regulars was drafted in that draft, so
 * the reconstruction resolves all of them to their real Sleeper player ids.
 */
import { readFileSync } from 'node:fs';

import { assertValidConfig } from '../../config.js';
import {
  adpFile,
  configFile,
  loungeStateFile,
  relationshipsSeedFile,
  selectedDraftFile,
  simulationPicksFile,
  starPlayersFile,
} from '../../paths.js';
import type {
  AppConfig,
  LoungeState,
  Pick,
  Reaction,
  RelationshipsSeed,
  SelectedDraft,
  SleeperPlayer,
  StarPlayer,
  StarPlayersFile,
} from '../../types.js';

// ---------------------------------------------------------------------------
// Real data, read once
// ---------------------------------------------------------------------------

function readJsonFile<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

/** The 238 real picks of the Defensive Bros 2026 draft, in file order. */
export const realPicks: Pick[] = readFileSync(simulationPicksFile, 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line) as Pick);

/** `data/simulation/selected-draft.json` — the Simulation draft that was chosen. */
export const realSelectedDraft: SelectedDraft = readJsonFile<SelectedDraft>(selectedDraftFile);

/** The 15 Regulars from `data/players/star-players.json`. */
export const realRegulars: readonly StarPlayer[] =
  readJsonFile<StarPlayersFile>(starPlayersFile).players;

/** `data/players/relationships.seed.json`. */
export const realRelationships: RelationshipsSeed =
  readJsonFile<RelationshipsSeed>(relationshipsSeedFile);

/** `data/lounge/state.json` — carries the persistent Kyle Pitts League Lore joke. */
export const realState: LoungeState = readJsonFile<LoungeState>(loungeStateFile);

/** `data/config/app.json`, through the real validator. */
export const realConfig: AppConfig = assertValidConfig(readJsonFile<unknown>(configFile));

/** The raw shape of `data/players/adp.json` (ADR 0004). */
export interface RealAdpArtifact {
  source: string;
  season: number;
  week: number;
  field: string;
  unrankedSentinel: number;
  generatedAt: string;
  rankedCount: number;
  adp: Record<string, number>;
}

/** `data/players/adp.json` — 456 ranked players, ordinal board 1..456. */
export const realAdp: RealAdpArtifact = readJsonFile<RealAdpArtifact>(adpFile);

// ---------------------------------------------------------------------------
// Derived fixtures
// ---------------------------------------------------------------------------

let playersCache: Record<string, SleeperPlayer> | undefined;

/**
 * A Sleeper `/players/nfl`-shaped dataset rebuilt from the real draft, enriched
 * with the real ADP artifact. Every entry is a player who was genuinely drafted,
 * with his real id, name, position and NFL team.
 */
export function realPlayers(): Record<string, SleeperPlayer> {
  if (playersCache !== undefined) return playersCache;
  const players: Record<string, SleeperPlayer> = {};
  for (const pick of realPicks) {
    const adp = realAdp.adp[pick.playerId];
    players[pick.playerId] = {
      player_id: pick.playerId,
      full_name: pick.playerName,
      position: pick.position ?? null,
      team: pick.nflTeam ?? null,
      active: true,
      search_rank: null,
      ...(typeof adp === 'number' && adp < realAdp.unrankedSentinel ? { adp } : {}),
    };
  }
  playersCache = players;
  return players;
}

/** The real pick for one Sleeper player id. Throws if the draft has no such pick. */
export function pickOf(playerId: string): Pick {
  const found = realPicks.find((pick) => pick.playerId === playerId);
  if (!found) throw new Error(`no real pick for player ${playerId}`);
  return found;
}

/** Every pick made before `pick` in the same draft. */
export function priorPicksOf(pick: Pick): Pick[] {
  return realPicks.filter((row) => row.draftId === pick.draftId && row.pickNo < pick.pickNo);
}

/** One Regular by `StarPlayer.key`. Throws if the cast has changed. */
export function regular(key: string): StarPlayer {
  const found = realRegulars.find((star) => star.key === key);
  if (!found) throw new Error(`no Regular with key ${key}`);
  return found;
}

/** An evenly spread sample of the real draft, so tests cover rounds 1 through 17. */
export function spreadOfPicks(count: number): Pick[] {
  const step = Math.max(1, Math.floor(realPicks.length / count));
  const out: Pick[] = [];
  for (let i = 0; i < realPicks.length && out.length < count; i += step) {
    const pick = realPicks[i];
    if (pick) out.push(pick);
  }
  return out;
}

// --- the three confirmed demo picks (docs/sleeper-facts.md §15) -------------

/** Kyle Pitts, player `7553`, pick 74, round 6. */
export const PITTS_PLAYER_ID = '7553';
/** Travis Kelce, player `1466`, pick 119, round 9. */
export const KELCE_PLAYER_ID = '1466';
/** Aaron Rodgers, player `96`, pick 229, round 17 — ADP 147, an 82-pick slide. */
export const RODGERS_PLAYER_ID = '96';
/**
 * Cameron Dicker, K, LAC, pick 141 — the "nothing to do with anyone" Pick.
 * No Regular plays for the Chargers, no Regular is a kicker, he is in no seeded
 * relationship, he has no Fantasy Memory and he is in no running joke.
 */
export const UNCONNECTED_PICK_PLAYER_ID = '8259';
/**
 * Bijan Robinson, RB, ATL, pick 2 — an Atlanta pick, which is one half of Kyle
 * Pitts' Appearance Gate. He is not Pitts, so the gate, not the mandatory
 * drafted-player slot, is what admits Pitts here.
 */
export const ATL_PICK_PLAYER_ID = '9509';
/** Sam LaPorta, TE, DET, pick 64 — the 4th tight end off the board: still early. */
export const EARLY_TE_PICK_PLAYER_ID = '10859';
/** Tyler Warren, TE, IND, pick 68 — the 5th tight end: one past the gate. */
export const LATE_TE_PICK_PLAYER_ID = '12518';

// ---------------------------------------------------------------------------
// The Season Literal scanner (CONTEXT.md: Season Literal)
// ---------------------------------------------------------------------------

/**
 * Phrases that betray a Fantasy Memory reference. Each of these is a way of
 * pointing at the past without naming it, which is exactly what the Season
 * Literal rule forbids. Drawn from the "Wrong — never write these" list in
 * `prompts/director.system.md` and `docs/director_prompt.md`.
 */
const HISTORY_MARKERS: readonly { pattern: RegExp; label: string }[] = [
  { pattern: /\blast (?:season|year|time)\b/i, label: 'last season/year/time' },
  { pattern: /\bback together\b/i, label: 'back together' },
  { pattern: /\breunit(?:e|ed|ing)\b/i, label: 'reunited' },
  { pattern: /\breunion\b/i, label: 'reunion' },
  { pattern: /\bwe were both on\b/i, label: 'we were both on' },
  { pattern: /\byou had me\b/i, label: 'you had me' },
  { pattern: /\bsame roster\b/i, label: 'same roster' },
  { pattern: /\bdone this before\b/i, label: 'done this before' },
  { pattern: /\bremember (?:our|when|the|that)\b/i, label: 'remember our/when/the' },
  { pattern: /\b(?:our|the|that|your) (?:title|ring|championship)\b/i, label: 'our/the title' },
  { pattern: /\bchampionship roster\b/i, label: 'championship roster' },
  { pattern: /\bwon it all\b/i, label: 'won it all' },
];

/** A four-digit season, e.g. `2025` or `2023`. */
export const SEASON_LITERAL = /\b(?:19|20)\d{2}\b/;

/**
 * Every Season Literal violation in a Reaction.
 *
 * A Message breaks the rule when it draws on Fantasy Memory — by `reason`, by
 * `historyRefs`, or by using one of the tell-tale phrases above — without naming
 * the season as a four-digit year. A `fantasy_2025_history` Message must carry
 * the literal `2025`; a `championship_history` Message must carry its own season.
 */
export function seasonLiteralViolations(reaction: Reaction): string[] {
  const violations: string[] = [];
  for (const [index, message] of reaction.reactions.entries()) {
    const where = `message ${index} (${message.speakerName})`;
    const text = message.text;
    const hasSeason = SEASON_LITERAL.test(text);

    if (message.reason === 'fantasy_2025_history' && !text.includes('2025')) {
      violations.push(`${where}: reason fantasy_2025_history but the text never says 2025 — ${text}`);
    }
    if (message.reason === 'championship_history' && !hasSeason) {
      violations.push(`${where}: reason championship_history but no championship season named — ${text}`);
    }
    if ((message.historyRefs ?? []).length > 0 && !hasSeason) {
      violations.push(`${where}: leans on historyRefs but names no season — ${text}`);
    }
    if (!hasSeason) {
      for (const marker of HISTORY_MARKERS) {
        if (marker.pattern.test(text)) {
          violations.push(`${where}: history reference "${marker.label}" with no four-digit season — ${text}`);
        }
      }
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// The memory-cutoff scanner (implementation_plan.md §4, §14)
// ---------------------------------------------------------------------------

/** Seasons that may never appear in a prompt except as Championship Membership. */
const FORBIDDEN_SEASON = /\b(?:19\d{2}|20[01]\d|202[0-4])\b/;

/**
 * Every line of a rendered prompt that names a pre-2025 season without framing
 * it as a championship. Backtick-quoted spans (Sleeper player ids, event ids)
 * are stripped first so a four-digit id is never mistaken for a season.
 */
export function preCutoffSeasonLines(prompt: string): string[] {
  return prompt
    .split('\n')
    .map((line) => line.replace(/`[^`]*`/g, ''))
    .filter((line) => FORBIDDEN_SEASON.test(line))
    .filter((line) => !/champion/i.test(line));
}

// ---------------------------------------------------------------------------
// Reaction helpers
// ---------------------------------------------------------------------------

/** A schema-valid Reaction for a Pick, with the drafted player speaking first. */
export function reactionFor(pick: Pick, texts: readonly string[]): Reaction {
  return {
    eventId: pick.eventId,
    pick: {
      season: pick.season,
      pickNo: pick.pickNo,
      round: pick.round ?? null,
      playerId: pick.playerId,
      playerName: pick.playerName,
      managerName: pick.managerName,
    },
    reactions: texts.map((text, index) => ({
      speakerPlayerId: pick.playerId,
      speakerName: pick.playerName,
      text,
      delayMs: index * 900,
      reason: 'drafted_player' as const,
    })),
  };
}

/** The `claude -p --output-format json` envelope, as the CLI really returns it. */
export function directorEnvelope(structuredOutput: unknown): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 4210,
    structured_output: structuredOutput,
  });
}
