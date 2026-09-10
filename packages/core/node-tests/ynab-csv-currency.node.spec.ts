import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { NodeSqlJsAdapter, YNABImportService } from '../src/index.js';

async function archiveWithAmount(amount: string): Promise<Uint8Array> {
  const csv = (rows: string[][]) =>
    rows.map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(',')).join('\n');
  const archive = new JSZip();
  archive.file(
    'Synthetic - Register.csv',
    csv([
      [
        'Account',
        'Flag',
        'Date',
        'Payee',
        'Category Group/Category',
        'Category Group',
        'Category',
        'Memo',
        'Outflow',
        'Inflow',
        'Cleared',
      ],
      [
        'Checking',
        '',
        '2026-09-01',
        'Shop',
        'Everyday: Food',
        'Everyday',
        'Food',
        'Synthetic purchase',
        amount,
        '0',
        'Cleared',
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
      ['Sep 2026', 'Everyday: Food', 'Everyday', 'Food', amount, '0', '0'],
    ])
  );
  return archive.generateAsync({ type: 'uint8array' });
}

describe('YNAB CSV currency preservation', () => {
  it.each([
    ['1\u202f234,56 €', 'EUR', '1 096,56 $US', 1_234_560],
    ['kr 1 234,56', 'SEK', '1 096,56 $US', 1_234_560],
    ['CHF 1’234.56', 'CHF', '$1,096.56', 1_234_560],
    ['KWD 1.234,567', 'KWD', '1.096,56 $', 1_234_567],
  ])(
    'imports every milliunit from %s',
    async (amount, currency, numberFormat, expectedMilliunits) => {
      const adapter = await NodeSqlJsAdapter.create();
      try {
        const result = await new YNABImportService(adapter).importYNABFromZipWithSummary(
          await archiveWithAmount(amount),
          {
            spaceId: 'synthetic-currency-import',
            budgetName: 'Synthetic currency import',
            currency,
            numberFormat,
            badgeIcon: 'Wallet',
          }
        );

        expect(result.summary.sourceRowsVerified).toBe(1);
        expect(
          adapter
            .prepare('SELECT OutflowNative FROM transactions WHERE BudgetID = ?')
            .all(result.budgetId)
        ).toEqual([{ OutflowNative: expectedMilliunits }]);
        expect(
          adapter
            .prepare('SELECT BalanceNative FROM accounts WHERE BudgetID = ?')
            .all(result.budgetId)
        ).toEqual([{ BalanceNative: -expectedMilliunits }]);
        expect(
          adapter.prepare('SELECT Amount FROM assignments WHERE BudgetID = ?').all(result.budgetId)
        ).toEqual([{ Amount: expectedMilliunits }]);
      } finally {
        adapter.close();
      }
    }
  );

  it('removes an incomplete import when a nonempty amount is not numeric', async () => {
    const adapter = await NodeSqlJsAdapter.create();
    try {
      await expect(
        new YNABImportService(adapter).importYNABFromZipWithSummary(
          await archiveWithAmount('12oops'),
          {
            spaceId: 'synthetic-invalid-currency',
            budgetName: 'Synthetic invalid currency',
            currency: 'USD',
            numberFormat: '$1,096.56',
            badgeIcon: 'Wallet',
          }
        )
      ).rejects.toThrow(/Unable to parse YNAB amount/);
      expect(adapter.prepare('SELECT COUNT(*) AS Count FROM budgets').get()).toEqual({ Count: 0 });
    } finally {
      adapter.close();
    }
  });
});
