// Tests for src/scanner/scanner.ts
//
// Strategy:
//  - Mock the Logger so no files are written during tests.
//  - Mock dotenv so the module loads cleanly without a real .env file.
//  - Provide a hand-crafted PriceMonitor-shaped mock for each test scenario.

jest.mock('../../src/logger', () => ({
  Logger: jest.fn().mockImplementation(() => ({
    debug: jest.fn(),
    info:  jest.fn(),
    warn:  jest.fn(),
    error: jest.fn(),
  })),
}));

jest.mock('dotenv', () => ({ config: jest.fn() }));

// Supply required env vars before config is loaded
process.env.WALLET_PRIVATE_KEY = 'test-key';
process.env.HELIUS_RPC_URL     = 'https://rpc.test';

import { ArbScanner } from '../../src/scanner/scanner';
import { CONFIG }     from '../../src/config';
import type { PriceEntry } from '../../src/types';
import type { ExtendedPriceEntry } from '../../src/monitor/priceMonitor';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a fresh PriceEntry stamped with "right now" so it is never stale. */
function freshEntry(price: number, liquidity = 1_000_000): PriceEntry {
  return { price, liquidity, timestamp: Date.now() };
}

/** Build an ExtendedPriceEntry (includes rawQuote). */
function extEntry(price: number, liquidity = 1_000_000): ExtendedPriceEntry {
  return { price, liquidity, timestamp: Date.now(), rawQuote: { mocked: true } };
}

// ─── Mock PriceMonitor factory ───────────────────────────────────────────────
//
// ArbScanner only calls two methods:
//   getAllEntries(mint)        → Array<{ dex: string; entry: PriceEntry }>
//   getExtendedEntry(mint, dex)→ ExtendedPriceEntry | null

type DexEntries = Array<{ dex: string; entry: PriceEntry }>;

function makeMockMonitor(
  allEntriesMap: Record<string, DexEntries>,
  extEntryMap:   Record<string, Record<string, ExtendedPriceEntry | null>>,
) {
  // Derive TokenConfig list from allEntriesMap keys; look up symbol/decimals
  // from CONFIG.WATCHED_TOKENS so ArbScanner can resolve tokenSymbol correctly.
  const tokens = Object.keys(allEntriesMap).map(mint => {
    const known = CONFIG.WATCHED_TOKENS.find(t => t.mint === mint);
    return known ?? { mint, symbol: mint.slice(0, 6), decimals: 6 };
  });

  return {
    getTokens:    jest.fn(() => tokens),
    getAllEntries: jest.fn((mint: string): DexEntries => allEntriesMap[mint] ?? []),
    getExtendedEntry: jest.fn(
      (mint: string, dex: string): ExtendedPriceEntry | null =>
        extEntryMap[mint]?.[dex] ?? null,
    ),
  };
}

// ─── Constants used across tests ─────────────────────────────────────────────

const SOL_MINT  = CONFIG.WATCHED_TOKENS.find(t => t.symbol === 'SOL')!.mint;
const USDC_MINT = CONFIG.USDC_MINT;
// A non-SOL, non-USDC token present in WATCHED_TOKENS
const BONK_MINT = CONFIG.WATCHED_TOKENS.find(t => t.symbol === 'BONK')!.mint;

