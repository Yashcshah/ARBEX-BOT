import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  VersionedTransaction,
  TransactionMessage,
} from '@solana/web3.js';
import { ArbOpportunity, BundleResult } from '../types';
import { CONFIG } from '../config';
import { Logger } from '../logger';
import { JupiterSwap } from './jupiterSwap';
import axios from 'axios';

const log = new Logger('JitoExecutor');

// Polling constants for waitForBundle
const POLL_INTERVAL_MS  = 500;
const MAX_POLL_ATTEMPTS = 60; // 60 x 500 ms = 30 s

export class JitoExecutor {
  private jupiterSwap: JupiterSwap;
  private currentTipLamports: number = CONFIG.JITO_TIP_LAMPORTS;

  constructor(
    private connection: Connection,
    private wallet:     Keypair,
  ) {
    this.jupiterSwap = new JupiterSwap(wallet);
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Execute an arbitrage opportunity as a 3-tx Jito bundle:
   *   [tipTx, buyTx, sellTx]
   */
  async executeArb(opp: ArbOpportunity, solPriceUsd: number): Promise<BundleResult> {
    const tipCostUsd = (this.currentTipLamports / 1e9) * solPriceUsd;
    const txFeeUsd   = 0.000005 * 2 * solPriceUsd;

    // Build buy and sell transactions concurrently
    const [buyTx, sellTx] = await Promise.all([
      this.jupiterSwap.getSwapTx(
        opp.buyRawQuote,
        `BUY  ${opp.tokenSymbol} on ${opp.buyDex}`
      ),
      this.jupiterSwap.getSwapTx(
        opp.sellRawQuote,
        `SELL ${opp.tokenSymbol} on ${opp.sellDex}`
      ),
    ]);

    if (!buyTx || !sellTx) {
      log.warn(
        `[${opp.tokenSymbol}] Failed to build swap tx(s) — ` +
        `buyTx=${!!buyTx} sellTx=${!!sellTx}; aborting bundle`
      );
      return this.failedResult(opp, tipCostUsd + txFeeUsd);
    }

    let tipTx: VersionedTransaction;
    try {
      tipTx = await this.buildTipTx();
    } catch (err) {
      log.error(
        `[${opp.tokenSymbol}] Failed to build tip tx: ` +
        (err instanceof Error ? err.message : String(err))
      );
      return this.failedResult(opp, tipCostUsd + txFeeUsd);
    }

    // Bundle order: tip first so Jito validators prioritise the bundle
    return this.sendBundle([tipTx, buyTx, sellTx], opp, solPriceUsd);
  }

  setTipLamports(lamports: number): void {
    this.currentTipLamports = lamports;
    log.debug(`Tip updated to ${lamports} lamports`);
  }

  getTipLamports(): number {
    return this.currentTipLamports;
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  /**
   * Build a signed SOL transfer to a randomly selected Jito tip account.
   */
  private async buildTipTx(): Promise<VersionedTransaction> {
    const tipAccounts = CONFIG.JITO_TIP_ACCOUNTS;
    const tipAccount  = tipAccounts[Math.floor(Math.random() * tipAccounts.length)];
    const tipKey      = new PublicKey(tipAccount);

    const { blockhash } = await this.connection.getLatestBlockhash('confirmed');

    const tipIx = SystemProgram.transfer({
      fromPubkey: this.wallet.publicKey,
      toPubkey:   tipKey,
      lamports:   this.currentTipLamports,
    });

    const msg = new TransactionMessage({
      payerKey:        this.wallet.publicKey,
      recentBlockhash: blockhash,
      instructions:    [tipIx],
    }).compileToV0Message();

    const tx = new VersionedTransaction(msg);
    tx.sign([this.wallet]);

    log.debug(
      `Tip tx built: ${this.currentTipLamports} lamports -> ${tipAccount.slice(0, 8)}...`
    );
    return tx;
  }

  /**
   * Serialize and POST a bundle of transactions to the Jito block-engine,
   * then poll for confirmation.
   */
  private async sendBundle(
    txs:         VersionedTransaction[],
    opp:         ArbOpportunity,
    solPriceUsd: number,
  ): Promise<BundleResult> {
    const tipCostUsd = (this.currentTipLamports / 1e9) * solPriceUsd;
    const txFeeUsd   = 0.000005 * 2 * solPriceUsd;
    const totalFees  = tipCostUsd + txFeeUsd;

    // Serialize every transaction to base64
    const encodedTxs = txs.map(tx =>
      Buffer.from(tx.serialize()).toString('base64')
    );

    const rpcBody = {
      jsonrpc: '2.0',
      id:      1,
      method:  'sendBundle',
      params:  [encodedTxs],
    };

    let bundleId: string;
    try {
      const { data } = await axios.post(
        `${CONFIG.JITO_BLOCK_ENGINE_URL}/api/v1/bundles`,
        rpcBody,
        { timeout: 15_000 }
      );

      if (data.error) {
        log.error(
          `[${opp.tokenSymbol}] Jito RPC error: ${JSON.stringify(data.error)}`
        );
        return this.failedResult(opp, tipCostUsd); // tip may have been consumed
      }

      bundleId = data.result as string;
      log.info(`[${opp.tokenSymbol}] Bundle submitted — id: ${bundleId}`);
    } catch (err) {
      log.error(
        `[${opp.tokenSymbol}] Failed to submit bundle: ` +
        (err instanceof Error ? err.message : String(err))
      );
      return this.failedResult(opp, tipCostUsd);
    }

    const confirmed = await this.waitForBundle(bundleId);

    if (confirmed) {
      log.info(
        `[${opp.tokenSymbol}] Bundle LANDED — profit=$${opp.netProfitUsd.toFixed(4)} ` +
        `fees=$${totalFees.toFixed(4)} id=${bundleId}`
      );
      return {
        landed:      true,
        profit:      opp.netProfitUsd,
        fees:        totalFees,
        txSignature: bundleId,
        token:       opp.token,
        tokenSymbol: opp.tokenSymbol,
        timestamp:   Date.now(),
      };
    }

    log.warn(`[${opp.tokenSymbol}] Bundle did NOT land — id=${bundleId}`);
    return {
      landed:      false,
      profit:      0,
      fees:        tipCostUsd, // Tip was consumed even if bundle did not land
      txSignature: bundleId,
      token:       opp.token,
      tokenSymbol: opp.tokenSymbol,
      timestamp:   Date.now(),
    };
  }

  /**
   * Poll the Jito block-engine for bundle status until confirmed/finalized or
   * the 30-second timeout is reached.
   */
  private async waitForBundle(bundleId: string): Promise<boolean> {
    const rpcBody = {
      jsonrpc: '2.0',
      id:      1,
      method:  'getBundleStatuses',
      params:  [[bundleId]],
    };

    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
      await this.sleep(POLL_INTERVAL_MS);

      try {
        const { data } = await axios.post(
          `${CONFIG.JITO_BLOCK_ENGINE_URL}/api/v1/bundles`,
          rpcBody,
          { timeout: 5_000 }
        );

        const statuses: Array<{ bundle_id: string; status: string }> | undefined =
          data?.result?.value;

        if (!statuses || statuses.length === 0) continue;

        const status = statuses[0].status;
        log.debug(
          `[waitForBundle] ${bundleId.slice(0, 12)}... status=${status} (poll ${attempt + 1})`
        );

        if (status === 'confirmed' || status === 'finalized') {
          return true;
        }

        // Terminal failure states — no point continuing to poll
        if (status === 'failed' || status === 'invalid') {
          log.warn(`Bundle ${bundleId.slice(0, 12)}... status=${status} — giving up`);
          return false;
        }

      } catch (err) {
        log.debug(
          `waitForBundle poll error (attempt ${attempt + 1}): ` +
          (err instanceof Error ? err.message : String(err))
        );
        // Continue polling on transient network errors
      }
    }

    log.warn(
      `Bundle ${bundleId.slice(0, 12)}... timed out after ` +
      `${(MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS) / 1000}s`
    );
    return false;
  }

  // ── Utilities ────────────────────────────────────────────────────────────────

  private failedResult(opp: ArbOpportunity, feesUsd: number): BundleResult {
    return {
      landed:      false,
      profit:      0,
      fees:        feesUsd,
      txSignature: '',
      token:       opp.token,
      tokenSymbol: opp.tokenSymbol,
      timestamp:   Date.now(),
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
