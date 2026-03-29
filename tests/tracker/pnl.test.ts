// Tests for src/tracker/pnl.ts
//
// PnLTracker reads/writes files.  We redirect all I/O to a temporary directory
// so real data is never touched and tests are fully isolated from each other.
//
// Approach:
//   1. Mock dotenv and the Logger (suppress console/file noise).
//   2. Set required env vars before config.ts loads.
//   3. After import, override CONFIG.DATA_DIR to point at a per-test tmpdir.
//   4. Instantiate a fresh PnLTracker per test inside the temp dir.

jest.mock('../../src/logger', () => ({
  Logger: jest.fn().mockImplementation(() => ({
    debug: jest.fn(),
    info:  jest.fn(),
    warn:  jest.fn(),
    error: jest.fn(),
  })),
}));

jest.mock('dotenv', () => ({ config: jest.fn() }));

process.env.WALLET_PRIVATE_KEY = 'test-key';
process.env.HELIUS_RPC_URL     = 'https://rpc.test';

import * as os   from 'os';
import * as fs   from 'fs';
import * as path from 'path';

import { CONFIG }     from '../../src/config';
import { PnLTracker } from '../../src/tracker/pnl';
import type { BundleResult } from '../../src/types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Create a unique temp directory for one test and point CONFIG.DATA_DIR at it. */
function setupTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pnl-test-'));
  (CONFIG as { DATA_DIR: string }).DATA_DIR = dir;
  return dir;
}

/** Remove a temp directory and all its contents. */
function teardownTempDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Build a minimal BundleResult. */
function makeResult(overrides: Partial<BundleResult> = {}): BundleResult {
  return {
    landed:      true,
    profit:      2.00,
    fees:        0.05,
    txSignature: 'sig-' + Math.random().toString(36).slice(2),
    token:       'So11111111111111111111111111111111111111112',
    tokenSymbol: 'SOL',
    timestamp:   Date.now(),
    ...overrides,
  };
}

