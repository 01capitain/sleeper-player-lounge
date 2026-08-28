/**
 * `lounge screenshot` — `react` pinned to PNG.
 *
 * A still is the fastest, most shareable artefact (~3s, no ffmpeg), so it gets
 * its own verb rather than making people remember `--format png`. Like `react`
 * it re-renders a Reaction that already exists and never calls the Director.
 */
import { runReact, type ReactDeps, type ReactResult } from './react.js';

export interface ScreenshotOptions {
  latest?: boolean;
  pick?: number;
  /** Explicit output path. */
  out?: string;
  /** Open the PNG with the platform opener. */
  open?: boolean;
}

export async function runScreenshot(
  opts: ScreenshotOptions = {},
  deps: ReactDeps = {},
): Promise<ReactResult> {
  return runReact({ ...opts, format: 'png' }, deps);
}

export default runScreenshot;
