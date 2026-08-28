/**
 * The shared one-Pick pipeline.
 *
 * Every command that turns a Pick into something you can look at goes through
 * `processPick`:
 *
 *   hasProcessed? -> buildContext -> Director -> validate -> persist -> render
 *
 * IDEMPOTENCY IS A PRODUCT RULE (implementation_plan.md §14). The guard is the
 * first thing that happens, before a single token is spent, and a Pick that has
 * already been processed comes back as `skipped: true` carrying the Reaction
 * that is already on disk — never a second, different one.
 *
 * Everything the pipeline touches is injectable, because the two things it
 * depends on that must never appear in a test are the `claude` binary (costs
 * money) and the network. Tests pass `director: new StubDirector()` and an
 * in-memory `players` index; nothing else is required.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { loadConfig } from '../config.js';
import type { BuildContextDeps, BuiltContext } from '../context/builder.js';
import { buildContext } from '../context/builder.js';
import { createClaudeCliDirector, StubDirector, type DirectorUsage } from '../director/index.js';
import { loadAdp, enrichWithAdp } from '../import/adp.js';
import { applyAlias, loadAliasMap } from '../import/alias.js';
import type { PlayerIndex } from '../import/players.js';
import {
  hasProcessed,
  persistReaction,
  recentMessages,
  type PersistOptions,
} from '../lounge/persist.js';
import { cacheDir, loungeReactionsFile, playersCacheFile, reactionSchemaFile } from '../paths.js';
import type { LoungeBrowser } from '../render/browser.js';
import { defaultOutputPath, render, type RenderOptions } from '../render/index.js';
import type { PlayerChipMeta } from '../render/payload.js';
import type {
  LoungeDirector,
  ManagerAliasMap,
  Pick,
  Reaction,
  RenderFormat,
  SleeperPlayer,
} from '../types.js';
import { readJson, readJsonIfExists } from '../util/json.js';
import { readJsonl } from '../util/jsonl.js';
import { log } from '../util/log.js';
import { validateReaction } from '../validate.js';

// ---------------------------------------------------------------------------
// Options and result
// ---------------------------------------------------------------------------

export interface ProcessPickOptions {
  /**
   * The Director to use. Defaults to the real `claude -p` subprocess, so every
   * test must pass one — `StubDirector` is free and deterministic.
   */
  director?: LoungeDirector;
  /** Shorthand for `director: new StubDirector()`. */
  stub?: boolean;
  /** Render an asset after persisting. Default true. */
  render?: boolean;
  /** png | gif | mp4. Defaults to `rendering.defaultFormat`. */
  format?: RenderFormat;
  /** Apply the Manager Alias overlay to the Pick before anything reads it. */
  alias?: boolean;
  /** A preloaded alias map, so a batch does not re-read the file per Pick. */
  aliasMap?: ManagerAliasMap | null;
  /** Open the rendered file with the platform opener. Default false. */
  open?: boolean;
  /** Reuse one chromium across a batch instead of launching one per Pick. */
  browser?: LoungeBrowser;
  /** Explicit output path. Defaults to `output/{eventId}.{format}`. */
  out?: string;
  /** ADP-enriched players dataset. Loaded from cache when omitted. */
  players?: PlayerIndex;
  /** Extra `buildContext` dependencies (tests inject the whole world here). */
  contextDeps?: BuildContextDeps;
  /** File overrides for the three lounge files. */
  persist?: PersistOptions;
  /** Extra renderer options, e.g. `headshotOptions: { download: false }`. */
  renderOptions?: RenderOptions;
  /**
   * When a Pick was already processed, re-render its stored Reaction instead of
   * doing nothing. Costs no money — the Director is never called. `demo` uses
   * it so running it twice still ends with a picture.
   */
  rerenderSkipped?: boolean;
}

