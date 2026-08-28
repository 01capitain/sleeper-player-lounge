import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { LoungeMessage, Reaction } from '../../types.js';
import { validateReaction } from '../../validate.js';
import {
  appendMessages,
  appendReaction,
  hasProcessed,
  loadState,
  persistReaction,
  recentMessages,
  updateState,
  type PersistOptions,
} from '../persist.js';

let dir: string;
let options: PersistOptions;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'lounge-persist-'));
  options = {
    reactionsFile: path.join(dir, 'reactions.jsonl'),
    messagesFile: path.join(dir, 'messages.jsonl'),
    stateFile: path.join(dir, 'state.json'),
    now: () => new Date('2026-08-28T12:00:00.000Z'),
  };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function reaction(eventId = 'draft1:42:9001', pickNo = 42): Reaction {
  return {
    eventId,
    pick: {
      season: 2026,
      pickNo,
      round: 4,
      playerId: '9001',
      playerName: 'Cameron Dicker',
      managerName: 'Max',
    },
    reactions: [
      {
        speakerPlayerId: '9001',
        speakerName: 'Cameron Dicker',
        text: 'A kicker in round 4. Bold.',
        delayMs: 0,
        reason: 'drafted_player',
      },
      {
        speakerPlayerId: '1466',
        speakerName: 'Travis Kelce',
        text: 'Max is drafting like the setlist is already locked in.',
        delayMs: 1400,
        reason: 'star_regular',
        historyRefs: ['2025: Cameron Dicker was on Max’s roster'],
      },
    ],
  };
}

describe('appendReaction', () => {
  it('writes one JSONL row carrying the Reaction plus metadata', async () => {
    const record = await appendReaction(reaction(), { ...options, simulated: true });
    expect(record.createdAt).toBe('2026-08-28T12:00:00.000Z');
    expect(record.simulated).toBe(true);

    const raw = (await readFile(options.reactionsFile as string, 'utf8')).trim();
    expect(raw.split('\n')).toHaveLength(1);
    // The stored row is still a schema-valid Reaction.
    expect(() => validateReaction(JSON.parse(raw))).not.toThrow();
  });
});

describe('appendMessages', () => {
  it('writes LoungeMessage rows with ascending seq', async () => {
    const rows = await appendMessages(reaction(), { ...options, simulated: true });
    expect(rows.map((row) => row.seq)).toEqual([1, 2]);
    expect(rows[0]?.speakerName).toBe('Cameron Dicker');
    expect(rows[1]?.historyRefs).toHaveLength(1);
    expect(rows[0]?.historyRefs).toBeUndefined();
  });

  it('continues the sequence across Reactions', async () => {
    await appendMessages(reaction('draft1:42:9001', 42), options);
    const second = await appendMessages(reaction('draft1:43:9002', 43), options);
    expect(second.map((row) => row.seq)).toEqual([3, 4]);

    const tail = await recentMessages(3, options);
    expect(tail.map((row: LoungeMessage) => row.seq)).toEqual([2, 3, 4]);
  });
});

describe('recentMessages', () => {
  it('returns the last n, oldest first, and [] when the transcript is empty', async () => {
    expect(await recentMessages(20, options)).toEqual([]);
    await appendMessages(reaction(), options);
    expect((await recentMessages(1, options))[0]?.seq).toBe(2);
  });
});

describe('state', () => {
  it('defaults, patches and re-reads lastProcessedPickNo', async () => {
    expect((await loadState(options)).lastProcessedPickNo).toBe(0);
    await updateState({ lastProcessedPickNo: 42, recentTone: 'chaotic' }, options);
    const state = await loadState(options);
    expect(state.lastProcessedPickNo).toBe(42);
    expect(state.recentTone).toBe('chaotic');
  });

  it('pretty-prints state.json with a trailing newline (git-friendly, §11)', async () => {
    await updateState({ lastProcessedPickNo: 7 }, options);
    const raw = await readFile(options.stateFile as string, 'utf8');
    expect(raw.endsWith('}\n')).toBe(true);
    expect(raw).toContain('\n  "lastProcessedPickNo": 7');
  });
});

describe('hasProcessed — the idempotency rule (§14)', () => {
  it('is false before, true after', async () => {
    expect(await hasProcessed('draft1:42:9001', options)).toBe(false);
    await persistReaction(reaction(), options);
    expect(await hasProcessed('draft1:42:9001', options)).toBe(true);
    expect(await hasProcessed('draft1:43:9002', options)).toBe(false);
  });

  it('detects a half-written event from the message log alone', async () => {
    await appendMessages(reaction(), options);
    expect(await hasProcessed('draft1:42:9001', options)).toBe(true);
  });

  it('prevents duplicate persistence when the same Pick is processed twice', async () => {
    const first = await persistReaction(reaction(), { ...options, simulated: true });
    expect(first.persisted).toBe(true);
    expect(first.messages?.map((row) => row.seq)).toEqual([1, 2]);
    expect(first.state?.lastProcessedPickNo).toBe(42);

    const second = await persistReaction(reaction(), { ...options, simulated: true });
    expect(second.persisted).toBe(false);
    expect(second.messages).toBeUndefined();

    const reactions = (await readFile(options.reactionsFile as string, 'utf8')).trim().split('\n');
    const messages = (await readFile(options.messagesFile as string, 'utf8')).trim().split('\n');
    expect(reactions).toHaveLength(1);
    expect(messages).toHaveLength(2);
    expect((await loadState(options)).lastProcessedPickNo).toBe(42);
  });

  it('never rewinds lastProcessedPickNo when an earlier Pick is replayed', async () => {
    await persistReaction(reaction('draft1:80:x', 80), options);
    await persistReaction(reaction('draft1:12:y', 12), options);
    expect((await loadState(options)).lastProcessedPickNo).toBe(80);
  });

  it('writes nothing at all for a duplicate on a clean directory', async () => {
    await persistReaction(reaction(), options);
    await rm(options.messagesFile as string);
    // The reaction log alone is enough to block a re-run.
    const result = await persistReaction(reaction(), options);
    expect(result.persisted).toBe(false);
    await expect(stat(options.messagesFile as string)).rejects.toThrow();
  });
});
