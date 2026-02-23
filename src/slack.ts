import { App } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadConfig, resolvedChannelConfig, type ResponseMode } from './config.js';
import {
  runClaude,
  runClaudeStreaming,
  runClaudePersistentStreaming,
  getActiveProcesses,
  killProcess,
  killAllProcesses,
} from './claude.js';
import { enqueue, dequeue, getPendingForChannel, getPending, type QueuedMessage } from './queue.js';

interface SlackFile {
  id: string;
  name: string;
  mimetype: string;
  size: number;
  url_private_download?: string;
}

interface SlackMessage {
  text?: string;
  user?: string;
  channel: string;
  ts: string;
  thread_ts?: string;
  subtype?: string;
  bot_id?: string;
  files?: SlackFile[];
}

const SUPPORTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const IMAGE_SIZE_LIMIT = 5 * 1024 * 1024; // 5MB
const IMAGE_TEMP_DIR = join(tmpdir(), 'claudeway-images');

async function downloadSlackImages(files: SlackFile[], token: string): Promise<string[]> {
  const imageFiles = files.filter(
    (f) =>
      f.url_private_download && SUPPORTED_IMAGE_TYPES.has(f.mimetype) && f.size <= IMAGE_SIZE_LIMIT,
  );
  if (imageFiles.length === 0) return [];

  mkdirSync(IMAGE_TEMP_DIR, { recursive: true });

  const paths: string[] = [];
  for (const file of imageFiles) {
    try {
      const res = await fetch(file.url_private_download!, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        console.error(`[images] Failed to download ${file.name}: HTTP ${res.status}`);
        continue;
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      const localPath = join(IMAGE_TEMP_DIR, `${file.id}-${file.name}`);
      writeFileSync(localPath, buffer);
      paths.push(localPath);
      console.log(`[images] Downloaded ${file.name} (${(file.size / 1024).toFixed(1)}KB)`);
    } catch (err) {
      console.error(`[images] Failed to download ${file.name}:`, err);
    }
  }
  return paths;
}

function cleanupImages(paths: string[]): void {
  for (const p of paths) {
    try {
      unlinkSync(p);
    } catch {
      // Already removed
    }
  }
}

const MAX_MESSAGE_LENGTH = 3900;
const FILE_THRESHOLD = 12000;

/**
 * Convert standard Markdown to Slack mrkdwn.
 * Claude Code outputs standard Markdown by default; this ensures it renders
 * correctly in Slack even if the system prompt hint is ignored.
 */
export function markdownToSlackMrkdwn(text: string): string {
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

const STREAM_UPDATE_INTERVAL_MS = 1000;
const STREAMING_INDICATOR = ' :writing_hand:';

class StreamingResponder {
  private client: WebClient;
  private channel: string;
  private threadTs: string;
  private messageTs: string | null = null;
  private fullText = '';
  private lastUpdateLen = 0;
  private updateTimer: ReturnType<typeof setInterval> | null = null;
  private finished = false;

  constructor(client: WebClient, channel: string, threadTs: string) {
    this.client = client;
    this.channel = channel;
    this.threadTs = threadTs;
  }

  onTextDelta(text: string): void {
    this.fullText += text;
    // Start the throttled update loop on first chunk
    if (!this.updateTimer && !this.finished) {
      this.updateTimer = setInterval(() => this.flush(), STREAM_UPDATE_INTERVAL_MS);
      // Post the initial message immediately
      this.flush();
    }
  }

  private async flush(): Promise<void> {
    if (this.fullText.length === 0) return;
    // Skip if no new text — unless finished, where we must update to remove the indicator
    if (!this.finished && this.fullText.length === this.lastUpdateLen) return;

    const displayText = markdownToSlackMrkdwn(this.fullText);
    // Truncate for Slack's single-message limit, append indicator if still streaming
    const truncated =
      displayText.length > MAX_MESSAGE_LENGTH
        ? displayText.substring(0, MAX_MESSAGE_LENGTH - 20) + '\n_[streaming...]_'
        : displayText;
    const withIndicator = this.finished ? truncated : truncated + STREAMING_INDICATOR;

    try {
      if (!this.messageTs) {
        const res = await this.client.chat.postMessage({
          channel: this.channel,
          thread_ts: this.threadTs,
          text: withIndicator,
        });
        this.messageTs = res.ts ?? null;
      } else {
        await this.client.chat.update({
          channel: this.channel,
          ts: this.messageTs,
          text: withIndicator,
        });
      }
      this.lastUpdateLen = this.fullText.length;
    } catch (err) {
      console.error(`[streaming] Failed to update message:`, err);
    }
  }

  async finish(): Promise<void> {
    this.finished = true;
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }
    // Final update to remove the streaming indicator
    if (this.fullText.length > 0) {
      await this.flush();
    }
  }

  getFullText(): string {
    return this.fullText;
  }

  getMessageTs(): string | null {
    return this.messageTs;
  }
}

class NativeStreamingResponder {
  private client: WebClient;
  private channel: string;
  private threadTs: string;
  private streamId: string | null = null;
  private fullText = '';
  private buffer = '';
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private finished = false;

  constructor(client: WebClient, channel: string, threadTs: string) {
    this.client = client;
    this.channel = channel;
    this.threadTs = threadTs;
  }

  onTextDelta(text: string): void {
    this.fullText += text;
    this.buffer += text;
    if (!this.flushTimer && !this.finished) {
      this.flushTimer = setInterval(() => this.flush(), STREAM_UPDATE_INTERVAL_MS);
      // Start the stream immediately on first chunk
      this.startStream();
    }
  }

  private async startStream(): Promise<void> {
    try {
      const res = (await this.client.apiCall('chat.startStream', {
        channel: this.channel,
        thread_ts: this.threadTs,
      })) as { stream_id?: string };
      this.streamId = res.stream_id ?? null;
      // Flush any buffered text
      await this.flush();
    } catch (err) {
      console.error(`[native-stream] Failed to start stream:`, err);
    }
  }

  private async flush(): Promise<void> {
    if (!this.streamId || this.buffer.length === 0) return;

    const chunk = this.buffer;
    this.buffer = '';

    try {
      await this.client.apiCall('chat.appendStream', {
        stream_id: this.streamId,
        text: chunk,
      });
    } catch (err) {
      console.error(`[native-stream] Failed to append:`, err);
    }
  }

  async finish(): Promise<void> {
    this.finished = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.streamId) {
      // Flush remaining buffer
      await this.flush();
      try {
        await this.client.apiCall('chat.stopStream', {
          stream_id: this.streamId,
        });
      } catch (err) {
        console.error(`[native-stream] Failed to stop stream:`, err);
      }
    }
  }

  getFullText(): string {
    return this.fullText;
  }
}

