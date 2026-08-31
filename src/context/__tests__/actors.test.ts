import { describe, expect, it } from 'vitest';

import {
  BASE_NON_REGULAR_ACTIVITY,
  BASE_ROSTER_TEAMMATE_ACTIVITY,
  RELEVANCE_BONUS,
  actorWeight,
  createRng,
  gateAllows,
  hashSeed,
  selectActors,
  weightedSample,
} from '../actors.js';
import { makePick, starMetaFixture, unconnectedRegulars } from './fixtures.js';

const rules = {
  draftedPlayerMustReact: true,
  includeRelevantCurrentTeammates: true,
  includeCurrentRosterTeammates: true,
  minMessages: 2,
  targetMessages: 4,
  maxMessages: 6,
  maxRegularsPerReaction: 3,
  allowNoOptionalStarReaction: true,
};

/** A Pick nobody in the cast has any connection to: a kicker, on nobody's team. */
function unconnectedInput(overrides: Parameters<typeof makePick>[0] = {}) {
  return {
    pick: makePick(overrides),
    regulars: unconnectedRegulars,
    starMeta: starMetaFixture,
    nflTeammates: [],
    fantasyTeammates2025: [],
    championshipTeammates: [],
    positionRivals: [],
    runningJokes: [],
    rules,
  };
}

describe('Regulars are ambient', () => {
  it('selects a Regular who has ZERO connection to the pick', () => {
    // A Round 4 kicker on the Chargers. No cast member shares his team, his
    // position, a running joke, a fantasy roster or a relationship with him.
    // Regulars must still turn up — that is what makes the Lounge inhabited.
    const actors = selectActors(unconnectedInput());
    const regulars = actors.filter((actor) => actor.role === 'regular');

    expect(regulars.length).toBeGreaterThan(0);
    for (const regular of regulars) {
      expect(regular.reasons.some((reason) => reason.startsWith('ambient Lounge regular'))).toBe(
        true,
      );
      // No relevance reason at all — they are here purely on `activity`.
      expect(regular.reasons).toHaveLength(1);
    }
  });

  it('gives every unconnected Regular a real chance across a whole draft', () => {
    const appearances = new Map<string, number>();
    for (let pickNo = 1; pickNo <= 120; pickNo += 1) {
      const actors = selectActors(
        unconnectedInput({ pickNo, playerId: `900${pickNo}`, eventId: `draft1:${pickNo}:900${pickNo}` }),
      );
      for (const actor of actors) {
        if (actor.starKey) appearances.set(actor.starKey, (appearances.get(actor.starKey) ?? 0) + 1);
      }
    }
    for (const star of unconnectedRegulars) {
      expect(appearances.get(star.key) ?? 0).toBeGreaterThan(10);
    }
  });

  it('never lets relevance act as a gate: weight is activity alone when nothing connects', () => {
    expect(actorWeight(0.8, {})).toBeCloseTo(0.8, 10);
    expect(actorWeight(0.8, { isNflTeammate: true })).toBeCloseTo(
      0.8 * (1 + RELEVANCE_BONUS.nflTeammate),
      10,
    );
    // Every bonus multiplies upward; none can zero a Regular out of the pool.
    expect(actorWeight(0.7, { sharedRoster2025: true })).toBeGreaterThan(actorWeight(0.7, {}));
    expect(actorWeight(0.7, { runningJokeStrength: 1 })).toBeGreaterThan(actorWeight(0.7, {}));
  });

  it('keeps an unconnected Regular heavier than a fully connected non-Regular', () => {
    const ambientRegular = actorWeight(0.7, {});
    const connectedOutsider = actorWeight(BASE_NON_REGULAR_ACTIVITY, {
      sharedRoster2025: true,
      samePosition: true,
    });
    expect(ambientRegular).toBeGreaterThan(connectedOutsider);
  });
});

describe('mandatory candidate', () => {
  it('always ranks the drafted player first, across many seeded picks', () => {
    for (let pickNo = 1; pickNo <= 200; pickNo += 1) {
      const pick = makePick({
        pickNo,
        playerId: `p${pickNo}`,
        playerName: `Player ${pickNo}`,
        eventId: `draft1:${pickNo}:p${pickNo}`,
      });
      const actors = selectActors({
        pick,
        regulars: unconnectedRegulars,
        starMeta: starMetaFixture,
        nflTeammates: [
          { playerId: 't1', name: 'Ladd McConkey', position: 'WR', nflTeam: 'LAC' },
          { playerId: 't2', name: 'Justin Herbert', position: 'QB', nflTeam: 'LAC' },
        ],
        rules,
      });
      const first = actors[0];
      expect(first?.playerId).toBe(pick.playerId);
      expect(first?.mandatory).toBe(true);
      expect(first?.role).toBe('drafted_player');
      expect(actors.filter((actor) => actor.mandatory)).toHaveLength(1);
    }
  });

  it('still returns the drafted player when the cast is empty', () => {
    const actors = selectActors({ pick: makePick(), regulars: [], rules });
    expect(actors).toHaveLength(1);
    expect(actors[0]?.role).toBe('drafted_player');
  });
});

