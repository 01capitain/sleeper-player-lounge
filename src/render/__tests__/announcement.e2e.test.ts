/**
 * The draft announcement, exercised in a real browser.
 *
 * The announcement is the centrepiece of every export, and almost all of it
 * lives in `templates/lounge.css` and `templates/render.js` — CSS custom
 * properties, a measured type fit and a measured density fit, none of which a
 * unit test can see. So these run against the real template through the same
 * Playwright driver the renderers use.
 *
 * What is pinned here is behaviour the design depends on, not pixels:
 *   - the hero name is the pick's player, the credit is the manager
 *   - the team accent is keyed off the drafted player's chip and degrades to
 *     the house accent for an unknown or absent team
 *   - a missing round drops out of the kicker instead of printing "null"
 *   - a very long name is shrunk rather than allowed to overflow
 *   - `render()` is settled immediately, `reset()` settles inside the 700ms
 *     status pause the video timeline allows
 *   - a long thread tightens the chat instead of pushing the announcement off
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { launchLoungeBrowser, type LoungeBrowser, type LoungePage } from '../browser.js';
import type { RenderPayload, RenderPayloadReaction } from '../payload.js';

const LAUNCH_TIMEOUT = 60_000;
const TEST_TIMEOUT = 60_000;

let browser: LoungeBrowser;
let page: LoungePage;

beforeAll(async () => {
  browser = await launchLoungeBrowser();
  page = await browser.newPage();
}, LAUNCH_TIMEOUT);

afterAll(async () => {
  await page?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
});

// ---------------------------------------------------------------------------
// Payload helpers
// ---------------------------------------------------------------------------

function reaction(overrides: Partial<RenderPayloadReaction> = {}): RenderPayloadReaction {
  return {
    speakerPlayerId: '1466',
    speakerName: 'Travis Kelce',
    text: 'Round nine. In this economy.',
    delayMs: 0,
    teamChip: 'KC · TE',
    ...overrides,
  };
}

function payload(overrides: Partial<RenderPayload> = {}): RenderPayload {
  return {
    pick: {
      season: 2026,
      pickNo: 119,
      round: 9,
      playerId: '1466',
      playerName: 'Travis Kelce',
      managerName: 'RadebergBearTheater',
    },
    previousMessages: [],
    reactions: [reaction()],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// In-page reading
//
// The tsconfig has no `dom` lib (this is Node code), so the browser globals the
// evaluated callbacks need are reached through a cast, exactly as `browser.ts`
// reaches `window.LOUNGE`. The cast is erased before the function is serialised.
// ---------------------------------------------------------------------------

interface PageBox {
  top: number;
  height: number;
  width: number;
}

interface PageElement {
  className: string;
  textContent: string | null;
  scrollWidth: number;
  clientWidth: number;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): PageBox;
}

interface PageDocument {
  getElementById(id: string): PageElement | null;
  querySelector(selector: string): PageElement | null;
}

interface PageWindow {
  document: PageDocument;
  getComputedStyle(element: PageElement): { fontSize: string; color: string };
}

/** Everything the assertions below need, read in one pass. */
interface AnnouncementSnapshot {
  kicker: string;
  given: string;
  family: string;
  credit: string;
  manager: string;
  teamAttr: string | null;
  nameplate: string | null;
  accent: string;
  familyFontSize: number;
  familyOverflows: boolean;
  cardHeight: number;
  cardWidth: number;
  cardTop: number;
  scrollTop: number;
  density: string;
}

async function snapshot(): Promise<AnnouncementSnapshot> {
  return page.raw.evaluate(() => {
    const win = globalThis as unknown as PageWindow;
    const doc = win.document;
    const text = (selector: string): string => {
      const node = doc.querySelector(selector);
      return node?.textContent?.trim() ?? '';
    };
    const card = doc.querySelector('.status-card');
    const family = doc.querySelector('.announce-family');
    const scroll = doc.getElementById('scroll');
    if (!card || !family || !scroll) throw new Error('announcement is not rendered');
    const cardBox = card.getBoundingClientRect();
    return {
      kicker: text('.status-eyebrow'),
      given: text('.announce-given'),
      family: text('.announce-family'),
      credit: text('.status-line'),
      manager: text('.status-line .picked'),
      teamAttr: card.getAttribute('data-team'),
      nameplate: doc.querySelector('.announce-team')?.textContent ?? null,
      accent: win.getComputedStyle(doc.querySelector('.status-eyebrow') ?? card).color,
      familyFontSize: parseFloat(win.getComputedStyle(family).fontSize),
      // the fitter's whole job: the hero must never spill out of its column
      familyOverflows: family.scrollWidth > family.clientWidth + 1,
      cardHeight: cardBox.height,
      cardWidth: cardBox.width,
      cardTop: cardBox.top,
      scrollTop: scroll.getBoundingClientRect().top,
      density: scroll.className,
    };
  }) as Promise<AnnouncementSnapshot>;
}

/** The end of the last entrance animation, in ms from `reset()`. */
async function entranceEndsAtMs(): Promise<number> {
  return page.raw.evaluate(() => {
    interface Timing {
      delay?: number | null;
      duration?: number | string | null;
    }
    interface Animation {
      effect: { getTiming(): Timing } | null;
    }
    const doc = (globalThis as unknown as PageWindow).document;
    const card = doc.querySelector('.status-card') as unknown as {
      getAnimations(options: { subtree: boolean }): Animation[];
    } | null;
    if (!card) return 0;
    return card.getAnimations({ subtree: true }).reduce((latest, animation) => {
      const timing = animation.effect?.getTiming();
      const delay = Number(timing?.delay ?? 0);
      const duration = Number(timing?.duration ?? 0);
      const end = (Number.isFinite(delay) ? delay : 0) + (Number.isFinite(duration) ? duration : 0);
      return Math.max(latest, end);
    }, 0);
  });
}

