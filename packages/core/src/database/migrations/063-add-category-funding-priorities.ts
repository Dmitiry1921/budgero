import type { Migration } from '../migrations.js';

const additions = [
  ['categories', 'FundingPriority', 'INTEGER NOT NULL DEFAULT 3 CHECK (FundingPriority > 0)'],
  ['budgets', 'CategoryPriorityMode', "TEXT NOT NULL DEFAULT 'five-levels'"],
  ['budgets', 'GoalFundingDistribution', "TEXT NOT NULL DEFAULT 'proportional-shortfall'"],
  ['budgets', 'ShowCategoryPriorities', 'BOOLEAN NOT NULL DEFAULT 1'],
] as const;

export const migration063: Migration = {
  version: 63,
  description: 'Add category funding priorities and per-budget goal funding settings',
  up: (db) => {
    for (const [table, column, definition] of additions) {
      const columns = db.exec(`PRAGMA table_info(${table})`)[0]?.values ?? [];
      if (!columns.some((row) => row[1] === column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      }
    }
  },
  verify: (db) =>
    additions.every(
      ([table, column]) =>
        db.exec(`PRAGMA table_info(${table})`)[0]?.values.some((row) => row[1] === column) ?? false
    ),
};
