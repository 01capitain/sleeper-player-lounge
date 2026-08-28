/**
 * Desktop draft board — the whole draft on one page, as a single HTML file.
 *
 * WHAT THIS IS NOT: a change to the export pipeline. `png.ts` and `video.ts`
 * still render exactly one Reaction onto the 1080x1920 `templates/lounge.html`
 * stage, and nothing here touches them or what they output. This is an
 * additional *viewing* surface: a two-pane desktop page whose left pane is the
 * board (every Pick, in draft order) and whose right pane is the Lounge
 * transcript (every Reaction, in pick order). Clicking a Pick scrolls the
 * transcript to it; Replay re-animates one scene on the very beats
 * `buildTimeline()` hands the MP4 encoder, so a rewind shows what an export
 * would produce.
 *
 * Self-containment is the same guarantee `html.ts` makes and is verified the
 * same way: CSS and JS are inlined, headshots become `data:` URIs, and the
 * finished file makes zero network requests from `file://`.
 *
 * ---------------------------------------------------------------------------
 * Why the chat pane is built in the browser
 * ---------------------------------------------------------------------------
 * `templates/lounge.css` AND `templates/render.js` are read at build time and
 * inlined verbatim — never copied, never edited. The draft announcement is a
 * rich, JS-built structure (`.announce-stage` / `.announce-hero` /
 * `.announce-portrait`) whose hero line is *measured* and shrunk to fit by
 * `fitAnnouncement()`. Server-rendering a mirror of that DOM would silently
 * drift the moment the card is redesigned, so this builder does not mirror it:
 * it embeds one `RenderPayload` per scene and lets `window.LOUNGE` — the same
 * code the PNG and MP4 renders drive — build every scene in the page. A card
 * redesign therefore lands in this view for free.
 *
 * Every Pick appears, including the (many) Picks with no Reaction. Those are
 * rendered inert rather than hidden: a board that quietly drops two hundred
 * picks is not a board.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../config.js';
import {
  loungeReactionsFile,
  repoRoot,
  selectedDraftFile,
  simulationPicksFile,
} from '../paths.js';
import type { AppConfig, Pick, Reaction, RenderFormat, SelectedDraft } from '../types.js';
import { readJsonIfExists } from '../util/json.js';
import { readJsonl } from '../util/jsonl.js';
import { resolveHeadshots, type ResolveHeadshotsOptions } from './headshots.js';
import {
  buildTeamChip,
  toRenderPayload,
  type PlayerChipMeta,
  type RenderPayload,
} from './payload.js';
import { buildTimeline, type Timeline, type TimelineOptions } from './video.js';

const defaultTemplatesDir = path.join(repoRoot, 'templates');

/** A persisted `reactions.jsonl` row. */
type StoredReaction = Reaction & { createdAt?: string; simulated?: boolean };

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** One row of the left pane. `anchorId` is null when this Pick has no Reaction. */
export interface BoardRow {
  eventId: string;
  pickNo: number;
  round: number | null;
  draftSlot: number | null;
  playerName: string;
  position: string | null;
  nflTeam: string | null;
  managerName: string;
  /** DOM id of this Pick's scene in the right pane, or null when it has none. */
  anchorId: string | null;
  /** `npm run lounge -- react --pick N --format mp4`, or null with no scene. */
  exportCommand: string | null;
  /** `npm run lounge -- simulate --pick N`, offered when there is no scene. */
  generateCommand: string;
}

/** One scene of the right pane: an announcement card plus its Messages. */
export interface BoardScene {
  eventId: string;
  anchorId: string;
  pickNo: number;
  /**
   * The scene's own wall-clock header — `28 Aug 2026 · 18:15` — or null when
   * the stored Reaction carried no usable `createdAt`.
   */
  timestamp: string | null;
  /** Exactly what `window.LOUNGE.render()` accepts. */
  payload: RenderPayload;
  /** The same beats `renderVideo` plays. Replay walks these. */
  timeline: Timeline;
  exportCommand: string;
}

