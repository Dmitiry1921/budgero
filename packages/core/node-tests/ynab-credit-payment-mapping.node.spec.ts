import { describe, expect, it, vi } from 'vitest';
import {
  AccountService,
  BudgetService,
  MonthlyBudgetService,
  NodeSqlJsAdapter,
  TransactionService,
  YNABImportService,
  type YNABApiPlanSnapshot,
  type YNABImportConfig,
} from '../src/index.js';

type Plan = YNABApiPlanSnapshot['plan'];

function category(id: string, groupId: string, name: string, budgeted: number) {
  return {
    id,
    category_group_id: groupId,
    name,
    hidden: false,
    deleted: false,
    internal: groupId !== 'everyday',
    budgeted,
    activity: 0,
    balance: budgeted,
  };
}

function account(id: string, name: string, closed = false): Plan['accounts'][number] {
  return {
    id,
    name,
    type: 'creditCard',
    on_budget: true,
    closed,
    deleted: false,
    balance: 0,
    transfer_payee_id: `transfer-${id}`,
    note: `Identifying note for ${id}`,
  };
}

/** Synthetic: $1,000 cash, $100 groceries, and $20/$30 set aside for two cards. */
function fixture(): YNABApiPlanSnapshot {
  const categories = [
    category('income', 'internal', 'Ready to Assign', 0),
    category('groceries', 'everyday', 'Groceries', 100_000),
    category('payment-first', 'payments', 'Everyday card', 20_000),
    category('payment-second', 'payments', 'Everyday card', 30_000),
  ];
  return {
    serverKnowledge: 17,
    plan: {
      id: 'synthetic-duplicate-card-plan',
      name: 'Synthetic duplicate card plan',
      first_month: '2026-09-01',
      last_month: '2026-09-01',
      currency_format: {
        iso_code: 'USD',
        example_format: '123,456.78',
        decimal_digits: 2,
        decimal_separator: '.',
        symbol_first: true,
        group_separator: ',',
        currency_symbol: '$',
        display_symbol: true,
      },
      accounts: [
        { ...account('checking', 'Checking'), type: 'checking', balance: 1_000_000 },
        account('card-first', 'Everyday card'),
        account('card-second', 'Everyday card'),
      ],
      category_groups: [
        { id: 'internal', name: 'Internal Master Category', internal: true },
        { id: 'everyday', name: 'Everyday', internal: false },
        { id: 'payments', name: 'Credit Card Payments', internal: true },
      ].map((group) => ({ ...group, hidden: false, deleted: false })),
      categories,
      months: [
        {
          month: '2026-09-01',
          deleted: false,
          budgeted: 150_000,
          activity: 0,
          income: 1_000_000,
          to_be_budgeted: 850_000,
          categories: categories.map((item) => ({ ...item })),
        },
      ],
      payees: [
        { id: 'starting', name: 'Starting Balance', transfer_account_id: null, deleted: false },
      ],
      transactions: [
        {
          id: 'opening-checking',
          account_id: 'checking',
          date: '2026-09-01',
          amount: 1_000_000,
          memo: null,
          cleared: 'cleared',
          approved: true,
          payee_id: 'starting',
          category_id: 'income',
          transfer_account_id: null,
          transfer_transaction_id: null,
          deleted: false,
        },
      ],
      subtransactions: [],
    },
  };
}

function config(
  snapshot: YNABApiPlanSnapshot,
  byAccountId: Record<string, string> = {
    'card-first': 'payment-first',
    'card-second': 'payment-second',
  }
): YNABImportConfig {
  return {
    spaceId: 'synthetic-card-mapping-space',
    budgetName: snapshot.plan.name,
    currency: 'USD',
    numberFormat: '123,456.78',
    badgeIcon: 'HelpCircle',
    creditPaymentMappings: {
      planId: snapshot.plan.id,
      serverKnowledge: snapshot.serverKnowledge,
      byAccountId,
    },
  };
}

function importedAccount(adapter: NodeSqlJsAdapter, budgetId: number, sourceId: string) {
  const row = adapter
    .prepare('SELECT ID, Metadata, Archived FROM accounts WHERE BudgetID = ?')
    .all(budgetId)
    .map((value) => value as { ID: number; Metadata: string; Archived: number })
    .find((value) => JSON.parse(value.Metadata).ynab_account_id === sourceId);
  expect(row, `source account ${sourceId} was imported`).toBeDefined();
  return {
    ...row!,
    paymentCategoryId: JSON.parse(row!.Metadata).cc_payment_category_id as number,
    sourcePaymentCategoryId: JSON.parse(row!.Metadata).ynab_credit_payment_category_id as string,
  };
}

