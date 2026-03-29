// Tests for src/config.ts
//
// config.ts calls requireEnv() at module-load time, so each test must use
// jest.resetModules() to force a fresh evaluation with the desired env state.

// Silence logger file-stream noise during tests
jest.mock('../src/logger', () => ({
  Logger: jest.fn().mockImplementation(() => ({
    debug: jest.fn(),
    info:  jest.fn(),
    warn:  jest.fn(),
    error: jest.fn(),
  })),
}));

// dotenv.config() must be a no-op so it never reads a real .env file
jest.mock('dotenv', () => ({ config: jest.fn() }));

describe('CONFIG loading', () => {
  // Save the original env so we can restore it after each test
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    // Start each test with a clean slate
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV };
    // Remove both required vars so individual tests can set exactly what they need
    delete process.env.WALLET_PRIVATE_KEY;
    delete process.env.HELIUS_RPC_URL;
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  // ── Required env vars ───────────────────────────────────────────────────────

  it('throws when WALLET_PRIVATE_KEY is missing', () => {
    process.env.HELIUS_RPC_URL = 'https://rpc.helius.xyz/?api-key=test';
    // WALLET_PRIVATE_KEY is absent
    expect(() => require('../src/config')).toThrow(
      'Missing required environment variable: WALLET_PRIVATE_KEY',
    );
  });

  it('throws when HELIUS_RPC_URL is missing', () => {
    process.env.WALLET_PRIVATE_KEY = 'mock-private-key-base58';
    // HELIUS_RPC_URL is absent
    expect(() => require('../src/config')).toThrow(
      'Missing required environment variable: HELIUS_RPC_URL',
    );
  });

  it('throws when both required vars are missing', () => {
    // Neither variable is set
    expect(() => require('../src/config')).toThrow(
      'Missing required environment variable:',
    );
  });

  // ── Successful load ─────────────────────────────────────────────────────────

  it('loads successfully when both required vars are present', () => {
    process.env.WALLET_PRIVATE_KEY = 'mock-private-key-base58';
    process.env.HELIUS_RPC_URL     = 'https://rpc.helius.xyz/?api-key=test';

    // Should not throw
    const { CONFIG } = require('../src/config') as typeof import('../src/config');

    expect(CONFIG.WALLET_PRIVATE_KEY).toBe('mock-private-key-base58');
    expect(CONFIG.HELIUS_RPC_URL).toBe('https://rpc.helius.xyz/?api-key=test');
  });

  // ── Default values ──────────────────────────────────────────────────────────

  it('applies correct trading defaults', () => {
    process.env.WALLET_PRIVATE_KEY = 'mock-private-key-base58';
    process.env.HELIUS_RPC_URL     = 'https://rpc.helius.xyz/?api-key=test';

    const { CONFIG } = require('../src/config') as typeof import('../src/config');

    expect(CONFIG.MIN_PROFIT_USD).toBe(1.00);
    expect(CONFIG.MAX_TRADE_USD).toBe(50);
    expect(CONFIG.MIN_SPREAD_PCT).toBe(0.3);
    expect(CONFIG.POLL_INTERVAL_MS).toBe(200);
    expect(CONFIG.PRICE_STALENESS_MS).toBe(500);
  });

  it('applies correct safety defaults', () => {
    process.env.WALLET_PRIVATE_KEY = 'mock-private-key-base58';
    process.env.HELIUS_RPC_URL     = 'https://rpc.helius.xyz/?api-key=test';

    const { CONFIG } = require('../src/config') as typeof import('../src/config');

    expect(CONFIG.MAX_DAILY_LOSS_USD).toBe(5.00);
    expect(CONFIG.CAPITAL_RESERVE_SOL).toBe(0.05);
    expect(CONFIG.BLACKLIST_THRESHOLD).toBe(10);
    expect(CONFIG.WIN_RATE_PAUSE_PCT).toBe(20);
    expect(CONFIG.WIN_RATE_WINDOW).toBe(50);
    expect(CONFIG.WIN_RATE_LOW_PCT).toBe(40);
    expect(CONFIG.WIN_RATE_PAUSE_MINUTES).toBe(10);
    expect(CONFIG.WIN_RATE_MAX_PAUSES).toBe(3);
  });

  it('defaults JITO_BLOCK_ENGINE_URL when not set in env', () => {
    process.env.WALLET_PRIVATE_KEY = 'mock-private-key-base58';
    process.env.HELIUS_RPC_URL     = 'https://rpc.helius.xyz/?api-key=test';
    delete process.env.JITO_BLOCK_ENGINE_URL;

    const { CONFIG } = require('../src/config') as typeof import('../src/config');

    expect(CONFIG.JITO_BLOCK_ENGINE_URL).toBe('https://mainnet.block-engine.jito.wtf');
  });

  it('uses JITO_BLOCK_ENGINE_URL from env when provided', () => {
    process.env.WALLET_PRIVATE_KEY   = 'mock-private-key-base58';
    process.env.HELIUS_RPC_URL       = 'https://rpc.helius.xyz/?api-key=test';
    process.env.JITO_BLOCK_ENGINE_URL = 'https://custom-jito.example.com';

    const { CONFIG } = require('../src/config') as typeof import('../src/config');

    expect(CONFIG.JITO_BLOCK_ENGINE_URL).toBe('https://custom-jito.example.com');
  });

  it('defaults DASHBOARD_SECRET to "changeme" when not set', () => {
    process.env.WALLET_PRIVATE_KEY = 'mock-private-key-base58';
    process.env.HELIUS_RPC_URL     = 'https://rpc.helius.xyz/?api-key=test';
    delete process.env.DASHBOARD_SECRET;

    const { CONFIG } = require('../src/config') as typeof import('../src/config');

    expect(CONFIG.DASHBOARD_SECRET).toBe('changeme');
  });

  it('sets DEBUG to false by default', () => {
    process.env.WALLET_PRIVATE_KEY = 'mock-private-key-base58';
    process.env.HELIUS_RPC_URL     = 'https://rpc.helius.xyz/?api-key=test';
    delete process.env.DEBUG;

    const { CONFIG } = require('../src/config') as typeof import('../src/config');

    expect(CONFIG.DEBUG).toBe(false);
  });

  it('sets DEBUG to true when env var is "true"', () => {
    process.env.WALLET_PRIVATE_KEY = 'mock-private-key-base58';
    process.env.HELIUS_RPC_URL     = 'https://rpc.helius.xyz/?api-key=test';
    process.env.DEBUG              = 'true';

    const { CONFIG } = require('../src/config') as typeof import('../src/config');

    expect(CONFIG.DEBUG).toBe(true);
  });

  it('includes USDC_MINT in CONFIG', () => {
    process.env.WALLET_PRIVATE_KEY = 'mock-private-key-base58';
    process.env.HELIUS_RPC_URL     = 'https://rpc.helius.xyz/?api-key=test';

    const { CONFIG } = require('../src/config') as typeof import('../src/config');

    expect(CONFIG.USDC_MINT).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  });

  it('has a non-empty WATCHED_TOKENS list that includes SOL', () => {
    process.env.WALLET_PRIVATE_KEY = 'mock-private-key-base58';
    process.env.HELIUS_RPC_URL     = 'https://rpc.helius.xyz/?api-key=test';

    const { CONFIG } = require('../src/config') as typeof import('../src/config');

    expect(CONFIG.WATCHED_TOKENS.length).toBeGreaterThan(0);
    const sol = CONFIG.WATCHED_TOKENS.find((t) => t.symbol === 'SOL');
    expect(sol).toBeDefined();
    expect(sol?.mint).toBe('So11111111111111111111111111111111111111112');
  });

  // ── tokenByMint / tokenBySymbol helpers ─────────────────────────────────────

  it('tokenByMint returns the correct token config', () => {
    process.env.WALLET_PRIVATE_KEY = 'mock-private-key-base58';
    process.env.HELIUS_RPC_URL     = 'https://rpc.helius.xyz/?api-key=test';

    const { tokenByMint } = require('../src/config') as typeof import('../src/config');

    const token = tokenByMint('So11111111111111111111111111111111111111112');
    expect(token?.symbol).toBe('SOL');
  });

  it('tokenByMint returns undefined for an unknown mint', () => {
    process.env.WALLET_PRIVATE_KEY = 'mock-private-key-base58';
    process.env.HELIUS_RPC_URL     = 'https://rpc.helius.xyz/?api-key=test';

    const { tokenByMint } = require('../src/config') as typeof import('../src/config');

    expect(tokenByMint('unknownmint1111111111111111111111111111111')).toBeUndefined();
  });

  it('tokenBySymbol returns the correct token config', () => {
    process.env.WALLET_PRIVATE_KEY = 'mock-private-key-base58';
    process.env.HELIUS_RPC_URL     = 'https://rpc.helius.xyz/?api-key=test';

    const { tokenBySymbol } = require('../src/config') as typeof import('../src/config');

    const token = tokenBySymbol('BONK');
    expect(token?.mint).toBe('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
  });

  it('tokenBySymbol returns undefined for an unknown symbol', () => {
    process.env.WALLET_PRIVATE_KEY = 'mock-private-key-base58';
    process.env.HELIUS_RPC_URL     = 'https://rpc.helius.xyz/?api-key=test';

    const { tokenBySymbol } = require('../src/config') as typeof import('../src/config');

    expect(tokenBySymbol('UNKNOWN')).toBeUndefined();
  });
});
