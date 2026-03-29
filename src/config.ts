import * as dotenv from 'dotenv';
dotenv.config();

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

export const CONFIG = {
  // ── Required env vars ────────────────────────────────────────────────────────
  WALLET_PRIVATE_KEY: requireEnv('WALLET_PRIVATE_KEY'),
  HELIUS_RPC_URL:     requireEnv('HELIUS_RPC_URL'),

  // ── Optional env vars ────────────────────────────────────────────────────────
  HELIUS_RPC_FALLBACK_URL: process.env.HELIUS_RPC_FALLBACK_URL ?? '',
  JITO_BLOCK_ENGINE_URL:   process.env.JITO_BLOCK_ENGINE_URL ?? 'https://mainnet.block-engine.jito.wtf',
  BIRDEYE_API_KEY:          process.env.BIRDEYE_API_KEY ?? '',
  DASHBOARD_SECRET:         process.env.DASHBOARD_SECRET ?? 'changeme',
  DEBUG:                    process.env.DEBUG === 'true',

  // ── Trading ──────────────────────────────────────────────────────────────────
  MIN_PROFIT_USD:     1.00,
  MAX_TRADE_USD:      50,
  MIN_SPREAD_PCT:     0.3,
  POLL_INTERVAL_MS:   200,
  PRICE_STALENESS_MS: 500,  // Discard quotes older than this

  // ── Jito ─────────────────────────────────────────────────────────────────────
  JITO_TIP_LAMPORTS:      10_000,
  JITO_BUNDLE_TIMEOUT_MS: 30_000,
  JITO_TIP_ACCOUNTS: [
    '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
    'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
    'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
    'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
    'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
    'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
    '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
  ],

  // ── Safety ───────────────────────────────────────────────────────────────────
  MAX_DAILY_LOSS_USD:     5.00,
  CAPITAL_RESERVE_SOL:    0.05,
  BLACKLIST_THRESHOLD:    10,
  WIN_RATE_PAUSE_PCT:     20,
  WIN_RATE_WINDOW:        50,
  WIN_RATE_LOW_PCT:       40,
  WIN_RATE_PAUSE_MINUTES: 10,
  WIN_RATE_MAX_PAUSES:    3,

  // ── Auto-tune ────────────────────────────────────────────────────────────────
  AUTO_TUNE_ENABLED:      true,
  TIP_INCREASE_LAMPORTS:  10_000,
  TIP_DECREASE_LAMPORTS:  5_000,
  TIP_MIN_LAMPORTS:       5_000,
  TIP_MAX_LAMPORTS:       100_000,
  TIP_MAX_PCT_OF_PROFIT:  0.50,
  AUTO_TUNE_WINDOW:       50,
  AUTO_TUNE_PROFIT_WINDOW: 20,

  // ── Token Scanner ────────────────────────────────────────────────────────────
  TOKEN_SCAN_INTERVAL_MS: 24 * 60 * 60 * 1000,
  TOKEN_SCAN_TOP_N:       20,

  // ── Dashboard ────────────────────────────────────────────────────────────────
  DASHBOARD_PORT: 3001,

  // ── Logging / Persistence ────────────────────────────────────────────────────
  LOG_DIR:        './logs',
  DATA_DIR:       './data',
  TRADES_FILE:    './data/trades.json',
  BLACKLIST_FILE: './data/blacklist.json',
  STATE_FILE:     './data/state.json',

  // ── Token list (updated by tokenScanner at runtime) ──────────────────────────
  WATCHED_TOKENS: [
    { symbol: 'SOL',  mint: 'So11111111111111111111111111111111111111112',  decimals: 9 },
    { symbol: 'BONK', mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', decimals: 5 },
    { symbol: 'WIF',  mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', decimals: 6 },
    { symbol: 'JUP',  mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',  decimals: 6 },
    { symbol: 'RAY',  mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', decimals: 6 },
    { symbol: 'JTO',  mint: 'jtojtomepa8berHjUyMmkGmzPiUFPNnUJbPDJkKKNs',  decimals: 9 },
  ],

  USDC_MINT: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  MAX_SLIPPAGE_BPS: 50,
};

export type TokenConfig = typeof CONFIG.WATCHED_TOKENS[number];

// ── Runtime-mutable config (tip lamports, halt state) ────────────────────────
export const runtimeConfig = {
  jitoTipLamports: CONFIG.JITO_TIP_LAMPORTS,
  watchedTokens:   [...CONFIG.WATCHED_TOKENS] as TokenConfig[],
  botHalted:       false,
  haltReason:      '',
};

export function tokenByMint(mint: string): TokenConfig | undefined {
  return CONFIG.WATCHED_TOKENS.find(t => t.mint === mint);
}

export function tokenBySymbol(symbol: string): TokenConfig | undefined {
  return CONFIG.WATCHED_TOKENS.find(t => t.symbol === symbol);
}
