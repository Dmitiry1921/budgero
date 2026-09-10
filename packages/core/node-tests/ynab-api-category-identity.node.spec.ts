import { describe, expect, it } from 'vitest';
import {
  NodeSqlJsAdapter,
  YNABImportService,
  normalizeYNABApiSnapshot,
  type YNABApiPlanSnapshot,
} from '../src/index.js';

/** Entirely synthetic snapshot: $100 income, two envelopes and two purchases. */
function fixture(): YNABApiPlanSnapshot {
  const categories = [
    {
      id: 'income',
      category_group_id: 'internal',
      name: 'Ready to Assign',
      hidden: false,
      deleted: false,
      internal: true,
      budgeted: 0,
      activity: 0,
      balance: 0,
    },
    {
      id: 'first',
      category_group_id: 'first-group',
      name: 'First',
      hidden: false,
      deleted: false,
      internal: false,
      budgeted: 10_000,
      activity: -1_000,
      balance: 9_000,
    },
    {
      id: 'second',
      category_group_id: 'second-group',
      name: 'Second',
      hidden: false,
      deleted: false,
      internal: false,
      budgeted: 20_000,
      activity: -2_000,
      balance: 18_000,
    },
  ];
  return {
    serverKnowledge: 1,
    plan: {
      id: 'synthetic-category-identity',
      name: 'Synthetic category identity',
      last_modified_on: '2026-09-01T00:00:00Z',
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
        {
          id: 'checking',
          name: 'Checking',
          type: 'checking',
          on_budget: true,
          closed: false,
          deleted: false,
          balance: 97_000,
          transfer_payee_id: 'checking-transfer',
        },
      ],
      category_groups: [
        {
          id: 'internal',
          name: 'Internal Master Category',
          hidden: false,
          deleted: false,
          internal: true,
        },
        { id: 'first-group', name: 'First group', hidden: false, deleted: false, internal: false },
        {
          id: 'second-group',
          name: 'Second group',
          hidden: false,
          deleted: false,
          internal: false,
        },
      ],
      categories,
      months: [
        {
          month: '2026-09-01',
          deleted: false,
          budgeted: 30_000,
          activity: -3_000,
          income: 100_000,
          to_be_budgeted: 70_000,
          categories,
        },
      ],
      payees: [{ id: 'store', name: 'Store', transfer_account_id: null, deleted: false }],
      transactions: [
        {
          id: 'income-tx',
          account_id: 'checking',
          date: '2026-09-01',
          amount: 100_000,
          memo: '',
          cleared: 'cleared',
          approved: true,
          payee_id: 'store',
          category_id: 'income',
          transfer_account_id: null,
          transfer_transaction_id: null,
          deleted: false,
        },
        {
          id: 'first-tx',
          account_id: 'checking',
          date: '2026-09-02',
          amount: -1_000,
          memo: '',
          cleared: 'cleared',
          approved: true,
          payee_id: 'store',
          category_id: 'first',
          transfer_account_id: null,
          transfer_transaction_id: null,
          deleted: false,
        },
        {
          id: 'second-tx',
          account_id: 'checking',
          date: '2026-09-03',
          amount: -2_000,
          memo: '',
          cleared: 'cleared',
          approved: true,
          payee_id: 'store',
          category_id: 'second',
          transfer_account_id: null,
          transfer_transaction_id: null,
          deleted: false,
        },
      ],
      subtransactions: [],
    },
  };
}

async function importSnapshot(
  snapshot: YNABApiPlanSnapshot,
  check: (adapter: NodeSqlJsAdapter, budgetId: number) => void
) {
  const adapter = await NodeSqlJsAdapter.create();
  try {
    const result = await new YNABImportService(adapter).importYNABFromApiSnapshotWithSummary(
      snapshot,
      {
        spaceId: 'synthetic-category-space',
        budgetName: 'Synthetic category import',
        currency: 'USD',
        numberFormat: '123,456.78',
        badgeIcon: 'HelpCircle',
      }
    );
    expect(result.verification?.categories.matched).toBe(result.verification?.categories.checked);
    expect(result.verification?.readyToAssign.matched).toBe(1);
    expect(result.summary.sourceRowsVerified).toBe(snapshot.plan.transactions.length);
    check(adapter, result.budgetId);
  } finally {
    adapter.close();
  }
}

function expectDistinctEnvelopes(adapter: NodeSqlJsAdapter, budgetId: number) {
  const rows = adapter
    .prepare(
      `
    SELECT a.CategoryId AS EnvelopeId, a.Amount, SUM(t.InflowNative - t.OutflowNative) AS Activity
    FROM assignments a JOIN transactions t ON t.CategoryID = a.CategoryId
    WHERE a.BudgetId = ? GROUP BY a.CategoryId ORDER BY a.Amount
  `
    )
    .all(budgetId) as { EnvelopeId: number; Amount: number; Activity: number }[];
  expect(rows.map(({ Amount, Activity }) => ({ Amount, Activity }))).toEqual([
    { Amount: 10_000, Activity: -1_000 },
    { Amount: 20_000, Activity: -2_000 },
  ]);
  expect(new Set(rows.map((row) => row.EnvelopeId)).size).toBe(2);
}

