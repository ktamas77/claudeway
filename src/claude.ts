import { spawn, type ChildProcess } from 'child_process';
import { existsSync, unlinkSync, rmSync } from 'fs';
import { resolve } from 'path';
import { v5 as uuidv5 } from 'uuid';
import { getConfigPath } from './config.js';

// Re-export ProcessMode for consumers that only import from claude.ts
export type { ProcessMode } from './config.js';

export interface ClaudeOptions {
  message: string;
  cwd: string;
  model: string;
  systemPrompt: string;
  timeoutMs: number;
  channelId: string;
  imagePaths?: string[];
}

export interface ClaudeStreamingOptions extends ClaudeOptions {
  onTextDelta: (text: string) => void;
}

export interface ClaudeResult {
  response: string;
  sessionId: string | null;
  cost: number | null;
  tokens: number | null;
}

// Claudeway namespace UUID for deterministic session IDs
const CLAUDEWAY_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

// Absolute maximum runtime — safety net regardless of activity
const ABSOLUTE_TIMEOUT_MS = 12 * 60 * 60 * 1000; // 12 hours

// --- Process registry for tracking and killing running Claude processes ---

interface ActiveProcess {
  proc: ChildProcess;
  channelId: string;
  sessionId: string;
  startedAt: Date;
  message: string;
  messageCount: number;
  totalCost: number;
  totalTokens: number;
}

const processRegistry = new Map<string, ActiveProcess>();

// --- Persistent process registry ---

interface PersistentProcessEntry {
  proc: ChildProcess;
  channelId: string;
  sessionId: string;
  startedAt: Date;
  lastMessage: string;
  messageCount: number;
  totalCost: number;
  totalTokens: number;
  idleTimer: ReturnType<typeof setTimeout>;
  lineBuffer: string;
  currentTurn: {
    resolve: (r: ClaudeResult) => void;
    reject: (e: Error) => void;
    onTextDelta?: (text: string) => void;
    fullText: string;
    sessionId: string | null;
    cost: number | null;
  } | null;
}

const persistentRegistry = new Map<string, PersistentProcessEntry>();

export interface ActiveProcessInfo {
  channelId: string;
  sessionId: string;
  startedAt: Date;
  message: string;
  messageCount: number;
  totalCost: number;
  totalTokens: number;
  isActive: boolean;
}

export function getActiveProcesses(): ActiveProcessInfo[] {
  const oneshot = Array.from(processRegistry.values()).map(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    ({ proc, ...rest }) => ({ ...rest, isActive: true }),
  );
  const persistent = Array.from(persistentRegistry.values()).map((entry) => ({
    channelId: entry.channelId,
    sessionId: entry.sessionId,
    startedAt: entry.startedAt,
    message: entry.lastMessage,
    messageCount: entry.messageCount,
    totalCost: entry.totalCost,
    totalTokens: entry.totalTokens,
    isActive: entry.currentTurn !== null,
  }));
  return [...oneshot, ...persistent];
}

export function killProcess(channelId: string): boolean {
  const entry = processRegistry.get(channelId);
  if (entry) {
    entry.proc.kill('SIGTERM');
    return true;
  }
  const persistentEntry = persistentRegistry.get(channelId);
  if (persistentEntry) {
    clearTimeout(persistentEntry.idleTimer);
    persistentEntry.proc.kill('SIGTERM');
    return true;
  }
  return false;
}

export function nudgeProcess(channelId: string): boolean {
  const entry = processRegistry.get(channelId);
  if (entry) {
    entry.proc.kill('SIGINT');
    return true;
  }
  const persistentEntry = persistentRegistry.get(channelId);
  if (persistentEntry) {
    persistentEntry.proc.kill('SIGINT');
    return true;
  }
  return false;
}

export function killAllProcesses(): string[] {
  const killed: string[] = [];
  for (const [channelId, entry] of processRegistry) {
    entry.proc.kill('SIGTERM');
    killed.push(channelId);
  }
  for (const [channelId, entry] of persistentRegistry) {
    clearTimeout(entry.idleTimer);
    entry.proc.kill('SIGTERM');
    killed.push(channelId);
  }
  return killed;
}

/**
 * Generate a deterministic session UUID from channel ID + folder path.
 * Same channel+folder always produces the same session ID, surviving restarts.
 */
export function deriveSessionId(channelId: string, folder: string): string {
  return uuidv5(`${channelId}:${folder}`, CLAUDEWAY_NAMESPACE);
}

