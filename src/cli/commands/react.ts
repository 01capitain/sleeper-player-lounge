/**
 * `lounge react` — re-render an existing Reaction in another format.
 *
 * THIS COMMAND NEVER CALLS THE DIRECTOR. It reads a Reaction that is already in
 * `data/lounge/reactions.jsonl` and hands it to the renderer, so turning a PNG
 * into an MP4 is a pure renderer operation and cannot produce different
 * dialogue than the screenshot you already shared.
 */
import type { PlayerIndex } from '../../import/players.js';
import type { PersistOptions } from '../../lounge/persist.js';
import { loungeReactionsFile } from '../../paths.js';
import type { RenderFormat } from '../../types.js';
import {
  findReactionByPickNo,
  formatDialogue,
  latestReaction,
  renderReaction,
  type RenderReactionOptions,
  type StoredReaction,
} from '../pipeline.js';

export interface ReactOptions {
  /** Use the most recently generated Reaction. The default. */
  latest?: boolean;
  /** Use the Reaction for one specific overall pick number. */
  pick?: number;
  format?: RenderFormat;
  /** Explicit output path. */
  out?: string;
  /** Open the rendered file with the platform opener. */
  open?: boolean;
}

export interface ReactDeps {
  reactionsFile?: string;
  persist?: PersistOptions;
  players?: PlayerIndex;
  render?: (reaction: StoredReaction, opts: RenderReactionOptions) => Promise<string>;
  stdout?: (line: string) => void;
  renderOptions?: RenderReactionOptions;
}

export interface ReactResult {
  reaction: StoredReaction;
  outputPath: string;
}

export async function runReact(
  opts: ReactOptions = {},
  deps: ReactDeps = {},
): Promise<ReactResult> {
  const out = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const file = deps.reactionsFile ?? deps.persist?.reactionsFile ?? loungeReactionsFile;
  const reaction = await resolveReaction(opts, file);
  const draw = deps.render ?? renderReaction;

  const renderOpts: RenderReactionOptions = {
    open: opts.open === true,
    persist: deps.persist ?? (deps.reactionsFile ? { reactionsFile: deps.reactionsFile } : {}),
    ...(opts.format ? { format: opts.format } : {}),
    ...(opts.out ? { out: opts.out } : {}),
    ...(deps.players ? { players: deps.players } : {}),
    ...(deps.renderOptions ?? {}),
  };
  const outputPath = await draw(reaction, renderOpts);

  const round = reaction.pick.round ?? '?';
  out(
    `#${reaction.pick.pickNo} · round ${round} · ${reaction.pick.playerName} -> ${reaction.pick.managerName}`,
  );
  for (const line of formatDialogue(reaction)) out(line);
  out(`  rendered: ${outputPath}`);

  return { reaction, outputPath };
}

/** `--pick <n>` wins over `--latest`; with neither, the latest is used. */
async function resolveReaction(opts: ReactOptions, file: string): Promise<StoredReaction> {
  if (typeof opts.pick === 'number') {
    const found = await findReactionByPickNo(opts.pick, file);
    if (!found) {
      throw new Error(
        `No stored Reaction for pick #${opts.pick}. ` +
          `Generate one first: \`npm run lounge -- simulate --pick ${opts.pick}\`.`,
      );
    }
    return found;
  }
  const found = await latestReaction(file);
  if (!found) {
    throw new Error(
      'No Reactions have been generated yet. Run `npm run demo` or `npm run lounge -- simulate --next`.',
    );
  }
  return found;
}

export default runReact;
