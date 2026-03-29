# ARBEX — Solana MEV Arbitrage Bot

> **Capital:** 0.5 SOL (~$75) · **Platform:** Windows PC → Linux VPS
> **Stack:** TypeScript 5.4 · Node.js 20 LTS · Jupiter V6 · Jito · Helius

ARBEX detects price spreads across four Solana DEXes and executes atomic arbitrage
via Jito bundles. Either both swaps land, or neither does — no half-filled positions.

---

## Architecture

```
src/
├── index.ts                    Main loop — orchestrates all modules, tracks P&L
├── config.ts                   All tunable parameters (thresholds, limits, keys)
├── logger.ts                   Structured timestamped logs (file + console)
├── types.ts                    Shared TypeScript interfaces + type guards
│
├── monitor/
│   ├── priceMonitor.ts         Polls Jupiter, Raydium, Orca, Meteora every 200ms
│   └── tokenScanner.ts         Ranks top-50 tokens by spread potential (Birdeye)
│
├── scanner/
│   └── scanner.ts              Detects spreads, validates net profit after fees
│
├── executor/
│   ├── jupiterSwap.ts          Fetches serialized swap txs from Jupiter V6
│   └── jito.ts                 Builds 3-tx atomic bundles, submits to Jito
│
├── safety/
│   ├── riskGuard.ts            Daily loss limit, blacklist, win-rate pause
│   └── autoTune.ts             Auto-adjusts Jito tip every 50 trades
│
├── tracker/
│   └── pnl.ts                  Persists trades (NDJSON), rehydrates on restart
│
└── dashboard/
    ├── server.ts               Express + WebSocket server on port 3001
    └── mev-dashboard.html      Single-file live dark-theme dashboard
```

### Data flow (every 200 ms tick)

```
priceMonitor  ──▶  PriceMap { token → { Jupiter|Raydium|Orca|Meteora → price } }
scanner       ──▶  ArbOpportunity[] (sorted by net profit, post-fee)
riskGuard     ──▶  allowed / blocked (daily loss, blacklist, win rate)
jito          ──▶  [tipTx, buyTx, sellTx] atomic bundle → Jito Block Engine
pnl + logger  ──▶  trades.json (NDJSON) + live dashboard via WebSocket
autoTune      ──▶  adjusts JITO_TIP_LAMPORTS every 50 trades
```

---

## Prerequisites (Windows PC)

```powershell
# 1. Install nvm-windows from https://github.com/coreybutler/nvm-windows/releases
nvm install 20
nvm use 20
node --version   # v20.x.x

# 2. Global tools
npm install -g typescript ts-node
tsc --version    # 5.x.x

# 3. Git for Windows: https://git-scm.com/download/win
git --version
```

---

## Quick Start

### 1. Clone & install

```powershell
git clone <repo>
cd arbex
npm install
```

### 2. Configure environment

```powershell
copy .env.example .env
notepad .env
```

Fill in:

```
HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
JITO_BLOCK_ENGINE_URL=https://mainnet.block-engine.jito.wtf
WALLET_PRIVATE_KEY=YOUR_BASE58_KEY          # generated in step 3
BIRDEYE_API_KEY=YOUR_KEY
DASHBOARD_SECRET=change_me_to_something_random
```

### 3. Generate a dedicated bot wallet

> ⚠️ **Never use your main wallet.** Generate a fresh one for the bot.

```powershell
npm run wallet
# Prints: public key + base58 private key
# Paste private key into WALLET_PRIVATE_KEY in .env
# Send 0.5 SOL to the printed public key
```

### 4. Run tests

```powershell
npm test
# Expected: all Jest tests pass
```

### 5. Start the bot

```powershell
npm run dev
# Dashboard: http://localhost:3001
# Logs: ./logs/arbex-YYYY-MM-DD.log
```

---

## VPS Deployment (Ubuntu 22.04)

### Transfer & install

```bash
git clone <repo>
# Transfer .env securely (scp, secrets manager, etc.)
scp .env user@vps:~/arbex/.env
cd arbex
npm install
npm run build          # Compiles TypeScript → dist/
```

### Run with PM2 (auto-restart on reboot)

```bash
npm install -g pm2

pm2 start dist/index.js --name arbex
pm2 save               # Persist process list across reboots
pm2 startup            # Install startup hook (follow printed command)
pm2 install pm2-logrotate  # Prevent disk fill from PM2 logs

# Dashboard: http://YOUR_VPS_IP:3001
```

### PM2 cheatsheet

```bash
pm2 logs arbex          # Tail live logs
pm2 status              # Process health
pm2 restart arbex       # Restart bot
pm2 stop arbex          # Stop bot
pm2 delete arbex        # Remove from PM2
```

### Manual blacklist reload (without restart)

```bash
# Edit data/blacklist.json, then:
kill -USR1 $(pm2 pid arbex)
```

---

## Configuration (`src/config.ts`)

All parameters are in one place. No hardcoded values anywhere else.

