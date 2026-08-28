/**
 * `lounge react` / `lounge screenshot`.
 *
 * The load-bearing property: re-rendering an existing Reaction must not call
 * the Director. Turning a PNG into an MP4 is a renderer operation, and if it
 * ever regenerated the scene it would produce different dialogue than the
 * still you already shared.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { StubDirector } from '../../director/index.js';
import type { Reaction } from '../../types.js';
import { readJsonl } from '../../util/jsonl.js';
import { runReact } from '../commands/react.js';
import { runScreenshot } from '../commands/screenshot.js';
import { processPick, type RenderReactionOptions, type StoredReaction } from '../pipeline.js';
import { cleanWorkspaces, inertContextDeps, makePick, workspace } from './harness.js';

afterEach(cleanWorkspaces);

const director = new StubDirector();

/** A render stand-in that records what it was asked to draw. */
function fakeRender(): {
  calls: { reaction: StoredReaction; opts: RenderReactionOptions }[];
  fn: (reaction: StoredReaction, opts: RenderReactionOptions) => Promise<string>;
} {
  const calls: { reaction: StoredReaction; opts: RenderReactionOptions }[] = [];
  return {
    calls,
    fn: (reaction, opts) => {
      calls.push({ reaction, opts });
      return Promise.resolve(`/tmp/${reaction.eventId}.${opts.format ?? 'mp4'}`);
    },
  };
}

/** Two stored Reactions, generated once with the stub Director. */
async function seeded(): Promise<Awaited<ReturnType<typeof workspace>>> {
  const ws = await workspace();
  for (const pick of [
    makePick({ pickNo: 74, playerId: '7553' }),
    makePick({ pickNo: 119, playerId: '1466', playerName: 'Travis Kelce', nflTeam: 'KC' }),
  ]) {
    await processPick(pick, {
      director,
      render: false,
      persist: ws.persist,
      contextDeps: inertContextDeps(),
    });
  }
  return ws;
}

describe('react', () => {
  it('never generates a new Reaction — the logs are byte-for-byte unchanged', async () => {
    const ws = await seeded();
    const before = await readJsonl<Reaction>(ws.persist.reactionsFile);
    const messagesBefore = await readJsonl(ws.persist.messagesFile);
    const draw = fakeRender();

    await runReact(
      { latest: true, format: 'mp4' },
      { reactionsFile: ws.persist.reactionsFile, persist: ws.persist, render: draw.fn, stdout: () => {} },
    );

    expect(await readJsonl<Reaction>(ws.persist.reactionsFile)).toEqual(before);
    expect(await readJsonl(ws.persist.messagesFile)).toEqual(messagesBefore);
    expect(draw.calls).toHaveLength(1);
    // It rendered the Reaction that was already on disk, not a new one.
    expect(draw.calls[0]?.reaction.eventId).toBe(before[before.length - 1]?.eventId);
  });

  it('--latest picks the most recently generated Reaction', async () => {
    const ws = await seeded();
    const draw = fakeRender();
    const result = await runReact(
      { latest: true },
      { reactionsFile: ws.persist.reactionsFile, persist: ws.persist, render: draw.fn, stdout: () => {} },
    );
    expect(result.reaction.pick.pickNo).toBe(119);
  });

  it('--pick selects that Pick’s Reaction', async () => {
    const ws = await seeded();
    const draw = fakeRender();
    const result = await runReact(
      { pick: 74, format: 'gif' },
      { reactionsFile: ws.persist.reactionsFile, persist: ws.persist, render: draw.fn, stdout: () => {} },
    );
    expect(result.reaction.pick.pickNo).toBe(74);
    expect(draw.calls[0]?.opts.format).toBe('gif');
  });

  it('explains how to generate one when the Pick has no Reaction', async () => {
    const ws = await seeded();
    await expect(
      runReact(
        { pick: 5 },
        { reactionsFile: ws.persist.reactionsFile, persist: ws.persist, render: fakeRender().fn },
      ),
    ).rejects.toThrow(/simulate --pick 5/);
  });

  it('explains how to start when nothing has been generated at all', async () => {
    const ws = await workspace();
    await expect(
      runReact(
        { latest: true },
        { reactionsFile: ws.persist.reactionsFile, persist: ws.persist, render: fakeRender().fn },
      ),
    ).rejects.toThrow(/npm run demo/);
  });

  it('prints the dialogue and the output path on stdout', async () => {
    const ws = await seeded();
    const lines: string[] = [];
    await runReact(
      { latest: true, format: 'png' },
      {
        reactionsFile: ws.persist.reactionsFile,
        persist: ws.persist,
        render: fakeRender().fn,
        stdout: (line) => lines.push(line),
      },
    );
    const text = lines.join('\n');
    expect(text).toContain('#119');
    expect(text).toContain('rendered:');
  });
});

describe('screenshot', () => {
  it('is `react` pinned to png', async () => {
    const ws = await seeded();
    const draw = fakeRender();
    await runScreenshot(
      { latest: true },
      { reactionsFile: ws.persist.reactionsFile, persist: ws.persist, render: draw.fn, stdout: () => {} },
    );
    expect(draw.calls[0]?.opts.format).toBe('png');
  });
});
