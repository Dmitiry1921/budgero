import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { NodeSqlJsAdapter, YNABImportService } from '../src/index.js';

async function sourceArchive(group: string, category: string, includePlanCategory = true) {
  const csv = (rows: string[][]) =>
    rows.map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(',')).join('\n');
  const archive = new JSZip();
  archive.file(
    'Synthetic - Register.csv',
    csv([
      [
        'Account',
        'Date',
        'Payee',
        'Category Group/Category',
        'Category Group',
        'Category',
        'Memo',
        'Outflow',
        'Inflow',
      ],
      [
        'Checking',
        '2026-09-01',
        'Employer',
        'Inflow: Ready to Assign',
        'Inflow',
        'Ready to Assign',
        'Salary',
        '0',
        '20.00',
      ],
      [
        'Checking',
        '2026-09-02',
        'Shop',
        `${group}: ${category}`,
        group,
        category,
        'Purchase',
        '2.00',
        '0',
      ],
    ])
  );
  archive.file(
    'Synthetic - Plan.csv',
    csv([
      [
        'Month',
        'Category Group/Category',
        'Category Group',
        'Category',
        'Assigned',
        'Activity',
        'Available',
      ],
      ...(includePlanCategory
        ? [['Sep 2026', `${group}: ${category}`, group, category, '10.00', '-2.00', '8.00']]
        : []),
    ])
  );
  return archive.generateAsync({ type: 'uint8array' });
}

describe('YNAB CSV category identities', () => {
  it.each([
    ['Everyday', 'Ready to Assign vacation', 'Everyday'],
    ['Everyday', 'Ready to Assign', 'Everyday'],
    ['Cash inflows reserve', 'Buffer', 'Cash inflows reserve'],
    ['Everyday', 'Uncategorized', 'Everyday'],
    ['Everyday', 'Transfers', 'Everyday'],
    ['Income', 'Salary reserve', 'Income (YNAB)'],
    ['Transfers', 'Transfer fees', 'Transfers (YNAB)'],
    ['Uncategorized', 'New purchases', 'Uncategorized (YNAB)'],
  ])('preserves the spending category %s / %s', async (group, category, expectedGroup) => {
    const adapter = await NodeSqlJsAdapter.create();
    try {
      const result = await new YNABImportService(adapter).importYNABFromZipWithSummary(
        await sourceArchive(group, category),
        {
          spaceId: 'synthetic-csv-categories',
          budgetName: 'Synthetic CSV categories',
          currency: 'USD',
          numberFormat: '$1,096.56',
          badgeIcon: 'Wallet',
        }
      );
      expect(
        adapter
          .prepare(
            `
        SELECT c.Name AS Category, g.Name AS CategoryGroup, a.Amount
        FROM transactions t
        JOIN categories c ON c.ID = t.CategoryID
        JOIN category_groups g ON g.ID = c.CategoryGroupID
        JOIN assignments a ON a.CategoryId = c.ID AND a.BudgetId = t.BudgetID
        WHERE t.BudgetID = ? AND t.Memo = 'Purchase'
      `
          )
          .all(result.budgetId)
      ).toEqual([{ Category: category, CategoryGroup: expectedGroup, Amount: 10_000 }]);
      expect(
        adapter
          .prepare(
            `
        SELECT c.Name AS Category, g.Name AS CategoryGroup
        FROM transactions t JOIN categories c ON c.ID = t.CategoryID
        JOIN category_groups g ON g.ID = c.CategoryGroupID
        WHERE t.BudgetID = ? AND t.Memo = 'Salary'
      `
          )
          .get(result.budgetId)
      ).toEqual({ Category: 'Income', CategoryGroup: 'Income' });
    } finally {
      adapter.close();
    }
  });

  it('does not replace the system Income alias with a register-only ordinary Income category', async () => {
    const adapter = await NodeSqlJsAdapter.create();
    try {
      const result = await new YNABImportService(adapter).importYNABFromZipWithSummary(
        await sourceArchive('Everyday', 'Income', false),
        {
          spaceId: 'synthetic-csv-register-category',
          budgetName: 'Synthetic CSV register category',
          currency: 'USD',
          numberFormat: '$1,096.56',
          badgeIcon: 'Wallet',
        }
      );
      expect(
        adapter
          .prepare(
            `
        SELECT t.Memo, c.Name AS Category, g.Name AS CategoryGroup
        FROM transactions t JOIN categories c ON c.ID = t.CategoryID
        JOIN category_groups g ON g.ID = c.CategoryGroupID
        WHERE t.BudgetID = ? ORDER BY t.Date
      `
          )
          .all(result.budgetId)
      ).toEqual([
        { Memo: 'Salary', Category: 'Income', CategoryGroup: 'Income' },
        { Memo: 'Purchase', Category: 'Income', CategoryGroup: 'Everyday' },
      ]);
    } finally {
      adapter.close();
    }
  });
});
