import { describe, expect, it } from 'vitest';

import type { Reaction, ReactionMessage } from './types.js';
import {
  isValidReaction,
  SchemaValidationError,
  validatePick,
  validatePlayerHistory,
  validateReaction,
} from './validate.js';

const EVENT_ID = '1389356983177465857:31:1466';

function message(overrides: Partial<ReactionMessage> = {}): ReactionMessage {
  return {
    speakerPlayerId: '1466',
    speakerName: 'Kyle Pitts',
    text: 'You had me in 2025 and you are really doing this again?',
    delayMs: 600,
    reason: 'fantasy_2025_history',
    ...overrides,
  };
}

function reaction(messages: ReactionMessage[]): Reaction {
  return {
    eventId: EVENT_ID,
    pick: {
      season: 2026,
      pickNo: 31,
      round: 3,
      playerId: '1466',
      playerName: 'Kyle Pitts',
      managerName: 'Stephan',
    },
    reactions: messages,
  };
}

describe('validateReaction', () => {
  it('accepts a well-formed Reaction', () => {
    const value = reaction([
      message(),
      message({
        speakerPlayerId: '4046',
        speakerName: 'Patrick Mahomes',
        text: 'Here we go again.',
        delayMs: 1400,
        reason: 'star_regular',
      }),
    ]);

    const validated = validateReaction(value);
    expect(validated).toEqual(value);
    expect(isValidReaction(value)).toBe(true);
  });

  it('accepts the maximum of 6 Messages', () => {
    const value = reaction(
      Array.from({ length: 6 }, (_, i) => message({ delayMs: i * 900 })),
    );
    expect(() => validateReaction(value)).not.toThrow();
  });

  it('rejects 7 Messages — maxItems is not enforced at the model boundary', () => {
    const value = reaction(
      Array.from({ length: 7 }, (_, i) => message({ delayMs: i * 900 })),
    );

    expect(() => validateReaction(value)).toThrow(SchemaValidationError);
    expect(() => validateReaction(value)).toThrow(/must NOT have more than 6 items/);
    expect(isValidReaction(value)).toBe(false);

    try {
      validateReaction(value);
      expect.unreachable('expected validateReaction to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaValidationError);
      expect((error as SchemaValidationError).message).toContain('/reactions:');
    }
  });

  it('rejects a 300-character Message — maxLength is not enforced at the model boundary', () => {
    const long = 'a'.repeat(300);
    const value = reaction([message({ text: long })]);

    expect(() => validateReaction(value)).toThrow(SchemaValidationError);
    expect(() => validateReaction(value)).toThrow(/must NOT have more than 280 characters/);
    expect(isValidReaction(value)).toBe(false);

    try {
      validateReaction(value);
      expect.unreachable('expected validateReaction to throw');
    } catch (error) {
      expect((error as SchemaValidationError).message).toContain('/reactions/0/text:');
    }
  });

  it('accepts a Message at exactly 280 characters', () => {
    expect(() => validateReaction(reaction([message({ text: 'b'.repeat(280) })]))).not.toThrow();
  });

  it('rejects an empty reactions array', () => {
    expect(() => validateReaction(reaction([]))).toThrow(/fewer than 1 items/);
  });

  it('rejects an unknown reason', () => {
    const value = reaction([message({ reason: 'vibes' as ReactionMessage['reason'] })]);
    expect(() => validateReaction(value)).toThrow(/\/reactions\/0\/reason:/);
  });

  it('rejects a delayMs above 7000', () => {
    expect(() => validateReaction(reaction([message({ delayMs: 9000 })]))).toThrow(
      /\/reactions\/0\/delayMs:/,
    );
  });

  it('lists every problem at once (allErrors)', () => {
    const value = reaction([
      message({ text: 'c'.repeat(300), delayMs: 99999, reason: 'nope' as ReactionMessage['reason'] }),
    ]);
    try {
      validateReaction(value);
      expect.unreachable('expected validateReaction to throw');
    } catch (error) {
      const lines = (error as SchemaValidationError).message.split('\n').slice(1);
      expect(lines.length).toBeGreaterThanOrEqual(3);
      for (const line of lines) expect(line).toMatch(/^[^:]*: .+/);
    }
  });

  it('rejects a Reaction missing required top-level fields', () => {
    expect(() => validateReaction({ eventId: EVENT_ID })).toThrow(SchemaValidationError);
    expect(() => validateReaction(null)).toThrow(SchemaValidationError);
  });
});

describe('validatePick', () => {
  it('accepts a normalized Pick with the {draftId}:{pickNo}:{playerId} eventId', () => {
    const pick = {
      eventId: EVENT_ID,
      season: 2026,
      leagueId: '1389356983177465856',
      draftId: '1389356983177465857',
      pickNo: 31,
      round: 3,
      draftSlot: 3,
      playerId: '1466',
      playerName: 'Kyle Pitts',
      position: 'TE',
      nflTeam: 'ATL',
      managerId: '471439689564286976',
      managerName: 'Stephan',
      pickedAt: '2026-08-28T10:00:00.000Z',
      simulated: true,
    };
    expect(validatePick(pick)).toEqual(pick);
  });

  it('accepts null-able optional fields', () => {
    expect(() =>
      validatePick({
        eventId: EVENT_ID,
        season: 2026,
        leagueId: 'L',
        draftId: 'D',
        pickNo: 1,
        round: null,
        draftSlot: null,
        playerId: 'P',
        playerName: 'Name',
        position: null,
        nflTeam: null,
        managerId: 'M',
        managerName: 'Manager',
        pickedAt: null,
      }),
    ).not.toThrow();
  });

  it('rejects a Pick missing managerName', () => {
    expect(() =>
      validatePick({
        eventId: EVENT_ID,
        season: 2026,
        leagueId: 'L',
        draftId: 'D',
        pickNo: 1,
        playerId: 'P',
        playerName: 'Name',
        managerId: 'M',
      }),
    ).toThrow(/managerName/);
  });
});

describe('validatePlayerHistory', () => {
  it('accepts 2025 history plus championship membership', () => {
    const history = {
      playerId: '1466',
      lastSeason: {
        season: 2025,
        managerId: '471439689564286976',
        managerName: 'Stephan',
        performance: 'disappointing',
        teamFinish: 4,
        champion: false,
        sharedRosterPlayerIds: ['4046'],
      },
      championships: [
        {
          season: 2023,
          managerId: '471439689564286976',
          managerName: 'Stephan',
          sharedChampionPlayerIds: ['4046'],
        },
      ],
    };
    expect(validatePlayerHistory(history)).toEqual(history);
  });

  it('accepts a null lastSeason with no championships', () => {
    expect(() =>
      validatePlayerHistory({ playerId: '1466', lastSeason: null, championships: [] }),
    ).not.toThrow();
  });

  it('rejects a lastSeason for any year other than 2025', () => {
    expect(() =>
      validatePlayerHistory({
        playerId: '1466',
        lastSeason: {
          season: 2024,
          managerId: 'M',
          managerName: 'Stephan',
          performance: 'good',
          champion: false,
        },
        championships: [],
      }),
    ).toThrow(/\/lastSeason\/season:/);
  });

  it('rejects an unknown performance label', () => {
    expect(() =>
      validatePlayerHistory({
        playerId: '1466',
        lastSeason: {
          season: 2025,
          managerId: 'M',
          managerName: 'Stephan',
          performance: 'mid',
          champion: false,
        },
        championships: [],
      }),
    ).toThrow(/\/lastSeason\/performance:/);
  });

  it('rejects a championship entry without its season', () => {
    expect(() =>
      validatePlayerHistory({
        playerId: '1466',
        lastSeason: null,
        championships: [{ managerId: 'M', managerName: 'Stephan' }],
      }),
    ).toThrow(/season/);
  });
});