export interface ProcessPickResult {
  eventId: string;
  /** The Pick as processed, i.e. after any Manager Alias overlay. */
  pick: Pick;
  /** The Reaction — freshly generated, or the stored one when skipped. */
  reaction: Reaction | null;
  /** Absolute path of the rendered asset, or null when nothing was rendered. */
  outputPath: string | null;
  /** True when this Pick already had a Reaction and none was generated. */
  skipped: boolean;
  /** The Context that was handed to the Director, when one was built. */
  context?: BuiltContext;
  /** Director cost in USD, when the real Director reported it. */
  costUsd?: number;
  usage: DirectorUsage[];
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

/**
 * Run one Pick through the whole pipeline exactly once.
 * Never throws for the "already processed" case — that is an ordinary outcome.
 */
export async function processPick(
  pick: Pick,
  opts: ProcessPickOptions = {},
): Promise<ProcessPickResult> {
  const target = opts.alias === true ? await aliasPick(pick, opts) : pick;
  const usage: DirectorUsage[] = [];

  // --- the idempotency guard, before anything expensive ---------------------
  if (await hasProcessed(target.eventId, opts.persist ?? {})) {
    const stored = await findReactionByEventId(target.eventId, opts.persist?.reactionsFile);
    log.info(`pick ${target.pickNo} (${target.playerName}) already processed — skipping`);
    let outputPath: string | null = null;
    if (stored && opts.rerenderSkipped === true && opts.render !== false) {
      outputPath = await renderReaction(stored, opts);
    }
    return {
      eventId: target.eventId,
      pick: target,
      reaction: stored,
      outputPath,
      skipped: true,
      usage,
    };
  }

  // --- context --------------------------------------------------------------
  const players = opts.players ?? (await loadEnrichedPlayers());
  const context = await buildContext(target, { players, ...opts.contextDeps });

  // --- director -------------------------------------------------------------
  const director = await resolveDirector(opts, usage);
  const generated = await director.generateReaction(context);

  // --- validate -------------------------------------------------------------
  // The real Director already validated; a stub or a future adapter may not
  // have, and nothing unvalidated is ever allowed onto disk.
  const reaction = validateReaction(generated);

  // --- persist --------------------------------------------------------------
  const persisted = await persistReaction(reaction, {
    ...(opts.persist ?? {}),
    simulated: target.simulated === true,
    pickNo: target.pickNo,
  });
  if (!persisted.persisted) {
    // Another writer got there between the guard and here.
    log.warn(`pick ${target.pickNo} was persisted concurrently; not writing a duplicate`);
  }

  // --- render ---------------------------------------------------------------
  let outputPath: string | null = null;
  if (opts.render !== false) {
    outputPath = await renderReaction(reaction, { ...opts, players, context });
  }

  const costUsd = totalCost(usage);
  return {
    eventId: target.eventId,
    pick: target,
    reaction,
    outputPath,
    skipped: false,
    context,
    ...(costUsd !== undefined ? { costUsd } : {}),
    usage,
  };
}

/** Sum of every `total_cost_usd` the Director reported, or undefined. */
export function totalCost(usage: readonly DirectorUsage[]): number | undefined {
  const costs = usage
    .map((entry) => entry.totalCostUsd)
    .filter((value): value is number => typeof value === 'number');
  if (costs.length === 0) return undefined;
  return costs.reduce((sum, value) => sum + value, 0);
}

async function resolveDirector(
  opts: ProcessPickOptions,
  usage: DirectorUsage[],
): Promise<LoungeDirector> {
  if (opts.director) return opts.director;
  if (opts.stub === true) return new StubDirector();
  // The Director sanitizes the schema for `--json-schema` itself; see
  // `structuredOutputSchema` in src/director/claude-cli.ts.
  return createClaudeCliDirector({
    onUsage: (entry) => usage.push(entry),
  });
}

async function aliasPick(pick: Pick, opts: ProcessPickOptions): Promise<Pick> {
  const map = opts.aliasMap === undefined ? await loadAliasMap() : opts.aliasMap;
  if (!map) {
    log.warn('Manager Alias requested but no alias map exists; using the real managers');
    return pick;
  }
  const aliased = applyAlias(pick, map);
  // The eventId is `{draftId}:{pickNo}:{playerId}` — the alias touches only the
  // Manager, so idempotency is unaffected by design.
  return aliased;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export interface RenderReactionOptions extends ProcessPickOptions {
  context?: BuiltContext;
}

/**
 * Render a Reaction with the transcript tail and team chips filled in.
 * Shared by `processPick`, `react` and `screenshot` — the last two reach it
 * without ever constructing a Director.
 */
export async function renderReaction(
  reaction: Reaction,
  opts: RenderReactionOptions = {},
): Promise<string> {
  const config = await loadConfig().catch(() => undefined);
  const format: RenderFormat = opts.format ?? config?.rendering.defaultFormat ?? 'mp4';
  const out = opts.out ?? defaultOutputPath(reaction.eventId, format);
  const players = opts.players ?? (await loadEnrichedPlayers());
  const history = await recentMessages(8, opts.persist ?? {});

  const renderOptions: RenderOptions = {
    format,
    out,
    recentMessages: history,
    playerMeta: buildPlayerMeta(reaction, players, opts.context),
    ...(config ? { config } : {}),
    ...(opts.browser ? { browser: opts.browser } : {}),
    ...(opts.renderOptions ?? {}),
  };

  const written = await render(reaction, renderOptions);
  if (opts.open === true) openFile(written);
  return written;
}

/**
 * `playerId -> { position, nflTeam }` for every Speaker in the Reaction.
 *
 * Regulars can appear under a `star:` pseudo id when the players dataset has no
 * match for them, so the Context's actor list is merged in on top of the
 * dataset lookup — it is the only place those pseudo ids carry metadata.
 */
export function buildPlayerMeta(
  reaction: Reaction,
  players: Readonly<Record<string, SleeperPlayer>>,
  context?: BuiltContext,
): Record<string, PlayerChipMeta> {
  const meta: Record<string, PlayerChipMeta> = {};
  const ids = new Set<string>([reaction.pick.playerId]);
  for (const message of reaction.reactions) ids.add(message.speakerPlayerId);

  for (const id of ids) {
    const player = players[id];
    if (player) meta[id] = { position: player.position ?? null, nflTeam: player.team ?? null };
  }
  for (const actor of context?.actors ?? []) {
    // A Regular can be addressed either by his real Sleeper id or, when the
    // players dataset has no match for him, by a `star:` pseudo id.
    for (const id of [actor.playerId, actor.starKey ? `star:${actor.starKey}` : undefined]) {
      if (id === undefined || !ids.has(id)) continue;
      meta[id] = {
        position: actor.position ?? meta[id]?.position ?? null,
        nflTeam: actor.nflTeam ?? meta[id]?.nflTeam ?? null,
      };
    }
  }
  return meta;
}

// ---------------------------------------------------------------------------
// Stored Reactions — the `react` / `screenshot` source
// ---------------------------------------------------------------------------

/** A persisted Reaction row. `createdAt`/`simulated` come from the persist layer. */
export type StoredReaction = Reaction & { createdAt?: string; simulated?: boolean };

/** Every stored Reaction, oldest first. A missing file reads as `[]`. */
export async function loadReactions(filePath = loungeReactionsFile): Promise<StoredReaction[]> {
  return readJsonl<StoredReaction>(filePath);
}

/** The most recently generated Reaction, or null when none exist yet. */
export async function latestReaction(filePath = loungeReactionsFile): Promise<StoredReaction | null> {
  const rows = await loadReactions(filePath);
  return rows[rows.length - 1] ?? null;
}

/** The most recent stored Reaction for one overall pick number, or null. */
export async function findReactionByPickNo(
  pickNo: number,
  filePath = loungeReactionsFile,
): Promise<StoredReaction | null> {
  const rows = await loadReactions(filePath);
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row?.pick?.pickNo === pickNo) return row;
  }
  return null;
}

