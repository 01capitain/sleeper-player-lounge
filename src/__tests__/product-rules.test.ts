/**
 * PRODUCT-RULE CONFORMANCE SUITE
 * ==============================
 *
 * This file does not test implementation details. It encodes the rules the
 * Players Lounge is *defined* by — implementation_plan.md §4 (memory rules),
 * §9 (actor selection) and §14 (validation tests), CONTEXT.md's glossary, and
 * ADR 0001 and 0004 — as executable statements.
 *
 * **A failure here means a promise to the user is broken**, not that an
 * internal helper changed shape. Each `describe` is named after the rule and
 * each `it` reads as the promise itself, so a red line in CI names the broken
 * promise without anyone having to open the file.
 *
 * Rules asserted:
 *   1  the drafted player is always in the room and always speaks
 *   2  never more than six messages, never fewer than the configured minimum
 *   3  a 2025 reference always names 2025
 *   4  a championship reference always names its season
 *   5  no non-championship roster history from before 2025 reaches the prompt
 *   6  Kyle Pitts always carries the league bust lore
 *   7  a Lounge with Kelce in it always forbids Taylor Swift lyrics
 *   8  reprocessing a pick never creates a second event
 *   9  the pre-draft target league is never simulated
 *   10 the completed alternate 2026 draft can be replayed
 *   11 Regulars are ambient — relevance raises odds, it never gates
 *   12 the Director always runs behind the ADR 0001 isolation guard
 *   13 ADP sentinels never leak, and `search_rank` is never an ADP fallback
 *   14 an Appearance Gate is the only thing that keeps a Regular out, and it
 *      takes his lore out of the room with him
 *   15 the Manager's own roster reacts to what he just drafted
 *
 * House rules for this suite:
 *   - the real `claude` binary is NEVER spawned; every Director test either uses
 *     `StubDirector` or injects a fake spawn;
 *   - nothing reaches the network;
 *   - `data/` is read-only — every write goes to a fresh temp directory;
 *   - where randomness is involved the invariant is asserted across many seeds,
 *     never on one lucky case.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  assertContextClean,
  buildContext,
  ForbiddenHistoryError,
  MAX_RECENT_MESSAGES,
  resolveStarMeta,
  type BuildContextDeps,
  type BuiltContext,
} from '../context/builder.js';
import {
  actorWeight,
  gateAllows,
  selectActors,
  type SelectedActor,
} from '../context/actors.js';
import { computeDraftSignals } from '../context/signals.js';
import {
  allowedSpeakers,
  ClaudeCliDirector,
  productRuleViolations,
  REQUIRED_CLI_FLAGS,
  renderUserPrompt,
  StubDirector,
  type DirectorSpawn,
} from '../director/index.js';
import { assertNoForbiddenHistory } from '../history/index.js';
import { adpFor } from '../import/adp.js';
import { loadPicks } from '../import/picks.js';
import { hasProcessed, persistReaction } from '../lounge/persist.js';
import { directorSystemPromptFile } from '../director/claude-cli.js';
import { reactionSchemaFile, simulationPicksFile } from '../paths.js';
import { discoverSimulationDraft, findTargetLeague } from '../sleeper/discovery.js';
import type {
  LoungeMessage,
  Pick,
  PlayerHistory,
  Reaction,
  SleeperPlayer,
} from '../types.js';
import { SchemaValidationError, validatePick, validateReaction } from '../validate.js';

import {
  AFFC_DRAFT_ID,
  AFFC_LEAGUE_ID,
  BROS_DRAFT_ID,
  BROS_LEAGUE_ID,
  HOTELKIT_DRAFT_ID,
  HOTELKIT_LEAGUE_ID,
  USER_ID,
  brosDraft,
  brosPicks,
  draft,
  leagues2026,
  testClient,
  testConfig,
} from '../import/__tests__/fixtures.js';
import {
  ATL_PICK_PLAYER_ID,
  directorEnvelope,
  EARLY_TE_PICK_PLAYER_ID,
  KELCE_PLAYER_ID,
  LATE_TE_PICK_PLAYER_ID,
  PITTS_PLAYER_ID,
  preCutoffSeasonLines,
  pickOf,
  priorPicksOf,
  reactionFor,
  realAdp,
  realConfig,
  realPicks,
  realPlayers,
  realRegulars,
  realRelationships,
  realSelectedDraft,
  realState,
  regular,
  RODGERS_PLAYER_ID,
  seasonLiteralViolations,
  spreadOfPicks,
  UNCONNECTED_PICK_PLAYER_ID,
} from './fixtures/product-rules.js';

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

const players = realPlayers();
const starMeta = resolveStarMeta(realRegulars, players);
const systemPrompt = readFileSync(directorSystemPromptFile, 'utf8');
const reactionSchema = JSON.parse(readFileSync(reactionSchemaFile, 'utf8')) as {
  properties: { reactions: { minItems: number; maxItems: number } };
};

/** The rules the product actually ships with, from `data/config/app.json`. */
const rules = realConfig.reactionRules;

/**
 * Build a Context for a real Pick from real data, with no disk or network
 * access: config, players, Regulars, relationships and Lounge state are all
 * injected, and Fantasy Memory is off unless a test supplies it.
 */
async function contextFor(
  pick: Pick,
  overrides: Partial<BuildContextDeps> = {},
): Promise<BuiltContext> {
  return buildContext(pick, {
    config: realConfig,
    players,
    starPlayers: realRegulars,
    relationships: realRelationships,
    state: realState,
    recentMessages: [],
    priorPicks: priorPicksOf(pick),
    history: null,
    ...overrides,
  });
}

/** A spawn that records every argv it is handed and replies from a queue. */
function fakeSpawn(responses: readonly string[]): DirectorSpawn & { calls: string[][] } {
  const calls: string[][] = [];
  const impl = async (
    _file: string,
    args: readonly string[],
  ): Promise<{ stdout: string }> => {
    calls.push([...args]);
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    return { stdout: next ?? '' };
  };
  return Object.assign(impl, { calls }) as DirectorSpawn & { calls: string[][] };
}

/** The value argv carries directly after `flag`, or `undefined` when absent. */
function argAfter(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

/** 2025 Fantasy Memory — the only ordinary roster history the rules allow. */
function memory2025(playerId: string, overrides: Partial<PlayerHistory> = {}): PlayerHistory {
  return {
    playerId,
    lastSeason: {
      season: 2025,
      managerId: 'mgr-max',
      managerName: 'Max',
      performance: 'disappointing',
      teamFinish: 7,
      champion: false,
      sharedRosterPlayerIds: [],
    },
    championships: [],
    ...overrides,
  };
}

let tempRoot: string;

beforeAll(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'lounge-product-rules-'));
});

afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

/** A fresh, isolated set of lounge files. The real `data/lounge/` is never touched. */
async function tempLounge(name: string): Promise<{
  reactionsFile: string;
  messagesFile: string;
  stateFile: string;
}> {
  const dir = await mkdtemp(path.join(tempRoot, `${name}-`));
  return {
    reactionsFile: path.join(dir, 'reactions.jsonl'),
    messagesFile: path.join(dir, 'messages.jsonl'),
    stateFile: path.join(dir, 'state.json'),
  };
}

async function countLines(file: string): Promise<number> {
  const text = await readFile(file, 'utf8').catch(() => '');
  return text.split('\n').filter((line) => line.trim() !== '').length;
}

// ===========================================================================
// Rule 1 — the drafted player is always present
// ===========================================================================