async function withDatabase(check: (adapter: NodeSqlJsAdapter) => Promise<void>) {
  const adapter = await NodeSqlJsAdapter.create();
  try {
    await check(adapter);
  } finally {
    adapter.close();
  }
}

describe('YNAB credit-card payment category matching', () => {
  it('asks for source-ID matches for equal-balance duplicate names, including a closed card and hidden envelope', () =>
    withDatabase(async (adapter) => {
      const snapshot = fixture();
      snapshot.plan.accounts[2].closed = true;
      snapshot.plan.categories[3].hidden = true;
      snapshot.plan.months[0].categories[3].hidden = true;
      const preview = YNABImportService.inspectYNABApiSnapshot(snapshot);
      expect(preview.creditPaymentMatching).toMatchObject({
        planId: snapshot.plan.id,
        serverKnowledge: snapshot.serverKnowledge,
        accounts: expect.arrayContaining([
          expect.objectContaining({ accountId: 'card-first', balance: 0, closed: false }),
          expect.objectContaining({ accountId: 'card-second', balance: 0, closed: true }),
        ]),
        categories: expect.arrayContaining([
          expect.objectContaining({
            categoryId: 'payment-first',
            assigned: 20_000,
            available: 20_000,
          }),
          expect.objectContaining({
            categoryId: 'payment-second',
            assigned: 30_000,
            available: 30_000,
          }),
        ]),
      });
      expect(preview.creditPaymentMatching?.accounts).toHaveLength(2);
      for (const card of preview.creditPaymentMatching!.accounts) {
        expect(new Set(card.candidateCategoryIds)).toEqual(
          new Set(['payment-first', 'payment-second'])
        );
        expect(card.note).toBe(`Identifying note for ${card.accountId}`);
      }
      expect(adapter.prepare('SELECT COUNT(*) AS count FROM budgets').get()).toEqual({ count: 0 });
    }));

  it('shows recent transactions from the exact source account despite identical card names', () => {
    const snapshot = fixture();
    snapshot.plan.payees.push(
      { id: 'shop-first', name: 'First shop', transfer_account_id: null, deleted: false },
      { id: 'shop-second', name: 'Second shop', transfer_account_id: null, deleted: false }
    );
    const source = snapshot.plan.transactions[0];
    snapshot.plan.transactions.push(
      {
        ...source,
        id: 'first-older',
        account_id: 'card-first',
        date: '2026-09-03',
        payee_id: 'shop-first',
        amount: -5_000,
      },
      {
        ...source,
        id: 'first-latest',
        account_id: 'card-first',
        date: '2026-09-05',
        payee_id: 'shop-first',
        amount: -10_000,
      },
      {
        ...source,
        id: 'first-deleted',
        account_id: 'card-first',
        date: '2026-09-06',
        payee_id: 'shop-second',
        deleted: true,
      },
      {
        ...source,
        id: 'second-latest',
        account_id: 'card-second',
        date: '2026-09-04',
        payee_id: 'shop-second',
        amount: -15_000,
      }
    );
    const matching = YNABImportService.inspectYNABApiSnapshot(snapshot).creditPaymentMatching!;
    expect(
      matching.accounts.find((item) => item.accountId === 'card-first')?.recentTransactions
    ).toEqual([
      { date: '2026-09-05', payee: 'First shop', amount: -10_000 },
      { date: '2026-09-03', payee: 'First shop', amount: -5_000 },
    ]);
    expect(
      matching.accounts.find((item) => item.accountId === 'card-second')?.recentTransactions
    ).toEqual([{ date: '2026-09-04', payee: 'Second shop', amount: -15_000 }]);
  });

  it.each([false, true])(
    'preserves selected category funding and later card operations when source arrays are shuffled=%s',
    (shuffled) =>
      withDatabase(async (adapter) => {
        const snapshot = fixture();
        if (shuffled) {
          snapshot.plan.accounts.reverse();
          snapshot.plan.categories.reverse();
          snapshot.plan.category_groups.reverse();
          snapshot.plan.months[0].categories.reverse();
        }
        const result = await new YNABImportService(adapter).importYNABFromApiSnapshotWithSummary(
          snapshot,
          config(snapshot, { 'card-first': 'payment-second', 'card-second': 'payment-first' })
        );
        expect(result.verification?.status).toBe('passed');
        const first = importedAccount(adapter, result.budgetId, 'card-first');
        const second = importedAccount(adapter, result.budgetId, 'card-second');
        const checking = importedAccount(adapter, result.budgetId, 'checking');
        expect(first.paymentCategoryId).not.toBe(second.paymentCategoryId);
        expect(first.sourcePaymentCategoryId).toBe('payment-second');
        expect(second.sourcePaymentCategoryId).toBe('payment-first');
        const monthly = new MonthlyBudgetService(adapter);
        const envelope = (categoryId: number) =>
          monthly
            .getMonthlyBudget('2026-09', result.budgetId)
            .find((row) => row.CategoryID === categoryId)!;
        expect(envelope(first.paymentCategoryId)).toMatchObject({
          Assigned: 30_000,
          Available: 30_000,
        });
        expect(envelope(second.paymentCategoryId)).toMatchObject({
          Assigned: 20_000,
          Available: 20_000,
        });
        const groceries = adapter
          .prepare('SELECT ID FROM categories WHERE BudgetID = ? AND Name = ?')
          .get(result.budgetId, 'Groceries') as { ID: number };
        const transfers = adapter
          .prepare('SELECT ID FROM categories WHERE BudgetID = ? AND Name = ?')
          .get(result.budgetId, 'Transfers') as { ID: number };
        const transactions = new TransactionService(adapter);

        await transactions.addTransaction(
          0,
          10_000,
          first.ID,
          groceries.ID,
          result.budgetId,
          '2026-09-10',
          '',
          '',
          'First card purchase'
        );
        expect(envelope(first.paymentCategoryId).Available).toBe(40_000);
        expect(envelope(second.paymentCategoryId).Available).toBe(20_000);
        await transactions.addTransaction(
          0,
          15_000,
          second.ID,
          groceries.ID,
          result.budgetId,
          '2026-09-11',
          '',
          '',
          'Second card purchase'
        );
        expect(envelope(first.paymentCategoryId).Available).toBe(40_000);
        expect(envelope(second.paymentCategoryId).Available).toBe(35_000);

        await transactions.addTransaction(
          0,
          5_000,
          checking.ID,
          transfers.ID,
          result.budgetId,
          '2026-09-12',
          '',
          'synthetic-first-card-payment'
        );
        await transactions.addTransaction(
          5_000,
          0,
          first.ID,
          transfers.ID,
          result.budgetId,
          '2026-09-12',
          '',
          'synthetic-first-card-payment'
        );
        expect(envelope(first.paymentCategoryId).Available).toBe(35_000);
        expect(envelope(second.paymentCategoryId).Available).toBe(35_000);

        const secondBeforeDelete = envelope(second.paymentCategoryId);
        const secondTransactions = adapter
          .prepare('SELECT * FROM transactions WHERE AccountID = ? ORDER BY ID')
          .all(second.ID);
        new AccountService(adapter).deleteAccount(first.ID);
        expect(importedAccount(adapter, result.budgetId, 'card-second').paymentCategoryId).toBe(
          second.paymentCategoryId
        );
        expect(envelope(second.paymentCategoryId)).toEqual(secondBeforeDelete);
        expect(
          adapter
            .prepare('SELECT * FROM transactions WHERE AccountID = ? ORDER BY ID')
            .all(second.ID)
        ).toEqual(secondTransactions);
        expect(
          adapter.prepare('SELECT ID FROM categories WHERE ID = ?').get(second.paymentCategoryId)
        ).toEqual({ ID: second.paymentCategoryId });
      })
  );

  it('imports an open and closed same-named card with separate selected categories', () =>
    withDatabase(async (adapter) => {
      const snapshot = fixture();
      snapshot.plan.accounts[2].closed = true;
      snapshot.plan.categories[3].hidden = true;
      snapshot.plan.months[0].categories[3].hidden = true;
      const result = await new YNABImportService(adapter).importYNABFromApiSnapshotWithSummary(
        snapshot,
        config(snapshot)
      );
      const first = importedAccount(adapter, result.budgetId, 'card-first');
      const second = importedAccount(adapter, result.budgetId, 'card-second');
      expect(first.Archived).toBe(0);
      expect(second.Archived).toBe(1);
      expect(first.paymentCategoryId).not.toBe(second.paymentCategoryId);
      expect(result.verification?.status).toBe('passed');
    }));

  it('keeps unique exact-name matches automatic', () =>
    withDatabase(async (adapter) => {
      const snapshot = fixture();
      snapshot.plan.accounts[2].name = 'Travel card';
      snapshot.plan.categories[3].name = 'Travel card';
      snapshot.plan.months[0].categories[3].name = 'Travel card';
      const service = new YNABImportService(adapter);
      expect(
        YNABImportService.inspectYNABApiSnapshot(snapshot).creditPaymentMatching
      ).toBeUndefined();
      const importConfig = config(snapshot);
      delete importConfig.creditPaymentMappings;
      const result = await service.importYNABFromApiSnapshotWithSummary(snapshot, importConfig);
      expect(importedAccount(adapter, result.budgetId, 'card-first').paymentCategoryId).not.toBe(
        importedAccount(adapter, result.budgetId, 'card-second').paymentCategoryId
      );
      expect(result.verification?.status).toBe('passed');
    }));

  it.each([
    [
      'missing choices',
      (value: YNABImportConfig) => {
        delete value.creditPaymentMappings;
      },
    ],
    [
      'missing second card',
      (value: YNABImportConfig) => {
        delete value.creditPaymentMappings!.byAccountId['card-second'];
      },
    ],
    [
      'reused category',
      (value: YNABImportConfig) => {
        value.creditPaymentMappings!.byAccountId['card-second'] = 'payment-first';
      },
    ],
    [
      'non-payment category',
      (value: YNABImportConfig) => {
        value.creditPaymentMappings!.byAccountId['card-first'] = 'groceries';
      },
    ],
    [
      'unknown account',
      (value: YNABImportConfig) => {
        value.creditPaymentMappings!.byAccountId.unknown = 'payment-first';
      },
    ],
    [
      'another plan',
      (value: YNABImportConfig) => {
        value.creditPaymentMappings!.planId = 'another-plan';
      },
    ],
    [
      'old snapshot',
      (value: YNABImportConfig) => {
        value.creditPaymentMappings!.serverKnowledge--;
      },
    ],
  ] as const)('rejects %s before creating any budget', (_name, mutate) =>
    withDatabase(async (adapter) => {
      const snapshot = fixture();
      const importConfig = config(snapshot);
      mutate(importConfig);
      const createBudget = vi.spyOn(BudgetService.prototype, 'createBudget');
      try {
        await expect(
          new YNABImportService(adapter).importYNABFromApiSnapshotWithSummary(
            snapshot,
            importConfig
          )
        ).rejects.toThrow();
        expect(createBudget).not.toHaveBeenCalled();
        expect(adapter.prepare('SELECT COUNT(*) AS count FROM budgets').get()).toEqual({
          count: 0,
        });
      } finally {
        createBudget.mockRestore();
      }
    })
  );

  it('excludes automatically owned categories from choices and refuses their reuse', () =>
    withDatabase(async (adapter) => {
      const snapshot = fixture();
      snapshot.plan.accounts.push(account('card-third', 'Travel card'));
      const thirdPayment = category('payment-third', 'payments', 'Travel card', 0);
      snapshot.plan.categories.push(thirdPayment);
      snapshot.plan.months[0].categories.push({ ...thirdPayment });
      const service = new YNABImportService(adapter);
      const matching = YNABImportService.inspectYNABApiSnapshot(snapshot).creditPaymentMatching!;
      expect(matching.accounts.map((item) => item.accountId).sort()).toEqual([
        'card-first',
        'card-second',
      ]);
      expect(matching.categories.map((item) => item.categoryId)).not.toContain('payment-third');
      expect(
        matching.accounts.every((item) => !item.candidateCategoryIds.includes('payment-third'))
      ).toBe(true);
      const createBudget = vi.spyOn(BudgetService.prototype, 'createBudget');
      try {
        await expect(
          service.importYNABFromApiSnapshotWithSummary(
            snapshot,
            config(snapshot, { 'card-first': 'payment-third', 'card-second': 'payment-second' })
          )
        ).rejects.toThrow();
        expect(createBudget).not.toHaveBeenCalled();
      } finally {
        createBudget.mockRestore();
      }
    }));
});