describe('determinism', () => {
  it('produces identical actors for the same eventId', () => {
    const a = selectActors(unconnectedInput());
    const b = selectActors(unconnectedInput());
    expect(a.map((actor) => actor.playerId)).toEqual(b.map((actor) => actor.playerId));
    expect(a).toEqual(b);
  });

  it('produces identical actors for the same explicit seed and different ones otherwise', () => {
    const base = unconnectedInput();
    expect(selectActors({ ...base, seed: 7 })).toEqual(selectActors({ ...base, seed: 7 }));

    const signatures = new Set<string>();
    for (let pickNo = 1; pickNo <= 40; pickNo += 1) {
      const actors = selectActors(
        unconnectedInput({ pickNo, playerId: `q${pickNo}`, eventId: `draft1:${pickNo}:q${pickNo}` }),
      );
      signatures.add(actors.map((actor) => actor.playerId).join('|'));
    }
    // Different picks must not all collapse onto one cast.
    expect(signatures.size).toBeGreaterThan(1);
  });

  it('hashes and samples deterministically', () => {
    expect(hashSeed('draft1:42:9001')).toBe(hashSeed('draft1:42:9001'));
    const items = [
      { item: 'a', weight: 0.9 },
      { item: 'b', weight: 0.1 },
    ];
    expect(weightedSample(items, 2, createRng(1))).toEqual(weightedSample(items, 2, createRng(1)));
  });
});

