import { render } from './src/render/index.js';
import { buildTimeline, frameCountFor } from './src/render/video.js';
import { preparePayload } from './src/render/payload.js';
import { stubReaction, loungeMessage } from './src/render/__tests__/fixtures.js';
import { loadConfig } from './src/config.js';

const reaction = stubReaction();
const config = await loadConfig();
const opts = {
  recentMessages: [loungeMessage(1), loungeMessage(2), loungeMessage(3)],
  playerMeta: {
    '4046': { nflTeam: 'KC', position: 'TE' },
    '96': { nflTeam: 'PIT', position: 'QB' },
    '4034': { nflTeam: 'KC', position: 'QB' },
  },
  headshotOptions: { download: false },
  config,
};
const payload = await preparePayload(reaction, opts);
const timeline = buildTimeline(payload, {
  durationSeconds: config.rendering.defaultDurationSeconds,
  showTypingIndicators: config.rendering.showTypingIndicators,
});
console.log('timeline durationMs', timeline.durationMs, 'events', timeline.events.length);
console.log('frames @12fps', frameCountFor(timeline.durationMs, 12));

for (const format of ['mp4', 'gif'] as const) {
  const t0 = Date.now();
  const out = await render(reaction, { ...opts, format, out: `output/sample-reaction.${format}` });
  console.log(format, out, Date.now() - t0, 'ms');
}
