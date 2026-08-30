/**
 * Git-backed handoff for a multi-day draft.
 *
 * A slow draft with an eight-hour pick timer runs for days, and nobody sits at
 * one machine for days. The Lounge already survives being stopped and restarted
 * — `state.json` and the two JSONL logs are the whole memory — so making it
 * survive being moved to a *different* machine is just a matter of getting those
 * files there. Git is already in the loop, so this pushes them after every Pick
 * and pulls them back on the next start.
 *
 * THREE RULES SHAPE EVERYTHING HERE.
 *
 * 1. **Only `data/lounge` is ever committed.** Every git command is pathspec-
 *    limited. A draft-night watcher that commits whatever else happened to be in
 *    the working tree — a half-finished edit, a rebuilt artifact — would be a
 *    trap, and the whole point is that this runs unattended for hours.
 * 2. **A sync failure is never fatal.** The Reaction is already on disk by the
 *    time we get here. Losing the push means the other machine is behind; losing
 *    the draft because a push failed would be absurd. Everything returns a
 *    `SyncResult` and nothing throws.
 * 3. **The repo is never left mid-rebase.** A failed rebase is aborted before
 *    returning, so the next command — and the human — find a clean tree.
 *
 * ONE MACHINE AT A TIME is the assumption, and it is the user's to keep. The
 * logs are append-only JSONL, so two machines drafting at once would conflict on
 * the same trailing lines. `pull()` at startup is what makes the handoff safe;
 * it cannot make concurrency safe.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { repoRoot } from '../paths.js';
import { log } from '../util/log.js';

const execFileAsync = promisify(execFile);

/**
 * The only path this module will ever stage, commit or push.
 *
 * Relative to the repo root because that is what a git pathspec wants. The
 * rendered videos in `output/` are deliberately absent: they are gitignored, so
 * a handoff carries the transcript and the state, not the artifacts. Anything
 * missed can be re-rendered from the Reaction with `lounge react --pick <n>`.
 */
export const SYNCED_PATHSPEC = 'data/lounge';

/** What a sync attempt did. `ok: false` is reported, never thrown. */
export interface SyncResult {
  ok: boolean;
  /** True when there was genuinely nothing to commit or nothing to pull. */
  noop: boolean;
  /** Human-readable outcome, already suitable for a log line. */
  detail: string;
}

/** Injected in tests so nothing shells out to a real repository. */
export type GitRunner = (args: readonly string[]) => Promise<{ stdout: string; stderr: string }>;

export interface GitSyncOptions {
  /** Defaults to `git` in `repoRoot`. */
  run?: GitRunner;
}

function defaultRunner(args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', [...args], { cwd: repoRoot, encoding: 'utf8' });
}

/** The message on every automatic commit, so they are obvious in `git log`. */
export function commitMessage(label: string): string {
  return `Lounge: ${label}`;
}

/**
 * Pull the Lounge forward before the watcher starts.
 *
 * `--autostash` is the important flag: the working tree on draft night usually
 * has *something* in it, and a rebase that refuses to start would mean the
 * watcher silently runs on stale state — the exact failure this feature exists
 * to prevent.
 */
export async function pull(options: GitSyncOptions = {}): Promise<SyncResult> {
  const run = options.run ?? defaultRunner;
  try {
    const { stdout } = await run(['pull', '--rebase', '--autostash']);
    const noop = /already up to date/i.test(stdout);
    return {
      ok: true,
      noop,
      detail: noop ? 'already up to date' : stdout.trim().split('\n').pop() ?? 'pulled',
    };
  } catch (error) {
    await abortRebase(run);
    return { ok: false, noop: false, detail: describe(error) };
  }
}

/**
 * Stage, commit and push `data/lounge`.
 *
 * `label` names the Pick, so `git log` reads as a draft board. On a rejected
 * push the remote moved under us — the other machine, or a manual commit — so
 * we rebase onto it once and retry. Twice would be a loop, not a retry.
 */
export async function publish(label: string, options: GitSyncOptions = {}): Promise<SyncResult> {
  const run = options.run ?? defaultRunner;
  try {
    // `-A` so a first-ever `messages.jsonl` is picked up as a new file, and a
    // pathspec so nothing outside the Lounge can ride along.
    await run(['add', '-A', '--', SYNCED_PATHSPEC]);

    if (await nothingStaged(run)) {
      return { ok: true, noop: true, detail: 'no Lounge changes to publish' };
    }

    // Pathspec-limited commit: whatever else is staged stays staged and uncommitted.
    await run(['commit', '-m', commitMessage(label), '--', SYNCED_PATHSPEC]);
  } catch (error) {
    return { ok: false, noop: false, detail: `commit failed: ${describe(error)}` };
  }

  return pushWithRetry(run);
}

/** Push, and on rejection rebase onto the remote once and push again. */
async function pushWithRetry(run: GitRunner): Promise<SyncResult> {
  try {
    await run(['push']);
    return { ok: true, noop: false, detail: 'pushed' };
  } catch (error) {
    log.debug('lounge push rejected, rebasing onto the remote', describe(error));
  }

  try {
    await run(['pull', '--rebase', '--autostash']);
  } catch (error) {
    await abortRebase(run);
    return {
      ok: false,
      noop: false,
      detail:
        `committed locally but could not rebase onto the remote: ${describe(error)} — ` +
        'resolve by hand, the Reaction is safe on disk',
    };
  }

  try {
    await run(['push']);
    return { ok: true, noop: false, detail: 'pushed after rebase' };
  } catch (error) {
    return {
      ok: false,
      noop: false,
      detail: `committed locally but push still failed: ${describe(error)}`,
    };
  }
}

/** True when the pathspec has nothing staged — `diff --cached --quiet` exits 0. */
async function nothingStaged(run: GitRunner): Promise<boolean> {
  try {
    await run(['diff', '--cached', '--quiet', '--', SYNCED_PATHSPEC]);
    return true;
  } catch {
    // Non-zero exit is git's way of saying "there are staged changes".
    return false;
  }
}

/** Leave no half-finished rebase behind. Failing to abort is not worth reporting. */
async function abortRebase(run: GitRunner): Promise<void> {
  await run(['rebase', '--abort']).catch(() => undefined);
}

/** git writes the useful part to stderr; fall back to the error's own message. */
function describe(error: unknown): string {
  const stderr = (error as { stderr?: string } | null)?.stderr?.trim();
  if (stderr) return stderr.split('\n')[0] ?? stderr;
  return error instanceof Error ? error.message.split('\n')[0] ?? error.message : String(error);
}
