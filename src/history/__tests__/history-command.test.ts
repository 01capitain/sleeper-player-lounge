import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runHistoryImport } from '../../cli/commands/history.js';
import type { ChampionsFile, LastSeasonFile } from '../../types.js';
import { readJson, writeJson } from '../../util/json.js';
import { D2025, L2026, makeClient, singleSeasonChain, threeSeasonChain } from './harness.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function workspace(): Promise<{
  lastSeasonFile: string;
  championsFile: string;
  selectedDraftFile: string;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lounge-history-cli-'));
  tempDirs.push(dir);
  return {
    lastSeasonFile: path.join(dir, 'last-season.json'),
    championsFile: path.join(dir, 'champions.json'),
    selectedDraftFile: path.join(dir, 'selected-draft.json'),
  };
}

describe('runHistoryImport', () => {
  it('writes both history files and prints a summary', async () => {
    const files = await workspace();
    const { client } = makeClient(threeSeasonChain());
    const out: string[] = [];

    await runHistoryImport({ league: L2026 }, { client, ...files, stdout: (line) => out.push(line) });

    const lastSeason = await readJson<LastSeasonFile>(files.lastSeasonFile);
    const champions = await readJson<ChampionsFile>(files.championsFile);

    expect(lastSeason.season).toBe(2025);
    expect(Object.keys(lastSeason.players)).toHaveLength(7);
    expect(Object.keys(champions.championshipRosters).sort()).toEqual(['2024', '2025']);

    const text = out.join('\n');
    expect(text).toContain('Seasons found: 3');
    expect(text).toContain('Champions: 2');
    expect(text).toContain('2025 roster records: 7');
    expect(text).toMatch(/disaster\s+1/);
    expect(text).toMatch(/excellent\s+1/);
    expect(text).toContain(files.lastSeasonFile);
  });

  it('preserves the template rules block on the written files', async () => {
    const files = await workspace();
    const { client } = makeClient(threeSeasonChain());
    await runHistoryImport({ league: L2026 }, { client, ...files, stdout: () => {} });

    const lastSeason = await readJson<Record<string, unknown>>(files.lastSeasonFile);
    const champions = await readJson<Record<string, unknown>>(files.championsFile);
    expect(lastSeason['rules']).toMatchObject({ explicitSeasonMentionRequired: true });
    expect(champions['rules']).toMatchObject({ onlyLongTermRosterMemory: 'championship_membership' });
  });

  it('defaults to the Simulation league from selected-draft.json', async () => {
    const files = await workspace();
    await writeJson(files.selectedDraftFile, {
      leagueId: D2025,
      leagueName: 'Defensive Bros',
      draftId: 'DB2025DRAFT',
      season: 2025,
      status: 'complete',
      type: 'snake',
      rounds: 17,
      teams: 14,
      selectedAt: '2026-08-28T00:00:00.000Z',
      totalPicks: 241,
    });
    const { client } = makeClient(singleSeasonChain());
    const out: string[] = [];

    await runHistoryImport({}, { client, ...files, stdout: (line) => out.push(line) });

    const lastSeason = await readJson<LastSeasonFile>(files.lastSeasonFile);
    expect(lastSeason.sourceLeagueId).toBe(D2025);
    expect(out.join('\n')).toContain('Seasons found: 1');
  });

  it('explains what to do when no Simulation league has been selected', async () => {
    const files = await workspace();
    const { client } = makeClient(threeSeasonChain());
    await expect(runHistoryImport({}, { client, ...files, stdout: () => {} })).rejects.toThrow(
      /lounge setup/,
    );
  });

  it('resolves the configured target league by name with --target', async () => {
    const files = await workspace();
    const routes = threeSeasonChain();
    routes['/user/471439689564286976/leagues/nfl/2026'] = [
      { league_id: 'other', name: 'Defensive Bros', season: '2026', status: 'in_season', total_rosters: 14 },
      routes[`/league/${L2026}`],
    ];
    const { client } = makeClient(routes);
    const out: string[] = [];

    await runHistoryImport({ target: true }, { client, ...files, stdout: (line) => out.push(line) });

    const lastSeason = await readJson<LastSeasonFile>(files.lastSeasonFile);
    expect(lastSeason.sourceLeagueId).toBe('L2025');
    expect(out[0]).toContain(L2026);
  });
});
