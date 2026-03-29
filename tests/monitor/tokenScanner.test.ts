/**
 * tests/monitor/tokenScanner.test.ts
 *
 * Tests the production TokenScanner implementation:
 * - Birdeye top-N token fetching
 * - Stablecoin filtering (USDC/USDT/etc excluded)
 * - Fallback to CONFIG.WATCHED_TOKENS when BIRDEYE_API_KEY missing
 * - API failure → keep existing watched list (no throw)
 * - updateTokens() push into PriceMonitor after successful scan
 * - start() / stop() lifecycle
 */

import axios from 'axios';
import { TokenScanner } from '../../src/monitor/tokenScanner';

// ── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('axios');

const DEFAULT_TOKENS = [
  { symbol: 'SOL', mint: 'So11111111111111111111111111111111111111112', decimals: 9 },
];

jest.mock('../../src/config', () => ({
  CONFIG: {
    BIRDEYE_API_KEY:        'test-birdeye-key',
    TOKEN_SCAN_INTERVAL_MS: 999_999,   // prevent auto-reschedule in tests
    TOKEN_SCAN_TOP_N:       5,
    WATCHED_TOKENS: [
      { symbol: 'SOL', mint: 'So11111111111111111111111111111111111111112', decimals: 9 },
    ],
  },
  runtimeConfig: { watchedTokens: [] },
}));