/** Everything the page needs, resolved and ready to render. */
export interface BoardModel {
  title: string;
  heading: string;
  subheading: string;
  leagueName: string;
  season: number;
  rows: BoardRow[];
  scenes: BoardScene[];
  watermark: string;
}

export interface BuildBoardOptions extends TimelineOptions {
  /** Picks to show. Defaults to `data/simulation/picks.jsonl`. */
  picks?: readonly Pick[];
  /** Override the picks file. Ignored when `picks` is given. */
  picksFile?: string;
  /** Reactions to show. Defaults to `data/lounge/reactions.jsonl`. */
  reactions?: readonly StoredReaction[];
  /** Override the reactions file. Ignored when `reactions` is given. */
  reactionsFile?: string;
  /** Only the last N Picks. */
  limit?: number;
  /** `playerId -> { position, nflTeam }`, for the chat's team/position chips. */
  playerMeta?: Readonly<Record<string, PlayerChipMeta>>;
  /** Loaded app config; `rendering.watermark` is read from it. */
  config?: { rendering: AppConfig['rendering'] };
  /** Explicit watermark, overriding the config value. */
  watermark?: string;
  /** Draft metadata for the heading. Pass `null` to skip the lookup. */
  draft?: SelectedDraft | null;
  /** Passed through to `resolveHeadshots` (cache dir, injected fetch, env). */
  headshotOptions?: ResolveHeadshotsOptions;
  /**
   * Directory the board HTML will be written to. Headshots are copied into a
   * `headshots/` folder beside it and referenced relatively. Omit to skip
   * headshots entirely — every avatar then falls back to its monogram.
   */
  assetDir?: string;
  /** Where `desktop.*`, `lounge.css` and `render.js` live. */
  templatesDir?: string;
  /** The `--format` shown in the export command. Defaults to `mp4`. */
  exportFormat?: RenderFormat;
  /**
   * A ready-made model, bypassing every lookup above. Mirrors
   * `preparePayload`'s `payload` option: a caller that already needs the model
   * (to report counts, say) builds it once and hands it straight back.
   */
  model?: BoardModel;
}

// ---------------------------------------------------------------------------
// The commands the page shows
// ---------------------------------------------------------------------------

/**
 * The export command for one Pick. `react` re-renders a *stored* Reaction and
 * never calls the Director, which is exactly what a rewind should offer.
 */
export function exportCommandFor(pickNo: number, format: RenderFormat = 'mp4'): string {
  return `npm run lounge -- react --pick ${pickNo} --format ${format}`;
}

/** What to run for a Pick that has no Reaction yet. */
export function generateCommandFor(pickNo: number): string {
  return `npm run lounge -- simulate --pick ${pickNo}`;
}

/**
 * The DOM id of a Pick's scene. Derived from the `eventId` so it is stable
 * across rebuilds and unique across drafts.
 */
export function anchorIdFor(eventId: string): string {
  const cleaned = eventId
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return `scene-${cleaned.length > 0 ? cleaned : 'reaction'}`;
}

// ---------------------------------------------------------------------------
// Fantasy ownership — who has him *now*
// ---------------------------------------------------------------------------

/** The Pick at which a player became somebody's, and who that somebody is. */
export interface Ownership {
  /** The overall pick number he went at. Ownership starts here, not before. */
  pickNo: number;
  managerName: string;
  /** His NFL position, from the Pick. `null` when the Pick did not carry one. */
  position: string | null;
}

/**
 * `playerId -> Ownership` across the whole draft.
 *
 * Built from every Pick, never only the ones on a `--limit`ed board: a board
 * showing the last 60 picks still knows that pick 3 happened.
 */
export function ownershipByPlayer(picks: readonly Pick[]): Map<string, Ownership> {
  const owners = new Map<string, Ownership>();
  for (const pick of picks) {
    if (!pick?.playerId) continue;
    const existing = owners.get(pick.playerId);
    // A player is drafted once; if a feed ever repeats him, the earliest Pick
    // is the one that made him somebody's.
    if (existing && existing.pickNo <= pick.pickNo) continue;
    owners.set(pick.playerId, {
      pickNo: pick.pickNo,
      managerName: pick.managerName,
      position: pick.position ?? null,
    });
  }
  return owners;
}

