/**
 * Lounge persistence.
 *
 * implementation_plan.md §11: append-only JSONL for chronological history,
 * small pretty-printed JSON for derived state.
 *
 *   data/lounge/reactions.jsonl  one row per Reaction, the Director's answer
 *   data/lounge/messages.jsonl   one row per Message, `seq` ascending forever
 *   data/lounge/state.json       lastProcessedPickNo, running jokes, tone
 *
 * IDEMPOTENCY IS A PRODUCT RULE (§14: "repeated processing of same pick creates
 * no duplicate event"). A slow-draft watcher re-reads the same picks constantly,
 * so `hasProcessed(eventId)` gates every write and `persistReaction` is the safe
 * entry point that does the check for you.
 */
import {
  loungeMessagesFile,
  loungeReactionsFile,
  loungeStateFile,
} from '../paths.js';
import type { LoungeMessage, LoungeState, Reaction } from '../types.js';
import { readJson, readJsonIfExists, writeJson } from '../util/json.js';
import { appendJsonl, readJsonl, readJsonlTail } from '../util/jsonl.js';

/** File overrides, so tests can point every function at a temp directory. */
export interface PersistOptions {
  reactionsFile?: string;
  messagesFile?: string;
  stateFile?: string;
  /** Injected clock, for deterministic `createdAt` values. */
  now?: () => Date;
}

/** A persisted Reaction row: the Reaction plus the metadata JSONL needs. */
export type ReactionRecord = Reaction & {
  createdAt: string;
  simulated: boolean;
};

/** The state every fresh install starts from. */
export const DEFAULT_STATE: LoungeState = {
  season: new Date().getUTCFullYear(),
  lastProcessedPickNo: 0,
  activeRunningJokes: [],
  activeRivalries: [],
  recentTone: 'neutral',
};

function reactionsPath(options: PersistOptions): string {
  return options.reactionsFile ?? loungeReactionsFile;
}
function messagesPath(options: PersistOptions): string {
  return options.messagesFile ?? loungeMessagesFile;
}
function statePath(options: PersistOptions): string {
  return options.stateFile ?? loungeStateFile;
}
function clock(options: PersistOptions): Date {
  return (options.now ?? (() => new Date()))();
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

/**
 * True when this Pick already has a Reaction on disk.
 *
 * Both logs are checked: a crash between the two appends must not let a Pick be
 * re-directed and produce a second, different Reaction.
 */
export async function hasProcessed(
  eventId: string,
  options: PersistOptions = {},
): Promise<boolean> {
  const reactions = await readJsonl<{ eventId?: string }>(reactionsPath(options));
  if (reactions.some((row) => row.eventId === eventId)) return true;
  const messages = await readJsonl<{ eventId?: string }>(messagesPath(options));
  return messages.some((row) => row.eventId === eventId);
}

// ---------------------------------------------------------------------------
// Appends
// ---------------------------------------------------------------------------

/** Append one Reaction to `reactions.jsonl`. */
export async function appendReaction(
  reaction: Reaction,
  options: PersistOptions & { simulated?: boolean } = {},
): Promise<ReactionRecord> {
  const record: ReactionRecord = {
    ...reaction,
    createdAt: clock(options).toISOString(),
    simulated: options.simulated === true,
  };
  await appendJsonl(reactionsPath(options), record);
  return record;
}

/**
 * Append a Reaction's Messages to `messages.jsonl` as `LoungeMessage` rows with
 * ascending `seq`, continuing from whatever the transcript already holds.
 */
export async function appendMessages(
  reaction: Reaction,
  options: PersistOptions & { simulated?: boolean } = {},
): Promise<LoungeMessage[]> {
  const file = messagesPath(options);
  const startSeq = (await lastSeq(file)) + 1;
  const createdAt = clock(options).toISOString();
  const rows: LoungeMessage[] = reaction.reactions.map((message, index) => ({
    eventId: reaction.eventId,
    seq: startSeq + index,
    speakerPlayerId: message.speakerPlayerId,
    speakerName: message.speakerName,
    text: message.text,
    reason: message.reason,
    ...(message.historyRefs && message.historyRefs.length > 0
      ? { historyRefs: message.historyRefs }
      : {}),
    createdAt,
    simulated: options.simulated === true,
  }));
  await appendJsonl(file, rows);
  return rows;
}

/** The highest `seq` currently in the transcript, or 0 when it is empty. */
export async function lastSeq(file: string = loungeMessagesFile): Promise<number> {
  const tail = await readJsonlTail<LoungeMessage>(file, 1);
  const last = tail[0];
  return typeof last?.seq === 'number' ? last.seq : 0;
}

/** The last `n` Lounge Messages, oldest first. */
export async function recentMessages(
  n: number,
  options: PersistOptions = {},
): Promise<LoungeMessage[]> {
  return readJsonlTail<LoungeMessage>(messagesPath(options), n);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Read `state.json`, falling back to `DEFAULT_STATE` when it does not exist. */
export async function loadState(options: PersistOptions = {}): Promise<LoungeState> {
  const file = statePath(options);
  const state = await readJsonIfExists<LoungeState>(file);
  return state ?? { ...DEFAULT_STATE };
}

/** Merge a patch into `state.json` and write it back, pretty-printed and sorted. */
export async function updateState(
  patch: Partial<LoungeState>,
  options: PersistOptions = {},
): Promise<LoungeState> {
  const file = statePath(options);
  const current = await loadState(options);
  const next: LoungeState = { ...current, ...patch };
  await writeJson(file, next);
  return next;
}

/** Read `state.json`, throwing if it is missing. For callers that require it. */
export async function requireState(options: PersistOptions = {}): Promise<LoungeState> {
  return readJson<LoungeState>(statePath(options));
}

// ---------------------------------------------------------------------------
// The safe entry point
// ---------------------------------------------------------------------------

export interface PersistReactionResult {
  /** False when the Pick had already been processed and nothing was written. */
  persisted: boolean;
  record?: ReactionRecord;
  messages?: LoungeMessage[];
  state?: LoungeState;
}

/**
 * Persist one Reaction exactly once: reaction row, message rows, then
 * `lastProcessedPickNo`. Re-running with the same `eventId` is a no-op, which is
 * the §14 duplicate-event rule.
 */
export async function persistReaction(
  reaction: Reaction,
  options: PersistOptions & { simulated?: boolean; pickNo?: number } = {},
): Promise<PersistReactionResult> {
  if (await hasProcessed(reaction.eventId, options)) {
    return { persisted: false };
  }
  const record = await appendReaction(reaction, options);
  const messages = await appendMessages(reaction, options);
  const pickNo = options.pickNo ?? reaction.pick.pickNo;
  const current = await loadState(options);
  const state =
    typeof pickNo === 'number' && pickNo > current.lastProcessedPickNo
      ? await updateState({ lastProcessedPickNo: pickNo }, options)
      : current;
  return { persisted: true, record, messages, state };
}
