import { ArbOpportunity } from '../types';
import { CONFIG } from '../config';
import { Logger } from '../logger';
import { PriceMonitor } from '../monitor/priceMonitor';

const log = new Logger('ArbScanner');

export class ArbScanner {
  constructor(private priceMonitor: PriceMonitor) {}

  scan(solPriceUsd: number, availableCapitalUsd = CONFIG.MAX_TRADE_USD): ArbOpportunity[] {
    const opportunities: ArbOpportunity[] = [];

    // Use priceMonitor's live token list (updated by tokenScanner) rather than
    // the static CONFIG array (§14.8)
    for (const token of this.priceMonitor.getTokens()) {
      // Skip USDC — it is the quote currency, not a tradeable leg
      if (token.mint === CONFIG.USDC_MINT) continue;

      // Retrieve all fresh (non-stale) entries for this mint across every DEX
      const freshEntries = this.priceMonitor.getAllEntries(token.mint);

      // Need at least two DEXes to compare
      if (freshEntries.length < 2) continue;

      // Compare every unique (i, j) pair
      for (let i = 0; i < freshEntries.length; i++) {
        for (let j = i + 1; j < freshEntries.length; j++) {
          const a = freshEntries[i];
          const b = freshEntries[j];

          // Determine buy (lower price) and sell (higher price) sides
          const [buySide, sellSide] =
            a.entry.price <= b.entry.price ? [a, b] : [b, a];

          const buyDex   = buySide.dex;
          const sellDex  = sellSide.dex;
          const buyPrice  = buySide.entry.price;
          const sellPrice = sellSide.entry.price;

          const spreadPct = ((sellPrice - buyPrice) / buyPrice) * 100;

          if (spreadPct < CONFIG.MIN_SPREAD_PCT) continue;

          // Fetch extended entries to obtain rawQuote payloads
          const buyEntry  = this.priceMonitor.getExtendedEntry(token.mint, buyDex);
          const sellEntry = this.priceMonitor.getExtendedEntry(token.mint, sellDex);

          if (!buyEntry || !sellEntry) {
            log.debug(
              `[${token.symbol}] Missing extended entry for ${buyDex} or ${sellDex} — skipping`
            );
            continue;
          }

          // Position sizing: cap at available capital (§14.1 capital buffer)
          const tradeSize = Math.min(CONFIG.MAX_TRADE_USD, availableCapitalUsd);

          const grossProfit = tradeSize * (spreadPct / 100);

          // Cost estimates
          const jitoTipUsd = (CONFIG.JITO_TIP_LAMPORTS / 1e9) * solPriceUsd;
          const txFeeUsd   = 0.000005 * 2 * solPriceUsd;

          const netProfitUsd = grossProfit - jitoTipUsd - txFeeUsd;

          if (netProfitUsd < CONFIG.MIN_PROFIT_USD) {
            log.debug(
              `[${token.symbol}] ${buyDex}→${sellDex} spread=${spreadPct.toFixed(3)}% ` +
              `net=$${netProfitUsd.toFixed(4)} — below threshold, skipping`
            );
            continue;
          }

          log.info(
            `[${token.symbol}] Opportunity: buy on ${buyDex} @ $${buyPrice.toFixed(6)} ` +
            `sell on ${sellDex} @ $${sellPrice.toFixed(6)} ` +
            `spread=${spreadPct.toFixed(3)}% net=$${netProfitUsd.toFixed(4)}`
          );

          opportunities.push({
            token:        token.mint,
            tokenSymbol:  token.symbol,
            buyDex,
            sellDex,
            buyPrice,
            sellPrice,
            spreadPct,
            netProfitUsd,
            tradeSizeUsd: tradeSize,
            buyRawQuote:  buyEntry.rawQuote,
            sellRawQuote: sellEntry.rawQuote,
          });
        }
      }
    }

    // Best opportunities first
    opportunities.sort((a, b) => b.netProfitUsd - a.netProfitUsd);

    return opportunities;
  }
}