describe('Rule 1 — the drafted player is always in the room and always speaks', () => {
  it('the drafted player is the first, mandatory candidate for every one of the 238 real picks', async () => {
    for (const pick of realPicks) {
      const context = await contextFor(pick);
      const first: SelectedActor | undefined = context.actors[0];
      expect(first, `pick ${pick.pickNo} ${pick.playerName} produced no candidates`).toBeDefined();
      expect(first?.playerId, `pick ${pick.pickNo} ${pick.playerName}`).toBe(pick.playerId);
      expect(first?.mandatory, `pick ${pick.pickNo} ${pick.playerName}`).toBe(true);
      expect(first?.role).toBe('drafted_player');
    }
  });

  it('the drafted player is an allowed speaker for every one of the 238 real picks', async () => {
    for (const pick of realPicks) {
      const context = await contextFor(pick);
      const allowed = allowedSpeakers(context);
      expect(allowed.ids.has(pick.playerId), `pick ${pick.pickNo} ${pick.playerName}`).toBe(true);
    }
  });

  it('the drafted player sends a message in every generated reaction of the real draft', async () => {
    const director = new StubDirector();
    for (const pick of realPicks) {
      const context = await contextFor(pick);
      const reaction = await director.generateReaction(context);
      const spoke = reaction.reactions.some(
        (message) => message.speakerPlayerId === pick.playerId,
      );
      expect(spoke, `pick ${pick.pickNo} ${pick.playerName} never spoke`).toBe(true);
    }
  });

  it('the drafted player stays mandatory under every actor-selection seed', async () => {
    for (const pick of spreadOfPicks(8)) {
      for (let seed = 0; seed < 64; seed += 1) {
        const context = await contextFor(pick, { seed });
        expect(
          context.actors[0]?.playerId,
          `pick ${pick.pickNo} seed ${seed}`,
        ).toBe(pick.playerId);
      }
    }
  });

  it('a reaction in which the drafted player never speaks is rejected as invalid', async () => {
    const pick = pickOf(PITTS_PLAYER_ID);
    const context = await contextFor(pick);
    const teammate = context.actors.find((actor) => !actor.mandatory);
    expect(teammate, 'the fixture pick needs at least one non-drafted candidate').toBeDefined();

    const withoutHim: Reaction = {
      ...reactionFor(pick, ['a', 'b']),
      reactions: [
        {
          speakerPlayerId: teammate?.playerId ?? 'x',
          speakerName: teammate?.name ?? 'x',
          text: 'somebody took a tight end again',
          delayMs: 0,
          reason: 'star_regular',
        },
        {
          speakerPlayerId: teammate?.playerId ?? 'x',
          speakerName: teammate?.name ?? 'x',
          text: 'bold',
          delayMs: 900,
          reason: 'star_regular',
        },
      ],
    };

    const violations = productRuleViolations(withoutHim, context, rules);
    expect(violations.join('\n')).toMatch(/does not speak/);
  });
});

// ===========================================================================
// Rule 2 — message count bounds
// ===========================================================================

describe('Rule 2 — a reaction is never longer than six messages, never shorter than the minimum', () => {
  it('the shipped reaction schema caps a reaction at six messages', () => {
    expect(reactionSchema.properties.reactions.maxItems).toBe(6);
    expect(reactionSchema.properties.reactions.minItems).toBe(1);
    expect(rules.maxMessages).toBe(6);
  });

  it('a seventh message fails validation', () => {
    const pick = pickOf(KELCE_PLAYER_ID);
    const seven = reactionFor(pick, ['1', '2', '3', '4', '5', '6', '7']);
    expect(() => validateReaction(seven)).toThrow(SchemaValidationError);
  });

  it('an empty reaction fails validation', () => {
    const pick = pickOf(KELCE_PLAYER_ID);
    expect(() => validateReaction(reactionFor(pick, []))).toThrow(SchemaValidationError);
  });

  it('a reaction below the configured minimum is rejected as invalid', async () => {
    const pick = pickOf(KELCE_PLAYER_ID);
    const context = await contextFor(pick);
    const violations = productRuleViolations(reactionFor(pick, ['just me then']), context, rules);
    expect(violations.join('\n')).toMatch(
      new RegExp(`below the minimum of ${rules.minMessages}`),
    );
  });

  it('a seven-message reaction is rejected as invalid', async () => {
    const pick = pickOf(KELCE_PLAYER_ID);
    const context = await contextFor(pick);
    const violations = productRuleViolations(
      reactionFor(pick, ['1', '2', '3', '4', '5', '6', '7']),
      context,
      rules,
    );
    expect(violations.join('\n')).toMatch(/exceeds the maximum of 6/);
  });

  it('every generated reaction for the real draft stays inside the configured bounds', async () => {
    const director = new StubDirector();
    for (const pick of realPicks) {
      const context = await contextFor(pick);
      const reaction = await director.generateReaction(context);
      const count = reaction.reactions.length;
      expect(count, `pick ${pick.pickNo} ${pick.playerName}`).toBeGreaterThanOrEqual(
        rules.minMessages,
      );
      expect(count, `pick ${pick.pickNo} ${pick.playerName}`).toBeLessThanOrEqual(
        rules.maxMessages,
      );
      expect(productRuleViolations(reaction, context, rules)).toEqual([]);
    }
  });

  it('the Director refuses a seven-message answer rather than trimming it', async () => {
    const pick = pickOf(KELCE_PLAYER_ID);
    const context = await contextFor(pick);
    const dir = await mkdtemp(path.join(tempRoot, 'seven-'));
    const overlong = directorEnvelope(reactionFor(pick, ['1', '2', '3', '4', '5', '6', '7']));

    const director = new ClaudeCliDirector({
      spawn: fakeSpawn([overlong]),
      failedEventsFile: path.join(dir, 'failed.jsonl'),
    });

    await expect(director.generateReaction(context)).rejects.toThrow(/maxItems|6 items/i);
    expect(await countLines(path.join(dir, 'failed.jsonl'))).toBe(1);
  });
});

// ===========================================================================
// Rule 3 — the Season Literal for 2025
// ===========================================================================

