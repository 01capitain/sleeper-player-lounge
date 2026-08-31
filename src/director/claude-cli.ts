/**
 * The Director: a `claude -p` subprocess (ADR 0001).
 *
 * ISOLATION IS LOAD-BEARING. ADR 0001 fixes a flag set that makes the Director
 * a closed box: `--tools ""` denies it the filesystem and the network, and
 * `--setting-sources ""`, `--disable-slash-commands` and `--strict-mcp-config`
 * keep the operator's personal settings, skills, hooks and MCP servers out of
 * the prompt. `--no-session-persistence` keeps draft runs out of session
 * history. A Director whose dialogue depends on whose machine it ran on is not
 * reproducible, so `REQUIRED_CLI_FLAGS` is asserted in tests against the argv a
 * fake spawn sees. `--bare` must never be added: it forces `ANTHROPIC_API_KEY`
 * auth and never reads OAuth or the keychain, which defeats the no-API-key
 * property the whole design rests on.
 *
 * Schema enforcement at the model boundary is NOT validation. `--json-schema`
 * does not reliably enforce `maxItems: 6` or `maxLength: 280`, so every answer
 * goes through `validateReaction` plus the §14 product rules before it is
 * returned. Invalid answers are retried exactly once; a second failure writes a
 * record to `data/lounge/failed.jsonl` and throws, so message history is never
 * corrupted (implementation_plan.md §10).
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { loungeDir, reactionSchemaFile, repoRoot } from '../paths.js';
import type {
  LoungeContext,
  LoungeDirector,
  Reaction,
  ReactionRulesConfig,
  StarPlayer,
} from '../types.js';
import { appendJsonl } from '../util/jsonl.js';
import { log } from '../util/log.js';
import { validateReaction } from '../validate.js';
import type { BuiltContext, OffTheBoardRef } from '../context/builder.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Paths and flags
// ---------------------------------------------------------------------------

/** `prompts/director.system.md` — the actual runtime system prompt. */
export const directorSystemPromptFile = path.join(repoRoot, 'prompts', 'director.system.md');

/** Where a Reaction that failed validation twice is recorded. */
export const failedEventsFile = path.join(loungeDir, 'failed.jsonl');

/**
 * The default model. Overridable via config / `LOUNGE_DIRECTOR_MODEL`.
 *
 * Dialogue quality is the whole product here, so the Director gets the strongest
 * model. Measured on the same cast: haiku averaged 60 characters a line against
 * sonnet's 85, leaned on the same "Manager knows what he's doing" construction in
 * 4 of 17 lines, and dropped the recurring personas almost entirely — Kelce's
 * Taylor references disappeared. It was also no faster in practice.
 */
export const DEFAULT_DIRECTOR_MODEL = 'opus';

/**
 * Every flag ADR 0001 requires. Tests assert each of these appears in the argv
 * handed to the spawn function — this array is the isolation guard.
 */
export const REQUIRED_CLI_FLAGS = [
  '-p',
  '--model',
  '--tools',
  '--output-format',
  '--no-session-persistence',
  '--disable-slash-commands',
  '--strict-mcp-config',
  '--setting-sources',
  '--system-prompt-file',
  '--json-schema',
] as const;

// ---------------------------------------------------------------------------
// Spawn seam
// ---------------------------------------------------------------------------

export interface DirectorSpawnResult {
  stdout: string;
  stderr?: string;
}

export interface DirectorSpawnOptions {
  timeoutMs: number;
  cwd: string;
  maxBuffer: number;
}

/**
 * Injected so tests never touch the real binary — spawning `claude` needs the
 * network and produces different dialogue every run. Always `execFile`-shaped:
 * a program plus an argv array, never a shell string.
 */
export type DirectorSpawn = (
  file: string,
  args: readonly string[],
  options: DirectorSpawnOptions,
) => Promise<DirectorSpawnResult>;

const defaultSpawn: DirectorSpawn = async (file, args, options) => {
  const pending = execFileAsync(file, [...args], {
    timeout: options.timeoutMs,
    cwd: options.cwd,
    maxBuffer: options.maxBuffer,
    encoding: 'utf8',
  });
  // The prompt travels in argv, so there is nothing to send on stdin. Leaving it
  // open makes the CLI wait three seconds for input that never arrives, on every
  // single pick. `execFile` has no stdio option, so close the pipe by hand.
  pending.child.stdin?.end();
  const { stdout, stderr } = await pending;
  return { stdout, stderr };
};

/**
 * The Reaction schema as `--json-schema` will accept it.
 *
 * `schemas/reaction.schema.json` declares `"$schema": ".../draft/2020-12/schema"`
 * for our own ajv validation, but the CLI's structured-output validator cannot
 * resolve that meta-schema ref and rejects the whole thing:
 *   `--json-schema is not a valid JSON Schema: no schema with key or ref ...`
 * `$schema` is metadata about the schema rather than a constraint on the value,
 * so dropping it changes nothing we enforce — and every constraint is re-checked
 * locally by `validateReaction` regardless. `title` is kept: it is harmless and
 * names the structured output in the CLI's own error messages.
 */
