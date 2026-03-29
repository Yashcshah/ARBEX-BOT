import { ArbOpportunity } from '../types';
import { CONFIG } from '../config';
import { Logger } from '../logger';
import { PnLTracker } from '../tracker/pnl';

const log = new Logger('RiskGuard');

// ─── GuardResult ─────────────────────────────────────────────────────────────

export type GuardResult = { allowed: boolean; reason?: string };

// ─── RiskGuard ───────────────────────────────────────────────────────────────

export class RiskGuard {
  /** Timestamp (ms) until which new trades are blocked due to a low win-rate. */
  private pauseUntil = 0;

  /** Number of win-rate pauses triggered today. */
  private pauseCount = 0;

  constructor(private pnl: PnLTracker) {}

  /**
   * Run all safety checks before a bundle is submitted.
   * Returns { allowed: false, reason } on the first failing rule.
   */
  check(opp: ArbOpportunity): GuardResult {
    // Ensure dailyLoss resets at midnight UTC before every check
    this.pnl.checkDailyReset();

    const state = this.pnl.getState();

    // ── 1. Daily loss ceiling ─────────────────────────────────────────────
    if (state.dailyLoss >= CONFIG.MAX_DAILY_LOSS_USD) {
      log.warn(
        `Daily loss limit reached: $${state.dailyLoss.toFixed(2)} >= ` +
        `$${CONFIG.MAX_DAILY_LOSS_USD.toFixed(2)}`,
      );
      return { allowed: false, reason: 'Daily loss limit hit' };
    }

    // ── 2. Blacklisted token ──────────────────────────────────────────────
    if (this.pnl.isBlacklisted(opp.token)) {
      return { allowed: false, reason: `Token ${opp.tokenSymbol} is blacklisted` };
    }

    // ── 3. Active pause (low win-rate cooldown) ───────────────────────────
    if (Date.now() < this.pauseUntil) {
      const remainingSec = Math.ceil((this.pauseUntil - Date.now()) / 1000);
      log.warn(`Bot paused due to low win rate — ${remainingSec}s remaining`);
      return { allowed: false, reason: 'Bot paused (low win rate)' };
    }

    // ── 4. Rolling win-rate check ─────────────────────────────────────────
    if (state.tradeWindow.length >= CONFIG.WIN_RATE_WINDOW) {
      const winRate = this.pnl.getWinRate();

      if (winRate < CONFIG.WIN_RATE_PAUSE_PCT) {
        this.pauseCount++;
        log.warn(
          `Win rate ${winRate.toFixed(1)}% below pause threshold ` +
          `${CONFIG.WIN_RATE_PAUSE_PCT}% (pause #${this.pauseCount})`,
        );

        if (this.pauseCount > CONFIG.WIN_RATE_MAX_PAUSES) {
          // Force a full daily halt by setting dailyLoss to the ceiling
          log.error(
            `Win-rate pause limit exceeded (${this.pauseCount} pauses). ` +
            'Forcing daily halt.',
          );
          // Mutate the tracked state by recording a synthetic loss that
          // pushes dailyLoss to the limit; the simplest safe approach is
          // to directly expose it via the guard flag checked above.
          // We achieve this by setting a pause that expires never today:
          this.pauseUntil = Number.MAX_SAFE_INTEGER;
        } else {
          this.pauseUntil = Date.now() + CONFIG.WIN_RATE_PAUSE_MINUTES * 60_000;
        }

        return {
          allowed: false,
          reason: `Win rate ${winRate.toFixed(1)}% below threshold`,
        };
      } else {
        // Win rate healthy — reset pause streak
        this.pauseCount = 0;
      }
    }

    return { allowed: true };
  }

  /** Call after a successful trade to reset the consecutive-pause logic. */
  onSuccess(): void {
    this.pauseCount = 0;
  }

  /** Call when a daily reset occurs so pause streak starts fresh each day. */
  onDailyReset(): void {
    this.pauseCount  = 0;
    this.pauseUntil  = 0;
    log.info('RiskGuard daily reset — pause counters cleared');
  }
}