jest.mock('../../src/logger', () => ({
  Logger: jest.fn().mockImplementation(() => ({
    info:  jest.fn(),
    warn:  jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  })),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Lightweight PriceMonitor mock — only needs updateTokens()
jest.mock('../../src/monitor/priceMonitor', () => ({
  PriceMonitor: jest.fn().mockImplementation(() => ({
    updateTokens: jest.fn(),
    getTokens:    jest.fn().mockReturnValue([]),
    start:        jest.fn(),
    stop:         jest.fn(),
    getMap:       jest.fn().mockReturnValue({}),
  })),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const mockedAxios = axios as jest.Mocked<typeof axios>;

/** Builds a Birdeye tokenlist API response. */
function birdeyeResponse(tokens: Array<{ address: string; symbol: string; decimals?: number; v24hUSD?: number }>) {
  return {
    data: {
      data: {
        tokens: tokens.map(t => ({
          address:  t.address,
          symbol:   t.symbol,
          decimals: t.decimals ?? 6,
          v24hUSD:  t.v24hUSD ?? 1_000_000,
        })),
      },
    },
  };
}

const SAMPLE_TOKENS = [
  { address: 'BONK_MINT_1111111111111111111111111111', symbol: 'BONK', decimals: 5, v24hUSD: 9_000_000 },
  { address: 'WIF__MINT_1111111111111111111111111111', symbol: 'WIF',  decimals: 6, v24hUSD: 7_000_000 },
  { address: 'JTO__MINT_1111111111111111111111111111', symbol: 'JTO',  decimals: 9, v24hUSD: 5_000_000 },
];

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TokenScanner — construction & initial state', () => {
  test('constructs without arguments', () => {
    expect(() => new TokenScanner()).not.toThrow();
  });

  test('constructs with a PriceMonitor reference', async () => {
    const { PriceMonitor } = await import('../../src/monitor/priceMonitor');
    const pm = new PriceMonitor([]);
    expect(() => new TokenScanner(pm)).not.toThrow();
  });

  test('getWatchedTokens() returns CONFIG.WATCHED_TOKENS initially', () => {
    const scanner = new TokenScanner();
    const tokens = scanner.getWatchedTokens();
    expect(tokens).toEqual(DEFAULT_TOKENS);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('TokenScanner — stop()', () => {
  test('stop() does not throw before start()', () => {
    const scanner = new TokenScanner();
    expect(() => scanner.stop()).not.toThrow();
  });

  test('stop() does not throw after start()', async () => {
    mockedAxios.get.mockResolvedValueOnce(birdeyeResponse(SAMPLE_TOKENS));
    const scanner = new TokenScanner();
    await scanner.start();
    expect(() => scanner.stop()).not.toThrow();
  });

  test('stop() is idempotent (safe to call twice)', async () => {
    mockedAxios.get.mockResolvedValueOnce(birdeyeResponse(SAMPLE_TOKENS));
    const scanner = new TokenScanner();
    await scanner.start();
    scanner.stop();
    expect(() => scanner.stop()).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('TokenScanner — successful scan', () => {
  afterEach(() => jest.clearAllMocks());

  test('getWatchedTokens() is updated after a successful scan', async () => {
    mockedAxios.get.mockResolvedValueOnce(birdeyeResponse(SAMPLE_TOKENS));

    const scanner = new TokenScanner();
    await scanner.start();
    scanner.stop();

    const tokens = scanner.getWatchedTokens();
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens[0]).toHaveProperty('mint');
    expect(tokens[0]).toHaveProperty('symbol');
    expect(tokens[0]).toHaveProperty('decimals');
  });

  test('mint and symbol are mapped from Birdeye address/symbol fields', async () => {
    mockedAxios.get.mockResolvedValueOnce(birdeyeResponse(SAMPLE_TOKENS));

    const scanner = new TokenScanner();
    await scanner.start();
    scanner.stop();

    const mints = scanner.getWatchedTokens().map(t => t.mint);
    expect(mints).toContain('BONK_MINT_1111111111111111111111111111');
  });

  test('respects TOKEN_SCAN_TOP_N limit (max 5 in mock config)', async () => {
    const manyTokens = Array.from({ length: 20 }, (_, i) => ({
      address: `MINT${i}_111111111111111111111111111111`,
      symbol:  `TOK${i}`,
      decimals: 6,
      v24hUSD:  10_000_000 - i * 100_000,
    }));

    mockedAxios.get.mockResolvedValueOnce(birdeyeResponse(manyTokens));

    const scanner = new TokenScanner();
    await scanner.start();
    scanner.stop();

    expect(scanner.getWatchedTokens().length).toBeLessThanOrEqual(5);
  });

  test('decimals default to 6 when missing from API response', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        data: {
          tokens: [{ address: 'MINT_NO_DEC_111111111111111111111111', symbol: 'NODEC' }],
        },
      },
    });

    const scanner = new TokenScanner();
    await scanner.start();
    scanner.stop();

    const tokens = scanner.getWatchedTokens();
    if (tokens.length > 0) {
      expect(tokens[0].decimals).toBe(6);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('TokenScanner — stablecoin filtering', () => {
  afterEach(() => jest.clearAllMocks());

  test('USDC is excluded from watched list', async () => {
    mockedAxios.get.mockResolvedValueOnce(birdeyeResponse([
      ...SAMPLE_TOKENS,
      { address: 'USDC_MINT', symbol: 'USDC', decimals: 6, v24hUSD: 100_000_000 },
    ]));

    const scanner = new TokenScanner();
    await scanner.start();
    scanner.stop();

    const symbols = scanner.getWatchedTokens().map(t => t.symbol);
    expect(symbols).not.toContain('USDC');
  });

  test('USDT is excluded from watched list', async () => {
    mockedAxios.get.mockResolvedValueOnce(birdeyeResponse([
      ...SAMPLE_TOKENS,
      { address: 'USDT_MINT', symbol: 'USDT', decimals: 6, v24hUSD: 100_000_000 },
    ]));

    const scanner = new TokenScanner();
    await scanner.start();
    scanner.stop();

    const symbols = scanner.getWatchedTokens().map(t => t.symbol);
    expect(symbols).not.toContain('USDT');
  });

  test('when all tokens are stablecoins, existing list is kept', async () => {
    mockedAxios.get.mockResolvedValueOnce(birdeyeResponse([
      { address: 'USDC_MINT', symbol: 'USDC', decimals: 6 },
      { address: 'USDT_MINT', symbol: 'USDT', decimals: 6 },
      { address: 'DAI__MINT', symbol: 'DAI',  decimals: 6 },
    ]));

    const scanner = new TokenScanner();
    const before = scanner.getWatchedTokens();
    await scanner.start();
    scanner.stop();

    // Should not have replaced the list with an empty array
    expect(scanner.getWatchedTokens()).toEqual(before);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('TokenScanner — API failure handling', () => {
  afterEach(() => jest.clearAllMocks());

  test('does not throw on network error — keeps existing list', async () => {
    mockedAxios.get.mockRejectedValueOnce(new Error('Network error'));

    const scanner = new TokenScanner();
    const before = scanner.getWatchedTokens();
    await expect(scanner.start()).resolves.not.toThrow();
    scanner.stop();

    // List must be unchanged
    expect(scanner.getWatchedTokens()).toEqual(before);
  });

  test('does not throw on empty token list — keeps existing list', async () => {
    mockedAxios.get.mockResolvedValueOnce(birdeyeResponse([]));

    const scanner = new TokenScanner();
    const before = scanner.getWatchedTokens();
    await scanner.start();
    scanner.stop();

    expect(scanner.getWatchedTokens()).toEqual(before);
  });

  test('does not throw on malformed API response', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: null });

    const scanner = new TokenScanner();
    const before = scanner.getWatchedTokens();
    await expect(scanner.start()).resolves.not.toThrow();
    scanner.stop();

    expect(scanner.getWatchedTokens()).toEqual(before);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('TokenScanner — no BIRDEYE_API_KEY', () => {
  afterEach(() => jest.clearAllMocks());

  test('skips scan and keeps default list when API key is empty', async () => {
    // Temporarily override BIRDEYE_API_KEY to empty string
    const configMod = await import('../../src/config');
    const originalKey = configMod.CONFIG.BIRDEYE_API_KEY;
    (configMod.CONFIG as Record<string, unknown>).BIRDEYE_API_KEY = '';

    const scanner = new TokenScanner();
    const before = scanner.getWatchedTokens();
    await scanner.start();
    scanner.stop();

    expect(scanner.getWatchedTokens()).toEqual(before);
    // Axios should not have been called
    expect(mockedAxios.get).not.toHaveBeenCalled();

    // Restore
    (configMod.CONFIG as Record<string, unknown>).BIRDEYE_API_KEY = originalKey;
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('TokenScanner — PriceMonitor integration', () => {
  afterEach(() => jest.clearAllMocks());

  test('calls priceMonitor.updateTokens() after successful scan', async () => {
    const { PriceMonitor } = await import('../../src/monitor/priceMonitor');
    const pm = new PriceMonitor([]);
    mockedAxios.get.mockResolvedValueOnce(birdeyeResponse(SAMPLE_TOKENS));

    const scanner = new TokenScanner(pm);
    await scanner.start();
    scanner.stop();

    expect(pm.updateTokens).toHaveBeenCalledTimes(1);
    const passedTokens = (pm.updateTokens as jest.Mock).mock.calls[0][0];
    expect(Array.isArray(passedTokens)).toBe(true);
    expect(passedTokens.length).toBeGreaterThan(0);
  });

  test('does NOT call priceMonitor.updateTokens() when scan fails', async () => {
    const { PriceMonitor } = await import('../../src/monitor/priceMonitor');
    const pm = new PriceMonitor([]);
    mockedAxios.get.mockRejectedValueOnce(new Error('API down'));

    const scanner = new TokenScanner(pm);
    await scanner.start();
    scanner.stop();

    expect(pm.updateTokens).not.toHaveBeenCalled();
  });

  test('does NOT call priceMonitor.updateTokens() when all tokens filtered', async () => {
    const { PriceMonitor } = await import('../../src/monitor/priceMonitor');
    const pm = new PriceMonitor([]);
    mockedAxios.get.mockResolvedValueOnce(birdeyeResponse([
      { address: 'USDC_MINT', symbol: 'USDC' },
      { address: 'USDT_MINT', symbol: 'USDT' },
    ]));

    const scanner = new TokenScanner(pm);
    await scanner.start();
    scanner.stop();

    expect(pm.updateTokens).not.toHaveBeenCalled();
  });

  test('works correctly without a PriceMonitor (no crash)', async () => {
    mockedAxios.get.mockResolvedValueOnce(birdeyeResponse(SAMPLE_TOKENS));
    const scanner = new TokenScanner(); // no PriceMonitor
    await expect(scanner.start()).resolves.not.toThrow();
    scanner.stop();
  });
});
