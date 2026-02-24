import { mkdirSync, writeFileSync, readFileSync, unlinkSync, readdirSync, existsSync } from 'fs';
import { resolve, join } from 'path';

export interface QueuedMessage {
  channelId: string;
  userId: string;
  text: string;
  ts: string;
  threadTs: string;
  queuedAt: string;
  imagePaths?: string[];
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

export function dequeue(channelId: string, ts: string): boolean {
  const file = messageFile(channelId, ts);
  try {
    unlinkSync(file);
    return true;
  } catch {
    return false;
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

export function updateQueuedText(channelId: string, ts: string, newText: string): boolean {
  const file = messageFile(channelId, ts);
  if (!existsSync(file)) return false;
  try {
    const existing = JSON.parse(readFileSync(file, 'utf-8')) as QueuedMessage;
    existing.text = newText;
    writeFileSync(file, JSON.stringify(existing, null, 2), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

export function getPendingForChannel(channelId: string): QueuedMessage[] {
  return getPending().filter((m) => m.channelId === channelId);
}