| Parameter | Default | Description |
|-----------|---------|-------------|
| `MIN_PROFIT_USD` | `$1.00` | Skip arbs below this net profit |
| `MAX_TRADE_USD` | `$50` | Max position size per arb |
| `MIN_SPREAD_PCT` | `0.3%` | Minimum gross spread to consider |
| `POLL_INTERVAL_MS` | `200ms` | Price polling frequency |
| `JITO_TIP_LAMPORTS` | `10,000` | Starting Jito tip (~$0.001) |
| `MAX_DAILY_LOSS_USD` | `$5.00` | Bot halts for the day if hit |
| `CAPITAL_RESERVE_SOL` | `0.05` | Min SOL kept as fee buffer |
| `BLACKLIST_THRESHOLD` | `10` | Consecutive failures → auto-blacklist |
| `WIN_RATE_PAUSE_PCT` | `20%` | Pause if rolling win rate drops below |
| `WIN_RATE_WINDOW` | `50` | Number of trades for win rate calc |
| `TIP_MIN_LAMPORTS` | `5,000` | AutoTune lower bound |
| `TIP_MAX_LAMPORTS` | `100,000` | AutoTune upper bound |
| `TIP_MAX_PCT_OF_PROFIT` | `0.50` | Tip never exceeds 50% of avg gross |
| `AUTO_TUNE_ENABLED` | `true` | Enable tip auto-adjustment |
| `DASHBOARD_PORT` | `3001` | Dashboard HTTP + WebSocket port |

---

## Safety Systems

### Daily Loss Limit
- `dailyLoss` resets at **midnight UTC** on each bot startup and throughout the day
- Includes: failed bundle tips + swap losses (negative net profit)
- When `dailyLoss >= MAX_DAILY_LOSS_USD`: bot halts, dashboard shows red alert

### Token Blacklist
- Triggers after `BLACKLIST_THRESHOLD` **consecutive** failed bundles per token
- Auto-expires after **24 hours** — no permanent bans
- Manual override: `kill -USR1 <pid>` after editing `data/blacklist.json`

### Win Rate Pause
- Pause lasts **10 minutes** when win rate < 20% over last 50 trades
- After **3 consecutive pauses**: bot halts for the day
- Counters survive restarts via `data/trades.json`

### Auto-Tune
- Runs every **50 trades**
- **Raise tip** if win rate < 40% (losing bundle auctions)
- **Lower tip** if tip > 50% of average gross profit (eating all margin)
- **Lower tip** if win rate > 60% (competitive enough to cut cost)
- Bounds: 5,000 – 100,000 lamports

---

## Tuning Cheatsheet

### Jito Tip
```typescript
// config.ts
JITO_TIP_LAMPORTS: 10_000   // ~$0.001 — start here
JITO_TIP_LAMPORTS: 50_000   // More competitive
JITO_TIP_LAMPORTS: 100_000  // Aggressive (ensure profit > tip)
```
AutoTune adjusts this automatically after 50 trades.

### Profit Threshold
```typescript
MIN_PROFIT_USD: 1.00   // Default — ignores arbs smaller than $1
MIN_PROFIT_USD: 0.50   // Lower = more trades, more tip exposure
```

### Trade Size
```typescript
MAX_TRADE_USD: 50    // Default — safe for $75 starting capital
MAX_TRADE_USD: 25    // More conservative
```
Actual size is capped to `(wallet balance − 0.05 SOL) × SOL price`.

### Spread Threshold
```typescript
MIN_SPREAD_PCT: 0.3   // Default
MIN_SPREAD_PCT: 0.5   // More conservative, fewer but safer trades
```

---

## Persistent Data (`data/`)

| File | Format | Purpose |
|------|--------|---------|
| `trades.json` | NDJSON (one JSON per line) | Full trade history — never overwritten |
| `blacklist.json` | JSON array | Timestamped blacklist entries |
| `state.json` | JSON | AutoTune state (tip lamports) across restarts |

---

## Dashboard (`http://localhost:3001`)

| Panel | Shows |
|-------|-------|
| P&L Strip | Net profit today / all-time / win rate |
| Stats Row | Total trades, wins, losses, best spread today |
| Live Feed | Last 20 trades — token, DEXes, spread, profit, status |
| Safety Status | Daily loss bar, active Jito tip, blacklisted tokens |
| Alerts | Win rate warnings, daily limit, RPC errors |

**Health check:** `GET http://localhost:3001/status` returns full PnLState JSON.

**Remote stop:** `POST http://localhost:3001/stop` with header `x-secret: <DASHBOARD_SECRET>`.

---

## Worker Thread Upgrade Path (post-profitability)

Each module is already interface-isolated for zero-logic-change upgrades:

1. Create `src/workers/priceMonitor.worker.ts` — wraps `priceMonitor.ts` with `parentPort` message passing
2. `index.ts` spawns worker instead of importing directly
3. Repeat for `scanner`, `executor`, `logger`

Zero logic changes — only wrapping.

---

## Out of Scope (this version)

- Multi-hop arbitrage (SOL → BONK → USDC → SOL)
- Flash loan integration
- Cross-chain arbitrage
- Liquidation / NFT floor arb
- Rust rewrite

---

## Legal

DEX arbitrage is legal, beneficial to markets, and fully on-chain transparent.
This bot does **not** front-run users or exploit smart contract vulnerabilities.
