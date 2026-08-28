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
import type { LoungeContext, Reaction } from '../../types.js';
import {
  ClaudeCliDirector,
  DirectorFailureError,
  REQUIRED_CLI_FLAGS,
  buildPrompt,
  parseEnvelope,
  productRuleViolations,
  renderUserPrompt,
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
    total_cost_usd: 0.0042,
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
// the cost guard
// ---------------------------------------------------------------------------

describe('ADR 0001 flag set (the cost guard)', () => {
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
    // The values that actually strip the 15,269-token default system prompt.
    expect(args?.[args.indexOf('--model') + 1]).toBe('sonnet');
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
  it('reads structured_output and surfaces cost and duration', async () => {
    const context = await makeContext();
    const usage: unknown[] = [];
    const director = new ClaudeCliDirector({
      spawn: fakeSpawn([envelope(validReaction(context))]),
      failedEventsFile: path.join(dir, 'failed.jsonl'),
      onUsage: (entry) => usage.push(entry),
    });

    const reaction = await director.generateReaction(context);
    expect(reaction.reactions).toHaveLength(2);
    expect(usage).toEqual([
      { eventId: context.pick.eventId, attempt: 1, model: 'sonnet', totalCostUsd: 0.0042, durationMs: 4210 },
    ]);
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
    expect(user).toContain('no run, no stack, no notable fall');
  });

  it('describes the signals it does have', async () => {
    const context = await makeContext();
    const user = renderUserPrompt({
      ...context,
      draftSignals: { positionRun: 'RB', isStack: true, fellBelowRank: 31 },
    });
    expect(user).toContain('Position run');
    expect(user).toContain('Stack');
    expect(user).toContain('Fall');
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