// --- Stream-json line parser (pure, exported for testing) ---

export type StreamLineEvent =
  | { type: 'text_delta'; text: string }
  | {
      type: 'result';
      text: string;
      sessionId: string | null;
      cost: number | null;
      tokens: number | null;
    }
  | { type: 'user_receipt' }
  | null;

/**
 * Parse one NDJSON line from Claude CLI --output-format stream-json output.
 * Returns a typed event or null (unrecognised / whitespace / invalid JSON).
 */
export function parseStreamLine(line: string): StreamLineEvent {
  if (!line.trim()) return null;
  try {
    const obj = JSON.parse(line);

    // Text delta — {"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}}
    if (
      obj.type === 'stream_event' &&
      obj.event?.type === 'content_block_delta' &&
      obj.event.delta?.type === 'text_delta' &&
      obj.event.delta.text
    ) {
      return { type: 'text_delta', text: obj.event.delta.text };
    }

    // Result event
    if (obj.type === 'result') {
      const usage = obj.usage;
      const tokens = usage != null ? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) : null;
      return {
        type: 'result',
        text: obj.result ?? '',
        sessionId: obj.session_id ?? null,
        cost: obj.cost_usd ?? obj.total_cost_usd ?? null,
        tokens,
      };
    }

    // User message receipt (persistent mode --replay-user-messages)
    if (obj.type === 'user') {
      return { type: 'user_receipt' };
    }

    return null;
  } catch {
    return null;
  }
}

function spawnClaudeProcess(args: string[], cwd: string) {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  if (!env.HOME && env.USER) env.HOME = `/Users/${env.USER}`;

  return spawn('claude', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
}

function runClaudeProcess(
  args: string[],
  cwd: string,
  timeoutMs: number,
  channelId: string,
  sessionId: string,
  message: string,
): Promise<ClaudeResult> {
  return new Promise((resolve, reject) => {
    const proc = spawnClaudeProcess(args, cwd);

    processRegistry.set(channelId, {
      proc,
      channelId,
      sessionId,
      startedAt: new Date(),
      message: message.substring(0, 80),
      messageCount: 1,
      totalCost: 0,
      totalTokens: 0,
    });

    let stdout = '';
    let stderr = '';

    const resetTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        proc.kill('SIGTERM');
        reject(new Error(`Claude idle timeout after ${timeoutMs / 1000}s of inactivity`));
      }, timeoutMs);
    };

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
      resetTimer();
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
      resetTimer();
    });

    let timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`Claude idle timeout after ${timeoutMs / 1000}s of inactivity`));
    }, timeoutMs);

    const absoluteTimer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`Claude absolute timeout after ${ABSOLUTE_TIMEOUT_MS / 3600000}h`));
    }, ABSOLUTE_TIMEOUT_MS);

    proc.on('close', (code) => {
      processRegistry.delete(channelId);
      clearTimeout(timer);
      clearTimeout(absoluteTimer);

      if (code !== 0) {
        reject(new Error(`Claude exited with code ${code}: ${stderr.trim()}`));
        return;
      }

      try {
        const json = JSON.parse(stdout);
        const usage = json.usage;
        resolve({
          response: json.result ?? json.content ?? stdout,
          sessionId: json.session_id ?? null,
          cost: json.cost_usd ?? null,
          tokens: usage != null ? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) : null,
        });
      } catch {
        resolve({
          response: stdout.trim(),
          sessionId: null,
          cost: null,
          tokens: null,
        });
      }
    });

    proc.on('error', (err) => {
      processRegistry.delete(channelId);
      clearTimeout(timer);
      clearTimeout(absoluteTimer);
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });
  });
}

