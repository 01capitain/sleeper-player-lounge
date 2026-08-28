/**
 * The desktop draft board.
 *
 * Two properties matter more than anything else here and are asserted from
 * both sides:
 *
 *  - **Every Pick appears.** A board that quietly drops the ~85% of picks with
 *    no Reaction is not a board. Picks with a Reaction get a scene anchor;
 *    picks without get none, and are still on the page.
 *  - **The file is self-contained.** No `<link>`, no `<script src>`, no
 *    absolute URL, and — proved for real at the bottom of this file — zero
 *    network requests when chromium loads it from `file://` with every
 *    non-`file:` request aborted.
 *
 * Nothing here touches the network: headshot downloads are switched off, so
 * every avatar falls back to the template's monogram.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AdpArtifact } from '../../import/adp.js';
import type { Pick, Reaction } from '../../types.js';
import {
  anchorIdFor,
  buildBoardHtml,
  buildBoardModel,
  describeDelta,
  exportCommandFor,
  generateCommandFor,
  renderBoardHtml,
  type BoardRow,
  type BuildBoardOptions,
} from '../desktop.js';

/**
 * The tsconfig has no `dom` lib on purpose — this is Node code — so the
 * in-page callbacks below reach the document through a cast on `globalThis`,
 * exactly as `src/render/browser.ts` reaches `window.LOUNGE`. The cast is
 * erased before the function is serialised into the browser.
 */
interface DomRect {
  top: number;
}
interface DomNode {
  id: string;
  textContent: string | null;
  disabled: boolean;
  scrollTop: number;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): DomRect;
}
interface DomDocument {
  documentElement: { getAttribute(name: string): string | null };
  body: { scrollWidth: number; clientWidth: number };
  querySelector(selector: string): DomNode | null;
  querySelectorAll(selector: string): { length: number };
  getElementById(id: string): DomNode | null;
}
type DomWindow = { document: DomDocument };

const DRAFT_ID = 'sim9001';

/** Real drafts have far more picks than Reactions; the fixture mirrors that. */
function pick(pickNo: number, overrides: Partial<Pick> = {}): Pick {
  const playerId = overrides.playerId ?? `p${pickNo}`;
  return {
    eventId: `${DRAFT_ID}:${pickNo}:${playerId}`,
    season: 2026,
    leagueId: 'league-1',
    draftId: DRAFT_ID,
    pickNo,
    round: Math.ceil(pickNo / 4),
    draftSlot: ((pickNo - 1) % 4) + 1,
    playerId,
    playerName: `Player ${pickNo}`,
    position: 'WR',
    nflTeam: 'KC',
    managerId: `m${((pickNo - 1) % 4) + 1}`,
    managerName: `Manager ${((pickNo - 1) % 4) + 1}`,
    simulated: true,
    ...overrides,
  };
}

function reactionFor(source: Pick, count = 2): Reaction {
  return {
    eventId: source.eventId,
    pick: {
      season: source.season,
      pickNo: source.pickNo,
      round: source.round ?? null,
      playerId: source.playerId,
      playerName: source.playerName,
      managerName: source.managerName,
    },
    reactions: Array.from({ length: count }, (_, index) => ({
      speakerPlayerId: index === 0 ? source.playerId : `s${index}`,
      speakerName: index === 0 ? source.playerName : `Speaker ${index}`,
      text: `Line ${index} about pick ${source.pickNo}.`,
      delayMs: index * 1200,
      reason: 'other' as const,
    })),
  };
}

const PICKS = Array.from({ length: 12 }, (_, i) => pick(i + 1));
/** Picks 3 and 9 have scenes; the other ten do not. */
const REACTIONS = [reactionFor(PICKS[2] as Pick, 3), reactionFor(PICKS[8] as Pick, 2)];

const ADP: AdpArtifact = {
  source: 'test',
  season: 2026,
  week: 0,
  field: 'adp_dd_ppr',
  unrankedSentinel: 900,
  generatedAt: '2026-08-01T00:00:00.000Z',
  rankedCount: 3,
  // p1 is a reach (ADP 30, taken 1st), p3 is a slide, p5 lands exactly on ADP.
  adp: { p1: 30, p3: 1, p5: 5 },
};