describe('Rule 3 — a message that reaches back to 2025 always says 2025', () => {
  it('the scanner catches the seasonless history references the prompt forbids', () => {
    const pick = pickOf(RODGERS_PLAYER_ID);
    const bad = [
      'Back together again.',
      'Remember our title?',
      'Same roster as last time.',
      "We've done this before.",
      'You had me and you let me go.',
    ];
    for (const text of bad) {
      const violations = seasonLiteralViolations(reactionFor(pick, [text, 'ok']));
      expect(violations.join('\n'), `"${text}" slipped past the scanner`).not.toBe('');
    }
  });

  it('the scanner accepts the history references the prompt calls correct', () => {
    const pick = pickOf(RODGERS_PLAYER_ID);
    const good = [
      "You had me in 2025 and you're really doing this again?",
      "We were both on Max's 2023 championship roster.",
      'After what I gave you in 2025, I owe you one.',
    ];
    for (const text of good) {
      expect(seasonLiteralViolations(reactionFor(pick, [text, 'ok'])), text).toEqual([]);
    }
  });

  it('a message flagged fantasy_2025_history that never says 2025 is a violation', () => {
    const pick = pickOf(RODGERS_PLAYER_ID);
    const reaction = reactionFor(pick, ['we go way back', 'ok']);
    const first = reaction.reactions[0];
    if (first) first.reason = 'fantasy_2025_history';
    expect(seasonLiteralViolations(reaction).join('\n')).toMatch(/never says 2025/);
  });

  it('no generated reaction for the real draft references history without a season', async () => {
    const director = new StubDirector();
    for (const pick of realPicks) {
      const context = await contextFor(pick);
      const reaction = await director.generateReaction(context);
      expect(
        seasonLiteralViolations(reaction),
        `pick ${pick.pickNo} ${pick.playerName}`,
      ).toEqual([]);
    }
  });

  it('a prompt carrying 2025 memory demands the season be stated as a four-digit year', async () => {
    const pick = pickOf(RODGERS_PLAYER_ID);
    const context = await contextFor(pick, {
      history: { historyFor: (id) => (id === pick.playerId ? memory2025(id) : null) },
    });
    const prompt = renderUserPrompt(context);

    expect(prompt).toContain('2025');
    expect(prompt).toContain('must state the season as a four-digit year');
  });

  it('the Director system prompt requires the four-digit season on every history reference', () => {
    expect(systemPrompt).toMatch(/four-digit year/i);
    expect(systemPrompt).toContain('2025');
    expect(systemPrompt).toContain('Back together again.');
  });

  // GAP CLOSED. This was `it.fails` while the Season Literal rule lived only in
  // the prompt. Running 30 picks through the real Director settled it: 42 of 43
  // history lines named their season unprompted, and the one that did not
  // ("New team, new manager, new me.") is exactly this failure mode. 97.7% is
  // not good enough for a stated product rule, so `productRuleViolations` now
  // scans the returned text and rejects it.
  it(
    'the Director rejects a 2025 history reference that never names the season',
    async () => {
      const pick = pickOf(RODGERS_PLAYER_ID);
      const context = await contextFor(pick, {
        history: { historyFor: (id) => (id === pick.playerId ? memory2025(id) : null) },
      });
      const dir = await mkdtemp(path.join(tempRoot, 'season-literal-'));

      const seasonless = reactionFor(pick, ['Back together again.', 'Wild.']);
      const first = seasonless.reactions[0];
      if (first) {
        first.reason = 'fantasy_2025_history';
        first.historyRefs = ['2025 roster'];
      }

      const director = new ClaudeCliDirector({
        spawn: fakeSpawn([directorEnvelope(seasonless)]),
        failedEventsFile: path.join(dir, 'failed.jsonl'),
      });

      await expect(director.generateReaction(context)).rejects.toThrow();
    },
  );
});

// ===========================================================================
// Rule 4 — the Season Literal for championships
// ===========================================================================

