// Tests for src/safety/riskGuard.ts
//
// RiskGuard depends on PnLTracker and CONFIG.  We mock both the Logger (to
// suppress file I/O) and dotenv, then provide a hand-rolled PnLTracker stub
// whose behaviour we can control per-test.

jest.mock('../../src/logger', () => ({
  Logger: jest.fn().mockImplementation(() => ({
    debug: jest.fn(),
    info:  jest.fn(),
    warn:  jest.fn(),
    error: jest.fn(),
  })),
}));

jest.mock('dotenv', () => ({ config: jest.fn() }));

// Inject required env vars before config.ts is evaluated
process.env.WALLET_PRIVATE_KEY = 'test-key';
process.env.HELIUS_RPC_URL     = 'https://rpc.test';

import { RiskGuard }    from '../../src/safety/riskGuard';
import { CONFIG }       from '../../src/config';
import type { PnLState, ArbOpportunity } from '../../src/types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** A minimal ArbOpportunity used as the argument to guard.check(). */
function makeOpp(token = 'So11111111111111111111111111111111111111112'): ArbOpportunity {
  return {
    token,
    tokenSymbol:  'SOL',
    buyDex:       'Jupiter',
    sellDex:      'Orca',
    buyPrice:     100,
    sellPrice:    101,
    spreadPct:    1.0,
    netProfitUsd: 2.0,
    tradeSizeUsd: 50,
    buyRawQuote:  null,
    sellRawQuote: null,
  };
}

/** Returns a default PnLState where everything is within safe limits. */
function safeState(overrides: Partial<PnLState> = {}): PnLState {
  return {
    totalTrades:         0,
    wins:                0,
    losses:              0,
    grossProfit:         0,
    totalFees:           0,
    netProfit:           0,
    dailyLoss:           0,
    blacklistedTokens:   [],
    consecutiveFailures: {},
    tradeWindow:         [],
    lastDailyReset:      new Date().toISOString().slice(0, 10),
    ...overrides,
  };
}

