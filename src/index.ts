import 'dotenv/config';
import { App } from '@slack/bolt';
import { loadConfig } from './config.js';
import { registerMessageHandler } from './slack.js';

const { SLACK_BOT_TOKEN, SLACK_APP_TOKEN } = process.env;

if (!SLACK_BOT_TOKEN || !SLACK_APP_TOKEN) {
  console.error('Missing SLACK_BOT_TOKEN or SLACK_APP_TOKEN in .env');
  process.exit(1);
}

const config = loadConfig();

const app = new App({
  token: SLACK_BOT_TOKEN,
  socketMode: true,
  appToken: SLACK_APP_TOKEN,
});

registerMessageHandler(app);

await app.start();

console.log('Claudeway started');
console.log('Configured channels:');
for (const [id, ch] of Object.entries(config.channels)) {
  console.log(`  #${ch.name} (${id}) -> ${ch.folder}`);
}