function runClaudeStreamingProcess(
  args: string[],
  cwd: string,
  timeoutMs: number,
  onTextDelta: (text: string) => void,
  channelId: string,
  registrySessionId: string,
  message: string,
): Promise<ClaudeResult> {
  return new Promise((resolve, reject) => {
    const proc = spawnClaudeProcess(args, cwd);

    processRegistry.set(channelId, {
      proc,
      channelId,
      sessionId: registrySessionId,
      startedAt: new Date(),
      message: message.substring(0, 80),
      messageCount: 1,
      totalCost: 0,
      totalTokens: 0,
    });

    let stderr = '';
    let fullText = '';
    let sessionId: string | null = null;
    let cost: number | null = null;
    let tokens: number | null = null;
    let lineBuffer = '';

    function processLine(line: string) {
      const event = parseStreamLine(line);
      if (!event) return;
      if (event.type === 'text_delta') {
        fullText += event.text;
        onTextDelta(event.text);
      } else if (event.type === 'result') {
        sessionId = event.sessionId ?? sessionId;
        cost = event.cost ?? cost;
        tokens = event.tokens ?? tokens;
        if (event.text) fullText = event.text;
      }
    }

    const resetTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        proc.kill('SIGTERM');
        reject(new Error(`Claude idle timeout after ${timeoutMs / 1000}s of inactivity`));
      }, timeoutMs);
    };

    proc.stdout.on('data', (data: Buffer) => {
      lineBuffer += data.toString();
      const lines = lineBuffer.split('\n');
      // Keep the last (possibly incomplete) line in the buffer
      lineBuffer = lines.pop() ?? '';
      for (const line of lines) {
        processLine(line);
      }
      resetTimer();
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
      resetTimer();
    });

    let timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`Claude idle timeout after ${timeoutMs / 1000}s of inactivity`));
    }, timeoutMs);

    const absoluteTimer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`Claude absolute timeout after ${ABSOLUTE_TIMEOUT_MS / 3600000}h`));
    }, ABSOLUTE_TIMEOUT_MS);

    proc.on('close', (code) => {
      processRegistry.delete(channelId);
      clearTimeout(timer);
      clearTimeout(absoluteTimer);
      // Process any remaining buffered line
      if (lineBuffer.trim()) {
        processLine(lineBuffer);
      }

      if (code !== 0) {
        reject(new Error(`Claude exited with code ${code}: ${stderr.trim()}`));
        return;
      }

      resolve({
        response: fullText,
        sessionId,
        cost,
        tokens,
      });
    });

    proc.on('error', (err) => {
      processRegistry.delete(channelId);
      clearTimeout(timer);
      clearTimeout(absoluteTimer);
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });
  });
}

/**
 * Resolve paths to all artifacts Claude CLI creates for a session.
 * Claude encodes folder paths by replacing / with - (keeping the leading dash).
 */