// Per-channel processing lock — one message at a time per channel
const channelBusy = new Set<string>();

// Global concurrency limit for Claude CLI processes
const MAX_CONCURRENT_PROCESSES = 8;
let activeProcesses = 0;
const concurrencyWaiters: (() => void)[] = [];

async function acquireProcessSlot(): Promise<void> {
  if (activeProcesses < MAX_CONCURRENT_PROCESSES) {
    activeProcesses++;
    return;
  }
  await new Promise<void>((resolve) => concurrencyWaiters.push(resolve));
  activeProcesses++;
}

function releaseProcessSlot(): void {
  activeProcesses--;
  const next = concurrencyWaiters.shift();
  if (next) next();
}

export function splitMessage(text: string): string[] {
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

async function processBatch(
  queued: QueuedMessage,
  client: WebClient,
  channelConfig: ReturnType<typeof resolvedChannelConfig> & object,
): Promise<void> {
  try {
    const result = await runClaude({
      message: queued.text,
      cwd: channelConfig.folder,
      model: channelConfig.model,
      systemPrompt: channelConfig.systemPrompt,
      timeoutMs: channelConfig.timeoutMs,
      channelId: queued.channelId,
      imagePaths: queued.imagePaths,
    });

    await safeReact(client, queued.channelId, queued.ts, 'white_check_mark');
    await safeReact(client, queued.channelId, queued.ts, 'hourglass_flowing_sand', 'remove');

    await sendResponse(client, queued.channelId, queued.threadTs, result.response);

    if (result.cost !== null) {
      console.log(`[${channelConfig.name}] Cost: $${result.cost.toFixed(4)}`);
    }
  } finally {
    if (queued.imagePaths) cleanupImages(queued.imagePaths);
  }
}

async function processStreamUpdate(
  queued: QueuedMessage,
  client: WebClient,
  channelConfig: ReturnType<typeof resolvedChannelConfig> & object,
): Promise<void> {
  try {
    const responder = new StreamingResponder(client, queued.channelId, queued.threadTs);

    const result = await runClaudeStreaming({
      message: queued.text,
      cwd: channelConfig.folder,
      model: channelConfig.model,
      systemPrompt: channelConfig.systemPrompt,
      timeoutMs: channelConfig.timeoutMs,
      channelId: queued.channelId,
      imagePaths: queued.imagePaths,
      onTextDelta: (text) => responder.onTextDelta(text),
    });

    await responder.finish();

    await safeReact(client, queued.channelId, queued.ts, 'white_check_mark');
    await safeReact(client, queued.channelId, queued.ts, 'hourglass_flowing_sand', 'remove');

    // If final response exceeds file threshold, upload as file and delete the streamed message
    const finalText = result.response || responder.getFullText();
    if (finalText.length > FILE_THRESHOLD) {
      // Delete the streamed message and upload as file instead
      const msgTs = responder.getMessageTs();
      if (msgTs) {
        try {
          await client.chat.delete({ channel: queued.channelId, ts: msgTs });
        } catch {
          // Best effort — may lack permission
        }
      }
      await client.files.uploadV2({
        channel_id: queued.channelId,
        thread_ts: queued.threadTs,
        content: finalText,
        filename: 'response.md',
        title: 'Response',
      });
    } else if (finalText.length > MAX_MESSAGE_LENGTH) {
      // Final text fits in messages but was truncated during streaming — do a final complete send
      const formatted = markdownToSlackMrkdwn(finalText);
      const chunks = splitMessage(formatted);
      // Update the existing message with the first chunk
      const msgTs = responder.getMessageTs();
      if (msgTs && chunks.length > 0) {
        try {
          await client.chat.update({
            channel: queued.channelId,
            ts: msgTs,
            text: chunks[0],
          });
        } catch {
          // Fall through to post
        }
        // Post remaining chunks as follow-up messages
        for (let i = 1; i < chunks.length; i++) {
          await client.chat.postMessage({
            channel: queued.channelId,
            thread_ts: queued.threadTs,
            text: chunks[i],
          });
        }
      }
    }

    if (result.cost !== null) {
      console.log(`[${channelConfig.name}] Cost: $${result.cost.toFixed(4)}`);
    }
  } finally {
    if (queued.imagePaths) cleanupImages(queued.imagePaths);
  }
}

async function processStreamNative(
  queued: QueuedMessage,
  client: WebClient,
  channelConfig: ReturnType<typeof resolvedChannelConfig> & object,
): Promise<void> {
  try {
    const responder = new NativeStreamingResponder(client, queued.channelId, queued.threadTs);

    const result = await runClaudeStreaming({
      message: queued.text,
      cwd: channelConfig.folder,
      model: channelConfig.model,
      systemPrompt: channelConfig.systemPrompt,
      timeoutMs: channelConfig.timeoutMs,
      channelId: queued.channelId,
      imagePaths: queued.imagePaths,
      onTextDelta: (text) => responder.onTextDelta(text),
    });

    await responder.finish();

    await safeReact(client, queued.channelId, queued.ts, 'white_check_mark');
    await safeReact(client, queued.channelId, queued.ts, 'hourglass_flowing_sand', 'remove');

    // Native streaming handles display automatically; fall back to file upload for huge responses
    const finalText = result.response || responder.getFullText();
    if (finalText.length > FILE_THRESHOLD) {
      await client.files.uploadV2({
        channel_id: queued.channelId,
        thread_ts: queued.threadTs,
        content: finalText,
        filename: 'response.md',
        title: 'Response',
      });
    }

    if (result.cost !== null) {
      console.log(`[${channelConfig.name}] Cost: $${result.cost.toFixed(4)}`);
    }
  } finally {
    if (queued.imagePaths) cleanupImages(queued.imagePaths);
  }
}

async function processPersistent(
  queued: QueuedMessage,
  client: WebClient,
  channelConfig: ReturnType<typeof resolvedChannelConfig> & object,
): Promise<void> {
  const mode = channelConfig.responseMode;

  if (mode === 'batch') {
    // No streaming output needed — use a no-op delta handler
    try {
      const result = await runClaudePersistentStreaming({
        message: queued.text,
        cwd: channelConfig.folder,
        model: channelConfig.model,
        systemPrompt: channelConfig.systemPrompt,
        timeoutMs: channelConfig.timeoutMs,
        channelId: queued.channelId,
        imagePaths: queued.imagePaths,
        onTextDelta: () => {},
      });

      await safeReact(client, queued.channelId, queued.ts, 'white_check_mark');
      await safeReact(client, queued.channelId, queued.ts, 'hourglass_flowing_sand', 'remove');
      await sendResponse(client, queued.channelId, queued.threadTs, result.response);

      if (result.cost !== null) {
        console.log(`[${channelConfig.name}] Cost: $${result.cost.toFixed(4)}`);
      }
    } finally {
      if (queued.imagePaths) cleanupImages(queued.imagePaths);
    }
  } else if (mode === 'stream-update') {
    try {
      const responder = new StreamingResponder(client, queued.channelId, queued.threadTs);

      const result = await runClaudePersistentStreaming({
        message: queued.text,
        cwd: channelConfig.folder,
        model: channelConfig.model,
        systemPrompt: channelConfig.systemPrompt,
        timeoutMs: channelConfig.timeoutMs,
        channelId: queued.channelId,
        imagePaths: queued.imagePaths,
        onTextDelta: (text) => responder.onTextDelta(text),
      });

      await responder.finish();
      await safeReact(client, queued.channelId, queued.ts, 'white_check_mark');
      await safeReact(client, queued.channelId, queued.ts, 'hourglass_flowing_sand', 'remove');

      const finalText = result.response || responder.getFullText();
      if (finalText.length > FILE_THRESHOLD) {
        const msgTs = responder.getMessageTs();
        if (msgTs) {
          try {
            await client.chat.delete({ channel: queued.channelId, ts: msgTs });
          } catch {
            // Best effort
          }
        }
        await client.files.uploadV2({
          channel_id: queued.channelId,
          thread_ts: queued.threadTs,
          content: finalText,
          filename: 'response.md',
          title: 'Response',
        });
      } else if (finalText.length > MAX_MESSAGE_LENGTH) {
        const formatted = markdownToSlackMrkdwn(finalText);
        const chunks = splitMessage(formatted);
        const msgTs = responder.getMessageTs();
        if (msgTs && chunks.length > 0) {
          try {
            await client.chat.update({ channel: queued.channelId, ts: msgTs, text: chunks[0] });
          } catch {
            // Fall through
          }
          for (let i = 1; i < chunks.length; i++) {
            await client.chat.postMessage({
              channel: queued.channelId,
              thread_ts: queued.threadTs,
              text: chunks[i],
            });
          }
        }
      }

      if (result.cost !== null) {
        console.log(`[${channelConfig.name}] Cost: $${result.cost.toFixed(4)}`);
      }
    } finally {
      if (queued.imagePaths) cleanupImages(queued.imagePaths);
    }
  } else {
    // stream-native
    try {
      const responder = new NativeStreamingResponder(client, queued.channelId, queued.threadTs);

      const result = await runClaudePersistentStreaming({
        message: queued.text,
        cwd: channelConfig.folder,
        model: channelConfig.model,
        systemPrompt: channelConfig.systemPrompt,
        timeoutMs: channelConfig.timeoutMs,
        channelId: queued.channelId,
        imagePaths: queued.imagePaths,
        onTextDelta: (text) => responder.onTextDelta(text),
      });

      await responder.finish();
      await safeReact(client, queued.channelId, queued.ts, 'white_check_mark');
      await safeReact(client, queued.channelId, queued.ts, 'hourglass_flowing_sand', 'remove');

      const finalText = result.response || responder.getFullText();
      if (finalText.length > FILE_THRESHOLD) {
        await client.files.uploadV2({
          channel_id: queued.channelId,
          thread_ts: queued.threadTs,
          content: finalText,
          filename: 'response.md',
          title: 'Response',
        });
      }

      if (result.cost !== null) {
        console.log(`[${channelConfig.name}] Cost: $${result.cost.toFixed(4)}`);
      }
    } finally {
      if (queued.imagePaths) cleanupImages(queued.imagePaths);
    }
  }
}

const MODE_PROCESSORS: Record<
  ResponseMode,
  (
    queued: QueuedMessage,
    client: WebClient,
    config: ReturnType<typeof resolvedChannelConfig> & object,
  ) => Promise<void>
> = {
  batch: processBatch,
  'stream-update': processStreamUpdate,
  'stream-native': processStreamNative,
};

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
  await safeReact(client, queued.channelId, queued.ts, 'inbox_tray', 'remove');

  const mode = channelConfig.responseMode;

  // Wait for a process slot if at global concurrency limit
  if (activeProcesses >= MAX_CONCURRENT_PROCESSES) {
    console.log(
      `[${channelConfig.name}] Waiting for process slot (${activeProcesses}/${MAX_CONCURRENT_PROCESSES} active)`,
    );
  }
  await acquireProcessSlot();

  const processMode = channelConfig.processMode;
  console.log(
    `[${channelConfig.name}] Processing (${processMode}/${mode}): ${queued.text.substring(0, 80)}...`,
  );

  try {
    if (processMode === 'persistent') {
      await processPersistent(queued, client, channelConfig);
    } else {
      await MODE_PROCESSORS[mode](queued, client, channelConfig);
    }
  } catch (err) {
    await safeReact(client, queued.channelId, queued.ts, 'x');
    await safeReact(client, queued.channelId, queued.ts, 'hourglass_flowing_sand', 'remove');

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
  releaseProcessSlot();
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

// --- Magic command helpers ---

function getChannelName(channelId: string): string {
  try {
    const config = loadConfig();
    return config.channels[channelId]?.name ?? channelId;
  } catch {
    return channelId;
  }
}

function findChannelIdByName(name: string): string | null {
  try {
    const config = loadConfig();
    for (const [id, ch] of Object.entries(config.channels)) {
      if (ch.name === name) return id;
    }
  } catch {
    // Config error
  }
  return null;
}

export function formatDuration(startedAt: Date): string {
  const ms = Date.now() - startedAt.getTime();
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

async function handlePs(channelId: string, threadTs: string, client: WebClient): Promise<void> {
  const processes = getActiveProcesses();
  const pending = getPending();

  let text: string;
  if (processes.length === 0) {
    text = ':gear: *No active processes*';
  } else {
    const lines = processes.map((p) => {
      const name = getChannelName(p.channelId);
      const duration = formatDuration(p.startedAt);
      const snippet = p.message.length >= 80 ? p.message + '...' : p.message;
      return `\u2022 #${name} \u2014 ${duration} \u2014 "${snippet}"`;
    });
    text = `:gear: *Active Processes (${processes.length}/${MAX_CONCURRENT_PROCESSES})*\n\n${lines.join('\n')}`;
  }

  if (pending.length > 0) {
    const channelCounts = new Map<string, number>();
    for (const msg of pending) {
      const name = getChannelName(msg.channelId);
      channelCounts.set(name, (channelCounts.get(name) ?? 0) + 1);
    }
    const breakdown = Array.from(channelCounts.entries())
      .map(([name, count]) => `${count} ${name}`)
      .join(', ');
    text += `\n\nQueued: ${pending.length} message${pending.length !== 1 ? 's' : ''} (${breakdown})`;
  }

  await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text });
}

async function handleKill(
  targetChannelId: string,
  responseChannelId: string,
  threadTs: string,
  client: WebClient,
): Promise<void> {
  const processes = getActiveProcesses();
  const target = processes.find((p) => p.channelId === targetChannelId);

  if (!target) {
    const name = getChannelName(targetChannelId);
    await client.chat.postMessage({
      channel: responseChannelId,
      thread_ts: threadTs,
      text: `:warning: No active process in #${name}`,
    });
    return;
  }

  const name = getChannelName(targetChannelId);
  const duration = formatDuration(target.startedAt);
  const killed = killProcess(targetChannelId);

  if (killed) {
    await client.chat.postMessage({
      channel: responseChannelId,
      thread_ts: threadTs,
      text: `:stop_sign: Killed process in #${name} (was running ${duration})`,
    });
  } else {
    await client.chat.postMessage({
      channel: responseChannelId,
      thread_ts: threadTs,
      text: `:warning: Failed to kill process in #${name}`,
    });
  }
}

async function handleKillAll(
  channelId: string,
  threadTs: string,
  client: WebClient,
): Promise<void> {
  const processes = getActiveProcesses();
  if (processes.length === 0) {
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: ':stop_sign: No active processes to kill',
    });
    return;
  }

  const killed = killAllProcesses();
  const names = killed.map((id) => `#${getChannelName(id)}`).join(', ');
  await client.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    text: `:stop_sign: Killed ${killed.length} process${killed.length !== 1 ? 'es' : ''}: ${names}`,
  });
}