describe('candidate ordering and limits', () => {
  it('offers one relevant current NFL teammate when one exists', () => {
    const actors = selectActors({
      ...unconnectedInput(),
      nflTeammates: [
        { playerId: 't1', name: 'Ladd McConkey', position: 'WR', nflTeam: 'LAC' },
        { playerId: 't2', name: 'Justin Herbert', position: 'QB', nflTeam: 'LAC' },
      ],
    });
    const mates = actors.filter((actor) => actor.role === 'nfl_teammate');
    expect(mates).toHaveLength(1);
    expect(actors[1]?.role).toBe('nfl_teammate');
    expect(mates[0]?.reasons[0]).toContain('current NFL teammate');
  });

  it('respects maxRegularsPerReaction and the 3..6 candidate band', () => {
    for (let pickNo = 1; pickNo <= 60; pickNo += 1) {
      const actors = selectActors({
        ...unconnectedInput({ pickNo, playerId: `r${pickNo}`, eventId: `draft1:${pickNo}:r${pickNo}` }),
        rules: { ...rules, maxRegularsPerReaction: 2 },
      });
      expect(actors.filter((actor) => actor.role === 'regular').length).toBeLessThanOrEqual(2);
      expect(actors.length).toBeLessThanOrEqual(6);
      expect(actors.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('never repeats a player across roles', () => {
    const actors = selectActors({
      ...unconnectedInput(),
      nflTeammates: [{ playerId: '1466', name: 'Travis Kelce', position: 'TE', nflTeam: 'LAC' }],
      fantasyTeammates2025: [{ playerId: '1466', name: 'Travis Kelce', position: 'TE' }],
      runningJokes: [
        { id: 'kyle-pitts-draft-bust', topic: 'bust', strength: 1, participants: ['kyle_pitts'], persistent: true },
      ],
    });
    const ids = actors.map((actor) => actor.playerId);
    expect(new Set(ids).size).toBe(ids.length);
    const names = actors.map((actor) => actor.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('records why a relevant Regular is present without excluding the others', () => {
    const actors = selectActors({
      ...unconnectedInput({ position: 'TE', nflTeam: 'ATL', playerName: 'Drake London' }),
      relevance: { kyle_pitts: { sharedRoster2025: true } },
    });
    const pitts = actors.find((actor) => actor.starKey === 'kyle_pitts');
    expect(pitts).toBeDefined();
    expect(pitts?.reasons.join(' ')).toContain('2025');
  });
});

describe('an Appearance Gate is the one thing that keeps a Regular out', () => {
  /** The fixture cast, with Kyle Pitts gated to Atlanta and the early tight ends. */
  const gatedRegulars = unconnectedRegulars.map((star) =>
    star.key === 'kyle_pitts'
      ? {
          ...star,
          appearance: {
            nflTeams: ['ATL'],
            earlyAtPosition: { position: 'TE', withinFirst: 4 },
          },
        }
      : star,
  );

  function inputFor(overrides: Parameters<typeof makePick>[0], positionDraftIndex?: number) {
    return {
      ...unconnectedInput(overrides),
      regulars: gatedRegulars,
      ...(positionDraftIndex !== undefined ? { positionDraftIndex } : {}),
    };
  }

  it('admits on any listed condition and fails closed when the data is missing', () => {
    const gate = { nflTeams: ['ATL'], earlyAtPosition: { position: 'TE', withinFirst: 4 } };
    expect(gateAllows(gate, { nflTeam: 'atl', position: 'RB' })).toBe(true);
    expect(gateAllows(gate, { nflTeam: 'DET', position: 'te', positionDraftIndex: 4 })).toBe(true);
    expect(gateAllows(gate, { nflTeam: 'DET', position: 'TE', positionDraftIndex: 5 })).toBe(false);
    expect(gateAllows(gate, { nflTeam: 'DET', position: 'TE' })).toBe(false);
    expect(gateAllows(gate, {})).toBe(false);
    expect(gateAllows(undefined, {})).toBe(true);
  });

  it('keeps the gated Regular out of the pool on a pick his gate rejects', () => {
    for (let seed = 0; seed < 200; seed += 1) {
      const actors = selectActors({ ...inputFor({}, 12), seed });
      expect(actors.some((actor) => actor.starKey === 'kyle_pitts'), `seed ${seed}`).toBe(false);
    }
  });

  it('admits him on his own NFL team and on an early tight end', () => {
    const reachable = (input: ReturnType<typeof inputFor>): boolean => {
      for (let seed = 0; seed < 200; seed += 1) {
        const actors = selectActors({ ...input, seed });
        if (actors.some((actor) => actor.starKey === 'kyle_pitts')) return true;
      }
      return false;
    };
    expect(reachable(inputFor({ nflTeam: 'ATL', position: 'RB' }, 9))).toBe(true);
    expect(reachable(inputFor({ nflTeam: 'DET', position: 'TE' }, 3))).toBe(true);
  });

  it('leaves the ungated Regulars entirely ambient', () => {
    const seen = new Set<string>();
    for (let seed = 0; seed < 200; seed += 1) {
      for (const actor of selectActors({ ...inputFor({}, 12), seed })) {
        if (actor.starKey) seen.add(actor.starKey);
      }
    }
    expect([...seen].sort()).toEqual(['aaron_rodgers', 'travis_kelce']);
  });
});

describe("the drafting Manager's own roster", () => {
  const roster = [
    { playerId: '5001', name: 'Justin Tucker', position: 'K', nflTeam: 'BAL' },
    { playerId: '5002', name: 'Tyreek Hill', position: 'WR', nflTeam: 'MIA' },
  ];

  it('offers one player already on the roster, and says why he is there', () => {
    const actors = selectActors({ ...unconnectedInput(), currentRosterTeammates: roster });
    const mate = actors.find((actor) => actor.role === 'roster_teammate');
    expect(mate).toBeDefined();
    expect(roster.map((entry) => entry.name)).toContain(mate?.name);
    expect(mate?.reasons.some((reason) => reason.includes("Max's roster in this draft"))).toBe(true);
  });

  it('prefers the roster-mate whose starting spot the pick threatens', () => {
    // The fixture Pick is a kicker, so Justin Tucker is the contested one. The
    // weight ordering is the promise; the draw only has to follow it on balance.
    expect(
      actorWeight(BASE_ROSTER_TEAMMATE_ACTIVITY, {
        sharedRosterThisDraft: true,
        competesForStartingSpot: true,
        samePosition: true,
      }),
    ).toBeGreaterThan(
      actorWeight(BASE_ROSTER_TEAMMATE_ACTIVITY, { sharedRosterThisDraft: true }),
    );

    const counts = { contested: 0, other: 0 };
    for (let seed = 0; seed < 400; seed += 1) {
      const actors = selectActors({
        ...unconnectedInput(),
        currentRosterTeammates: roster,
        seed,
      });
      const mate = actors.find((actor) => actor.role === 'roster_teammate');
      if (mate?.name === 'Justin Tucker') counts.contested += 1;
      else if (mate?.name === 'Tyreek Hill') counts.other += 1;
    }
    expect(counts.contested).toBeGreaterThan(counts.other);
  });

  it('outweighs every ambient Regular, so the pick never lands unremarked', () => {
    const loudest = Math.max(...unconnectedRegulars.map((star) => star.activity));
    expect(
      actorWeight(BASE_ROSTER_TEAMMATE_ACTIVITY, { sharedRosterThisDraft: true }),
    ).toBeGreaterThan(loudest);
  });

  it('still leaves a seat for a Regular in a full room', () => {
    for (let seed = 0; seed < 100; seed += 1) {
      const actors = selectActors({
        ...unconnectedInput(),
        currentRosterTeammates: roster,
        nflTeammates: [
          { playerId: '5003', name: 'Joey Bosa', position: 'DE', nflTeam: 'LAC' },
        ],
        seed,
      });
      expect(actors.some((actor) => actor.role === 'regular'), `seed ${seed}`).toBe(true);
    }
  });
});
