import { describe, expect, it, beforeEach } from 'bun:test';
import { getDevMode, initDevMode, overrideDevMode } from './dev-mode';

// The module uses globalThis for state, so we need to reset between tests.
const g = globalThis as typeof globalThis & Record<string, unknown>;

function resetDevMode() {
  delete g['__lifecycleion_is_dev__'];
  delete g['__lifecycleion_init_param__'];
}

describe('getDevMode', () => {
  beforeEach(resetDevMode);

  it('returns false when not initialized', () => {
    expect(getDevMode()).toBe(false);
  });
});

describe('initDevMode — explicit boolean', () => {
  beforeEach(resetDevMode);

  it('sets true when passed true', () => {
    initDevMode(true);
    expect(getDevMode()).toBe(true);
  });

  it('sets false when passed false', () => {
    initDevMode(false);
    expect(getDevMode()).toBe(false);
  });
});

describe('initDevMode — first-wins semantics', () => {
  beforeEach(resetDevMode);

  it('ignores subsequent calls once initialized', () => {
    initDevMode(true);
    initDevMode(false);
    expect(getDevMode()).toBe(true);
  });

  it('ignores a detect call after an explicit value', () => {
    initDevMode(true);
    initDevMode({ detect: 'node_env' });
    expect(getDevMode()).toBe(true);
  });
});

describe('initDevMode — detect: cmd', () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    resetDevMode();
    process.argv = [...originalArgv];
  });

  it('returns true when argv contains "dev"', () => {
    process.argv = ['node', 'server.js', 'dev'];
    initDevMode({ detect: 'cmd' });
    expect(getDevMode()).toBe(true);
  });

  it('returns false when argv contains "prod"', () => {
    process.argv = ['node', 'server.js', 'prod'];
    initDevMode({ detect: 'cmd' });
    expect(getDevMode()).toBe(false);
  });

  it('returns false when argv contains neither', () => {
    process.argv = ['node', 'server.js'];
    initDevMode({ detect: 'cmd' });
    expect(getDevMode()).toBe(false);
  });
});

describe('initDevMode — detect: cmd, strict', () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    resetDevMode();
    process.argv = [...originalArgv];
  });

  it('does not throw when argv contains "dev"', () => {
    process.argv = ['node', 'server.js', 'dev'];
    expect(() => initDevMode({ detect: 'cmd', strict: true })).not.toThrow();
    expect(getDevMode()).toBe(true);
  });

  it('does not throw when argv contains "prod"', () => {
    process.argv = ['node', 'server.js', 'prod'];
    expect(() => initDevMode({ detect: 'cmd', strict: true })).not.toThrow();
    expect(getDevMode()).toBe(false);
  });

  it('throws when argv contains neither "dev" nor "prod"', () => {
    process.argv = ['node', 'server.js'];
    expect(() => initDevMode({ detect: 'cmd', strict: true })).toThrow(
      'initDevMode: expected "dev" or "prod" as a CLI argument',
    );
  });
});

describe('initDevMode — detect: node_env', () => {
  const originalEnv = process.env.NODE_ENV;

  beforeEach(() => {
    resetDevMode();
    process.env.NODE_ENV = originalEnv;
  });

  it('returns true when NODE_ENV is "development"', () => {
    process.env.NODE_ENV = 'development';
    initDevMode({ detect: 'node_env' });
    expect(getDevMode()).toBe(true);
  });

  it('returns false when NODE_ENV is "production"', () => {
    process.env.NODE_ENV = 'production';
    initDevMode({ detect: 'node_env' });
    expect(getDevMode()).toBe(false);
  });

  it('returns false when NODE_ENV is undefined', () => {
    delete process.env.NODE_ENV;
    initDevMode({ detect: 'node_env' });
    expect(getDevMode()).toBe(false);
  });
});

describe('initDevMode — detect: both (default)', () => {
  const originalArgv = process.argv;
  const originalEnv = process.env.NODE_ENV;

  beforeEach(() => {
    resetDevMode();
    process.argv = [...originalArgv];
    process.env.NODE_ENV = originalEnv;
  });

  it('cmd takes precedence over NODE_ENV when "dev" is in argv', () => {
    process.argv = ['node', 'server.js', 'dev'];
    process.env.NODE_ENV = 'production';
    initDevMode({ detect: 'both' });
    expect(getDevMode()).toBe(true);
  });

  it('cmd takes precedence over NODE_ENV when "prod" is in argv', () => {
    process.argv = ['node', 'server.js', 'prod'];
    process.env.NODE_ENV = 'development';
    initDevMode({ detect: 'both' });
    expect(getDevMode()).toBe(false);
  });

  it('falls back to NODE_ENV when argv has neither "dev" nor "prod"', () => {
    process.argv = ['node', 'server.js'];
    process.env.NODE_ENV = 'development';
    initDevMode({ detect: 'both' });
    expect(getDevMode()).toBe(true);
  });

  it('omitting param behaves the same as detect: both', () => {
    process.argv = ['node', 'server.js'];
    process.env.NODE_ENV = 'development';
    initDevMode();
    expect(getDevMode()).toBe(true);
  });
});

describe('overrideDevMode', () => {
  beforeEach(resetDevMode);

  it('forces true even after initDevMode set false', () => {
    initDevMode(false);
    overrideDevMode(true);
    expect(getDevMode()).toBe(true);
  });

  it('forces false even after initDevMode set true', () => {
    initDevMode(true);
    overrideDevMode(false);
    expect(getDevMode()).toBe(false);
  });

  it('sets value without prior initDevMode call', () => {
    overrideDevMode(true);
    expect(getDevMode()).toBe(true);
  });

  it('redetect replays the original initDevMode param', () => {
    initDevMode(true);
    overrideDevMode(false); // force to false
    overrideDevMode('redetect'); // should replay initDevMode(true)
    expect(getDevMode()).toBe(true);
  });

  it('redetect with no prior initDevMode behaves like detect: both', () => {
    // No initDevMode called — savedParam is undefined, resolves to detectValue('both')
    // Just verify it doesn't throw
    expect(() => overrideDevMode('redetect')).not.toThrow();
  });
});
