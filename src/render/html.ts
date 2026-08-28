/**
 * Standalone HTML output — the Lounge scene as a single file you can open in a
 * browser, double-click from Finder, or drop in a shared folder.
 *
 * Why this exists alongside PNG and MP4: a PNG cannot show the scene arriving,
 * and an MP4 cannot be inspected or re-watched without a player and a scrub bar.
 * The HTML build animates on load using the SAME timeline the video encoder
 * uses, so what you see here is exactly what the MP4 will contain — which makes
 * it the fastest way to judge pacing before committing to an encode.
 *
 * The file is fully self-contained: CSS and JS are inlined and the payload is
 * embedded, so it works from `file://` with no server and no network. Headshots
 * are the one exception — they are inlined as `data:` URIs when cached locally,
 * so the file stays portable.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { repoRoot } from '../paths.js';
import type { Reaction } from '../types.js';
import { preparePayload, type PreparePayloadOptions } from './payload.js';
import { buildTimeline, type TimelineOptions } from './video.js';
import type { RenderPayload } from './payload.js';

const templatesDir = path.join(repoRoot, 'templates');

export interface RenderHtmlOptions extends PreparePayloadOptions, TimelineOptions {
  /** Skip the animation and paint the final state immediately. */
  still?: boolean;
}

/** Inline every locally cached headshot so the file survives being moved. */
async function inlineHeadshots(payload: RenderPayload): Promise<RenderPayload> {
  const rows = [...(payload.previousMessages ?? []), ...(payload.reactions ?? [])];
  const seen = new Map<string, string>();
  for (const row of rows) {
    const url = row.headshotUrl;
    if (!url || !url.startsWith('file://')) continue;
    if (seen.has(url)) {
      row.headshotUrl = seen.get(url);
      continue;
    }
    try {
      const bytes = await readFile(fileURLToPath(url));
      // Sleeper serves PNG bytes from a .jpg URL, so sniff rather than trust it.
      const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
      const dataUri = `data:image/${isPng ? 'png' : 'jpeg'};base64,${bytes.toString('base64')}`;
      seen.set(url, dataUri);
      row.headshotUrl = dataUri;
    } catch {
      delete row.headshotUrl; // falls back to the monogram avatar
    }
  }
  return payload;
}

/** Render one Reaction to a self-contained HTML file. Returns the path written. */
export async function buildHtml(reaction: Reaction, opts: RenderHtmlOptions = {}): Promise<string> {
  const payload = await inlineHeadshots(await preparePayload(reaction, opts));
  const timeline = buildTimeline(payload, opts);

  const [shell, css, js] = await Promise.all([
    readFile(path.join(templatesDir, 'lounge.html'), 'utf8'),
    readFile(path.join(templatesDir, 'lounge.css'), 'utf8'),
    readFile(path.join(templatesDir, 'render.js'), 'utf8'),
  ]);

  // Keep the shell's exact DOM — the render script depends on those ids.
  const bodyStart = shell.indexOf('<body>') + '<body>'.length;
  const bodyEnd = shell.indexOf('</body>');
  const body = shell
    .slice(bodyStart, bodyEnd)
    .replace(/<script src="render\.js"><\/script>/, '');

  const still = opts.still === true;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Players Lounge — ${escapeHtml(payload.pick?.playerName ?? 'reaction')}</title>
<style>
${css}
/* --- browser chrome, not part of the 1080x1920 render target --------------- */
html, body { background: #07080b; margin: 0; }
body { min-height: 100vh; display: flex; flex-direction: column; align-items: center;
       gap: 20px; padding: 24px 12px 40px; box-sizing: border-box; }
#stage { box-shadow: 0 24px 80px rgba(0,0,0,.6); flex: 0 0 auto;
         transform-origin: top center; }
.controls { display: flex; gap: 12px; align-items: center; flex-wrap: wrap;
  font: 600 15px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  color: #7b8595; }
.controls button {
  font: inherit; color: #cbd5e1; background: #1a1f27; border: 1px solid #2a3038;
  border-radius: 8px; padding: 9px 16px; cursor: pointer; }
.controls button:hover { background: #232933; }
.controls .meta { color: #4d5666; }
</style>
</head>
<body>

<div class="controls">
  <button id="replay">Replay</button>
  <button id="final">Show final</button>
  <span class="meta" id="meta"></span>
</div>

${body}

<script>
${js}
</script>
<script>
(function () {
  var PAYLOAD = ${JSON.stringify(payload)};
  var TIMELINE = ${JSON.stringify(timeline)};
  var STILL = ${still ? 'true' : 'false'};
  var timers = [];

  function clearTimers() { timers.forEach(clearTimeout); timers = []; }

  function showFinal() { clearTimers(); window.LOUNGE.render(PAYLOAD); }

  function play() {
    clearTimers();
    // Fit the 1080x1920 stage to the viewport without touching the render target.
    TIMELINE.events.forEach(function (ev) {
      timers.push(setTimeout(function () {
        var a = ev.action;
        if (a.kind === 'reset') window.LOUNGE.reset(PAYLOAD);
        else if (a.kind === 'showTyping') window.LOUNGE.showTyping(a.speakerPlayerId);
        else if (a.kind === 'hideTyping') window.LOUNGE.hideTyping();
        else if (a.kind === 'reveal') window.LOUNGE.revealNext();
      }, ev.atMs));
    });
  }

  function fit() {
    var stage = document.getElementById('stage');
    if (!stage) return;
    var avail = window.innerHeight - 130;
    var scale = Math.min(1, avail / 1920, (window.innerWidth - 24) / 1080);
    stage.style.transform = 'scale(' + scale + ')';
    stage.style.marginBottom = (1920 * scale - 1920) + 'px';
  }

  function boot() {
    if (!window.LOUNGE || !window.LOUNGE.ready) { setTimeout(boot, 20); return; }
    document.getElementById('meta').textContent =
      PAYLOAD.reactions.length + ' messages · ' + Math.round(TIMELINE.durationMs / 100) / 10 + 's';
    document.getElementById('replay').onclick = play;
    document.getElementById('final').onclick = showFinal;
    fit();
    window.addEventListener('resize', fit);
    if (STILL) showFinal(); else play();
  }
  boot();
})();
</script>
</body>
</html>
`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}

/** Write the standalone HTML to `outPath`. Returns the path written. */
export async function renderHtml(
  reaction: Reaction,
  outPath: string,
  opts: RenderHtmlOptions = {},
): Promise<string> {
  const html = await buildHtml(reaction, opts);
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, html, 'utf8');
  return outPath;
}
