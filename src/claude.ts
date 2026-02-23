import { spawn } from 'child_process';
import { existsSync } from 'fs';
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

export async function runClaude(options: ClaudeOptions): Promise<ClaudeResult> {
  const { message, cwd, model, systemPrompt, timeoutMs, channelId } = options;

  const configPath = getConfigPath();
  const prompt = systemPrompt.replace('CONFIG_PATH', configPath);
  const sessionId = deriveSessionId(channelId, cwd);

  const args = [
    '-p',
    '--output-format',
    'json',
    '--model',
    model,
    '--session-id',
    sessionId,
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

  // Try with session ID (resumes if session exists, creates new if not)
  try {
    return await runClaudeProcess(args, cwd, timeoutMs);
  } catch {
    // If session-id fails, fall back to no session flag
    console.log(`[${channelId}] Session ${sessionId} failed, trying without session-id`);
    const fallbackArgs = args.filter(
      (a, i) => a !== '--session-id' && args[i - 1] !== '--session-id',
    );
    return await runClaudeProcess(fallbackArgs, cwd, timeoutMs);
  }
}
