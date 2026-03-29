/**
 * tests/monitor/priceMonitor.test.ts
 *
 * Tests the production PriceMonitor implementation:
 * - 4-DEX Jupiter V6 quote fetching (Jupiter, Orca, Raydium, Meteora)
 * - ExtendedPriceEntry with rawQuote payload
 * - Staleness filtering in getAllEntries()
 * - updateTokens() live swap
 * - start() / stop() lifecycle
 */

import axios from 'axios';
import { PriceMonitor } from '../../src/monitor/priceMonitor';
import type { TokenConfig } from '../../src/config';

// ── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('axios');

jest.mock('../../src/config', () => ({
  CONFIG: {
    POLL_INTERVAL_MS:   200,
    PRICE_STALENESS_MS: 500,
    USDC_MINT:          'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    MAX_SLIPPAGE_BPS:   50,
    WATCHED_TOKENS: [
      { symbol: 'SOL', mint: 'So11111111111111111111111111111111111111112', decimals: 9 },
    ],
  },
  runtimeConfig: {
    watchedTokens: [
      { symbol: 'SOL', mint: 'So11111111111111111111111111111111111111112', decimals: 9 },
    ],
  },
}));

jest.mock('../../src/logger', () => ({
  Logger: jest.fn().mockImplementation(() => ({
    info:  jest.fn(),
    warn:  jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    trade: jest.fn(),
    tune:  jest.fn(),
  })),
  logger: {
    info:  jest.fn(),
    warn:  jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    trade: jest.fn(),
    tune:  jest.fn(),
  },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const SOL_MINT     = 'So11111111111111111111111111111111111111112';
const SOL_TOKEN: TokenConfig = { symbol: 'SOL', mint: SOL_MINT, decimals: 9 };

/** Jupiter V6 /quote response shape with a realistic outAmount. */
function jupiterQuoteResponse(outAmount: number) {
  return {
    data: {
      inputMint:    SOL_MINT,
      outputMint:   'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      inAmount:     '10000000000', // 10 SOL in lamports
      outAmount:    String(outAmount),
      otherAmountThreshold: String(outAmount - 1000),
      swapMode: 'ExactIn',
      routePlan: [],
    },
  };
}

const mockedAxios = axios as jest.Mocked<typeof axios>;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PriceMonitor — construction & initial state', () => {
  test('constructs with a token list', () => {
    const monitor = new PriceMonitor([SOL_TOKEN]);
    expect(monitor).toBeInstanceOf(PriceMonitor);
  });

  test('getMap() returns empty object before any fetch', () => {
    const monitor = new PriceMonitor([SOL_TOKEN]);
    expect(monitor.getMap()).toEqual({});
  });

  test('getAllEntries() returns [] for unknown mint', () => {
    const monitor = new PriceMonitor([SOL_TOKEN]);
    expect(monitor.getAllEntries('unknown-mint')).toEqual([]);
  });

  test('getExtendedEntry() returns null before any fetch', () => {
    const monitor = new PriceMonitor([SOL_TOKEN]);
    expect(monitor.getExtendedEntry(SOL_MINT, 'Jupiter')).toBeNull();
  });

  test('getTokens() returns the constructed token list', () => {
    const monitor = new PriceMonitor([SOL_TOKEN]);
    expect(monitor.getTokens()).toEqual([SOL_TOKEN]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('PriceMonitor — start() / stop() lifecycle', () => {
  beforeEach(() => {
    mockedAxios.get.mockResolvedValue(jupiterQuoteResponse(1_500_000_000)); // $150 per SOL-equiv
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('start() completes initial fetch without throwing', async () => {
    const monitor = new PriceMonitor([SOL_TOKEN]);
    await expect(monitor.start()).resolves.not.toThrow();
    monitor.stop();
  });

  test('stop() does not throw before start()', () => {
    const monitor = new PriceMonitor([SOL_TOKEN]);
    expect(() => monitor.stop()).not.toThrow();
  });

  test('stop() does not throw after start()', async () => {
    const monitor = new PriceMonitor([SOL_TOKEN]);
    await monitor.start();
    expect(() => monitor.stop()).not.toThrow();
  });

  test('stop() is idempotent (safe to call twice)', async () => {
    const monitor = new PriceMonitor([SOL_TOKEN]);
    await monitor.start();
    monitor.stop();
    expect(() => monitor.stop()).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('PriceMonitor — cache population after start()', () => {
  afterEach(() => jest.clearAllMocks());

  test('getMap() has an entry for SOL after successful fetch', async () => {
    mockedAxios.get.mockResolvedValue(jupiterQuoteResponse(1_500_000_000));

    const monitor = new PriceMonitor([SOL_TOKEN]);
    await monitor.start();
    monitor.stop();

    const map = monitor.getMap();
    expect(map[SOL_MINT]).toBeDefined();
  });

  test('at least one DEX is populated after a successful fetch', async () => {
    mockedAxios.get.mockResolvedValue(jupiterQuoteResponse(1_500_000_000));

    const monitor = new PriceMonitor([SOL_TOKEN]);
    await monitor.start();
    monitor.stop();

    const entries = monitor.getAllEntries(SOL_MINT);
    expect(entries.length).toBeGreaterThanOrEqual(1);
  });

  test('each populated entry has a positive price and recent timestamp', async () => {
    const before = Date.now();
    mockedAxios.get.mockResolvedValue(jupiterQuoteResponse(1_500_000_000));

    const monitor = new PriceMonitor([SOL_TOKEN]);
    await monitor.start();
    monitor.stop();

    const entries = monitor.getAllEntries(SOL_MINT);
    for (const { entry } of entries) {
      expect(entry.price).toBeGreaterThan(0);
      expect(entry.timestamp).toBeGreaterThanOrEqual(before);
    }
  });

  test('getExtendedEntry() returns rawQuote payload after successful fetch', async () => {
    mockedAxios.get.mockResolvedValue(jupiterQuoteResponse(1_500_000_000));

    const monitor = new PriceMonitor([SOL_TOKEN]);
    await monitor.start();
    monitor.stop();

    // At least one of the four DEXes should have an extended entry
    const dexes = ['Jupiter', 'Orca', 'Raydium', 'Meteora'];
    const found = dexes.some(dex => monitor.getExtendedEntry(SOL_MINT, dex) !== null);
    expect(found).toBe(true);
  });

  test('getPriceEntry() returns a PriceEntry for populated (mint, dex)', async () => {
    mockedAxios.get.mockResolvedValue(jupiterQuoteResponse(1_500_000_000));

    const monitor = new PriceMonitor([SOL_TOKEN]);
    await monitor.start();
    monitor.stop();

    // Find which DEX was populated
    const entries = monitor.getAllEntries(SOL_MINT);
    if (entries.length > 0) {
      const { dex } = entries[0];
      const pe = monitor.getPriceEntry(SOL_MINT, dex);
      expect(pe).not.toBeNull();
      expect(pe!.price).toBeGreaterThan(0);
    }
  });

  test('getPriceEntry() returns null for non-existent (mint, dex)', async () => {
    mockedAxios.get.mockResolvedValue(jupiterQuoteResponse(1_500_000_000));

    const monitor = new PriceMonitor([SOL_TOKEN]);
    await monitor.start();
    monitor.stop();

    expect(monitor.getPriceEntry(SOL_MINT, 'NonExistentDEX')).toBeNull();
    expect(monitor.getPriceEntry('bad-mint', 'Jupiter')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('PriceMonitor — API failure handling', () => {
  afterEach(() => jest.clearAllMocks());

  test('getAllEntries() returns [] when all DEX fetches fail', async () => {
    mockedAxios.get.mockRejectedValue(new Error('Network error'));

    const monitor = new PriceMonitor([SOL_TOKEN]);
    await monitor.start();
    monitor.stop();

    // No entries should be cached when all fetches fail
    expect(monitor.getAllEntries(SOL_MINT)).toEqual([]);
  });

  test('getMap() returns {} when all DEX fetches fail', async () => {
    mockedAxios.get.mockRejectedValue(new Error('Network error'));

    const monitor = new PriceMonitor([SOL_TOKEN]);
    await monitor.start();
    monitor.stop();

    expect(monitor.getMap()).toEqual({});
  });

  test('partial failure: some DEXes succeed and are cached', async () => {
    // First two calls succeed (Jupiter + Orca), last two fail (Raydium + Meteora)
    mockedAxios.get
      .mockResolvedValueOnce(jupiterQuoteResponse(1_500_000_000))
      .mockResolvedValueOnce(jupiterQuoteResponse(1_502_000_000))
      .mockRejectedValueOnce(new Error('Raydium timeout'))
      .mockRejectedValueOnce(new Error('Meteora timeout'));

    const monitor = new PriceMonitor([SOL_TOKEN]);
    await monitor.start();
    monitor.stop();

    const entries = monitor.getAllEntries(SOL_MINT);
    // At least 1 entry from the two successful calls
    expect(entries.length).toBeGreaterThanOrEqual(1);
  });

  test('zero outAmount is treated as no quote (entry not cached)', async () => {
    mockedAxios.get.mockResolvedValue(jupiterQuoteResponse(0)); // outAmount = 0

    const monitor = new PriceMonitor([SOL_TOKEN]);
    await monitor.start();
    monitor.stop();

    expect(monitor.getAllEntries(SOL_MINT)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('PriceMonitor — staleness filtering', () => {
  afterEach(() => jest.clearAllMocks());

  test('getAllEntries() returns empty array when all entries are stale', async () => {
    mockedAxios.get.mockResolvedValue(jupiterQuoteResponse(1_500_000_000));

    const monitor = new PriceMonitor([SOL_TOKEN]);
    await monitor.start();
    monitor.stop();

    // Manually back-date all cached entries to force staleness
    const map = monitor.getMap();
    for (const dexMap of Object.values(map)) {
      for (const entry of Object.values(dexMap)) {
        // PRICE_STALENESS_MS = 500 in mock; set timestamp 1s in the past
        (entry as { timestamp: number }).timestamp = Date.now() - 1000;
      }
    }

    expect(monitor.getAllEntries(SOL_MINT)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('PriceMonitor — updateTokens()', () => {
  afterEach(() => jest.clearAllMocks());

  const BONK_TOKEN: TokenConfig = {
    symbol: 'BONK',
    mint:   'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    decimals: 5,
  };

  test('getTokens() reflects the new list after updateTokens()', () => {
    const monitor = new PriceMonitor([SOL_TOKEN]);
    expect(monitor.getTokens()).toEqual([SOL_TOKEN]);

    monitor.updateTokens([BONK_TOKEN]);
    expect(monitor.getTokens()).toEqual([BONK_TOKEN]);
  });

  test('updateTokens() does not throw with an empty list', () => {
    const monitor = new PriceMonitor([SOL_TOKEN]);
    expect(() => monitor.updateTokens([])).not.toThrow();
    expect(monitor.getTokens()).toEqual([]);
  });

  test('updateTokens() does not throw with a larger list', () => {
    const monitor = new PriceMonitor([SOL_TOKEN]);
    expect(() => monitor.updateTokens([SOL_TOKEN, BONK_TOKEN])).not.toThrow();
    expect(monitor.getTokens()).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('PriceMonitor — price calculation accuracy', () => {
  afterEach(() => jest.clearAllMocks());

  test('computed price is outAmount/1e6 divided by trade size', async () => {
    // 10 SOL → 1,500 USDC ⟹ price = 150 USDC/SOL
    // amount = 10 * 10^9 = 10_000_000_000 lamports
    // outAmount = 1_500 * 10^6 = 1_500_000_000 USDC micro-units
    // price = (1_500_000_000 / 1e6) / (10_000_000_000 / 1e9) = 1500 / 10 = 150
    mockedAxios.get.mockResolvedValue(jupiterQuoteResponse(1_500_000_000));

    const monitor = new PriceMonitor([SOL_TOKEN]);
    await monitor.start();
    monitor.stop();

    const entries = monitor.getAllEntries(SOL_MINT);
    expect(entries.length).toBeGreaterThanOrEqual(1);

    for (const { entry } of entries) {
      // Price should be approximately $150 per SOL
      expect(entry.price).toBeCloseTo(150, 0);
    }
  });
});
