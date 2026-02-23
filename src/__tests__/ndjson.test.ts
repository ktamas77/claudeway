import { parseStreamLine } from '../claude.js';

describe('parseStreamLine — text_delta events', () => {
  const makeDelta = (text: string) =>
    JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text },
      },
    });

  it('extracts text from a well-formed text_delta event', () => {
    expect(parseStreamLine(makeDelta('Hello'))).toEqual({ type: 'text_delta', text: 'Hello' });
  });

  it('handles unicode text', () => {
    expect(parseStreamLine(makeDelta('こんにちは 🎉'))).toEqual({
      type: 'text_delta',
      text: 'こんにちは 🎉',
    });
  });

  it('handles multi-line text in a single delta', () => {
    const text = 'line one\nline two\nline three';
    expect(parseStreamLine(makeDelta(text))).toEqual({ type: 'text_delta', text });
  });

  it('returns null for empty lines', () => {
    expect(parseStreamLine('')).toBeNull();
  });

  it('returns null for whitespace-only lines', () => {
    expect(parseStreamLine('   \t  ')).toBeNull();
  });

  it('returns null for non-JSON garbage', () => {
    expect(parseStreamLine('not json at all')).toBeNull();
  });

  it('returns null when event.type is not content_block_delta', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_start', delta: { type: 'text_delta', text: 'hi' } },
    });
    expect(parseStreamLine(line)).toBeNull();
  });

  it('returns null when delta.type is not text_delta', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: '{}' },
      },
    });
    expect(parseStreamLine(line)).toBeNull();
  });

  it('returns null when delta.text is empty string', () => {
    expect(parseStreamLine(makeDelta(''))).toBeNull();
  });

  it('returns null when delta.text is missing', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta' } },
    });
    expect(parseStreamLine(line)).toBeNull();
  });

  it('returns null for unknown top-level type', () => {
    expect(parseStreamLine(JSON.stringify({ type: 'ping' }))).toBeNull();
  });
});

describe('parseStreamLine — result events', () => {
  it('extracts session_id, cost_usd, and result text', () => {
    const line = JSON.stringify({
      type: 'result',
      result: 'The answer is 42',
      session_id: 'abc-123',
      cost_usd: 0.0042,
    });
    expect(parseStreamLine(line)).toEqual({
      type: 'result',
      text: 'The answer is 42',
      sessionId: 'abc-123',
      cost: 0.0042,
      tokens: null,
    });
  });

  it('falls back to total_cost_usd when cost_usd is absent', () => {
    const line = JSON.stringify({
      type: 'result',
      result: '',
      session_id: 'x',
      total_cost_usd: 0.1,
    });
    const event = parseStreamLine(line);
    expect(event?.type === 'result' && event.cost).toBe(0.1);
  });

  it('returns null session_id when session_id is absent', () => {
    const line = JSON.stringify({ type: 'result', result: 'hi', cost_usd: 0.01 });
    const event = parseStreamLine(line);
    expect(event?.type === 'result' && event.sessionId).toBeNull();
  });

  it('returns null cost when neither cost field is present', () => {
    const line = JSON.stringify({ type: 'result', result: 'hi', session_id: 'x' });
    const event = parseStreamLine(line);
    expect(event?.type === 'result' && event.cost).toBeNull();
  });

  it('returns empty string for result text when result field is absent', () => {
    const line = JSON.stringify({ type: 'result', session_id: 'x', cost_usd: 0 });
    const event = parseStreamLine(line);
    expect(event?.type === 'result' && event.text).toBe('');
  });

  it('sums input_tokens + output_tokens from usage field', () => {
    const line = JSON.stringify({
      type: 'result',
      result: 'hi',
      session_id: 'x',
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    const event = parseStreamLine(line);
    expect(event?.type === 'result' && event.tokens).toBe(150);
  });

  it('returns null tokens when usage field is absent', () => {
    const line = JSON.stringify({ type: 'result', result: 'hi', session_id: 'x', cost_usd: 0.01 });
    const event = parseStreamLine(line);
    expect(event?.type === 'result' && event.tokens).toBeNull();
  });
});

describe('parseStreamLine — user_receipt', () => {
  it('returns user_receipt for persistent mode echo', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'hello' },
    });
    expect(parseStreamLine(line)).toEqual({ type: 'user_receipt' });
  });
});

describe('parseStreamLine — robustness', () => {
  it('does not throw on truncated JSON', () => {
    expect(() => parseStreamLine('{"type":"stream_event","event":')).not.toThrow();
    expect(parseStreamLine('{"type":"stream_event","event":')).toBeNull();
  });

  it('does not throw on deeply wrong shapes', () => {
    expect(() =>
      parseStreamLine(JSON.stringify({ type: 'stream_event', event: null })),
    ).not.toThrow();
  });

  it('returns null for assistant events without matching shape', () => {
    const line = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [] } });
    expect(parseStreamLine(line)).toBeNull();
  });
});
