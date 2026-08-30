/**
 * `src/watch/sync.ts` — the git-backed machine handoff.
 *
 * Every test drives a fake `GitRunner`, so nothing here touches a real
 * repository, a remote, or the network. What is actually being asserted is the
 * argv: this module's whole safety story is *which* git commands it runs and
 * with which pathspec, and argv is the only place that is visible.
 */
import { describe, expect, it } from 'vitest';

import { commitMessage, publish, pull, SYNCED_PATHSPEC, type GitRunner } from '../sync.js';

/** A git that succeeds at everything and records what it was asked to do. */
function fakeGit(
  responses: Record<string, string | Error> = {},
): { calls: string[][]; run: GitRunner } {
  const calls: string[][] = [];
  const run: GitRunner = async (args) => {
    calls.push([...args]);
    const key = args.slice(0, 2).join(' ');
    const scripted = responses[key] ?? responses[args[0] ?? ''];
    if (scripted instanceof Error) throw scripted;
    return { stdout: scripted ?? '', stderr: '' };
  };
  return { calls, run };
}

/** An error shaped like the one `execFile` throws for a non-zero git exit. */
function gitError(stderr: string): Error {
  return Object.assign(new Error('Command failed'), { stderr });
}

/** The commands actually issued, as `git ...` strings, for readable assertions. */
function issued(calls: string[][]): string[] {
  return calls.map((args) => `git ${args.join(' ')}`);
}

// ---------------------------------------------------------------------------
// The pathspec guarantee — the reason this module can run unattended
// ---------------------------------------------------------------------------

describe('nothing outside data/lounge is ever staged, committed or pushed', () => {
  it('scopes both the add and the commit to the Lounge pathspec', async () => {
    // `diff --cached --quiet` throwing is git's way of saying "changes staged".
    const { calls, run } = fakeGit({ 'diff --cached': gitError('') });
    await publish('#1 · round 1 · Jahmyr Gibbs -> Skunk Works', { run });

    const add = calls.find((args) => args[0] === 'add');
    const commit = calls.find((args) => args[0] === 'commit');
    expect(add).toContain(SYNCED_PATHSPEC);
    expect(add).toContain('--');
    expect(commit).toContain(SYNCED_PATHSPEC);
    expect(commit).toContain('--');
  });

  it('never issues a bare `git add -A` or a bare `git commit -a`', async () => {
    const { calls, run } = fakeGit({ 'diff --cached': gitError('') });
    await publish('#1', { run });

    for (const args of calls) {
      if (args[0] === 'add') expect(args).toContain('--');
      if (args[0] === 'commit') {
        expect(args).not.toContain('-a');
        expect(args).toContain('--');
      }
    }
  });

  it('labels the commit with the pick, so `git log` reads as a draft board', async () => {
    const { calls, run } = fakeGit({ 'diff --cached': gitError('') });
    await publish('#7 · round 1 · Puka Nacua -> BigTruzz', { run });

    const commit = calls.find((args) => args[0] === 'commit');
    expect(commit).toContain(commitMessage('#7 · round 1 · Puka Nacua -> BigTruzz'));
  });
});

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

describe('publish', () => {
  it('commits and pushes when the Lounge changed', async () => {
    const { calls, run } = fakeGit({ 'diff --cached': gitError('') });
    const result = await publish('#1', { run });

    expect(result).toMatchObject({ ok: true, noop: false });
    expect(issued(calls).at(-1)).toBe('git push');
  });

  it('is a no-op when nothing changed — a duplicate poll must not make a commit', async () => {
    // `diff --cached --quiet` exiting 0 means nothing is staged.
    const { calls, run } = fakeGit();
    const result = await publish('#1', { run });

    expect(result).toMatchObject({ ok: true, noop: true });
    expect(issued(calls)).not.toContain('git commit');
    expect(issued(calls)).not.toContain('git push');
  });

  it('rebases onto the remote and retries once when the push is rejected', async () => {
    let pushes = 0;
    const calls: string[][] = [];
    const run: GitRunner = async (args) => {
      calls.push([...args]);
      if (args[0] === 'diff') throw gitError('');
      if (args[0] === 'push') {
        pushes += 1;
        if (pushes === 1) throw gitError('! [rejected] main -> main (fetch first)');
      }
      return { stdout: '', stderr: '' };
    };

    const result = await publish('#1', { run });

    expect(result.ok).toBe(true);
    expect(result.detail).toBe('pushed after rebase');
    expect(pushes).toBe(2);
    expect(issued(calls)).toContain('git pull --rebase --autostash');
  });

  it('reports failure without throwing when the retry also fails', async () => {
    const run: GitRunner = async (args) => {
      if (args[0] === 'diff') throw gitError('');
      if (args[0] === 'push') throw gitError('! [rejected] main -> main');
      return { stdout: '', stderr: '' };
    };

    const result = await publish('#1', { run });

    // The Reaction is already on disk; a failed push must never end the draft.
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('committed locally');
  });

  it('aborts a failed rebase rather than leaving the repo mid-rebase', async () => {
    const calls: string[][] = [];
    const run: GitRunner = async (args) => {
      calls.push([...args]);
      if (args[0] === 'diff') throw gitError('');
      if (args[0] === 'push') throw gitError('! [rejected] main -> main');
      if (args[0] === 'pull') throw gitError('CONFLICT (content): data/lounge/messages.jsonl');
      return { stdout: '', stderr: '' };
    };

    const result = await publish('#1', { run });

    expect(result.ok).toBe(false);
    expect(issued(calls)).toContain('git rebase --abort');
  });
});

// ---------------------------------------------------------------------------
// Pull
// ---------------------------------------------------------------------------

describe('pull', () => {
  it('rebases with --autostash, so a dirty working tree cannot block the handoff', async () => {
    const { calls, run } = fakeGit({ pull: 'Successfully rebased and updated refs/heads/main.' });
    const result = await pull({ run });

    expect(result.ok).toBe(true);
    expect(issued(calls)).toEqual(['git pull --rebase --autostash']);
  });

  it('reports a no-op when the machine is already current', async () => {
    const { run } = fakeGit({ pull: 'Already up to date.\n' });
    expect(await pull({ run })).toMatchObject({ ok: true, noop: true });
  });

  it('aborts and reports failure on a conflict', async () => {
    const calls: string[][] = [];
    const run: GitRunner = async (args) => {
      calls.push([...args]);
      if (args[0] === 'pull') throw gitError('CONFLICT (content): data/lounge/state.json');
      return { stdout: '', stderr: '' };
    };

    const result = await pull({ run });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('CONFLICT');
    expect(issued(calls)).toContain('git rebase --abort');
  });
});
