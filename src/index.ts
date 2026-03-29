import { Connection, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

import { CONFIG } from './config';
import { Logger } from './logger';
import { PriceMonitor } from './monitor/priceMonitor';
import { TokenScanner } from './monitor/tokenScanner';
import { ArbScanner } from './scanner/scanner';
import { JitoExecutor } from './executor/jito';
import { RiskGuard } from './safety/riskGuard';
import { AutoTuner } from './safety/autoTune';
import { PnLTracker } from './tracker/pnl';
import { DashboardServer } from './dashboard/server';
import { AlertEvent } from './types';

// ─── Utilities ────────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

// ─── Module-level references (used by signal handlers) ───────────────────────

let priceMonitor: PriceMonitor;
let tokenScanner: TokenScanner;
let pnlTracker:   PnLTracker;
let dashboard:    DashboardServer;

// ─── Graceful shutdown ────────────────────────────────────────────────────────

async function shutdown(log: Logger): Promise<void> {
  log.info('Shutting down — flushing pending writes...');
  try { priceMonitor?.stop();   } catch { /* ignore */ }
  try { tokenScanner?.stop();   } catch { /* ignore */ }
  try { pnlTracker?.flush();    } catch { /* ignore */ }
  Logger.flushAndClose();
  process.exit(0);
}

// ─── SOL price helper ─────────────────────────────────────────────────────────

const SOL_MINT = 'So11111111111111111111111111111111111111112';

interface JupPriceResponse {
  data: Record<string, { price: number }>;
}

async function fetchSolPrice(): Promise<number> {
  try {
    const res  = await fetch(`https://price.jup.ag/v6/price?ids=${SOL_MINT}`);
    const json = (await res.json()) as JupPriceResponse;
    return json.data[SOL_MINT]?.price ?? 150;
  } catch {
    return 150;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const log = new Logger('Main');

  log.info('=== ARBEX STARTING === v1.0.0');

  // ── Signal handlers ──────────────────────────────────────────────────────────
  process.on('SIGINT',  () => { void shutdown(log); });
  process.on('SIGTERM', () => { void shutdown(log); });

  // SIGUSR1 → reload blacklist from disk without restarting (§14.11)
  process.on('SIGUSR1', () => {
    const sigLog = new Logger('SIGUSR1');
    sigLog.info('Received SIGUSR1 — reloading blacklist from disk...');
    try {
      pnlTracker?.checkAndExpireBlacklist();
      sigLog.info('Blacklist reloaded successfully.');
    } catch (err) {
      sigLog.error('Failed to reload blacklist: ' + (err instanceof Error ? err.message : String(err)));
    }
  });

  // ── Global error handlers ───────────────────────────────────────────────────
  process.on('unhandledRejection', (reason: unknown) => {
    const errLog = new Logger('Process');
    errLog.error(
      'Unhandled rejection: ' +
      (reason instanceof Error ? reason.stack ?? reason.message : String(reason))
    );
  });

  process.on('uncaughtException', (err: Error) => {
    const errLog = new Logger('Process');
    errLog.error('Uncaught exception: ' + (err.stack ?? err.message));
  });

  // ── Wallet ───────────────────────────────────────────────────────────────────
  let wallet: Keypair;
  try {
    wallet = Keypair.fromSecretKey(bs58.decode(CONFIG.WALLET_PRIVATE_KEY));
  } catch (err) {
    log.error(
      'Failed to decode WALLET_PRIVATE_KEY: ' +
      (err instanceof Error ? err.message : String(err))
    );
    process.exit(1);
  }

  log.info(`Wallet: ${wallet.publicKey.toBase58()}`);

  // ── RPC connection ───────────────────────────────────────────────────────────
  const wsEndpoint = process.env.HELIUS_WS_URL ?? undefined;
  const connection = new Connection(
    CONFIG.HELIUS_RPC_URL,
    { commitment: 'confirmed', ...(wsEndpoint ? { wsEndpoint } : {}) }
  );

  // ── Initial connectivity check ───────────────────────────────────────────────
  try {
    const slot = await connection.getSlot();
    log.info(`Connected to Solana — current slot: ${slot}`);
  } catch (err) {
    log.error(
      'Cannot reach RPC endpoint: ' +
      (err instanceof Error ? err.message : String(err))
    );
    process.exit(1);
  }

  // ── Startup balance check ────────────────────────────────────────────────────
  const lamports = await connection.getBalance(wallet.publicKey);
  const solBal   = lamports / 1e9;
  log.info(`Wallet balance: ${solBal.toFixed(4)} SOL`);

  if (solBal < CONFIG.CAPITAL_RESERVE_SOL) {
    log.error(
      `Insufficient balance: ${solBal.toFixed(4)} SOL < ` +
      `${CONFIG.CAPITAL_RESERVE_SOL} SOL minimum reserve. Fund the wallet and restart.`
    );
    process.exit(1);
  }

  // ── Instantiate all modules ──────────────────────────────────────────────────
  pnlTracker     = new PnLTracker();
  const riskGuard = new RiskGuard(pnlTracker);
  priceMonitor    = new PriceMonitor(CONFIG.WATCHED_TOKENS);
  tokenScanner    = new TokenScanner(priceMonitor);           // §14.8: feeds back into priceMonitor
  const executor  = new JitoExecutor(connection, wallet);
  const autoTuner = new AutoTuner(pnlTracker, executor);
  const scanner   = new ArbScanner(priceMonitor);
  dashboard       = new DashboardServer(pnlTracker);

  // ── Start services ───────────────────────────────────────────────────────────
  dashboard.start();
  await priceMonitor.start();

  // TokenScanner runs in background — not awaited (§14.8)
  void tokenScanner.start();

  log.info(
    `Bot ready. Watching ${CONFIG.WATCHED_TOKENS.length} tokens. ` +
    `Dashboard: http://localhost:${CONFIG.DASHBOARD_PORT}`
  );

  // ── RPC failure tracking (§12 / §14.10) ─────────────────────────────────────
  let consecutiveRpcErrors = 0;
  const RPC_PAUSE_THRESHOLD = 5;
  const RPC_PAUSE_MS        = 30_000; // §14.10 specifies 30s
  let   rpcPausedUntil      = 0;

  // ── Bundle in-flight guard (§14.1) ──────────────────────────────────────────
  let bundleInFlight = false;

  // ── Main trading loop ────────────────────────────────────────────────────────
  let loopTick = 0;

  while (true) {
    try {

      // ── RPC pause check ─────────────────────────────────────────────────────
      if (Date.now() < rpcPausedUntil) {
        const secLeft = Math.ceil((rpcPausedUntil - Date.now()) / 1000);
        log.warn(`RPC pause active — ${secLeft}s remaining`);
        await sleep(5_000);
        continue;
      }

      // ── Fetch SOL price ─────────────────────────────────────────────────────
      let solPriceUsd: number;
      try {
        solPriceUsd = await fetchSolPrice();
        consecutiveRpcErrors = 0; // success resets counter
      } catch (err) {
        consecutiveRpcErrors++;
        log.error(
          `SOL price fetch failed (${consecutiveRpcErrors}/${RPC_PAUSE_THRESHOLD}): ` +
          (err instanceof Error ? err.message : String(err))
        );
        if (consecutiveRpcErrors >= RPC_PAUSE_THRESHOLD) {
          rpcPausedUntil = Date.now() + RPC_PAUSE_MS;
          const alert: AlertEvent = {
            level:     'error',
            message:   `RPC errors — pausing ${RPC_PAUSE_MS / 1000}s (${consecutiveRpcErrors} consecutive failures)`,
            timestamp: Date.now(),
          };
          dashboard?.pushAlert(alert);
          consecutiveRpcErrors = 0;
          log.error(`${RPC_PAUSE_THRESHOLD}+ RPC failures — pausing ${RPC_PAUSE_MS / 1000}s`);
        }
        await sleep(CONFIG.POLL_INTERVAL_MS);
        continue;
      }

      // ── Capital available (§14.1) ────────────────────────────────────────────
      // Only refresh wallet balance every 10 ticks to avoid excessive RPC calls
      let availableCapitalUsd = CONFIG.MAX_TRADE_USD;
      if (loopTick % 10 === 0) {
        try {
          const balLamports = await connection.getBalance(wallet.publicKey);
          const tradableSol = Math.max(0, (balLamports / 1e9) - CONFIG.CAPITAL_RESERVE_SOL);
          availableCapitalUsd = Math.min(CONFIG.MAX_TRADE_USD, tradableSol * solPriceUsd);
        } catch {
          // Wallet balance check failed — use last known MAX_TRADE_USD safely
        }
      }

      // ── Scan for opportunities ───────────────────────────────────────────────
      const opportunities = scanner.scan(solPriceUsd, availableCapitalUsd);

      // Push fresh prices to the dashboard on every tick
      dashboard.pushPrices(priceMonitor.getMap());

      // ── Skip if bundle already in flight (§14.1) ────────────────────────────
      if (bundleInFlight) {
        await sleep(CONFIG.POLL_INTERVAL_MS);
        continue;
      }

      for (const opp of opportunities) {
        // ── Risk gate ──────────────────────────────────────────────────────────
        const guard = riskGuard.check(opp);
        if (!guard.allowed) {
          log.warn(`[${opp.tokenSymbol}] Blocked — ${guard.reason ?? 'risk guard'}`);
          // Push daily-halt alert to dashboard when daily loss ceiling hit
          if (guard.reason?.includes('Daily loss')) {
            dashboard.pushAlert({
              level:     'error',
              message:   `Daily loss limit reached ($${CONFIG.MAX_DAILY_LOSS_USD}). Bot halted until midnight UTC.`,
              timestamp: Date.now(),
            });
          }
          continue;
        }

        // ── Log opportunity ────────────────────────────────────────────────────
        log.info(
          `[${opp.tokenSymbol}] ARB | ` +
          `${opp.buyDex} $${opp.buyPrice.toFixed(6)} -> ` +
          `${opp.sellDex} $${opp.sellPrice.toFixed(6)} | ` +
          `spread=${opp.spreadPct.toFixed(3)}% ` +
          `size=$${opp.tradeSizeUsd.toFixed(2)} ` +
          `net=$${opp.netProfitUsd.toFixed(4)}`
        );

        // ── Set in-flight flag — discard remaining opportunities this tick ─────
        bundleInFlight = true;
        dashboard.pushPrices(priceMonitor.getMap());

        // ── Execute ────────────────────────────────────────────────────────────
        let result;
        try {
          result = await executor.executeArb(opp, solPriceUsd);
          consecutiveRpcErrors = 0; // successful execution clears RPC error streak
        } catch (err) {
          consecutiveRpcErrors++;
          log.error(
            `[${opp.tokenSymbol}] executeArb threw: ` +
            (err instanceof Error ? err.stack ?? err.message : String(err))
          );
          bundleInFlight = false;
          break;
        }

        bundleInFlight = false;

        // ── Record results ─────────────────────────────────────────────────────
        pnlTracker.recordResult(result, {
          spreadPct:    opp.spreadPct,
          tradeSizeUsd: opp.tradeSizeUsd,
          buyDex:       opp.buyDex,
          sellDex:      opp.sellDex,
        });

        autoTuner.onTrade();
        dashboard.pushTrade(result);
        dashboard.pushPnL(pnlTracker.getState());

        if (result.landed) {
          log.info(
            `[${opp.tokenSymbol}] LANDED | ` +
            `profit=$${result.profit.toFixed(4)} ` +
            `fees=$${result.fees.toFixed(4)} ` +
            `sig=${result.txSignature}`
          );
        } else {
          log.warn(
            `[${opp.tokenSymbol}] NOT LANDED | ` +
            `fees=$${result.fees.toFixed(4)} ` +
            `sig=${result.txSignature || 'n/a'}`
          );
        }

        // Only one bundle per tick — break after first execution (§14.1)
        break;
      }

      // ── Periodic maintenance ─────────────────────────────────────────────────
      loopTick++;
      if (loopTick % 100 === 0) {
        pnlTracker.checkAndExpireBlacklist();
      }

    } catch (err) {
      const errLog = new Logger('Loop');
      errLog.error(
        'Unhandled loop error: ' +
        (err instanceof Error ? err.stack ?? err.message : String(err))
      );
      bundleInFlight = false; // always clear on error
      await sleep(2_000);
    }

    await sleep(CONFIG.POLL_INTERVAL_MS);
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
