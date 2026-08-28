import { describe, expect, it } from 'vitest';

import { buildHtml } from '../html.js';
import { stubReaction } from './fixtures.js';

describe('standalone HTML output', () => {
  it('inlines the stylesheet and render script instead of linking them', async () => {
    const html = await buildHtml(stubReaction(), { headshotOptions: { download: false } });
    // A linked stylesheet or script would break the moment the file is moved.
    expect(html).not.toMatch(/<link[^>]+lounge\.css/);
    expect(html).not.toMatch(/<script src="render\.js">/);
    expect(html).toContain('window.LOUNGE');
    expect(html).toContain('#stage');
  });

  it('embeds the payload and the timeline so it needs no server', async () => {
    const reaction = stubReaction();
    const html = await buildHtml(reaction, { headshotOptions: { download: false } });
    expect(html).toContain('var PAYLOAD =');
    expect(html).toContain('var TIMELINE =');
    for (const message of reaction.reactions) {
      expect(html).toContain(message.speakerName);
    }
  });

  it('makes no request to any external host', async () => {
    const html = await buildHtml(stubReaction(), { headshotOptions: { download: false } });
    expect(html).not.toMatch(/https?:\/\//);
  });

  it('animates by default and can be built as a still instead', async () => {
    const animated = await buildHtml(stubReaction(), { headshotOptions: { download: false } });
    expect(animated).toContain('var STILL = false');
    const still = await buildHtml(stubReaction(), { still: true, headshotOptions: { download: false } });
    expect(still).toContain('var STILL = true');
  });

  it('escapes the player name in the title', async () => {
    const reaction = stubReaction();
    reaction.pick.playerName = 'Tom <script>alert(1)</script>';
    const html = await buildHtml(reaction, { headshotOptions: { download: false } });
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<title>Players Lounge — Tom <script>');
  });
});
