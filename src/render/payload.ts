/**
 * Reaction -> template payload mapping.
 *
 * `templates/lounge.html` is a finished, self-contained render target with a
 * fixed payload contract (see the header comment in `templates/render.js`).
 * This module is the only place that knows how a domain `Reaction` plus the
 * recent Lounge transcript turn into that contract, so the renderer never has
 * to reason about domain types and the template never has to reason about the
 * domain at all.
 *
 * Two spec decisions are encoded here (docs/render_spec.md):
 * - "previous few Lounge messages dimmed above the fold" -> the last 2-4
 *   transcript Messages, oldest first, never including this Reaction's own.
 * - "optional team/position chip, but avoid visual clutter" -> a chip is only
 *   built when *both* the NFL team and the position are known, and only for the
 *   new reaction bubbles; the dimmed previous rows stay chip-free.
 */
import { loadConfig } from '../config.js';
import type { AppConfig, LoungeMessage, Reaction, ReactionMessage } from '../types.js';
import { resolveHeadshots, type ResolveHeadshotsOptions } from './headshots.js';

// ---------------------------------------------------------------------------
// The template contract
// ---------------------------------------------------------------------------

/** The condensed Pick the status card renders. */
export interface RenderPayloadPick {
  season?: number;
  pickNo: number;
  round?: number | null;
  playerId: string;
  playerName: string;
  managerName: string;
  /**
   * OPT-IN, board only. The chip the announcement card should key its team
   * colour and nameplate off, when that must not be the drafted player's own
   * reaction row. The exports never set it, so `render.js` falls back to the
   * subject's row chip exactly as it always has.
   */
  teamChip?: string;
}

/** A dimmed "previously in the Lounge" row. */
export interface RenderPayloadPreviousMessage {
  speakerPlayerId: string;
  speakerName: string;
  text: string;
  headshotUrl?: string;
  teamChip?: string;
}

/** A reaction bubble. `delayMs` drives the reveal timeline in `video.ts`. */
export interface RenderPayloadReaction extends RenderPayloadPreviousMessage {
  delayMs: number;
  /**
   * OPT-IN, board only. `HH:MM` beside the bubble. The exports never set it and
   * `render.js` renders nothing when it is absent, so a PNG or MP4 is byte-for-
   * byte what it was before timestamps existed.
   */
  timestamp?: string;
}