// ---------------------------------------------------------------------------

describe('the announcement copy', () => {
  it(
    'makes the player the hero and the manager the credit',
    async () => {
      await page.render(payload());
      const view = await snapshot();

      expect(view.kicker).toContain('Round 9');
      expect(view.kicker).toContain('Pick 119');
      expect(view.given).toBe('Travis');
      expect(view.family).toBe('Kelce');
      expect(view.manager).toBe('RadebergBearTheater');
      // the name has to outrank everything else on the canvas
      expect(view.familyFontSize).toBeGreaterThan(80);
      expect(view.familyOverflows).toBe(false);
    },
    TEST_TIMEOUT,
  );

  it(
    'drops the round from the kicker when the pick has none',
    async () => {
      await page.render(payload({ pick: { ...payload().pick, round: null } }));
      const view = await snapshot();

      expect(view.kicker).toContain('Pick 119');
      expect(view.kicker).not.toMatch(/round/i);
      expect(view.kicker).not.toMatch(/null|undefined/i);
      expect(view.family).toBe('Kelce');
    },
    TEST_TIMEOUT,
  );

  it(
    'keeps a one-word name on the hero line with no credit above it',
    async () => {
      await page.render(payload({ pick: { ...payload().pick, playerName: 'Ocho' } }));
      const view = await snapshot();

      expect(view.given).toBe('');
      expect(view.family).toBe('Ocho');
    },
    TEST_TIMEOUT,
  );

  it(
    'still shows the credit line when the payload overrides it',
    async () => {
      await page.render(payload({ statusLine: 'Traded to Nordzone moments later' }));
      const view = await snapshot();

      expect(view.credit).toBe('Traded to Nordzone moments later');
      expect(view.family).toBe('Kelce');
    },
    TEST_TIMEOUT,
  );
});

describe('the team stage light', () => {
  it(
    'keys the accent off the drafted player chip',
    async () => {
      await page.render(payload());
      const view = await snapshot();

      expect(view.teamAttr).toBe('KC');
      expect(view.nameplate).toBe('KC · TE');
    },
    TEST_TIMEOUT,
  );

  it(
    'falls back to the house accent for an unknown or missing team',
    async () => {
      await page.render(payload());
      const known = await snapshot();

      // no chip at all -> no team key, no nameplate
      await page.render(payload({ reactions: [{ ...reaction(), teamChip: undefined }] }));
      const bare = await snapshot();
      expect(bare.teamAttr).toBeNull();
      expect(bare.nameplate).toBeNull();

      // an abbreviation with no palette entry -> keyed, but nothing overrides
      await page.render(payload({ reactions: [reaction({ teamChip: 'ZZZ · TE' })] }));
      const unknown = await snapshot();
      expect(unknown.teamAttr).toBe('ZZZ');

      // both land on the same house amber, and it is not the KC accent
      expect(unknown.accent).toBe(bare.accent);
      expect(unknown.accent).not.toBe(known.accent);
    },
    TEST_TIMEOUT,
  );
});

describe('names that do not fit', () => {
  it(
    'shrinks a very long surname instead of letting it overflow',
    async () => {
      const long = 'Bartholomew Featherstonehaugh-Wollensky';
      await page.render(payload({ pick: { ...payload().pick, playerName: long } }));
      const view = await snapshot();

      expect(view.family).toBe('Featherstonehaugh-Wollensky');
      expect(view.familyOverflows).toBe(false);
      // shrunk from the ceiling, but never below the floor
      expect(view.familyFontSize).toBeLessThan(80);
      expect(view.familyFontSize).toBeGreaterThanOrEqual(40);
      expect(view.cardWidth).toBe(992);
    },
    TEST_TIMEOUT,
  );

  it(
    'survives a very long manager name without widening the card',
    async () => {
      await page.render(
        payload({ pick: { ...payload().pick, managerName: 'Tucker forever #9 Goat' } }),
      );
      const view = await snapshot();

      expect(view.manager).toBe('Tucker forever #9 Goat');
      expect(view.cardWidth).toBe(992);
    },
    TEST_TIMEOUT,
  );
});

describe('the entrance', () => {
  it(
    'plays on reset(), never on render(), and is over inside the status pause',
    async () => {
      await page.render(payload());
      expect(await entranceEndsAtMs()).toBe(0);

      await page.reset(payload());
      const endsAt = await entranceEndsAtMs();
      expect(endsAt).toBeGreaterThan(0);
      // video.ts pauses STATUS_PAUSE_MS (700) before the first bubble
      expect(endsAt).toBeLessThanOrEqual(700);
    },
    TEST_TIMEOUT,
  );
});

describe('a long thread', () => {
  it(
    'tightens the chat rather than pushing the announcement off the canvas',
    async () => {
      const text = 'Nine rounds of this and somebody finally said my name out loud. '.repeat(2);
      const many = Array.from({ length: 5 }, (_, index) =>
        reaction({
          speakerPlayerId: index === 0 ? '1466' : `900${index}`,
          speakerName: index === 0 ? 'Travis Kelce' : `Speaker ${index}`,
          text,
          delayMs: index * 900,
        }),
      );

      await page.render(payload({ reactions: [many[0] as RenderPayloadReaction] }));
      const light = await snapshot();
      expect(light.density).toBe('');

      await page.render(payload({ reactions: many }));
      const heavy = await snapshot();

      expect(heavy.density).not.toBe('');
      // the announcement stays whole; the chat is what gave way
      expect(heavy.cardTop).toBeGreaterThanOrEqual(heavy.scrollTop);
      expect(heavy.cardHeight).toBeGreaterThan(300);
    },
    TEST_TIMEOUT,
  );
});