describe('Rule 4 — a message that reaches back to a championship always names its season', () => {
  it('a championship record with no explicit season never reaches the prompt', () => {
    expect(() =>
      assertContextClean({
        draftedPlayerHistory: {
          playerId: PITTS_PLAYER_ID,
          lastSeason: null,
          championships: [
            { season: Number.NaN, managerId: 'm', managerName: 'Max' },
          ],
        },
      }),
    ).toThrow(ForbiddenHistoryError);
  });

  it('a championship in the prompt is always rendered with its literal season', async () => {
    const pick = pickOf(RODGERS_PLAYER_ID);
    const context = await contextFor(pick, {
      history: {
        historyFor: (id) =>
          id === pick.playerId
            ? {
                playerId: id,
                lastSeason: null,
                championships: [
                  { season: 2023, managerId: 'm', managerName: 'Max', sharedChampionPlayerIds: [] },
                ],
              }
            : null,
      },
    });
    const prompt = renderUserPrompt(context);

    expect(prompt).toMatch(/2023: on Max's championship roster\./);
    expect(prompt).toContain('must state the season as a four-digit year');
  });

  it('a championship message that names no season is a violation', () => {
    const pick = pickOf(RODGERS_PLAYER_ID);
    const reaction = reactionFor(pick, ['Remember our title?', 'ok']);
    const first = reaction.reactions[0];
    if (first) first.reason = 'championship_history';
    expect(seasonLiteralViolations(reaction).join('\n')).toMatch(
      /championship season named|no four-digit season/,
    );
  });

  it('the Director system prompt requires the championship season to be spelled out', () => {
    expect(systemPrompt).toContain("We were both on Max's 2023 championship roster.");
    expect(systemPrompt).toMatch(/Remember our title\?/);
  });

  // GAP CLOSED alongside Rule 3 — the same text scan covers championship
  // references, which may name any season and so need the year even more.
  it(
    'the Director rejects a championship reference that never names the season',
    async () => {
      const pick = pickOf(RODGERS_PLAYER_ID);
      const context = await contextFor(pick, {
        history: {
          historyFor: (id) =>
            id === pick.playerId
              ? {
                  playerId: id,
                  lastSeason: null,
                  championships: [{ season: 2023, managerId: 'm', managerName: 'Max' }],
                }
              : null,
        },
      });
      const dir = await mkdtemp(path.join(tempRoot, 'championship-literal-'));

      const seasonless = reactionFor(pick, ['Remember our title?', 'Wild.']);
      const first = seasonless.reactions[0];
      if (first) first.reason = 'championship_history';

      const director = new ClaudeCliDirector({
        spawn: fakeSpawn([directorEnvelope(seasonless)]),
        failedEventsFile: path.join(dir, 'failed.jsonl'),
      });

      await expect(director.generateReaction(context)).rejects.toThrow();
    },
  );
});

// ===========================================================================
// Rule 5 — the memory cutoff
// ===========================================================================

describe('Rule 5 — no non-championship roster history from before 2025 ever reaches the prompt', () => {
  /**
   * A 2024 roster memory. `LastSeasonHistory.season` is the literal type `2025`,
   * so the compiler already forbids this — the cast reproduces what a corrupt
   * import or a hand-edited `last-season.json` would actually hand the builder,
   * which is the case the runtime guard exists for.
   */
  const memory2024 = {
    playerId: PITTS_PLAYER_ID,
    lastSeason: {
      season: 2024,
      managerId: 'mgr-max',
      managerName: 'Max',
      performance: 'disappointing',
      teamFinish: 9,
      champion: false,
      sharedRosterPlayerIds: [],
    },
    championships: [],
  } as unknown as PlayerHistory;

  it('the context builder refuses to assemble a context carrying 2024 roster memory', async () => {
    const pick = pickOf(PITTS_PLAYER_ID);
    await expect(
      contextFor(pick, { history: { historyFor: () => memory2024 } }),
    ).rejects.toThrow(ForbiddenHistoryError);
  });

  it('the real history module refuses 2024 roster memory before it can be rendered', async () => {
    const pick = pickOf(PITTS_PLAYER_ID);
    await expect(
      contextFor(pick, {
        history: { historyFor: () => memory2024, assertNoForbiddenHistory },
      }),
    ).rejects.toThrow(/2024/);
  });

  it('the cutoff holds for every pick in the real draft, not just the demo ones', async () => {
    for (const pick of spreadOfPicks(20)) {
      await expect(
        contextFor(pick, { history: { historyFor: () => memory2024 } }),
        `pick ${pick.pickNo} ${pick.playerName}`,
      ).rejects.toThrow(ForbiddenHistoryError);
    }
  });

  it('a pre-2025 championship roster is the one memory that survives the cutoff', async () => {
    const pick = pickOf(RODGERS_PLAYER_ID);
    const context = await contextFor(pick, {
      history: {
        historyFor: (id) =>
          id === pick.playerId
            ? {
                playerId: id,
                lastSeason: null,
                championships: [
                  { season: 2019, managerId: 'm', managerName: 'Max', sharedChampionPlayerIds: [] },
                ],
              }
            : null,
      },
    });
    expect(context.draftedPlayerHistory?.championships[0]?.season).toBe(2019);
    expect(renderUserPrompt(context)).toContain('2019: on Max\'s championship roster');
  });

  it('the rendered prompt names no pre-2025 season outside a championship sentence', async () => {
    const pick = pickOf(RODGERS_PLAYER_ID);
    const context = await contextFor(pick, {
      history: {
        historyFor: (id) =>
          id === pick.playerId
            ? memory2025(id, {
                championships: [
                  { season: 2023, managerId: 'm', managerName: 'Max', sharedChampionPlayerIds: [] },
                  { season: 2019, managerId: 'm', managerName: 'Max', sharedChampionPlayerIds: [] },
                ],
              })
            : null,
      },
    });
    const prompt = renderUserPrompt(context);

    // The allowed facts are there...
    expect(prompt).toContain('2025');
    expect(prompt).toContain('2023');
    expect(prompt).toContain('2019');
    // ...and every pre-cutoff season that appears is framed as a championship.
    expect(preCutoffSeasonLines(prompt)).toEqual([]);
  });

  it('no prompt from the real draft mentions a pre-2025 season at all when there is no memory', async () => {
    for (const pick of spreadOfPicks(30)) {
      const prompt = renderUserPrompt(await contextFor(pick));
      expect(preCutoffSeasonLines(prompt), `pick ${pick.pickNo} ${pick.playerName}`).toEqual([]);
    }
  });

  it('the transcript handed to the prompt is capped, so old dialogue cannot leak back in', async () => {
    const pick = pickOf(KELCE_PLAYER_ID);
    const transcript: LoungeMessage[] = Array.from({ length: 60 }, (_, index) => ({
      eventId: `x:${index}:y`,
      seq: index + 1,
      speakerPlayerId: KELCE_PLAYER_ID,
      speakerName: 'Travis Kelce',
      text: `line ${index + 1}`,
      reason: 'star_regular' as const,
      createdAt: '2026-08-01T09:00:00.000Z',
      simulated: true,
    }));

    const context = await contextFor(pick, { recentMessages: transcript });
    expect(context.recentMessages).toHaveLength(MAX_RECENT_MESSAGES);
    const prompt = renderUserPrompt(context);
    expect(prompt).not.toContain('line 1\n');
    expect(prompt).toContain('line 60');
  });
});

// ===========================================================================
// Rule 6 — Kyle Pitts League Lore
// ===========================================================================

describe("Rule 6 — Kyle Pitts always carries the league's bust lore", () => {
  const pitts = regular('kyle_pitts');

  it("Kyle Pitts' shipped profile contains league-specific bust lore", () => {
    expect(pitts.leagueLore ?? []).not.toEqual([]);
    expect((pitts.leagueLore ?? []).join(' ')).toMatch(/bust|draft disappointment/i);
    expect(pitts.required).toBe(true);
  });

  it('the bust lore reaches the prompt on the real pick that drafted him', async () => {
    const pick = pickOf(PITTS_PLAYER_ID);
    expect(pick.pickNo).toBe(74);
    const prompt = renderUserPrompt(await contextFor(pick));
    for (const lore of pitts.leagueLore ?? []) {
      expect(prompt).toContain(lore);
    }
  });

  it('the bust lore reaches the prompt under every actor-selection seed', async () => {
    const pick = pickOf(PITTS_PLAYER_ID);
    for (let seed = 0; seed < 40; seed += 1) {
      const prompt = renderUserPrompt(await contextFor(pick, { seed }));
      expect(prompt, `seed ${seed}`).toContain('League lore:');
      for (const lore of pitts.leagueLore ?? []) {
        expect(prompt, `seed ${seed}`).toContain(lore);
      }
    }
  });

  it('the lore travels with him whenever he is in the room, drafted or not', async () => {
    let sightings = 0;
    for (const pick of realPicks) {
      const context = await contextFor(pick);
      const present = context.actors.some((actor) => actor.starKey === 'kyle_pitts');
      if (!present) continue;
      sightings += 1;
      const prompt = renderUserPrompt(context);
      for (const lore of pitts.leagueLore ?? []) {
        expect(prompt, `pick ${pick.pickNo} ${pick.playerName}`).toContain(lore);
      }
    }
    // He is a Regular; over 238 picks he must turn up on his own account.
    expect(sightings).toBeGreaterThan(1);
  });

  it('the persistent bust joke stays alive in the Lounge on every pick his gate admits', async () => {
    const context = await contextFor(pickOf(ATL_PICK_PLAYER_ID));
    const joke = context.runningJokes.find((entry) => entry.id === 'kyle-pitts-draft-bust');
    expect(joke, 'the persistent League Lore joke must never decay while he is admitted').toBeDefined();
    expect(joke?.persistent).toBe(true);
  });
});

// ===========================================================================
// Rule 7 — the Kelce lyric guardrail
// ===========================================================================

describe('Rule 7 — a Lounge with Travis Kelce in it always forbids Taylor Swift lyrics', () => {
  const kelce = regular('travis_kelce');
  const lyricGuardrail = (kelce.guardrails ?? []).find((line) => /lyric/i.test(line));

  it("Travis Kelce's shipped profile forbids quoting lyrics", () => {
    expect(lyricGuardrail, 'no lyric guardrail on the Kelce profile').toBeDefined();
    expect(lyricGuardrail).toMatch(/Do not quote copyrighted Taylor Swift lyrics/i);
  });

  it('the lyric prohibition reaches the prompt on the real pick that drafted him', async () => {
    const pick = pickOf(KELCE_PLAYER_ID);
    expect(pick.pickNo).toBe(119);
    const prompt = renderUserPrompt(await contextFor(pick));
    expect(prompt).toContain(lyricGuardrail ?? 'lyrics');
  });

  it('every prompt across the real draft that has Kelce in the room carries the prohibition', async () => {
    let sightings = 0;
    for (const pick of realPicks) {
      const context = await contextFor(pick);
      const present = context.actors.some((actor) => actor.starKey === 'travis_kelce');
      if (!present) continue;
      sightings += 1;
      expect(
        renderUserPrompt(context),
        `pick ${pick.pickNo} ${pick.playerName}`,
      ).toContain(lyricGuardrail ?? 'lyrics');
    }
    expect(sightings).toBeGreaterThan(1);
  });

  it('the prohibition survives every actor-selection seed on his own pick', async () => {
    const pick = pickOf(KELCE_PLAYER_ID);
    for (let seed = 0; seed < 40; seed += 1) {
      expect(
        renderUserPrompt(await contextFor(pick, { seed })),
        `seed ${seed}`,
      ).toContain(lyricGuardrail ?? 'lyrics');
    }
  });

  it('the Director system prompt forbids reproducing lyrics for anyone, not just Kelce', () => {
    expect(systemPrompt).toMatch(/Never reproduce song lyrics/i);
    expect(systemPrompt).toMatch(/NEVER an actual lyric/i);
  });
});

// ===========================================================================
// Rule 8 — idempotency
// ===========================================================================

describe('Rule 8 — reprocessing the same pick never creates a second event', () => {
  it('persisting the same reaction twice writes it exactly once', async () => {
    const files = await tempLounge('idempotent');
    const pick = pickOf(PITTS_PLAYER_ID);
    const reaction = reactionFor(pick, ['round 6, again', 'this is the year']);

    const first = await persistReaction(reaction, files);
    expect(first.persisted).toBe(true);

    const second = await persistReaction(reaction, files);
    expect(second.persisted).toBe(false);
    expect(second.record).toBeUndefined();

    expect(await countLines(files.reactionsFile)).toBe(1);
    expect(await countLines(files.messagesFile)).toBe(2);
  });

  it('a re-run that produces different dialogue still writes nothing the second time', async () => {
    const files = await tempLounge('idempotent-different');
    const pick = pickOf(KELCE_PLAYER_ID);

    await persistReaction(reactionFor(pick, ['round 9?', 'ok']), files);
    const rewritten = reactionFor(pick, ['completely different take', 'and another']);
    const result = await persistReaction(rewritten, files);

    expect(result.persisted).toBe(false);
    expect(await countLines(files.reactionsFile)).toBe(1);
    expect(await countLines(files.messagesFile)).toBe(2);
    const transcript = await readFile(files.messagesFile, 'utf8');
    expect(transcript).not.toContain('completely different take');
  });

  it('hasProcessed answers for the deterministic {draftId}:{pickNo}:{playerId} event id', async () => {
    const files = await tempLounge('has-processed');
    const pick = pickOf(RODGERS_PLAYER_ID);
    expect(pick.eventId).toBe(`${pick.draftId}:${pick.pickNo}:${pick.playerId}`);

    expect(await hasProcessed(pick.eventId, files)).toBe(false);
    await persistReaction(reactionFor(pick, ['82 picks', 'unbelievable']), files);
    expect(await hasProcessed(pick.eventId, files)).toBe(true);
  });

  it('replaying a slice of the real draft three times leaves one event per pick', async () => {
    const files = await tempLounge('replay');
    const sample = spreadOfPicks(12);

    for (let pass = 0; pass < 3; pass += 1) {
      for (const pick of sample) {
        await persistReaction(reactionFor(pick, ['a', 'b']), files);
      }
    }

    expect(await countLines(files.reactionsFile)).toBe(sample.length);
    expect(await countLines(files.messagesFile)).toBe(sample.length * 2);

    const seqs = (await readFile(files.messagesFile, 'utf8'))
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => (JSON.parse(line) as LoungeMessage).seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });
});

// ===========================================================================
// Rule 9 — the target league is never simulated while pre-draft
// ===========================================================================

describe('Rule 9 — the pre-draft target league is never selected for simulation', () => {
  const leaguesPath = `/user/${USER_ID}/leagues/nfl/2026`;

  function routes(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      [leaguesPath]: leagues2026(),
      [`/league/${HOTELKIT_LEAGUE_ID}/drafts`]: [
        draft({ draft_id: HOTELKIT_DRAFT_ID, league_id: HOTELKIT_LEAGUE_ID, status: 'pre_draft' }),
      ],
      [`/league/${BROS_LEAGUE_ID}/drafts`]: [brosDraft()],
      [`/league/${AFFC_LEAGUE_ID}/drafts`]: [
        draft({ draft_id: AFFC_DRAFT_ID, league_id: AFFC_LEAGUE_ID, status: 'pre_draft' }),
      ],
      [`/draft/${BROS_DRAFT_ID}/picks`]: brosPicks(),
      ...overrides,
    };
  }

  it('hotelkit Fantasies is skipped even when it has a completed draft full of picks', async () => {
    const { client } = await testClient(
      routes({
        [`/league/${HOTELKIT_LEAGUE_ID}/drafts`]: [
          draft({
            draft_id: HOTELKIT_DRAFT_ID,
            league_id: HOTELKIT_LEAGUE_ID,
            status: 'complete',
            last_picked: 9_999_999_999_999,
            settings: { rounds: 15, teams: 8 },
          }),
        ],
        [`/draft/${HOTELKIT_DRAFT_ID}/picks`]: brosPicks(),
      }),
    );

    const selected = await discoverSimulationDraft(client, testConfig());
    expect(selected.leagueName).toBe('Defensive Bros');
    expect(selected.leagueId).not.toBe(HOTELKIT_LEAGUE_ID);
    expect(selected.draftId).not.toBe(HOTELKIT_DRAFT_ID);
  });

  it('discovery fails loudly rather than falling back to the pre-draft target league', async () => {
    const { client } = await testClient({
      [leaguesPath]: leagues2026().filter((league) => league.name === 'hotelkit Fantasies'),
      [`/league/${HOTELKIT_LEAGUE_ID}/drafts`]: [
        draft({
          draft_id: HOTELKIT_DRAFT_ID,
          league_id: HOTELKIT_LEAGUE_ID,
          status: 'complete',
          settings: { rounds: 15, teams: 8 },
        }),
      ],
      [`/draft/${HOTELKIT_DRAFT_ID}/picks`]: brosPicks(),
    });

    await expect(discoverSimulationDraft(client, testConfig())).rejects.toThrow(
      /No completed 2026 draft is available to simulate/,
    );
  });

  it('the target league is still identifiable — it is excluded, not invisible', async () => {
    const { client } = await testClient(routes());
    const target = await findTargetLeague(client, testConfig());
    expect(target?.league_id).toBe(HOTELKIT_LEAGUE_ID);
    expect(target?.status).toBe('pre_draft');
  });

  it('the selection actually committed to disk is not the target league', () => {
    expect(realSelectedDraft.leagueName).toBe('Defensive Bros');
    expect(realSelectedDraft.leagueName).not.toBe(realConfig.sleeper.targetLeagueName);
    expect(realSelectedDraft.status).toBe('complete');
  });
});

