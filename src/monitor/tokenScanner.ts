import { CONFIG, TokenConfig } from '../config';
import { Logger } from '../logger';
import { PriceMonitor } from './priceMonitor';
import axios from 'axios';

// ─── Stablecoins to always exclude from the watched list ─────────────────────

const STABLECOIN_SYMBOLS = new Set(['USDC', 'USDT', 'BUSD', 'DAI']);

// ─── Shape of a Birdeye token-list item ───────────────────────────────────────

interface BirdeyeToken {
  symbol:   string;
  address:  string;
  decimals: number;
  v24hUSD?: number;
  [key: string]: unknown;
}

interface BirdeyeResponse {
  data: {
    tokens: BirdeyeToken[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

const log = new Logger('TokenScanner');

// ─── TokenScanner ─────────────────────────────────────────────────────────────

export class TokenScanner {
  private running = false;
  private watchedTokens: TokenConfig[] = [...CONFIG.WATCHED_TOKENS];
  private scheduleHandle: ReturnType<typeof setTimeout> | null = null;

  /**
   * @param priceMonitor  Optional reference — when provided, a successful scan
   *                      atomically updates the monitor's token list (§14.8).
   */
  constructor(private priceMonitor?: PriceMonitor) {}

  // ── Public API ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.running = true;
    log.info('TokenScanner starting — running initial scan …');
    await this.runScan();
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.scheduleHandle !== null) {
      clearTimeout(this.scheduleHandle);
      this.scheduleHandle = null;
    }
    log.info('TokenScanner stopped.');
  }

  /** Returns the current list of watched tokens. */
  getWatchedTokens(): TokenConfig[] {
    return this.watchedTokens;
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private async runScan(): Promise<void> {
    if (!CONFIG.BIRDEYE_API_KEY) {
      log.warn(
        'BIRDEYE_API_KEY is not set — skipping token scan; ' +
        'using default WATCHED_TOKENS from config.'
      );
      return;
    }

    try {
      log.info('Fetching top tokens by 24h volume from Birdeye …');

      const { data } = await axios.get<BirdeyeResponse>(
        'https://public-api.birdeye.so/defi/tokenlist',
        {
          timeout: 10_000,
          headers: {
            'X-API-KEY': CONFIG.BIRDEYE_API_KEY,
          },
          params: {
            sort_by:   'v24hUSD',
            sort_type: 'desc',
            offset:    0,
            limit:     50,
            chain:     'solana',
          },
        }
      );

      const rawTokens: BirdeyeToken[] = data?.data?.tokens ?? [];

      if (!rawTokens.length) {
        log.warn('Birdeye returned an empty token list — keeping existing watched list.');
        return;
      }

      // Filter stablecoins, then take top N
      const filtered = rawTokens
        .filter(t => !STABLECOIN_SYMBOLS.has(t.symbol?.toUpperCase()))
        .slice(0, CONFIG.TOKEN_SCAN_TOP_N);

      // Convert to TokenConfig format
      const newList: TokenConfig[] = filtered.map(t => ({
        symbol:   t.symbol,
        mint:     t.address,
        decimals: t.decimals ?? 6,
      }));

      if (!newList.length) {
        log.warn('All Birdeye tokens were filtered out — keeping existing watched list.');
        return;
      }

      this.watchedTokens = newList;

      const symbols = newList.map(t => t.symbol).join(', ');
      log.info(
        `TokenScanner updated watched list (${newList.length} tokens): ${symbols}`
      );

      // Push new list into priceMonitor atomically (§14.8)
      if (this.priceMonitor) {
        this.priceMonitor.updateTokens(newList);
      }
    } catch (err) {
      log.error(
        'Token scan failed — keeping existing watched list. Reason: ' +
        (err instanceof Error ? err.message : String(err))
      );
      // Do not re-throw; the bot continues with whatever list it had.
    }
  }

  private schedule(): void {
    if (!this.running) return;

    this.scheduleHandle = setTimeout(async () => {
      if (!this.running) return;
      await this.runScan();
      this.schedule(); // reschedule after scan completes
    }, CONFIG.TOKEN_SCAN_INTERVAL_MS);
  }
}
