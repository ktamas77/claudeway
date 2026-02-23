import { App } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { loadConfig, resolvedChannelConfig } from './config.js';
import { runClaude } from './claude.js';

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

// Per-channel processing lock — one message at a time per channel
const channelBusy = new Set<string>();

// Per-channel message queue — holds the latest pending message per channel
const channelQueue = new Map<string, { msg: SlackMessage; client: WebClient }>();

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

  const chunks = splitMessage(text);
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

async function processMessage(msg: SlackMessage, client: WebClient): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error('Failed to load config:', err);
    return;
  }

  const channelConfig = resolvedChannelConfig(config, msg.channel);
  if (!channelConfig) return;

  const threadTs = msg.thread_ts ?? msg.ts;

  await safeReact(client, msg.channel, msg.ts, 'hourglass_flowing_sand');

  try {
    console.log(`[${channelConfig.name}] Processing: ${msg.text!.substring(0, 80)}...`);

    const result = await runClaude({
      message: msg.text!,
      cwd: channelConfig.folder,
      model: channelConfig.model,
      systemPrompt: channelConfig.systemPrompt,
      timeoutMs: channelConfig.timeoutMs,
      channelId: msg.channel,
    });

    await safeReact(client, msg.channel, msg.ts, 'hourglass_flowing_sand', 'remove');
    await safeReact(client, msg.channel, msg.ts, 'white_check_mark');

    await sendResponse(client, msg.channel, threadTs, result.response);

    if (result.cost !== null) {
      console.log(`[${channelConfig.name}] Cost: $${result.cost.toFixed(4)}`);
    }
  } catch (err) {
    await safeReact(client, msg.channel, msg.ts, 'hourglass_flowing_sand', 'remove');
    await safeReact(client, msg.channel, msg.ts, 'x');

    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[${channelConfig.name}] Error:`, errorMsg);

    try {
      await client.chat.postMessage({
        channel: msg.channel,
        thread_ts: threadTs,
        text: `:warning: Error: ${errorMsg}`,
      });
    } catch (replyErr) {
      console.error(`[${channelConfig.name}] Failed to send error reply:`, replyErr);
    }
  }
}

async function drainQueue(channelId: string): Promise<void> {
  channelBusy.add(channelId);

  try {
    // Process current + any queued message
    while (channelQueue.has(channelId)) {
      const queued = channelQueue.get(channelId)!;
      channelQueue.delete(channelId);
      await processMessage(queued.msg, queued.client);
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

    // Quick config check — don't queue messages for unconfigured channels
    try {
      const config = loadConfig();
      if (!resolvedChannelConfig(config, msg.channel)) return;
    } catch {
      return;
    }

    if (channelBusy.has(msg.channel)) {
      // Channel is busy — queue this message (replaces any previous queued message)
      console.log(`[${msg.channel}] Busy, queuing message`);
      channelQueue.set(msg.channel, { msg, client });
      return;
    }

    // Not busy — put in queue and start draining
    channelQueue.set(msg.channel, { msg, client });
    drainQueue(msg.channel).catch((err) => {
      console.error(`[${msg.channel}] Queue drain error:`, err);
    });
  });
}
