import { deriveSessionId, sessionArtifactPaths } from '../claude.js';

describe('deriveSessionId', () => {
  it('returns a UUID-format string', () => {
    const id = deriveSessionId('C001', '/projects/foo');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('is deterministic — same inputs produce the same ID', () => {
    const a = deriveSessionId('C001', '/projects/foo');
    const b = deriveSessionId('C001', '/projects/foo');
    expect(a).toBe(b);
  });

  it('produces different IDs for different channelIds', () => {
    expect(deriveSessionId('C001', '/projects/foo')).not.toBe(
      deriveSessionId('C002', '/projects/foo'),
    );
  });

  it('produces different IDs for different folders', () => {
    expect(deriveSessionId('C001', '/projects/foo')).not.toBe(
      deriveSessionId('C001', '/projects/bar'),
    );
  });

  it('is stable — known input produces known output (regression guard)', () => {
    // If this breaks, the namespace constant or hash logic changed
    const id = deriveSessionId('C0AHAGEQY8Y', '/Users/tamas/dev/ktamas77/claudeway');
    expect(id).toBe('808dcec8-994d-5b57-8aa6-c6beeaf1fd39');
  });
});

describe('sessionArtifactPaths — path encoding', () => {
  const HOME = '/Users/testuser';

  beforeEach(() => {
    process.env.HOME = HOME;
  });

  it('encodes / as - in the folder path (keeping the leading dash)', () => {
    const paths = sessionArtifactPaths('abc-123', '/Users/foo/bar');
    expect(paths.jsonl).toContain('-Users-foo-bar');
  });

  it('constructs correct .jsonl path', () => {
    const paths = sessionArtifactPaths('my-session', '/projects/test');
    expect(paths.jsonl).toBe(`${HOME}/.claude/projects/-projects-test/my-session.jsonl`);
  });

  it('constructs correct session directory path', () => {
    const paths = sessionArtifactPaths('my-session', '/projects/test');
    expect(paths.dir).toBe(`${HOME}/.claude/projects/-projects-test/my-session`);
  });

  it('constructs correct todo file path', () => {
    const paths = sessionArtifactPaths('my-session', '/projects/test');
    expect(paths.todo).toBe(`${HOME}/.claude/todos/my-session-agent-my-session.json`);
  });

  it('uses HOME env var', () => {
    process.env.HOME = '/custom/home';
    const paths = sessionArtifactPaths('s', '/p');
    expect(paths.jsonl).toMatch(/^\/custom\/home/);
  });
});
