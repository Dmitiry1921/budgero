import {
  getGoalFundingSettings,
  type GoalFundingSettings,
  type FundingPriorityUpdate,
} from '@budgero/core/browser';
import { S, type OpCodeEntry } from '../shared';

export const budgetOps = {
  'budgets.updateGoalFundingSettings': {
    execute: async (args) =>
      S().budgets.updateGoalFundingSettings(
        args.id as number,
        args.settings as Partial<GoalFundingSettings>,
        args.restorePriorities as FundingPriorityUpdate[] | undefined
      ),
    invalidates: [['budgets'], ['categories', '*'], ['monthlyBudget', '*']],
    undo: {
      capture: async (args) => {
        const settings = getGoalFundingSettings(S().budgets.getBudget(args.id as number));
        const restoringIds = new Set(
          ((args.restorePriorities as FundingPriorityUpdate[]) ?? []).map(
            (entry) => entry.categoryId
          )
        );
        const converts =
          (args.settings as Partial<GoalFundingSettings>).CategoryPriorityMode === 'five-levels';
        const restorePriorities = S()
          .categories.getAllCategories(args.id as number)
          .filter(
            (category) =>
              restoringIds.has(category.ID) || (converts && (category.FundingPriority ?? 3) > 5)
          )
          .map((category) => ({
            categoryId: category.ID,
            priority: category.FundingPriority ?? 3,
          }));
        return { settings, restorePriorities };
      },
      build: (args, _result, before) => [
        {
          op: 'budgets.updateGoalFundingSettings',
          args: { id: args.id, ...(before as Record<string, unknown>) },
        },
      ],
    },
  },
  'budgets.create': {
    execute: async (args) => {
      return await S().budgets!.createBudget({
        name: args.name as string,
        space_id: (args.spaceId as string | undefined) ?? (args.space_id as string | undefined),
        display_currency: args.displayCurrency as string,
        badge_icon: args.badgeIcon as string,
        number_format: args.numberFormat as string,
        create_default_categories: args.createDefaultCategories as boolean,
      });
    },
    invalidates: [
      ['budgets'],
      ['accounts', '*'],
      ['transactions', '*'],
      ['categoryGroups', '*'],
      ['monthlyBudget', '*'],
    ],
  },

  // useUpdateBudgetName
  'budgets.updateName': {
    execute: async (args) => {
      return await S().budgets!.updateBudgetName(args.id as number, args.name as string);
    },
    invalidates: [['budgets']],
  },

  // useUpdateBudgetCurrency
  'budgets.updateCurrency': {
    execute: async (args) => {
      return await S().budgets!.updateBudgetCurrency(args.id as number, args.currency as string);
    },
    invalidates: [['budgets']],
  },

  // useUpdateBudgetIcon
  'budgets.updateIcon': {
    execute: async (args) => {
      return await S().budgets!.updateBudgetIcon(args.id as number, args.icon as string);
    },
    invalidates: [['budgets']],
  },

  // useUpdateBudgetNumberFormat
  'budgets.updateNumberFormat': {
    execute: async (args) => {
      return await S().budgets!.updateBudgetNumberFormat(args.id as number, args.format as string);
    },
    invalidates: [['budgets']],
  },

  // useUpdateBudgetRtaMode — switches Ready to Assign between cumulative/monthly
  'budgets.updateRtaMode': {
    execute: async (args) => {
      return S().budgets!.updateRtaMode(args.id as number, args.mode as 'cumulative' | 'monthly');
    },
    invalidates: [['budgets'], ['readyToAssign', '*'], ['monthlyBudget', '*']],
  },

  // useDeleteBudget
  'budgets.delete': {
    execute: async (args) => {
      return await S().budgets!.deleteBudget(args.id as number);
    },
    invalidates: [
      ['budgets'],
      ['accounts'],
      ['transactions'],
      ['categoryGroups'],
      ['monthlyBudget', '*'],
    ],
  },

  // useInsertDefaultCategories (if exists)
  'budgets.insertDefaultCategories': {
    execute: async (args) => {
      return await S().budgets!.insertDefaultCategories(args.budgetId as number);
    },
    invalidates: [['categoryGroups']],
  },
} satisfies Record<string, OpCodeEntry>;
