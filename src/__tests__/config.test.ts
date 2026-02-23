import { resolvedChannelConfig, getChannelConfig, type Config } from '../config.js';

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
