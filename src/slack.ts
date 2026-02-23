import { App } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { loadConfig, resolvedChannelConfig } from './config.js';
import { runClaude } from './claude.js';
import { enqueue, dequeue, getPendingForChannel, type QueuedMessage } from './queue.js';

interface SlackMessage {
  text?: string;
  user?: string;
  channel: string;
  ts: string;
  thread_ts?: string;
  subtype?: string;
  bot_id?: string;
}

const MAX_MESSAGE_LENGTH = 3900;
const FILE_THRESHOLD = 12000;

/**
 * Convert standard Markdown to Slack mrkdwn.
 * Claude Code outputs standard Markdown by default; this ensures it renders
 * correctly in Slack even if the system prompt hint is ignored.
 */
function markdownToSlackMrkdwn(text: string): string {
  let result = text;

  // Convert Markdown links [text](url) → <url|text>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');

  // Convert headings (### text → *text*) — Slack has no heading syntax
  result = result.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');

  // Convert **bold** → *bold* (must come before single-asterisk handling)
  result = result.replace(/\*\*(.+?)\*\*/g, '*$1*');

  // Convert ~~strikethrough~~ → ~strikethrough~
  result = result.replace(/~~(.+?)~~/g, '~$1~');

  // Convert horizontal rules (---, ***, ___) → ———
  result = result.replace(/^(?:[-*_]){3,}\s*$/gm, '———');

  // Strip language tags from fenced code blocks (```js → ```)
  result = result.replace(/```\w+\n/g, '```\n');

  return result;
}

// Per-channel processing lock — one message at a time per channel
const channelBusy = new Set<string>();

function splitMessage(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_MESSAGE_LENGTH) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf('\n', MAX_MESSAGE_LENGTH);
    if (splitAt === -1 || splitAt < MAX_MESSAGE_LENGTH * 0.5) {
      splitAt = MAX_MESSAGE_LENGTH;
    }
    chunks.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt).trimStart();
  }
  return chunks;
}

async function sendResponse(
  client: WebClient,
  channel: string,
  threadTs: string,
  text: string,
): Promise<void> {
  if (text.length > FILE_THRESHOLD) {
    await client.files.uploadV2({
      channel_id: channel,
      thread_ts: threadTs,
      content: text,
      filename: 'response.md',
      title: 'Response',
    });
    return;
  }

  // Convert standard Markdown → Slack mrkdwn before sending
  const formatted = markdownToSlackMrkdwn(text);

  const chunks = splitMessage(formatted);
  for (const chunk of chunks) {
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: chunk,
    });
  }
}

async function safeReact(
  client: WebClient,
  channel: string,
  timestamp: string,
  name: string,
  action: 'add' | 'remove' = 'add',
): Promise<void> {
  try {
    if (action === 'add') {
      await client.reactions.add({ channel, timestamp, name });
    } else {
      await client.reactions.remove({ channel, timestamp, name });
    }
  } catch {
    // Ignore reaction errors
  }
}

async function processQueuedMessage(queued: QueuedMessage, client: WebClient): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error('Failed to load config:', err);
    dequeue(queued.channelId, queued.ts);
    return;
  }

  const channelConfig = resolvedChannelConfig(config, queued.channelId);
  if (!channelConfig) {
    dequeue(queued.channelId, queued.ts);
    return;
  }

  await safeReact(client, queued.channelId, queued.ts, 'hourglass_flowing_sand');

  try {
    console.log(`[${channelConfig.name}] Processing: ${queued.text.substring(0, 80)}...`);

    const result = await runClaude({
      message: queued.text,
      cwd: channelConfig.folder,
      model: channelConfig.model,
      systemPrompt: channelConfig.systemPrompt,
      timeoutMs: channelConfig.timeoutMs,
      channelId: queued.channelId,
    });

    await safeReact(client, queued.channelId, queued.ts, 'hourglass_flowing_sand', 'remove');
    await safeReact(client, queued.channelId, queued.ts, 'white_check_mark');

    await sendResponse(client, queued.channelId, queued.threadTs, result.response);

    if (result.cost !== null) {
      console.log(`[${channelConfig.name}] Cost: $${result.cost.toFixed(4)}`);
    }
  } catch (err) {
    await safeReact(client, queued.channelId, queued.ts, 'hourglass_flowing_sand', 'remove');
    await safeReact(client, queued.channelId, queued.ts, 'x');

    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[${channelConfig.name}] Error:`, errorMsg);

    try {
      await client.chat.postMessage({
        channel: queued.channelId,
        thread_ts: queued.threadTs,
        text: `:warning: Error: ${errorMsg}`,
      });
    } catch (replyErr) {
      console.error(`[${channelConfig.name}] Failed to send error reply:`, replyErr);
    }
  }

  // Remove from persistent queue after processing (success or error)
  dequeue(queued.channelId, queued.ts);
}

async function drainChannel(channelId: string, client: WebClient): Promise<void> {
  channelBusy.add(channelId);

  try {
    let pending = getPendingForChannel(channelId);
    while (pending.length > 0) {
      await processQueuedMessage(pending[0], client);
      pending = getPendingForChannel(channelId);
    }
  } finally {
    channelBusy.delete(channelId);
  }
}

export function registerMessageHandler(app: App): void {
  app.message(async ({ message, client }) => {
    const msg = message as SlackMessage;

    // Ignore bot messages and message edits
    if (msg.subtype || msg.bot_id) return;
    if (!msg.text) return;

    // Quick config check
    try {
      const config = loadConfig();
      if (!resolvedChannelConfig(config, msg.channel)) return;
    } catch {
      return;
    }

    const threadTs = msg.thread_ts ?? msg.ts;

    // Persist to queue
    enqueue({
      channelId: msg.channel,
      userId: msg.user ?? 'unknown',
      text: msg.text,
      ts: msg.ts,
      threadTs,
      queuedAt: new Date().toISOString(),
    });

    if (channelBusy.has(msg.channel)) {
      console.log(`[${msg.channel}] Busy, message queued`);
      return;
    }

    drainChannel(msg.channel, client).catch((err) => {
      console.error(`[${msg.channel}] Queue drain error:`, err);
    });
  });
}

/**
 * Process any messages left in the queue from before a restart.
 * Call after Bolt app.start() with the Slack client.
 */
export function drainAllPending(app: App): void {
  // Drain pending messages for all channels after a short delay
  setTimeout(async () => {
    const { getPending } = await import('./queue.js');
    const pending = getPending();
    if (pending.length === 0) return;

    console.log(`[startup] Found ${pending.length} queued message(s) from before restart`);

    const channels = [...new Set(pending.map((m) => m.channelId))];
    for (const channelId of channels) {
      if (channelBusy.has(channelId)) continue;
      // Use the app's web client
      const client = app.client;
      drainChannel(channelId, client).catch((err) => {
        console.error(`[${channelId}] Startup drain error:`, err);
      });
    }
  }, 3000);
}
