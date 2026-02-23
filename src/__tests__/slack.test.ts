import { markdownToSlackMrkdwn, splitMessage, formatDuration } from '../slack.js';

describe('markdownToSlackMrkdwn', () => {
  describe('links', () => {
    it('converts [text](url) to <url|text>', () => {
      expect(markdownToSlackMrkdwn('[Claude](https://claude.ai)')).toBe(
        '<https://claude.ai|Claude>',
      );
    });

    it('handles multiple links in one string', () => {
      const input = '[A](https://a.com) and [B](https://b.com)';
      expect(markdownToSlackMrkdwn(input)).toBe('<https://a.com|A> and <https://b.com|B>');
    });

    it('leaves bare URLs unchanged', () => {
      expect(markdownToSlackMrkdwn('https://example.com')).toBe('https://example.com');
    });
  });

  describe('headings', () => {
    it('converts # heading to *heading*', () => {
      expect(markdownToSlackMrkdwn('# Title')).toBe('*Title*');
    });

    it('converts ## heading to *heading*', () => {
      expect(markdownToSlackMrkdwn('## Section')).toBe('*Section*');
    });

    it('converts ###### heading to *heading*', () => {
      expect(markdownToSlackMrkdwn('###### Deep')).toBe('*Deep*');
    });

    it('does not convert # mid-sentence', () => {
      expect(markdownToSlackMrkdwn('color is #ff0000')).toBe('color is #ff0000');
    });
  });

  describe('bold', () => {
    it('converts **bold** to *bold*', () => {
      expect(markdownToSlackMrkdwn('**bold text**')).toBe('*bold text*');
    });

    it('handles multiple bold spans', () => {
      expect(markdownToSlackMrkdwn('**a** and **b**')).toBe('*a* and *b*');
    });
  });

  describe('strikethrough', () => {
    it('converts ~~strike~~ to ~strike~', () => {
      expect(markdownToSlackMrkdwn('~~deleted~~')).toBe('~deleted~');
    });
  });

  describe('horizontal rules', () => {
    it('converts --- to ———', () => {
      expect(markdownToSlackMrkdwn('---')).toBe('———');
    });

    it('converts *** to ———', () => {
      expect(markdownToSlackMrkdwn('***')).toBe('———');
    });

    it('converts ___ to ———', () => {
      expect(markdownToSlackMrkdwn('___')).toBe('———');
    });
  });

  describe('code fences', () => {
    it('strips language tag from ```js code block', () => {
      expect(markdownToSlackMrkdwn('```js\ncode\n```')).toBe('```\ncode\n```');
    });

    it('strips language tag from ```typescript code block', () => {
      expect(markdownToSlackMrkdwn('```typescript\nconst x = 1;\n```')).toBe(
        '```\nconst x = 1;\n```',
      );
    });

    it('leaves ``` without language tag unchanged', () => {
      expect(markdownToSlackMrkdwn('```\ncode\n```')).toBe('```\ncode\n```');
    });
  });

  it('returns empty string unchanged', () => {
    expect(markdownToSlackMrkdwn('')).toBe('');
  });

  it('handles a realistic mixed-Markdown Claude response', () => {
    const input =
      '## Summary\n**key point** — see [docs](https://example.com)\n```js\nconsole.log(1)\n```';
    const expected =
      '*Summary*\n*key point* — see <https://example.com|docs>\n```\nconsole.log(1)\n```';
    expect(markdownToSlackMrkdwn(input)).toBe(expected);
  });
});

describe('splitMessage', () => {
  const MAX = 3900;

  it('returns a single chunk for text under MAX_MESSAGE_LENGTH', () => {
    const text = 'hello world';
    expect(splitMessage(text)).toEqual([text]);
  });

  it('returns a single chunk for text exactly at MAX_MESSAGE_LENGTH', () => {
    const text = 'a'.repeat(MAX);
    const chunks = splitMessage(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(text);
  });

  it('splits at the last newline before MAX_MESSAGE_LENGTH', () => {
    const firstPart = 'a'.repeat(MAX - 10) + '\n';
    const secondPart = 'b'.repeat(50);
    const chunks = splitMessage(firstPart + secondPart);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(firstPart.trimEnd());
    expect(chunks[1]).toBe(secondPart);
  });

  it('splits at MAX boundary when no newline found in first half', () => {
    const text = 'a'.repeat(MAX + 100);
    const chunks = splitMessage(text);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].length).toBe(MAX);
  });

  it('trims leading whitespace from subsequent chunks', () => {
    const text = 'a'.repeat(MAX) + '\n   rest';
    const chunks = splitMessage(text);
    expect(chunks[1]).toBe('rest');
  });

  it('produces the correct number of chunks for 3x input', () => {
    const text = 'a'.repeat(MAX * 3);
    expect(splitMessage(text).length).toBeGreaterThanOrEqual(3);
  });
});

describe('formatDuration', () => {
  const ago = (ms: number) => new Date(Date.now() - ms);

  it('formats sub-minute duration as "Xs"', () => {
    expect(formatDuration(ago(42_000))).toBe('42s');
  });

  it('formats exactly 60 seconds as "1m 0s"', () => {
    expect(formatDuration(ago(60_000))).toBe('1m 0s');
  });

  it('formats 90 seconds as "1m 30s"', () => {
    expect(formatDuration(ago(90_000))).toBe('1m 30s');
  });

  it('formats exactly 1 hour as "1h 0m 0s"', () => {
    expect(formatDuration(ago(3_600_000))).toBe('1h 0m 0s');
  });

  it('formats 1h 1m 1s correctly', () => {
    expect(formatDuration(ago(3_661_000))).toBe('1h 1m 1s');
  });

  it('formats 0 seconds as "0s"', () => {
    expect(formatDuration(ago(0))).toBe('0s');
  });
});
