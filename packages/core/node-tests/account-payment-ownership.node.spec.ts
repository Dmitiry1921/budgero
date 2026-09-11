import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeSqlJsAdapter, ServiceManager, ZERO_MILLI, type Account } from '../src/index.js';
import { CurrencyService } from '../src/services/currency/index.js';

const adapters: NodeSqlJsAdapter[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const adapter of adapters.splice(0)) adapter.close();
});

async function setup() {
  const adapter = await NodeSqlJsAdapter.create();
  adapters.push(adapter);
  const manager = new ServiceManager();
  await manager.initialize(adapter);
  const services = manager.getServices();
  const newBudget = () =>
    services.budgets.createBudget({
      name: 'Payment category ownership',
      display_currency: 'USD',
      badge_icon: 'dollar',
      number_format: '123,456.78',
      create_default_categories: false,
    });
  const budgetId = await newBudget();
  const { accounts, categories } = services;
  const paymentId = (account: Account) =>
    (JSON.parse(accounts.getAccount(account.ID).Metadata || '{}') as Record<string, number>)
      .cc_payment_category_id;
  const createCard = (metadata?: Record<string, unknown>) =>
    accounts.createAccount('Visa', budgetId, 'Credit', 'USD', ZERO_MILLI, metadata);
  const createCategory = (name = 'Visa', groupName = 'Credit Card Payments', budget = budgetId) => {
    const groupId =
      categories.getCategoryGroupByName(groupName, budget)?.ID ||
      categories.addCategoryGroup(groupName, budget);
    return categories.addCategory(groupId, budget, name, '');
  };
  const snapshot = () =>
    Object.fromEntries(
      ['accounts', 'categories', 'category_groups', 'assignments', 'transactions'].map((table) => [
        table,
        adapter.prepare(`SELECT * FROM ${table} ORDER BY ID`).all(),
      ])
    );
  return {
    adapter,
    accounts,
    categories,
    budgetId,
    newBudget,
    paymentId,
    createCard,
    createCategory,
    snapshot,
  };
}

