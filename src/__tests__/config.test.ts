import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  resolvedChannelConfig,
  getChannelConfig,
  loadConfig,
  saveConfig,
  type Config,
} from '../config.js';

const baseConfig: Config = {
  channels: {
    C001: { name: 'test-channel', folder: '/projects/test' },
    C002: {
      name: 'custom-channel',
      folder: '/projects/custom',
      model: 'sonnet',
      systemPrompt: 'custom prompt',
      timeoutMs: 60_000,
      responseMode: 'stream-update',
      processMode: 'persistent',
    },
  },
  defaults: {
    model: 'opus',
    systemPrompt: 'default prompt',
    timeoutMs: 300_000,
    responseMode: 'batch',
    processMode: 'oneshot',
  },
};

describe('resolvedChannelConfig', () => {
  it('returns null for an unknown channelId', () => {
    expect(resolvedChannelConfig(baseConfig, 'C999')).toBeNull();
  });

  it('fills in all defaults when channel has only name and folder', () => {
    const result = resolvedChannelConfig(baseConfig, 'C001');
    expect(result).toMatchObject({
      name: 'test-channel',
      folder: '/projects/test',
      model: 'opus',
      systemPrompt: 'default prompt',
      timeoutMs: 300_000,
      responseMode: 'batch',
      processMode: 'oneshot',
    });
  });

  it('uses channel-level overrides over defaults', () => {
    const result = resolvedChannelConfig(baseConfig, 'C002');
    expect(result).toMatchObject({
      model: 'sonnet',
      systemPrompt: 'custom prompt',
      timeoutMs: 60_000,
      responseMode: 'stream-update',
      processMode: 'persistent',
    });
  });

  it('defaults processMode to "oneshot" when absent from both channel and defaults', () => {
    const config: Config = {
      channels: { C003: { name: 'x', folder: '/x' } },
      defaults: { model: 'opus', systemPrompt: '', timeoutMs: 300_000, responseMode: 'batch' },
    };
    expect(resolvedChannelConfig(config, 'C003')?.processMode).toBe('oneshot');
  });

  it('channel-level responseMode overrides defaults', () => {
    const config: Config = {
      ...baseConfig,
      channels: {
        C004: { name: 'y', folder: '/y', responseMode: 'stream-native' },
      },
    };
    expect(resolvedChannelConfig(config, 'C004')?.responseMode).toBe('stream-native');
  });
});

describe('getChannelConfig', () => {
  it('returns the channel config for a known channel', () => {
    expect(getChannelConfig(baseConfig, 'C001')).toEqual(baseConfig.channels['C001']);
  });

  it('returns null for an unknown channel', () => {
    expect(getChannelConfig(baseConfig, 'C999')).toBeNull();
  });
});

describe('YAML config support', () => {
  let tmpDir: string;
  const originalCwd = process.cwd;

  const minimalConfig = {
    channels: { C001: { name: 'test', folder: '/test' } },
    defaults: {
      model: 'opus',
      systemPrompt: 'test prompt',
      timeoutMs: 300000,
      responseMode: 'batch',
    },
  };

  const minimalYaml = `
channels:
  C002:
    name: from-yaml
    folder: /yaml
defaults:
  model: opus
  systemPrompt: yaml prompt
  timeoutMs: 300000
  responseMode: batch
`;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'claudeway-config-test-'));
    process.cwd = () => tmpDir;
  });

  afterEach(() => {
    process.cwd = originalCwd;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads config.json when only JSON exists', () => {
    writeFileSync(join(tmpDir, 'config.json'), JSON.stringify(minimalConfig));
    const config = loadConfig();
    expect(config.channels.C001.name).toBe('test');
  });

  it('loads config.yaml when only YAML exists', () => {
    writeFileSync(join(tmpDir, 'config.yaml'), minimalYaml);
    const config = loadConfig();
    expect(config.channels.C002.name).toBe('from-yaml');
  });

  it('prefers config.yaml over config.json when both exist', () => {
    writeFileSync(join(tmpDir, 'config.yaml'), minimalYaml);
    writeFileSync(join(tmpDir, 'config.json'), JSON.stringify(minimalConfig));
    const config = loadConfig();
    expect(config.channels.C002.name).toBe('from-yaml');
  });

  it('saveConfig writes YAML when config.yaml is active', () => {
    writeFileSync(join(tmpDir, 'config.yaml'), minimalYaml);
    const config = loadConfig();
    config.channels.C002.name = 'updated';
    saveConfig(config);

    const saved = readFileSync(join(tmpDir, 'config.yaml'), 'utf-8');
    expect(saved).toContain('updated');
    expect(existsSync(join(tmpDir, 'config.json'))).toBe(false);
  });

  it('saveConfig writes JSON when config.json is active', () => {
    writeFileSync(join(tmpDir, 'config.json'), JSON.stringify(minimalConfig));
    const config = loadConfig();
    config.channels.C001.name = 'updated';
    saveConfig(config);

    const saved = JSON.parse(readFileSync(join(tmpDir, 'config.json'), 'utf-8'));
    expect(saved.channels.C001.name).toBe('updated');
  });

  it('applies defaults when loading YAML config', () => {
    const yamlNoDefaults = `
channels:
  C001:
    name: minimal
    folder: /min
`;
    writeFileSync(join(tmpDir, 'config.yaml'), yamlNoDefaults);
    const config = loadConfig();
    expect(config.defaults.responseMode).toBe('batch');
    expect(config.defaults.processMode).toBe('oneshot');
  });
});