/**
 * The chip a speaker wears inside one scene.
 *
 * `RB · Bark to the Kamara` once a fantasy manager owns him, and `undefined`
 * while he is still on the board — in which case the caller leaves the NFL
 * chip (`ATL · RB`) that `toRenderPayload` already built alone.
 *
 * `atPickNo` is the scene's own pick, and the comparison is inclusive: the
 * player this scene is about is owned by the manager who just took him. A Pick
 * that happens *later* is the future, and an earlier scene must not show it.
 */
export function ownerChipFor(
  owner: Ownership | undefined,
  atPickNo: number,
): string | undefined {
  if (!owner || owner.pickNo > atPickNo) return undefined;
  const manager = owner.managerName?.trim();
  if (!manager) return undefined;
  const position = owner.position?.trim().toUpperCase();
  return position ? `${position} · ${manager}` : manager;
}

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

/**
 * Timestamps are read in UTC, which is how `createdAt` is stored.
 *
 * The alternative — the builder's own zone — would make the same reactions.jsonl
 * produce a different board on a different machine, and a board is a record of
 * when the draft happened, not of where it was rebuilt. No date library: this is
 * two fields off a `Date`.
 */
const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

/**
 * `createdAt + offsetMs`, or null when `createdAt` is missing or unparseable.
 *
 * Null rather than a thrown error or an `Invalid Date`: a Reaction persisted
 * before `createdAt` existed still deserves to be on the board, just without a
 * clock on it.
 */
