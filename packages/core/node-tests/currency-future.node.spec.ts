import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeSqlJsAdapter, ServiceManager, asMilli } from '../src';

function iso(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

async function setup() {
  const adapter = await NodeSqlJsAdapter.create();
  const manager = new ServiceManager();
  await manager.initialize(adapter);
  const services = manager.getServices();
  const budgetId = await services.budgets.createBudget({
    name: 'Review',
    display_currency: 'USD',
    badge_icon: 'dollar',
    number_format: '123,456.78',
    create_default_categories: true,
  });
  const account = await services.accounts.createAccount(
    'Foreign',
    budgetId,
    'checking',
    'EUR',
    0,
    {},
    true
  );
  const groupId = services.categories.addCategoryGroup('Bills', budgetId);
  const categoryId = services.categories.addCategory(groupId, budgetId, 'Bill');
  return { adapter, services, budgetId, account, categoryId };
}

afterEach(() => vi.unstubAllGlobals());

describe('Future transaction exchange rates', () => {
  it('uses the successfully fetched rate for a one-off transaction 30 days ahead', async () => {
    const { adapter, services, budgetId, account, categoryId } = await setup();
    const today = new Date();
    const future = new Date(today);
    future.setDate(future.getDate() + 30);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ date: iso(today), quotes: { EURUSD: 1.25 } }),
      })
    );
    const id = await services.transactions.addTransaction(
      asMilli(0),
      asMilli(100_000),
      account.ID,
      categoryId,
      budgetId,
      iso(future),
      'Future bill'
    );
    const query = adapter.prepare(
      'SELECT OutflowConverted, ConversionPending FROM transactions WHERE ID = ?'
    );
    const result = query.get(id);
    query.finalize();
    expect(result).toEqual({ OutflowConverted: 125_000, ConversionPending: 0 });
  });

  it('ignores legacy future-dated cache rows and reuses today’s rate', async () => {
    const { services, budgetId } = await setup();
    const today = new Date();
    const future = new Date(today);
    future.setDate(future.getDate() + 30);
    services.currency.saveRate('EUR', 'USD', 1.25, iso(today), budgetId);
    services.currency.saveRate('EUR', 'USD', 0.5, iso(future), budgetId);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await services.currency.getOrFetchRate('EUR', 'USD', iso(future), budgetId)).toBe(1.25);
    expect(services.currency.getLocalRate('EUR', 'USD', iso(future), budgetId)).toBe(1.25);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still uses a custom rate that starts on the future payment date', async () => {
    const { services, budgetId } = await setup();
    const today = new Date();
    const future = new Date(today);
    future.setDate(future.getDate() + 30);
    services.currency.saveRate('EUR', 'USD', 1.25, iso(today), budgetId);
    await services.currency.addCustomRate('EUR', 'USD', 1.5, iso(future), null, budgetId);
    expect(await services.currency.resolveRate('EUR', 'USD', iso(future), budgetId)).toBe(1.5);
  });
});
