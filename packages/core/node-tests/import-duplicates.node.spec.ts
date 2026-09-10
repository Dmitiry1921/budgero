import { describe, it, expect } from 'vitest';
import { NodeSqlJsAdapter, ServiceManager, asMilli } from '../src';
import { importSourceKey, type DuplicateInput } from '../src/services/import/duplicate-planner';
import { parseCamt, camtToImportRows } from '../src/services/import/camt-parser';

async function setup() {
  const db = await NodeSqlJsAdapter.create();
  const manager = new ServiceManager();
  await manager.initialize(db);
  const services = manager.getServices();
  const budgetId = await services.budgets.createBudget({
    name: 'Imports',
    display_currency: 'USD',
    badge_icon: 'dollar',
    number_format: '123,456.78',
    create_default_categories: false,
  });
  const group = services.categories.addCategoryGroup('Group', budgetId);
  const categoryId = services.categories.addCategory(group, budgetId, 'Category');
  const account = await services.accounts.createAccount(
    'Checking',
    budgetId,
    'Checking',
    'USD',
    asMilli(0),
    true
  );
  const row: DuplicateInput = {
    index: 0,
    valid: true,
    budgetId,
    accountId: account.ID,
    currency: 'USD',
    operationId: 'attempt:0',
    fileRowKey: 'file-a:0',
    date: '2026-09-01',
    inflow: 0,
    outflow: 10000,
    payee: 'Coffee',
    memo: 'Original memo',
  };
  const add = (input = row, provenance = true) =>
    services.transactions.addTransaction(
      asMilli(input.inflow),
      asMilli(input.outflow),
      input.accountId,
      categoryId,
      input.budgetId,
      input.date,
      input.memo,
      '',
      input.payee,
      null,
      null,
      false,
      provenance ? [input] : []
    );
  return { db, services, row, add, categoryId, duplicates: services.importHistory.duplicates };
}

