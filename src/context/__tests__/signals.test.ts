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

describe('draft surprise is symmetric and league-relative', () => {
  const players = makePlayers([
    { player_id: 'star', full_name: 'Falling Star', position: 'WR', adp: 10 },
    { player_id: 'guy', full_name: 'Reached Guy', position: 'WR', adp: 90 },
  ]);

  it('reports a reach when a player goes far ahead of his ADP', () => {
    // rank 90, taken at 60 => 30 picks early, well past a 14-team threshold of 18.
    const pick = makePick({ pickNo: 60, playerId: 'guy', position: 'WR' });
    const signals = computeDraftSignals(pick, [], players, { teams: 14 });
    expect(signals.reachedAboveRank).toBe(30);
    expect(signals.fellBelowRank).toBeUndefined();
  });

  it('still reports a fall when a player slides past his ADP', () => {
    const pick = makePick({ pickNo: 45, playerId: 'star', position: 'WR' });
    const signals = computeDraftSignals(pick, [], players, { teams: 14 });
    expect(signals.fellBelowRank).toBe(35);
    expect(signals.reachedAboveRank).toBeUndefined();
  });

  it('says nothing when the pick lands near his ADP', () => {
    const pick = makePick({ pickNo: 14, playerId: 'star', position: 'WR' });
    const signals = computeDraftSignals(pick, [], players, { teams: 14 });
    expect(signals.fellBelowRank).toBeUndefined();
    expect(signals.reachedAboveRank).toBeUndefined();
  });

  it('scales the threshold with league size, so 8-team and 14-team differ', () => {
    // rank 10, taken at 22 => 12 picks late.
    const pick = makePick({ pickNo: 22, playerId: 'star', position: 'WR' });

    // 8-team league: threshold = round(8 * 1.25) = 10, so 12 picks IS a fall.
    expect(computeDraftSignals(pick, [], players, { teams: 8 }).fellBelowRank).toBe(12);

    // 14-team league: threshold = round(14 * 1.25) = 18, so the same 12 picks is not.
    expect(computeDraftSignals(pick, [], players, { teams: 14 }).fellBelowRank).toBeUndefined();
  });

  it('exposes the rank and threshold it judged against', () => {
    const pick = makePick({ pickNo: 60, playerId: 'guy', position: 'WR' });
    const detail = computeDraftSignalDetail(pick, [], players, { teams: 8 });
    expect(detail.expectedRank).toBe(90);
    expect(detail.surpriseThreshold).toBe(10);
  });

  it('makes no claim when the player has no ADP', () => {
    const noRank = makePlayers([{ player_id: 'ghost', position: 'WR' }]);
    const pick = makePick({ pickNo: 200, playerId: 'ghost', position: 'WR' });
    const signals = computeDraftSignals(pick, [], noRank, { teams: 8 });
    expect(signals.fellBelowRank).toBeUndefined();
    expect(signals.reachedAboveRank).toBeUndefined();
  });
});