// ===========================================================================
// Rule 10 — the alternate 2026 draft replays
// ===========================================================================

describe('Rule 10 — the completed alternate 2026 draft can be replayed end to end', () => {
  it('the stored simulation holds all 238 real picks', async () => {
    const picks = await loadPicks(simulationPicksFile);
    expect(picks).toHaveLength(238);
    expect(picks).toHaveLength(realSelectedDraft.totalPicks);
  });

  it('every stored pick is a valid Pick', async () => {
    const picks = await loadPicks(simulationPicksFile);
    for (const pick of picks) {
      expect(() => validatePick(pick), `pick ${pick.pickNo} ${pick.playerName}`).not.toThrow();
    }
  });

  it('pick numbers ascend without gaps or repeats', async () => {
    const picks = await loadPicks(simulationPicksFile);
    const numbers = picks.map((pick) => pick.pickNo);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(numbers[0]).toBe(1);
    expect(numbers[numbers.length - 1]).toBe(238);
  });

  it('every event id is unique and follows {draftId}:{pickNo}:{playerId}', async () => {
    const picks = await loadPicks(simulationPicksFile);
    const ids = picks.map((pick) => pick.eventId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const pick of picks) {
      expect(pick.eventId).toBe(`${pick.draftId}:${pick.pickNo}:${pick.playerId}`);
      expect(pick.draftId).toBe(realSelectedDraft.draftId);
      expect(pick.season).toBe(2026);
    }
  });

  it('every replayed pick is marked simulated, never presented as live', async () => {
    const picks = await loadPicks(simulationPicksFile);
    for (const pick of picks) {
      expect(pick.simulated, `pick ${pick.pickNo}`).toBe(true);
      expect(pick.synthetic ?? false, `pick ${pick.pickNo}`).toBe(false);
    }
  });

  it('the §15 demo picks are all really in the draft, so no synthetic pick is needed', () => {
    expect(pickOf(PITTS_PLAYER_ID)).toMatchObject({ pickNo: 74, round: 6, playerName: 'Kyle Pitts' });
    expect(pickOf(KELCE_PLAYER_ID)).toMatchObject({ pickNo: 119, round: 9, playerName: 'Travis Kelce' });
    expect(pickOf(RODGERS_PLAYER_ID)).toMatchObject({ pickNo: 229, round: 17, playerName: 'Aaron Rodgers' });
  });

  it('the whole draft replays through the director without a single failure', async () => {
    const director = new StubDirector();
    const seen = new Set<string>();
    for (const pick of realPicks) {
      const context = await contextFor(pick);
      const reaction = await director.generateReaction(context);
      expect(reaction.eventId).toBe(pick.eventId);
      expect(seen.has(reaction.eventId), `duplicate event ${reaction.eventId}`).toBe(false);
      seen.add(reaction.eventId);
      expect(() => validateReaction(reaction)).not.toThrow();
    }
    expect(seen.size).toBe(238);
  });
});

