import type { Migration } from '../migrations.js';

export const migration062: Migration = {
  version: 62,
  description: 'Preserve transaction import identities independently of import history',
  up: `ALTER TABLE import_runs ADD COLUMN RunKey TEXT;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_import_runs_key ON import_runs(RunKey);
  CREATE TABLE IF NOT EXISTS import_provenance (
    ID INTEGER PRIMARY KEY AUTOINCREMENT,
    TransactionID INTEGER NOT NULL REFERENCES transactions(ID) ON DELETE CASCADE ON UPDATE CASCADE,
    BudgetID INTEGER NOT NULL REFERENCES budgets(ID) ON DELETE CASCADE ON UPDATE CASCADE,
    AccountID INTEGER NOT NULL REFERENCES accounts(ID) ON DELETE CASCADE ON UPDATE CASCADE,
    Currency TEXT NOT NULL,
    OperationID TEXT NOT NULL UNIQUE,
    FileRowKey TEXT NOT NULL,
    SourceKey TEXT,
    IdentityJSON TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_import_provenance_destination ON import_provenance(BudgetID, AccountID, Currency);
  CREATE INDEX IF NOT EXISTS idx_import_provenance_transaction ON import_provenance(TransactionID);`,
};
