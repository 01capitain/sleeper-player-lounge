import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildContext } from '../../context/builder.js';
import {
  history2025,
  makeMessage,
  makePick,
  makePlayers,
  unconnectedRegulars,
} from '../../context/__tests__/fixtures.js';
import type { LoungeContext, PlayerFact, Reaction, StarPlayer } from '../../types.js';
import {
  ClaudeCliDirector,
  DirectorFailureError,
  FACT_BUDGET,
  REQUIRED_CLI_FLAGS,
  buildPrompt,
  parseEnvelope,
  DEFAULT_DIRECTOR_MODEL,
  productRuleViolations,
  renderUserPrompt,
  selectFacts,
  type DirectorSpawn,
  type FailedEventRecord,
} from '../claude-cli.js';
import { StubDirector, stubReaction } from '../index.js';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const players = makePlayers([
  { player_id: '9001', full_name: 'Cameron Dicker', position: 'K', team: 'LAC', search_rank: 180 },
  { player_id: 't1', full_name: 'Ladd McConkey', position: 'WR', team: 'LAC', search_rank: 40 },
  { player_id: '96', full_name: 'Aaron Rodgers', position: 'QB', team: 'PIT', search_rank: 120 },
  { player_id: '1466', full_name: 'Travis Kelce', position: 'TE', team: 'KC', search_rank: 60 },
  { player_id: '7553', full_name: 'Kyle Pitts', position: 'TE', team: 'ATL', search_rank: 95 },
]);

async function makeContext(): Promise<LoungeContext> {
  return buildContext(makePick(), {
    players,
    starPlayers: unconnectedRegulars,
    state: {
      season: 2026,
      lastProcessedPickNo: 0,
      activeRunningJokes: [
        {
          id: 'kyle-pitts-draft-bust',
          topic: 'Kyle Pitts is remembered by the league as a great draft bust.',
          strength: 1,
          participants: ['kyle_pitts'],
          persistent: true,
        },
      ],
      activeRivalries: [],
      recentTone: 'pre_draft',
    },
    recentMessages: [makeMessage(1, { text: 'this draft is chaos' })],
    priorPicks: [
      makePick({ pickNo: 6, playerId: 'a', playerName: 'Bijan Robinson', managerId: 'mgr1' }),
    ],
    history: {
      historyFor: (playerId) => (playerId === '9001' ? history2025('9001') : null),
    },
    teammatesOf: () => [{ playerId: 't1', name: 'Ladd McConkey', position: 'WR', nflTeam: 'LAC' }],
  });
}

function validReaction(context: LoungeContext): Reaction {
  return {
    eventId: context.pick.eventId,
    pick: {
      season: context.pick.season,
      pickNo: context.pick.pickNo,
      round: context.pick.round ?? null,
      playerId: context.pick.playerId,
      playerName: context.pick.playerName,
      managerName: context.pick.managerName,
    },
    reactions: [
      {
        speakerPlayerId: context.pick.playerId,
        speakerName: context.pick.playerName,
        text: 'Pick 42. A kicker. In round 4. Max, we need to talk.',
        delayMs: 0,
        reason: 'drafted_player',
      },
      {
        speakerPlayerId: 't1',
        speakerName: 'Ladd McConkey',
        text: 'my guy went before half the receivers, respectfully',
        delayMs: 1200,
        reason: 'nfl_teammate',
      },
    ],
  };
}

function envelope(structured: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 4210,
    structured_output: structured,
    ...extra,
  });
}

