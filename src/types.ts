// ─── Price Data ───────────────────────────────────────────────────────────────

export interface PriceEntry {
  price: number;      // USD price of 1 token
  liquidity: number;  // Pool TVL in USD
  timestamp: number;  // Unix ms when quote was fetched
}

// token mint → dex name → price entry
export type PriceMap = Record<string, Record<string, PriceEntry>>;

// ─── Arb Opportunity ─────────────────────────────────────────────────────────

export interface ArbOpportunity {
  token: string;        // Token mint address
  tokenSymbol: string;  // e.g. "SOL"
  buyDex: string;       // DEX to buy on
  sellDex: string;      // DEX to sell on
  buyPrice: number;     // USD price on buy DEX
  sellPrice: number;    // USD price on sell DEX
  spreadPct: number;    // Gross spread (%)
  netProfitUsd: number; // After tip + fees
  tradeSizeUsd: number; // Position size in USD
  buyRawQuote: unknown; // Raw Jupiter quote for buy leg
  sellRawQuote: unknown; // Raw Jupiter quote for sell leg
}

// ─── Bundle Result ────────────────────────────────────────────────────────────

export interface BundleResult {
  landed: boolean;
  profit: number;      // Net USD profit (0 if not landed)
  fees: number;        // Total fees paid (tip + tx fees) in USD
  txSignature: string;
  token: string;
  tokenSymbol: string;
  timestamp: number;
}

// ─── P&L State ────────────────────────────────────────────────────────────────

export interface PnLState {
  totalTrades: number;
  wins: number;
  losses: number;
  grossProfit: number;
  totalFees: number;
  netProfit: number;
  dailyLoss: number;                            // Resets midnight UTC
  blacklistedTokens: string[];                  // Mint addresses
  consecutiveFailures: Record<string, number>;  // mint → count
  tradeWindow: boolean[];                       // Last N results for win rate
  lastDailyReset: string;                       // ISO date YYYY-MM-DD
}

// ─── Trade Record (persisted as NDJSON) ──────────────────────────────────────

export interface TradeRecord {
  timestamp: number;
  token: string;
  tokenSymbol: string;
  buyDex: string;
  sellDex: string;
  grossProfit: number;
  fees: number;
  netProfit: number;
  landed: boolean;
  txSignature: string;
  tradeSizeUsd: number;
  spreadPct: number;
}

// ─── Dashboard WebSocket Events ───────────────────────────────────────────────

export interface DashboardEvent {
  type: 'trade' | 'pnl_update' | 'alert' | 'prices' | 'status';
  payload: unknown;
}

export interface AlertEvent {
  level: 'warn' | 'error' | 'info';
  message: string;
  timestamp: number;
}

// ─── Type Guards ──────────────────────────────────────────────────────────────

export function isPriceEntry(obj: unknown): obj is PriceEntry {
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return (
    typeof o.price === 'number' &&
    typeof o.liquidity === 'number' &&
    typeof o.timestamp === 'number'
  );
}

export function isArbOpportunity(obj: unknown): obj is ArbOpportunity {
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return (
    typeof o.token === 'string' &&
    typeof o.buyDex === 'string' &&
    typeof o.sellDex === 'string' &&
    typeof o.buyPrice === 'number' &&
    typeof o.sellPrice === 'number' &&
    typeof o.spreadPct === 'number' &&
    typeof o.netProfitUsd === 'number' &&
    typeof o.tradeSizeUsd === 'number'
  );
}
