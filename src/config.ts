import { readFileSync, writeFileSync, renameSync, existsSync } from 'fs';
import { resolve } from 'path';
import { stringify as yamlStringify, parse as yamlParse } from 'yaml';

export type ResponseMode = 'batch' | 'stream-update' | 'stream-native';
export type ProcessMode = 'oneshot' | 'persistent';

export interface ChannelConfig {
  name: string;
  folder: string;
  model?: string;
  systemPrompt?: string;
  timeoutMs?: number;
  responseMode?: ResponseMode;
  processMode?: ProcessMode;
}

export interface Defaults {
  model: string;
  systemPrompt: string;
  timeoutMs: number;
  responseMode: ResponseMode;
  processMode?: ProcessMode;
}

export interface Config {
  channels: Record<string, ChannelConfig>;
  defaults: Defaults;
  systemChannel?: string;
}

type ConfigFormat = 'yaml' | 'json';

function detectConfigPath(): { path: string; format: ConfigFormat } {
  const yamlPath = resolve(process.cwd(), 'config.yaml');
  const jsonPath = resolve(process.cwd(), 'config.json');
  if (existsSync(yamlPath)) {
    if (existsSync(jsonPath)) {
      console.warn('[config] Both config.yaml and config.json exist — using config.yaml');
    }
    return { path: yamlPath, format: 'yaml' };
  }
  return { path: jsonPath, format: 'json' };
}

function parseConfig(raw: string, format: ConfigFormat): Config {
  return format === 'yaml' ? (yamlParse(raw) as Config) : (JSON.parse(raw) as Config);
}

function serializeConfig(config: Config, format: ConfigFormat): string {
  return format === 'yaml'
    ? yamlStringify(config, { lineWidth: 0 })
    : JSON.stringify(config, null, 2) + '\n';
}

export function getConfigPath(): string {
  return detectConfigPath().path;
}

export function loadConfig(): Config {
  const { path: configPath, format } = detectConfigPath();
  const raw = readFileSync(configPath, 'utf-8');
  const config = parseConfig(raw, format);

  if (!config.channels || typeof config.channels !== 'object') {
    throw new Error(`${configPath}: "channels" must be an object`);
  }
  if (!config.defaults) {
    config.defaults = {
      model: 'opus',
      systemPrompt:
        'Format all responses using Slack mrkdwn syntax (NOT standard Markdown). Key rules: *bold* (single asterisk), _italic_ (underscore), ~strikethrough~ (single tilde), `code`, ```code blocks``` (no language tag), > blockquote, <URL|label> for links (NOT [label](url)), :emoji: shortcodes. Standard Markdown ##headers, **bold**, [links](url), and tables do NOT work in Slack. Use - or numbered lists. Keep responses concise.',
      timeoutMs: 300000,
      responseMode: 'batch',
    };
  }
  if (!config.defaults.responseMode) {
    config.defaults.responseMode = 'batch';
  }
  if (!config.defaults.processMode) {
    config.defaults.processMode = 'oneshot';
  }

  return config;
}

export function saveConfig(config: Config): void {
  const { path: configPath, format } = detectConfigPath();
  const content = serializeConfig(config, format);
  const tmpPath = configPath + '.tmp';

  // Write to temp file
  writeFileSync(tmpPath, content, 'utf-8');

  // Validate the temp file parses correctly and has required fields
  const parsed = parseConfig(readFileSync(tmpPath, 'utf-8'), format);
  if (!parsed.channels || typeof parsed.channels !== 'object') {
    throw new Error('saveConfig: validation failed — "channels" must be an object');
  }

  // Atomic rename: temp → original
  renameSync(tmpPath, configPath);
}

export function getChannelConfig(config: Config, channelId: string): ChannelConfig | null {
  return config.channels[channelId] ?? null;
}

export function resolvedChannelConfig(
  config: Config,
  channelId: string,
):
  | (ChannelConfig & {
      model: string;
      systemPrompt: string;
      timeoutMs: number;
      responseMode: ResponseMode;
      processMode: ProcessMode;
    })
  | null {
  const ch = config.channels[channelId];
  if (!ch) return null;
  return {
    ...ch,
    model: ch.model ?? config.defaults.model,
    systemPrompt: ch.systemPrompt ?? config.defaults.systemPrompt,
    timeoutMs: ch.timeoutMs ?? config.defaults.timeoutMs,
    responseMode: ch.responseMode ?? config.defaults.responseMode,
    processMode: ch.processMode ?? config.defaults.processMode ?? 'oneshot',
  };
}