// ===========================================================================
// Rule 11 — Regulars are ambient
// ===========================================================================

describe('Rule 11 — Regulars are ambient: relevance raises their odds, it never gates them', () => {
  const puka = regular('puka_nacua');
  const unconnected = pickOf(UNCONNECTED_PICK_PLAYER_ID);

  it('the fixture pick really has nothing to do with the Regular under test', () => {
    // Puka Nacua: LAR wide receiver. The pick: a Los Angeles Chargers kicker.
    expect(unconnected.position).toBe('K');
    expect(unconnected.nflTeam).toBe('LAC');
    expect(puka.position).toBe('WR');
    expect(starMeta['puka_nacua']?.nflTeam).toBe('LAR');
    expect(puka.required).toBe(false);
    // No seeded relationship mentions him at all.
    const mentioned = realRelationships.relationships.some((rel) =>
      rel.players.includes('puka_nacua'),
    );
    expect(mentioned).toBe(false);
    // No running joke involves him.
    const inJoke = realState.activeRunningJokes.some((joke) =>
      joke.participants.includes('puka_nacua'),
    );
    expect(inJoke).toBe(false);
    // No Fantasy Memory is loaded for this suite at all.
    expect(unconnected.playerId).not.toBe(starMeta['puka_nacua']?.playerId);
  });

  it('a Regular with no connection to the pick can still speak', async () => {
    let selectedAtLeastOnce = false;
    for (let seed = 0; seed < 200 && !selectedAtLeastOnce; seed += 1) {
      const context = await contextFor(unconnected, { seed });
      selectedAtLeastOnce = context.actors.some((actor) => actor.starKey === 'puka_nacua');
    }
    expect(
      selectedAtLeastOnce,
      'a Regular with zero connection to the pick was never selectable — Regulars have been gated on relevance',
    ).toBe(true);
  });

  it('an unconnected Regular carries his bare activity as his weight — no bonus, no penalty', () => {
    // Sampling is stochastic; the weight formula is not.
    expect(actorWeight(puka.activity, {})).toBe(puka.activity);
    expect(actorWeight(puka.activity, {})).toBeGreaterThan(0);
  });

  it('every ungated Regular is reachable on a pick that concerns none of them', async () => {
    const seen = new Set<string>();
    for (let seed = 0; seed < 400; seed += 1) {
      const actors = selectActors({
        pick: unconnected,
        seed,
        regulars: realRegulars,
        starMeta,
        nflTeammates: [],
        runningJokes: realState.activeRunningJokes,
        rules,
      });
      for (const actor of actors) if (actor.starKey) seen.add(actor.starKey);
    }
    // A Regular carrying an Appearance Gate is the stated exception (Rule 14);
    // every other Regular must still turn up on a pick about nobody.
    const missing = realRegulars
      .filter((star) => star.appearance === undefined)
      .map((star) => star.key)
      .filter((key) => !seen.has(key));
    expect(missing, `these ungated Regulars were never selectable: ${missing.join(', ')}`).toEqual(
      [],
    );
  });

  it('the Lounge is never empty: some Regular is in the room for every pick of the real draft', async () => {
    for (const pick of realPicks) {
      const context = await contextFor(pick);
      const hasRegular = context.actors.some((actor) => actor.starKey !== undefined);
      expect(hasRegular, `pick ${pick.pickNo} ${pick.playerName} had no Regular in the room`).toBe(
        true,
      );
    }
  });

  it('the prompt tells the Director that an unconnected Regular is normal, not an error', async () => {
    const prompt = renderUserPrompt(await contextFor(unconnected));
    expect(prompt).toMatch(/here for every pick, whether or not this one concerns him/);
    expect(prompt).toMatch(/ambient Lounge regular/);
    expect(systemPrompt).toMatch(/They are not waiting to be relevant/);
    expect(systemPrompt).toMatch(/bonus angle, not a licence requirement/);
  });

  it('being drafted does not make a Regular more likely to speak elsewhere', () => {
    // CONTEXT.md: "Regulars are not more likely to speak because they were drafted."
    // The weight formula has no drafted-recently term at all; activity plus
    // bounded relevance bonuses is the whole of it.
    for (const star of realRegulars) {
      expect(actorWeight(star.activity, {}), star.key).toBe(star.activity);
    }
  });
});

// ===========================================================================
// Rule 12 — the Director isolation guard (ADR 0001)
// ===========================================================================

describe('Rule 12 — the Director always runs behind the ADR 0001 isolation guard', () => {
  const guardedFlags = [
    '--tools',
    '--setting-sources',
    '--disable-slash-commands',
    '--strict-mcp-config',
    '--output-format',
    '--no-session-persistence',
  ] as const;

  async function capture(): Promise<string[][]> {
    const pick = pickOf(RODGERS_PLAYER_ID);
    const context = await contextFor(pick);
    const spawn = fakeSpawn([directorEnvelope(reactionFor(pick, ['82 picks late', 'noted']))]);
    const dir = await mkdtemp(path.join(tempRoot, 'isolationguard-'));
    const director = new ClaudeCliDirector({
      spawn,
      model: 'sonnet',
      failedEventsFile: path.join(dir, 'failed.jsonl'),
    });
    await director.generateReaction(context);
    return spawn.calls;
  }

  it('every isolation flag ADR 0001 requires is on the command line', async () => {
    const [argv] = await capture();
    expect(argv).toBeDefined();
    for (const flag of guardedFlags) {
      expect(
        argv,
        `missing ${flag} — the Director would no longer be isolated from the operator's machine`,
      ).toContain(flag);
    }
    for (const flag of REQUIRED_CLI_FLAGS) {
      expect(argv, `missing ${flag}`).toContain(flag);
    }
  });

  it('the default system prompt and settings are both stripped, not merely overridden', async () => {
    const [argv = []] = await capture();
    expect(argAfter(argv, '--tools')).toBe('');
    expect(argAfter(argv, '--setting-sources')).toBe('');
    expect(argAfter(argv, '--output-format')).toBe('json');
    expect(argAfter(argv, '--system-prompt-file')).toBe(directorSystemPromptFile);
  });

  it('--bare never appears, so the Director never demands an API key', async () => {
    const calls = await capture();
    for (const argv of calls) {
      expect(argv).not.toContain('--bare');
      expect(argv).not.toContain('--dangerously-skip-permissions');
    }
  });

  it('the isolation guard is still in place on the retry attempt', async () => {
    const pick = pickOf(RODGERS_PLAYER_ID);
    const context = await contextFor(pick);
    const dir = await mkdtemp(path.join(tempRoot, 'isolationguard-retry-'));
    const spawn = fakeSpawn([
      directorEnvelope({ eventId: pick.eventId, reactions: [] }),
      directorEnvelope(reactionFor(pick, ['fine', 'ok'])),
    ]);
    const director = new ClaudeCliDirector({
      spawn,
      failedEventsFile: path.join(dir, 'failed.jsonl'),
    });

    await director.generateReaction(context);
    expect(spawn.calls).toHaveLength(2);
    for (const argv of spawn.calls) {
      for (const flag of guardedFlags) expect(argv).toContain(flag);
      expect(argv).not.toContain('--bare');
    }
  });

  it('the Director is invoked as a program plus argv, never as a shell string', async () => {
    const pick = pickOf(RODGERS_PLAYER_ID);
    const context = await contextFor(pick);
    const seen: { file: string; args: readonly string[] }[] = [];
    const dir = await mkdtemp(path.join(tempRoot, 'isolationguard-argv-'));
    const director = new ClaudeCliDirector({
      cliPath: 'claude',
      failedEventsFile: path.join(dir, 'failed.jsonl'),
      spawn: async (file, args) => {
        seen.push({ file, args });
        return { stdout: directorEnvelope(reactionFor(pick, ['a', 'b'])) };
      },
    });

    await director.generateReaction(context);
    expect(seen[0]?.file).toBe('claude');
    expect(seen[0]?.file).not.toMatch(/[ |;&]/);
    expect(Array.isArray(seen[0]?.args)).toBe(true);
  });
});

