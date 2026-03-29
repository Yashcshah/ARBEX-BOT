import { isPriceEntry, isArbOpportunity } from '../src/types';

// ─── isPriceEntry ─────────────────────────────────────────────────────────────

describe('isPriceEntry', () => {
  it('returns true for a valid PriceEntry object', () => {
    const entry = { price: 150.5, liquidity: 1_000_000, timestamp: Date.now() };
    expect(isPriceEntry(entry)).toBe(true);
  });

  it('returns false for null', () => {
    expect(isPriceEntry(null)).toBe(false);
  });

  it('returns false for a non-object (string)', () => {
    expect(isPriceEntry('not an object')).toBe(false);
  });

  it('returns false when price field is missing', () => {
    const entry = { liquidity: 1_000_000, timestamp: Date.now() };
    expect(isPriceEntry(entry)).toBe(false);
  });

  it('returns false when liquidity field is missing', () => {
    const entry = { price: 150.5, timestamp: Date.now() };
    expect(isPriceEntry(entry)).toBe(false);
  });

  it('returns false when timestamp field is missing', () => {
    const entry = { price: 150.5, liquidity: 1_000_000 };
    expect(isPriceEntry(entry)).toBe(false);
  });

  it('returns false when price is a string instead of a number', () => {
    const entry = { price: '150.5', liquidity: 1_000_000, timestamp: Date.now() };
    expect(isPriceEntry(entry)).toBe(false);
  });

  it('returns false when liquidity is null instead of a number', () => {
    const entry = { price: 150.5, liquidity: null, timestamp: Date.now() };
    expect(isPriceEntry(entry)).toBe(false);
  });

  it('returns false for an empty object', () => {
    expect(isPriceEntry({})).toBe(false);
  });

  it('returns true when extra fields are present alongside required ones', () => {
    const entry = {
      price: 0.001,
      liquidity: 500,
      timestamp: 1_700_000_000_000,
      extraField: 'ignored',
    };
    expect(isPriceEntry(entry)).toBe(true);
  });
});

// ─── isArbOpportunity ─────────────────────────────────────────────────────────

describe('isArbOpportunity', () => {
  const validOpp = {
    token: 'So11111111111111111111111111111111111111112',
    tokenSymbol: 'SOL',
    buyDex: 'Jupiter',
    sellDex: 'Orca',
    buyPrice: 149.5,
    sellPrice: 151.0,
    spreadPct: 1.003,
    netProfitUsd: 2.50,
    tradeSizeUsd: 50,
    buyRawQuote: { raw: true },
    sellRawQuote: { raw: true },
  };

  it('returns true for a complete valid ArbOpportunity', () => {
    expect(isArbOpportunity(validOpp)).toBe(true);
  });

  it('returns false for null', () => {
    expect(isArbOpportunity(null)).toBe(false);
  });

  it('returns false for a non-object (number)', () => {
    expect(isArbOpportunity(42)).toBe(false);
  });

  it('returns false when token field is missing', () => {
    const { token: _omit, ...rest } = validOpp;
    expect(isArbOpportunity(rest)).toBe(false);
  });

  it('returns false when buyDex field is missing', () => {
    const { buyDex: _omit, ...rest } = validOpp;
    expect(isArbOpportunity(rest)).toBe(false);
  });

  it('returns false when sellDex field is missing', () => {
    const { sellDex: _omit, ...rest } = validOpp;
    expect(isArbOpportunity(rest)).toBe(false);
  });

  it('returns false when buyPrice field is missing', () => {
    const { buyPrice: _omit, ...rest } = validOpp;
    expect(isArbOpportunity(rest)).toBe(false);
  });

  it('returns false when sellPrice field is missing', () => {
    const { sellPrice: _omit, ...rest } = validOpp;
    expect(isArbOpportunity(rest)).toBe(false);
  });

  it('returns false when spreadPct field is missing', () => {
    const { spreadPct: _omit, ...rest } = validOpp;
    expect(isArbOpportunity(rest)).toBe(false);
  });

  it('returns false when netProfitUsd field is missing', () => {
    const { netProfitUsd: _omit, ...rest } = validOpp;
    expect(isArbOpportunity(rest)).toBe(false);
  });

  it('returns false when tradeSizeUsd field is missing', () => {
    const { tradeSizeUsd: _omit, ...rest } = validOpp;
    expect(isArbOpportunity(rest)).toBe(false);
  });

  it('returns false when token is a number instead of a string', () => {
    const opp = { ...validOpp, token: 12345 };
    expect(isArbOpportunity(opp)).toBe(false);
  });

  it('returns false when buyPrice is a string instead of a number', () => {
    const opp = { ...validOpp, buyPrice: '149.5' };
    expect(isArbOpportunity(opp)).toBe(false);
  });

  it('returns false for an empty object', () => {
    expect(isArbOpportunity({})).toBe(false);
  });

  it('returns true even when optional raw-quote fields are absent', () => {
    // buyRawQuote / sellRawQuote are not checked by the guard
    const { buyRawQuote: _b, sellRawQuote: _s, ...rest } = validOpp;
    expect(isArbOpportunity(rest)).toBe(true);
  });
});