export function structuredOutputSchema(schemaFile: string): string {
  const parsed: Record<string, unknown> = JSON.parse(readFileSync(schemaFile, 'utf8'));
  delete parsed['$schema'];
  return JSON.stringify(parsed);
}

// ---------------------------------------------------------------------------
// Errors and telemetry
// ---------------------------------------------------------------------------

/** Thrown after the single retry has also failed. The failed record is on disk. */
export class DirectorFailureError extends Error {
  readonly eventId: string;
  readonly attempts: number;
  readonly violations: string[];

  constructor(eventId: string, attempts: number, violations: string[]) {
    super(
      `Director failed for ${eventId} after ${attempts} attempt${attempts === 1 ? '' : 's'}:\n${violations
        .map((violation) => `  - ${violation}`)
        .join('\n')}`,
    );
    this.name = 'DirectorFailureError';
    this.eventId = eventId;
    this.attempts = attempts;
    this.violations = violations;
  }
}

/** The failed-event record appended to `data/lounge/failed.jsonl`. */
export interface FailedEventRecord {
  eventId: string;
  pickNo: number;
  playerName: string;
  managerName: string;
  failedAt: string;
  attempts: number;
  model: string;
  violations: string[];
  /** First 4000 chars of the last raw CLI stdout, for post-mortems. */
  rawOutput?: string;
}

// ---------------------------------------------------------------------------
// The Director
// ---------------------------------------------------------------------------

export interface ClaudeCliDirectorOptions {
  model?: string;
  /** The binary to run. Default `claude`. */
  cliPath?: string;
  systemPromptFile?: string;
  schemaFile?: string;
  failedEventsFile?: string;
  /** Injected in tests. Defaults to `execFile`. */
  spawn?: DirectorSpawn;
  timeoutMs?: number;
  maxBuffer?: number;
  rules?: Partial<ReactionRulesConfig>;
  now?: () => Date;
}

const DEFAULT_RULES: Pick<
  ReactionRulesConfig,
  | 'minMessages'
  | 'maxMessages'
  | 'draftedPlayerMustReact'
  | 'maxHistoryMessages'
  | 'maxChampionshipMessages'
  | 'allowHistoryInOpeningMessage'
> = {
  minMessages: 2,
  maxMessages: 6,
  draftedPlayerMustReact: true,
  maxHistoryMessages: 2,
  maxChampionshipMessages: 1,
  allowHistoryInOpeningMessage: false,
};

export class ClaudeCliDirector implements LoungeDirector {
  private readonly model: string;
  private readonly cliPath: string;
  private readonly systemPromptFile: string;
  private readonly schemaFile: string;
  private readonly failedFile: string;
  private readonly spawn: DirectorSpawn;
  private readonly timeoutMs: number;
  private readonly maxBuffer: number;
  private readonly rules: Partial<ReactionRulesConfig>;
  private readonly now: () => Date;

  constructor(options: ClaudeCliDirectorOptions = {}) {
    this.model = options.model ?? process.env['LOUNGE_DIRECTOR_MODEL']?.trim() ?? DEFAULT_DIRECTOR_MODEL;
    this.cliPath = options.cliPath ?? 'claude';
    this.systemPromptFile = options.systemPromptFile ?? directorSystemPromptFile;
    this.schemaFile = options.schemaFile ?? reactionSchemaFile;
    this.failedFile = options.failedEventsFile ?? failedEventsFile;
    this.spawn = options.spawn ?? defaultSpawn;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.maxBuffer = options.maxBuffer ?? 8 * 1024 * 1024;
    this.rules = options.rules ?? {};
    this.now = options.now ?? (() => new Date());
  }

  /** The exact argv handed to `execFile`. Exposed so `--dry-run` can print it. */
  buildArgs(userPrompt: string): string[] {
    const schemaJson = structuredOutputSchema(this.schemaFile);
    return [
      '-p',
      userPrompt,
      '--model',
      this.model,
      '--tools',
      '',
      '--output-format',
      'json',
      '--no-session-persistence',
      '--disable-slash-commands',
      '--strict-mcp-config',
      '--setting-sources',
      '',
      '--system-prompt-file',
      this.systemPromptFile,
      '--json-schema',
      schemaJson,
    ];
  }

  /** The system + user prompt pair, without spawning anything. */
  buildPrompt(context: LoungeContext): { system: string; user: string } {
    return buildPrompt(context, {
      systemPromptFile: this.systemPromptFile,
      rules: { ...DEFAULT_RULES, ...this.rules },
    });
  }

