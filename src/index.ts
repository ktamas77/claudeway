import 'dotenv/config';
import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { resolve } from 'path';
import { App } from '@slack/bolt';
import { loadConfig } from './config.js';
import { registerMessageHandler, drainAllPending } from './slack.js';
import { ensureQueueDir } from './queue.js';

// Pidfile lock — ensure only one gateway runs at a time
const PIDFILE = resolve(process.cwd(), 'claudeway.pid');

function acquireLock(): void {
  if (existsSync(PIDFILE)) {
    const oldPid = parseInt(readFileSync(PIDFILE, 'utf-8').trim(), 10);
    try {
      process.kill(oldPid, 0);
      console.error(`Another Claudeway instance is running (PID ${oldPid}). Exiting.`);
      process.exit(1);
    } catch {
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

function killOrphanProcesses(): void {
  // Kill any claude -p processes and their child processes from previous runs
  try {
    execSync('pkill -9 -f "claude.*dangerously-skip-permissions" 2>/dev/null', {
      stdio: 'ignore',
    });
  } catch {
    // No orphans found, that's fine
  }
}

async function notifySystemChannel(app: App | null, message: string): Promise<void> {
  if (!app) return;
  try {
    const config = loadConfig();
    if (!config.systemChannel) return;
    await app.client.chat.postMessage({
      channel: config.systemChannel,
      text: message,
    });
  } catch {
    // Best-effort — don't crash on notification failure
  }
}

let slackApp: App | null = null;

function shutdown(): void {
  console.log('Claudeway shutting down');
  // Fire-and-forget shutdown notification, then exit after brief delay
  notifySystemChannel(slackApp, ':wave: Claudeway shutting down').finally(() => {
    killOrphanProcesses();
    releaseLock();
    process.exit(0);
  });
  // Force exit after 3s if notification hangs
  setTimeout(() => {
    killOrphanProcesses();
    releaseLock();
    process.exit(0);
  }, 3000);
}

acquireLock();
killOrphanProcesses();
process.on('exit', releaseLock);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

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

ensureQueueDir();
const config = loadConfig();

const app = new App({
  token: SLACK_BOT_TOKEN,
  socketMode: true,
  appToken: SLACK_APP_TOKEN,
});
slackApp = app;

registerMessageHandler(app);

app.error(async (error) => {
  console.error('Bolt error:', error);
});

await app.start();

const channelCount = Object.keys(config.channels).length;
console.log('Claudeway started');
console.log('Configured channels:');
for (const [id, ch] of Object.entries(config.channels)) {
  console.log(`  #${ch.name} (${id}) -> ${ch.folder}`);
}

await notifySystemChannel(
  app,
  `:rocket: Claudeway started (${channelCount} channel${channelCount === 1 ? '' : 's'} configured)`,
);

// Drain any messages left in queue from before restart
drainAllPending(app);

// Heartbeat — log every 30 minutes so you can tell it's alive
setInterval(
  () => {
    console.log(`[heartbeat] ${new Date().toISOString()} — alive`);
  },
  30 * 60 * 1000,
);