function instantAt(createdAt: string | null | undefined, offsetMs = 0): Date | null {
  if (typeof createdAt !== 'string' || createdAt.trim() === '') return null;
  const base = Date.parse(createdAt);
  if (!Number.isFinite(base)) return null;
  const offset = Number.isFinite(offsetMs) ? offsetMs : 0;
  return new Date(base + offset);
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** `18:15` for one message: the scene's `createdAt` plus its own `delayMs`. */
export function formatMessageTime(
  createdAt: string | null | undefined,
  delayMs = 0,
): string | null {
  const at = instantAt(createdAt, delayMs);
  if (!at) return null;
  return `${pad2(at.getUTCHours())}:${pad2(at.getUTCMinutes())}`;
}

/** `28 Aug 2026 · 18:15` — the header above one scene. */
export function formatSceneTime(createdAt: string | null | undefined): string | null {
  const at = instantAt(createdAt);
  if (!at) return null;
  const day = at.getUTCDate();
  const month = MONTHS[at.getUTCMonth()] ?? '';
  return `${day} ${month} ${at.getUTCFullYear()} · ${pad2(at.getUTCHours())}:${pad2(
    at.getUTCMinutes(),
  )}`;
}

// ---------------------------------------------------------------------------
// Model assembly
// ---------------------------------------------------------------------------

/** Resolve every input into the finished `BoardModel`. No HTML yet. */
export async function buildBoardModel(opts: BuildBoardOptions = {}): Promise<BoardModel> {
  if (opts.model) return opts.model;

  const allPicks = opts.picks
    ? [...opts.picks]
    : await readJsonl<Pick>(opts.picksFile ?? simulationPicksFile);
  allPicks.sort((a, b) => a.pickNo - b.pickNo);

  const limit = opts.limit;
  const picks =
    typeof limit === 'number' && limit > 0 && limit < allPicks.length
      ? allPicks.slice(-limit)
      : allPicks;

  const reactions = opts.reactions
    ? [...opts.reactions]
    : await readJsonl<StoredReaction>(opts.reactionsFile ?? loungeReactionsFile);

  // Only Reactions for Picks actually on this board; a --limit must not leave
  // an orphaned scene in the transcript with no row to select it.
  const shown = new Set(picks.map((pick) => pick.eventId));
  const byEventId = new Map<string, StoredReaction>();
  for (const reaction of reactions) {
    if (reaction?.eventId && shown.has(reaction.eventId)) byEventId.set(reaction.eventId, reaction);
  }

  const config =
    opts.config ?? (opts.watermark ? undefined : await loadConfig().catch(() => undefined));
  const watermark =
    opts.watermark ?? config?.rendering.watermark ?? 'Players Lounge • Fantasy parody';
  const exportFormat = opts.exportFormat ?? 'mp4';

  // One headshot pass for the whole page, deduped by player id.
  const speakerIds = new Set<string>();
  for (const reaction of byEventId.values()) {
    speakerIds.add(reaction.pick.playerId);
    for (const message of reaction.reactions) speakerIds.add(message.speakerPlayerId);
  }
  const headshots = opts.assetDir
    ? await copyHeadshots(
        [...speakerIds].filter((id) => id.length > 0),
        opts.assetDir,
        opts.headshotOptions,
      )
    : {};

  const rows: BoardRow[] = picks.map((pick) => {
    const reaction = byEventId.get(pick.eventId);
    return {
      eventId: pick.eventId,
      pickNo: pick.pickNo,
      round: pick.round ?? null,
      draftSlot: pick.draftSlot ?? null,
      playerName: pick.playerName,
      position: pick.position ?? null,
      nflTeam: pick.nflTeam ?? null,
      managerName: pick.managerName,
      anchorId: reaction ? anchorIdFor(pick.eventId) : null,
      exportCommand: reaction ? exportCommandFor(pick.pickNo, exportFormat) : null,
      generateCommand: generateCommandFor(pick.pickNo),
    };
  });

  // Ownership is read from the whole draft, not from the (possibly limited)
  // board: what a scene may show is decided per scene, by pick number.
  const owners = ownershipByPlayer(allPicks);

  // Scenes follow the board, so the transcript reads in draft order.
  const scenes: BoardScene[] = [];
  for (const pick of picks) {
    const reaction = byEventId.get(pick.eventId);
    if (!reaction) continue;
    // No `previousMessages`: in a continuous transcript the previous scene IS
    // the previous messages, and repeating them would double every bubble.
    const payload = toRenderPayload(reaction, {
      headshots,
      watermark,
      ...(opts.playerMeta ? { playerMeta: opts.playerMeta } : {}),
    });
    applyLoungeChrome(payload, pick, owners, opts.playerMeta, reaction.createdAt);
    scenes.push({
      eventId: reaction.eventId,
      anchorId: anchorIdFor(pick.eventId),
      pickNo: pick.pickNo,
      timestamp: formatSceneTime(reaction.createdAt),
      payload,
      timeline: buildTimeline(payload, timelineOptionsFrom(opts)),
      exportCommand: exportCommandFor(pick.pickNo, exportFormat),
    });
  }

  const draft = opts.draft !== undefined ? opts.draft : await readSelectedDraft();
  const leagueName = draft?.leagueName ?? 'Draft';
  const season = draft?.season ?? picks[0]?.season ?? new Date().getUTCFullYear();

  const rounds = new Set(rows.map((row) => row.round).filter((r): r is number => r !== null));
  const teams = draft?.teams ?? new Set(rows.map((row) => row.managerName)).size;
  const heading = `${leagueName} — ${season} draft board`;
  const subheading = [
    `${rows.length} pick${rows.length === 1 ? '' : 's'}`,
    `${rounds.size} round${rounds.size === 1 ? '' : 's'}`,
    `${teams} teams`,
    `${scenes.length} Lounge scene${scenes.length === 1 ? '' : 's'}`,
  ].join(' · ');

  return {
    title: `${heading} · Players Lounge`,
    heading,
    subheading,
    leagueName,
    season,
    rows,
    scenes,
    watermark,
  };
}

/**
 * The two things the board shows that an export does not, written onto a
 * payload `toRenderPayload` has already built.
 *
 * Both are opt-in fields the export pipeline never sets, so `render.js` stays
 * the single renderer and a PNG or MP4 is unaffected:
 *
 *  - **the fantasy owner** replaces the NFL chip on every speaker the draft has
 *    already claimed, because in a draft room "who has him now" beats "who does
 *    he play for". The announcement card is handed the drafted player's NFL chip
 *    explicitly (`pick.teamChip`), so it keeps its team colour and nameplate
 *    even though his own bubble now names his manager.
 *  - **a clock** on each bubble, `createdAt + delayMs`, so the transcript reads
 *    as the evening it was.
 */
function applyLoungeChrome(
  payload: RenderPayload,
  pick: Pick,
  owners: ReadonlyMap<string, Ownership>,
  playerMeta: Readonly<Record<string, PlayerChipMeta>> | undefined,
  createdAt: string | undefined,
): void {
  const subjectMeta = playerMeta?.[pick.playerId] ?? {
    position: pick.position ?? null,
    nflTeam: pick.nflTeam ?? null,
  };
  const nflChip = buildTeamChip(subjectMeta);
  if (nflChip) payload.pick.teamChip = nflChip;

  for (const row of payload.reactions) {
    const chip = ownerChipFor(owners.get(row.speakerPlayerId), pick.pickNo);
    if (chip) row.teamChip = chip;
    const time = formatMessageTime(createdAt, row.delayMs);
    if (time) row.timestamp = time;
  }
}

function timelineOptionsFrom(opts: BuildBoardOptions): TimelineOptions {
  const resolved: TimelineOptions = {};
  if (opts.durationSeconds !== undefined) resolved.durationSeconds = opts.durationSeconds;
  if (opts.showTypingIndicators !== undefined) {
    resolved.showTypingIndicators = opts.showTypingIndicators;
  }
  if (opts.statusPauseMs !== undefined) resolved.statusPauseMs = opts.statusPauseMs;
  if (opts.holdMs !== undefined) resolved.holdMs = opts.holdMs;
  if (opts.typingLeadMs !== undefined) resolved.typingLeadMs = opts.typingLeadMs;
  return resolved;
}

async function readSelectedDraft(): Promise<SelectedDraft | null> {
  return (await readJsonIfExists<SelectedDraft>(selectedDraftFile)) ?? null;
}

/**
 * `playerId -> data: URI` for every locally cached headshot. Anything missing
 * is simply absent, and the avatar falls back to its monogram — the same rule
 * the render template already follows, so this never fails a build.
 */
/** Where the board's headshots are written, relative to the HTML file. */
export const HEADSHOT_DIR_NAME = 'headshots';

/**
 * Copy each player's headshot into a sidecar `headshots/` directory ONCE and
 * reference it by relative URL.
 *
 * The single-scene `--format html` export inlines its headshots as data URIs so
 * one file can be moved or emailed intact. The board cannot afford that: a
 * player who speaks in twenty scenes was embedded twenty times over, which put a
 * 38-scene board at 7.9MB and growing linearly with the transcript. Here the
 * same photo is written once and referenced by every scene that needs it, so the
 * page size stops tracking scene count and starts tracking cast size.
 *
 * The trade is that the board is a directory, not a single file. That is the
 * right call for a local tool you open next to a live draft, and the wrong one
 * for something you share — which is why only this build does it.
 */
async function copyHeadshots(
  playerIds: readonly string[],
  outDir: string,
  opts: ResolveHeadshotsOptions | undefined,
): Promise<Record<string, string>> {
  const resolved = await resolveHeadshots(playerIds, opts ?? {});
  const refs: Record<string, string> = {};
  const entries = Object.entries(resolved).filter(([, url]) => url.startsWith('file://'));
  if (entries.length === 0) return refs;

  const dir = path.join(outDir, HEADSHOT_DIR_NAME);
  try {
    await mkdir(dir, { recursive: true });
  } catch {
    return refs; // no directory, no headshots: the monogram avatar covers it
  }

  for (const [playerId, url] of entries) {
    try {
      const bytes = await readFile(fileURLToPath(url));
      // Sleeper serves PNG bytes from a .jpg URL, so sniff rather than trust it.
      const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
      const file = `${safeAssetName(playerId)}.${isPng ? 'png' : 'jpg'}`;
      await writeFile(path.join(dir, file), bytes);
      refs[playerId] = `${HEADSHOT_DIR_NAME}/${file}`;
    } catch {
      // no headshot: the monogram avatar covers it
    }
  }
  return refs;
}

/** A player id reduced to something safe to use as a filename. */
export function safeAssetName(playerId: string): string {
  const cleaned = playerId.replace(/[^A-Za-z0-9._-]/g, '_');
  return cleaned.length > 0 ? cleaned : 'unknown';
}

// ---------------------------------------------------------------------------
// The left pane
// ---------------------------------------------------------------------------

/** Every Pick, grouped by round, newest round last. */
export function renderBoardPane(rows: readonly BoardRow[]): string {
  const groups = new Map<number | null, BoardRow[]>();
  for (const row of rows) {
    const bucket = groups.get(row.round);
    if (bucket) bucket.push(row);
    else groups.set(row.round, [row]);
  }

  const sections: string[] = [];
  for (const [round, group] of groups) {
    const first = group[0];
    const last = group[group.length - 1];
    const withScenes = group.filter((row) => row.anchorId !== null).length;
    const range =
      first && last && first.pickNo !== last.pickNo
        ? `picks ${first.pickNo}-${last.pickNo}`
        : `pick ${first?.pickNo ?? '?'}`;
    sections.push(
      `        <section class="round" data-round="${round ?? ''}">\n` +
        `          <h2 class="round-head">` +
        `<span class="round-no">${round === null ? 'Unnumbered round' : `Round ${round}`}</span>` +
        `<span class="round-meta">${range}</span>` +
        `<span class="round-scenes">${
          withScenes > 0 ? `${withScenes} scene${withScenes === 1 ? '' : 's'}` : ''
        }</span></h2>\n` +
        `          <div class="round-rows">\n${group.map(renderPickRow).join('\n')}\n          </div>\n` +
        `        </section>`,
    );
  }
  return sections.join('\n');
}

function renderPickRow(row: BoardRow): string {
  const hasScene = row.anchorId !== null;
  const position = (row.position ?? '').toUpperCase();
  const team = row.nflTeam ?? '';
  const slot =
    row.round !== null && row.draftSlot !== null
      ? `R${row.round} · ${String(row.draftSlot).padStart(2, '0')}`
      : row.round !== null
        ? `R${row.round}`
        : '—';

  const search = [String(row.pickNo), row.playerName, position, team, row.managerName]
    .join(' ')
    .toLowerCase();

  const summary = [
    row.round !== null ? `Round ${row.round}` : null,
    position && team ? `${team} · ${position}` : position || team || null,
    `→ ${row.managerName}`,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' · ');

  const attrs = [
    'type="button"',
    `class="pick ${hasScene ? 'has-scene' : 'no-scene'}"`,
    `data-pick="${row.pickNo}"`,
    `data-player="${escapeHtml(row.playerName)}"`,
    `data-summary="${escapeHtml(summary)}"`,
    `data-search="${escapeHtml(search)}"`,
    hasScene ? `data-anchor="${escapeHtml(row.anchorId as string)}"` : null,
    `data-hint="${escapeHtml(row.generateCommand)}"`,
  ].filter((attr): attr is string => attr !== null);

  return (
    `            <button ${attrs.join(' ')}>` +
    `<span class="cell-no">${row.pickNo}</span>` +
    `<span class="cell-slot">${escapeHtml(slot)}</span>` +
    `<span class="cell-player">${escapeHtml(row.playerName)}</span>` +
    `<span class="cell-pos">${renderPosition(position)}</span>` +
    `<span class="cell-team">${escapeHtml(team || '—')}</span>` +
    `<span class="cell-manager">${escapeHtml(row.managerName)}</span>` +
    `<span class="cell-scene">${
      hasScene ? '<span class="scene-pill">Scene</span>' : '<span class="no-pill">—</span>'
    }</span>` +
    '</button>'
  );
}

const POSITIONS = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'DEF']);

