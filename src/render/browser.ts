/**
 * Playwright driver for `templates/lounge.html`.
 *
 * The template is a finished, self-contained page loaded over `file://` — no
 * server, no bundler, no network. It reveals nothing on its own: every bubble
 * appears because this driver called `revealNext()`. That is what makes frame
 * capture deterministic, so this wrapper stays deliberately thin and never adds
 * timing logic of its own beyond the documented transition settle.
 *
 * A `LoungeBrowser` owns one chromium process and can hand out many pages, so a
 * batch render pays the ~300ms launch cost once. Both `withLoungeBrowser` and
 * `withLoungePage` close what they opened in a `finally`.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

import { repoRoot } from '../paths.js';
import type { RenderPayload } from './payload.js';

/** The master canvas from docs/render_spec.md. `#stage` is exactly this size. */
export const STAGE_WIDTH = 1080;
export const STAGE_HEIGHT = 1920;

/** CSS reveal transition is 150ms; the template's contract says wait >=200ms. */
export const SETTLE_MS = 220;

/** `templates/` sits next to `src/` and `dist/`, so it resolves from the repo root. */
export const templatesDir = path.join(repoRoot, 'templates');
export const loungeTemplateFile = path.join(templatesDir, 'lounge.html');

/** Mirror of the `window.LOUNGE` surface documented in `templates/render.js`. */
interface LoungeApi {
  ready: boolean;
  render(payload: RenderPayload): void;
  reset(payload: RenderPayload): void;
  showTyping(speakerPlayerId: string): void;
  hideTyping(): void;
  revealNext(): boolean;
  messageCount(): number;
  revealedCount(): number;
}

export interface LoungeBrowserOptions {
  /** Headless by default; `false` is for eyeballing the template by hand. */
  headless?: boolean;
  /** Absolute path to the template. Defaults to `templates/lounge.html`. */
  templateFile?: string;
  /** 1 keeps the master canvas 1:1 with the PNG. Raise only for retina exports. */
  deviceScaleFactor?: number;
}

export interface StageBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One initialised template page. Every method is a thin `evaluate` bridge. */
export class LoungePage {
  constructor(
    private readonly page: Page,
    private readonly context: BrowserContext,
  ) {}

  /** Escape hatch for anything this wrapper does not cover. */
  get raw(): Page {
    return this.page;
  }

  /** Final state: everything visible. The PNG path. */
  async render(payload: RenderPayload): Promise<void> {
    await this.page.evaluate((data) => {
      const api = (globalThis as { LOUNGE?: LoungeApi }).LOUNGE;
      if (!api) throw new Error('window.LOUNGE is not available');
      api.render(data);
    }, payload);
  }

  /** Opening state: previous messages + status card, every reaction hidden. */
  async reset(payload: RenderPayload): Promise<void> {
    await this.page.evaluate((data) => {
      const api = (globalThis as { LOUNGE?: LoungeApi }).LOUNGE;
      if (!api) throw new Error('window.LOUNGE is not available');
      api.reset(data);
    }, payload);
  }

  async showTyping(speakerPlayerId: string): Promise<void> {
    await this.page.evaluate((id) => {
      const api = (globalThis as { LOUNGE?: LoungeApi }).LOUNGE;
      if (!api) throw new Error('window.LOUNGE is not available');
      api.showTyping(id);
    }, speakerPlayerId);
  }

  async hideTyping(): Promise<void> {
    await this.page.evaluate(() => {
      const api = (globalThis as { LOUNGE?: LoungeApi }).LOUNGE;
      if (!api) throw new Error('window.LOUNGE is not available');
      api.hideTyping();
    });
  }

  /** Reveals exactly one bubble. `false` once none remain. */
  async revealNext(): Promise<boolean> {
    return this.page.evaluate(() => {
      const api = (globalThis as { LOUNGE?: LoungeApi }).LOUNGE;
      if (!api) throw new Error('window.LOUNGE is not available');
      return api.revealNext();
    });
  }

  async messageCount(): Promise<number> {
    return this.page.evaluate(() => {
      const api = (globalThis as { LOUNGE?: LoungeApi }).LOUNGE;
      if (!api) throw new Error('window.LOUNGE is not available');
      return api.messageCount();
    });
  }

