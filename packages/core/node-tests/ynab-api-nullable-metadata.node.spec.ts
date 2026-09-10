import { describe, expect, it } from 'vitest';
import {
  NodeSqlJsAdapter,
  YNABImportService,
  normalizeYNABApiSnapshot,
  type YNABApiPlanSnapshot,
} from '../src/index.js';

function snapshotFixture(): YNABApiPlanSnapshot {
  const category = {
    id: 'category-food',
    category_group_id: 'group-everyday',
    name: 'Food',
    hidden: false,
    deleted: false,
    internal: false,
    budgeted: 5_000,
    activity: 0,
    balance: 5_000,
  };
  return {
    serverKnowledge: 1,
    plan: {
      id: 'plan-nullable-metadata',
      name: 'Synthetic nullable metadata',
      last_modified_on: '2026-09-01T00:00:00Z',
      first_month: '2026-09-01',
      last_month: '2026-09-01',
      currency_format: null,
      accounts: [
        {
          id: 'account-tracking',
          name: 'Tracking',
          type: 'otherAsset',
          on_budget: false,
          closed: false,
          deleted: false,
          balance: -1_010,
          transfer_payee_id: 'transfer-tracking',
        },
      ],
      category_groups: [
        {
          id: 'group-everyday',
          name: 'Everyday',
          hidden: false,
          deleted: false,
          internal: false,
        },
      ],
      categories: [category],
      months: [],
      payees: [],
      transactions: [
        {
          id: 'transaction-split',
          account_id: 'account-tracking',
          date: '2026-09-01',
          amount: -1_010,
          memo: null,
          cleared: 'cleared',
          approved: true,
          payee_id: null,
          category_id: null,
          transfer_account_id: null,
          transfer_transaction_id: null,
          deleted: false,
        },
      ],
      subtransactions: [0, 1].map((index) => ({
        id: `split-child-${index}`,
        transaction_id: 'transaction-split',
        amount: -505,
        memo: `Part ${index + 1}`,
        payee_id: null,
        category_id: 'category-food',
        transfer_account_id: null,
        deleted: false,
      })),
    },
  };
}

describe('YNAB nullable API metadata', () => {
  it('imports exact milliunit amounts when the optional currency format is unavailable', async () => {
    const snapshot = snapshotFixture();
    const adapter = await NodeSqlJsAdapter.create();
    try {
      const result = await new YNABImportService(adapter).importYNABFromApiSnapshotWithSummary(
        snapshot,
        {
          spaceId: 'space-nullable-metadata',
          budgetName: 'Nullable currency format',
          currency: 'KWD',
          numberFormat: '123,456.789',
          badgeIcon: 'HelpCircle',
        }
      );

      expect(result.verification?.status).toBe('passed');
      expect(result.summary.sourceRowsVerified).toBe(2);
      expect(
        adapter
          .prepare('SELECT BalanceNative FROM accounts WHERE BudgetID = ?')
          .all(result.budgetId)
      ).toEqual([{ BalanceNative: -1_010 }]);
      expect(
        adapter
          .prepare(
            `SELECT s.OutflowNative FROM transaction_splits s
             JOIN transactions t ON t.ID = s.TransactionID
             WHERE t.BudgetID = ? ORDER BY s.OrderIndex`
          )
          .all(result.budgetId)
      ).toEqual([{ OutflowNative: 505 }, { OutflowNative: 505 }]);
    } finally {
      adapter.close();
    }
  });

  it.each([null, undefined])(
    'preserves monthly assignments without claiming verification when a movement month is %s',
    (month) => {
      const snapshot = snapshotFixture();
      snapshot.plan.months = [
        {
          month: '2026-09-01',
          deleted: false,
          budgeted: 5_000,
          activity: 0,
          income: 0,
          to_be_budgeted: -5_000,
          categories: snapshot.plan.categories,
        },
      ];
      snapshot.moneyMovements = [
        {
          id: 'movement-known-month',
          month: '2026-09-01',
          from_category_id: null,
          to_category_id: 'category-food',
          amount: 3_000,
          deleted: false,
        },
        {
          id: 'movement-unknown-month',
          month,
          from_category_id: null,
          to_category_id: 'category-food',
          amount: 2_000,
          deleted: false,
        },
      ];

      const normalized = normalizeYNABApiSnapshot(snapshot);

      expect(normalized.budgetRows).toContainEqual(
        expect.objectContaining({ Month: '2026-09-01', Category: 'Food', Assigned: '5.000' })
      );
      expect(normalized.categoryMonthSpecs).toHaveLength(1);
      expect(normalized.source).toMatchObject({
        moneyMovements: 2,
        categoryAssignmentsVerified: 0,
        registerRows: 2,
      });
    }
  );
});