describe('File import duplicate planning and provenance', () => {
  it('recognizes an exact row after ledger edits and history deletion', async () => {
    const { services, row, add, duplicates, categoryId } = await setup();
    const id = await add();
    services.transactions.updatePlainTransactionMetadata(
      id,
      categoryId,
      'Edited memo',
      'Renamed payee'
    );
    const run = services.importHistory.recordImportRun({
      budgetId: row.budgetId,
      sourceType: 'csv',
      sourceName: 'a.csv',
      summary: { transactionsImported: 1, accountsCreated: 0, categoriesCreated: 0 },
      transactionIds: [id],
      accountIds: [],
      categoryIds: [],
    });
    services.importHistory.deleteImportRun(run);
    expect(duplicates.plan([row])[0]).toMatchObject({
      status: 'already-imported',
      candidates: [{ id }],
    });
  });

  it('requires review for manual transactions and consumes matches one-to-one', async () => {
    const { row, add, duplicates } = await setup();
    const id = await add(row, false);
    const results = duplicates.plan([
      row,
      { ...row, index: 1, fileRowKey: 'file-a:1', operationId: 'attempt:1' },
    ]);
    expect(results[0]).toMatchObject({ status: 'needs-review', candidates: [{ id }] });
    expect(results[1]).toMatchObject({ status: 'needs-review', candidates: [], sameFileIndex: 0 });
  });

  it('keeps repeated legitimate purchases and recognizes each on reimport', async () => {
    const { row, add, duplicates } = await setup();
    const other = { ...row, index: 1, fileRowKey: 'file-a:1', operationId: 'attempt:1' };
    const first = await add();
    const second = await add(other);
    expect(first).not.toBe(second);
    expect(duplicates.plan([row, other]).map((p) => p.status)).toEqual([
      'already-imported',
      'already-imported',
    ]);
  });

  it('matches OFX identity across exports and reviews conflicting amounts', async () => {
    const { row, add, duplicates } = await setup();
    const bankRow = { ...row, sourceKey: '["ofx-v1","account","fitid"]' };
    await add(bankRow);
    expect(duplicates.plan([{ ...bankRow, fileRowKey: 'different-file' }])[0].status).toBe(
      'already-imported'
    );
    expect(
      duplicates.plan([{ ...bankRow, fileRowKey: 'different-file', outflow: 20000 }])[0].status
    ).toBe('needs-review');
  });

  it('does not match different accounts, currencies, dates, or direction', async () => {
    const { row, add, duplicates, services } = await setup();
    await add();
    const other = await services.accounts.createAccount(
      'Savings',
      row.budgetId,
      'Savings',
      'USD',
      asMilli(0),
      true
    );
    for (const patch of [
      { accountId: other.ID },
      { currency: 'EUR' },
      { date: '2026-09-02' },
      { inflow: 10000, outflow: 0 },
    ]) {
      expect(duplicates.plan([{ ...row, fileRowKey: 'another-file', ...patch }])[0].status).toBe(
        'new'
      );
    }
  });

  it('makes operation replay idempotent but permits an intentional extra import', async () => {
    const { row, add, duplicates, services } = await setup();
    const id = await add();
    expect(await add()).toBe(id);
    const second = await add({ ...row, operationId: 'deliberate-extra' });
    expect(second).not.toBe(id);
    expect(services.transactions.getTransactionsByAccount(row.accountId)).toHaveLength(2);
    expect(duplicates.identities(second)[0].fileRowKey).toBe(row.fileRowKey);
  });

  it('rolls back the ledger when provenance cannot be persisted', async () => {
    const { db, row, add, services } = await setup();
    db.exec(
      "CREATE TRIGGER fail_provenance BEFORE INSERT ON import_provenance BEGIN SELECT RAISE(ABORT, 'test failure'); END;"
    );
    await expect(add()).rejects.toThrow('test failure');
    expect(services.transactions.getTransactionsByAccount(row.accountId)).toHaveLength(0);
  });

  it('allows reimport after deletion and restores identity with a recreated transaction', async () => {
    const { row, add, duplicates, services } = await setup();
    const id = await add();
    const identities = duplicates.identities(id);
    await services.transactions.deleteTransaction(id);
    expect(duplicates.plan([row])[0].status).toBe('new');
    await add({ ...row, ...identities[0] });
    expect(duplicates.plan([row])[0].status).toBe('already-imported');
  });

  it('persists a reviewed match without taking ownership of the existing transaction', async () => {
    const { row, add, duplicates, services } = await setup();
    const id = await add(row, false);
    duplicates.record(id, row);
    const run = services.importHistory.recordImportRun({
      runKey: 'reviewed',
      budgetId: row.budgetId,
      sourceType: 'csv',
      sourceName: 'a.csv',
      summary: {
        transactionsImported: 0,
        duplicatesSkipped: 1,
        accountsCreated: 0,
        categoriesCreated: 0,
      },
      transactionIds: [],
      accountIds: [],
      categoryIds: [],
    });
    services.importHistory.undoImportRun(run);
    expect(duplicates.plan([row])[0].status).toBe('already-imported');
    expect(services.transactions.getTransactionByID(id).ID).toBe(id);
  });

  it('checkpoints one run and removes imported provenance on import undo', async () => {
    const { row, add, duplicates, services } = await setup();
    const id = await add();
    const input = {
      runKey: 'checkpoint',
      budgetId: row.budgetId,
      sourceType: 'csv' as const,
      sourceName: 'a.csv',
      summary: { transactionsImported: 0, accountsCreated: 0, categoriesCreated: 0 },
      transactionIds: [] as number[],
      accountIds: [],
      categoryIds: [],
    };
    const run = services.importHistory.recordImportRun(input);
    expect(
      services.importHistory.recordImportRun({
        ...input,
        transactionIds: [id],
        summary: {
          ...input.summary,
          transactionsImported: 1,
          failedRows: 1,
          failures: [{ index: 1, message: 'Unreadable row' }],
        },
      })
    ).toBe(run);
    expect(services.importHistory.listImportRuns(row.budgetId)).toHaveLength(1);
    expect(services.importHistory.getImportRun(run)?.summary.failedRows).toBe(1);
    services.importHistory.recordImportRun({ ...input, transactionIds: [] });
    expect(services.importHistory.getImportRun(run)?.transactionIds).toEqual([id]);
    services.importHistory.undoImportRun(run);
    expect(duplicates.plan([row])[0].status).toBe('new');
  });
  it('trusts only entry-level CAMT bank IDs, never end-to-end or nested batch references', () => {
    const entry = (body: string) =>
      `<BkToCstmrStmt><Stmt><Acct><Id><IBAN>GB123</IBAN></Id><Ccy>USD</Ccy></Acct><Ntry><Amt Ccy="USD">10</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>2026-09-01</Dt></BookgDt>${body}</Ntry></Stmt></BkToCstmrStmt>`;
    const rows = (body: string) => camtToImportRows(parseCamt(entry(body))).rows[0];
    expect(
      importSourceKey(
        'camt',
        rows(
          '<NtryDtls><TxDtls><Refs><EndToEndId>customer-id</EndToEndId><AcctSvcrRef>nested-id</AcctSvcrRef></Refs></TxDtls></NtryDtls>'
        )
      )
    ).toBeUndefined();
    expect(importSourceKey('camt', rows('<AcctSvcrRef>bank-entry-1</AcctSvcrRef>'))).toBeDefined();
    for (const placeholder of ['NOTPROVIDED', 'NONREF', 'N/A', '0', '']) {
      expect(
        importSourceKey('camt', rows(`<AcctSvcrRef>${placeholder}</AcctSvcrRef>`))
      ).toBeUndefined();
    }
    expect(importSourceKey('csv', { Account: 'a', FITID: 'not-trusted' })).toBeUndefined();
    expect(importSourceKey('ofx', { Account: '', FITID: 'missing-account' })).toBeUndefined();
  });
});