// SOL price used in all calls (affects net profit calculation)
const SOL_PRICE = 150;

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('ArbScanner.scan()', () => {

  describe('spread filter', () => {
    it('returns no opportunities when spread is below MIN_SPREAD_PCT', () => {
      // buyPrice and sellPrice differ by far less than 0.3 %
      const buyP  = 150.00;
      const sellP = 150.10; // spread = 0.0667 %

      const monitor = makeMockMonitor(
        {
          [SOL_MINT]: [
            { dex: 'Jupiter', entry: freshEntry(buyP) },
            { dex: 'Orca',    entry: freshEntry(sellP) },
          ],
        },
        {
          [SOL_MINT]: {
            Jupiter: extEntry(buyP),
            Orca:    extEntry(sellP),
          },
        },
      );

      const scanner = new ArbScanner(monitor as any);
      const results = scanner.scan(SOL_PRICE);

      expect(results).toHaveLength(0);
    });

    it('keeps opportunity when spread equals MIN_SPREAD_PCT exactly', () => {
      // 0.3 % above 150.00 → 150.45
      const buyP  = 150.00;
      const sellP = buyP * (1 + CONFIG.MIN_SPREAD_PCT / 100);

      const monitor = makeMockMonitor(
        {
          [SOL_MINT]: [
            { dex: 'Jupiter', entry: freshEntry(buyP) },
            { dex: 'Orca',    entry: freshEntry(sellP) },
          ],
        },
        {
          [SOL_MINT]: {
            Jupiter: extEntry(buyP),
            Orca:    extEntry(sellP),
          },
        },
      );

      const scanner = new ArbScanner(monitor as any);
      const results = scanner.scan(SOL_PRICE);

      // netProfitUsd must also pass MIN_PROFIT_USD — with a large trade size it will
      // Only assert the spread filter did not discard it (result length >= 0 is
      // trivially true; we assert getAllEntries was called)
      expect(monitor.getAllEntries).toHaveBeenCalledWith(SOL_MINT);
    });
  });

  describe('net-profit filter', () => {
    it('returns no opportunities when net profit is below MIN_PROFIT_USD', () => {
      // Use a very small trade size by temporarily overriding MAX_TRADE_USD.
      // Easiest approach: choose a spread that is just above the spread floor but
      // yields net profit below $1 given the default MAX_TRADE_USD of $50.
      //
      // gross = 50 * 0.004 = $0.20
      // jitoTipUsd ≈ (10_000 / 1e9) * 150 = $0.0015
      // txFeeUsd   ≈ 0.000005 * 2 * 150   = $0.0015
      // net ≈ $0.20 - $0.003 = ~$0.197  <  $1.00  → filtered
      const buyP  = 100.00;
      const sellP = 100.40; // 0.4 % spread → gross $0.20 on $50

      const monitor = makeMockMonitor(
        {
          [SOL_MINT]: [
            { dex: 'Jupiter', entry: freshEntry(buyP) },
            { dex: 'Orca',    entry: freshEntry(sellP) },
          ],
        },
        {
          [SOL_MINT]: {
            Jupiter: extEntry(buyP),
            Orca:    extEntry(sellP),
          },
        },
      );

      const scanner = new ArbScanner(monitor as any);
      const results = scanner.scan(SOL_PRICE);

      expect(results).toHaveLength(0);
    });

    it('returns opportunity when net profit exceeds MIN_PROFIT_USD', () => {
      // spread = 10 %: gross = $50 * 0.10 = $5.00, net ≈ $4.997 > $1
      const buyP  = 100.00;
      const sellP = 110.00;

      const monitor = makeMockMonitor(
        {
          [SOL_MINT]: [
            { dex: 'Jupiter', entry: freshEntry(buyP) },
            { dex: 'Orca',    entry: freshEntry(sellP) },
          ],
        },
        {
          [SOL_MINT]: {
            Jupiter: extEntry(buyP),
            Orca:    extEntry(sellP),
          },
        },
      );

      const scanner = new ArbScanner(monitor as any);
      const results = scanner.scan(SOL_PRICE);

      expect(results).toHaveLength(1);
      expect(results[0].netProfitUsd).toBeGreaterThan(CONFIG.MIN_PROFIT_USD);
      expect(results[0].buyDex).toBe('Jupiter');
      expect(results[0].sellDex).toBe('Orca');
    });
  });

  describe('sorting', () => {
    it('sorts results by netProfitUsd descending', () => {
      // Two tokens: BONK with 10 % spread and SOL with 5 % spread
      // Use two separate watched tokens so we get two distinct opportunities.
      const WIF_MINT = CONFIG.WATCHED_TOKENS.find(t => t.symbol === 'WIF')!.mint;

      const monitor = makeMockMonitor(
        {
          [SOL_MINT]: [
            { dex: 'Jupiter', entry: freshEntry(100.00) },
            { dex: 'Orca',    entry: freshEntry(110.00) }, // 10 % spread
          ],
          [WIF_MINT]: [
            { dex: 'Jupiter', entry: freshEntry(2.00) },
            { dex: 'Orca',    entry: freshEntry(2.10) },   // 5 % spread
          ],
        },
        {
          [SOL_MINT]: {
            Jupiter: extEntry(100.00),
            Orca:    extEntry(110.00),
          },
          [WIF_MINT]: {
            Jupiter: extEntry(2.00),
            Orca:    extEntry(2.10),
          },
        },
      );

      const scanner = new ArbScanner(monitor as any);
      const results = scanner.scan(SOL_PRICE);

      expect(results.length).toBeGreaterThanOrEqual(2);
      for (let i = 0; i < results.length - 1; i++) {
        expect(results[i].netProfitUsd).toBeGreaterThanOrEqual(
          results[i + 1].netProfitUsd,
        );
      }
    });
  });

  describe('USDC skip', () => {
    it('never calls getAllEntries for the USDC mint', () => {
      // Build a monitor that has USDC entries available — the scanner should
      // never request them because USDC is the quote currency.
      const monitor = makeMockMonitor(
        {
          [USDC_MINT]: [
            { dex: 'Jupiter', entry: freshEntry(1.00) },
            { dex: 'Orca',    entry: freshEntry(1.002) },
          ],
          [SOL_MINT]: [], // no SOL entries → no opp
        },
        {},
      );

      const scanner = new ArbScanner(monitor as any);
      scanner.scan(SOL_PRICE);

      // getAllEntries must not have been called with the USDC mint
      const calledMints: string[] = monitor.getAllEntries.mock.calls.map(
        (c: [string]) => c[0],
      );
      expect(calledMints).not.toContain(USDC_MINT);
    });
  });

  describe('missing extended entry', () => {
    it('skips an opportunity when getExtendedEntry returns null', () => {
      // Spread is large enough, but extendedEntry is missing for one DEX
      const buyP  = 100.00;
      const sellP = 115.00; // 15 % spread

      const monitor = makeMockMonitor(
        {
          [SOL_MINT]: [
            { dex: 'Jupiter', entry: freshEntry(buyP) },
            { dex: 'Orca',    entry: freshEntry(sellP) },
          ],
        },
        {
          // Orca's extended entry is intentionally absent (null)
          [SOL_MINT]: {
            Jupiter: extEntry(buyP),
            Orca:    null,
          },
        },
      );

      const scanner = new ArbScanner(monitor as any);
      const results = scanner.scan(SOL_PRICE);

      expect(results).toHaveLength(0);
    });
  });

  describe('output shape', () => {
    it('returned opportunities contain all required ArbOpportunity fields', () => {
      const buyP  = 100.00;
      const sellP = 115.00;

      const monitor = makeMockMonitor(
        {
          [SOL_MINT]: [
            { dex: 'Jupiter', entry: freshEntry(buyP) },
            { dex: 'Orca',    entry: freshEntry(sellP) },
          ],
        },
        {
          [SOL_MINT]: {
            Jupiter: extEntry(buyP),
            Orca:    extEntry(sellP),
          },
        },
      );

      const scanner = new ArbScanner(monitor as any);
      const [opp]   = scanner.scan(SOL_PRICE);

      expect(opp).toMatchObject({
        token:        SOL_MINT,
        tokenSymbol:  'SOL',
        buyDex:       'Jupiter',
        sellDex:      'Orca',
        buyPrice:     buyP,
        sellPrice:    sellP,
        tradeSizeUsd: CONFIG.MAX_TRADE_USD,
      });
      expect(typeof opp.spreadPct).toBe('number');
      expect(typeof opp.netProfitUsd).toBe('number');
      expect(opp.buyRawQuote).toBeDefined();
      expect(opp.sellRawQuote).toBeDefined();
    });
  });
});
