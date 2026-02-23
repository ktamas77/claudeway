import 'dotenv/config';
import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'fs';
import { resolve } from 'path';
import { App } from '@slack/bolt';
import { loadConfig } from './config.js';
import { registerMessageHandler } from './slack.js';

// Pidfile lock — ensure only one gateway runs at a time
const PIDFILE = resolve(process.cwd(), 'claudeway.pid');

function acquireLock(): void {
  if (existsSync(PIDFILE)) {
    const oldPid = parseInt(readFileSync(PIDFILE, 'utf-8').trim(), 10);
    try {
      process.kill(oldPid, 0); // check if process exists
      console.error(`Another Claudeway instance is running (PID ${oldPid}). Exiting.`);
      process.exit(1);
    } catch {
      // Process doesn't exist, stale pidfile — clean up
      console.log(`Removing stale pidfile (PID ${oldPid})`);
    }
  }
  writeFileSync(PIDFILE, String(process.pid), 'utf-8');
}

function releaseLock(): void {
  try {
    unlinkSync(PIDFILE);
  } catch {
    // ignore
  }
}

acquireLock();
process.on('exit', releaseLock);
process.on('SIGTERM', () => {
  releaseLock();
  process.exit(0);
});
process.on('SIGINT', () => {
  releaseLock();
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

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

app.error(async (error) => {
  console.error('Bolt error:', error);
});

await app.start();

console.log('Claudeway started');
console.log('Configured channels:');
for (const [id, ch] of Object.entries(config.channels)) {
  console.log(`  #${ch.name} (${id}) -> ${ch.folder}`);
}