  /**
   * Turn a Context into a validated Reaction.
   *
   * Attempt 1, then exactly one retry with the violations fed back. A second
   * failure writes to `failed.jsonl` and throws — nothing is ever persisted from
   * an answer that did not validate.
   */
  async generateReaction(context: LoungeContext): Promise<Reaction> {
    const basePrompt = renderUserPrompt(context, { ...DEFAULT_RULES, ...this.rules });
    const violations: string[] = [];
    let rawOutput: string | undefined;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const userPrompt =
        attempt === 1 ? basePrompt : `${basePrompt}\n${retryAddendum(violations)}`;
      try {
        const { stdout } = await this.spawn(this.cliPath, this.buildArgs(userPrompt), {
          timeoutMs: this.timeoutMs,
          cwd: repoRoot,
          maxBuffer: this.maxBuffer,
        });
        rawOutput = stdout;
        const envelope = parseEnvelope(stdout);
        log.debug(
          `director: ${context.pick.eventId} attempt ${attempt} duration=${
            envelope.durationMs ?? '?'
          }ms`,
        );

        const candidate = repairEnvelopeShape(envelope.structuredOutput, context);
        // Local validation is mandatory: the model boundary does not enforce
        // `maxItems: 6` or `maxLength: 280` (ADR 0001).
        const reaction = validateReaction(candidate);
        const productViolations = productRuleViolations(reaction, context, {
          ...DEFAULT_RULES,
          ...this.rules,
        });
        if (productViolations.length > 0) {
          throw new Error(productViolations.join('; '));
        }
        return reaction;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        violations.push(`attempt ${attempt}: ${message}`);
        log.warn(`director: ${context.pick.eventId} attempt ${attempt} rejected — ${message}`);
      }
    }

    const record: FailedEventRecord = {
      eventId: context.pick.eventId,
      pickNo: context.pick.pickNo,
      playerName: context.pick.playerName,
      managerName: context.pick.managerName,
      failedAt: this.now().toISOString(),
      attempts: 2,
      model: this.model,
      violations,
      ...(rawOutput !== undefined ? { rawOutput: rawOutput.slice(0, 4000) } : {}),
    };
    await appendJsonl(this.failedFile, record);
    throw new DirectorFailureError(context.pick.eventId, 2, violations);
  }
}

/** Convenience factory, so callers do not import the class directly. */
export function createClaudeCliDirector(
  options: ClaudeCliDirectorOptions = {},
): ClaudeCliDirector {
  return new ClaudeCliDirector(options);
}

// ---------------------------------------------------------------------------
// The CLI JSON envelope
// ---------------------------------------------------------------------------

export interface DirectorEnvelope {
  structuredOutput: unknown;
  durationMs?: number;
  isError?: boolean;
}

/**
 * Read `structured_output` out of the CLI's JSON envelope, surfacing
 * `duration_ms` for logging. Falls back to parsing the `result` text as JSON,
 * then to the whole payload, so an envelope shape change degrades into the
 * normal retry path rather than an unhandled crash.
 */
