import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeSqlJsAdapter, YNABImportService, BudgetService } from '../src';

// @ts-expect-error ESM import.meta.url is not recognized by TypeScript in CommonJS context
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEST_SPACE_ID = 'space_ynab_import';

describe('YNABImportService', () => {
  let adapter: NodeSqlJsAdapter;
  let budgetsServices: BudgetService;
  let importedBudgetId: number;

  beforeAll(async () => {
    // Initialize in-memory database
    adapter = await NodeSqlJsAdapter.create();

    // Initialize services - YNABImportService takes the adapter directly
    const ynabImportService = new YNABImportService(adapter);
    budgetsServices = new BudgetService(adapter);

    // Read the test YNAB export file
    const testFilePath = join(__dirname, 'test-data', 'test_ynab_export.zip');
    const fileBuffer = readFileSync(testFilePath);

    // Import the YNAB data with config - ONLY ONCE
    importedBudgetId = await ynabImportService.importYNABFromZip(fileBuffer, {
      spaceId: TEST_SPACE_ID,
      budgetName: 'Test YNAB Import',
      currency: 'USD',
      numberFormat: '$1,097',
      badgeIcon: 'HelpCircle',
    });
  });

  it('should create a budget with correct name', () => {
    const allBudgets = budgetsServices.getAllBudgets();
    const importedBudget = allBudgets.find((b) => b.ID === importedBudgetId);

    expect(importedBudget).toBeDefined();
    expect(importedBudget?.Name).toBe('Test YNAB Import');
    expect(importedBudget?.DisplayCurrency).toBe('USD');
    expect(importedBudget?.SpaceID).toBe(TEST_SPACE_ID);
    expect(budgetsServices.getAllBudgets(TEST_SPACE_ID)).toContainEqual(importedBudget);
  });

  it('should default imported budgets to monthly Ready to Assign', () => {
    expect(budgetsServices.getRtaMode(importedBudgetId)).toBe('monthly');
  });

  it('should have total assignments of 36866410 milliunits', () => {
    const stmt = adapter.prepare(`
      SELECT COALESCE(SUM(Amount), 0) as total
      FROM assignments
      WHERE BudgetId = ?
    `);
    const result = stmt.get(importedBudgetId) as { total: number };
    stmt.finalize();

    expect(result.total).toBe(36866410); // 36,866.41 in milliunits
  });

  it('should have imported category groups', () => {
    const stmt = adapter.prepare(`
      SELECT COUNT(*) as count 
      FROM category_groups 
      WHERE BudgetId = ?
    `);
    const result = stmt.get(importedBudgetId) as { count: number };
    stmt.finalize();

    // 11 from the budget and 3  for SYSTEM CATEGORIES
    expect(result.count).toBe(14);
  });

  it('should have imported categories', () => {
    const stmt = adapter.prepare(`
      SELECT COUNT(*) as count 
      FROM categories 
      WHERE BudgetId = ?
    `);
    const result = stmt.get(importedBudgetId) as { count: number };
    stmt.finalize();
    // 42 from the budget and 3 for SYSTEM CATEGORIES
    expect(result.count).toBe(45);
  });

  it('should have imported transactions', () => {
    const stmt = adapter.prepare(`
      SELECT COUNT(*) as count 
      FROM transactions 
      WHERE BudgetId = ?
    `);
    const result = stmt.get(importedBudgetId) as { count: number };
    stmt.finalize();

    expect(result.count).toBe(787);
  });

  it('should populate payees for register transactions', () => {
    const stmt = adapter.prepare(`
      SELECT DISTINCT Payee 
      FROM transactions 
      WHERE BudgetId = ? AND Payee IS NOT NULL AND TRIM(Payee) <> ''
    `);
    const rows = stmt.all(importedBudgetId) as { Payee: string }[];
    stmt.finalize();

    const payees = rows.map((row) => row.Payee);
    expect(payees.length).toBeGreaterThan(0);
    expect(payees).toContain('Budgero'); // starting balances fallback
  });

  it('should import payees for register entries', () => {
    const countStmt = adapter.prepare(`
      SELECT COUNT(*) as count
      FROM transactions
      WHERE BudgetId = ?
        AND Payee IS NOT NULL
        AND TRIM(Payee) <> ''
    `);
    const countResult = countStmt.get(importedBudgetId) as { count: number };
    countStmt.finalize();

    expect(countResult.count).toBeGreaterThan(0);

    const sampleStmt = adapter.prepare(`
      SELECT Payee
      FROM transactions
      WHERE BudgetId = ?
        AND Payee IS NOT NULL
        AND TRIM(Payee) <> ''
      ORDER BY Date ASC, ID ASC
      LIMIT 1
    `);
    const sample = sampleStmt.get(importedBudgetId) as { Payee: string } | undefined;
    sampleStmt.finalize();

    expect(sample?.Payee).toBeTypeOf('string');
    expect(sample?.Payee?.trim().length).toBeGreaterThan(0);
  });

  it('should have imported accounts', () => {
    const stmt = adapter.prepare(`
      SELECT COUNT(*) as count
      FROM accounts
      WHERE BudgetId = ?
    `);
    const result = stmt.get(importedBudgetId) as { count: number };
    stmt.finalize();

    expect(result.count).toBe(5);
  });

  it('should categorize "Inflow: Ready to Assign" rows as Income (regression)', () => {
    // Starting balances, wages, reconciliation adjustments — anything YNAB
    // files under "Inflow: Ready to Assign" — must import into the Income
    // category. They regressed to Uncategorized when system categories
    // started existing on every new budget: createCategoryStructure's
    // only-if-group-missing branch stopped populating categories['Income'].
    const stmt = adapter.prepare(`
      SELECT c.Name as categoryName, COUNT(*) as count
      FROM transactions t
      JOIN categories c ON t.CategoryID = c.ID
      WHERE t.BudgetId = ?
        AND (t.Memo = 'Starting Balance' OR t.Memo = 'Wage' OR t.Memo = 'Balance Adjustment'
             OR t.Memo = 'Savings Income')
      GROUP BY c.Name
    `);
    const rows = stmt.all(importedBudgetId) as { categoryName: string; count: number }[];
    stmt.finalize();

    expect(rows).toEqual([{ categoryName: 'Income', count: expect.any(Number) }]);
    expect(rows[0].count).toBeGreaterThan(0);
  });
});