describe('credit card payment category ownership', () => {
  it('gives same-named cards separate payment categories', async () => {
    const { createCard, paymentId, categories, budgetId } = await setup();
    const first = await createCard();
    const second = await createCard();
    expect(paymentId(second)).not.toBe(paymentId(first));
    expect(
      categories.getAllCategories(budgetId).filter((category) => category.Name === 'Visa')
    ).toHaveLength(2);
  });

  it('uses an explicit unclaimed payment category even when its name differs', async () => {
    const { createCard, createCategory, paymentId, accounts } = await setup();
    const categoryId = createCategory('Imported source envelope');
    const account = await createCard({ cc_payment_category_id: categoryId });
    expect(paymentId(account)).toBe(categoryId);
    await accounts.updateAccount(account.ID, '', 'Checking', 'USD');
    await accounts.updateAccount(account.ID, '', 'Credit', 'USD', {
      cc_payment_category_id: categoryId,
    });
    expect(paymentId(account)).toBe(categoryId);
  });

  it('preserves source and native payment identities when account edits rebuild metadata', async () => {
    const { createCard, createCategory, paymentId, accounts } = await setup();
    const categoryId = createCategory();
    const account = await createCard({
      cc_payment_category_id: categoryId,
      ynab_account_id: 'source-card',
      ynab_credit_payment_category_id: 'source-payment-category',
    });
    await accounts.updateAccount(account.ID, 'Renamed card', 'Credit', 'USD', {
      liability: true,
      note: 'Updated account details',
    });
    expect(accounts.getAccount(account.ID).Name).toBe('Renamed card');
    expect(paymentId(account)).toBe(categoryId);
    expect(JSON.parse(accounts.getAccount(account.ID).Metadata || '{}')).toMatchObject({
      cc_payment_category_id: categoryId,
      ynab_account_id: 'source-card',
      ynab_credit_payment_category_id: 'source-payment-category',
      liability: true,
      note: 'Updated account details',
    });
  });

  it('validates the explicit category’s own group when several payment groups share a name', async () => {
    const { createCard, createCategory, paymentId, categories, budgetId } = await setup();
    createCategory('First group');
    const otherGroup = categories.addCategoryGroup('Credit Card Payments', budgetId);
    const categoryId = categories.addCategory(otherGroup, budgetId, 'Second group', '');
    const account = await createCard({ cc_payment_category_id: categoryId });
    expect(paymentId(account)).toBe(categoryId);
  });

  it.each(['archived', 'another type'])(
    'reserves the category of an account that is %s',
    async (ownerState) => {
      const { createCard, paymentId, accounts, snapshot } = await setup();
      const owner = await createCard();
      if (ownerState === 'archived') accounts.setAccountArchived(owner.ID, true);
      else await accounts.updateAccount(owner.ID, '', 'Checking', 'USD');
      const before = snapshot();
      await expect(createCard({ cc_payment_category_id: paymentId(owner) })).rejects.toThrow(
        'already linked to another account'
      );
      expect(snapshot()).toEqual(before);
      const other = await createCard();
      expect(paymentId(other)).not.toBe(paymentId(owner));
    }
  );

  it.each(['missing', 'wrong group', 'another budget', 'null', 'string'])(
    'rejects an explicit %s category before creating anything',
    async (invalidKind) => {
      const { accounts, budgetId, createCategory, newBudget, snapshot } = await setup();
      let categoryId: unknown = 999999;
      if (invalidKind === 'wrong group') categoryId = createCategory('Visa', 'Expenses');
      if (invalidKind === 'another budget') {
        categoryId = createCategory('Visa', 'Credit Card Payments', await newBudget());
      }
      if (invalidKind === 'null') categoryId = null;
      if (invalidKind === 'string') categoryId = String(createCategory());
      const rate = vi.spyOn(CurrencyService.prototype, 'getOrFetchRate');
      const before = snapshot();
      await expect(
        accounts.createAccount('Visa', budgetId, 'Credit', 'EUR', -1000, {
          cc_payment_category_id: categoryId,
        })
      ).rejects.toThrow('must belong to this budget');
      expect(rate).not.toHaveBeenCalled();
      expect(snapshot()).toEqual(before);
    }
  );

  it.each(['claimed', 'wrong group'])(
    'rejects an explicit %s update before changing currency, name, or metadata',
    async (invalidKind) => {
      const { createCard, createCategory, paymentId, accounts, snapshot } = await setup();
      const account = await createCard();
      const owner = await createCard();
      const target =
        invalidKind === 'claimed' ? paymentId(owner) : createCategory('Other', 'Expenses');
      const convert = vi.spyOn(CurrencyService.prototype, 'handleAccountCurrencyChange');
      const before = snapshot();
      await expect(
        accounts.updateAccount(account.ID, 'Changed', 'Checking', 'EUR', {
          cc_payment_category_id: target,
        })
      ).rejects.toThrow('Credit card payment category');
      expect(convert).not.toHaveBeenCalled();
      expect(snapshot()).toEqual(before);
    }
  );

  it('skips claimed categories when a same-named account becomes a card', async () => {
    const { accounts, budgetId, createCard, paymentId } = await setup();
    const owner = await createCard();
    const other = await accounts.createAccount('Visa', budgetId, 'Checking', 'USD', ZERO_MILLI);
    await accounts.updateAccount(other.ID, '', 'Credit', 'USD');
    expect(paymentId(other)).not.toBe(paymentId(owner));
  });

  it('skips claimed categories when repairing a missing link on unarchive', async () => {
    const { adapter, accounts, createCard, paymentId } = await setup();
    const owner = await createCard();
    const other = await createCard();
    const otherCategoryId = paymentId(other);
    accounts.setAccountArchived(other.ID, true);
    adapter.prepare('DELETE FROM categories WHERE ID = ?').run(otherCategoryId);
    accounts.setAccountArchived(other.ID, false);
    expect(paymentId(other)).not.toBe(paymentId(owner));
    expect(paymentId(other)).not.toBe(otherCategoryId);
  });

  it('reattaches only an unclaimed candidate when repairing a missing link', async () => {
    const { adapter, accounts, createCard, createCategory, paymentId } = await setup();
    const owner = await createCard();
    const other = await createCard();
    accounts.setAccountArchived(other.ID, true);
    adapter.prepare('DELETE FROM categories WHERE ID = ?').run(paymentId(other));
    const unclaimed = createCategory();
    accounts.setAccountArchived(other.ID, false);
    expect(paymentId(other)).toBe(unclaimed);
    expect(paymentId(owner)).not.toBe(unclaimed);
  });

  it('preserves a funded legacy shared category during reads, rename, and unarchive', async () => {
    const { adapter, accounts, categories, budgetId, createCard, paymentId } = await setup();
    const owner = await createCard();
    const other = await createCard();
    const sharedId = paymentId(owner);
    adapter
      .prepare('UPDATE accounts SET Metadata = ? WHERE ID = ?')
      .run(JSON.stringify({ cc_payment_category_id: sharedId }), other.ID);
    adapter
      .prepare('INSERT INTO assignments (CategoryID, Amount, Month, BudgetID) VALUES (?, ?, ?, ?)')
      .run(sharedId, 25000, '2026-09', budgetId);
    const categoryCount = categories.getAllCategories(budgetId).length;

    accounts.getAccount(other.ID);
    accounts.listAccounts(budgetId);
    accounts.setAccountArchived(other.ID, true);
    accounts.setAccountArchived(other.ID, false);
    await accounts.updateAccount(other.ID, 'Renamed card', 'Credit', 'USD', {
      note: 'Keep funding',
    });

    expect(paymentId(other)).toBe(sharedId);
    expect(categories.getAllCategories(budgetId)).toHaveLength(categoryCount);
    expect(
      categories.getAllCategories(budgetId).find((category) => category.ID === sharedId)?.Name
    ).toBe('Visa');
    expect(
      adapter.prepare('SELECT Amount FROM assignments WHERE CategoryID = ?').get(sharedId)
    ).toEqual({ Amount: 25000 });
  });

  it.each(['shared link', 'missing link'])(
    'does not delete another archived account’s category when deleting a card with a %s',
    async (linkKind) => {
      const { adapter, accounts, categories, budgetId, createCard, paymentId } = await setup();
      const owner = await createCard();
      const other = await createCard();
      const sharedId = paymentId(owner);
      accounts.setAccountArchived(owner.ID, true);
      adapter
        .prepare('UPDATE accounts SET Metadata = ? WHERE ID = ?')
        .run(
          JSON.stringify(linkKind === 'shared link' ? { cc_payment_category_id: sharedId } : {}),
          other.ID
        );
      adapter
        .prepare(
          'INSERT INTO assignments (CategoryID, Amount, Month, BudgetID) VALUES (?, ?, ?, ?)'
        )
        .run(sharedId, 25000, '2026-09', budgetId);
      accounts.deleteAccount(other.ID);
      expect(paymentId(owner)).toBe(sharedId);
      expect(
        categories.getAllCategories(budgetId).some((category) => category.ID === sharedId)
      ).toBe(true);
      expect(
        adapter.prepare('SELECT Amount FROM assignments WHERE CategoryID = ?').get(sharedId)
      ).toEqual({ Amount: 25000 });
    }
  );

  it('does not search for a different category to delete when its explicit link is shared', async () => {
    const { adapter, accounts, categories, budgetId, createCard, createCategory, paymentId } =
      await setup();
    const owner = await createCard();
    const sharedId = paymentId(owner);
    accounts.setAccountArchived(owner.ID, true);
    categories.updateCategoryName(sharedId, 'Shared envelope');
    const other = await createCard();
    const unclaimed = createCategory();
    adapter
      .prepare('UPDATE accounts SET Metadata = ? WHERE ID = ?')
      .run(JSON.stringify({ cc_payment_category_id: sharedId }), other.ID);
    const before = categories.getAllCategories(budgetId);
    accounts.deleteAccount(other.ID);
    const categoryIds = categories.getAllCategories(budgetId).map((category) => category.ID);
    expect(categoryIds).toContain(sharedId);
    expect(categoryIds).toContain(unclaimed);
    expect(categories.getAllCategories(budgetId)).toEqual(before);
  });
});