async function handleMagicCommand(
  text: string,
  channelId: string,
  threadTs: string,
  client: WebClient,
): Promise<boolean> {
  const trimmed = text.trim();

  if (trimmed === '!ps') {
    await handlePs(channelId, threadTs, client);
    return true;
  }

  if (trimmed === '!killall') {
    await handleKillAll(channelId, threadTs, client);
    return true;
  }

  if (trimmed === '!kill') {
    await handleKill(channelId, channelId, threadTs, client);
    return true;
  }

  // !kill #channel, !kill channel, or !kill <#C123|channel>
  const killMatch = trimmed.match(/^!kill\s+(?:<#(\w+)(?:\|[^>]*)?>|#?(\S+))$/);
  if (killMatch) {
    const slackChannelId = killMatch[1];
    const targetName = killMatch[2];

    let resolvedId: string | null = slackChannelId ?? null;
    if (!resolvedId && targetName) {
      resolvedId = findChannelIdByName(targetName);
      if (!resolvedId) {
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: `:warning: No configured channel named "${targetName}"`,
        });
        return true;
      }
    }

    if (resolvedId) {
      await handleKill(resolvedId, channelId, threadTs, client);
    }
    return true;
  }

  return false;
}

export function registerMessageHandler(app: App): void {
  app.message(async ({ message, client, context }) => {
    const msg = message as SlackMessage;

    // Ignore bot messages and message edits (allow file_share for image attachments)
    if (msg.bot_id) return;
    if (msg.subtype && msg.subtype !== 'file_share') return;

    // Handle magic commands (!ps, !kill, !killall) — bypass queue and Claude processing
    if (
      msg.text &&
      (await handleMagicCommand(msg.text, msg.channel, msg.thread_ts ?? msg.ts, client))
    ) {
      return;
    }

    const hasText = !!msg.text;
    const hasImages = !!(
      msg.files &&
      msg.files.some((f) => f.url_private_download && SUPPORTED_IMAGE_TYPES.has(f.mimetype))
    );
    // Require at least text or images
    if (!hasText && !hasImages) return;

    // Quick config check
    try {
      const config = loadConfig();
      if (!resolvedChannelConfig(config, msg.channel)) return;
    } catch {
      return;
    }

    // Download image attachments before enqueueing
    let imagePaths: string[] = [];
    if (hasImages && msg.files) {
      const token = context.botToken ?? process.env.SLACK_BOT_TOKEN ?? '';
      imagePaths = await downloadSlackImages(msg.files, token);
    }

    const threadTs = msg.thread_ts ?? msg.ts;
    const text = msg.text || (imagePaths.length > 0 ? 'What is in this image?' : '');

    // Persist to queue
    enqueue({
      channelId: msg.channel,
      userId: msg.user ?? 'unknown',
      text,
      ts: msg.ts,
      threadTs,
      queuedAt: new Date().toISOString(),
      ...(imagePaths.length > 0 ? { imagePaths } : {}),
    });

    // Acknowledge receipt immediately
    await safeReact(client, msg.channel, msg.ts, 'inbox_tray');

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
