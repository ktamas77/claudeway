import { mkdirSync, writeFileSync, readFileSync, unlinkSync, readdirSync } from 'fs';
import { resolve, join } from 'path';

export interface QueuedMessage {
  channelId: string;
  userId: string;
  text: string;
  ts: string;
  threadTs: string;
  queuedAt: string;
}

const QUEUE_DIR = resolve(process.cwd(), '.queue');

export function ensureQueueDir(): void {
  mkdirSync(QUEUE_DIR, { recursive: true });
}

function messageFile(channelId: string, ts: string): string {
  // Replace dots in ts for safe filenames
  return join(QUEUE_DIR, `${channelId}_${ts.replace('.', '-')}.json`);
}

export function enqueue(msg: QueuedMessage): void {
  const file = messageFile(msg.channelId, msg.ts);
  writeFileSync(file, JSON.stringify(msg, null, 2), 'utf-8');
}

export function dequeue(channelId: string, ts: string): void {
  const file = messageFile(channelId, ts);
  try {
    unlinkSync(file);
  } catch {
    // Already removed
  }
}

export function getPending(): QueuedMessage[] {
  try {
    const files = readdirSync(QUEUE_DIR).filter((f) => f.endsWith('.json'));
    return files
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(QUEUE_DIR, f), 'utf-8')) as QueuedMessage;
        } catch {
          return null;
        }
      })
      .filter((m): m is QueuedMessage => m !== null)
      .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
  } catch {
    return [];
  }
}

export function getPendingForChannel(channelId: string): QueuedMessage[] {
  return getPending().filter((m) => m.channelId === channelId);
}