export function parseEnvelope(stdout: string): DirectorEnvelope {
  const trimmed = stdout.trim();
  if (trimmed === '') throw new Error('claude CLI returned empty stdout');
  let payload: unknown;
  try {
    payload = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(
      `claude CLI returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('claude CLI envelope was not a JSON object');
  }
  const record = payload as Record<string, unknown>;
  const envelope: DirectorEnvelope = { structuredOutput: undefined };

  if (typeof record['duration_ms'] === 'number') {
    envelope.durationMs = record['duration_ms'];
  }
  if (record['is_error'] === true) {
    envelope.isError = true;
    throw new Error(
      `claude CLI reported an error: ${String(record['result'] ?? record['subtype'] ?? 'unknown')}`,
    );
  }

  if (record['structured_output'] !== undefined && record['structured_output'] !== null) {
    envelope.structuredOutput = record['structured_output'];
    return envelope;
  }
  const result = record['result'];
  if (typeof result === 'string') {
    envelope.structuredOutput = JSON.parse(stripCodeFence(result));
    return envelope;
  }
  if (typeof result === 'object' && result !== null) {
    envelope.structuredOutput = result;
    return envelope;
  }
  // Not an envelope at all — perhaps a bare Reaction.
  envelope.structuredOutput = payload;
  return envelope;
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
}

/**
 * The `eventId` and the echoed `pick` are ours, not the Director's creative
 * output, so they are filled in from the Context rather than being a reason to
 * burn a retry. The Messages are never touched.
 */
function repairEnvelopeShape(value: unknown, context: LoungeContext): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const record = { ...(value as Record<string, unknown>) };
  record['eventId'] = context.pick.eventId;
  const pick = typeof record['pick'] === 'object' && record['pick'] !== null
    ? (record['pick'] as Record<string, unknown>)
    : {};
  record['pick'] = {
    ...pick,
    season: context.pick.season,
    pickNo: context.pick.pickNo,
    round: context.pick.round ?? null,
    playerId: context.pick.playerId,
    playerName: context.pick.playerName,
    managerName: context.pick.managerName,
  };
  return record;
}

// ---------------------------------------------------------------------------
// Product rules (§14) — violations are treated as invalid and trigger the retry
// ---------------------------------------------------------------------------

/**
 * Check the rules the JSON schema cannot express:
 *  - the drafted player must appear as a Speaker;
 *  - at most `maxMessages` (6) Messages, at least `minMessages`;
 *  - every Speaker must be someone present in the Context.
 */
export function productRuleViolations(
  reaction: Reaction,
  context: LoungeContext,
  rules: Partial<ReactionRulesConfig> = {},
): string[] {
  const merged = { ...DEFAULT_RULES, ...rules };
  const violations: string[] = [];
  const messages = reaction.reactions ?? [];

  if (messages.length > merged.maxMessages) {
    violations.push(`${messages.length} messages exceeds the maximum of ${merged.maxMessages}`);
  }
  if (messages.length < merged.minMessages) {
    violations.push(`${messages.length} messages is below the minimum of ${merged.minMessages}`);
  }

  if (merged.draftedPlayerMustReact !== false) {
    const spoke = messages.some(
      (message) =>
        message.speakerPlayerId === context.pick.playerId ||
        normalize(message.speakerName) === normalize(context.pick.playerName),
    );
    if (!spoke) {
      violations.push(
        `the drafted player ${context.pick.playerName} does not speak; he must send at least one message`,
      );
    }
  }

  const allowed = allowedSpeakers(context);
  for (const message of messages) {
    const known =
      allowed.ids.has(message.speakerPlayerId) || allowed.names.has(normalize(message.speakerName));
    if (!known) {
      violations.push(
        `"${message.speakerName}" (${message.speakerPlayerId}) is not present in the context and may not speak`,
      );
      continue;
    }

    // The id and the name must describe the SAME player. Accepting "known id OR
    // known name" let the Director pair one player's name with another's id —
    // observed in the wild as `speakerName: "Justin Jefferson"` carrying Travis
    // Kelce's id 1466. Everything downstream keys on the id, so the scene then
    // renders Kelce's headshot and KC/TE chip above Jefferson's name.
    const expected = allowed.nameById.get(message.speakerPlayerId);
    if (expected !== undefined && expected !== normalize(message.speakerName)) {
      violations.push(
        `"${message.speakerName}" was given the player id ${message.speakerPlayerId}, ` +
          `which belongs to a different player in this Context — ids and names must match`,
      );
    }
  }

  if (reaction.eventId !== context.pick.eventId) {
    violations.push(`eventId "${reaction.eventId}" does not match the pick "${context.pick.eventId}"`);
  }

  // The Season Literal rule. A message that leans on Fantasy Memory must name
  // the season as a four-digit year, so managers know which one is meant —
  // "You had me in 2025" is legible, "back together again" is not.
  //
  // Measured over 36 real Reactions, 42 of 43 history lines named their season
  // unprompted. The exception ("New team, new manager, new me.") is exactly the
  // vague form the rule exists to forbid, so it is enforced here rather than
  // left to the prompt.
  for (const message of messages) {
    if (leansOnHistory(message) && !SEASON_LITERAL.test(message.text)) {
      violations.push(
        `"${message.speakerName}" refers to fantasy history without naming the season: ` +
          `"${message.text}" — any history reference must state the four-digit year`,
      );
    }
  }

  // The Fantasy Memory ration. Fantasy Memory is the only section of the Context
  // that is populated for every single Pick, so left uncapped it becomes the
  // default angle: measured over live picks 13-18, the drafted player opened
  // with his own 2025 roster and verdict in six of six, and the room answered in
  // kind — a rut the Director itself noticed ("third straight guy confessing his
  // 2025 in the group chat"). Prose asking for restraint did not hold, so the
  // ration is enforced here, where a breach costs a retry.
  const historyMessages = messages.filter((message) => leansOnHistory(message));
  const maxHistory = merged.maxHistoryMessages ?? 2;
  if (historyMessages.length > maxHistory) {
    violations.push(
      `${historyMessages.length} messages lean on fantasy history; at most ${maxHistory} may. ` +
        'Keep the sharpest one and put the rest on this pick, this draft or these players',
    );
  }

  const championshipMessages = messages.filter((message) => leansOnChampionship(message));
  const maxChampionship = merged.maxChampionshipMessages ?? 1;
  if (championshipMessages.length > maxChampionship) {
    violations.push(
      `${championshipMessages.length} messages mention a championship roster; at most ` +
        `${maxChampionship} may. A ring is background, not material`,
    );
  }

  const opener = messages[0];
  if (
    merged.allowHistoryInOpeningMessage !== true &&
    opener !== undefined &&
    leansOnHistory(opener)
  ) {
    violations.push(
      `the opening message ("${opener.speakerName}: ${opener.text}") leans on fantasy history; ` +
        'the first line answers the pick that just happened. Move the history line later',
    );
  }

  return violations;
}

/**
 * True when a Message draws on Fantasy Memory.
 *
 * Keyed on the structured fields only — `historyRefs` and `reason` — never on
 * the prose. Matching text would flag a line that merely says "2026".
 */
function leansOnHistory(message: Reaction['reactions'][number]): boolean {
  return (
    (message.historyRefs?.length ?? 0) > 0 ||
    message.reason === 'fantasy_2025_history' ||
    message.reason === 'championship_history'
  );
}

/** True when a Message draws specifically on a championship roster. */
function leansOnChampionship(message: Reaction['reactions'][number]): boolean {
  if (message.reason === 'championship_history') return true;
  return (message.historyRefs ?? []).some((ref) => /champion|title/i.test(ref));
}

/** A four-digit season, e.g. `2025`. */
const SEASON_LITERAL = /\b(?:19|20)\d{2}\b/;

/** Everyone the Context admits to the room, by id and by normalized name. */
export function allowedSpeakers(context: LoungeContext): {
  ids: Set<string>;
  names: Set<string>;
  /** playerId -> the name the Context knows him by, for pair consistency. */
  nameById: Map<string, string>;
} {
  const ids = new Set<string>();
  const names = new Set<string>();
  const nameById = new Map<string, string>();
  const add = (id: string | undefined, name: string | undefined): void => {
    if (id) ids.add(id);
    if (name) names.add(normalize(name));
    if (id && name && !nameById.has(id)) nameById.set(id, normalize(name));
  };

  add(context.pick.playerId, context.pick.playerName);
  for (const mate of context.nflTeammates ?? []) add(mate.playerId, mate.name);
  for (const star of context.regulars ?? []) add(`star:${star.key}`, star.name);
  for (const playerId of Object.keys(context.speakerHistories ?? {})) add(playerId, undefined);
  for (const actor of actorsOf(context)) add(actor.playerId, actor.name);

  return { ids, names, nameById };
}

function actorsOf(context: LoungeContext): { playerId: string; name: string }[] {
  const extras = context as Partial<BuiltContext>;
  return extras.actors ?? [];
}

function normalize(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '');
}

function retryAddendum(violations: string[]): string {
  return [
    '',
    '## Your previous answer was rejected',
    ...violations.map((violation) => `- ${violation}`),
    '',
    'Fix exactly those problems and return the corrected JSON. Do not add new speakers.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Prompt construction — the actual creative input
// ---------------------------------------------------------------------------

export interface BuildPromptOptions {
  systemPromptFile?: string;
  /** The reaction rules the user prompt states as limits. Defaults apply. */
  rules?: Partial<ReactionRulesConfig>;
}

/**
 * The `--dry-run` path: the exact system and user prompts, with no subprocess.
 */
export function buildPrompt(
  context: LoungeContext,
  options: BuildPromptOptions = {},
): { system: string; user: string } {
  const systemFile = options.systemPromptFile ?? directorSystemPromptFile;
  return {
    system: readFileSync(systemFile, 'utf8'),
    user: renderUserPrompt(context, options.rules),
  };
}

/**
 * Serialize a Context into the user prompt.
 *
 * Every section is written so the Director can tell *presence* from *absence*:
 * a heading with nothing under it says so in words ("no fantasy memory exists
 * for anyone in this room"), because the Fantasy Memory rules turn on exactly
 * that distinction. What is absent from the Context cannot be said.
 */
export function renderUserPrompt(
  context: LoungeContext,
  rules: Partial<ReactionRulesConfig> = {},
): string {
  const pick = context.pick;
  const extras = context as Partial<BuiltContext>;
  const merged = { ...DEFAULT_RULES, ...rules };
  const lines: string[] = [];

  // --- the pick -------------------------------------------------------------
  lines.push(`# The pick`);
  lines.push('');
  lines.push(
    `Pick ${pick.pickNo}${pick.round != null ? `, round ${pick.round}` : ''} of the ${pick.season} draft.`,
  );
  lines.push(`${pick.managerName} drafts ${pick.playerName}${describePlayer(pick.position, pick.nflTeam)}.`);
  lines.push('');

  // --- manager roster -------------------------------------------------------
  lines.push(`## ${pick.managerName}'s roster so far`);
  lines.push('');
  const roster = context.manager?.roster ?? [];
  if (roster.length === 0) {
    lines.push(`Nobody yet — ${pick.playerName} is ${pick.managerName}'s first pick of this draft.`);
  } else {
    // Positions matter here: they are how a roster-mate can see whether the new
    // pick strengthens his fantasy team or takes his starting spot.
    const detail = new Map(
      (extras.managerRosterDetail ?? []).map((ref) => [ref.name, ref] as const),
    );
    const inRoom = new Set((extras.actors ?? []).map((actor) => actor.name));
    roster.forEach((name, index) => {
      const ref = detail.get(name);
      const marker = inRoom.has(name) ? ' — in the Lounge for this pick' : '';
      lines.push(`${index + 1}. ${name}${describePlayer(ref?.position, ref?.nflTeam)}${marker}`);
    });
    lines.push('');
    lines.push(
      `${pick.playerName} joins that roster. Anyone already on it has a stake in this pick: it either strengthens the team he plays for or lines up against him for a starting spot.`,
    );
  }
  lines.push('');

  // --- the room -------------------------------------------------------------
  lines.push('## Who is in the Lounge for this pick');
  lines.push('');
  lines.push(
    'These are the only players who exist right now. Any speaker you use must come from this list.',
  );
  lines.push('');
  lines.push(...renderRoom(context));
  lines.push('');

  // --- fantasy memory -------------------------------------------------------
  lines.push('## Fantasy memory available for this pick');
  lines.push('');
  const memory = renderMemory(context);
  if (memory.length === 0) {
    lines.push(
      'None. Nobody in this room has any fantasy history you may use. Do not reference past seasons, past rosters, championships or "last time" in any form.',
    );
  } else {
    lines.push(
      'These facts, and only these facts, exist. Anyone not listed here has no fantasy history at all — say nothing about their past.',
    );
    lines.push('');
    lines.push(...memory);
    lines.push('');
    lines.push(
      'Any message built on one of these facts must state the season as a four-digit year.',
    );
    lines.push('');
    lines.push(
      'FANTASY MEMORY IS RATIONED. It is the one thing every pick has, which is exactly why it cannot carry the reaction — a whole round of players reciting their 2025 roster and their verdict on it reads like a queue at a confessional. This pick, this draft and these players come first; the past is a callback, not the subject.',
    );
    const maxHistory = merged.maxHistoryMessages ?? 2;
    const maxChampionship = merged.maxChampionshipMessages ?? 1;
    lines.push('');
    lines.push(
      `- At most ${maxHistory} message${maxHistory === 1 ? '' : 's'} in this reaction may lean on a fact from the list above. The rest must be about this pick, this draft, this roster or these players.`,
    );
    if (merged.allowHistoryInOpeningMessage !== true) {
      lines.push(
        '- The opening message may not lean on one at all. The first line answers what just happened.',
      );
    }
    lines.push(
      `- At most ${maxChampionship} of them may mention a championship roster. A ring is the oldest and flattest fact here; reach for it only when it is genuinely the sharpest angle in the room.`,
    );
    lines.push(
      '- A message that leans on the list must set `historyRefs` to the facts it used. That is how the ration is counted, so an unlabelled history line is a rejected reaction.',
    );
  }
  lines.push('');

  // --- draft signals --------------------------------------------------------
  lines.push('## What is happening in the draft');
  lines.push('');
  // A plain fact, not a signal: where he sits in the queue at his own position.
  // Kept out of `renderSignals` so an ordinary pick still reads as ordinary.
  const positionIndex = extras.signalDetail?.positionDraftIndex;
  if (positionIndex !== undefined && pick.position) {
    lines.push(
      `He is the ${ordinal(positionIndex)} ${pick.position} taken in this draft.`,
    );
    lines.push('');
  }
  const signals = renderSignals(context);
  if (signals.length === 0) {
    lines.push(
      'Nothing unusual — no run, no stack, no notable reach or fall. This is an ordinary pick, and the Lounge still reacts to it.',
    );
  } else {
    lines.push(...signals);
  }
  lines.push('');

  // --- running jokes --------------------------------------------------------
  const jokes = context.runningJokes ?? [];
  lines.push('## Running jokes currently alive in the Lounge');
  lines.push('');
  if (jokes.length === 0) {
    lines.push('None active.');
  } else {
    for (const joke of jokes) {
      const participants = joke.participants.join(', ');
      lines.push(
        `- ${joke.topic} (strength ${joke.strength.toFixed(2)}${
          joke.persistent === true ? ', persistent league lore' : ''
        }${participants ? `; about: ${participants}` : ''})`,
      );
    }
  }
  lines.push('');

  // --- transcript -----------------------------------------------------------
  const recent = context.recentMessages ?? [];
  lines.push('## The last messages in the Lounge');
  lines.push('');
  if (recent.length === 0) {
    lines.push('The Lounge has not said anything yet. This is the first reaction of the draft.');
  } else {
    lines.push('Oldest first. Continue this rhythm; do not repeat a joke that just landed.');
    lines.push('');
    for (const message of recent) {
      lines.push(`${message.speakerName}: ${message.text}`);
    }
  }
  lines.push('');

  // --- the ask --------------------------------------------------------------
  lines.push('## Write the reaction');
  lines.push('');
  lines.push(`- ${pick.playerName} must send at least one message.`);
  lines.push(
    `- ${merged.minMessages} to ${merged.maxMessages} messages total. Fewer and sharper beats six forced jokes.`,
  );
  if ((extras.actors ?? []).length > 0 || (context.regulars ?? []).length > 0) {
    lines.push(
      `- At most ${merged.maxHistoryMessages ?? 2} of them may lean on fantasy history${
        merged.allowHistoryInOpeningMessage !== true ? ', and the first one may not' : ''
      }.`,
    );
  }
  lines.push('- Pick one or two angles from above. A reaction that hits all of them reads like a list.');
  lines.push('- Only the players listed under "Who is in the Lounge" may speak. Managers never speak.');
  lines.push(`- Use exactly this eventId: ${pick.eventId}`);
  lines.push('');
  lines.push('Return JSON only, matching the required schema.');

  return lines.join('\n');
}

function renderRoom(context: LoungeContext): string[] {
  const extras = context as Partial<BuiltContext>;
  const out: string[] = [];
  const seen = new Set<string>();
  // Anyone in the room who is already off the board. A Regular keeps his ambient
  // seat after he is drafted — but his profile still tells him to be annoyed
  // when players at his position go ahead of him, and without this fact nothing
  // contradicts it. CeeDee Lamb spent picks 13 to 18 of the live draft playing
  // the overlooked man six picks after he was taken.
  const offTheBoard = new Map<string, OffTheBoardRef>();
  for (const ref of extras.offTheBoard ?? []) {
    offTheBoard.set(ref.playerId, ref);
    offTheBoard.set(normalize(ref.name), ref);
  }

  const emit = (
    name: string,
    playerId: string,
    position: string | null | undefined,
    nflTeam: string | null | undefined,
    headline: string,
    star: StarPlayer | undefined,
    reasons: string[],
  ): void => {
    if (seen.has(playerId)) return;
    seen.add(playerId);
    out.push(`### ${name}${describePlayer(position, nflTeam)} — id \`${playerId}\``);
    out.push(headline);
    const taken = offTheBoard.get(playerId) ?? offTheBoard.get(normalize(name));
    if (taken && playerId !== context.pick.playerId) {
      out.push(
        `ALREADY DRAFTED — he went at pick ${taken.pickNo} to ${taken.managerName}. ` +
          'He is on a roster, so he is not waiting for his name and cannot be passed over. ' +
          'He watches this pick as an owner of his own situation, not as a man still on the board.',
      );
    }
    if (star) {
      if (star.voice.length > 0) out.push(`Voice: ${star.voice.join(', ')}.`);
      for (const hook of star.hooks) out.push(`- ${hook}`);
      for (const lore of star.leagueLore ?? []) out.push(`- League lore: ${lore}`);
      for (const guardrail of star.guardrails ?? []) out.push(`- Must: ${guardrail}`);
    }
    // Drop reasons that merely restate the headline, so the block stays short.
    const headlineKey = reasonKey(headline);
    const extraReasons = reasons.filter((reason) => !headlineKey.includes(reasonKey(reason)));
    if (extraReasons.length > 0) out.push(`In the room because: ${extraReasons.join('; ')}.`);
    out.push('');
  };

  if (extras.actors && extras.actors.length > 0) {
    for (const actor of extras.actors) {
      emit(
        actor.name,
        actor.playerId,
        actor.position,
        actor.nflTeam,
        actor.mandatory
          ? 'THE DRAFTED PLAYER. He must send at least one message.'
          : headlineForRole(actor.role, context.pick.playerName, context.pick.managerName),
        actor.star,
        // The mandatory reason is already the headline; keep the rest.
        actor.mandatory
          ? actor.reasons.filter((reason) => !reason.startsWith('the drafted player'))
          : actor.reasons,
      );
    }
    return out;
  }

  // Plain `LoungeContext` (no builder extras) — still fully renderable.
  emit(
    context.pick.playerName,
    context.pick.playerId,
    context.pick.position,
    context.pick.nflTeam,
    'THE DRAFTED PLAYER. He must send at least one message.',
    undefined,
    [],
  );
  for (const mate of context.nflTeammates ?? []) {
    emit(
      mate.name,
      mate.playerId,
      mate.position,
      mate.nflTeam,
      `Current NFL teammate of ${context.pick.playerName}.`,
      undefined,
      [],
    );
  }
  for (const star of context.regulars ?? []) {
    emit(
      star.name,
      `star:${star.key}`,
      star.position,
      null,
      'Lounge regular. He is here for every pick, whether or not this one concerns him.',
      star,
      [],
    );
  }
  return out;
}

/** Loose comparison key, so "Current NFL teammate of X." matches "current NFL teammate of X". */
function reasonKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9 ]+/g, '').trim();
}

