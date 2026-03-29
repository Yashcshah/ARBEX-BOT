import { CONFIG } from '../config';
import { Logger } from '../logger';
import { PnLTracker } from '../tracker/pnl';
import { JitoExecutor } from '../executor/jito';

const log = new Logger('AutoTuner');

// ─── AutoTuner ────────────────────────────────────────────────────────────────
//
// Adjusts the Jito tip every AUTO_TUNE_WINDOW trades based on observed win
// rate.  A poor win rate signals that the bot is losing bundle auctions, so
// the tip is raised.  A high win rate means the current tip is competitive
// and can be trimmed to improve net margins.

export class AutoTuner {
  private tradesSinceLastTune = 0;

  constructor(
    private pnl:      PnLTracker,
    private executor: JitoExecutor,
  ) {}

  /**
   * Must be called after every trade (win or loss).
   * Triggers a tuning pass every AUTO_TUNE_WINDOW trades.
   */
  onTrade(): void {
    this.tradesSinceLastTune++;

    if (this.tradesSinceLastTune >= CONFIG.AUTO_TUNE_WINDOW) {
      this.runTune();
    }
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private runTune(): void {
    this.tradesSinceLastTune = 0;

    if (!CONFIG.AUTO_TUNE_ENABLED) return;

    const winRate    = this.pnl.getWinRate();
    const currentTip = this.executor.getTipLamports();

    // ── Check 1: win rate too low → raise tip (§14.7) ────────────────────────
    if (winRate < CONFIG.WIN_RATE_LOW_PCT) {
      const newTip = Math.min(
        currentTip + CONFIG.TIP_INCREASE_LAMPORTS,
        CONFIG.TIP_MAX_LAMPORTS,
      );

      if (newTip !== currentTip) {
        this.executor.setTipLamports(newTip);
        log.info(
          `Raised tip ${currentTip.toLocaleString()} -> ` +
          `${newTip.toLocaleString()} lamports ` +
          `(win rate ${winRate.toFixed(1)}% < ${CONFIG.WIN_RATE_LOW_PCT}%)`,
        );
      } else {
        log.warn(
          `Win rate low (${winRate.toFixed(1)}%) but tip already at max ` +
          `${CONFIG.TIP_MAX_LAMPORTS.toLocaleString()} lamports`,
        );
      }
      return; // don't double-adjust in the same tune pass
    }

    // ── Check 2: tip > TIP_MAX_PCT_OF_PROFIT × avg gross profit → lower tip (§14.7) ──
    const avgGross = this.pnl.getAvgGrossProfit(CONFIG.AUTO_TUNE_PROFIT_WINDOW);
    if (avgGross > 0) {
      const tipUsd          = (currentTip / 1e9) * 150; // rough SOL→USD at $150
      const maxAllowedTipUsd = avgGross * CONFIG.TIP_MAX_PCT_OF_PROFIT;

      if (tipUsd > maxAllowedTipUsd && currentTip > CONFIG.TIP_MIN_LAMPORTS) {
        const newTip = Math.max(
          currentTip - CONFIG.TIP_DECREASE_LAMPORTS,
          CONFIG.TIP_MIN_LAMPORTS,
        );
        this.executor.setTipLamports(newTip);
        log.info(
          `Lowered tip ${currentTip.toLocaleString()} -> ${newTip.toLocaleString()} lamports ` +
          `(tip $${tipUsd.toFixed(4)} > ${(CONFIG.TIP_MAX_PCT_OF_PROFIT * 100).toFixed(0)}% ` +
          `of avg gross $${avgGross.toFixed(4)})`,
        );
        return;
      }
    }

    // ── Check 3: win rate healthy → trim tip back toward minimum (§14.7) ─────
    if (winRate > 60 && currentTip > CONFIG.TIP_MIN_LAMPORTS) {
      const newTip = Math.max(
        currentTip - CONFIG.TIP_DECREASE_LAMPORTS,
        CONFIG.TIP_MIN_LAMPORTS,
      );

      if (newTip !== currentTip) {
        this.executor.setTipLamports(newTip);
        log.info(
          `Lowered tip ${currentTip.toLocaleString()} -> ` +
          `${newTip.toLocaleString()} lamports ` +
          `(win rate ${winRate.toFixed(1)}% > 60%)`,
        );
      }
    } else {
      log.debug(
        `AutoTune: no adjustment needed ` +
        `(win rate ${winRate.toFixed(1)}%, tip ${currentTip.toLocaleString()} lamports)`,
      );
    }
  }
}