type SharedImportTestCase = {
  title: string;
  zipFile: string;
  numberFormat: string;
  currency: string;
  budgetName: string;
};

// Money totals are integer milliunits (1/1000 currency unit).
const SHARED_EXPECTATIONS = {
  assignmentsTotal: 6682116000,
  categoryGroups: 13,
  categories: 49,
  transactions: 1006,
  accounts: 7,
  septemberInflow: 458161550,
  septemberOutflow: 604032530,
} as const;

const sharedImportCases: SharedImportTestCase[] = [
  {
    title: 'TSV export',
    zipFile: 'ynab_export_tsv.zip',
    numberFormat: '123.456,78',
    currency: 'RSD',
    budgetName: 'TSV YNAB Import',
  },
];

for (const testCase of sharedImportCases) {
  describe(`YNABImportService ${testCase.title}`, () => {
    let adapter: NodeSqlJsAdapter;
    let budgetsService: BudgetService;
    let importedBudgetId: number;

    beforeAll(async () => {
      adapter = await NodeSqlJsAdapter.create();
      const ynabImportService = new YNABImportService(adapter);
      budgetsService = new BudgetService(adapter);

      const testFilePath = join(__dirname, 'test-data', testCase.zipFile);
      const fileBuffer = readFileSync(testFilePath);

      importedBudgetId = await ynabImportService.importYNABFromZip(fileBuffer, {
        spaceId: TEST_SPACE_ID,
        budgetName: testCase.budgetName,
        currency: testCase.currency,
        numberFormat: testCase.numberFormat,
        badgeIcon: 'HelpCircle',
      });
    });

    afterAll(() => {
      adapter.close();
    });

    it('should create a budget with correct name', () => {
      const allBudgets = budgetsService.getAllBudgets();
      const importedBudget = allBudgets.find((b) => b.ID === importedBudgetId);

      expect(importedBudget).toBeDefined();
      expect(importedBudget?.Name).toBe(testCase.budgetName);
      expect(importedBudget?.DisplayCurrency).toBe(testCase.currency);
    });

    it('should have total assignments of 6682116000 milliunits', () => {
      const stmt = adapter.prepare(`
        SELECT COALESCE(SUM(Amount), 0) as total
        FROM assignments
        WHERE BudgetId = ?
      `);
      const result = stmt.get(importedBudgetId) as { total: number };
      stmt.finalize();

      expect(result.total).toBe(SHARED_EXPECTATIONS.assignmentsTotal);
    });

    it('should have imported category groups', () => {
      const stmt = adapter.prepare(`
        SELECT COUNT(*) as count
        FROM category_groups
        WHERE BudgetId = ?
      `);
      const result = stmt.get(importedBudgetId) as { count: number };
      stmt.finalize();

      expect(result.count).toBe(SHARED_EXPECTATIONS.categoryGroups);
    });

    it('should have imported categories', () => {
      const stmt = adapter.prepare(`
        SELECT COUNT(*) as count
        FROM categories
        WHERE BudgetId = ?
      `);
      const result = stmt.get(importedBudgetId) as { count: number };
      stmt.finalize();

      expect(result.count).toBe(SHARED_EXPECTATIONS.categories);
    });

    it('should have imported transactions', () => {
      const stmt = adapter.prepare(`
        SELECT COUNT(*) as count
        FROM transactions
        WHERE BudgetId = ?
      `);
      const result = stmt.get(importedBudgetId) as { count: number };
      stmt.finalize();

      expect(result.count).toBe(SHARED_EXPECTATIONS.transactions);
    });

    it('should model complete exported split rows as one split transaction', () => {
      const parents = adapter
        .prepare(
          `SELECT ID, Memo, Payee
           FROM transactions
           WHERE BudgetId = ? AND Memo = 'Imported YNAB split'`
        )
        .all(importedBudgetId) as { ID: number; Memo: string; Payee: string | null }[];

      expect(parents).toHaveLength(2);
      expect(parents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ Memo: 'Imported YNAB split', Payee: null }),
        ])
      );

      const splitCount = adapter
        .prepare(
          `SELECT COUNT(*) AS count
           FROM transaction_splits s
           JOIN transactions t ON t.ID = s.TransactionID
           WHERE t.BudgetID = ? AND t.Memo = 'Imported YNAB split'`
        )
        .get(importedBudgetId) as { count: number };

      expect(splitCount.count).toBe(4);
    });

    it('should have imported accounts', () => {
      const stmt = adapter.prepare(`
        SELECT COUNT(*) as count
        FROM accounts
        WHERE BudgetId = ?
      `);
      const result = stmt.get(importedBudgetId) as { count: number };
      stmt.finalize();

      expect(result.count).toBe(SHARED_EXPECTATIONS.accounts);
    });

    it('should have correct September 2025 inflow and outflow totals', () => {
      const stmt = adapter.prepare(`
        SELECT 
          COALESCE(SUM(InflowConverted), 0) as totalInflow,
          COALESCE(SUM(OutflowConverted), 0) as totalOutflow
        FROM transactions
        WHERE BudgetId = ?
          AND strftime('%Y-%m', Date) = '2025-09'
      `);
      const result = stmt.get(importedBudgetId) as { totalInflow: number; totalOutflow: number };
      stmt.finalize();

      expect(result.totalInflow).toBe(SHARED_EXPECTATIONS.septemberInflow);
      expect(result.totalOutflow).toBe(SHARED_EXPECTATIONS.septemberOutflow);
    });

    it('should categorize every transfer leg as "Transfers", not "Uncategorized"', () => {
      const stmt = adapter.prepare(`
        SELECT c.Name as categoryName, COUNT(*) as count
        FROM transactions t
        JOIN categories c ON t.CategoryID = c.ID
        WHERE t.BudgetId = ?
          AND t.TransferID IS NOT NULL AND TRIM(t.TransferID) <> ''
        GROUP BY c.Name
      `);
      const rows = stmt.all(importedBudgetId) as { categoryName: string; count: number }[];
      stmt.finalize();

      // Both legs of a transfer (the outflow/source side and the inflow/dest side)
      // must land in "Transfers" — the source side previously regressed to
      // "Uncategorized" because the importer passed a non-zero default category.
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.categoryName).toBe('Transfers');
      }
    });

    it('should put transfer source legs in Transfers (regression)', () => {
      // Identify source legs by their transfer metadata rather than Payee:
      // internal on-budget transfers intentionally store an empty payee.
      const stmt = adapter.prepare(`
        SELECT c.Name as categoryName, COUNT(*) as count
        FROM transactions t
        JOIN categories c ON t.CategoryID = c.ID
        WHERE t.BudgetId = ?
          AND t.TransferID IS NOT NULL AND TRIM(t.TransferID) <> ''
          AND t.OutflowConverted > 0
        GROUP BY c.Name
      `);
      const rows = stmt.all(importedBudgetId) as { categoryName: string; count: number }[];
      stmt.finalize();

      expect(rows).toEqual([{ categoryName: 'Transfers', count: expect.any(Number) }]);
      expect(rows[0].count).toBeGreaterThan(0);
    });
  });
}