function headlineForRole(role: string, draftedName: string, managerName: string): string {
  switch (role) {
    case 'nfl_teammate':
      return `Current NFL teammate of ${draftedName}.`;
    case 'roster_teammate':
      return `Already on ${managerName}'s roster in this draft — ${draftedName} just joined his fantasy team.`;
    case 'regular':
      return 'Lounge regular. He is here for every pick, whether or not this one concerns him.';
    case 'fantasy_2025_teammate':
      return `Shared a 2025 fantasy roster with ${draftedName}.`;
    case 'championship_teammate':
      return `Shared a championship fantasy roster with ${draftedName}.`;
    case 'position_rival':
      return `Position rival of ${draftedName}.`;
    case 'running_joke':
      return 'Part of a running joke this pick touches.';
    default:
      return 'In the Lounge.';
  }
}

function renderMemory(context: LoungeContext): string[] {
  const out: string[] = [];
  const extras = context as Partial<BuiltContext>;
  const names = new Map<string, string>();
  names.set(context.pick.playerId, context.pick.playerName);
  for (const mate of context.nflTeammates ?? []) names.set(mate.playerId, mate.name);
  for (const actor of extras.actors ?? []) names.set(actor.playerId, actor.name);

  const withMemory = new Set<string>();

  for (const [playerId, history] of Object.entries(context.speakerHistories ?? {})) {
    const name = names.get(playerId) ?? playerId;
    const last = history.lastSeason;
    if (last) {
      withMemory.add(playerId);
      const finish = last.teamFinish != null ? `, that team finished ${ordinal(last.teamFinish)}` : '';
      out.push(
        `- ${name} — ${last.season}: on ${last.managerName}'s roster, ${describePerformance(last.performance)}${finish}${
          last.champion === true ? `, and that roster won the ${last.season} title` : ''
        }.`,
      );
    }
    for (const championship of history.championships ?? []) {
      withMemory.add(playerId);
      out.push(
        `- ${name} — ${championship.season}: on ${championship.managerName}'s championship roster.`,
      );
    }
  }

  for (const link of extras.sharedRosters ?? []) {
    if (link.kind === 'roster_2025') {
      out.push(
        `- ${link.aName} and ${link.bName} were both on ${link.managerName ?? 'the same'}'s ${link.season} roster.`,
      );
    } else {
      out.push(
        `- ${link.aName} and ${link.bName} were both on ${link.managerName ?? 'the same'}'s ${link.season} championship roster.`,
      );
    }
  }

  const silent = [...names.entries()]
    .filter(([playerId]) => !withMemory.has(playerId))
    .map(([, name]) => name);
  if (out.length > 0 && silent.length > 0) {
    out.push('');
    out.push(`No fantasy history exists for: ${silent.join(', ')}.`);
  }

  return out;
}

