import { describe, it, expect, vi } from 'vitest';
import {
  NodeSqlJsAdapter,
  ServiceManager,
  DatabaseAdapter,
  ValidationError,
  asMilli,
  convertScaled,
} from '../src';

describe('safe exchange-rate conversion', () => {
  it('rejects a conversion that cannot remain an exact integer', () => {
    expect(() => convertScaled(25_000, 1_500_386_752_667_713, 'EUR', 'USD')).toThrow(
      ValidationError
    );
    expect(() => convertScaled(25_000, 1_500_386_752_667_713, 'EUR', 'USD')).toThrow(
      'Check the decimal point'
    );
  });

  it('accepts the precise intended fractional rate', () => {
    expect(convertScaled(25_000, 0.01500386752667713, 'EUR', 'USD')).toBe(375);
  });
});

describe('CurrencyService', () => {
  it('uses reciprocal local and manual rates; convertAmount falls back to manual', async () => {
    const adapter = await NodeSqlJsAdapter.create();
    const sm = new ServiceManager();
    await sm.initialize(adapter as DatabaseAdapter);
    const { budgets, currency } = sm.getServices();

    const bId = await budgets.createBudget({
      name: 'C',
      display_currency: 'USD',
      badge_icon: 'dollar',
      number_format: '123,456.78',
      create_default_categories: true,
    });

    const month = '2024-01-15';

    // Save direct rate USD->EUR and test reciprocal via getLocalRate
    await currency.saveRate('USD', 'EUR', 0.8, month, bId);
    const eurusd = await currency.getLocalRate('EUR', 'USD', month, bId);
    expect(eurusd).toBeCloseTo(1 / 0.8, 6);

    // Manual reciprocal retrieval
    await currency.saveManualRate('EUR', 'USD', 1.5, bId);
    const usdeurManual = await currency.getManualRate('USD', 'EUR', bId);
    expect(usdeurManual).toBeCloseTo(1 / 1.5, 6);

    // convertAmount prefers getOrFetchRate; mock it to return null so manual is used
    const spy = vi.spyOn(currency, 'getOrFetchRate').mockResolvedValue(null);
    const conv = await currency.convertAmount(10, 'EUR', 'USD', month, bId);
    expect(conv).toBeCloseTo(15, 6);
    spy.mockRestore();
  });
});

describe('CurrencyService custom date-range rates', () => {
  it('derives the reverse direction automatically (EUR→RON answers RON→EUR)', async () => {
    const adapter = await NodeSqlJsAdapter.create();
    const sm = new ServiceManager();
    await sm.initialize(adapter as DatabaseAdapter);
    const { budgets, currency } = sm.getServices();

    const bId = await budgets.createBudget({
      name: 'CR',
      display_currency: 'RON',
      badge_icon: 'dollar',
      number_format: '123,456.78',
      create_default_categories: true,
    });

    await currency.addCustomRate('EUR', 'RON', 5.2374, '2026-07-01', '2026-07-31', bId);

    // Direct direction.
    expect(currency.getCustomRate('EUR', 'RON', '2026-07-06', bId)).toBeCloseTo(5.2374, 6);
    // Reverse direction is derived — users never need to enter it.
    expect(currency.getCustomRate('RON', 'EUR', '2026-07-06', bId)).toBeCloseTo(1 / 5.2374, 6);
    // Outside the date range: no custom rate either way.
    expect(currency.getCustomRate('RON', 'EUR', '2026-08-02', bId)).toBeNull();

    // The full resolution chain (what transaction conversion uses) agrees.
    const resolved = await currency.resolveRate('RON', 'EUR', '2026-07-06', bId);
    expect(resolved).toBeCloseTo(1 / 5.2374, 6);
  });
});

