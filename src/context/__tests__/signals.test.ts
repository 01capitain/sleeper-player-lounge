import { describe, expect, it } from 'vitest';

import { computeDraftSignalDetail, computeDraftSignals } from '../signals.js';
import { makePick, makePlayers } from './fixtures.js';

function priorPick(pickNo: number, position: string, extra: Parameters<typeof makePick>[0] = {}) {
  return makePick({
    pickNo,
    position,
    playerId: `prior${pickNo}`,
    playerName: `Prior ${pickNo}`,
    eventId: `draft1:${pickNo}:prior${pickNo}`,
    ...extra,
  });
}

describe('position run', () => {
  it('reports a run when 3 of the last 5 picks share the position', () => {
    const pick = makePick({ pickNo: 20, position: 'RB', playerId: 'rb1' });
    const priors = [
      priorPick(16, 'WR'),
      priorPick(17, 'RB'),
      priorPick(18, 'QB'),
      priorPick(19, 'RB'),
    ];
    const signals = computeDraftSignals(pick, priors);
    expect(signals.positionRun).toBe('RB');

    const detail = computeDraftSignalDetail(pick, priors);
    expect(detail.positionRunCount).toBe(3);
    expect(detail.positionRunWindow).toBe(5);
  });

  it('stays undefined when the position is not running', () => {
    const pick = makePick({ pickNo: 20, position: 'RB', playerId: 'rb1' });
    const priors = [priorPick(17, 'WR'), priorPick(18, 'QB'), priorPick(19, 'TE')];
    expect(computeDraftSignals(pick, priors).positionRun).toBeUndefined();
  });

  it('stays undefined when the drafted player has no known position', () => {
    const pick = makePick({ pickNo: 20, position: null, playerId: 'x' });
    expect(computeDraftSignals(pick, [priorPick(19, 'RB')]).positionRun).toBeUndefined();
  });

  it('ignores picks from another draft', () => {
    const pick = makePick({ pickNo: 20, position: 'RB', playerId: 'rb1' });
    const priors = [
      priorPick(17, 'RB', { draftId: 'other' }),
      priorPick(18, 'RB', { draftId: 'other' }),
    ];
    expect(computeDraftSignals(pick, priors).positionRun).toBeUndefined();
  });
});

describe('stack', () => {
  it('reports a stack when the manager already owns an NFL teammate', () => {
    const pick = makePick({ pickNo: 30, nflTeam: 'KC', playerId: 'kc2', position: 'TE' });
    const priors = [
      makePick({ pickNo: 10, nflTeam: 'KC', playerId: 'kc1', playerName: 'Patrick Mahomes', managerId: 'mgr1' }),
    ];
    const detail = computeDraftSignalDetail(pick, priors);
    expect(detail.isStack).toBe(true);
    expect(detail.stackWith).toEqual(['Patrick Mahomes']);
  });

  it('is undefined when the NFL teammate belongs to another manager', () => {
    const pick = makePick({ pickNo: 30, nflTeam: 'KC', playerId: 'kc2' });
    const priors = [
      makePick({ pickNo: 10, nflTeam: 'KC', playerId: 'kc1', managerId: 'mgr2', managerName: 'Anna' }),
    ];
    expect(computeDraftSignals(pick, priors).isStack).toBeUndefined();
  });

  it('is undefined when the drafted player has no NFL team', () => {
    const pick = makePick({ pickNo: 30, nflTeam: null, playerId: 'kc2' });
    expect(computeDraftSignals(pick, []).isStack).toBeUndefined();
  });
});

describe('obvious fall', () => {
  it('reports how far a highly ranked player slid', () => {
    const pick = makePick({ pickNo: 60, playerId: 'star' });
    const players = makePlayers([{ player_id: 'star', adp: 20 }]);
    const signals = computeDraftSignals(pick, [], players);
    expect(signals.fellBelowRank).toBe(40);
    expect(computeDraftSignalDetail(pick, [], players).expectedRank).toBe(20);
  });

  it('is undefined for a small, unremarkable slide', () => {
    const pick = makePick({ pickNo: 25, playerId: 'star' });
    const players = makePlayers([{ player_id: 'star', adp: 20 }]);
    expect(computeDraftSignals(pick, [], players).fellBelowRank).toBeUndefined();
  });

  it('is undefined when the player has no ADP — never guess', () => {
    const pick = makePick({ pickNo: 200, playerId: 'star' });
    expect(computeDraftSignals(pick, [], makePlayers([{ player_id: 'star' }])).fellBelowRank).toBeUndefined();
    expect(computeDraftSignals(pick, [], {}).fellBelowRank).toBeUndefined();
  });

  it('ignores Sleeper sentinel ranks for unranked players', () => {
    const pick = makePick({ pickNo: 200, playerId: 'star' });
    const players = makePlayers([{ player_id: 'star', adp: 9999999 }]);
    expect(computeDraftSignals(pick, [], players).fellBelowRank).toBeUndefined();
  });
});