/** Exactly the object `window.LOUNGE.render()` / `.reset()` accept. */
export interface RenderPayload {
  pick: RenderPayloadPick;
  statusLine?: string;
  memberCount?: number;
  watermark?: string;
  previousMessages: RenderPayloadPreviousMessage[];
  reactions: RenderPayloadReaction[];
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** The subset of Sleeper player metadata the chip needs. */
export interface PlayerChipMeta {
  position?: string | null;
  nflTeam?: string | null;
}

export interface ToRenderPayloadOptions {
  /** Recent transcript Messages, oldest first. The tail becomes `previousMessages`. */
  recentMessages?: readonly LoungeMessage[];
  /** How many previous Messages to show. Clamped to the spec's 2..4 band. */
  previousMessageCount?: number;
  /** `playerId` -> local `file://` headshot, from `resolveHeadshots`. */
  headshots?: Readonly<Record<string, string>>;
  /** `playerId` -> team/position, for the optional chip. */
  playerMeta?: Readonly<Record<string, PlayerChipMeta>>;
  /** Loaded app config; `rendering.watermark` is read from it. */
  config?: Pick<AppConfig, 'rendering'>;
  /** Explicit watermark, overriding the config value. */
  watermark?: string;
  /** Overrides the status card's default "X selected Y" line. */
  statusLine?: string;
  /** Header subline count. Defaults to the template's distinct-speaker count. */
  memberCount?: number;
}

/** Spec band for the dimmed rows above the fold. */
export const MIN_PREVIOUS_MESSAGES = 2;
export const MAX_PREVIOUS_MESSAGES = 4;
const DEFAULT_PREVIOUS_MESSAGES = 3;

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/** Map a validated Reaction plus recent transcript Messages onto the template payload. */
export function toRenderPayload(
  reaction: Reaction,
  opts: ToRenderPayloadOptions = {},
): RenderPayload {
  const headshots = opts.headshots ?? {};
  const meta = opts.playerMeta ?? {};

  const payload: RenderPayload = {
    pick: {
      season: reaction.pick.season,
      pickNo: reaction.pick.pickNo,
      round: reaction.pick.round ?? null,
      playerId: reaction.pick.playerId,
      playerName: reaction.pick.playerName,
      managerName: reaction.pick.managerName,
    },
    previousMessages: selectPreviousMessages(reaction, opts).map((message) => {
      const row: RenderPayloadPreviousMessage = {
        speakerPlayerId: message.speakerPlayerId,
        speakerName: message.speakerName,
        text: message.text,
      };
      const shot = headshots[message.speakerPlayerId];
      if (shot) row.headshotUrl = shot;
      return row;
    }),
    reactions: reaction.reactions.map((message) => toReactionRow(message, headshots, meta)),
  };

  const watermark = opts.watermark ?? opts.config?.rendering.watermark;
  if (watermark) payload.watermark = watermark;
  if (opts.statusLine) payload.statusLine = opts.statusLine;
  if (opts.memberCount !== undefined) payload.memberCount = opts.memberCount;

  return payload;
}

function toReactionRow(
  message: ReactionMessage,
  headshots: Readonly<Record<string, string>>,
  meta: Readonly<Record<string, PlayerChipMeta>>,
): RenderPayloadReaction {
  const row: RenderPayloadReaction = {
    speakerPlayerId: message.speakerPlayerId,
    speakerName: message.speakerName,
    text: message.text,
    delayMs: message.delayMs,
  };
  const shot = headshots[message.speakerPlayerId];
  if (shot) row.headshotUrl = shot;
  const chip = buildTeamChip(meta[message.speakerPlayerId]);
  if (chip) row.teamChip = chip;
  return row;
}

/**
 * `"KC · TE"`, but only when both halves are known.
 * A half-empty chip is clutter without information, so it is omitted entirely.
 */
export function buildTeamChip(meta: PlayerChipMeta | undefined): string | undefined {
  const team = meta?.nflTeam?.trim();
  const position = meta?.position?.trim();
  if (!team || !position) return undefined;
  return `${team} · ${position}`;
}

/**
 * The tail of the transcript, oldest first. Messages belonging to this
 * Reaction's own `eventId` are dropped: when a Reaction is rendered after it has
 * already been persisted, its own bubbles would otherwise appear twice.
 */
export function selectPreviousMessages(
  reaction: Reaction,
  opts: ToRenderPayloadOptions = {},
): LoungeMessage[] {
  const requested = opts.previousMessageCount ?? DEFAULT_PREVIOUS_MESSAGES;
  const count = Math.min(
    MAX_PREVIOUS_MESSAGES,
    Math.max(MIN_PREVIOUS_MESSAGES, Math.trunc(requested)),
  );
  const history = (opts.recentMessages ?? []).filter(
    (message) => message.eventId !== reaction.eventId,
  );
  return history.slice(-count);
}

/** Every distinct Speaker id in a payload — the ids whose headshots are worth fetching. */
export function speakerIdsFor(
  reaction: Reaction,
  opts: ToRenderPayloadOptions = {},
): string[] {
  const ids = new Set<string>();
  for (const message of selectPreviousMessages(reaction, opts)) {
    ids.add(message.speakerPlayerId);
  }
  for (const message of reaction.reactions) ids.add(message.speakerPlayerId);
  ids.add(reaction.pick.playerId);
  return [...ids].filter((id) => id.length > 0);
}

// ---------------------------------------------------------------------------
// The one impure convenience wrapper
// ---------------------------------------------------------------------------

export interface PreparePayloadOptions extends ToRenderPayloadOptions {
  /** A ready-made payload, bypassing all mapping and headshot resolution. */
  payload?: RenderPayload;
  /** Passed through to `resolveHeadshots` (cache dir, injected fetch, env). */
  headshotOptions?: ResolveHeadshotsOptions;
}

/**
 * `toRenderPayload` with the two ambient lookups filled in: the app config (for
 * the watermark) and the headshot cache. Both degrade to their absent form, so
 * this never fails for reasons the render can survive.
 */
export async function preparePayload(
  reaction: Reaction,
  opts: PreparePayloadOptions = {},
): Promise<RenderPayload> {
  if (opts.payload) return opts.payload;

  const config =
    opts.config ?? (opts.watermark ? undefined : await loadConfig().catch(() => undefined));
  const headshots =
    opts.headshots ?? (await resolveHeadshots(speakerIdsFor(reaction, opts), opts.headshotOptions));

  const resolved: ToRenderPayloadOptions = { ...opts, headshots };
  if (config) resolved.config = config;
  return toRenderPayload(reaction, resolved);
}