describe('YNAB import date-order detection', () => {
  async function importWithRegisterDates(dates: string[]): Promise<string[]> {
    const JSZip = (await import('jszip')).default;

    const registerHeader =
      '"Account","Flag","Date","Payee","Category Group/Category","Category Group","Category","Memo","Outflow","Inflow","Cleared"';
    const registerRows = dates.map(
      (date, index) =>
        `"Checking","","${date}","Grocer","Everyday: Food","Everyday","Food","row ${index}","10.00","0.00","Cleared"`
    );
    const budgetCsv = [
      '"Month","Category Group/Category","Category Group","Category","Assigned","Activity","Available"',
      '"Jan 2025","Everyday: Food","Everyday","Food","10.00","0.00","0.00"',
    ].join('\n');

    const zip = new JSZip();
    zip.file('Test Budget - Register.csv', [registerHeader, ...registerRows].join('\n'));
    zip.file('Test Budget - Budget.csv', budgetCsv);
    const zipData = await zip.generateAsync({ type: 'uint8array' });

    const adapter = await NodeSqlJsAdapter.create();
    try {
      const service = new YNABImportService(adapter);
      const budgetId = await service.importYNABFromZip(zipData, {
        spaceId: TEST_SPACE_ID,
        budgetName: 'Date Order Test',
        currency: 'USD',
        numberFormat: '123,456.78',
        badgeIcon: 'HelpCircle',
      });

      const stmt = adapter.prepare(
        `SELECT Date FROM transactions WHERE BudgetID = ? ORDER BY Memo`
      );
      const rows = stmt.all(budgetId) as { Date: string }[];
      stmt.finalize();
      return rows.map((row) => row.Date);
    } finally {
      adapter.close();
    }
  }

  it('detects US month-first dates from unambiguous rows (regression)', async () => {
    // 01/25/2025 can only be month-first — 02/03/2025 must follow that order.
    const dates = await importWithRegisterDates(['01/25/2025', '02/03/2025']);
    expect(dates).toEqual(['2025-01-25', '2025-02-03']);
  });

  it('keeps day-first parsing when the file says so', async () => {
    const dates = await importWithRegisterDates(['25/01/2025', '03/02/2025']);
    expect(dates).toEqual(['2025-01-25', '2025-02-03']);
  });

  it('parses ISO dates regardless of detection', async () => {
    const dates = await importWithRegisterDates(['2025-01-25', '2025-02-03']);
    expect(dates).toEqual(['2025-01-25', '2025-02-03']);
  });

  it('parses single-digit day/month components', async () => {
    const dates = await importWithRegisterDates(['1/25/2025', '2/3/2025']);
    expect(dates).toEqual(['2025-01-25', '2025-02-03']);
  });
});

