/**
 * `lounge demo` — the front door.
 *
 * Two things are tested here because they are the two ways the front door can
 * disappoint: choosing a boring Pick, and requiring the reader to have run
 * something else first.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { StubDirector } from '../../director/index.js';
import type { PlayerIndex } from '../../import/players.js';
import type { Pick } from '../../types.js';
import { choosePick, runDemo, DEMO_REGULARS } from '../commands/demo.js';
import { processPick, type ProcessPickOptions, type ProcessPickResult } from '../pipeline.js';
import { cleanWorkspaces, inertContextDeps, makePick, workspace } from './harness.js';

afterEach(cleanWorkspaces);

const director = new StubDirector();

const PITTS = '7553';
const KELCE = '1466';
const RODGERS = '96';

/** A draft containing all three required Regulars at their real pick numbers. */
function realisticDraft(): Pick[] {
  return [
    makePick({ pickNo: 1, playerId: '9221', playerName: 'Jahmyr Gibbs', position: 'RB', round: 1 }),
    makePick({ pickNo: 40, playerId: '4046', playerName: 'Patrick Mahomes', position: 'QB', round: 3 }),
    makePick({ pickNo: 74, playerId: PITTS, playerName: 'Kyle Pitts', position: 'TE', round: 6 }),
    makePick({ pickNo: 119, playerId: KELCE, playerName: 'Travis Kelce', position: 'TE', round: 9 }),
    makePick({ pickNo: 229, playerId: RODGERS, playerName: 'Aaron Rodgers', position: 'QB', round: 17 }),
  ];
}

/** Real ADP shape: Rodgers ranked 147 but taken at 229 is an 82-pick slide. */
const PLAYERS: PlayerIndex = {
  '9221': { player_id: '9221', adp: 3 },
  '4046': { player_id: '4046', adp: 12 },
  '7553': { player_id: '7553', adp: 80 },
  '1466': { player_id: '1466', adp: 110 },
  '96': { player_id: '96', adp: 147 },
};

describe('choosePick', () => {
  it('prefers a required Regular over everything else', () => {
    const choice = choosePick(realisticDraft(), PLAYERS);
    expect(choice.pick.playerId).toBe(PITTS);
    expect(choice.reason).toContain('bust lore');
  });

  it('walks the Regulars in order when the earlier ones are already processed', () => {
    const picks = realisticDraft();
    const processed = new Set([
      picks.find((pick) => pick.playerId === PITTS)?.eventId ?? '',
    ]);
    expect(choosePick(picks, PLAYERS, { processed }).pick.playerId).toBe(KELCE);

    processed.add(picks.find((pick) => pick.playerId === KELCE)?.eventId ?? '');
    expect(choosePick(picks, PLAYERS, { processed }).pick.playerId).toBe(RODGERS);
  });

  it('falls back to the biggest ADP slide when no Regular was drafted', () => {
    const picks = realisticDraft().filter(
      (pick) => !DEMO_REGULARS.some((regular) => regular.playerId === pick.playerId),
    );
    const choice = choosePick(picks, PLAYERS);
    expect(choice.pick.playerId).toBe('4046'); // ADP 12, taken 40 — a 28-pick slide.
    expect(choice.reason).toContain('biggest slide');
    expect(choice.reason).toContain('28 picks');
  });

  it('falls back to the biggest reach when nothing slid', () => {
    const picks = [
      makePick({ pickNo: 10, playerId: 'a', playerName: 'Reach Guy' }),
      makePick({ pickNo: 20, playerId: 'b', playerName: 'Small Reach' }),
    ];
    const players: PlayerIndex = {
      a: { player_id: 'a', adp: 60 },
      b: { player_id: 'b', adp: 25 },
    };
    const choice = choosePick(picks, players);
    expect(choice.pick.playerId).toBe('a');
    expect(choice.reason).toContain('biggest reach');
  });

  it('falls back to pick 1 when there is no ADP at all', () => {
    const picks = [
      makePick({ pickNo: 1, playerId: 'a', playerName: 'First' }),
      makePick({ pickNo: 2, playerId: 'b', playerName: 'Second' }),
    ];
    const choice = choosePick(picks, {});
    expect(choice.pick.pickNo).toBe(1);
    expect(choice.reason).toContain('first pick');
  });

  it('honours an explicit --pick', () => {
    const choice = choosePick(realisticDraft(), PLAYERS, { pickNo: 229 });
    expect(choice.pick.playerId).toBe(RODGERS);
    expect(choice.reason).toContain('229');
  });

  it('names the available range for an unknown --pick', () => {
    expect(() => choosePick(realisticDraft(), PLAYERS, { pickNo: 999 })).toThrow(/1\.\.229/);
  });

  it('refuses politely when there are no Picks', () => {
    expect(() => choosePick([], PLAYERS)).toThrow(/lounge -- setup/);
  });
});