export function sessionArtifactPaths(sessionId: string, cwd: string) {
  const home = process.env.HOME ?? `/Users/${process.env.USER ?? ''}`;
  const encodedPath = cwd.replace(/\//g, '-');
  return {
    jsonl: resolve(home, '.claude', 'projects', encodedPath, `${sessionId}.jsonl`),
    dir: resolve(home, '.claude', 'projects', encodedPath, sessionId),
    todo: resolve(home, '.claude', 'todos', `${sessionId}-agent-${sessionId}.json`),
  };
}

/**
 * Remove all session artifacts so the session ID can be reused.
 * Called on "already in use" errors before retrying.
 */
function clearSessionArtifacts(sessionId: string, cwd: string): void {
  const paths = sessionArtifactPaths(sessionId, cwd);
  for (const [name, p] of Object.entries(paths)) {
    try {
      if (!existsSync(p)) continue;
      if (name === 'dir') {
        rmSync(p, { recursive: true, force: true });
      } else {
        unlinkSync(p);
      }
      console.log(`Cleared session artifact: ${p}`);
    } catch {
      // Ignore — file may already be gone or locked
    }
  }
}

function buildClaudeArgs(
  options: ClaudeOptions,
  outputFormat: 'json' | 'stream-json',
): { args: string[]; sessionId: string; cwd: string; resuming: boolean } {
  const { message, cwd, model, systemPrompt, channelId } = options;

  const configPath = getConfigPath();
  const prompt = systemPrompt.replace('CONFIG_PATH', configPath);
  const sessionId = deriveSessionId(channelId, cwd);

  const { jsonl: sessionFile } = sessionArtifactPaths(sessionId, cwd);
  const resuming = existsSync(sessionFile);

  const args = [
    '-p',
    '--output-format',
    outputFormat,
    ...(outputFormat === 'stream-json' ? ['--verbose', '--include-partial-messages'] : []),
    '--model',
    model,
    ...(resuming ? ['--resume', sessionId] : ['--session-id', sessionId]),
    '--append-system-prompt',
    prompt,
    '--dangerously-skip-permissions',
  ];

  const mcpConfigPath = resolve(process.cwd(), 'mcp.json');
  if (existsSync(mcpConfigPath)) {
    args.push('--mcp-config', mcpConfigPath);
  }

  // If images are attached, append file path references so Claude reads them
  if (options.imagePaths && options.imagePaths.length > 0) {
    const imageRefs = options.imagePaths.map((p) => p).join('\n');
    args.push(
      message + '\n\n[Attached image files — use your Read tool to view them]\n' + imageRefs,
    );
  } else {
    args.push(message);
  }

  return { args, sessionId, cwd, resuming };
}

function makeFreshArgs(args: string[], sessionId: string): string[] {
  return args.map((a, i) => (a === '--resume' && args[i + 1] === sessionId ? '--session-id' : a));
}

export async function runClaude(options: ClaudeOptions): Promise<ClaudeResult> {
  const { args, sessionId, cwd, resuming } = buildClaudeArgs(options, 'json');

  console.log(`[${options.channelId}] ${resuming ? 'Resuming' : 'Starting'} session ${sessionId}`);

  try {
    return await runClaudeProcess(
      args,
      cwd,
      options.timeoutMs,
      options.channelId,
      sessionId,
      options.message,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('already in use')) {
      console.log(
        `[${options.channelId}] Session ${sessionId} already in use — clearing artifacts and retrying`,
      );
      clearSessionArtifacts(sessionId, cwd);
      return await runClaudeProcess(
        makeFreshArgs(args, sessionId),
        cwd,
        options.timeoutMs,
        options.channelId,
        sessionId,
        options.message,
      );
    }
    throw err;
  }
}

export async function runClaudeStreaming(options: ClaudeStreamingOptions): Promise<ClaudeResult> {
  const { args, sessionId, cwd, resuming } = buildClaudeArgs(options, 'stream-json');

  console.log(
    `[${options.channelId}] ${resuming ? 'Resuming' : 'Starting'} streaming session ${sessionId}`,
  );

  try {
    return await runClaudeStreamingProcess(
      args,
      cwd,
      options.timeoutMs,
      options.onTextDelta,
      options.channelId,
      sessionId,
      options.message,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('already in use')) {
      console.log(
        `[${options.channelId}] Session ${sessionId} already in use — clearing artifacts and retrying`,
      );
      clearSessionArtifacts(sessionId, cwd);
      return await runClaudeStreamingProcess(
        makeFreshArgs(args, sessionId),
        cwd,
        options.timeoutMs,
        options.onTextDelta,
        options.channelId,
        sessionId,
        options.message,
      );
    }
    throw err;
  }
}

// --- Persistent process mode ---

function buildPersistentClaudeArgs(options: ClaudeOptions): {
  args: string[];
  sessionId: string;
  cwd: string;
  resuming: boolean;
} {
  const { cwd, model, systemPrompt, channelId } = options;

  const configPath = getConfigPath();
  const prompt = systemPrompt.replace('CONFIG_PATH', configPath);
  const sessionId = deriveSessionId(channelId, cwd);

  const { jsonl: sessionFile } = sessionArtifactPaths(sessionId, cwd);
  const resuming = existsSync(sessionFile);

  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--input-format',
    'stream-json',
    '--replay-user-messages',
    '--model',
    model,
    ...(resuming ? ['--resume', sessionId] : ['--session-id', sessionId]),
    '--append-system-prompt',
    prompt,
    '--dangerously-skip-permissions',
  ];

  const mcpConfigPath = resolve(process.cwd(), 'mcp.json');
  if (existsSync(mcpConfigPath)) {
    args.push('--mcp-config', mcpConfigPath);
  }

  return { args, sessionId, cwd, resuming };
}

