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
import { adpFor, loadAdp, type AdpArtifact } from '../import/adp.js';
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
  /** The player's average draft position, or null when he is UNRANKED. */
  adp: number | null;
  /**
   * `adp - pickNo`. Positive is a reach (taken early), negative is a slide.
   * Null whenever `adp` is null — an unranked player has no delta, ever.
   */
  adpDelta: number | null;
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
  /** The ADP artifact. Pass `null` for a board that shows no ADP values. */
  adp?: AdpArtifact | null;
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

  const adp = opts.adp !== undefined ? opts.adp : await loadAdp();
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
  const headshots = await inlineHeadshots(
    [...speakerIds].filter((id) => id.length > 0),
    opts.headshotOptions,
  );

  const rows: BoardRow[] = picks.map((pick) => {
    const reaction = byEventId.get(pick.eventId);
    const value = adp ? adpFor(pick.playerId, adp) : null;
    return {
      eventId: pick.eventId,
      pickNo: pick.pickNo,
      round: pick.round ?? null,
      draftSlot: pick.draftSlot ?? null,
      playerName: pick.playerName,
      position: pick.position ?? null,
      nflTeam: pick.nflTeam ?? null,
      managerName: pick.managerName,
      adp: value,
      adpDelta: value === null ? null : Math.round(value) - pick.pickNo,
      anchorId: reaction ? anchorIdFor(pick.eventId) : null,
      exportCommand: reaction ? exportCommandFor(pick.pickNo, exportFormat) : null,
      generateCommand: generateCommandFor(pick.pickNo),
    };
  });

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
    scenes.push({
      eventId: reaction.eventId,
      anchorId: anchorIdFor(pick.eventId),
      pickNo: pick.pickNo,
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
async function inlineHeadshots(
  playerIds: readonly string[],
  opts: ResolveHeadshotsOptions | undefined,
): Promise<Record<string, string>> {
  const resolved = await resolveHeadshots(playerIds, opts ?? {});
  const inlined: Record<string, string> = {};
  const seen = new Map<string, string>();
  for (const [playerId, url] of Object.entries(resolved)) {
    if (!url.startsWith('file://')) continue;
    const cached = seen.get(url);
    if (cached !== undefined) {
      inlined[playerId] = cached;
      continue;
    }
    try {
      const bytes = await readFile(fileURLToPath(url));
      // Sleeper serves PNG bytes from a .jpg URL, so sniff rather than trust it.
      const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
      const uri = `data:image/${isPng ? 'png' : 'jpeg'};base64,${bytes.toString('base64')}`;
      seen.set(url, uri);
      inlined[playerId] = uri;
    } catch {
      // no headshot: the monogram avatar covers it
    }
  }
  return inlined;
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
    describeDelta(row),
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
    `<span class="cell-adp">${renderDelta(row)}</span>` +
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

/**
 * The ADP column. An unranked player gets the word "unranked", never a
 * fabricated number: `data/players/adp.json` holds 456 ranked players and
 * absence from it means the board genuinely does not know.
 */
function renderDelta(row: BoardRow): string {
  if (row.adp === null || row.adpDelta === null) {
    return '<span class="unranked">unranked</span>';
  }
  const delta = row.adpDelta;
  const kind = delta > 0 ? 'is-reach' : delta < 0 ? 'is-slide' : 'is-even';
  const sign = delta > 0 ? `+${delta}` : String(delta);
  return (
    `<span class="delta ${kind}" title="${escapeHtml(describeDelta(row) ?? '')}">${sign}</span>` +
    `<span class="adp-raw">ADP ${Math.round(row.adp)}</span>`
  );
}

/** Plain-language version of the delta, for tooltips and the selection dock. */
export function describeDelta(row: BoardRow): string | null {
  if (row.adp === null || row.adpDelta === null) return null;
  const delta = row.adpDelta;
  const adp = Math.round(row.adp);
  if (delta === 0) return `taken exactly at ADP ${adp}`;
  if (delta > 0) return `reached ${delta} picks early (ADP ${adp})`;
  return `fell ${Math.abs(delta)} picks past ADP ${adp}`;
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
  const html = await buildBoardHtml(opts);
  await mkdir(path.dirname(outPath), { recursive: true });
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