function renderSignals(context: LoungeContext): string[] {
  const extras = context as Partial<BuiltContext>;
  const detail = extras.signalDetail;
  const signals = context.draftSignals ?? {};
  const out: string[] = [];

  if (signals.positionRun !== undefined) {
    const count = detail?.positionRunCount;
    const window = detail?.positionRunWindow;
    out.push(
      count && window
        ? `- Position run: ${count} of the last ${window} picks were ${signals.positionRun}s.`
        : `- Position run: ${signals.positionRun}s are flying off the board.`,
    );
  }
  if (signals.isStack === true) {
    const partners = detail?.stackWith ?? [];
    out.push(
      partners.length > 0
        ? `- Stack: ${context.pick.managerName} already has ${partners.join(' and ')} from ${
            context.pick.nflTeam ?? 'the same NFL team'
          }.`
        : `- Stack: this pick shares an NFL team with someone already on ${context.pick.managerName}'s roster.`,
    );
  }
  if (signals.fellBelowRank !== undefined) {
    const expected = detail?.expectedRank;
    out.push(
      expected !== undefined
        ? `- Slide: consensus had him around ${expected} and he went at ${context.pick.pickNo} — ${signals.fellBelowRank} picks late. Players expect to go near their ranking, so he is taking this personally.`
        : `- Slide: he went ${signals.fellBelowRank} picks later than consensus. He is taking it personally.`,
    );
  }
  if (signals.reachedAboveRank !== undefined) {
    const expected = detail?.expectedRank;
    out.push(
      expected !== undefined
        ? `- Reach: consensus had him around ${expected} and he went at ${context.pick.pickNo} — ${signals.reachedAboveRank} picks early. Somebody has to defend that.`
        : `- Reach: he went ${signals.reachedAboveRank} picks earlier than consensus. Somebody has to defend that.`,
    );
  }
  return out;
}

function describePlayer(
  position: string | null | undefined,
  nflTeam: string | null | undefined,
): string {
  const parts = [position, nflTeam].filter(
    (part): part is string => typeof part === 'string' && part.trim() !== '',
  );
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

function describePerformance(performance: string): string {
  switch (performance) {
    case 'excellent':
      return 'he was excellent';
    case 'good':
      return 'he was good';
    case 'neutral':
      return 'he was roughly as expected';
    case 'disappointing':
      return 'he was disappointing';
    case 'disaster':
      return 'he was a disaster';
    default:
      return performance;
  }
}

function ordinal(value: number): string {
  const abs = Math.abs(value);
  const rest = abs % 100;
  if (rest >= 11 && rest <= 13) return `${value}th`;
  switch (abs % 10) {
    case 1:
      return `${value}st`;
    case 2:
      return `${value}nd`;
    case 3:
      return `${value}rd`;
    default:
      return `${value}th`;
  }
}