describe('Transaction exchange-rate overrides', () => {
  it('pins the rate while creating an exact received transfer amount', async () => {
    const adapter = await NodeSqlJsAdapter.create();
    const sm = new ServiceManager();
    await sm.initialize(adapter as DatabaseAdapter);
    const { budgets, accounts, categories, transactions } = sm.getServices();

    const budgetId = await budgets.createBudget({
      name: 'Transfer',
      display_currency: 'USD',
      badge_icon: 'dollar',
      number_format: '123,456.78',
      create_default_categories: true,
    });
    const eur = await accounts.createAccount('EUR', budgetId, 'checking', 'EUR', 0);
    const transferCategory = categories
      .getAllCategories(budgetId)
      .find((category) => category.Name === 'Transfers');
    if (!transferCategory) throw new Error('Transfers category missing');

    const rate = 1_000 / 900;
    const transactionId = await transactions.addTransaction(
      900_000,
      0,
      eur.ID,
      transferCategory.ID,
      budgetId,
      '2026-08-20',
      'Exact transfer',
      'transfer-1',
      '',
      null,
      rate
    );

    const transaction = transactions.getTransactionByID(transactionId);
    expect(transaction.InflowNative).toBe(900_000);
    expect(transaction.InflowConverted).toBe(1_000_000);
    expect(transaction.ExchangeRate).toBeCloseTo(rate, 10);
    expect(transaction.ExchangeRateOverride).toBeTruthy();
    expect(transaction.ConversionPending).toBeFalsy();
  });

  it('leaves the transaction unchanged when an edited rate would overflow', async () => {
    const adapter = await NodeSqlJsAdapter.create();
    const sm = new ServiceManager();
    await sm.initialize(adapter as DatabaseAdapter);
    const { budgets, accounts, categories, transactions } = sm.getServices();

    const budgetId = await budgets.createBudget({
      name: 'Safe rates',
      display_currency: 'USD',
      badge_icon: 'dollar',
      number_format: '123,456.78',
      create_default_categories: true,
    });
    const eur = await accounts.createAccount('EUR', budgetId, 'checking', 'EUR', asMilli(0));
    const category = categories
      .getAllCategories(budgetId)
      .find((candidate) => candidate.Name !== 'Income');
    if (!category) throw new Error('category missing');

    const transactionId = await transactions.addTransaction(
      asMilli(25_000),
      asMilli(0),
      eur.ID,
      category.ID,
      budgetId,
      '2026-09-02',
      'Precise conversion',
      undefined,
      undefined,
      undefined,
      1
    );
    const before = transactions.getTransactionByID(transactionId);

    await expect(
      transactions.updateTransactionColumn(transactionId, 'ExchangeRate', 1_500_386_752_667_713)
    ).rejects.toThrow('Check the decimal point');

    const after = transactions.getTransactionByID(transactionId);
    expect(after.ExchangeRate).toBe(before.ExchangeRate);
    expect(after.InflowConverted).toBe(before.InflowConverted);
    expect(after.OutflowConverted).toBe(before.OutflowConverted);
  });
});

describe('CurrencyService addCustomRate alsoReverse', () => {
  it('stores both directions as explicit rows when requested', async () => {
    const adapter = await NodeSqlJsAdapter.create();
    const sm = new ServiceManager();
    await sm.initialize(adapter as DatabaseAdapter);
    const { budgets, currency } = sm.getServices();

    const bId = await budgets.createBudget({
      name: 'CR2',
      display_currency: 'RON',
      badge_icon: 'dollar',
      number_format: '123,456.78',
      create_default_categories: true,
    });

    const result = await currency.addCustomRate(
      'EUR',
      'RON',
      5.2374,
      '2026-07-01',
      null,
      bId,
      true
    );
    expect(result.reverseId).not.toBeNull();

    const rows = currency.getCustomRatesForBudget(bId);
    expect(rows).toHaveLength(2);
    const reverse = rows.find((row) => row.FromCurrency === 'RON');
    expect(reverse?.ToCurrency).toBe('EUR');
    expect(reverse?.Rate).toBeCloseTo(1 / 5.2374, 8);
  });
});