describe('YNAB API category identity', () => {
  it('keeps same-named category IDs separate within the same group', async () => {
    const snapshot = fixture();
    snapshot.plan.categories[2].category_group_id = 'first-group';
    snapshot.plan.categories[2].name = 'First';
    await importSnapshot(snapshot, expectDistinctEnvelopes);
  });

  it('keeps same-named group IDs and their categories separate', async () => {
    const snapshot = fixture();
    snapshot.plan.category_groups[2].name = 'First group';
    snapshot.plan.categories[2].name = 'First';
    await importSnapshot(snapshot, (adapter, budgetId) => {
      expectDistinctEnvelopes(adapter, budgetId);
      expect(
        adapter
          .prepare('SELECT COUNT(*) AS count FROM category_groups WHERE BudgetID = ? AND Name = ?')
          .get(budgetId, 'First group')
      ).toEqual({ count: 2 });
    });
  });

  it('keeps whitespace and delimiter differences in display names from merging IDs', async () => {
    const snapshot = fixture();
    snapshot.plan.category_groups[1].name = 'Everyday::Sub';
    snapshot.plan.categories[1].name = 'Food';
    snapshot.plan.category_groups[2].name = 'Everyday';
    snapshot.plan.categories[2].name = 'Sub::Food';
    await importSnapshot(snapshot, expectDistinctEnvelopes);
    const whitespace = fixture();
    whitespace.plan.categories[2].category_group_id = 'first-group';
    whitespace.plan.categories[2].name = 'First ';
    await importSnapshot(whitespace, expectDistinctEnvelopes);
  });

  it.each([
    '__proto__',
    'constructor',
    'toString',
    'Income',
    'Transfers',
    'Uncategorized',
    'Credit Card Payments',
    'Cash inflow reserve',
  ])(
    'imports the ordinary source group %s without treating it as a system group',
    async (groupName) => {
      const snapshot = fixture();
      snapshot.plan.category_groups[1].name = groupName;
      await importSnapshot(snapshot, expectDistinctEnvelopes);
    }
  );

  it.each(['Ready to Assign later', 'Transfer', 'Transfers', 'Uncategorized', 'Income'])(
    'preserves the ordinary source category %s as an envelope',
    async (categoryName) => {
      const snapshot = fixture();
      snapshot.plan.categories[1].name = categoryName;
      await importSnapshot(snapshot, expectDistinctEnvelopes);
    }
  );

  it('verifies category values by source ID when month display names differ', async () => {
    const snapshot = fixture();
    snapshot.plan.months[0].categories = snapshot.plan.categories.map((category) => ({
      ...category,
      name: `${category.name} before rename`,
    }));
    await importSnapshot(snapshot, expectDistinctEnvelopes);
  });

  it.each(['Card ', 'Ready to Assign later ', 'Uncategorized'])(
    'links and verifies the internal payment category for credit card %s by source ID',
    async (cardName) => {
      const snapshot = fixture();
      const card = {
        id: 'card',
        name: cardName,
        type: 'creditCard',
        on_budget: true,
        closed: false,
        deleted: false,
        balance: 0,
        transfer_payee_id: 'card-transfer',
      };
      snapshot.plan.accounts.push(card);
      snapshot.plan.category_groups.push({
        id: 'card-group',
        name: 'Credit Card Payments',
        hidden: false,
        deleted: false,
        internal: true,
      });
      snapshot.plan.categories.push({
        id: 'card-category',
        category_group_id: 'card-group',
        name: card.name,
        hidden: false,
        deleted: false,
        internal: true,
        budgeted: 5_000,
        activity: 0,
        balance: 5_000,
      });
      snapshot.plan.months[0].to_be_budgeted -= 5_000;
      expect(
        normalizeYNABApiSnapshot(snapshot).categoryMonthSpecs.some(
          (spec) => spec.ynabCategoryId === 'card-category'
        )
      ).toBe(true);
      await importSnapshot(snapshot, (adapter, budgetId) => {
        const account = adapter
          .prepare('SELECT Metadata FROM accounts WHERE BudgetID = ? AND Name = ?')
          .get(budgetId, card.name) as { Metadata: string };
        const categoryId = JSON.parse(account.Metadata).cc_payment_category_id;
        expect(
          adapter
            .prepare('SELECT Amount FROM assignments WHERE BudgetId = ? AND CategoryId = ?')
            .get(budgetId, categoryId)
        ).toEqual({ Amount: 5_000 });
        expect(
          adapter
            .prepare(
              "SELECT COUNT(*) AS count FROM categories c JOIN category_groups g ON g.ID = c.CategoryGroupID WHERE c.BudgetID = ? AND c.Name = ? AND g.Name = 'Credit Card Payments'"
            )
            .get(budgetId, card.name)
        ).toEqual({ count: 1 });
      });
    }
  );

  it('keeps an explicitly uncategorized API inflow out of income', async () => {
    const snapshot = fixture();
    snapshot.plan.transactions[1].amount = 1_000;
    snapshot.plan.transactions[1].category_id = null;
    snapshot.plan.accounts[0].balance += 2_000;
    snapshot.plan.categories[1].activity = 0;
    snapshot.plan.categories[1].balance = 10_000;
    await importSnapshot(snapshot, (adapter, budgetId) => {
      expect(
        adapter
          .prepare(
            'SELECT c.Name FROM transactions t JOIN categories c ON c.ID = t.CategoryID WHERE t.BudgetID = ? AND t.InflowNative = 1000'
          )
          .get(budgetId)
      ).toEqual({ Name: 'Uncategorized' });
    });
  });
});