describe('YNABImportService — credit cards', () => {
  it('imports accounts listed under "Credit Card Payments" as credit cards, without duplicate categories', async () => {
    const adapter = await NodeSqlJsAdapter.create();
    const { ServiceManager } = await import('../src');
    const sm = new ServiceManager();
    await sm.initialize(adapter as any);
    const services = sm.getServices();
    const importer = new YNABImportService(adapter);
    const fileBuffer = readFileSync(join(__dirname, 'test-data', 'ynab_credit_cards.zip'));
    const budgetId = await importer.importYNABFromZip(fileBuffer, {
      spaceId: TEST_SPACE_ID,
      budgetName: 'Credit Cards',
      currency: 'USD',
      numberFormat: '123,456.78',
      badgeIcon: 'HelpCircle',
    });

    const accounts = services.accounts.listAccounts(budgetId);
    const byName = Object.fromEntries(accounts.map((a: any) => [a.Name, a]));
    expect(byName['Checking'].Type).toBe('Checking');
    expect(byName['Cash'].Type).toBe('Checking');
    expect(byName['Test Card'].Type).toBe('Credit');
    expect(byName['Debt Card'].Type).toBe('Credit');

    // Exactly one CC Payment category per card, linked from the account metadata.
    const ccGroup = services.categories.getCategoryGroupByName('Credit Card Payments', budgetId);
    const ccCategories = services.categories
      .getAllCategories(budgetId)
      .filter((c: any) => c.CategoryGroupID === ccGroup!.ID)
      .map((c: any) => c.Name)
      .sort();
    expect(ccCategories).toEqual(['Debt Card', 'Test Card']);
    const debtMeta = JSON.parse(byName['Debt Card'].Metadata || '{}');
    expect(typeof debtMeta.cc_payment_category_id).toBe('number');

    // The Debt Card's $200 opening debt stays out of Ready to Assign. Each
    // month reflects income and assignments reached through that month; later
    // assignments do not rewrite historical RTA snapshots.
    services.budgets.updateRtaMode(budgetId, 'monthly');
    const expectedRtaByMonth = {
      '2026-07': 1_050_000,
      '2026-08': 520_000,
      '2026-09': 500_000,
      '2026-10': 0,
    };
    for (const [month, expected] of Object.entries(expectedRtaByMonth)) {
      expect(services.monthlyBudgets.getReadyToAssign(budgetId, month)).toBe(expected);
    }
    expect(byName['Debt Card'].BalanceNative).toBe(-200_000);
  });
});

