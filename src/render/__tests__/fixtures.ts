/**
 * Shared render fixtures.
 *
 * The stub Reaction is deliberately hostile to the layout: one Message uses the
 * schema's full 280-character budget and one Speaker has an absurdly long name,
 * so the end-to-end render proves the template survives both without the stage
 * growing past 1080x1920.
 */
import type { LoungeMessage, Reaction } from '../../types.js';

/** Exactly 280 characters — the schema's `maxLength` for Message text. */
export const MAX_LENGTH_TEXT = (
  'Four rounds of everybody sleeping on me and now the whole Lounge wants to ' +
  'talk about ceiling and floor and target share like any of you watched a ' +
  'single snap in 2025, so go ahead and keep typing your little takes while I ' +
  'go put up another one for the guy who finally acted like he knew all along.'
).slice(0, 280);

export const LONG_SPEAKER_NAME =
  'Bartholomew Maximilian Featherstonehaugh-Wollensky III';

export function stubReaction(overrides: Partial<Reaction> = {}): Reaction {
  return {
    eventId: 'sim9001:31:4046',
    pick: {
      season: 2026,
      pickNo: 31,
      round: 4,
      playerId: '4046',
      playerName: 'Travis Kelce',
      managerName: 'Max',
    },
    reactions: [
      {
        speakerPlayerId: '4046',
        speakerName: 'Travis Kelce',
        text: 'Round 4? In this economy? Fine. Somebody is getting a ring out of this.',
        delayMs: 0,
        reason: 'drafted_player',
      },
      {
        speakerPlayerId: '96',
        speakerName: 'Aaron Rodgers',
        text: MAX_LENGTH_TEXT,
        delayMs: 1400,
        reason: 'star_regular',
      },
      {
        speakerPlayerId: '7553',
        speakerName: LONG_SPEAKER_NAME,
        text: 'Every single year one of you says this is my breakout. I am simply saying it back.',
        delayMs: 3100,
        reason: 'running_joke',
      },
      {
        speakerPlayerId: '4034',
        speakerName: 'Patrick Mahomes',
        text: 'Max had me in 2025 too. Look how that ended.',
        delayMs: 4600,
        reason: 'fantasy_2025_history',
      },
    ],
    ...overrides,
  };
}

/** A two-Message Reaction, for the deliberately short video tests. */
export function shortReaction(): Reaction {
  return stubReaction({
    eventId: 'sim9001:32:1234',
    reactions: [
      {
        speakerPlayerId: '4046',
        speakerName: 'Travis Kelce',
        text: 'Here we go again.',
        delayMs: 0,
        reason: 'drafted_player',
      },
      {
        speakerPlayerId: '96',
        speakerName: 'Aaron Rodgers',
        text: 'Nobody asked, but I have thoughts.',
        delayMs: 900,
        reason: 'star_regular',
      },
    ],
  });
}

export function loungeMessage(
  seq: number,
  overrides: Partial<LoungeMessage> = {},
): LoungeMessage {
  return {
    eventId: `sim9001:${seq}:900${seq}`,
    seq,
    speakerPlayerId: `900${seq}`,
    speakerName: `Speaker ${seq}`,
    text: `Transcript line ${seq}.`,
    reason: 'other',
    createdAt: '2026-08-01T00:00:00.000Z',
    simulated: true,
    ...overrides,
  };
}
