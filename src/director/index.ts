/**
 * Director entry point.
 *
 * Re-exports the `LoungeDirector` interface and the `claude -p` implementation,
 * plus `StubDirector` — a deterministic canned Director with no LLM involved.
 * Milestone A explicitly requires rendering a hardcoded reaction before any
 * model exists, and the renderer and tests need something offline and
 * repeatable.
 */
import type { LoungeContext, LoungeDirector, Reaction, ReactionMessage } from '../types.js';

export type { LoungeDirector, Reaction } from '../types.js';

export {
  ClaudeCliDirector,
  createClaudeCliDirector,
  DirectorFailureError,
  DEFAULT_DIRECTOR_MODEL,
  REQUIRED_CLI_FLAGS,
  allowedSpeakers,
  buildPrompt,
  directorSystemPromptFile,
  failedEventsFile,
  parseEnvelope,
  productRuleViolations,
  renderUserPrompt,
  type ClaudeCliDirectorOptions,
  type DirectorSpawn,
  type DirectorSpawnOptions,
  type DirectorSpawnResult,
  type FailedEventRecord,
} from './claude-cli.js';

/**
 * A Director that never spawns anything.
 *
 * The output is a function of the Context alone, so the same Pick always yields
 * the same Reaction. It satisfies every §14 product rule the real Director is
 * held to: the drafted player speaks first, at most 6 messages, and every
 * speaker is someone the Context actually admits to the room.
 */
export class StubDirector implements LoungeDirector {
  /** Number of Messages to emit, clamped to 1..6. */
  private readonly messageCount: number;

  constructor(options: { messageCount?: number } = {}) {
    this.messageCount = Math.min(6, Math.max(1, options.messageCount ?? 3));
  }

  generateReaction(context: LoungeContext): Promise<Reaction> {
    return Promise.resolve(stubReaction(context, this.messageCount));
  }
}

/** The canned Reaction, exposed directly for fixtures and renderer tests. */
export function stubReaction(context: LoungeContext, messageCount = 3): Reaction {
  const pick = context.pick;
  const messages: ReactionMessage[] = [
    {
      speakerPlayerId: pick.playerId,
      speakerName: pick.playerName,
      text: `${pick.managerName} takes me at ${pick.pickNo}. Understood. Let's work.`,
      delayMs: 0,
      reason: 'drafted_player',
    },
  ];

  const teammate = context.nflTeammates?.[0];
  if (teammate && messages.length < messageCount) {
    messages.push({
      speakerPlayerId: teammate.playerId,
      speakerName: teammate.name,
      text: `Congrats bro. Somebody in this draft finally watched a ${
        pick.nflTeam ?? 'game'
      } tape.`,
      delayMs: 1200,
      reason: 'nfl_teammate',
    });
  }

  const regular = context.regulars?.[0];
  if (regular && messages.length < messageCount) {
    messages.push({
      speakerPlayerId: `star:${regular.key}`,
      speakerName: regular.name,
      text: `Pick ${pick.pickNo} and I'm still sat here watching. Fine. Congrats ${pick.playerName}.`,
      delayMs: 2400,
      reason: 'star_regular',
    });
  }

  while (messages.length < Math.min(messageCount, 2)) {
    // Nobody else is in the room; the drafted player carries the scene.
    messages.push({
      speakerPlayerId: pick.playerId,
      speakerName: pick.playerName,
      text: `Round ${pick.round ?? 1}. Noted.`,
      delayMs: 1200 * messages.length,
      reason: 'drafted_player',
    });
  }

  return {
    eventId: pick.eventId,
    pick: {
      season: pick.season,
      pickNo: pick.pickNo,
      round: pick.round ?? null,
      playerId: pick.playerId,
      playerName: pick.playerName,
      managerName: pick.managerName,
    },
    reactions: messages.slice(0, messageCount),
  };
}