describe('YNABImportService — migration edge cases', () => {
  async function createEdgeCaseExport(): Promise<Uint8Array> {
    const JSZip = (await import('jszip')).default;
    const registerCsv = [
      '\uFEFF"Account","Flag","Date","Payee","Category Group/Category","Category Group","Category","Memo","Outflow","Inflow","Cleared"',
      '"Checking","","2026-08-30","Notes Payee","Archive: Missing From Plan","Archive","Missing From Plan","First line, with comma\nSecond ""quoted"" line\nThird line ✅","$12.34","$0.00","Cleared"',
      '"Checking","","2026-08-30","Grocer","Everyday: Food","Everyday","Food","Split (1/3): Food part","$20.00","$0.00","Cleared"',
      '"Checking","","2026-08-30","Transit","Everyday: Transport","Everyday","Transport","Split (2/3): Transport part","$30.25","$0.00","Cleared"',
      '"Checking","","2026-08-30","Home Store","Everyday: Household","Everyday","Household","Split (3/3): Household part","$73.20","$0.00","Cleared"',
    ].join('\r\n');
    const planCsv = [
      '\uFEFF"Month","Category Group/Category","Category Group","Category","Assigned","Activity","Available"',
      '"Aug 2026","Everyday: Food","Everyday","Food","$0.00","$0.00","$0.00"',
      '"Aug 2026","Everyday: Transport","Everyday","Transport","$0.00","$0.00","$0.00"',
      '"Aug 2026","Everyday: Household","Everyday","Household","$0.00","$0.00","$0.00"',
    ].join('\r\n');

    const zip = new JSZip();
    zip.file('Edge Cases - Register.csv', registerCsv);
    zip.file('Edge Cases - Plan.csv', planCsv);
    return zip.generateAsync({ type: 'uint8array' });
  }

  it('previews multiline rows, missing categories, and complete split groups', async () => {
    const zip = await createEdgeCaseExport();
    const preview = await YNABImportService.inspectYNABZip(zip);

    expect(preview).toEqual({
      dateOrderAmbiguous: false,
      registerRowCount: 4,
      accountCount: 1,
      categoryCount: 4,
      missingCategories: [
        {
          categoryGroup: 'Archive',
          category: 'Missing From Plan',
          transactionCount: 1,
        },
      ],
      splitTransactions: [
        {
          account: 'Checking',
          date: '2026-08-30',
          payees: ['Grocer', 'Transit', 'Home Store'],
          partCount: 3,
        },
      ],
    });
  });

  it('preserves multiline memos, creates missing categories, and imports splits automatically', async () => {
    const zip = await createEdgeCaseExport();
    const adapter = await NodeSqlJsAdapter.create();

    try {
      const importer = new YNABImportService(adapter);
      const result = await importer.importYNABFromZipWithSummary(zip, {
        spaceId: TEST_SPACE_ID,
        budgetName: 'Edge Cases',
        currency: 'USD',
        numberFormat: '123,456.78',
        badgeIcon: 'HelpCircle',
      });

      expect(result.summary).toEqual({
        registerRowsImported: 4,
        transactionsCreated: 2,
        missingCategoriesCreated: [
          {
            categoryGroup: 'Archive',
            category: 'Missing From Plan',
            transactionCount: 1,
          },
        ],
        splitTransactionsImported: 1,
        sourceRowsVerified: 4,
      });

      const transactions = adapter
        .prepare(
          `SELECT t.ID, t.Memo, t.Payee, c.Name AS Category
           FROM transactions t
           JOIN categories c ON c.ID = t.CategoryID
           WHERE t.BudgetID = ?
           ORDER BY t.ID`
        )
        .all(result.budgetId) as {
        ID: number;
        Memo: string;
        Payee: string | null;
        Category: string;
      }[];

      expect(transactions).toHaveLength(2);
      expect(transactions[0]).toMatchObject({
        Memo: 'First line, with comma\nSecond "quoted" line\nThird line ✅',
        Payee: 'Notes Payee',
        Category: 'Missing From Plan',
      });
      expect(transactions[1]).toMatchObject({
        Memo: 'Imported YNAB split',
        Payee: null,
      });

      const splitRows = adapter
        .prepare(
          `SELECT s.Memo, s.Payee, s.OutflowNative, s.OrderIndex, c.Name AS Category
           FROM transaction_splits s
           JOIN categories c ON c.ID = s.CategoryID
           WHERE s.TransactionID = ?
           ORDER BY s.OrderIndex`
        )
        .all(transactions[1].ID) as {
        Memo: string;
        Payee: string;
        OutflowNative: number;
        OrderIndex: number;
        Category: string;
      }[];

      expect(splitRows).toEqual([
        {
          Memo: 'Food part',
          Payee: 'Grocer',
          OutflowNative: 20_000,
          OrderIndex: 0,
          Category: 'Food',
        },
        {
          Memo: 'Transport part',
          Payee: 'Transit',
          OutflowNative: 30_250,
          OrderIndex: 1,
          Category: 'Transport',
        },
        {
          Memo: 'Household part',
          Payee: 'Home Store',
          OutflowNative: 73_200,
          OrderIndex: 2,
          Category: 'Household',
        },
      ]);
    } finally {
      adapter.close();
    }
  });

  it('explodes transfer splits while preserving ordinary inflow splits', async () => {
    const JSZip = (await import('jszip')).default;
    const registerCsv = [
      '"Account","Date","Payee","Category Group/Category","Category Group","Category","Memo","Outflow","Inflow"',
      '"Checking","2026-08-30","Transfer : Savings","","","","Split (1/2): Move to savings","$20.00","$0.00"',
      '"Checking","2026-08-30","Grocer","Everyday: Food","Everyday","Food","Split (2/2): Food part","$30.00","$0.00"',
      '"Savings","2026-08-30","Transfer : Checking","","","","Move to savings","$0.00","$20.00"',
      '"Checking","2026-08-31","Employer","Inflow: Ready to Assign","Inflow","Ready to Assign","Split (1/2): Salary","$0.00","$60.00"',
      '"Checking","2026-08-31","Store","Everyday: Food","Everyday","Food","Split (2/2): Refund","$0.00","$40.00"',
    ].join('\r\n');
    const planCsv = [
      '"Month","Category Group/Category","Category Group","Category","Assigned","Activity","Available"',
      '"Aug 2026","Everyday: Food","Everyday","Food","$0.00","$0.00","$0.00"',
    ].join('\r\n');
    const zip = new JSZip();
    zip.file('Transfer Splits - Register.csv', registerCsv);
    zip.file('Transfer Splits - Plan.csv', planCsv);
    const archive = await zip.generateAsync({ type: 'uint8array' });

    const preview = await YNABImportService.inspectYNABZip(archive);
    expect(preview.splitTransactions).toEqual([
      expect.objectContaining({ account: 'Checking', date: '2026-08-31', partCount: 2 }),
    ]);

    const adapter = await NodeSqlJsAdapter.create();
    try {
      const importer = new YNABImportService(adapter);
      const result = await importer.importYNABFromZipWithSummary(archive, {
        spaceId: TEST_SPACE_ID,
        budgetName: 'Transfer split import',
        currency: 'USD',
        numberFormat: '123,456.78',
        badgeIcon: 'HelpCircle',
      });

      expect(result.summary.transactionsCreated).toBe(4);
      expect(result.summary.splitTransactionsImported).toBe(1);

      const transferRows = adapter
        .prepare(
          `SELECT t.Memo, t.Payee, t.OutflowNative, t.InflowNative, c.Name AS Category
           FROM transactions t
           JOIN categories c ON c.ID = t.CategoryID
           WHERE t.BudgetID = ? AND t.TransferID IS NOT NULL
           ORDER BY t.OutflowNative DESC`
        )
        .all(result.budgetId) as Record<string, unknown>[];
      expect(transferRows).toHaveLength(2);
      expect(transferRows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            Memo: 'Move to savings',
            Payee: null,
            OutflowNative: 20_000,
            Category: 'Transfers',
          }),
          expect.objectContaining({ Payee: null, InflowNative: 20_000, Category: 'Transfers' }),
        ])
      );

      const explodedOrdinary = adapter
        .prepare(
          `SELECT t.Memo, t.Payee, t.OutflowNative, c.Name AS Category
           FROM transactions t
           JOIN categories c ON c.ID = t.CategoryID
           WHERE t.BudgetID = ? AND t.Payee = 'Grocer'`
        )
        .get(result.budgetId);
      expect(explodedOrdinary).toEqual({
        Memo: 'Food part',
        Payee: 'Grocer',
        OutflowNative: 30_000,
        Category: 'Food',
      });

      const inflowSplits = adapter
        .prepare(
          `SELECT s.Memo, s.InflowNative, s.OutflowNative
           FROM transaction_splits s
           JOIN transactions t ON t.ID = s.TransactionID
           WHERE t.BudgetID = ?
           ORDER BY s.OrderIndex`
        )
        .all(result.budgetId);
      expect(inflowSplits).toEqual([
        { Memo: 'Salary', InflowNative: 60_000, OutflowNative: 0 },
        { Memo: 'Refund', InflowNative: 40_000, OutflowNative: 0 },
      ]);
    } finally {
      adapter.close();
    }
  });

  it('does not mistake ordinary transfer-related text for an account transfer', async () => {
    const JSZip = (await import('jszip')).default;
    const registerCsv = [
      '"Account","Date","Payee","Category Group/Category","Category Group","Category","Memo","Outflow","Inflow"',
      '"Checking","2026-09-01","Wire Transfer Service","Everyday: Fees","Everyday","Fees","Transfer confirmation fee","$12.00","$0.00"',
    ].join('\r\n');
    const planCsv = [
      '"Month","Category Group/Category","Category Group","Category","Assigned","Activity","Available"',
      '"Sep 2026","Everyday: Fees","Everyday","Fees","$0.00","$0.00","$0.00"',
    ].join('\r\n');
    const zip = new JSZip();
    zip.file('Transfer Text - Register.csv', registerCsv);
    zip.file('Transfer Text - Plan.csv', planCsv);

    const adapter = await NodeSqlJsAdapter.create();
    try {
      const importer = new YNABImportService(adapter);
      const result = await importer.importYNABFromZipWithSummary(
        await zip.generateAsync({ type: 'uint8array' }),
        {
          spaceId: TEST_SPACE_ID,
          budgetName: 'Transfer text',
          currency: 'USD',
          numberFormat: '123,456.78',
          badgeIcon: 'HelpCircle',
        }
      );

      const transaction = adapter
        .prepare(
          `SELECT t.Payee, t.Memo, t.TransferID, c.Name AS Category
           FROM transactions t
           JOIN categories c ON c.ID = t.CategoryID
           WHERE t.BudgetID = ?`
        )
        .get(result.budgetId);

      expect(transaction).toEqual({
        Payee: 'Wire Transfer Service',
        Memo: 'Transfer confirmation fee',
        TransferID: null,
        Category: 'Fees',
      });
    } finally {
      adapter.close();
    }
  });

  it('imports uncategorized and mixed-direction split lines without losing their amounts', async () => {
    const JSZip = (await import('jszip')).default;
    const registerCsv = [
      '"Account","Date","Payee","Category Group/Category","Category Group","Category","Memo","Outflow","Inflow"',
      '"Checking","2026-09-01","Mystery Store","","","","Split (1/2): Unknown item","$10.00","$0.00"',
      '"Checking","2026-09-01","Grocer","Everyday: Food","Everyday","Food","Split (2/2): Groceries","$20.00","$0.00"',
      '"Checking","2026-09-02","Store","Everyday: Food","Everyday","Food","Split (1/2): Purchase","$100.00","$0.00"',
      '"Checking","2026-09-02","Store","Everyday: Food","Everyday","Food","Split (2/2): Refund","$0.00","$25.00"',
    ].join('\r\n');
    const planCsv = [
      '"Month","Category Group/Category","Category Group","Category","Assigned","Activity","Available"',
      '"Sep 2026","Everyday: Food","Everyday","Food","$0.00","$0.00","$0.00"',
    ].join('\r\n');
    const zip = new JSZip();
    zip.file('Split Directions - Register.csv', registerCsv);
    zip.file('Split Directions - Plan.csv', planCsv);
    const archive = await zip.generateAsync({ type: 'uint8array' });

    const preview = await YNABImportService.inspectYNABZip(archive);
    expect(preview.splitTransactions).toHaveLength(2);

    const adapter = await NodeSqlJsAdapter.create();
    try {
      const importer = new YNABImportService(adapter);
      const result = await importer.importYNABFromZipWithSummary(archive, {
        spaceId: TEST_SPACE_ID,
        budgetName: 'Split directions',
        currency: 'USD',
        numberFormat: '123,456.78',
        badgeIcon: 'HelpCircle',
      });

      expect(result.summary.transactionsCreated).toBe(2);
      expect(result.summary.splitTransactionsImported).toBe(2);

      const splitRows = adapter
        .prepare(
          `SELECT t.Date, s.Memo, s.InflowNative, s.OutflowNative, c.Name AS Category
           FROM transaction_splits s
           JOIN transactions t ON t.ID = s.TransactionID
           JOIN categories c ON c.ID = s.CategoryID
           WHERE t.BudgetID = ?
           ORDER BY t.Date, s.OrderIndex`
        )
        .all(result.budgetId);

      expect(splitRows).toEqual([
        {
          Date: '2026-09-01',
          Memo: 'Unknown item',
          InflowNative: 0,
          OutflowNative: 10_000,
          Category: 'Uncategorized',
        },
        {
          Date: '2026-09-01',
          Memo: 'Groceries',
          InflowNative: 0,
          OutflowNative: 20_000,
          Category: 'Food',
        },
        {
          Date: '2026-09-02',
          Memo: 'Purchase',
          InflowNative: 0,
          OutflowNative: 100_000,
          Category: 'Food',
        },
        {
          Date: '2026-09-02',
          Memo: 'Refund',
          InflowNative: 25_000,
          OutflowNative: 0,
          Category: 'Food',
        },
      ]);

      const mixedParent = adapter
        .prepare(
          `SELECT InflowNative, OutflowNative
           FROM transactions
           WHERE BudgetID = ? AND Date = '2026-09-02'`
        )
        .get(result.budgetId);
      expect(mixedParent).toEqual({ InflowNative: 25_000, OutflowNative: 100_000 });
    } finally {
      adapter.close();
    }
  });

  it('keeps repeated same-day transfers as distinct balanced pairs', async () => {
    const JSZip = (await import('jszip')).default;
    const registerCsv = [
      '"Account","Date","Payee","Category Group/Category","Category Group","Category","Memo","Outflow","Inflow"',
      '"Checking","2026-09-03","Transfer : Savings","","","","First transfer","$50.00","$0.00"',
      '"Checking","2026-09-03","Transfer : Savings","","","","Second transfer","$50.00","$0.00"',
      '"Savings","2026-09-03","Transfer : Checking","","","","First transfer","$0.00","$50.00"',
      '"Savings","2026-09-03","Transfer : Checking","","","","Second transfer","$0.00","$50.00"',
    ].join('\r\n');
    const planCsv =
      '"Month","Category Group/Category","Category Group","Category","Assigned","Activity","Available"';
    const zip = new JSZip();
    zip.file('Duplicate Transfers - Register.csv', registerCsv);
    zip.file('Duplicate Transfers - Plan.csv', planCsv);

    const adapter = await NodeSqlJsAdapter.create();
    try {
      const importer = new YNABImportService(adapter);
      const result = await importer.importYNABFromZipWithSummary(
        await zip.generateAsync({ type: 'uint8array' }),
        {
          spaceId: TEST_SPACE_ID,
          budgetName: 'Duplicate transfers',
          currency: 'USD',
          numberFormat: '123,456.78',
          badgeIcon: 'HelpCircle',
        }
      );

      const pairs = adapter
        .prepare(
          `SELECT TransferID, COUNT(*) AS LegCount,
                  SUM(InflowNative) AS TotalInflow, SUM(OutflowNative) AS TotalOutflow
           FROM transactions
           WHERE BudgetID = ? AND TransferID IS NOT NULL AND TransferID != ''
           GROUP BY TransferID
           ORDER BY TransferID`
        )
        .all(result.budgetId);

      expect(pairs).toHaveLength(2);
      expect(pairs).toEqual([
        expect.objectContaining({ LegCount: 2, TotalInflow: 50_000, TotalOutflow: 50_000 }),
        expect.objectContaining({ LegCount: 2, TotalInflow: 50_000, TotalOutflow: 50_000 }),
      ]);
    } finally {
      adapter.close();
    }
  });

  it('does not detect incomplete or non-contiguous split markers as a split transaction', async () => {
    const JSZip = (await import('jszip')).default;
    const registerCsv = [
      '"Account","Date","Payee","Category Group/Category","Category Group","Category","Memo","Outflow","Inflow"',
      '"Checking","2026-08-30","Split Store","Everyday: Food","Everyday","Food","Split (1/2): Food part","$20.00","$0.00"',
      '"Checking","2026-08-30","Another Payee","Everyday: Food","Everyday","Food","Ordinary row","$5.00","$0.00"',
      '"Checking","2026-08-30","Split Store","Everyday: Transport","Everyday","Transport","Split (2/2): Transport part","$30.00","$0.00"',
    ].join('\r\n');
    const planCsv = [
      '"Month","Category Group/Category","Category Group","Category","Assigned","Activity","Available"',
      '"Aug 2026","Everyday: Food","Everyday","Food","$0.00","$0.00","$0.00"',
      '"Aug 2026","Everyday: Transport","Everyday","Transport","$0.00","$0.00","$0.00"',
    ].join('\r\n');
    const zip = new JSZip();
    zip.file('Incomplete - Register.csv', registerCsv);
    zip.file('Incomplete - Plan.csv', planCsv);

    const preview = await YNABImportService.inspectYNABZip(
      await zip.generateAsync({ type: 'uint8array' })
    );

    expect(preview.splitTransactions).toEqual([]);
  });
});