/** Minimal opportunity context for recordResult. */
const OPP_CTX = { spreadPct: 1.0, tradeSizeUsd: 50 };

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('PnLTracker', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = setupTempDir();
  });

  afterEach(() => {
    teardownTempDir(tmpDir);
  });

  // ── getWinRate ─────────────────────────────────────────────────────────────

  describe('getWinRate()', () => {
    it('returns 0 when the trade window is empty', () => {
      const tracker = new PnLTracker();
      expect(tracker.getWinRate()).toBe(0);
    });

    it('returns 100 when every trade in the window landed', () => {
      const tracker = new PnLTracker();
      tracker.recordResult(makeResult({ landed: true }), OPP_CTX);
      tracker.recordResult(makeResult({ landed: true }), OPP_CTX);

      expect(tracker.getWinRate()).toBe(100);
    });

    it('returns 0 when every trade in the window failed to land', () => {
      const tracker = new PnLTracker();
      tracker.recordResult(makeResult({ landed: false, profit: 0, fees: 0.05 }), OPP_CTX);
      tracker.recordResult(makeResult({ landed: false, profit: 0, fees: 0.05 }), OPP_CTX);

      expect(tracker.getWinRate()).toBe(0);
    });

    it('calculates the correct percentage for a mixed window', () => {
      const tracker = new PnLTracker();

      // 3 wins, 1 loss → 75 %
      tracker.recordResult(makeResult({ landed: true  }), OPP_CTX);
      tracker.recordResult(makeResult({ landed: true  }), OPP_CTX);
      tracker.recordResult(makeResult({ landed: true  }), OPP_CTX);
      tracker.recordResult(makeResult({ landed: false, profit: 0, fees: 0.05 }), OPP_CTX);

      expect(tracker.getWinRate()).toBe(75);
    });

    it('keeps only the last WIN_RATE_WINDOW entries in the window', () => {
      const tracker   = new PnLTracker();
      const windowSz  = CONFIG.WIN_RATE_WINDOW; // 50

      // Fill the window with wins
      for (let i = 0; i < windowSz; i++) {
        tracker.recordResult(makeResult({ landed: true }), OPP_CTX);
      }
      expect(tracker.getWinRate()).toBe(100);

      // Add one more loss — oldest win should be evicted → still 98 %
      tracker.recordResult(makeResult({ landed: false, profit: 0, fees: 0.05 }), OPP_CTX);
      expect(tracker.getWinRate()).toBe(((windowSz - 1) / windowSz) * 100);
    });
  });

  // ── isBlacklisted ──────────────────────────────────────────────────────────

  describe('isBlacklisted()', () => {
    it('returns false for an unknown token on a fresh tracker', () => {
      const tracker = new PnLTracker();
      expect(tracker.isBlacklisted('some-unknown-mint')).toBe(false);
    });

    it('returns true after a token is manually added to the blacklist', () => {
      const tracker = new PnLTracker();
      const mint    = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

      tracker.addToBlacklist(mint);

      expect(tracker.isBlacklisted(mint)).toBe(true);
    });

    it('returns false after a token is removed from the blacklist', () => {
      const tracker = new PnLTracker();
      const mint    = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

      tracker.addToBlacklist(mint);
      tracker.removeFromBlacklist(mint);

      expect(tracker.isBlacklisted(mint)).toBe(false);
    });

    it('auto-blacklists a token after BLACKLIST_THRESHOLD consecutive failures', () => {
      const tracker = new PnLTracker();
      const mint    = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

      for (let i = 0; i < CONFIG.BLACKLIST_THRESHOLD; i++) {
        tracker.recordResult(
          makeResult({ token: mint, tokenSymbol: 'BONK', landed: false, profit: 0, fees: 0.05 }),
          OPP_CTX,
        );
      }

      expect(tracker.isBlacklisted(mint)).toBe(true);
    });
  });

  // ── recordResult ──────────────────────────────────────────────────────────

  describe('recordResult()', () => {
    it('increments totalTrades after each call', () => {
      const tracker = new PnLTracker();

      expect(tracker.getState().totalTrades).toBe(0);

      tracker.recordResult(makeResult(), OPP_CTX);
      expect(tracker.getState().totalTrades).toBe(1);

      tracker.recordResult(makeResult(), OPP_CTX);
      expect(tracker.getState().totalTrades).toBe(2);
    });

    it('increments wins for a landed trade', () => {
      const tracker = new PnLTracker();
      tracker.recordResult(makeResult({ landed: true }), OPP_CTX);

      const state = tracker.getState();
      expect(state.wins).toBe(1);
      expect(state.losses).toBe(0);
    });

    it('increments losses for a trade that did not land', () => {
      const tracker = new PnLTracker();
      tracker.recordResult(
        makeResult({ landed: false, profit: 0, fees: 0.05 }),
        OPP_CTX,
      );

      const state = tracker.getState();
      expect(state.wins).toBe(0);
      expect(state.losses).toBe(1);
    });

    it('accumulates dailyLoss when a bundle does not land', () => {
      const tracker = new PnLTracker();
      const fees    = 0.07;

      tracker.recordResult(
        makeResult({ landed: false, profit: 0, fees }),
        OPP_CTX,
      );

      expect(tracker.getState().dailyLoss).toBeCloseTo(fees);
    });

    it('accumulates dailyLoss when a landed trade has negative profit', () => {
      const tracker = new PnLTracker();
      const loss    = -0.50;

      tracker.recordResult(
        makeResult({ landed: true, profit: loss, fees: 0.05 }),
        OPP_CTX,
      );

      expect(tracker.getState().dailyLoss).toBeCloseTo(Math.abs(loss));
    });

    it('does not increase dailyLoss for a profitable landed trade', () => {
      const tracker = new PnLTracker();

      tracker.recordResult(makeResult({ landed: true, profit: 3.00, fees: 0.05 }), OPP_CTX);

      expect(tracker.getState().dailyLoss).toBe(0);
    });

    it('appends the record to the trades.json file', () => {
      const tracker    = new PnLTracker();
      const tradesFile = path.join(tmpDir, 'trades.json');

      tracker.recordResult(makeResult(), OPP_CTX);

      expect(fs.existsSync(tradesFile)).toBe(true);
      const lines = fs.readFileSync(tradesFile, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]);
      expect(parsed.tokenSymbol).toBe('SOL');
    });
  });

  // ── checkDailyReset ───────────────────────────────────────────────────────

  describe('checkDailyReset()', () => {
    it('resets dailyLoss to 0 when the date changes', () => {
      const tracker = new PnLTracker();

      // Manually inject an old date into state so a reset is triggered
      // We access the private state via getState which returns a copy,
      // so we manipulate it through a fresh tracker that starts with today.
      // Instead, spy on Date to simulate the day rolling over.

      // First: record a loss today
      tracker.recordResult(
        makeResult({ landed: false, profit: 0, fees: 0.10 }),
        OPP_CTX,
      );
      expect(tracker.getState().dailyLoss).toBeGreaterThan(0);

      // Now simulate date changing to tomorrow by overriding Date
      const ORIGINAL_DATE = Date;
      const tomorrow = new Date();
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      const tomorrowISO = tomorrow.toISOString();

      // Override Date so toISOString().slice(0,10) returns tomorrow's date
      global.Date = class extends ORIGINAL_DATE {
        toISOString(): string {
          return tomorrowISO;
        }
      } as unknown as typeof Date;

      try {
        tracker.checkDailyReset();
        // After the reset dailyLoss should be 0 (no trades exist for "tomorrow")
        expect(tracker.getState().dailyLoss).toBe(0);
      } finally {
        global.Date = ORIGINAL_DATE;
      }
    });

    it('does NOT reset dailyLoss when the date has not changed', () => {
      const tracker = new PnLTracker();

      tracker.recordResult(
        makeResult({ landed: false, profit: 0, fees: 0.10 }),
        OPP_CTX,
      );
      const lossBeforeReset = tracker.getState().dailyLoss;

      // checkDailyReset with the same date should be a no-op
      tracker.checkDailyReset();

      expect(tracker.getState().dailyLoss).toBeCloseTo(lossBeforeReset);
    });

    it('sets lastDailyReset to today on the first call', () => {
      const tracker = new PnLTracker();
      const today   = new Date().toISOString().slice(0, 10);

      tracker.checkDailyReset();

      expect(tracker.getState().lastDailyReset).toBe(today);
    });
  });

  // ── getState ──────────────────────────────────────────────────────────────

  describe('getState()', () => {
    it('returns a shallow copy — mutating the result does not affect internal state', () => {
      const tracker = new PnLTracker();

      const state = tracker.getState();
      state.totalTrades = 999;

      expect(tracker.getState().totalTrades).toBe(0);
    });

    it('returns a copy of blacklistedTokens — mutating it does not affect state', () => {
      const tracker = new PnLTracker();
      const mint    = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

      tracker.addToBlacklist(mint);

      const state = tracker.getState();
      state.blacklistedTokens.push('extra-mint');

      expect(tracker.getState().blacklistedTokens).toHaveLength(1);
    });
  });

  // ── flush ─────────────────────────────────────────────────────────────────

  describe('flush()', () => {
    it('does not throw', () => {
      const tracker = new PnLTracker();
      expect(() => tracker.flush()).not.toThrow();
    });
  });
});