// ===========================================================================
// Rule 13 — ADP sentinels (ADR 0004)
// ===========================================================================

describe('Rule 13 — ADP sentinels never leak and search_rank is never an ADP fallback', () => {
  it('no value in the shipped ADP artifact is at or above the unranked sentinel', () => {
    expect(realAdp.unrankedSentinel).toBe(900);
    const leaked = Object.entries(realAdp.adp).filter(([, value]) => value >= 900);
    expect(leaked, `sentinel values leaked into the artifact: ${JSON.stringify(leaked)}`).toEqual(
      [],
    );
  });

  it('the artifact is an ordinal board of contiguous positions, not a sparse map', () => {
    // The exact size is whatever the last `scripts/build-adp.mjs` run produced —
    // the artifact is regenerated before a draft, so pinning the count here would
    // turn a routine refresh into a test failure. What must hold is the SHAPE:
    // ranks 1..rankedCount, each used exactly once. A floor catches a truncated
    // or empty rebuild, which is the failure this test actually protects against.
    const values = Object.values(realAdp.adp).sort((a, b) => a - b);
    expect(values).toHaveLength(realAdp.rankedCount);
    expect(values.length).toBeGreaterThan(300);
    expect(values[0]).toBe(1);
    expect(values[values.length - 1]).toBe(realAdp.rankedCount);
    expect(new Set(values).size).toBe(values.length);
  });

  it('an unranked player yields no ADP at all rather than a huge number', () => {
    expect(adpFor('this-player-does-not-exist', realAdp)).toBeNull();
    expect(adpFor('96', realAdp)).toBe(147);
  });

  it('a player with a search_rank but no ADP produces no fall and no reach', () => {
    // search_rank 4 vs pick 200 would manufacture a 196-pick "slide" (ADR 0004).
    const withOnlySearchRank: Record<string, SleeperPlayer> = {
      x: {
        player_id: 'x',
        full_name: 'Ranked But Unpriced',
        position: 'QB',
        team: 'BUF',
        active: true,
        search_rank: 4,
      },
    };
    const pick: Pick = { ...pickOf(RODGERS_PLAYER_ID), playerId: 'x', playerName: 'Ranked But Unpriced', pickNo: 200 };
    const signals = computeDraftSignals(pick, [], withOnlySearchRank);
    expect(signals.fellBelowRank).toBeUndefined();
    expect(signals.reachedAboveRank).toBeUndefined();
  });

  it('no pick in the real draft ever produces a fall or reach larger than the board itself', async () => {
    for (const pick of realPicks) {
      const signals = computeDraftSignals(pick, priorPicksOf(pick), players);
      if (signals.fellBelowRank !== undefined) {
        expect(signals.fellBelowRank, `pick ${pick.pickNo} ${pick.playerName}`).toBeLessThan(456);
      }
      if (signals.reachedAboveRank !== undefined) {
        expect(signals.reachedAboveRank, `pick ${pick.pickNo} ${pick.playerName}`).toBeLessThan(456);
      }
    }
  });

  it("Aaron Rodgers' real 82-pick slide is measured against ADP, not search_rank", () => {
    const pick = pickOf(RODGERS_PLAYER_ID);
    const signals = computeDraftSignals(pick, priorPicksOf(pick), players);
    expect(adpFor(RODGERS_PLAYER_ID, realAdp)).toBe(147);
    expect(signals.fellBelowRank).toBe(pick.pickNo - 147);
    expect(signals.fellBelowRank).toBe(82);
  });

  it('the 64 undrafted-by-ADP picks of the real draft stay silent about value', async () => {
    let silent = 0;
    for (const pick of realPicks) {
      if (adpFor(pick.playerId, realAdp) !== null) continue;
      silent += 1;
      const signals = computeDraftSignals(pick, priorPicksOf(pick), players);
      expect(signals.fellBelowRank, `pick ${pick.pickNo} ${pick.playerName}`).toBeUndefined();
      expect(signals.reachedAboveRank, `pick ${pick.pickNo} ${pick.playerName}`).toBeUndefined();
    }
    expect(silent).toBeGreaterThan(0);
  });
});

// ===========================================================================
// Rule 14 — Appearance Gates
// ===========================================================================

