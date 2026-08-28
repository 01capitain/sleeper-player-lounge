/**
 * Read-only Sleeper API client.
 *
 * Sleeper's read API needs no auth (implementation_plan.md §6). Every response is
 * cached on disk under `data/cache/http/` so replaying a 238-pick Simulation does
 * not hammer the API and so the pipeline stays reproducible offline.
 *
 * The ~5MB `/players/nfl` dataset bypasses that cache and gets its own file with a
 * 24h TTL (§7) — it is far too large to sit alongside small keyed responses.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { httpCacheDir, playersCacheFile } from '../paths.js';
import type { SleeperPlayer } from '../types.js';
import { log } from '../util/log.js';
import type {
  SleeperBracketMatch,
  SleeperDraft,
  SleeperDraftPick,
  SleeperLeague,
  SleeperMatchup,
  SleeperRoster,
  SleeperUser,
} from './types.js';

export const SLEEPER_BASE_URL = 'https://api.sleeper.app/v1';
export const SLEEPER_CDN_BASE_URL = 'https://sleepercdn.com';

/** Default on-disk TTL for small API responses. */
export const DEFAULT_TTL_MS = 10 * 60 * 1000;
/** TTL for the big `/players/nfl` dataset. */
export const PLAYERS_TTL_MS = 24 * 60 * 60 * 1000;
/** Total attempts per request, including the first. */
export const MAX_ATTEMPTS = 3;

/** Exponential backoff: 250ms, 1s, 4s. */
export function backoffMs(attempt: number): number {
  return 250 * 4 ** attempt;
}

/** Thrown for a Sleeper 404. Never retried — a 404 is an answer, not a failure. */
export class SleeperNotFoundError extends Error {
  readonly path: string;
  constructor(requestPath: string) {
    super(`Sleeper 404: ${requestPath}`);
    this.name = 'SleeperNotFoundError';
    this.path = requestPath;
  }
}

/** Thrown for any other non-2xx response, after retries are exhausted. */
export class SleeperHttpError extends Error {
  readonly status: number;
  readonly path: string;
  constructor(status: number, requestPath: string, body?: string) {
    super(`Sleeper ${status}: ${requestPath}${body ? ` — ${body.slice(0, 200)}` : ''}`);
    this.name = 'SleeperHttpError';
    this.status = status;
    this.path = requestPath;
  }
}

/** What a cached response file contains. */
export interface HttpCacheEntry<T = unknown> {
  fetchedAt: string;
  path: string;
  body: T;
}

export interface GetOptions {
  /** Cache lifetime in ms. Defaults to 10 minutes. `0` forces a fresh fetch. */
  ttlMs?: number;
}

export interface SleeperClientOptions {
  baseUrl?: string;
  cacheDir?: string;
  playersCacheFile?: string;
  fetchImpl?: typeof fetch;
  /** Injectable for tests; production waits for real time. */
  sleepImpl?: (ms: number) => Promise<void>;
}

