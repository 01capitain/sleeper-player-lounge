import { describe, expect, it } from 'vitest';

import type { AppConfig } from '../../types.js';
import {
  buildTeamChip,
  MAX_PREVIOUS_MESSAGES,
  selectPreviousMessages,
  speakerIdsFor,
  toRenderPayload,
} from '../payload.js';
import { loungeMessage, MAX_LENGTH_TEXT, stubReaction } from './fixtures.js';

const rendering = {
  rendering: { watermark: 'Players Lounge • Fantasy parody' },
} as Pick<AppConfig, 'rendering'>;

describe('toRenderPayload', () => {
  it('maps the Pick onto the status card fields', () => {
    const payload = toRenderPayload(stubReaction());
    expect(payload.pick).toEqual({
      season: 2026,
      pickNo: 31,
      round: 4,
      playerId: '4046',
      playerName: 'Travis Kelce',
      managerName: 'Max',
    });
  });

  it('carries every Message across in order, with its delayMs', () => {
    const payload = toRenderPayload(stubReaction());
    expect(payload.reactions).toHaveLength(4);
    expect(payload.reactions.map((row) => row.delayMs)).toEqual([0, 1400, 3100, 4600]);
    expect(payload.reactions[1]?.text).toBe(MAX_LENGTH_TEXT);
    expect(payload.reactions[1]?.text).toHaveLength(280);
  });

  it('takes the watermark from the rendering config', () => {
    expect(toRenderPayload(stubReaction(), { config: rendering }).watermark).toBe(
      'Players Lounge • Fantasy parody',
    );
  });

  it('prefers an explicit watermark over the config', () => {
    const payload = toRenderPayload(stubReaction(), {
      config: rendering,
      watermark: 'Preview build',
    });
    expect(payload.watermark).toBe('Preview build');
  });

  it('omits watermark, statusLine and memberCount when nothing supplies them', () => {
    const payload = toRenderPayload(stubReaction());
    expect(payload.watermark).toBeUndefined();
    expect(payload.statusLine).toBeUndefined();
    expect(payload.memberCount).toBeUndefined();
  });

  it('passes statusLine and memberCount through when given', () => {
    const payload = toRenderPayload(stubReaction(), {
      statusLine: 'Max finally took a tight end',
      memberCount: 12,
    });
    expect(payload.statusLine).toBe('Max finally took a tight end');
    expect(payload.memberCount).toBe(12);
  });

  it('attaches headshot URLs to both reactions and previous messages', () => {
    const payload = toRenderPayload(stubReaction(), {
      recentMessages: [loungeMessage(1)],
      headshots: { '4046': 'file:///cache/4046.jpg', '9001': 'file:///cache/9001.jpg' },
    });
    expect(payload.reactions[0]?.headshotUrl).toBe('file:///cache/4046.jpg');
    expect(payload.reactions[1]?.headshotUrl).toBeUndefined();
    expect(payload.previousMessages[0]?.headshotUrl).toBe('file:///cache/9001.jpg');
  });
});

describe('teamChip', () => {
  it('joins team and position with a middot when both are known', () => {
    expect(buildTeamChip({ nflTeam: 'KC', position: 'TE' })).toBe('KC · TE');
  });

  it.each([
    ['team only', { nflTeam: 'KC', position: null }],
    ['position only', { nflTeam: null, position: 'TE' }],
    ['neither', { nflTeam: null, position: null }],
    ['blank strings', { nflTeam: '  ', position: '' }],
    ['no metadata', undefined],
  ])('is omitted with %s', (_label, meta) => {
    expect(buildTeamChip(meta)).toBeUndefined();
  });

  it('is only set on reaction rows whose player metadata is complete', () => {
    const payload = toRenderPayload(stubReaction(), {
      playerMeta: {
        '4046': { nflTeam: 'KC', position: 'TE' },
        '96': { nflTeam: 'PIT' },
        '7553': { position: 'TE' },
      },
    });
    expect(payload.reactions[0]?.teamChip).toBe('KC · TE');
    expect(payload.reactions[1]?.teamChip).toBeUndefined();
    expect(payload.reactions[2]?.teamChip).toBeUndefined();
    expect(payload.reactions[3]?.teamChip).toBeUndefined();
  });

  it('keeps the dimmed previous rows chip-free to avoid clutter', () => {
    const payload = toRenderPayload(stubReaction(), {
      recentMessages: [loungeMessage(1, { speakerPlayerId: '4046' })],
      playerMeta: { '4046': { nflTeam: 'KC', position: 'TE' } },
    });
    expect(payload.previousMessages[0]?.teamChip).toBeUndefined();
  });
});

describe('previousMessages', () => {
  const history = [1, 2, 3, 4, 5, 6].map((seq) => loungeMessage(seq));

  it('defaults to the tail of the transcript, oldest first', () => {
    const payload = toRenderPayload(stubReaction(), { recentMessages: history });
    expect(payload.previousMessages.map((row) => row.text)).toEqual([
      'Transcript line 4.',
      'Transcript line 5.',
      'Transcript line 6.',
    ]);
  });

  it('clamps the requested count into the spec\'s 2..4 band', () => {
    expect(
      selectPreviousMessages(stubReaction(), {
        recentMessages: history,
        previousMessageCount: 99,
      }),
    ).toHaveLength(MAX_PREVIOUS_MESSAGES);
    expect(
      selectPreviousMessages(stubReaction(), {
        recentMessages: history,
        previousMessageCount: 0,
      }),
    ).toHaveLength(2);
  });

  it('returns everything available when the transcript is short', () => {
    const payload = toRenderPayload(stubReaction(), { recentMessages: [loungeMessage(1)] });
    expect(payload.previousMessages).toHaveLength(1);
  });

  it('is empty when there is no transcript yet', () => {
    expect(toRenderPayload(stubReaction()).previousMessages).toEqual([]);
  });

  it('never echoes this Reaction\'s own persisted Messages', () => {
    const reaction = stubReaction();
    const payload = toRenderPayload(reaction, {
      recentMessages: [
        loungeMessage(1),
        loungeMessage(2, { eventId: reaction.eventId }),
        loungeMessage(3, { eventId: reaction.eventId }),
      ],
    });
    expect(payload.previousMessages.map((row) => row.text)).toEqual(['Transcript line 1.']);
  });
});

describe('speakerIdsFor', () => {
  it('collects reaction speakers, previous speakers and the drafted player, deduped', () => {
    const ids = speakerIdsFor(stubReaction(), {
      recentMessages: [loungeMessage(1), loungeMessage(2, { speakerPlayerId: '96' })],
    });
    expect(new Set(ids)).toEqual(new Set(['4046', '96', '7553', '4034', '9001']));
    expect(ids).toHaveLength(new Set(ids).size);
  });
});
