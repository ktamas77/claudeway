import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

export type ResponseMode = 'batch' | 'stream-update' | 'stream-native';

export interface ChannelConfig {
  name: string;
  folder: string;
  model?: string;
  systemPrompt?: string;
  timeoutMs?: number;
  responseMode?: ResponseMode;
}

export interface Defaults {
  model: string;
  systemPrompt: string;
  timeoutMs: number;
  responseMode: ResponseMode;
}

export interface Config {
  channels: Record<string, ChannelConfig>;
  defaults: Defaults;
  systemChannel?: string;
}

const CONFIG_PATH = resolve(process.cwd(), 'config.json');

export function getConfigPath(): string {
  return CONFIG_PATH;
}

export function loadConfig(): Config {
  const raw = readFileSync(CONFIG_PATH, 'utf-8');
  const config = JSON.parse(raw) as Config;

  if (!config.channels || typeof config.channels !== 'object') {
    throw new Error('config.json: "channels" must be an object');
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

  return config;
}

export function saveConfig(config: Config): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf-8');
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
  };
}