function cacheDisabled(): boolean {
  return process.env['LOUNGE_NO_CACHE'] === '1';
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export class SleeperClient {
  private readonly baseUrl: string;
  private readonly cacheDir: string;
  private readonly playersCacheFile: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(options: SleeperClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? SLEEPER_BASE_URL;
    this.cacheDir = options.cacheDir ?? httpCacheDir;
    this.playersCacheFile = options.playersCacheFile ?? playersCacheFile;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.sleepImpl = options.sleepImpl ?? sleep;
  }

  // -- generic ---------------------------------------------------------------

  /**
   * GET `{baseUrl}{path}` as JSON, through the on-disk response cache.
   * `path` must start with `/`, e.g. `/league/123/rosters`.
   */
  async get<T>(requestPath: string, opts: GetOptions = {}): Promise<T> {
    const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    const cacheFile = this.cacheFileFor(requestPath);

    if (!cacheDisabled() && ttlMs > 0) {
      const cached = await this.readCache<T>(cacheFile, ttlMs);
      if (cached !== null) {
        log.debug('sleeper cache hit', requestPath);
        return cached;
      }
    }

    const body = await this.fetchJson<T>(requestPath);
    await this.writeCache(cacheFile, requestPath, body);
    return body;
  }

  private cacheFileFor(requestPath: string): string {
    const key = createHash('sha256').update(requestPath).digest('hex');
    return path.join(this.cacheDir, `${key}.json`);
  }

  private async readCache<T>(cacheFile: string, ttlMs: number): Promise<T | null> {
    let raw: string;
    try {
      raw = await fs.readFile(cacheFile, 'utf8');
    } catch {
      return null;
    }
    try {
      const entry = JSON.parse(raw) as HttpCacheEntry<T>;
      const age = Date.now() - Date.parse(entry.fetchedAt);
      if (!Number.isFinite(age) || age > ttlMs || age < 0) return null;
      return entry.body;
    } catch {
      return null;
    }
  }

  private async writeCache(cacheFile: string, requestPath: string, body: unknown): Promise<void> {
    const entry: HttpCacheEntry = {
      fetchedAt: new Date().toISOString(),
      path: requestPath,
      body,
    };
    try {
      await fs.mkdir(path.dirname(cacheFile), { recursive: true });
      await fs.writeFile(cacheFile, JSON.stringify(entry), 'utf8');
    } catch (error) {
      // A broken cache must never break a request.
      log.warn('sleeper cache write failed', requestPath, error);
    }
  }

  /** Fetch with retry on network error and 5xx. 404 short-circuits. */
  private async fetchJson<T>(requestPath: string): Promise<T> {
    const url = `${this.baseUrl}${requestPath}`;
    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      try {
        const response = await this.fetchImpl(url, {
          headers: { accept: 'application/json' },
        });

        if (response.status === 404) throw new SleeperNotFoundError(requestPath);

        if (response.status >= 500) {
          lastError = new SleeperHttpError(response.status, requestPath);
        } else if (!response.ok) {
          // 4xx other than 404: deterministic, do not retry.
          throw new SleeperHttpError(response.status, requestPath, await safeText(response));
        } else {
          return (await response.json()) as T;
        }
      } catch (error) {
        if (error instanceof SleeperNotFoundError) throw error;
        if (error instanceof SleeperHttpError && error.status < 500) throw error;
        lastError = error;
      }

      if (attempt < MAX_ATTEMPTS - 1) {
        const wait = backoffMs(attempt);
        log.warn(`sleeper request failed (attempt ${attempt + 1}/${MAX_ATTEMPTS}), retrying in ${wait}ms`, requestPath);
        await this.sleepImpl(wait);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(`Sleeper request failed: ${requestPath}`);
  }

  // -- typed helpers ---------------------------------------------------------

  /** Leagues a user belongs to for one sport/season, e.g. `('4714…', 'nfl', '2026')`. */
  async getUserLeagues(
    userId: string,
    sport: string,
    season: string | number,
    opts?: GetOptions,
  ): Promise<SleeperLeague[]> {
    return this.get<SleeperLeague[]>(`/user/${userId}/leagues/${sport}/${season}`, opts);
  }

  async getLeague(leagueId: string, opts?: GetOptions): Promise<SleeperLeague> {
    return this.get<SleeperLeague>(`/league/${leagueId}`, opts);
  }

  async getLeagueUsers(leagueId: string, opts?: GetOptions): Promise<SleeperUser[]> {
    return this.get<SleeperUser[]>(`/league/${leagueId}/users`, opts);
  }

  async getLeagueRosters(leagueId: string, opts?: GetOptions): Promise<SleeperRoster[]> {
    return this.get<SleeperRoster[]>(`/league/${leagueId}/rosters`, opts);
  }

  async getLeagueDrafts(leagueId: string, opts?: GetOptions): Promise<SleeperDraft[]> {
    return this.get<SleeperDraft[]>(`/league/${leagueId}/drafts`, opts);
  }

  async getDraft(draftId: string, opts?: GetOptions): Promise<SleeperDraft> {
    return this.get<SleeperDraft>(`/draft/${draftId}`, opts);
  }

  async getDraftPicks(draftId: string, opts?: GetOptions): Promise<SleeperDraftPick[]> {
    return this.get<SleeperDraftPick[]>(`/draft/${draftId}/picks`, opts);
  }

  async getWinnersBracket(leagueId: string, opts?: GetOptions): Promise<SleeperBracketMatch[]> {
    return this.get<SleeperBracketMatch[]>(`/league/${leagueId}/winners_bracket`, opts);
  }

  async getMatchups(
    leagueId: string,
    week: number,
    opts?: GetOptions,
  ): Promise<SleeperMatchup[]> {
    return this.get<SleeperMatchup[]>(`/league/${leagueId}/matchups/${week}`, opts);
  }

  // -- players dataset -------------------------------------------------------

  /**
   * The full NFL players dataset, keyed by Sleeper player id.
   *
   * ~5MB, so it never touches the generic http cache: it is written verbatim to
   * `data/cache/sleeper-players.json` and considered fresh for 24h based on that
   * file's mtime.
   */
  async getAllPlayers(opts: { ttlMs?: number } = {}): Promise<Record<string, SleeperPlayer>> {
    const ttlMs = opts.ttlMs ?? PLAYERS_TTL_MS;

    if (!cacheDisabled() && ttlMs > 0) {
      const cached = await this.readPlayersCache(ttlMs);
      if (cached !== null) {
        log.debug('sleeper players cache hit');
        return cached;
      }
    }

    log.info('fetching Sleeper players dataset (~5MB)');
    const players = await this.fetchJson<Record<string, SleeperPlayer>>('/players/nfl');
    try {
      await fs.mkdir(path.dirname(this.playersCacheFile), { recursive: true });
      await fs.writeFile(this.playersCacheFile, JSON.stringify(players), 'utf8');
    } catch (error) {
      log.warn('players cache write failed', error);
    }
    return players;
  }

  private async readPlayersCache(ttlMs: number): Promise<Record<string, SleeperPlayer> | null> {
    try {
      const stat = await fs.stat(this.playersCacheFile);
      if (Date.now() - stat.mtimeMs > ttlMs) return null;
      const raw = await fs.readFile(this.playersCacheFile, 'utf8');
      return JSON.parse(raw) as Record<string, SleeperPlayer>;
    } catch {
      return null;
    }
  }

  /** Public headshot URL for a Sleeper player id. */
  headshotUrl(playerId: string): string {
    return headshotUrl(playerId);
  }
}

/** Public headshot URL for a Sleeper player id. */
export function headshotUrl(playerId: string): string {
  return `${SLEEPER_CDN_BASE_URL}/content/nfl/players/${playerId}.jpg`;
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

/** Shared default client. */
export const sleeper = new SleeperClient();

export default SleeperClient;
