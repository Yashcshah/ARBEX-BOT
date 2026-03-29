import * as fs   from 'fs';
import * as path from 'path';

import { PnLState, TradeRecord, BundleResult } from '../types';
import { CONFIG } from '../config';
import { Logger } from '../logger';

const log = new Logger('PnLTracker');

// ─── Blacklist entry (persisted in blacklist.json) ────────────────────────────

interface BlacklistEntry {
  mint:    string;
  addedAt: number; // Unix ms
}

// ─── PnLTracker ───────────────────────────────────────────────────────────────

export class PnLTracker {
  private state: PnLState = {
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
    lastDailyReset:      '',
  };

  // Rolling gross-profit buffer used by autoTune (§14.7)
  private grossProfitWindow: number[] = [];

  private tradesPath:    string;
  private blacklistPath: string;
  private statePath:     string;

  constructor() {
    // Ensure data directory exists
    if (!fs.existsSync(CONFIG.DATA_DIR)) {
      fs.mkdirSync(CONFIG.DATA_DIR, { recursive: true });
    }

    this.tradesPath    = path.join(CONFIG.DATA_DIR, 'trades.json');
    this.blacklistPath = path.join(CONFIG.DATA_DIR, 'blacklist.json');
    this.statePath     = path.join(CONFIG.DATA_DIR, 'state.json');

    this.rehydrate();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Returns a shallow copy of the current P&L state. */
  getState(): PnLState {
    return {
      ...this.state,
      blacklistedTokens:   [...this.state.blacklistedTokens],
      tradeWindow:         [...this.state.tradeWindow],
      consecutiveFailures: { ...this.state.consecutiveFailures },
    };
  }

  /** Record a BundleResult and the opportunity context, persisting to NDJSON. */
  recordResult(
    result: BundleResult,
    opp: { spreadPct: number; tradeSizeUsd: number; buyDex: string; sellDex: string },
  ): void {
    const record: TradeRecord = {
      timestamp:    result.timestamp,
      token:        result.token,
      tokenSymbol:  result.tokenSymbol,
      buyDex:       opp.buyDex,
      sellDex:      opp.sellDex,
      grossProfit:  result.profit + result.fees,
      fees:         result.fees,
      netProfit:    result.profit,
      landed:       result.landed,
      txSignature:  result.txSignature,
      tradeSizeUsd: opp.tradeSizeUsd,
      spreadPct:    opp.spreadPct,
    };

    // ── Persist to NDJSON ──────────────────────────────────────────────────
    try {
      fs.appendFileSync(this.tradesPath, JSON.stringify(record) + '\n', 'utf8');
    } catch (err: unknown) {
      log.error(`Failed to append trade record: ${(err as Error).message}`);
    }

    // ── Update in-memory state ─────────────────────────────────────────────
    this.state.totalTrades++;

    if (result.landed) {
      this.state.wins++;
    } else {
      this.state.losses++;
    }

    // grossProfit accumulates pre-fee revenue
    this.state.grossProfit += result.profit + result.fees;
    this.state.totalFees   += result.fees;
    this.state.netProfit   += result.profit;

    // Daily loss accounting
    if (!result.landed) {
      // Tip/fees burned even when bundle did not land
      this.state.dailyLoss += result.fees;
    } else if (result.profit < 0) {
      // Landed but at a net loss
      this.state.dailyLoss += Math.abs(result.profit);
    }

    // Trade window for win-rate calculation (keep last WIN_RATE_WINDOW entries)
    this.state.tradeWindow.push(result.landed);
    if (this.state.tradeWindow.length > CONFIG.WIN_RATE_WINDOW) {
      this.state.tradeWindow.shift();
    }

    // Gross-profit rolling window for autoTune TIP_MAX_PCT_OF_PROFIT check (§14.7)
    const grossProfit = result.profit + result.fees;
    this.grossProfitWindow.push(grossProfit);
    if (this.grossProfitWindow.length > CONFIG.AUTO_TUNE_PROFIT_WINDOW) {
      this.grossProfitWindow.shift();
    }

    // Consecutive-failure tracking → auto-blacklist
    const mint = result.token;
    if (result.landed) {
      this.state.consecutiveFailures[mint] = 0;
    } else {
      this.state.consecutiveFailures[mint] =
        (this.state.consecutiveFailures[mint] ?? 0) + 1;

      if (this.state.consecutiveFailures[mint] >= CONFIG.BLACKLIST_THRESHOLD) {
        this.addToBlacklist(mint);
        log.warn(
          `Auto-blacklisted ${result.tokenSymbol} (${mint}) after ` +
          `${this.state.consecutiveFailures[mint]} consecutive failures`,
        );
      }
    }
  }

  // ── Blacklist management ───────────────────────────────────────────────────

  isBlacklisted(mint: string): boolean {
    return this.state.blacklistedTokens.includes(mint);
  }

  addToBlacklist(mint: string): void {
    if (this.state.blacklistedTokens.includes(mint)) return;

    this.state.blacklistedTokens.push(mint);

    // Read existing entries so we preserve timestamps
    const entries = this.readBlacklistFile();
    if (!entries.find(e => e.mint === mint)) {
      entries.push({ mint, addedAt: Date.now() });
    }

    this.atomicWrite(this.blacklistPath, entries);
    log.info(`Added ${mint} to blacklist (total: ${this.state.blacklistedTokens.length})`);
  }

  removeFromBlacklist(mint: string): void {
    this.state.blacklistedTokens = this.state.blacklistedTokens.filter(m => m !== mint);

    const entries = this.readBlacklistFile().filter(e => e.mint !== mint);
    this.atomicWrite(this.blacklistPath, entries);
    log.info(`Removed ${mint} from blacklist`);
  }

  /**
   * Remove blacklist entries older than 24 hours, then persist.
   * Called periodically to avoid permanent bans from transient failures.
   */
  checkAndExpireBlacklist(): void {
    const cutoff  = Date.now() - 24 * 60 * 60 * 1000;
    const entries = this.readBlacklistFile();
    const fresh   = entries.filter(e => e.addedAt >= cutoff);
    const expired = entries.filter(e => e.addedAt <  cutoff);

    if (expired.length === 0) return;

    log.info(`Expiring ${expired.length} blacklist entries older than 24 h`);

    const expiredMints = new Set(expired.map(e => e.mint));
    this.state.blacklistedTokens = this.state.blacklistedTokens.filter(
      m => !expiredMints.has(m),
    );

    this.atomicWrite(this.blacklistPath, fresh);
  }

  // ── Win-rate ───────────────────────────────────────────────────────────────

  /** Returns 0-100 (%) based on the rolling trade window. */
  getWinRate(): number {
    const w = this.state.tradeWindow;
    if (w.length === 0) return 0;
    const wins = w.filter(Boolean).length;
    return (wins / w.length) * 100;
  }

  /**
   * Returns the average gross profit over the last n trades, or 0 if no data.
   * Used by autoTune to enforce TIP_MAX_PCT_OF_PROFIT (§14.7).
   */
  getAvgGrossProfit(n: number): number {
    if (this.grossProfitWindow.length === 0) return 0;
    const slice = this.grossProfitWindow.slice(-n);
    return slice.reduce((sum, v) => sum + v, 0) / slice.length;
  }

  // ── Daily-reset ───────────────────────────────────────────────────────────

  /**
   * Called before every guard check. Resets dailyLoss if the UTC date has
   * rolled over since the last reset, then recalculates it from today's trades.
   */
  checkDailyReset(): void {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    if (today === this.state.lastDailyReset) return;

    log.info(`Daily reset: ${this.state.lastDailyReset} -> ${today}`);
    this.state.lastDailyReset = today;
    this.state.dailyLoss      = 0;

    // Recalculate dailyLoss from today's on-disk records
    this.state.dailyLoss = this.calcDailyLossFromFile(today);
  }

  // ── Shutdown hook ─────────────────────────────────────────────────────────

  /** No-op: all writes are immediate. Call on graceful shutdown for symmetry. */
  flush(): void {
    log.debug('PnLTracker.flush() called (no-op)');
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Reads trades.json (NDJSON) line-by-line and rebuilds the entire in-memory
   * state. Called once at startup.
   */
  private rehydrate(): void {
    log.info('Rehydrating P&L state from disk...');

    if (!fs.existsSync(this.tradesPath)) {
      log.info('No trades file found - starting fresh');
      this.checkDailyReset();
      this.loadBlacklist();
      return;
    }

    let raw: string;
    try {
      raw = fs.readFileSync(this.tradesPath, 'utf8');
    } catch (err: unknown) {
      log.error(`Cannot read trades file: ${(err as Error).message}`);
      this.checkDailyReset();
      this.loadBlacklist();
      return;
    }

    const lines   = raw.split('\n');
    const records: TradeRecord[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const rec = JSON.parse(trimmed) as TradeRecord;
        records.push(rec);
      } catch {
        log.warn(`Skipping malformed trade line: ${trimmed.slice(0, 80)}`);
      }
    }

    // Rebuild aggregate state
    for (const rec of records) {
      this.state.totalTrades++;

      if (rec.landed) {
        this.state.wins++;
      } else {
        this.state.losses++;
      }

      this.state.grossProfit += rec.grossProfit;
      this.state.totalFees   += rec.fees;
      this.state.netProfit   += rec.netProfit;

      // Consecutive-failure counters
      if (rec.landed) {
        this.state.consecutiveFailures[rec.token] = 0;
      } else {
        this.state.consecutiveFailures[rec.token] =
          (this.state.consecutiveFailures[rec.token] ?? 0) + 1;
      }
    }

    // Trade window: keep only the last WIN_RATE_WINDOW results
    const windowSlice = records.slice(-CONFIG.WIN_RATE_WINDOW);
    this.state.tradeWindow = windowSlice.map(r => r.landed);

    log.info(
      `Rehydrated ${records.length} trades - ` +
      `wins: ${this.state.wins}, losses: ${this.state.losses}`,
    );

    // Daily loss is computed fresh after daily-reset logic
    this.checkDailyReset();
    this.loadBlacklist();
  }

  /**
   * Scans the trades file for today's records and computes the daily loss
   * from scratch (used after a day-rollover).
   */
  private calcDailyLossFromFile(today: string): number {
    if (!fs.existsSync(this.tradesPath)) return 0;

    let raw: string;
    try {
      raw = fs.readFileSync(this.tradesPath, 'utf8');
    } catch {
      return 0;
    }

    let loss = 0;
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const rec     = JSON.parse(trimmed) as TradeRecord;
        const recDate = new Date(rec.timestamp).toISOString().slice(0, 10);
        if (recDate !== today) continue;

        if (!rec.landed) {
          loss += rec.fees;
        } else if (rec.netProfit < 0) {
          loss += Math.abs(rec.netProfit);
        }
      } catch {
        // skip
      }
    }

    return loss;
  }

  /** Load blacklisted mints from disk into state. */
  private loadBlacklist(): void {
    const entries = this.readBlacklistFile();
    this.state.blacklistedTokens = entries.map(e => e.mint);

    if (entries.length > 0) {
      log.info(`Loaded ${entries.length} blacklisted tokens from disk`);
    }
  }

  /** Parse blacklist.json, returning an empty array on any error. */
  private readBlacklistFile(): BlacklistEntry[] {
    if (!fs.existsSync(this.blacklistPath)) return [];
    try {
      const raw    = fs.readFileSync(this.blacklistPath, 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as BlacklistEntry[]) : [];
    } catch {
      return [];
    }
  }

  /**
   * Atomic write: serialise data to filePath + '.tmp', then rename to filePath.
   * On most OSes the rename is atomic so readers never see a half-written file.
   */
  private atomicWrite(filePath: string, data: unknown): void {
    const tmp = filePath + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmp, filePath);
    } catch (err: unknown) {
      log.error(`atomicWrite failed for ${filePath}: ${(err as Error).message}`);
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  }
}
