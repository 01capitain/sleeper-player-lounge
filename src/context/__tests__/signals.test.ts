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
    const players = makePlayers([{ player_id: 'star', search_rank: 20 }]);
    const signals = computeDraftSignals(pick, [], players);
    expect(signals.fellBelowRank).toBe(40);
    expect(computeDraftSignalDetail(pick, [], players).expectedRank).toBe(20);
  });

  it('is undefined for a small, unremarkable slide', () => {
    const pick = makePick({ pickNo: 25, playerId: 'star' });
    const players = makePlayers([{ player_id: 'star', search_rank: 20 }]);
    expect(computeDraftSignals(pick, [], players).fellBelowRank).toBeUndefined();
  });

  it('is undefined when Sleeper has no search_rank — never guess', () => {
    const pick = makePick({ pickNo: 200, playerId: 'star' });
    expect(computeDraftSignals(pick, [], makePlayers([{ player_id: 'star' }])).fellBelowRank).toBeUndefined();
    expect(computeDraftSignals(pick, [], {}).fellBelowRank).toBeUndefined();
  });

  it('ignores Sleeper sentinel ranks for unranked players', () => {
    const pick = makePick({ pickNo: 200, playerId: 'star' });
    const players = makePlayers([{ player_id: 'star', search_rank: 9999999 }]);
    expect(computeDraftSignals(pick, [], players).fellBelowRank).toBeUndefined();
  });
});

describe('quiet picks', () => {
  it('returns an empty object when no signal is genuinely present', () => {
    expect(computeDraftSignals(makePick({ pickNo: 42 }), [], {})).toEqual({});
  });
});