function renderPosition(position: string): string {
  if (!position) return '<span class="pos">—</span>';
  const token = POSITIONS.has(position) ? position : 'DEF';
  return `<span class="pos" style="--pos: var(--pos-${token})">${escapeHtml(position)}</span>`;
}

// ---------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------

/** Build the complete, self-contained desktop board page. */
export async function buildBoardHtml(opts: BuildBoardOptions = {}): Promise<string> {
  const model = await buildBoardModel(opts);
  const dir = opts.templatesDir ?? defaultTemplatesDir;

  const [shell, loungeCss, desktopCss, renderJs, desktopJs] = await Promise.all([
    readFile(path.join(dir, 'desktop.html'), 'utf8'),
    readFile(path.join(dir, 'lounge.css'), 'utf8'),
    readFile(path.join(dir, 'desktop.css'), 'utf8'),
    readFile(path.join(dir, 'render.js'), 'utf8'),
    readFile(path.join(dir, 'desktop.js'), 'utf8'),
  ]);

  const data =
    'window.__BOARD__ = ' +
    jsonForScript({
      pickCount: model.rows.length,
      sceneCount: model.scenes.length,
      watermark: model.watermark,
      scenes: model.scenes.map((scene) => ({
        anchorId: scene.anchorId,
        eventId: scene.eventId,
        pickNo: scene.pickNo,
        timestamp: scene.timestamp,
        exportCommand: scene.exportCommand,
        messageCount: scene.payload.reactions.length,
        payload: scene.payload,
        timeline: scene.timeline,
      })),
    }) +
    ';';

  return applyTokens(shell, {
    __TITLE__: escapeHtml(model.title),
    __HEADING__: escapeHtml(model.heading),
    __SUBHEADING__: escapeHtml(model.subheading),
    __LOUNGE_CSS__: loungeCss,
    __DESKTOP_CSS__: desktopCss,
    __BOARD_ROWS__: renderBoardPane(model.rows),
    __DATA__: data,
    __RENDER_JS__: renderJs,
    __DESKTOP_JS__: desktopJs,
  });
}