describe('quiet picks', () => {
  it('returns an empty object when no signal is genuinely present', () => {
    expect(computeDraftSignals(makePick({ pickNo: 42 }), [], {})).toEqual({});
  });
});

describe('reach and disappointment thresholds', () => {
  // reach  when picked more than min(24, adp * 0.5) picks early
  // fall    when picked more than 8 picks after his ADP
  const board = makePlayers([
    { player_id: 'elite', full_name: 'Elite Guy', position: 'WR', adp: 10 },
    { player_id: 'mid', full_name: 'Mid Guy', position: 'WR', adp: 40 },
    { player_id: 'deep', full_name: 'Deep Guy', position: 'WR', adp: 100 },
  ]);
  const at = (playerId: string, pickNo: number) =>
    computeDraftSignals(makePick({ pickNo, playerId, position: 'WR' }), [], board);

  describe('reach — the fraction dominates at the top of the board', () => {
    it('flags an elite player taken 6 early (threshold is 5, not 24)', () => {
      // adp 10 -> min(24, 5) = 5
      expect(at('elite', 4).reachedAboveRank).toBe(6);
    });

    it('leaves the same player alone 4 picks early', () => {
      expect(at('elite', 6).reachedAboveRank).toBeUndefined();
    });

    it('uses the exact boundary strictly — 5 early is not yet a reach', () => {
      expect(at('elite', 5).reachedAboveRank).toBeUndefined();
    });
  });

  describe('reach — the 24-pick cap takes over deeper down', () => {
    it('flags a deep player taken 30 early (cap 24 beats the fraction 50)', () => {
      expect(at('deep', 70).reachedAboveRank).toBe(30);
    });

    it('leaves the same player alone 20 picks early', () => {
      expect(at('deep', 80).reachedAboveRank).toBeUndefined();
    });

    it('picks whichever threshold is lower at the crossover', () => {
      // adp 40 -> min(24, 20) = 20, so the fraction still wins here
      expect(at('mid', 19).reachedAboveRank).toBe(21);
      expect(at('mid', 21).reachedAboveRank).toBeUndefined();
    });
  });

  describe('disappointment — a flat 8 picks past consensus', () => {
    it('is disappointed 9 picks after his ADP', () => {
      const s = at('mid', 49);
      expect(s.fellBelowRank).toBe(9);
      expect(s.reachedAboveRank).toBeUndefined();
    });

    it('is not disappointed at exactly 8 picks past', () => {
      expect(at('mid', 48).fellBelowRank).toBeUndefined();
    });

    it('applies the same 8-pick line everywhere on the board', () => {
      expect(at('elite', 19).fellBelowRank).toBe(9);
      expect(at('deep', 109).fellBelowRank).toBe(9);
    });

    it('marks him disappointed in the detail', () => {
      const d = computeDraftSignalDetail(
        makePick({ pickNo: 49, playerId: 'mid', position: 'WR' }), [], board,
      );
      expect(d.disappointed).toBe(true);
      expect(d.expectedRank).toBe(40);
      expect(d.surpriseThreshold).toBe(8);
    });
  });

  it('says nothing when the pick lands on his ADP', () => {
    const s = at('mid', 40);
    expect(s.fellBelowRank).toBeUndefined();
    expect(s.reachedAboveRank).toBeUndefined();
  });

  it('makes no claim when the player has no ADP', () => {
    const noRank = makePlayers([{ player_id: 'ghost', position: 'WR' }]);
    const s = computeDraftSignals(makePick({ pickNo: 200, playerId: 'ghost', position: 'WR' }), [], noRank);
    expect(s.fellBelowRank).toBeUndefined();
    expect(s.reachedAboveRank).toBeUndefined();
  });
});