/** Build a mock PnLTracker whose behaviour is dictated by the supplied args. */
function makeMockPnl({
  state       = safeState(),
  blacklisted = false,
  winRate     = 60,
}: {
  state?:       PnLState;
  blacklisted?: boolean;
  winRate?:     number;
} = {}) {
  return {
    getState:        jest.fn(() => ({ ...state })),
    isBlacklisted:   jest.fn((_mint: string) => blacklisted),
    getWinRate:      jest.fn(() => winRate),
    checkDailyReset: jest.fn(),
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('RiskGuard.check()', () => {

  // ── Allowed path ────────────────────────────────────────────────────────────

  it('allows a trade when all safety checks pass', () => {
    const pnl   = makeMockPnl();
    const guard = new RiskGuard(pnl as any);

    const result = guard.check(makeOpp());

    expect(result.allowed).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('calls checkDailyReset before every check', () => {
    const pnl   = makeMockPnl();
    const guard = new RiskGuard(pnl as any);

    guard.check(makeOpp());

    expect(pnl.checkDailyReset).toHaveBeenCalledTimes(1);
  });

  // ── Daily loss ceiling ───────────────────────────────────────────────────

  it('blocks when dailyLoss equals MAX_DAILY_LOSS_USD', () => {
    const pnl   = makeMockPnl({ state: safeState({ dailyLoss: CONFIG.MAX_DAILY_LOSS_USD }) });
    const guard = new RiskGuard(pnl as any);

    const result = guard.check(makeOpp());

    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/daily loss/i);
  });

  it('blocks when dailyLoss exceeds MAX_DAILY_LOSS_USD', () => {
    const pnl   = makeMockPnl({ state: safeState({ dailyLoss: CONFIG.MAX_DAILY_LOSS_USD + 1 }) });
    const guard = new RiskGuard(pnl as any);

    const result = guard.check(makeOpp());

    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/daily loss/i);
  });

  it('allows when dailyLoss is just below MAX_DAILY_LOSS_USD', () => {
    const pnl   = makeMockPnl({ state: safeState({ dailyLoss: CONFIG.MAX_DAILY_LOSS_USD - 0.01 }) });
    const guard = new RiskGuard(pnl as any);

    const result = guard.check(makeOpp());

    expect(result.allowed).toBe(true);
  });

  // ── Blacklisted token ────────────────────────────────────────────────────

  it('blocks when the opportunity token is blacklisted', () => {
    const token = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'; // BONK
    const pnl   = makeMockPnl({ blacklisted: true });
    const guard = new RiskGuard(pnl as any);

    const result = guard.check(makeOpp(token));

    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/blacklisted/i);
  });

  it('calls isBlacklisted with the opportunity token', () => {
    const token = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
    const pnl   = makeMockPnl({ blacklisted: false });
    const guard = new RiskGuard(pnl as any);

    guard.check(makeOpp(token));

    expect(pnl.isBlacklisted).toHaveBeenCalledWith(token);
  });

  // ── Pause window (low win-rate cooldown) ──────────────────────────────────

  it('blocks during an active pause window', () => {
    // Trigger a pause first by providing a full window with a very low win rate
    const lowWinState = safeState({
      tradeWindow: new Array(CONFIG.WIN_RATE_WINDOW).fill(false), // 0 % wins
    });
    const pnl = makeMockPnl({ state: lowWinState, winRate: 0 });

    const guard = new RiskGuard(pnl as any);

    // First call triggers the pause
    guard.check(makeOpp());

    // Second call should be blocked by the active pause
    const result = guard.check(makeOpp());

    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/paused/i);
  });

  // ── Win-rate check ────────────────────────────────────────────────────────

  it('blocks and sets a pause when win rate drops below WIN_RATE_PAUSE_PCT', () => {
    const lowWinState = safeState({
      tradeWindow: new Array(CONFIG.WIN_RATE_WINDOW).fill(false),
    });
    const pnl   = makeMockPnl({ state: lowWinState, winRate: CONFIG.WIN_RATE_PAUSE_PCT - 1 });
    const guard = new RiskGuard(pnl as any);

    const result = guard.check(makeOpp());

    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/win rate/i);
  });

  it('allows when win rate is at or above WIN_RATE_PAUSE_PCT with a full window', () => {
    const wins        = CONFIG.WIN_RATE_PAUSE_PCT; // exactly at threshold
    const tradeWindow = [
      ...new Array(wins).fill(true),
      ...new Array(CONFIG.WIN_RATE_WINDOW - wins).fill(false),
    ];
    const state = safeState({ tradeWindow });
    const pnl   = makeMockPnl({ state, winRate: wins });
    const guard = new RiskGuard(pnl as any);

    const result = guard.check(makeOpp());

    expect(result.allowed).toBe(true);
  });

  it('skips win-rate check when tradeWindow is smaller than WIN_RATE_WINDOW', () => {
    // Even with a poor recorded winRate, an incomplete window must not block
    const state = safeState({
      tradeWindow: new Array(CONFIG.WIN_RATE_WINDOW - 1).fill(false),
    });
    const pnl   = makeMockPnl({ state, winRate: 0 });
    const guard = new RiskGuard(pnl as any);

    const result = guard.check(makeOpp());

    expect(result.allowed).toBe(true);
    // getWinRate should NOT have been called (window not full)
    expect(pnl.getWinRate).not.toHaveBeenCalled();
  });

  // ── Pause escalation to permanent halt ────────────────────────────────────

  it('sets an indefinite pause after exceeding WIN_RATE_MAX_PAUSES', () => {
    const lowWinState = safeState({
      tradeWindow: new Array(CONFIG.WIN_RATE_WINDOW).fill(false),
    });
    const pnl   = makeMockPnl({ state: lowWinState, winRate: 0 });
    const guard = new RiskGuard(pnl as any);

    // Trigger enough pauses to exceed the limit
    const callsNeeded = CONFIG.WIN_RATE_MAX_PAUSES + 2;
    const results: ReturnType<typeof guard.check>[] = [];

    for (let i = 0; i < callsNeeded; i++) {
      // Re-instantiate state each time so pause window is not blocking
      // (we need to reach the win-rate check on every call)
      const freshGuard = new RiskGuard(pnl as any);
      // Exhaust the allowed pauses on this instance
      for (let p = 0; p <= CONFIG.WIN_RATE_MAX_PAUSES; p++) {
        freshGuard.check(makeOpp());
      }
      results.push(freshGuard.check(makeOpp()));
    }

    // After the pause limit is exceeded the guard should continue blocking
    expect(results.every(r => r.allowed === false)).toBe(true);
  });

  // ── onSuccess / onDailyReset helpers ─────────────────────────────────────

  it('onSuccess does not throw', () => {
    const pnl   = makeMockPnl();
    const guard = new RiskGuard(pnl as any);

    expect(() => guard.onSuccess()).not.toThrow();
  });

  it('onDailyReset does not throw', () => {
    const pnl   = makeMockPnl();
    const guard = new RiskGuard(pnl as any);

    expect(() => guard.onDailyReset()).not.toThrow();
  });

  it('allows trades again after onDailyReset clears the pause', () => {
    // Trigger a pause
    const lowWinState = safeState({
      tradeWindow: new Array(CONFIG.WIN_RATE_WINDOW).fill(false),
    });
    const pnl   = makeMockPnl({ state: lowWinState, winRate: 0 });
    const guard = new RiskGuard(pnl as any);
    guard.check(makeOpp()); // triggers pause

    // Reset
    guard.onDailyReset();

    // Now provide a healthy win-rate so the win-rate check passes
    pnl.getWinRate.mockReturnValue(80);
    // Shrink tradeWindow so the win-rate check is skipped
    (pnl.getState as jest.Mock).mockReturnValue(safeState());

    const result = guard.check(makeOpp());
    expect(result.allowed).toBe(true);
  });
});