/** The most recent stored Reaction for one `eventId`, or null. */
export async function findReactionByEventId(
  eventId: string,
  filePath = loungeReactionsFile,
): Promise<StoredReaction | null> {
  const rows = await loadReactions(filePath);
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row?.eventId === eventId) return row;
  }
  return null;
}

/**
 * Every `eventId` that already has a Reaction, in one pass.
 *
 * `hasProcessed` re-reads both logs per call, which is fine for one Pick and
 * quadratic for a 238-Pick replay. Batch callers filter with this instead.
 */
export async function processedEventIds(options: PersistOptions = {}): Promise<Set<string>> {
  const rows = await loadReactions(options.reactionsFile);
  return new Set(rows.map((row) => row.eventId));
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

/** The generated dialogue as plain text, so it is readable without the image. */
export function formatDialogue(reaction: Reaction, indent = '  '): string[] {
  return reaction.reactions.map(
    (message) => `${indent}${message.speakerName}: ${message.text}`,
  );
}

/** `#74 · round 6 · Kyle Pitts -> Team Name`. */
export function describePick(pick: Pick): string {
  const round = pick.round === null || pick.round === undefined ? '?' : pick.round;
  return `#${pick.pickNo} · round ${round} · ${pick.playerName} -> ${pick.managerName}`;
}

// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------

let playerCache: PlayerIndex | null = null;

/**
 * The cached players dataset with ADP merged in.
 *
 * `ensurePlayerCache` merges the ADP artifact in memory *after* the dataset has
 * been written to disk, so `data/cache/sleeper-players.json` carries no `adp`
 * field. Reading the cache without re-merging silently disables every
 * reach/fall signal (ADR 0004), so the merge happens here, on every load.
 * No network: setup already wrote the cache.
 */
export async function loadEnrichedPlayers(force = false): Promise<PlayerIndex> {
  if (playerCache !== null && !force) return playerCache;
  const players = (await readJsonIfExists<PlayerIndex>(playersCacheFile)) ?? {};
  if (Object.keys(players).length === 0) {
    log.warn(
      'players dataset cache is empty — run `lounge setup`; names and chips will be degraded',
    );
  }
  enrichWithAdp(players, await loadAdp());
  playerCache = players;
  return players;
}

/** Test seam — drop the memoized players dataset. */
export function clearPlayerCache(): void {
  playerCache = null;
}

// ---------------------------------------------------------------------------
// Opening the result
// ---------------------------------------------------------------------------

/** The platform's "open this file" command, or null on an unknown platform. */
export function openerFor(platform: NodeJS.Platform = process.platform): string | null {
  if (platform === 'darwin') return 'open';
  if (platform === 'win32') return 'start';
  if (platform === 'linux') return 'xdg-open';
  return null;
}

/**
 * Hand the rendered file to the platform viewer. Fire and forget: a missing
 * opener (headless CI, an unusual desktop) is never a pipeline failure — the
 * absolute path has already been printed.
 */
export function openFile(filePath: string, platform: NodeJS.Platform = process.platform): boolean {
  const opener = openerFor(platform);
  if (opener === null) {
    log.warn(`no known file opener for platform '${platform}'; open ${filePath} yourself`);
    return false;
  }
  try {
    const child =
      platform === 'win32'
        ? spawn('cmd', ['/c', 'start', '', filePath], { detached: true, stdio: 'ignore' })
        : spawn(opener, [filePath], { detached: true, stdio: 'ignore' });
    child.on('error', (error) => log.warn(`could not open ${filePath}`, error));
    child.unref();
    return true;
  } catch (error) {
    log.warn(`could not open ${filePath}`, error);
    return false;
  }
}
