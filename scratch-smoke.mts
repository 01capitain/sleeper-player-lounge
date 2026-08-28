import { render } from './src/render/index.js';
import { stubReaction, loungeMessage } from './src/render/__tests__/fixtures.js';

const reaction = stubReaction();
const started = Date.now();
const out = await render(reaction, {
  format: 'png',
  out: 'output/sample-reaction.png',
  recentMessages: [loungeMessage(1), loungeMessage(2), loungeMessage(3)],
  playerMeta: {
    '4046': { nflTeam: 'KC', position: 'TE' },
    '96': { nflTeam: 'PIT', position: 'QB' },
    '4034': { nflTeam: 'KC', position: 'QB' },
  },
  headshotOptions: { download: false },
});
console.log('wrote', out, 'in', Date.now() - started, 'ms');
