import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MutationExecutor, type UndoEntry } from '@budgero/runtime';
import {
  executeMutationOp,
  getInvalidatesForOp,
  getUndoSpec,
} from '@shared/mutations/op-code-registry';
import { useUndoStore } from '@shared/mutations/UndoStore';
import type { FundingPriorityUpdate, GoalFundingSettings } from '@budgero/core/browser';

const state = vi.hoisted(() => ({
  categories: [
    {
      ID: 1,
      BudgetID: 7,
      CategoryGroupID: 10,
      Name: 'Rent',
      ExcludeFromBudgetPace: false,
      FundingPriority: 8,
    },
    {
      ID: 2,
      BudgetID: 7,
      CategoryGroupID: 10,
      Name: 'Fun',
      ExcludeFromBudgetPace: true,
      FundingPriority: 2,
    },
    {
      ID: 3,
      BudgetID: 8,
      CategoryGroupID: 11,
      Name: 'Other',
      ExcludeFromBudgetPace: false,
      FundingPriority: 9,
    },
  ],
  settings: {
    CategoryPriorityMode: 'numeric',
    GoalFundingDistribution: 'proportional-shortfall',
    ShowCategoryPriorities: true,
  },
}));
const mock = vi.hoisted(() => ({
  execute: vi.fn(),
  addCategory: vi.fn(),
  updatePriorities: vi.fn(),
}));
vi.mock('@shared/runtime/global', () => ({
  getRuntime: () => ({
    mutationsRouter: () => ({ execute: mock.execute }),
    services: () => ({
      budgets: {
        getBudget: () => ({ ...state.settings }),
        updateGoalFundingSettings: (
          id: number,
          settings: Partial<GoalFundingSettings>,
          restore: FundingPriorityUpdate[] = []
        ) => {
          Object.assign(state.settings, settings);
          if (settings.CategoryPriorityMode === 'five-levels')
            for (const c of state.categories.filter((c) => c.BudgetID === id))
              c.FundingPriority = Math.min(5, c.FundingPriority);
          for (const update of restore)
            state.categories.find((c) => c.ID === update.categoryId)!.FundingPriority =
              update.priority;
        },
      },
      categories: {
        getCategory: (id: number) => ({ ...state.categories.find((c) => c.ID === id)! }),
        getAllCategories: (id: number) =>
          state.categories.filter((c) => c.BudgetID === id).map((c) => ({ ...c })),
        updateFundingPriorities: mock.updatePriorities,
        updateCategoryDetails: (
          _budgetId: number,
          id: number,
          name: string,
          exclude: boolean,
          priority: number
        ) =>
          Object.assign(state.categories.find((c) => c.ID === id)!, {
            Name: name,
            ExcludeFromBudgetPace: exclude,
            FundingPriority: priority,
          }),
        deleteCategory: vi.fn(),
        addCategory: mock.addCategory,
      },
    }),
  }),
}));

let executor: MutationExecutor;
beforeEach(() => {
  state.categories[0].FundingPriority = 8;
  state.categories[0].Name = 'Rent';
  state.categories[0].ExcludeFromBudgetPace = false;
  state.categories[1].FundingPriority = 2;
  state.settings.CategoryPriorityMode = 'numeric';
  useUndoStore.getState().clear();
  vi.clearAllMocks();
  mock.updatePriorities.mockImplementation((_id: number, updates: FundingPriorityUpdate[]) => {
    for (const update of updates)
      state.categories.find((c) => c.ID === update.categoryId)!.FundingPriority = update.priority;
  });
  executor = new MutationExecutor({
    executeOp: executeMutationOp,
    getUndoSpec,
    getInvalidatesForOp,
    getQueryClient: () => undefined,
    pushUndo: (entry: UndoEntry) => useUndoStore.getState().push(entry),
    recordHistory: () => {},
    getActiveSpaceId: () => 'space-1',
    getSpaceRole: () => 'owner',
  });
  mock.execute.mockImplementation((spec) => executor.execute(spec));
});

describe('funding priority mutation undo', () => {
  it('converts and restores a budget in one undo/redo step', async () => {
    await executor.execute({
      op: 'budgets.updateGoalFundingSettings',
      payload: { id: 7, settings: { CategoryPriorityMode: 'five-levels' } },
    });
    expect(state.categories.map((c) => c.FundingPriority)).toEqual([5, 2, 9]);
    expect(useUndoStore.getState().past).toHaveLength(1);
    await useUndoStore.getState().undo();
    expect(state.settings.CategoryPriorityMode).toBe('numeric');
    expect(state.categories.map((c) => c.FundingPriority)).toEqual([8, 2, 9]);
    await useUndoStore.getState().redo();
    expect(state.settings.CategoryPriorityMode).toBe('five-levels');
    expect(state.categories.map((c) => c.FundingPriority)).toEqual([5, 2, 9]);
  });

  it('restores mixed selections as a batch, then reapplies the shared value', async () => {
    await executor.execute({
      op: 'categories.updateFundingPriorities',
      payload: {
        budgetId: 7,
        updates: [
          { categoryId: 1, priority: 1 },
          { categoryId: 2, priority: 1 },
        ],
      },
    });
    expect(state.categories.map((c) => c.FundingPriority)).toEqual([1, 1, 9]);
    expect(useUndoStore.getState().past).toHaveLength(1);
    await useUndoStore.getState().undo();
    expect(state.categories.map((c) => c.FundingPriority)).toEqual([8, 2, 9]);
    await useUndoStore.getState().redo();
    expect(state.categories.map((c) => c.FundingPriority)).toEqual([1, 1, 9]);
  });

  it('restores all Edit Category fields together', async () => {
    await executor.execute({
      op: 'categories.updateDetails',
      payload: { budgetId: 7, id: 1, name: 'Mortgage', excludeFromBudgetPace: true, priority: 1 },
    });
    await useUndoStore.getState().undo();
    expect(state.categories[0]).toMatchObject({
      Name: 'Rent',
      ExcludeFromBudgetPace: false,
      FundingPriority: 8,
    });
    await useUndoStore.getState().redo();
    expect(state.categories[0]).toMatchObject({
      Name: 'Mortgage',
      ExcludeFromBudgetPace: true,
      FundingPriority: 1,
    });
  });

  it('keeps priority when undoing category deletion', async () => {
    await executor.execute({ op: 'categories.delete', payload: { id: 1, budgetId: 7 } });
    await useUndoStore.getState().undo();
    expect(mock.addCategory).toHaveBeenCalledWith(10, 7, 'Rent', '', 8);
  });

  it('does not record a failed save as undoable', async () => {
    mock.updatePriorities.mockRejectedValueOnce(new Error('Save failed'));
    await expect(
      executor.execute({
        op: 'categories.updateFundingPriorities',
        payload: { budgetId: 7, updates: [{ categoryId: 1, priority: 1 }] },
      })
    ).rejects.toThrow();
    expect(useUndoStore.getState().past).toHaveLength(0);
  });
});
