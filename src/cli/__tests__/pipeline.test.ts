/**
 * The shared one-Pick pipeline.
 *
 * The behaviour under test that matters most is the §14 duplicate rule:
 * processing the same Pick twice must produce exactly one Reaction, one set of
 * Messages, and a `skipped: true` result that says so out loud.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { StubDirector } from '../../director/index.js';
import { reactionSchemaFile } from '../../paths.js';
import { readJson } from '../../util/json.js';
import { loadState } from '../../lounge/persist.js';
import { readFileSync } from 'node:fs';
import type { Reaction } from '../../types.js';
import { readJsonl } from '../../util/jsonl.js';
import { structuredOutputSchema } from '../../director/claude-cli.js';
import {
  buildPlayerMeta,
  openerFor,
  processPick,
  processedEventIds,
  totalCost,
  formatDialogue,
} from '../pipeline.js';
import { cleanWorkspaces, inertContextDeps, makePick, workspace } from './harness.js';

afterEach(cleanWorkspaces);

const director = new StubDirector();

describe('processPick', () => {
  it('runs a Pick through the pipeline once and records it', async () => {
    const ws = await workspace();
    const pick = makePick();

    const result = await processPick(pick, {
      director,
      render: false,
      persist: ws.persist,
      contextDeps: inertContextDeps(),
    });

    expect(result.skipped).toBe(false);
    expect(result.eventId).toBe(pick.eventId);
    expect(result.reaction?.reactions.length).toBeGreaterThanOrEqual(2);
    expect(result.outputPath).toBeNull();

    const reactions = await readJsonl<Reaction>(ws.persist.reactionsFile);
    expect(reactions).toHaveLength(1);
    const state = await loadState(ws.persist);
    expect(state.lastProcessedPickNo).toBe(74);
  });

  it('skips a Pick that has already been processed and never duplicates it', async () => {
    const ws = await workspace();
    const pick = makePick();
    const options = {
      director,
      render: false,
      persist: ws.persist,
      contextDeps: inertContextDeps(),
    };

    const first = await processPick(pick, options);
    const second = await processPick(pick, options);

    expect(first.skipped).toBe(false);
    expect(second.skipped).toBe(true);
    // The stored Reaction comes back, so callers can still show something.
    expect(second.reaction?.eventId).toBe(pick.eventId);
    expect(second.outputPath).toBeNull();

    expect(await readJsonl(ws.persist.reactionsFile)).toHaveLength(1);
    const messages = await readJsonl(ws.persist.messagesFile);
    expect(messages).toHaveLength(first.reaction?.reactions.length ?? 0);
  });

  it('never calls the Director for an already-processed Pick', async () => {
    const ws = await workspace();
    const pick = makePick();
    let calls = 0;
    const counting = {
      generateReaction: async (context: Parameters<StubDirector['generateReaction']>[0]) => {
        calls += 1;
        return director.generateReaction(context);
      },
    };
    const options = {
      director: counting,
      render: false,
      persist: ws.persist,
      contextDeps: inertContextDeps(),
    };

    await processPick(pick, options);
    await processPick(pick, options);
    await processPick(pick, options);

    expect(calls).toBe(1);
  });

  it('applies the Manager Alias overlay without changing the eventId', async () => {
    const ws = await workspace();
    const pick = makePick({ draftSlot: 3 });

    const result = await processPick(pick, {
      director,
      render: false,
      alias: true,
      persist: ws.persist,
      contextDeps: inertContextDeps(),
      aliasMap: {
        version: 1,
        sourceDraftId: pick.draftId,
        targetLeagueId: '1389387602825576448',
        targetLeagueName: 'hotelkit Fantasies',
        slots: { '3': { managerId: 'u-target', managerName: 'Winless Wonders' } },
      },
    });

    expect(result.pick.managerName).toBe('Winless Wonders');
    expect(result.eventId).toBe(pick.eventId);
    expect(result.reaction?.pick.managerName).toBe('Winless Wonders');
  });

  it('runs with no Fantasy Memory on disk (before `history import` has ever run)', async () => {
    const ws = await workspace();
    const result = await processPick(makePick({ pickNo: 119, playerId: '1466' }), {
      director,
      render: false,
      persist: ws.persist,
      contextDeps: inertContextDeps({ history: null }),
    });
    expect(result.skipped).toBe(false);
    expect(result.reaction).not.toBeNull();
  });
});

describe('processedEventIds', () => {
  it('reports every stored eventId in one pass', async () => {
    const ws = await workspace();
    const options = { director, render: false, persist: ws.persist, contextDeps: inertContextDeps() };
    await processPick(makePick({ pickNo: 1, playerId: '9221' }), options);
    await processPick(makePick({ pickNo: 2, playerId: '9509' }), options);

    const ids = await processedEventIds(ws.persist);
    expect(ids.size).toBe(2);
    expect(ids.has(makePick({ pickNo: 1, playerId: '9221' }).eventId)).toBe(true);
  });

  it('is empty when nothing has been processed', async () => {
    const ws = await workspace();
    expect((await processedEventIds(ws.persist)).size).toBe(0);
  });
});

describe('buildPlayerMeta', () => {
  const reaction: Reaction = {
    eventId: 'd:1:7553',
    pick: { season: 2026, pickNo: 1, round: 1, playerId: '7553', playerName: 'Kyle Pitts', managerName: 'M' },
    reactions: [
      { speakerPlayerId: '7553', speakerName: 'Kyle Pitts', text: 'ok', delayMs: 0, reason: 'drafted_player' },
      { speakerPlayerId: 'star:travis_kelce', speakerName: 'Travis Kelce', text: 'hi', delayMs: 1, reason: 'star_regular' },
    ],
  };

  it('reads position and team from the players dataset', () => {
    const meta = buildPlayerMeta(reaction, { '7553': { player_id: '7553', position: 'TE', team: 'ATL' } });
    expect(meta['7553']).toEqual({ position: 'TE', nflTeam: 'ATL' });
  });

  it('resolves a `star:` pseudo id from the Context actors', () => {
    const context = {
      actors: [
        { playerId: '1466', starKey: 'travis_kelce', name: 'Travis Kelce', position: 'TE', nflTeam: 'KC' },
      ],
    } as unknown as Parameters<typeof buildPlayerMeta>[2];
    const meta = buildPlayerMeta(reaction, {}, context);
    expect(meta['star:travis_kelce']).toEqual({ position: 'TE', nflTeam: 'KC' });
  });
});

describe('the schema handed to --json-schema', () => {
  it('strips the $schema dialect the claude CLI cannot resolve, and nothing else', () => {
    // The claude CLI validates --json-schema with an ajv that has no
    // draft-2020-12 meta-schema registered, so passing our schema verbatim
    // failed before the model was ever reached. Every real Director call was
    // broken by this and no unit test caught it, because they assert argv
    // against a fake spawn rather than running the binary.
    const source = JSON.parse(readFileSync(reactionSchemaFile, 'utf8'));
    expect(source['$schema']).toBeDefined();

    const sent = JSON.parse(structuredOutputSchema(reactionSchemaFile));

    expect(sent['$schema']).toBeUndefined();
    const { $schema: _dialect, ...rest } = source;
    expect(sent).toEqual(rest);
  });
});

describe('small helpers', () => {
  it('maps each platform to its opener', () => {
    expect(openerFor('darwin')).toBe('open');
    expect(openerFor('linux')).toBe('xdg-open');
    expect(openerFor('win32')).toBe('start');
    expect(openerFor('aix')).toBeNull();
  });

  it('sums the Director cost, or reports none', () => {
    expect(totalCost([])).toBeUndefined();
    expect(
      totalCost([
        { eventId: 'a', attempt: 1, model: 'sonnet', totalCostUsd: 0.004 },
        { eventId: 'a', attempt: 2, model: 'sonnet', totalCostUsd: 0.004 },
      ]),
    ).toBeCloseTo(0.008);
  });

  it('formats the dialogue as readable text', () => {
    const lines = formatDialogue({
      eventId: 'd:1:1',
      pick: { season: 2026, pickNo: 1, playerId: '1', playerName: 'A', managerName: 'M' },
      reactions: [{ speakerPlayerId: '1', speakerName: 'A', text: 'hello', delayMs: 0, reason: 'drafted_player' }],
    });
    expect(lines).toEqual(['  A: hello']);
  });
});