describe('CurrencyService daily rates', () => {
  it('reuses a fetched historical rate instead of pruning and refetching it', async () => {
    const adapter = await NodeSqlJsAdapter.create();
    const sm = new ServiceManager();
    await sm.initialize(adapter as DatabaseAdapter);
    const { budgets, currency } = sm.getServices();

    const bId = await budgets.createBudget({
      name: 'Historical',
      display_currency: 'USD',
      badge_icon: 'dollar',
      number_format: '123,456.78',
      create_default_categories: true,
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ quotes: { EURUSD: 1.2 } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const date = '2020-03-17';
      expect(await currency.getOrFetchRate('EUR', 'USD', date, bId)).toBeCloseTo(1.2, 6);
      expect(await currency.getOrFetchRate('EUR', 'USD', date, bId)).toBeCloseTo(1.2, 6);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("marks the official-rate refresh request when replacing today's cached rate", async () => {
    const adapter = await NodeSqlJsAdapter.create();
    const sm = new ServiceManager();
    await sm.initialize(adapter as DatabaseAdapter);
    const { budgets, currency, accounts } = sm.getServices();

    const bId = await budgets.createBudget({
      name: 'Refresh',
      display_currency: 'USD',
      badge_icon: 'dollar',
      number_format: '123,456.78',
      create_default_categories: true,
    });
    await accounts.createAccount('EUR account', bId, 'checking', 'EUR', 0);

    const today = new Date();
    const todayDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    await currency.saveRate('EUR', 'USD', 1.1, todayDate, bId);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ quotes: { USDEUR: 0.8 } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      await currency.restoreOfficialRates(bId);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[0]).toContain('refresh=true');
      expect(currency.getLocalRate('EUR', 'USD', todayDate, bId)).toBeCloseTo(1.25, 6);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('stores a clamped current-day response under the response date, not a future date', async () => {
    const adapter = await NodeSqlJsAdapter.create();
    const sm = new ServiceManager();
    await sm.initialize(adapter as DatabaseAdapter);
    const { budgets, currency } = sm.getServices();

    const bId = await budgets.createBudget({
      name: 'Future rate request',
      display_currency: 'USD',
      badge_icon: 'dollar',
      number_format: '123,456.78',
      create_default_categories: true,
    });
    const today = new Date();
    const todayDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowDate = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ date: todayDate, quotes: { EURUSD: 1.25 } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      await expect(currency.getOrFetchRate('EUR', 'USD', tomorrowDate, bId)).resolves.toBeCloseTo(
        1.25,
        6
      );
      expect(currency.getLocalRate('EUR', 'USD', tomorrowDate, bId)).toBeCloseTo(1.25, 6);
      const futureRate = adapter.prepare(
        'SELECT COUNT(*) AS Count FROM currency_rates WHERE BudgetID = ? AND RateDate = ?'
      );
      expect(futureRate.get(bId, tomorrowDate)).toEqual({ Count: 0 });
      futureRate.finalize();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('serves cached rates within the 7-day fallback window, not beyond', async () => {
    const adapter = await NodeSqlJsAdapter.create();
    const sm = new ServiceManager();
    await sm.initialize(adapter as DatabaseAdapter);
    const { budgets, currency } = sm.getServices();

    const bId = await budgets.createBudget({
      name: 'W',
      display_currency: 'USD',
      badge_icon: 'dollar',
      number_format: '123,456.78',
      create_default_categories: true,
    });

    await currency.saveRate('USD', 'EUR', 0.9, '2026-08-01', bId);

    // Within the window (5 days later) — nearest earlier rate applies.
    expect(await currency.getLocalRate('USD', 'EUR', '2026-08-06', bId)).toBeCloseTo(0.9, 6);
    // Reciprocal fallback works too.
    expect(await currency.getLocalRate('EUR', 'USD', '2026-08-06', bId)).toBeCloseTo(1 / 0.9, 6);
    // Beyond the window (8 days later) — no official rate.
    expect(await currency.getLocalRate('USD', 'EUR', '2026-08-09', bId)).toBeNull();
    // Earlier than the cached rate — never look forward.
    expect(await currency.getLocalRate('USD', 'EUR', '2026-07-31', bId)).toBeNull();
  });

  it('prunes cached rates older than the retention setting', async () => {
    const adapter = await NodeSqlJsAdapter.create();
    const sm = new ServiceManager();
    await sm.initialize(adapter as DatabaseAdapter);
    const { budgets, currency, userMeta } = sm.getServices();

    const bId = await budgets.createBudget({
      name: 'P',
      display_currency: 'USD',
      badge_icon: 'dollar',
      number_format: '123,456.78',
      create_default_categories: true,
    });

    expect(userMeta.getRateCacheRetentionDays()).toBe(30);

    const today = new Date();
    const daysAgo = (n: number): string => {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - n);
      const pad = (x: number) => String(x).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    };

    await currency.saveRate('USD', 'EUR', 0.9, daysAgo(5), bId);
    await currency.saveRate('USD', 'EUR', 0.89, daysAgo(45), bId);
    await currency.saveRate('USD', 'EUR', 0.88, daysAgo(120), bId);

    const pruned = currency.pruneRateCache(bId);
    expect(pruned).toBe(2);
    expect(await currency.getLocalRate('USD', 'EUR', daysAgo(5), bId)).toBeCloseTo(0.9, 6);

    // Wider retention keeps older rows.
    userMeta.setRateCacheRetentionDays(365);
    await currency.saveRate('USD', 'EUR', 0.87, daysAgo(120), bId);
    expect(currency.pruneRateCache(bId)).toBe(0);
    expect(userMeta.getRateCacheRetentionDays()).toBe(365);
  });

  it('resyncs pending conversions to official rates and leaves overrides alone', async () => {
    const adapter = await NodeSqlJsAdapter.create();
    const sm = new ServiceManager();
    await sm.initialize(adapter as DatabaseAdapter);
    const services = sm.getServices();
    const { budgets, currency, accounts, transactions, categories } = services;

    const bId = await budgets.createBudget({
      name: 'R',
      display_currency: 'USD',
      badge_icon: 'dollar',
      number_format: '123,456.78',
      create_default_categories: true,
    });
    const eur = await accounts.createAccount('EUR', bId, 'checking', 'EUR', 0);
    const cat = categories.getAllCategories(bId).find((c) => c.Name !== 'Income');
    if (!cat) throw new Error('category missing');

    // Offline: no official rate exists → 1:1 placeholder, marked pending.
    const txId = await transactions.addTransaction(0, 100, eur.ID, cat.ID, bId, '2026-08-03', 'x');
    let tx = transactions.getTransactionByID(txId);
    expect(tx.ConversionPending).toBeTruthy();
    expect(tx.OutflowConverted).toBe(100);

    // Back online: official rate lands in the cache; resync re-derives.
    await currency.saveRate('EUR', 'USD', 1.2, '2026-08-03', bId);
    const updated = await currency.resyncPendingConversions(bId);
    expect(updated).toBe(1);

    tx = transactions.getTransactionByID(txId);
    expect(tx.ConversionPending).toBeFalsy();
    expect(tx.OutflowConverted).toBe(120);
    expect(tx.ExchangeRate).toBeCloseTo(1.2, 6);

    // A second pass is a no-op.
    expect(await currency.resyncPendingConversions(bId)).toBe(0);
  });
});
