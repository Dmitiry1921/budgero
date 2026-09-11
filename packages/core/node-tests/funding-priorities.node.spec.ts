import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { NodeSqlJsAdapter, ServiceManager, GoalType, getGoalFundingSettings } from '../src';

let db: NodeSqlJsAdapter;
let services: ReturnType<ServiceManager['getServices']>;
let budgetId: number;
let otherBudget: number;
let categoryIds: number[];
let foreignCategory: number;

beforeEach(async () => {
  db = await NodeSqlJsAdapter.create();
  const manager = new ServiceManager();
  await manager.initialize(db);
  services = manager.getServices();
  const create = (name: string) =>
    services.budgets.createBudget({
      name,
      display_currency: 'EUR',
      badge_icon: 'coin',
      number_format: '1,234.56',
      create_default_categories: false,
    });
  budgetId = await create('First');
  otherBudget = await create('Second');
  const group = services.categories.addCategoryGroup('Goals', budgetId);
  categoryIds = [
    services.categories.addCategory(group, budgetId, 'Rent'),
    services.categories.addCategory(group, budgetId, 'Fun'),
  ];
  foreignCategory = services.categories.addCategory(
    services.categories.addCategoryGroup('Other', otherBudget),
    otherBudget,
    'Other'
  );
});
afterEach(() => db.close());
const priorities = () =>
  categoryIds.map((id) => services.categories.getCategory(id).FundingPriority);

describe('category funding persistence', () => {
  it('defaults old and new rows, and exposes priorities in every month', () => {
    expect(priorities()).toEqual([3, 3]);
    expect(getGoalFundingSettings(services.budgets.getBudget(budgetId))).toEqual({
      CategoryPriorityMode: 'five-levels',
      GoalFundingDistribution: 'proportional-shortfall',
      ShowCategoryPriorities: true,
    });
    services.categories.updateFundingPriorities(budgetId, [
      { categoryId: categoryIds[0], priority: 1 },
    ]);
    for (const month of ['2026-01', '2027-03']) {
      expect(
        services.monthlyBudgets
          .getMonthlyBudget(month, budgetId)
          .find((row) => row.CategoryID === categoryIds[0])?.FundingPriority
      ).toBe(1);
    }
  });

  it('validates the whole batch before changing any category', () => {
    for (const priority of [0, -1, 2.5, 6, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        services.categories.updateFundingPriorities(budgetId, [
          { categoryId: categoryIds[0], priority: 1 },
          { categoryId: categoryIds[1], priority },
        ])
      ).toThrow();
      expect(priorities()).toEqual([3, 3]);
    }
    expect(() =>
      services.categories.updateFundingPriorities(budgetId, [
        { categoryId: categoryIds[0], priority: 1 },
        { categoryId: foreignCategory, priority: 2 },
      ])
    ).toThrow();
    expect(priorities()).toEqual([3, 3]);
  });

  it('converts only the chosen budget and atomically restores mode and priorities', () => {
    for (const id of [budgetId, otherBudget])
      services.budgets.updateGoalFundingSettings(id, { CategoryPriorityMode: 'numeric' });
    services.categories.updateFundingPriorities(budgetId, [
      { categoryId: categoryIds[0], priority: 100 },
      { categoryId: categoryIds[1], priority: 2 },
    ]);
    services.categories.updateFundingPriorities(otherBudget, [
      { categoryId: foreignCategory, priority: 99 },
    ]);
    services.budgets.updateGoalFundingSettings(budgetId, {
      CategoryPriorityMode: 'five-levels',
      GoalFundingDistribution: 'equal-completion',
      ShowCategoryPriorities: false,
    });
    expect(priorities()).toEqual([5, 2]);
    expect(services.categories.getCategory(foreignCategory).FundingPriority).toBe(99);
    expect(getGoalFundingSettings(services.budgets.getBudget(otherBudget))).toMatchObject({
      CategoryPriorityMode: 'numeric',
      ShowCategoryPriorities: true,
    });
    services.budgets.updateGoalFundingSettings(
      budgetId,
      { CategoryPriorityMode: 'numeric', ShowCategoryPriorities: true },
      [{ categoryId: categoryIds[0], priority: 100 }]
    );
    expect(priorities()).toEqual([100, 2]);
    expect(() =>
      services.budgets.updateGoalFundingSettings(
        budgetId,
        { CategoryPriorityMode: 'five-levels' },
        [{ categoryId: foreignCategory, priority: 1 }]
      )
    ).toThrow();
    expect(priorities()).toEqual([100, 2]);
    expect(services.budgets.getBudget(budgetId).CategoryPriorityMode).toBe('numeric');
  });

  it('saves name, pace and priority together and rejects invalid full edits', () => {
    const id = categoryIds[0];
    expect(() =>
      services.categories.updateCategoryDetails(budgetId, id, 'Updated', true, 7)
    ).toThrow();
    expect(services.categories.getCategory(id)).toMatchObject({
      Name: 'Rent',
      FundingPriority: 3,
      ExcludeFromBudgetPace: false,
    });
    services.categories.updateCategoryDetails(budgetId, id, 'Updated', true, 1);
    expect(services.categories.getCategory(id)).toMatchObject({
      Name: 'Updated',
      FundingPriority: 1,
      ExcludeFromBudgetPace: true,
    });
  });

  it('preserves priorities and settings through database backup and restore', () => {
    services.budgets.updateGoalFundingSettings(budgetId, {
      CategoryPriorityMode: 'numeric',
      GoalFundingDistribution: 'equal-completion',
      ShowCategoryPriorities: false,
    });
    services.categories.updateFundingPriorities(budgetId, [
      { categoryId: categoryIds[0], priority: Number.MAX_SAFE_INTEGER },
    ]);
    const backup = db.backup();
    services.categories.updateFundingPriorities(budgetId, [
      { categoryId: categoryIds[0], priority: 1 },
    ]);
    db.restore(backup);
    expect(priorities()).toEqual([Number.MAX_SAFE_INTEGER, 3]);
    expect(getGoalFundingSettings(services.budgets.getBudget(budgetId))).toEqual({
      CategoryPriorityMode: 'numeric',
      GoalFundingDistribution: 'equal-completion',
      ShowCategoryPriorities: false,
    });
  });

  it('migrates existing rows without changing category order, goals or assignments', () => {
    const id = categoryIds[0];
    services.goals.createGoal(GoalType.MONTHLY, id, 100_000, '2026-01-01', '');
    services.monthlyBudgets.upsertMonthlyAssignment(id, 20_000, '2026-01', budgetId);
    const before = services.categories.getAllCategories(budgetId);
    db.exec('ALTER TABLE categories DROP COLUMN FundingPriority');
    for (const column of [
      'CategoryPriorityMode',
      'GoalFundingDistribution',
      'ShowCategoryPriorities',
    ])
      db.exec(`ALTER TABLE budgets DROP COLUMN ${column}`);
    db.exec('DELETE FROM schema_migrations WHERE version = 63');
    db.restoreAndMigrate(db.backup());
    expect(services.categories.getAllCategories(budgetId)).toEqual(before);
    expect(services.goals.getGoalByCategoryID(id).Target).toBe(100_000);
    expect(
      services.monthlyBudgets
        .getMonthlyBudget('2026-01', budgetId)
        .find((row) => row.CategoryID === id)?.Assigned
    ).toBe(20_000);
    expect(getGoalFundingSettings(services.budgets.getBudget(budgetId))).toMatchObject({
      CategoryPriorityMode: 'five-levels',
      ShowCategoryPriorities: true,
    });
  });
});
