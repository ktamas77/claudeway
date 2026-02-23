import { spawn } from 'child_process';
import { existsSync, unlinkSync, rmSync } from 'fs';
import { resolve } from 'path';
import { v5 as uuidv5 } from 'uuid';
import { getConfigPath } from './config.js';

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
}

// Claudeway namespace UUID for deterministic session IDs
const CLAUDEWAY_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

// Absolute maximum runtime — safety net regardless of activity
const ABSOLUTE_TIMEOUT_MS = 12 * 60 * 60 * 1000; // 12 hours

/**
 * Generate a deterministic session UUID from channel ID + folder path.
 * Same channel+folder always produces the same session ID, surviving restarts.
 */
export function deriveSessionId(channelId: string, folder: string): string {
  return uuidv5(`${channelId}:${folder}`, CLAUDEWAY_NAMESPACE);
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

function runClaudeProcess(args: string[], cwd: string, timeoutMs: number): Promise<ClaudeResult> {
  return new Promise((resolve, reject) => {
    const proc = spawnClaudeProcess(args, cwd);

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
      clearTimeout(timer);
      clearTimeout(absoluteTimer);

      if (code !== 0) {
        reject(new Error(`Claude exited with code ${code}: ${stderr.trim()}`));
        return;
      }

      try {
        const json = JSON.parse(stdout);
        resolve({
          response: json.result ?? json.content ?? stdout,
          sessionId: json.session_id ?? null,
          cost: json.cost_usd ?? null,
        });
      } catch {
        resolve({
          response: stdout.trim(),
          sessionId: null,
          cost: null,
        });
      }
    });

    proc.on('error', (err) => {
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
): Promise<ClaudeResult> {
  return new Promise((resolve, reject) => {
    const proc = spawnClaudeProcess(args, cwd);

    let stderr = '';
    let fullText = '';
    let sessionId: string | null = null;
    let cost: number | null = null;
    let lineBuffer = '';

    function processLine(line: string) {
      if (!line.trim()) return;
      try {
        const obj = JSON.parse(line);

        // Text delta — stream to callback
        // Events are wrapped: {"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}}
        if (
          obj.type === 'stream_event' &&
          obj.event?.type === 'content_block_delta' &&
          obj.event.delta?.type === 'text_delta' &&
          obj.event.delta.text
        ) {
          fullText += obj.event.delta.text;
          onTextDelta(obj.event.delta.text);
          return;
        }

        // Result event — extract metadata
        if (obj.type === 'result') {
          sessionId = obj.session_id ?? sessionId;
          cost = obj.cost_usd ?? obj.total_cost_usd ?? cost;
          if (obj.result) {
            fullText = obj.result;
          }
        }
      } catch {
        // Not valid JSON — ignore partial lines
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
      });
    });

    proc.on('error', (err) => {
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
function sessionArtifactPaths(sessionId: string, cwd: string) {
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
    return await runClaudeProcess(args, cwd, options.timeoutMs);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('already in use')) {
      console.log(
        `[${options.channelId}] Session ${sessionId} already in use — clearing artifacts and retrying`,
      );
      clearSessionArtifacts(sessionId, cwd);
      return await runClaudeProcess(makeFreshArgs(args, sessionId), cwd, options.timeoutMs);
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
    return await runClaudeStreamingProcess(args, cwd, options.timeoutMs, options.onTextDelta);
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
      );
    }
    throw err;
  }
}
