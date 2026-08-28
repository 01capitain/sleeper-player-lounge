/**
 * Shared fixtures for the CLI tests.
 *
 * Two rules govern everything in here, and they are the reason the helpers
 * exist at all:
 *
 *  - **No test ever spawns the real `claude` binary.** It costs money. Every
 *    test injects `StubDirector`, which is deterministic and free.
 *  - **No test ever touches the network or the repo's real data files.** Each
 *    test gets a temp workspace, and `inertContextDeps()` hands `buildContext`
 *    a complete, empty world so it never reads `data/`.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { BuildContextDeps } from '../../context/builder.js';
import type { PersistOptions } from '../../lounge/persist.js';
import type { LoungeBrowser } from '../../render/browser.js';
import type { LoungeState, Pick, RelationshipsSeed } from '../../types.js';
import { writeJsonl } from '../../util/jsonl.js';

export const DRAFT_ID = '1389356983177465857';
export const LEAGUE_ID = '1389356983177465856';

/** A normalized Pick with a real-looking `{draftId}:{pickNo}:{playerId}` eventId. */
export function makePick(overrides: Partial<Pick> = {}): Pick {
  const pickNo = overrides.pickNo ?? 74;
  const playerId = overrides.playerId ?? '7553';
  const draftId = overrides.draftId ?? DRAFT_ID;
  return {
    eventId: `${draftId}:${pickNo}:${playerId}`,
    season: 2026,
    leagueId: LEAGUE_ID,
    draftId,
    pickNo,
    round: 6,
    draftSlot: 4,
    playerId,
    playerName: 'Kyle Pitts',
    position: 'TE',
    nflTeam: 'ATL',
    managerId: 'u-1',
    managerName: 'The Isotones',
    simulated: true,
    ...overrides,
  };
}

/** The three lounge files, all inside one temp directory. */
export interface WorkspaceFiles extends PersistOptions {
  reactionsFile: string;
  messagesFile: string;
  stateFile: string;
}

export interface Workspace {
  dir: string;
  persist: WorkspaceFiles;
  picksFile: string;
  /** Write `picks.jsonl` for `loadPicks(picksFile)`. */
  writePicks(picks: readonly Pick[]): Promise<void>;
}

const created: string[] = [];

/** A temp directory standing in for `data/lounge` plus a picks file. */
export async function workspace(): Promise<Workspace> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lounge-cli-'));
  created.push(dir);
  const picksFile = path.join(dir, 'picks.jsonl');
  return {
    dir,
    picksFile,
    persist: {
      reactionsFile: path.join(dir, 'reactions.jsonl'),
      messagesFile: path.join(dir, 'messages.jsonl'),
      stateFile: path.join(dir, 'state.json'),
    },
    writePicks: (picks) => writeJsonl(picksFile, [...picks]),
  };
}

/** Remove every temp workspace. Call from `afterEach`. */
export async function cleanWorkspaces(): Promise<void> {
  await Promise.all(
    created.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
}

const EMPTY_STATE: LoungeState = {
  season: 2026,
  lastProcessedPickNo: 0,
  activeRunningJokes: [],
  activeRivalries: [],
  recentTone: 'neutral',
};

const EMPTY_RELATIONSHIPS: RelationshipsSeed = { version: 1, relationships: [] };

/**
 * A fully injected, empty world for `buildContext`.
 *
 * `history: null` is the important one: it exercises the "before `history
 * import` has ever run" path, which is the state a clean checkout is in.
 */
export function inertContextDeps(overrides: BuildContextDeps = {}): BuildContextDeps {
  return {
    players: {},
    starPlayers: [],
    relationships: EMPTY_RELATIONSHIPS,
    state: EMPTY_STATE,
    recentMessages: [],
    priorPicks: [],
    history: null,
    teammatesOf: null,
    positionRivalsOf: null,
    ...overrides,
  };
}

/** A `LoungeBrowser` that is never actually a browser. */
export function fakeBrowser(): { browser: LoungeBrowser; closed: () => number } {
  let closes = 0;
  const browser = {
    newPage: () => Promise.reject(new Error('fake browser: no pages')),
    close: () => {
      closes += 1;
      return Promise.resolve();
    },
  } as unknown as LoungeBrowser;
  return { browser, closed: () => closes };
}