function createPersistentProcess(
  options: ClaudeOptions,
  timeoutMs: number,
): PersistentProcessEntry {
  const { args, sessionId, cwd, resuming } = buildPersistentClaudeArgs(options);

  console.log(
    `[${options.channelId}] ${resuming ? 'Resuming' : 'Starting'} persistent session ${sessionId}`,
  );

  const env = { ...process.env };
  delete env.CLAUDECODE;
  if (!env.HOME && env.USER) env.HOME = `/Users/${env.USER}`;

  const proc = spawn('claude', args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  });

  const entry: PersistentProcessEntry = {
    proc,
    channelId: options.channelId,
    sessionId,
    startedAt: new Date(),
    lastMessage: '',
    messageCount: 0,
    totalCost: 0,
    totalTokens: 0,
    idleTimer: setTimeout(() => {}, 0), // placeholder; reset immediately below
    lineBuffer: '',
    currentTurn: null,
  };

  function resetIdleTimer() {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      console.log(`[${options.channelId}] Persistent process idle timeout — killing`);
      proc.kill('SIGTERM');
    }, timeoutMs);
  }

  // Start idle timer
  resetIdleTimer();

  proc.stdout.on('data', (data: Buffer) => {
    resetIdleTimer();
    entry.lineBuffer += data.toString();
    const lines = entry.lineBuffer.split('\n');
    entry.lineBuffer = lines.pop() ?? '';
    for (const line of lines) {
      processPersistentLine(entry, line);
    }
  });

  proc.stderr.on('data', (data: Buffer) => {
    resetIdleTimer();
    console.error(`[${options.channelId}] Persistent stderr: ${data.toString().trim()}`);
  });

  proc.on('close', (code) => {
    clearTimeout(entry.idleTimer);
    persistentRegistry.delete(options.channelId);

    // Process remaining buffered line
    if (entry.lineBuffer.trim()) {
      processPersistentLine(entry, entry.lineBuffer);
      entry.lineBuffer = '';
    }

    if (entry.currentTurn) {
      const turn = entry.currentTurn;
      entry.currentTurn = null;
      if (code !== 0) {
        turn.reject(new Error(`Persistent Claude process exited with code ${code}`));
      } else {
        // Process ended cleanly mid-turn — resolve with what we have
        turn.resolve({
          response: turn.fullText,
          sessionId: turn.sessionId,
          cost: turn.cost,
          tokens: null,
        });
      }
    }
  });

  proc.on('error', (err) => {
    clearTimeout(entry.idleTimer);
    persistentRegistry.delete(options.channelId);
    if (entry.currentTurn) {
      const turn = entry.currentTurn;
      entry.currentTurn = null;
      turn.reject(new Error(`Failed to spawn persistent claude: ${err.message}`));
    }
  });

  persistentRegistry.set(options.channelId, entry);
  return entry;
}

function processPersistentLine(entry: PersistentProcessEntry, line: string): void {
  const event = parseStreamLine(line);
  if (!event) return;

  if (event.type === 'user_receipt') {
    console.log(`[${entry.channelId}] Persistent: user message receipt`);
    return;
  }

  if (event.type === 'text_delta' && entry.currentTurn) {
    entry.currentTurn.fullText += event.text;
    entry.currentTurn.onTextDelta?.(event.text);
    return;
  }

  if (event.type === 'result' && entry.currentTurn) {
    entry.messageCount++;
    entry.totalCost += event.cost ?? 0;
    entry.totalTokens += event.tokens ?? 0;
    const turn = entry.currentTurn;
    entry.currentTurn = null;
    turn.resolve({
      response: event.text || turn.fullText,
      sessionId: event.sessionId ?? turn.sessionId,
      cost: event.cost ?? turn.cost,
      tokens: event.tokens,
    });
  }
}

export async function runClaudePersistentStreaming(
  options: ClaudeStreamingOptions,
): Promise<ClaudeResult> {
  const { channelId, message, timeoutMs, imagePaths, onTextDelta } = options;

  let entry = persistentRegistry.get(channelId);

  // Spawn or re-spawn if process is gone
  if (!entry || !entry.proc.pid || entry.proc.killed) {
    entry = createPersistentProcess(options, timeoutMs);
  }

  entry.lastMessage = message.substring(0, 80);

  // Build message content (include image refs if any)
  let content = message;
  if (imagePaths && imagePaths.length > 0) {
    const imageRefs = imagePaths.join('\n');
    content =
      message + '\n\n[Attached image files — use your Read tool to view them]\n' + imageRefs;
  }

  // Write the user message to stdin as NDJSON
  const inputLine = JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';

  return new Promise((resolve, reject) => {
    if (!entry) {
      reject(new Error('Persistent process entry missing'));
      return;
    }

    entry.currentTurn = {
      resolve,
      reject,
      onTextDelta,
      fullText: '',
      sessionId: entry.sessionId,
      cost: null,
    };

    entry.proc.stdin!.write(inputLine, (err) => {
      if (err) {
        if (entry!.currentTurn) {
          entry!.currentTurn = null;
        }
        reject(new Error(`Failed to write to persistent claude stdin: ${err.message}`));
      }
    });
  });
}
