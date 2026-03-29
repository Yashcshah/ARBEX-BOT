/**
 * tests/logger.test.ts
 *
 * Verifies the Logger class and module singleton do not throw under normal
 * and edge-case conditions.  File I/O is suppressed via the config mock so
 * tests run without touching the real filesystem.
 */

import * as fs from 'fs';

// ── Mock config BEFORE importing logger ──────────────────────────────────────
jest.mock('../src/config', () => ({
  CONFIG: { LOG_DIR: './test-logs', DEBUG: false },
  runtimeConfig: {
    botHalted:       false,
    haltReason:      '',
    jitoTipLamports: 10_000,
    watchedTokens:   [],
  },
}));

// Prevent actual file-system writes during tests
jest.spyOn(fs, 'existsSync').mockReturnValue(true);
const fakeStream = {
  write: jest.fn(),
  end:   jest.fn(),
} as unknown as fs.WriteStream;
jest.spyOn(fs, 'createWriteStream').mockReturnValue(fakeStream);

// Import AFTER mocks are registered
import { Logger, logger } from '../src/logger';

// ─────────────────────────────────────────────────────────────────────────────

describe('Logger class', () => {
  let log: Logger;

  beforeEach(() => {
    log = new Logger('TestModule');
    jest.clearAllMocks();
  });

  test('info() does not throw', () => {
    expect(() => log.info('hello info')).not.toThrow();
  });

  test('info() with meta does not throw', () => {
    expect(() => log.info('with meta', { key: 'value', num: 42 })).not.toThrow();
  });

  test('warn() does not throw', () => {
    expect(() => log.warn('some warning')).not.toThrow();
  });

  test('warn() with meta does not throw', () => {
    expect(() => log.warn('warn meta', { flag: true })).not.toThrow();
  });

  test('error() does not throw with plain string', () => {
    expect(() => log.error('something failed')).not.toThrow();
  });

  test('error() with Error object appends message', () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    log.error('outer', new Error('inner error'));
    const output = spy.mock.calls[0]?.[0] ?? '';
    expect(output).toContain('inner error');
    spy.mockRestore();
  });

  test('error() with non-Error object does not throw', () => {
    expect(() => log.error('msg', { code: 500 })).not.toThrow();
  });

  test('debug() does not throw', () => {
    // DEBUG is false per mock — should be a no-op but must not throw
    expect(() => log.debug('debug message')).not.toThrow();
  });

  test('trade() does not throw', () => {
    expect(() => log.trade('trade executed')).not.toThrow();
  });

  test('trade() with meta does not throw', () => {
    expect(() =>
      log.trade('trade record', { token: 'SOL', profit: 1.23, win: true })
    ).not.toThrow();
  });

  test('tune() does not throw', () => {
    expect(() => log.tune('tip adjusted')).not.toThrow();
  });

  test('tune() with meta does not throw', () => {
    expect(() =>
      log.tune('auto-tune', { oldTip: 10_000, newTip: 15_000 })
    ).not.toThrow();
  });

  test('flushAndClose() does not throw', () => {
    expect(() => Logger.flushAndClose()).not.toThrow();
  });

  test('flushAndClose() is idempotent (safe to call twice)', () => {
    expect(() => {
      Logger.flushAndClose();
      Logger.flushAndClose();
    }).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('logger singleton', () => {
  test('is exported and is a Logger instance', () => {
    expect(logger).toBeInstanceOf(Logger);
  });

  test('info() does not throw on singleton', () => {
    expect(() => logger.info('singleton info')).not.toThrow();
  });

  test('error() does not throw on singleton', () => {
    expect(() => logger.error('singleton error')).not.toThrow();
  });

  test('trade() does not throw on singleton', () => {
    expect(() => logger.trade('singleton trade', { netProfit: 0.5 })).not.toThrow();
  });

  test('tune() does not throw on singleton', () => {
    expect(() => logger.tune('singleton tune', { tipLamports: 20_000 })).not.toThrow();
  });
});
