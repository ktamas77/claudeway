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
}

export interface ClaudeResult {
  response: string;
  sessionId: string | null;
  cost: number | null;
}

// Claudeway namespace UUID for deterministic session IDs
const CLAUDEWAY_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

/**
 * Generate a deterministic session UUID from channel ID + folder path.
 * Same channel+folder always produces the same session ID, surviving restarts.
 */
export function deriveSessionId(channelId: string, folder: string): string {
  return uuidv5(`${channelId}:${folder}`, CLAUDEWAY_NAMESPACE);
}

function runClaudeProcess(args: string[], cwd: string, timeoutMs: number): Promise<ClaudeResult> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    // Ensure HOME is set — launchd may not provide it
    if (!env.HOME && env.USER) env.HOME = `/Users/${env.USER}`;

    const proc = spawn('claude', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`Claude timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);

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

export async function runClaude(options: ClaudeOptions): Promise<ClaudeResult> {
  const { message, cwd, model, systemPrompt, timeoutMs, channelId } = options;

  const configPath = getConfigPath();
  const prompt = systemPrompt.replace('CONFIG_PATH', configPath);
  const sessionId = deriveSessionId(channelId, cwd);

  // Check if a session file already exists — if so, resume it for context continuity
  const { jsonl: sessionFile } = sessionArtifactPaths(sessionId, cwd);
  const resuming = existsSync(sessionFile);

  const args = [
    '-p',
    '--output-format',
    'json',
    '--model',
    model,
    ...(resuming ? ['--resume', sessionId] : ['--session-id', sessionId]),
    '--append-system-prompt',
    prompt,
    '--dangerously-skip-permissions',
  ];

  // Pass MCP config if mcp.json exists in the project root
  const mcpConfigPath = resolve(process.cwd(), 'mcp.json');
  if (existsSync(mcpConfigPath)) {
    args.push('--mcp-config', mcpConfigPath);
  }

  args.push(message);

  console.log(`[${channelId}] ${resuming ? 'Resuming' : 'Starting'} session ${sessionId}`);

  try {
    return await runClaudeProcess(args, cwd, timeoutMs);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('already in use')) {
      console.log(
        `[${channelId}] Session ${sessionId} already in use — clearing artifacts and retrying`,
      );
      clearSessionArtifacts(sessionId, cwd);
      // Retry with --session-id (fresh session, since we just cleared artifacts)
      const freshArgs = args.map((a, i) =>
        a === '--resume' && args[i + 1] === sessionId ? '--session-id' : a,
      );
      return await runClaudeProcess(freshArgs, cwd, timeoutMs);
    }
    throw err;
  }
}
