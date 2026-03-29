import { PriceMap, PriceEntry } from '../types';
import { CONFIG, TokenConfig } from '../config';
import { Logger } from '../logger';
import axios from 'axios';

// ─── Extended entry that also carries the raw Jupiter/Orca quote payload ──────

export interface ExtendedPriceEntry extends PriceEntry {
  rawQuote: unknown;
}

// Internal cache: mint → dex → ExtendedPriceEntry
type ExtendedPriceMap = Map<string, Map<string, ExtendedPriceEntry>>;

const log = new Logger('PriceMonitor');

// ─── PriceMonitor ─────────────────────────────────────────────────────────────

export class PriceMonitor {
  private cache: PriceMap = {};
  private extCache: ExtendedPriceMap = new Map();
  private running = false;

  constructor(private tokens: TokenConfig[]) {}

  // ── Public API ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.running = true;
    log.info('Starting price monitor — initial fetch …');
    await this.refreshAll();
    log.info('Initial fetch complete; entering background refresh loop.');
    void this.backgroundRefresh();
  }

  stop(): void {
    this.running = false;
    log.info('Price monitor stopped.');
  }

  /**
   * Atomically replace the watched token list (§14.8).
   * Called by TokenScanner after each successful scan.
   * In-flight refreshes using the old list complete normally.
   */
  updateTokens(newTokens: TokenConfig[]): void {
    const prev = this.tokens.length;
    this.tokens = newTokens;
    log.info(
      `Token list updated: ${prev} → ${newTokens.length} tokens ` +
      `(${newTokens.map(t => t.symbol).join(', ')})`
    );
  }

  /** Returns the current token list (used by ArbScanner). */
  getTokens(): TokenConfig[] {
    return this.tokens;
  }

  /** Returns a snapshot of the plain PriceMap (no rawQuote). */
  getMap(): PriceMap {
    return this.cache;
  }

  /** Returns the plain PriceEntry for a (mint, dex) pair, or null. */
  getPriceEntry(mint: string, dex: string): PriceEntry | null {
    return this.cache[mint]?.[dex] ?? null;
  }

  /**
   * Returns all non-stale entries for a mint across every DEX.
   * Staleness threshold: CONFIG.PRICE_STALENESS_MS.
   */
  getAllEntries(mint: string): Array<{ dex: string; entry: PriceEntry }> {
    const now = Date.now();
    const dexMap = this.cache[mint];
    if (!dexMap) return [];

    return Object.entries(dexMap)
      .filter(([, entry]) => now - entry.timestamp <= CONFIG.PRICE_STALENESS_MS)
      .map(([dex, entry]) => ({ dex, entry }));
  }

  /** Returns the ExtendedPriceEntry (with rawQuote) for a (mint, dex) pair. */
  getExtendedEntry(mint: string, dex: string): ExtendedPriceEntry | null {
    return this.extCache.get(mint)?.get(dex) ?? null;
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private async backgroundRefresh(): Promise<void> {
    while (this.running) {
      await this.sleep(CONFIG.POLL_INTERVAL_MS);
      if (!this.running) break;
      await this.refreshAll();
    }
  }

  private async refreshAll(): Promise<void> {
    const nonUsdc = this.tokens.filter(t => t.mint !== CONFIG.USDC_MINT);
    await Promise.allSettled(nonUsdc.map(t => this.refreshToken(t)));
  }

  private async refreshToken(token: TokenConfig): Promise<void> {
    // All four DEXes polled in parallel — spec §4
    const [jupResult, orcaResult, raydiumResult, meteoraResult] = await Promise.allSettled([
      this.fetchJupiterQuote(token),
      this.fetchOrcaQuote(token),
      this.fetchRaydiumQuote(token),
      this.fetchMeteoraQuote(token),
    ]);

    const results: Array<{ dex: string; entry: ExtendedPriceEntry } | null> = [
      jupResult.status      === 'fulfilled' ? jupResult.value      : null,
      orcaResult.status     === 'fulfilled' ? orcaResult.value     : null,
      raydiumResult.status  === 'fulfilled' ? raydiumResult.value  : null,
      meteoraResult.status  === 'fulfilled' ? meteoraResult.value  : null,
    ];

    for (const result of results) {
      if (!result) continue;
      const { dex, entry } = result;

      // Update plain PriceMap
      if (!this.cache[token.mint]) this.cache[token.mint] = {};
      this.cache[token.mint][dex] = {
        price:     entry.price,
        liquidity: entry.liquidity,
        timestamp: entry.timestamp,
      };

      // Update extended cache
      if (!this.extCache.has(token.mint)) this.extCache.set(token.mint, new Map());
      this.extCache.get(token.mint)!.set(dex, entry);

      log.debug(
        `[${token.symbol}] ${dex} price=$${entry.price.toFixed(6)} ` +
        `ts=${entry.timestamp}`
      );
    }
  }

  private async fetchJupiterQuote(
    token: TokenConfig
  ): Promise<{ dex: string; entry: ExtendedPriceEntry } | null> {
    try {
      // Use a fixed small-trade amount: 10 * 10^decimals (e.g. 10 tokens)
      const amount = Math.floor(10 * Math.pow(10, token.decimals));

      const { data } = await axios.get('https://quote-api.jup.ag/v6/quote', {
        timeout: 3000,
        params: {
          inputMint:    token.mint,
          outputMint:   CONFIG.USDC_MINT,
          amount,
          slippageBps:  CONFIG.MAX_SLIPPAGE_BPS,
        },
      });

      const outAmount = Number(data.outAmount);
      if (!outAmount) return null;

      // outAmount is in USDC micro-units (1e6); amount is in token's micro-units
      const price = (outAmount / 1e6) / (amount / Math.pow(10, token.decimals));

      const entry: ExtendedPriceEntry = {
        price,
        liquidity: 0,   // Jupiter quote API doesn't expose TVL
        timestamp: Date.now(),
        rawQuote:  data,
      };

      return { dex: 'Jupiter', entry };
    } catch (err) {
      log.debug(
        `fetchJupiterQuote(${token.symbol}) failed: ` +
        (err instanceof Error ? err.message : String(err))
      );
      return null;
    }
  }

  private async fetchOrcaQuote(
    token: TokenConfig
  ): Promise<{ dex: string; entry: ExtendedPriceEntry } | null> {
    try {
      const amount = Math.floor(10 * Math.pow(10, token.decimals));

      const { data } = await axios.get('https://quote-api.jup.ag/v6/quote', {
        timeout: 3000,
        params: {
          inputMint:    token.mint,
          outputMint:   CONFIG.USDC_MINT,
          amount,
          slippageBps:  CONFIG.MAX_SLIPPAGE_BPS,
          dexes:        'Whirlpool',  // Restrict to Orca Whirlpool only
        },
      });

      // If Orca has no pool for this token the API still returns 200 but
      // outAmount is absent or zero.
      const outAmount = Number(data.outAmount);
      if (!outAmount) return null;

      const price = (outAmount / 1e6) / (amount / Math.pow(10, token.decimals));

      const entry: ExtendedPriceEntry = {
        price,
        liquidity: 0,
        timestamp: Date.now(),
        rawQuote:  data,
      };

      return { dex: 'Orca', entry };
    } catch (err) {
      log.debug(
        `fetchOrcaQuote(${token.symbol}) failed: ` +
        (err instanceof Error ? err.message : String(err))
      );
      return null;
    }
  }

  private async fetchRaydiumQuote(
    token: TokenConfig
  ): Promise<{ dex: string; entry: ExtendedPriceEntry } | null> {
    try {
      const amount = Math.floor(10 * Math.pow(10, token.decimals));

      const { data } = await axios.get('https://quote-api.jup.ag/v6/quote', {
        timeout: 3000,
        params: {
          inputMint:   token.mint,
          outputMint:  CONFIG.USDC_MINT,
          amount,
          slippageBps: CONFIG.MAX_SLIPPAGE_BPS,
          dexes:       'Raydium CLMM',  // Restrict to Raydium Concentrated Liquidity
        },
      });

      const outAmount = Number(data.outAmount);
      if (!outAmount) return null;

      const price = (outAmount / 1e6) / (amount / Math.pow(10, token.decimals));

      return {
        dex: 'Raydium',
        entry: { price, liquidity: 0, timestamp: Date.now(), rawQuote: data },
      };
    } catch (err) {
      log.debug(
        `fetchRaydiumQuote(${token.symbol}) failed: ` +
        (err instanceof Error ? err.message : String(err))
      );
      return null;
    }
  }

  private async fetchMeteoraQuote(
    token: TokenConfig
  ): Promise<{ dex: string; entry: ExtendedPriceEntry } | null> {
    try {
      const amount = Math.floor(10 * Math.pow(10, token.decimals));

      const { data } = await axios.get('https://quote-api.jup.ag/v6/quote', {
        timeout: 3000,
        params: {
          inputMint:   token.mint,
          outputMint:  CONFIG.USDC_MINT,
          amount,
          slippageBps: CONFIG.MAX_SLIPPAGE_BPS,
          dexes:       'Meteora DLMM',  // Restrict to Meteora Dynamic AMM
        },
      });

      const outAmount = Number(data.outAmount);
      if (!outAmount) return null;

      const price = (outAmount / 1e6) / (amount / Math.pow(10, token.decimals));

      return {
        dex: 'Meteora',
        entry: { price, liquidity: 0, timestamp: Date.now(), rawQuote: data },
      };
    } catch (err) {
      log.debug(
        `fetchMeteoraQuote(${token.symbol}) failed: ` +
        (err instanceof Error ? err.message : String(err))
      );
      return null;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ─── Module-level convenience export ─────────────────────────────────────────

/**
 * Convenience wrapper so callers don't need to hold a monitor reference.
 * The singleton is set by whoever constructs PriceMonitor (e.g. index.ts).
 */
let _instance: PriceMonitor | null = null;

export function setPriceMonitorInstance(m: PriceMonitor): void {
  _instance = m;
}

export function getExtendedEntry(
  mint: string,
  dex: string
): ExtendedPriceEntry | null {
  return _instance?.getExtendedEntry(mint, dex) ?? null;
}