describe('runDemo', () => {
  function recorder(): {
    calls: { pick: Pick; opts: ProcessPickOptions }[];
    fn: (pick: Pick, opts: ProcessPickOptions) => Promise<ProcessPickResult>;
  } {
    const calls: { pick: Pick; opts: ProcessPickOptions }[] = [];
    return {
      calls,
      fn: (pick, opts) => {
        calls.push({ pick, opts });
        return Promise.resolve({
          eventId: pick.eventId,
          pick,
          reaction: {
            eventId: pick.eventId,
            pick: {
              season: pick.season,
              pickNo: pick.pickNo,
              round: pick.round ?? null,
              playerId: pick.playerId,
              playerName: pick.playerName,
              managerName: pick.managerName,
            },
            reactions: [
              {
                speakerPlayerId: pick.playerId,
                speakerName: pick.playerName,
                text: 'noted',
                delayMs: 0,
                reason: 'drafted_player' as const,
              },
            ],
          },
          outputPath: '/tmp/demo.png',
          skipped: false,
          costUsd: 0.0042,
          usage: [],
        });
      },
    };
  }

  it('runs setup automatically when the workspace is empty', async () => {
    const ws = await workspace();
    await ws.writePicks(realisticDraft());
    let setupRuns = 0;
    const seen = recorder();

    const result = await runDemo(
      { open: false },
      {
        picksFile: ws.picksFile,
        persist: ws.persist,
        players: PLAYERS,
        processPick: seen.fn,
        isSetUp: () => Promise.resolve(false),
        setup: () => {
          setupRuns += 1;
          return Promise.resolve();
        },
        stdout: () => {},
      },
    );

    expect(setupRuns).toBe(1);
    expect(result.ranSetup).toBe(true);
  });

  it('does not re-run setup when the workspace is already populated', async () => {
    const ws = await workspace();
    await ws.writePicks(realisticDraft());
    let setupRuns = 0;

    const result = await runDemo(
      { open: false },
      {
        picksFile: ws.picksFile,
        persist: ws.persist,
        players: PLAYERS,
        processPick: recorder().fn,
        isSetUp: () => Promise.resolve(true),
        setup: () => {
          setupRuns += 1;
          return Promise.resolve();
        },
        stdout: () => {},
      },
    );

    expect(setupRuns).toBe(0);
    expect(result.ranSetup).toBe(false);
  });

  it('renders a PNG by default, opens it, and asks for a re-render when skipped', async () => {
    const ws = await workspace();
    await ws.writePicks(realisticDraft());
    const seen = recorder();

    await runDemo(
      {},
      {
        picksFile: ws.picksFile,
        persist: ws.persist,
        players: PLAYERS,
        processPick: seen.fn,
        isSetUp: () => Promise.resolve(true),
        stdout: () => {},
      },
    );

    const opts = seen.calls[0]?.opts;
    expect(opts?.format).toBe('png');
    expect(opts?.render).toBe(true);
    expect(opts?.open).toBe(true);
    expect(opts?.rerenderSkipped).toBe(true);
  });

  it('--no-open leaves the file closed', async () => {
    const ws = await workspace();
    await ws.writePicks(realisticDraft());
    const seen = recorder();
    await runDemo(
      { open: false },
      {
        picksFile: ws.picksFile,
        persist: ws.persist,
        players: PLAYERS,
        processPick: seen.fn,
        isSetUp: () => Promise.resolve(true),
        stdout: () => {},
      },
    );
    expect(seen.calls[0]?.opts.open).toBe(false);
  });

  it('prints why it chose the pick, the dialogue, the cost and the path', async () => {
    const ws = await workspace();
    await ws.writePicks(realisticDraft());
    const lines: string[] = [];

    await runDemo(
      { open: false },
      {
        picksFile: ws.picksFile,
        persist: ws.persist,
        players: PLAYERS,
        processPick: recorder().fn,
        isSetUp: () => Promise.resolve(true),
        stdout: (line) => lines.push(line),
      },
    );

    const text = lines.join('\n');
    expect(text).toContain('Kyle Pitts');
    expect(text).toContain('bust lore');
    expect(text).toContain('THE LOUNGE');
    expect(text).toContain('$0.0042');
    expect(text).toContain('/tmp/demo.png');
  });

  it('shows the stored Reaction again rather than paying twice', async () => {
    const ws = await workspace();
    const picks = realisticDraft();
    await ws.writePicks(picks);
    // Process every Regular so the demo has to fall back onto a processed one.
    for (const pick of picks) {
      await processPick(pick, {
        director,
        render: false,
        persist: ws.persist,
        contextDeps: inertContextDeps(),
      });
    }

    const lines: string[] = [];
    const result = await runDemo(
      { open: false },
      {
        picksFile: ws.picksFile,
        persist: ws.persist,
        players: PLAYERS,
        director,
        processOptions: { contextDeps: inertContextDeps(), render: false },
        isSetUp: () => Promise.resolve(true),
        stdout: (line) => lines.push(line),
      },
    );

    expect(result.skipped).toBe(true);
    expect(result.reaction).not.toBeNull();
    expect(lines.join('\n')).toContain('already had a Reaction');
  });
});