/** Everything injected, so no test reads `data/` or reaches the network. */
function options(extra: BuildBoardOptions = {}): BuildBoardOptions {
  return {
    picks: PICKS,
    reactions: REACTIONS,
    adp: ADP,
    draft: null,
    watermark: 'Players Lounge • Fantasy parody',
    headshotOptions: { download: false },
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Commands and ids
// ---------------------------------------------------------------------------

describe('the commands the board offers', () => {
  it('exports a stored Reaction with `react`, which never calls the Director', () => {
    expect(exportCommandFor(119)).toBe('npm run lounge -- react --pick 119 --format mp4');
    expect(exportCommandFor(1, 'gif')).toBe('npm run lounge -- react --pick 1 --format gif');
  });

  it('offers `simulate` for a Pick that has no Reaction yet', () => {
    expect(generateCommandFor(42)).toBe('npm run lounge -- simulate --pick 42');
  });

  it('derives a stable, id-safe anchor from the eventId', () => {
    expect(anchorIdFor('1389356983177465857:119:1466')).toBe('scene-1389356983177465857-119-1466');
    expect(anchorIdFor('1389356983177465857:119:1466')).toBe(anchorIdFor('1389356983177465857:119:1466'));
    expect(anchorIdFor('  ')).toBe('scene-reaction');
  });
});

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

describe('the board model', () => {
  it('keeps every Pick, not just the ones with a Reaction', async () => {
    const model = await buildBoardModel(options());
    expect(model.rows).toHaveLength(PICKS.length);
    expect(model.rows.map((row) => row.pickNo)).toEqual(PICKS.map((p) => p.pickNo));
    expect(model.scenes).toHaveLength(2);
  });

  it('gives an anchor only to the Picks that have a Reaction', async () => {
    const model = await buildBoardModel(options());
    const withAnchor = model.rows.filter((row) => row.anchorId !== null);
    expect(withAnchor.map((row) => row.pickNo)).toEqual([3, 9]);
    for (const row of model.rows) {
      if (row.anchorId === null) {
        expect(row.exportCommand).toBeNull();
        expect(row.generateCommand).toBe(generateCommandFor(row.pickNo));
      } else {
        expect(row.anchorId).toBe(anchorIdFor(row.eventId));
        expect(row.exportCommand).toBe(exportCommandFor(row.pickNo));
      }
    }
  });

  it('orders scenes by pick number so the transcript reads in draft order', async () => {
    const model = await buildBoardModel(
      options({ reactions: [...REACTIONS].reverse() }),
    );
    expect(model.scenes.map((scene) => scene.pickNo)).toEqual([3, 9]);
  });

  it('signs the ADP delta: positive is a reach, negative is a slide', async () => {
    const model = await buildBoardModel(options());
    const byPick = new Map(model.rows.map((row) => [row.pickNo, row]));
    expect(byPick.get(1)).toMatchObject({ adp: 30, adpDelta: 29 });
    expect(byPick.get(3)).toMatchObject({ adp: 1, adpDelta: -2 });
    expect(byPick.get(5)).toMatchObject({ adp: 5, adpDelta: 0 });
  });

  it('leaves the delta null for an unranked player rather than inventing one', async () => {
    const model = await buildBoardModel(options());
    const unranked = model.rows.filter((row) => !['p1', 'p3', 'p5'].includes(`p${row.pickNo}`));
    expect(unranked.length).toBeGreaterThan(0);
    for (const row of unranked) {
      expect(row.adp).toBeNull();
      expect(row.adpDelta).toBeNull();
      expect(describeDelta(row)).toBeNull();
    }
  });

  it('describes a delta in words for the tooltip and the dock', () => {
    const base: BoardRow = {
      eventId: 'e',
      pickNo: 74,
      round: 6,
      draftSlot: 4,
      playerName: 'Kyle Pitts',
      position: 'TE',
      nflTeam: 'ATL',
      managerName: 'The Isotones',
      adp: 22,
      adpDelta: -52,
      anchorId: null,
      exportCommand: null,
      generateCommand: generateCommandFor(74),
    };
    expect(describeDelta(base)).toBe('fell 52 picks past ADP 22');
    expect(describeDelta({ ...base, adp: 104, adpDelta: 30 })).toBe('reached 30 picks early (ADP 104)');
    expect(describeDelta({ ...base, adp: 74, adpDelta: 0 })).toBe('taken exactly at ADP 74');
  });

  it('`--limit` keeps the last N Picks and drops scenes that fall off the board', async () => {
    const model = await buildBoardModel(options({ limit: 4 }));
    expect(model.rows.map((row) => row.pickNo)).toEqual([9, 10, 11, 12]);
    // Pick 3's Reaction has no row to select it any more, so it is not a scene.
    expect(model.scenes.map((scene) => scene.pickNo)).toEqual([9]);
  });

  it('builds each scene on the same timeline the MP4 encoder walks', async () => {
    const model = await buildBoardModel(options());
    for (const scene of model.scenes) {
      expect(scene.timeline.durationMs).toBeGreaterThan(0);
      expect(scene.timeline.events[0]).toEqual({ atMs: 0, action: { kind: 'reset' } });
      const reveals = scene.timeline.events.filter((e) => e.action.kind === 'reveal');
      expect(reveals).toHaveLength(scene.payload.reactions.length);
    }
  });

  it('never repeats the previous scene as `previousMessages`', async () => {
    const model = await buildBoardModel(options());
    for (const scene of model.scenes) expect(scene.payload.previousMessages).toEqual([]);
  });

  it('summarises the board honestly in its heading', async () => {
    const model = await buildBoardModel(options());
    expect(model.subheading).toContain('12 picks');
    expect(model.subheading).toContain('2 Lounge scenes');
  });
});

// ---------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------

describe('the built page', () => {
  it('inlines the stylesheets and scripts instead of linking them', async () => {
    const html = await buildBoardHtml(options());
    expect(html).not.toMatch(/<link[^>]+stylesheet/);
    expect(html).not.toMatch(/<script[^>]+src=/);
    // lounge.css and render.js are inlined verbatim, never copied.
    expect(html).toContain('1080 x 1920 master canvas');
    expect(html).toContain('window.LOUNGE');
    expect(html).toContain('.lounge-canvas');
  });

  it('makes no request to any external host', async () => {
    const html = await buildBoardHtml(options());
    expect(html).not.toMatch(/https?:\/\//);
  });

  it('substitutes every placeholder it owns', async () => {
    const html = await buildBoardHtml(options());
    for (const token of [
      '__TITLE__',
      '__HEADING__',
      '__SUBHEADING__',
      '__LOUNGE_CSS__',
      '__DESKTOP_CSS__',
      '__BOARD_ROWS__',
      '__DATA__',
      '__RENDER_JS__',
      '__DESKTOP_JS__',
    ]) {
      expect(html).not.toContain(token);
    }
  });

  it('puts every Pick on the board, with a scene pill only where there is one', async () => {
    const html = await buildBoardHtml(options());
    for (const p of PICKS) {
      expect(html).toContain(`data-pick="${p.pickNo}"`);
      expect(html).toContain(`>${p.playerName}<`);
    }
    expect(html.match(/class="pick /g)).toHaveLength(PICKS.length);
    expect(html.match(/data-anchor="/g)).toHaveLength(2);
    // scoped to the board rows: the dock's idle copy shows a pill too
    expect(html.match(/class="cell-scene"><span class="scene-pill"/g)).toHaveLength(2);
    expect(html.match(/class="cell-scene"><span class="no-pill"/g)).toHaveLength(
      PICKS.length - 2,
    );
  });

  it('carries the generate command on the picks that have no scene', async () => {
    const html = await buildBoardHtml(options());
    expect(html).toContain(`data-hint="${generateCommandFor(1)}"`);
    expect(html).toContain(exportCommandFor(3));
    expect(html).toContain(exportCommandFor(9));
  });

  it('writes "unranked" rather than a fabricated ADP number', async () => {
    const html = await buildBoardHtml(options());
    expect(html).toContain('<span class="unranked">unranked</span>');
    expect(html).toContain('>+29<');
    expect(html).toContain('>-2<');
  });

  it('embeds one payload and timeline per scene', async () => {
    const html = await buildBoardHtml(options());
    expect(html).toContain('window.__BOARD__ =');
    for (const reaction of REACTIONS) {
      for (const message of reaction.reactions) expect(html).toContain(message.text);
    }
    const json = JSON.parse(
      html.slice(html.indexOf('window.__BOARD__ =') + 18, html.indexOf(';</script>')),
    ) as { sceneCount: number; pickCount: number; scenes: { anchorId: string }[] };
    expect(json.pickCount).toBe(PICKS.length);
    expect(json.sceneCount).toBe(2);
    expect(json.scenes.map((s) => s.anchorId)).toEqual([
      anchorIdFor((PICKS[2] as Pick).eventId),
      anchorIdFor((PICKS[8] as Pick).eventId),
    ]);
  });

  it('escapes anything a Pick could smuggle into markup', async () => {
    const hostile = pick(1, { playerName: 'Tom <script>alert(1)</script>', managerName: 'A " B' });
    const html = await buildBoardHtml(options({ picks: [hostile], reactions: [] }));
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('data-player="Tom &lt;script&gt;');
  });

  it('builds a usable page even with no Reactions at all', async () => {
    const html = await buildBoardHtml(options({ reactions: [] }));
    expect(html.match(/class="pick /g)).toHaveLength(PICKS.length);
    expect(html).not.toContain('data-anchor=');
    expect(html).toContain('"sceneCount":0');
  });

  it('writes the file and creates its parent directory', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lounge-board-'));
    try {
      const target = path.join(dir, 'nested', 'board.html');
      expect(await renderBoardHtml(target, options())).toBe(target);
      expect((await fs.readFile(target, 'utf8')).length).toBeGreaterThan(10_000);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// The real thing: chromium, file://, and every non-file request aborted
// ---------------------------------------------------------------------------

const LAUNCH_TIMEOUT = 60_000;
const LOAD_TIMEOUT = 60_000;

describe('loaded in a real browser', () => {
  let dir: string;
  let file: string;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lounge-board-e2e-'));
    file = path.join(dir, 'board.html');
    await renderBoardHtml(file, options());
  }, LAUNCH_TIMEOUT);

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it(
    'renders both panes with zero network requests and no errors',
    async () => {
      const { chromium } = await import('playwright');
      const browser = await chromium.launch({ headless: true });
      try {
        const context = await browser.newContext({
          viewport: { width: 1440, height: 900 },
          colorScheme: 'dark',
        });
        const page = await context.newPage();

        const external: string[] = [];
        const errors: string[] = [];
        // Anything that is not the file itself, or embedded in it, is a bug.
        await page.route('**/*', (route) => {
          const url = route.request().url();
          if (url.startsWith('file://') || url.startsWith('data:') || url.startsWith('blob:')) {
            return route.continue();
          }
          external.push(url);
          return route.abort();
        });
        page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
        page.on('console', (message) => {
          if (message.type() === 'error') errors.push(`console: ${message.text()}`);
        });
        page.on('requestfailed', (request) => errors.push(`requestfailed: ${request.url()}`));

        await page.goto(pathToFileURL(file).href, { waitUntil: 'load' });
        await page.waitForFunction(() => {
          const d = (globalThis as unknown as DomWindow).document;
          return d.documentElement.getAttribute('data-board-ready') === 'true';
        });

        expect(external).toEqual([]);
        expect(errors).toEqual([]);

        const view = await page.evaluate(() => {
          const d = (globalThis as unknown as DomWindow).document;
          return {
            picks: d.querySelectorAll('.pick').length,
            scenes: d.querySelectorAll('.scene').length,
            bubbles: d.querySelectorAll('.bubble').length,
            // built by templates/render.js, not by the Node builder
            cards: d.querySelectorAll('.status-card').length,
            heroes: d.querySelectorAll('.announce-family').length,
            selected: d.querySelector('.pick.is-selected')?.getAttribute('data-pick') ?? null,
            command: d.getElementById('export-cmd')?.textContent ?? null,
            horizontalOverflow: d.body.scrollWidth > d.body.clientWidth,
          };
        });

        expect(view.picks).toBe(PICKS.length);
        expect(view.scenes).toBe(2);
        expect(view.bubbles).toBe(5);
        expect(view.cards).toBe(2);
        expect(view.heroes).toBe(2);
        // it lands on the newest scene, and offers that scene's export command
        expect(view.selected).toBe('9');
        expect(view.command).toBe(exportCommandFor(9));
        expect(view.horizontalOverflow).toBe(false);

        // Clicking a Pick with a scene scrolls the transcript to it.
        await page.click('.pick[data-pick="3"]');
        await page.waitForTimeout(700);
        const jumped = await page.evaluate(() => {
          const d = (globalThis as unknown as DomWindow).document;
          const scene = d.querySelector('.scene.is-selected');
          const scroller = d.getElementById('chat-scroll');
          if (!scene || !scroller) return null;
          return {
            id: scene.id,
            offset: Math.round(
              scene.getBoundingClientRect().top - scroller.getBoundingClientRect().top,
            ),
          };
        });
        expect(jumped?.id).toBe(anchorIdFor((PICKS[2] as Pick).eventId));
        expect(Math.abs(jumped?.offset ?? 999)).toBeLessThan(40);

        // Replay re-hides that scene's bubbles, then brings them all back.
        await page.click('#replay');
        await page.waitForTimeout(120);
        const stillHidden = () =>
          page.evaluate(
            () =>
              (globalThis as unknown as DomWindow).document.querySelectorAll(
                '.scene.is-selected .scene-rows > .row.is-hidden',
              ).length,
          );
        expect(await stillHidden()).toBe(3);
        await page.waitForTimeout(11_000);
        expect(await stillHidden()).toBe(0);

        // A Pick with no Reaction is inert: the transcript does not move.
        const before = await page.evaluate(
          () =>
            (globalThis as unknown as DomWindow).document.getElementById('chat-scroll')
              ?.scrollTop ?? -1,
        );
        await page.click('.pick.no-scene[data-pick="5"]');
        await page.waitForTimeout(400);
        const inert = await page.evaluate((previous) => {
          const d = (globalThis as unknown as DomWindow).document;
          return {
            moved: (d.getElementById('chat-scroll')?.scrollTop ?? -1) !== previous,
            replayDisabled: d.getElementById('replay')?.disabled === true,
            note: d.getElementById('dock-note')?.textContent ?? '',
          };
        }, before);
        expect(inert.moved).toBe(false);
        expect(inert.replayDisabled).toBe(true);
        expect(inert.note).toContain(generateCommandFor(5));

        await context.close();
      } finally {
        await browser.close();
      }
    },
    LOAD_TIMEOUT,
  );
});
