import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { NodeSqlJsAdapter, YNABImportService } from '../src';
import type { YNABImportConfig } from '../src/services/import/types';

async function createExport(dates: string[]) {
  const zip = new JSZip();
  zip.file(
    'Synthetic - Register.csv',
    [
      'Account,Flag,Date,Payee,Category Group/Category,Category Group,Category,Memo,Outflow,Inflow,Cleared',
      ...dates.map(
        (date, index) =>
          `Checking,,${date},Shop,Everyday: Food,Everyday,Food,row ${index},10.00,0.00,Cleared`
      ),
    ].join('\n')
  );
  zip.file(
    'Synthetic - Plan.csv',
    'Month,Category Group/Category,Category Group,Category,Assigned,Activity,Available\nJan 2026,Everyday: Food,Everyday,Food,10.00,0.00,0.00'
  );
  return zip.generateAsync({ type: 'uint8array' });
}

async function importDates(dates: string[], dateOrder?: YNABImportConfig['dateOrder']) {
  const db = await NodeSqlJsAdapter.create();
  try {
    const budgetId = await new YNABImportService(db).importYNABFromZip(await createExport(dates), {
      spaceId: 'synthetic-date-order',
      budgetName: 'Synthetic dates',
      currency: 'USD',
      numberFormat: '123,456.78',
      badgeIcon: 'Wallet',
      dateOrder,
    });
    const stmt = db.prepare('SELECT Date FROM transactions WHERE BudgetID = ? ORDER BY Memo');
    const rows = stmt.all(budgetId) as { Date: string }[];
    stmt.finalize();
    return rows.map((row) => row.Date);
  } finally {
    db.close();
  }
}

describe('YNAB ZIP date-order choice', () => {
  it.each([
    { dates: ['09/01/2026'], ambiguous: true },
    { dates: ['01/09/2026', '09/01/2026'], ambiguous: true },
    { dates: ['2026-09-01', '09/01/2026'], ambiguous: true },
    { dates: ['01/01/2026', '09/09/2026'], ambiguous: false },
    { dates: ['2026-09-01'], ambiguous: false },
    { dates: ['09/01/2026', '09/13/2026'], ambiguous: false },
    { dates: ['09/01/2026', '13/09/2026'], ambiguous: false },
    { dates: [], ambiguous: false },
  ])(
    'reports ambiguity only when ordering changes a date: $dates',
    async ({ dates, ambiguous }) => {
      const preview = await YNABImportService.inspectYNABZip(await createExport(dates));
      expect(preview.dateOrderAmbiguous).toBe(ambiguous);
    }
  );

  it('imports September 1 when the user chooses month first', async () => {
    expect(await importDates(['09/01/2026'], 'month-first')).toEqual(['2026-09-01']);
  });

  it('imports January 9 when the user chooses day first', async () => {
    expect(await importDates(['09/01/2026'], 'day-first')).toEqual(['2026-01-09']);
  });

  it('continues to detect unambiguous exports without a choice', async () => {
    expect(await importDates(['09/01/2026', '09/13/2026'])).toEqual(['2026-09-01', '2026-09-13']);
  });

  it('does not change ISO dates when a choice is supplied', async () => {
    expect(await importDates(['2026-09-01'], 'day-first')).toEqual(['2026-09-01']);
  });
});

it('autodetects comma-decimal ZIP source amounts while retaining a US display preference', async () => {
  const zip = new JSZip();
  zip.file(
    'Synthetic - Register.csv',
    'Account,Date,Payee,Category Group,Category,Outflow,Inflow\nChecking,2026-09-01,Shop,Everyday,Food,"12,34","0,00"'
  );
  zip.file(
    'Synthetic - Plan.csv',
    'Month,Category Group,Category,Assigned\nSep 2026,Everyday,Food,"12,34"'
  );
  const db = await NodeSqlJsAdapter.create();
  try {
    const budgetId = await new YNABImportService(db).importYNABFromZip(
      await zip.generateAsync({ type: 'uint8array' }),
      {
        spaceId: 'synthetic',
        budgetName: 'Synthetic source format',
        currency: 'EUR',
        numberFormat: '$1,096.56',
        sourceNumberFormat: '',
        badgeIcon: 'Wallet',
      }
    );
    const transactions = db.prepare('SELECT OutflowConverted FROM transactions WHERE BudgetID = ?');
    expect(transactions.all(budgetId)).toEqual([{ OutflowConverted: 12340 }]);
    transactions.finalize();
    const assignments = db.prepare('SELECT Amount FROM assignments WHERE BudgetID = ?');
    expect(assignments.all(budgetId)).toEqual([{ Amount: 12340 }]);
    assignments.finalize();
  } finally {
    db.close();
  }
});
