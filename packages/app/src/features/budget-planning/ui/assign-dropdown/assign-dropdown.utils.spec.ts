import { asMilli } from '@shared/lib/currency/milli';
import { describe, expect, it } from 'vitest';
import {
  GoalType,
  GoalPurpose,
  type Goal,
  type GetMonthlyBudgetRow,
  GoalCalculations,
} from '@budgero/core/browser';
import { calculateUnderfundedGoals, prepareUnderfundedAssignments } from './assign-dropdown.utils';

const row = {
  CategoryID: 1,
  Category: 'Goal',
  FundingPriority: 2,
  Assigned: 20_000,
  Available: 420_000,
  Activity: -10_000,
} as GetMonthlyBudgetRow;
const history = {
  1: {
    assigned: 0,
    available: 0,
    activity: 0,
    historicalAssignments: [
      { month: '2026-01', amount: 100_000 },
      { month: '2026-02', amount: 100_000 },
    ],
    plannedAssignments: [],
  },
};

describe('funding shortfall integration', () => {
  it.each([
    [GoalType.MONTHLY, GoalPurpose.SPENDING, false],
    [GoalType.MONTHLY_SAVINGS, GoalPurpose.SAVINGS, false],
    [GoalType.YEARLY, GoalPurpose.SPENDING, false],
    [GoalType.TARGET_DATE, GoalPurpose.SAVINGS, false],
    [GoalType.YEARLY, GoalPurpose.SPENDING, true],
    [GoalType.TARGET_DATE, GoalPurpose.SAVINGS, true],
  ] as const)(
    'preserves %s / %s monthly shortfalls (recurring: %s)',
    (type, purpose, recurring) => {
      const goal: Goal = {
        ID: 1,
        CategoryID: 1,
        Type: type,
        Purpose: purpose,
        Target: asMilli(1_200_000),
        StartDate: '2026-01-01',
        TargetDate: recurring ? '2026-03-31' : '2026-12-31',
        Recurring: recurring,
        CycleMonths: recurring ? 3 : null,
      };
      const progress = GoalCalculations.calculateProgress(
        goal,
        {
          available: row.Available,
          assigned: row.Assigned,
          activity: row.Activity,
          historicalAssignments: history[1].historicalAssignments,
          plannedAssignments: [],
          currencyCode: 'EUR',
        },
        '2026-03'
      );
      const needs = calculateUnderfundedGoals([goal], [row], 'EUR', '2026-03', history);
      const expectedNeed = Math.round(
        type === GoalType.YEARLY || type === GoalType.TARGET_DATE
          ? Math.max(0, progress.monthlyTarget - row.Assigned)
          : progress.amountNeeded
      );
      expect(needs).toHaveLength(1);
      expect(needs[0]).toMatchObject({
        priority: 2,
        needed: expectedNeed,
        target: Math.round(progress.monthlyTarget),
      });
      for (const method of ['proportional-shortfall', 'equal-completion'] as const) {
        const result = prepareUnderfundedAssignments(needs, expectedNeed + 1, [row], method);
        expect(result.batchAssignments).toEqual([
          { categoryId: 1, amount: row.Assigned + expectedNeed },
        ]);
        expect(result.remaining).toBe(1);
      }
    }
  );

  it('ignores out-of-scope and fully funded goals, defaulting legacy category priority', () => {
    const goals: Goal[] = [1, 2].map((id) => ({
      ID: id,
      CategoryID: id,
      Type: GoalType.MONTHLY_SAVINGS,
      Purpose: GoalPurpose.SAVINGS,
      Target: asMilli(100_000),
      StartDate: '2026-01-01',
    }));
    expect(
      calculateUnderfundedGoals(
        goals,
        [{ ...row, FundingPriority: undefined }],
        'EUR',
        '2026-03'
      )[0]
    ).toMatchObject({ categoryId: 1, priority: 3 });
    expect(
      calculateUnderfundedGoals(goals, [{ ...row, Assigned: asMilli(100_000) }], 'EUR', '2026-03')
    ).toEqual([]);
  });
});