  async revealedCount(): Promise<number> {
    return this.page.evaluate(() => {
      const api = (globalThis as { LOUNGE?: LoungeApi }).LOUNGE;
      if (!api) throw new Error('window.LOUNGE is not available');
      return api.revealedCount();
    });
  }

  /** Wait out the 150ms reveal transition so the next frame is settled. */
  async settle(ms: number = SETTLE_MS): Promise<void> {
    await this.page.waitForTimeout(ms);
  }

  /** Screenshot `#stage` (exactly 1080x1920), never the viewport. */
  async screenshotStage(outPath: string): Promise<string> {
    await this.page.locator('#stage').screenshot({ path: outPath, animations: 'disabled' });
    return outPath;
  }

  /** The measured `#stage` box — the render regression test asserts on this. */
  async stageBox(): Promise<StageBox> {
    const box = await this.page.locator('#stage').boundingBox();
    if (!box) throw new Error('Lounge template: #stage has no bounding box');
    return box;
  }

  async close(): Promise<void> {
    await this.context.close();
  }
}

/** One chromium process, reused across a batch render. */
export class LoungeBrowser {
  constructor(
    private readonly browser: Browser,
    private readonly options: LoungeBrowserOptions,
  ) {}

  /** Open the template in a fresh context and wait for `window.LOUNGE.ready`. */
  async newPage(): Promise<LoungePage> {
    const context = await this.browser.newContext({
      viewport: { width: STAGE_WIDTH, height: STAGE_HEIGHT },
      deviceScaleFactor: this.options.deviceScaleFactor ?? 1,
      // The template renders identically everywhere, but pinning these keeps
      // date/number formatting and motion out of the frame-to-frame diff.
      reducedMotion: 'no-preference',
      colorScheme: 'dark',
    });
    const page = await context.newPage();
    const file = this.options.templateFile ?? loungeTemplateFile;
    try {
      await page.goto(pathToFileURL(file).href, { waitUntil: 'load' });
      await page.waitForFunction(() => {
        const api = (globalThis as { LOUNGE?: { ready?: boolean } }).LOUNGE;
        return api?.ready === true;
      });
    } catch (error) {
      await context.close().catch(() => undefined);
      throw new Error(
        `Could not initialise the Lounge template at ${file}: ${errorText(error)}`,
      );
    }
    return new LoungePage(page, context);
  }

  async close(): Promise<void> {
    await this.browser.close();
  }
}

/** Launch chromium. Callers must close it — prefer `withLoungeBrowser`. */
export async function launchLoungeBrowser(
  options: LoungeBrowserOptions = {},
): Promise<LoungeBrowser> {
  let browser: Browser;
  try {
    browser = await chromium.launch({ headless: options.headless ?? true });
  } catch (error) {
    throw new Error(
      'Could not launch chromium for rendering. Install the Playwright browser ' +
        `with \`npx playwright install chromium\`. Original error: ${errorText(error)}`,
    );
  }
  return new LoungeBrowser(browser, options);
}

/** Run `fn` against a browser that is always closed afterwards. */
export async function withLoungeBrowser<T>(
  options: LoungeBrowserOptions,
  fn: (browser: LoungeBrowser) => Promise<T>,
): Promise<T> {
  const browser = await launchLoungeBrowser(options);
  try {
    return await fn(browser);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

/**
 * Run `fn` against one ready page. Pass an existing `browser` to reuse a batch
 * render's chromium; that browser is then left open for the caller to close.
 */
export async function withLoungePage<T>(
  options: LoungeBrowserOptions & { browser?: LoungeBrowser },
  fn: (page: LoungePage) => Promise<T>,
): Promise<T> {
  const { browser: existing, ...launchOptions } = options;
  if (existing) {
    const page = await existing.newPage();
    try {
      return await fn(page);
    } finally {
      await page.close().catch(() => undefined);
    }
  }
  return withLoungeBrowser(launchOptions, async (browser) => {
    const page = await browser.newPage();
    try {
      return await fn(page);
    } finally {
      await page.close().catch(() => undefined);
    }
  });
}

/*
 * Note on `page.evaluate`: the callbacks above run inside the browser, where
 * this module's scope does not exist — so each one re-reads `globalThis.LOUNGE`
 * inline rather than calling a shared helper. The tsconfig has no `dom` lib on
 * purpose (this is Node code), which is why the API is reached through a cast on
 * `globalThis` instead of a `declare global` block; the cast is erased before
 * the function is serialised.
 */

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
