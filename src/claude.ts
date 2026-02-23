import { spawn } from 'child_process';
import { getConfigPath } from './config.js';

export interface ClaudeOptions {
  message: string;
  cwd: string;
  model: string;
  systemPrompt: string;
  timeoutMs: number;
}

export interface ClaudeResult {
  response: string;
  sessionId: string | null;
  cost: number | null;
}

export async function runClaude(options: ClaudeOptions): Promise<ClaudeResult> {
  const { message, cwd, model, systemPrompt, timeoutMs } = options;

  const configPath = getConfigPath();
  const prompt = systemPrompt.replace('CONFIG_PATH', configPath);

  const args = [
    '-p',
    '--continue',
    '--output-format',
    'json',
    '--model',
    model,
    '--append-system-prompt',
    prompt,
    '--dangerously-skip-permissions',
    message,
  ];

  return new Promise((resolve, reject) => {
    const proc = spawn('claude', args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
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
        // If JSON parsing fails, treat stdout as plain text
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
