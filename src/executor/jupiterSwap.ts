import { VersionedTransaction, Keypair } from '@solana/web3.js';
import axios from 'axios';
import { Logger } from '../logger';
import { CONFIG } from '../config';

const log = new Logger('JupiterSwap');

const JUPITER_SWAP_URL = 'https://quote-api.jup.ag/v6/swap';
const MAX_RETRIES      = 3;
const BASE_DELAY_MS    = 1000; // 1 s → 2 s on second retry

export class JupiterSwap {
  constructor(private wallet: Keypair) {}

  /**
   * Fetch a serialized swap transaction from Jupiter V6 /swap and deserialize +
   * sign it, ready for inclusion in a Jito bundle.
   *
   * @param rawQuote  The raw quote object returned by /v6/quote (stored in ExtendedPriceEntry).
   * @param label     Human-readable label used in log messages (e.g. "BUY Jupiter").
   * @returns         A signed VersionedTransaction, or null on unrecoverable failure.
   */
  async getSwapTx(rawQuote: unknown, label: string): Promise<VersionedTransaction | null> {
    const body = {
      quoteResponse:             rawQuote,
      userPublicKey:             this.wallet.publicKey.toBase58(),
      wrapAndUnwrapSol:          true,
      dynamicComputeUnitLimit:   true,
      prioritizationFeeLamports: 'auto' as const,
    };

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await axios.post(JUPITER_SWAP_URL, body, {
          timeout: 10_000,
          validateStatus: () => true, // Handle non-2xx ourselves
        });

        if (response.status !== 200) {
          log.warn(
            `[${label}] Jupiter /swap returned HTTP ${response.status} ` +
            `(attempt ${attempt}/${MAX_RETRIES}): ` +
            JSON.stringify(response.data).slice(0, 200)
          );
          // Non-200 responses are not network errors; treat as permanent failure
          return null;
        }

        const { swapTransaction } = response.data as { swapTransaction: string };
        if (!swapTransaction) {
          log.warn(`[${label}] Jupiter /swap response missing swapTransaction field`);
          return null;
        }

        // Deserialize the base64-encoded VersionedTransaction
        const buf = Buffer.from(swapTransaction, 'base64');
        const tx  = VersionedTransaction.deserialize(buf);

        // Sign with the wallet keypair
        tx.sign([this.wallet]);

        log.debug(`[${label}] Swap tx built and signed (attempt ${attempt})`);
        return tx;

      } catch (err) {
        // Network / timeout errors — eligible for retry with exponential backoff
        const isLastAttempt = attempt === MAX_RETRIES;
        const errMsg = err instanceof Error ? err.message : String(err);

        if (isLastAttempt) {
          log.error(`[${label}] Jupiter /swap failed after ${MAX_RETRIES} attempts: ${errMsg}`);
          return null;
        }

        const delayMs = BASE_DELAY_MS * attempt; // 1 s, 2 s
        log.warn(
          `[${label}] Jupiter /swap network error (attempt ${attempt}/${MAX_RETRIES}), ` +
          `retrying in ${delayMs}ms: ${errMsg}`
        );
        await this.sleep(delayMs);
      }
    }

    // Should never be reached, but satisfies TypeScript
    return null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