describe('Rule 14 — an Appearance Gate is the only thing that keeps a Regular out', () => {
  const pitts = regular('kyle_pitts');
  const gate = pitts.appearance;

  /** Is this Regular reachable on this Pick at all, over many seeds? */
  async function reachableOn(pick: Pick, starKey: string, seeds = 200): Promise<boolean> {
    for (let seed = 0; seed < seeds; seed += 1) {
      const context = await contextFor(pick, { seed });
      if (context.actors.some((actor) => actor.starKey === starKey)) return true;
    }
    return false;
  }

  it('Kyle Pitts is the only gated Regular, and his gate is Atlanta plus the early tight ends', () => {
    const gated = realRegulars.filter((star) => star.appearance !== undefined).map((s) => s.key);
    expect(gated).toEqual(['kyle_pitts']);
    expect(gate?.nflTeams).toEqual(['ATL']);
    expect(gate?.earlyAtPosition).toEqual({ position: 'TE', withinFirst: 4 });
  });

  it('the gate admits Atlanta picks and the first four tight ends, and nothing else', () => {
    expect(gateAllows(gate, { nflTeam: 'ATL', position: 'RB', positionDraftIndex: 30 })).toBe(true);
    expect(gateAllows(gate, { nflTeam: 'DET', position: 'TE', positionDraftIndex: 4 })).toBe(true);
    expect(gateAllows(gate, { nflTeam: 'IND', position: 'TE', positionDraftIndex: 5 })).toBe(false);
    expect(gateAllows(gate, { nflTeam: 'LAC', position: 'K', positionDraftIndex: 3 })).toBe(false);
    // A gate with no ordinal to measure fails closed rather than guessing.
    expect(gateAllows(gate, { nflTeam: 'DET', position: 'TE' })).toBe(false);
    // No gate is no gate: an ungated Regular is admitted everywhere.
    expect(gateAllows(undefined, { nflTeam: 'LAC', position: 'K' })).toBe(true);
  });

  it('he is reachable on an Atlanta pick and on the fourth tight end off the board', async () => {
    expect(await reachableOn(pickOf(ATL_PICK_PLAYER_ID), 'kyle_pitts')).toBe(true);
    expect(await reachableOn(pickOf(EARLY_TE_PICK_PLAYER_ID), 'kyle_pitts')).toBe(true);
  });

  it('he is never in the room on the fifth tight end or on a pick about nobody', async () => {
    for (const playerId of [LATE_TE_PICK_PLAYER_ID, UNCONNECTED_PICK_PLAYER_ID]) {
      const pick = pickOf(playerId);
      for (let seed = 0; seed < 200; seed += 1) {
        const context = await contextFor(pick, { seed });
        const present = context.actors.some((actor) => actor.starKey === 'kyle_pitts');
        expect(present, `pick ${pick.pickNo} ${pick.playerName}, seed ${seed}`).toBe(false);
      }
    }
  });

  it('his lore leaves the room with him — nobody else carries the joke by proxy', async () => {
    const context = await contextFor(pickOf(LATE_TE_PICK_PLAYER_ID));
    expect(context.runningJokes.some((joke) => joke.id === 'kyle-pitts-draft-bust')).toBe(false);
    const prompt = renderUserPrompt(context);
    expect(prompt).not.toContain('Kyle Pitts');
    for (const lore of pitts.leagueLore ?? []) expect(prompt).not.toContain(lore);
  });

  it('being drafted bypasses the gate: he always speaks on his own pick', async () => {
    const pick = pickOf(PITTS_PLAYER_ID);
    for (let seed = 0; seed < 40; seed += 1) {
      const context = await contextFor(pick, { seed });
      const drafted = context.actors[0];
      expect(drafted?.starKey, `seed ${seed}`).toBe('kyle_pitts');
      expect(drafted?.mandatory, `seed ${seed}`).toBe(true);
    }
  });

  it('the gate cuts his exposure across the real draft without silencing him', async () => {
    let sightings = 0;
    for (const pick of realPicks) {
      const context = await contextFor(pick);
      if (context.actors.some((actor) => actor.starKey === 'kyle_pitts')) sightings += 1;
    }
    expect(sightings).toBeGreaterThan(0);
    // Ungated he was drawn on roughly half the board; the gate is worth having
    // only if it is a hard ceiling, so hold it under a tenth of the draft.
    expect(sightings).toBeLessThan(realPicks.length / 10);
  });

  it('the Director is told nobody speaks for a gated Regular who is absent', () => {
    expect(systemPrompt).toMatch(/only in the room when the pick is an Atlanta player/i);
    expect(systemPrompt).toMatch(/nobody speaks for him/i);
  });
});

// ===========================================================================
// Rule 15 — the Manager's own roster reacts
// ===========================================================================

describe("Rule 15 — the Manager's own roster reacts to what he just drafted", () => {
  /** Picks with a roster behind them, spread across the whole board. */
  const withRoster = spreadOfPicks(40).filter((pick) => priorPicksOf(pick).some(
    (prior) => prior.managerId === pick.managerId,
  ));

  it('the sample really does cover picks that land on an existing roster', () => {
    expect(withRoster.length).toBeGreaterThan(20);
  });

  it('somebody already on the roster is offered on every pick that has one', async () => {
    for (const pick of withRoster) {
      const context = await contextFor(pick);
      const rosterNames = new Set(context.manager.roster);
      const mate = context.actors.find((actor) => actor.role === 'roster_teammate');
      expect(
        mate,
        `pick ${pick.pickNo} ${pick.playerName} offered nobody from ${pick.managerName}'s roster`,
      ).toBeDefined();
      expect(rosterNames.has(mate?.name ?? '')).toBe(true);
    }
  });

  it('a roster-mate outweighs the chattiest ambient Regular', () => {
    const loudest = Math.max(...realRegulars.map((star) => star.activity));
    expect(actorWeight(0.6, { sharedRosterThisDraft: true })).toBeGreaterThan(loudest);
    // Same position on the same roster is the sharpest version of the angle.
    expect(
      actorWeight(0.6, { sharedRosterThisDraft: true, competesForStartingSpot: true }),
    ).toBeGreaterThan(actorWeight(0.6, { sharedRosterThisDraft: true }));
  });

  it('the prompt names the stake: the roster he joins, with positions', async () => {
    const pick = withRoster[0];
    expect(pick).toBeDefined();
    const context = await contextFor(pick as Pick);
    const prompt = renderUserPrompt(context);
    expect(prompt).toContain(`${(pick as Pick).managerName}'s roster so far`);
    expect(prompt).toMatch(/joins that roster/);
    expect(prompt).toMatch(/lines up against him for a starting spot/);
    expect(prompt).toMatch(/in this draft — .* just joined his fantasy team/);
  });

  it('the roster listing carries each player\'s position, not just his name', async () => {
    const context = await contextFor(withRoster[0] as Pick);
    expect(context.managerRosterDetail.length).toBe(context.manager.roster.length);
    for (const ref of context.managerRosterDetail) {
      expect(ref.position, `${ref.name} has no position`).toBeTruthy();
    }
  });

  it('the Director is told what the angle is, and how to label it', () => {
    expect(systemPrompt).toMatch(/already on this manager's roster in this draft/i);
    expect(systemPrompt).toMatch(/starting spot/i);
    expect(systemPrompt).toMatch(/roster_teammate/);
    const enumValues = (
      JSON.parse(readFileSync(reactionSchemaFile, 'utf8')) as {
        properties: {
          reactions: { items: { properties: { reason: { enum: string[] } } } };
        };
      }
    ).properties.reactions.items.properties.reason.enum;
    expect(enumValues).toContain('roster_teammate');
  });
});

// ===========================================================================
// Championship restraint — a ring is background, not material
// ===========================================================================

describe('Championship history is background: it barely moves the odds', () => {
  it('a shared ring is the weakest relationship bonus in the formula', async () => {
    const { RELEVANCE_BONUS } = await import('../context/actors.js');
    expect(RELEVANCE_BONUS.sharedChampionship).toBeLessThan(RELEVANCE_BONUS.sharedRoster2025);
    expect(RELEVANCE_BONUS.sharedChampionship).toBeLessThan(RELEVANCE_BONUS.nflTeammate);
    expect(RELEVANCE_BONUS.sharedChampionship).toBeLessThan(
      RELEVANCE_BONUS.sharedRosterThisDraft,
    );
  });

  it('the Director is told to ration championship lines', () => {
    expect(systemPrompt).toMatch(/at most ONE championship line in a reaction/);
    expect(systemPrompt).toMatch(/never the opening message/);
  });

  it('the prompt repeats the restraint wherever championship facts are listed', async () => {
    const pick = pickOf(RODGERS_PLAYER_ID);
    const prompt = renderUserPrompt(
      await contextFor(pick, {
        history: {
          historyFor: (playerId: string) =>
            playerId === pick.playerId
              ? {
                  playerId,
                  lastSeason: null,
                  championships: [
                    {
                      season: 2023,
                      managerId: 'mgr-max',
                      managerName: 'Max',
                      sharedChampionPlayerIds: [],
                    },
                  ],
                }
              : null,
        },
      }),
    );
    expect(prompt).toMatch(/2023: on Max's championship roster/);
    expect(prompt).toMatch(/use at most one championship line in the whole reaction/);
  });
});
