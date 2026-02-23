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

export function registerMessageHandler(app: App): void {
  app.message(async ({ message, client }) => {
    const msg = message as SlackMessage;

    // Ignore bot messages and message edits
    if (msg.subtype || msg.bot_id) return;
    if (!msg.text) return;

    // Reload config on every message so self-edits take effect
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

    // Add hourglass reaction to show we're processing
    try {
      await client.reactions.add({
        channel: msg.channel,
        timestamp: msg.ts,
        name: 'hourglass_flowing_sand',
      });
    } catch {
      // Reaction may fail if already added, ignore
    }

    try {
      console.log(
        `[${channelConfig.name}] Processing message from ${msg.user}: ${msg.text.substring(0, 80)}...`,
      );

      const result = await runClaude({
        message: msg.text,
        cwd: channelConfig.folder,
        model: channelConfig.model,
        systemPrompt: channelConfig.systemPrompt,
        timeoutMs: channelConfig.timeoutMs,
        channelId: msg.channel,
      });

      // Remove hourglass, add checkmark
      try {
        await client.reactions.remove({
          channel: msg.channel,
          timestamp: msg.ts,
          name: 'hourglass_flowing_sand',
        });
        await client.reactions.add({
          channel: msg.channel,
          timestamp: msg.ts,
          name: 'white_check_mark',
        });
      } catch {
        // Ignore reaction errors
      }

      await sendResponse(client, msg.channel, threadTs, result.response);

      if (result.cost !== null) {
        console.log(`[${channelConfig.name}] Cost: $${result.cost.toFixed(4)}`);
      }
    } catch (err) {
      // Remove hourglass, add error reaction
      try {
        await client.reactions.remove({
          channel: msg.channel,
          timestamp: msg.ts,
          name: 'hourglass_flowing_sand',
        });
        await client.reactions.add({
          channel: msg.channel,
          timestamp: msg.ts,
          name: 'x',
        });
      } catch {
        // Ignore reaction errors
      }

      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[${channelConfig.name}] Error:`, errorMsg);

      await client.chat.postMessage({
        channel: msg.channel,
        thread_ts: threadTs,
        text: `:warning: Error: ${errorMsg}`,
      });
    }
  });
}
