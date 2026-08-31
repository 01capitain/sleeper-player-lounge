/**
 * Running a child process and collecting its output.
 *
 * Both ffmpeg callers — the MP4/GIF encoder and the WebP sidecar — need the
 * same three things: no inherited stdio, the tail of stderr on a non-zero exit,
 * and `ENOENT` reported as "not found on PATH" rather than a raw errno. That is
 * the whole module.
 */
import { spawn } from 'node:child_process';

/**
 * Run `binary` with `args` and resolve its stdout.
 *
 * Rejects with the last few lines of stderr on a non-zero exit, because ffmpeg
 * puts the reason there and the first lines are banner.
 */
export function run(binary: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      reject(
        new Error(
          error.code === 'ENOENT' ? `not found on PATH` : `${error.code ?? 'spawn failed'}`,
        ),
      );
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      const tail = stderr.trim().split('\n').slice(-8).join('\n');
      reject(new Error(`${binary} exited with code ${code}\n${tail}`));
    });
  });
}