/** A spawn that records every argv it is handed and replies from a queue. */
function fakeSpawn(responses: string[]): DirectorSpawn & { calls: string[][] } {
  const calls: string[][] = [];
  const spawn = vi.fn(async (_file: string, args: readonly string[]) => {
    calls.push([...args]);
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    return { stdout: next ?? '' };
  }) as unknown as DirectorSpawn & { calls: string[][] };
  (spawn as unknown as { calls: string[][] }).calls = calls;
  return spawn;
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'lounge-director-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// the isolation guard
// ---------------------------------------------------------------------------

describe('ADR 0001 flag set (the isolation guard)', () => {
  it('passes every required flag to the spawned CLI', async () => {
    const context = await makeContext();
    const spawn = fakeSpawn([envelope(validReaction(context))]);
    const director = new ClaudeCliDirector({ spawn, failedEventsFile: path.join(dir, 'failed.jsonl') });

    await director.generateReaction(context);

    const args = spawn.calls[0];
    expect(args).toBeDefined();
    for (const flag of REQUIRED_CLI_FLAGS) {
      expect(args).toContain(flag);
    }
    // The values that actually close the box: no tools, no personal settings,
    // and our own system prompt rather than the CLI's default one.
    expect(args?.[args.indexOf('--model') + 1]).toBe(DEFAULT_DIRECTOR_MODEL);
    expect(args?.[args.indexOf('--tools') + 1]).toBe('');
    expect(args?.[args.indexOf('--output-format') + 1]).toBe('json');
    expect(args?.[args.indexOf('--setting-sources') + 1]).toBe('');
    expect(args?.[args.indexOf('--system-prompt-file') + 1]).toMatch(
      /prompts[/\\]director\.system\.md$/,
    );
    const schema = JSON.parse(args?.[args.indexOf('--json-schema') + 1] ?? '{}') as {
      title?: string;
    };
    expect(schema.title).toBe('Players Lounge Reaction');
    // `--bare` defeats the no-API-key property and must never appear.
    expect(args).not.toContain('--bare');
    // The prompt is an argv entry, never interpolated into a shell string.
    expect(args?.[args.indexOf('-p') + 1]).toContain('Cameron Dicker');
  });

  it('honours a model override', async () => {
    const context = await makeContext();
    const spawn = fakeSpawn([envelope(validReaction(context))]);
    const director = new ClaudeCliDirector({
      spawn,
      model: 'haiku',
      failedEventsFile: path.join(dir, 'failed.jsonl'),
    });
    await director.generateReaction(context);
    const args = spawn.calls[0] ?? [];
    expect(args[args.indexOf('--model') + 1]).toBe('haiku');
  });
});

// ---------------------------------------------------------------------------
// envelope handling
// ---------------------------------------------------------------------------

describe('the CLI JSON envelope', () => {
  it('reads structured_output and surfaces the duration', async () => {
    const context = await makeContext();
    const director = new ClaudeCliDirector({
      spawn: fakeSpawn([envelope(validReaction(context))]),
      failedEventsFile: path.join(dir, 'failed.jsonl'),
    });

    const reaction = await director.generateReaction(context);
    expect(reaction.reactions).toHaveLength(2);
    expect(parseEnvelope(envelope(validReaction(context))).durationMs).toBe(4210);
  });

  it('falls back to a fenced JSON `result` when structured_output is absent', () => {
    const parsed = parseEnvelope(
      JSON.stringify({ result: '```json\n{"eventId":"x","reactions":[]}\n```' }),
    );
    expect(parsed.structuredOutput).toEqual({ eventId: 'x', reactions: [] });
  });

  it('treats an is_error envelope as a failure', () => {
    expect(() => parseEnvelope(JSON.stringify({ is_error: true, result: 'nope' }))).toThrow(/nope/);
  });

  it('treats empty stdout as a failure', () => {
    expect(() => parseEnvelope('   ')).toThrow(/empty stdout/);
  });
});

// ---------------------------------------------------------------------------
// validation, retry, failure
// ---------------------------------------------------------------------------

describe('validation and the single retry', () => {
  it('retries exactly once, then writes failed.jsonl and throws — history untouched', async () => {
    const context = await makeContext();
    const failedFile = path.join(dir, 'failed.jsonl');
    const messagesFile = path.join(dir, 'messages.jsonl');
    const spawn = fakeSpawn(['not json at all']);
    const director = new ClaudeCliDirector({ spawn, failedEventsFile: failedFile });

    await expect(director.generateReaction(context)).rejects.toThrow(DirectorFailureError);

    // Exactly one retry: two attempts total, never three.
    expect(spawn.calls).toHaveLength(2);

    const failed = (await readFile(failedFile, 'utf8')).trim().split('\n');
    expect(failed).toHaveLength(1);
    const record = JSON.parse(failed[0] ?? '{}') as FailedEventRecord;
    expect(record.eventId).toBe(context.pick.eventId);
    expect(record.attempts).toBe(2);
    expect(record.violations).toHaveLength(2);
    expect(record.violations[0]).toMatch(/attempt 1/);

    // §10: never corrupt message history.
    await expect(stat(messagesFile)).rejects.toThrow();
  });

  it('feeds the violations back into the retry prompt', async () => {
    const context = await makeContext();
    const bad = validReaction(context);
    bad.reactions = [bad.reactions[1] as never]; // drafted player never speaks
    const spawn = fakeSpawn([envelope(bad), envelope(validReaction(context))]);
    const director = new ClaudeCliDirector({ spawn, failedEventsFile: path.join(dir, 'failed.jsonl') });

    const reaction = await director.generateReaction(context);
    expect(reaction.reactions).toHaveLength(2);
    expect(spawn.calls).toHaveLength(2);
    const retryPrompt = spawn.calls[1]?.[1] ?? '';
    expect(retryPrompt).toContain('Your previous answer was rejected');
    expect(retryPrompt).toContain('does not speak');
  });

  it('rejects a reaction whose speaker is not in the Context', async () => {
    const context = await makeContext();
    const impostor = validReaction(context);
    impostor.reactions.push({
      speakerPlayerId: '99999',
      speakerName: 'Tom Brady',
      text: 'let me in',
      delayMs: 2400,
      reason: 'star_regular',
    });

    expect(productRuleViolations(impostor, context)).toEqual([
      expect.stringContaining('Tom Brady'),
    ]);

    const spawn = fakeSpawn([envelope(impostor)]);
    const director = new ClaudeCliDirector({ spawn, failedEventsFile: path.join(dir, 'failed.jsonl') });
    await expect(director.generateReaction(context)).rejects.toThrow(/not present in the context/);
  });

  it('rejects a speaker whose name and player id belong to different players', async () => {
    // Observed in a real run: speakerName "Justin Jefferson" carrying Travis
    // Kelce's id 1466. Both were "known", so an id-OR-name check passed it, and
    // the scene rendered Kelce's headshot and KC/TE chip above Jefferson's name.
    const context = await makeContext();
    const swapped = validReaction(context);
    const first = swapped.reactions[0] as { speakerPlayerId: string; speakerName: string };
    const second = swapped.reactions[1] as { speakerPlayerId: string; speakerName: string };
    first.speakerName = second.speakerName;

    expect(productRuleViolations(swapped, context).join(' ')).toMatch(/ids and names must match/);
  });

  it('rejects a history reference that does not name its season', async () => {
    // The Season Literal rule. Measured over 36 real Reactions, 42 of 43 history
    // lines named the season unprompted; the one that did not read "New team,
    // new manager, new me." — exactly the vague form the rule forbids.
    const context = await makeContext();
    const vague = validReaction(context);
    const first = vague.reactions[0] as { text: string; historyRefs?: string[] };
    first.text = 'New team, new manager, new me.';
    first.historyRefs = ['was on this manager roster before'];

    expect(productRuleViolations(vague, context).join(' ')).toMatch(/without naming the season/);
  });

  it('accepts the same reference once it states the year', async () => {
    const context = await makeContext();
    const explicit = validReaction(context);
    const first = explicit.reactions[0] as { text: string; historyRefs?: string[] };
    first.text = 'You had me in 2025 and you are really doing this again?';
    first.historyRefs = ['2025 roster'];

    expect(productRuleViolations(explicit, context)).toEqual([]);
  });

  it('leaves messages that lean on no history alone', async () => {
    const context = await makeContext();
    const plain = validReaction(context);
    const first = plain.reactions[0] as { text: string; historyRefs?: string[] };
    first.text = 'Round nine. Understood.';
    delete first.historyRefs;

    expect(productRuleViolations(plain, context)).toEqual([]);
  });

  it('rejects more than 6 messages, which the model boundary does not enforce', async () => {
    const context = await makeContext();
    const tooMany = validReaction(context);
    const template = tooMany.reactions[0] as never;
    tooMany.reactions = Array.from({ length: 7 }, () => ({ ...(template as object) })) as never;
    expect(productRuleViolations(tooMany, context).join(' ')).toMatch(/exceeds the maximum of 6/);
  });

  it('rejects a reaction where the drafted player never speaks', async () => {
    const context = await makeContext();
    const silent = validReaction(context);
    silent.reactions = [silent.reactions[1] as never];
    expect(productRuleViolations(silent, context).join(' ')).toContain('Cameron Dicker');
  });

  it('accepts a clean reaction', async () => {
    const context = await makeContext();
    expect(productRuleViolations(validReaction(context), context)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// the prompt
// ---------------------------------------------------------------------------

describe('prompt construction (--dry-run path)', () => {
  it('returns the real system prompt plus a rendered user prompt', async () => {
    const context = await makeContext();
    const { system, user } = buildPrompt(context);
    expect(system).toContain('You are the dialogue director for **Players Lounge**');
    expect(system).toContain('Fantasy memory — STRICT');
    expect(user).toContain('# The pick');
  });

  it('states the pick, the manager and the roster so far', async () => {
    const context = await makeContext();
    const user = renderUserPrompt(context);
    expect(user).toContain('Max drafts Cameron Dicker (K, LAC)');
    expect(user).toContain("Max's roster so far");
    expect(user).toContain('1. Bijan Robinson');
  });

  it('names everyone in the room with their id, voice and hooks', async () => {
    const context = await makeContext();
    const user = renderUserPrompt(context);
    expect(user).toContain('Who is in the Lounge for this pick');
    expect(user).toContain('THE DRAFTED PLAYER');
    expect(user).toContain('Current NFL teammate of Cameron Dicker');
    for (const actor of (context as { actors?: { name: string }[] }).actors ?? []) {
      expect(user).toContain(actor.name);
    }
  });

  it('makes the available fantasy history explicit, with seasons', async () => {
    const context = await makeContext();
    const user = renderUserPrompt(context);
    expect(user).toContain('Fantasy memory available for this pick');
    expect(user).toContain("2025: on Max's roster, he was disappointing");
    expect(user).toContain('four-digit year');
    expect(user).toContain('No fantasy history exists for:');
  });

  it('says so in words when nobody has any fantasy history', async () => {
    const context = await makeContext();
    const stripped = { ...context, draftedPlayerHistory: null, speakerHistories: {} };
    const user = renderUserPrompt(stripped);
    expect(user).toContain('Nobody in this room has any fantasy history you may use');
  });

  it('says so in words when the draft is quiet', async () => {
    const context = await makeContext();
    const user = renderUserPrompt({ ...context, draftSignals: {} });
    expect(user).toContain('no run, no stack, no notable reach or fall');
  });

  it('describes the signals it does have', async () => {
    const context = await makeContext();
    const user = renderUserPrompt({
      ...context,
      draftSignals: { positionRun: 'RB', isStack: true, fellBelowRank: 31 },
    });
    expect(user).toContain('Position run');
    expect(user).toContain('Stack');
    expect(user).toContain('Slide');
  });

  it('carries the running jokes and the recent transcript', async () => {
    const context = await makeContext();
    const user = renderUserPrompt(context);
    expect(user).toContain('great draft bust');
    expect(user).toContain('Travis Kelce: this draft is chaos');
  });

  it('pins the eventId and the message budget', async () => {
    const context = await makeContext();
    const user = renderUserPrompt(context);
    expect(user).toContain('Use exactly this eventId: draft1:42:9001');
    expect(user).toContain('2 to 6 messages total');
    expect(user).toContain('Cameron Dicker must send at least one message');
  });
});

// ---------------------------------------------------------------------------
// Background material: speech patterns and the rotating fact slice
// ---------------------------------------------------------------------------

/** Six numbered facts, so a selection can be identified by its numbers alone. */
function factsFor(who: string, count = 6): PlayerFact[] {
  return Array.from({ length: count }, (_, index) => ({
    fact: `${who} fact ${index + 1}`,
    angle: `${who} angle ${index + 1}`,
    confidence: 'high' as const,
    source: `https://example.com/${who}/${index + 1}`,
    accessed: '2026-08-28',
  }));
}

/** The drafted player is himself a Regular, which is the case facts matter most in. */
const researchedRegulars: StarPlayer[] = [
  {
    key: 'aaron_rodgers',
    name: 'Aaron Rodgers',
    sleeperPlayerId: '96',
    position: 'QB',
    required: true,
    activity: 0.92,
    voice: ['veteran', 'dry'],
    speechPattern: 'Controlled and declarative, with a dry aside bolted on after the main point.',
    hooks: ['remembers the good old days in Green Bay'],
    facts: factsFor('rodgers'),
  },
  {
    key: 'travis_kelce',
    name: 'Travis Kelce',
    sleeperPlayerId: '1466',
    position: 'TE',
    required: true,
    activity: 0.95,
    voice: ['loud'],
    speechPattern: 'Long energetic riffs that sound like he joined halfway through a story.',
    hooks: ['turns draft events into eras and tours'],
    facts: factsFor('kelce'),
    guardrails: ['Do not quote copyrighted Taylor Swift lyrics.'],
  },
  {
    key: 'kyle_pitts',
    name: 'Kyle Pitts',
    position: 'TE',
    required: true,
    activity: 0.9,
    voice: ['deadpan'],
    hooks: ['knows the league remembers him as a bust'],
    leagueLore: ['Kyle Pitts is a recurring symbol of draft disappointment in this league.'],
    researchPending: true,
  },
];

/** A context in which the DRAFTED player is a fact-carrying Regular. */
async function researchedContext(overrides: { pickNo?: number } = {}): Promise<LoungeContext> {
  const pickNo = overrides.pickNo ?? 42;
  return buildContext(
    makePick({
      pickNo,
      playerId: '96',
      playerName: 'Aaron Rodgers',
      position: 'QB',
      nflTeam: 'PIT',
      eventId: `draft1:${pickNo}:96`,
    }),
    {
      players,
      starPlayers: researchedRegulars,
      recentMessages: [],
      priorPicks: [],
      history: { historyFor: () => null },
      teammatesOf: () => [],
    },
  );
}

describe('background material in the prompt', () => {
  it("renders the drafted Regular's speech pattern and fact angles", async () => {
    const user = renderUserPrompt(await researchedContext());
    expect(user).toContain(
      'Speech pattern: Controlled and declarative, with a dry aside bolted on after the main point.',
    );
    expect(user).toContain('Background he could reach for this pick:');
    expect(user).toMatch(/- rodgers fact \d → rodgers angle \d/);
  });

  it('tells the Director that background is not fantasy memory and never a historyRef', async () => {
    const user = renderUserPrompt(await researchedContext());
    expect(user).toContain('not fantasy memory');
    expect(user).toContain('must never appear in `historyRefs`');
    expect(user).toContain('not a list to work through');
  });

  it('offers a small slice, never the whole research file', async () => {
    const user = renderUserPrompt(await researchedContext());
    const offered = user.match(/- rodgers fact \d/g) ?? [];
    expect(offered.length).toBeGreaterThanOrEqual(FACT_BUDGET.draftedPlayer.min);
    expect(offered.length).toBeLessThanOrEqual(FACT_BUDGET.draftedPlayer.max);
  });

  it('says nothing at all for a Regular whose research is still pending', async () => {
    const user = renderUserPrompt(await researchedContext());
    expect(user).toContain('Kyle Pitts');
    expect(user).not.toContain('Speech pattern: undefined');
  });
});

describe('fact selection', () => {
  const facts = factsFor('rodgers');

  it('is deterministic for a given eventId', () => {
    const a = selectFacts(facts, 'draft1:42:96', '96', true);
    const b = selectFacts(facts, 'draft1:42:96', '96', true);
    expect(a).toEqual(b);
  });

  it('rotates across eventIds, so the same anecdote is not retold every pick', () => {
    const seen = new Set<string>();
    for (let pickNo = 1; pickNo <= 40; pickNo += 1) {
      seen.add(
        selectFacts(facts, `draft1:${pickNo}:96`, '96', true)
          .map((fact) => fact.fact)
          .join('|'),
      );
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('honours the per-role budget and never repeats a fact within one pick', () => {
    for (let pickNo = 1; pickNo <= 40; pickNo += 1) {
      const drafted = selectFacts(facts, `draft1:${pickNo}:96`, '96', true);
      const other = selectFacts(facts, `draft1:${pickNo}:96`, '1466', false);
      expect(drafted.length).toBeGreaterThanOrEqual(FACT_BUDGET.draftedPlayer.min);
      expect(drafted.length).toBeLessThanOrEqual(FACT_BUDGET.draftedPlayer.max);
      expect(other.length).toBeGreaterThanOrEqual(FACT_BUDGET.otherSpeaker.min);
      expect(other.length).toBeLessThanOrEqual(FACT_BUDGET.otherSpeaker.max);
      expect(new Set(drafted.map((fact) => fact.fact)).size).toBe(drafted.length);
    }
  });

  it('gives each speaker his own rotation, independent of who else is in the room', () => {
    const drafted = selectFacts(facts, 'draft1:42:96', '96', true);
    const sameSeatDifferentPick = selectFacts(facts, 'draft1:43:96', '96', true);
    expect(drafted).not.toEqual(sameSeatDifferentPick);
  });

  it('returns nothing when the entry has no research yet', () => {
    expect(selectFacts(undefined, 'draft1:42:96', '96', true)).toEqual([]);
    expect(selectFacts([], 'draft1:42:96', '96', true)).toEqual([]);
  });

  it('never asks for more facts than exist', () => {
    expect(selectFacts(factsFor('thin', 1), 'draft1:42:96', '96', true)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// StubDirector (Milestone A: render a reaction with no LLM involved)
// ---------------------------------------------------------------------------

describe('StubDirector', () => {
  it('returns a deterministic, valid Reaction without spawning anything', async () => {
    const context = await makeContext();
    const director = new StubDirector();
    const a = await director.generateReaction(context);
    const b = await director.generateReaction(context);

    expect(a).toEqual(b);
    expect(a.eventId).toBe(context.pick.eventId);
    expect(a.reactions.length).toBeGreaterThanOrEqual(2);
    expect(a.reactions.length).toBeLessThanOrEqual(6);
    expect(productRuleViolations(a, context)).toEqual([]);
  });

  it('still speaks when the room is empty apart from the drafted player', async () => {
    const context = await makeContext();
    const alone = { ...context, nflTeammates: [], regulars: [], actors: [] } as LoungeContext;
    const reaction = stubReaction(alone);
    expect(reaction.reactions.length).toBeGreaterThanOrEqual(2);
    expect(productRuleViolations(reaction, alone)).toEqual([]);
  });
});
