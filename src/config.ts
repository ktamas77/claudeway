import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

export interface ChannelConfig {
  name: string;
  folder: string;
  model?: string;
  systemPrompt?: string;
  timeoutMs?: number;
}

export interface Defaults {
  model: string;
  systemPrompt: string;
  timeoutMs: number;
}

export interface Config {
  channels: Record<string, ChannelConfig>;
  defaults: Defaults;
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
      systemPrompt: 'Be concise. Format responses for Slack mrkdwn.',
      timeoutMs: 300000,
    };
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
): (ChannelConfig & { model: string; systemPrompt: string; timeoutMs: number }) | null {
  const ch = config.channels[channelId];
  if (!ch) return null;
  return {
    ...ch,
    model: ch.model ?? config.defaults.model,
    systemPrompt: ch.systemPrompt ?? config.defaults.systemPrompt,
    timeoutMs: ch.timeoutMs ?? config.defaults.timeoutMs,
  };
}