/** Write the board to `outPath`, creating parent directories. */
export async function renderBoardHtml(
  outPath: string,
  opts: BuildBoardOptions = {},
): Promise<string> {
  const outDir = path.dirname(outPath);
  await mkdir(outDir, { recursive: true });
  // Headshots land in `<outDir>/headshots/` and are referenced relatively, so
  // the board must know where it is being written before the model is built.
  const html = await buildBoardHtml({ ...opts, assetDir: opts.assetDir ?? outDir });
  await writeFile(outPath, html, 'utf8');
  return outPath;
}

/**
 * Replace every placeholder in one pass over the shell.
 *
 * One pass matters: the embedded data assigns `window.__BOARD__`, and a second
 * scan would treat that as the board-rows placeholder. `split`/`join` is used
 * rather than `String.replace` so a `$&` inside inlined CSS or JS is never
 * read as a replacement pattern.
 */
function applyTokens(shell: string, tokens: Readonly<Record<string, string>>): string {
  const pattern = /__[A-Z0-9_]+__/g;
  let output = '';
  let cursor = 0;
  for (let match = pattern.exec(shell); match !== null; match = pattern.exec(shell)) {
    const token = match[0];
    const value = Object.hasOwn(tokens, token) ? tokens[token] : undefined;
    if (value === undefined) continue;
    output += shell.slice(cursor, match.index) + value;
    cursor = match.index + token.length;
  }
  return output + shell.slice(cursor);
}

/**
 * JSON that is safe to embed inside a `<script>` element: `</script>` can never
 * appear, and the two Unicode line terminators JSON allows but JavaScript does
 * not are escaped. Written as escapes, never as literal characters — a raw
 * U+2028 in a source file terminates the line it is on.
 */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function escapeHtml(value: string): string {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}
