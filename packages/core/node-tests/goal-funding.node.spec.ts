import { describe, expect, it } from 'vitest';
import {
  allocateGoalFunding,
  type GoalFundingDistribution,
  type GoalFundingNeed,
} from '../src/services/goals/funding';

const need = (
  categoryId: number,
  needed: number,
  target = needed,
  priority = 3
): GoalFundingNeed => ({ categoryId, needed, target, priority });
const methods: GoalFundingDistribution[] = ['proportional-shortfall', 'equal-completion'];

describe('priority goal allocator', () => {
  it.each(methods)('fully covers higher tiers and ignores visual order: %s', (method) => {
    const goals = [need(1, 100, 100, 4), need(2, 60, 100, 1), need(3, 60, 100, 1)];
    expect(allocateGoalFunding(goals, 150, method)).toEqual([
      { categoryId: 1, amount: 30 },
      { categoryId: 2, amount: 60 },
      { categoryId: 3, amount: 60 },
    ]);
    expect(allocateGoalFunding(goals, 90, method)).toEqual([
      { categoryId: 2, amount: 45 },
      { categoryId: 3, amount: 45 },
    ]);
    expect(allocateGoalFunding([...goals].reverse(), 90, method)).toEqual(
      allocateGoalFunding(goals, 90, method)
    );
  });

  it('matches the partial funding example for both methods', () => {
    const goals = [need(1, 20_000, 100_000), need(2, 100_000, 100_000)];
    expect(allocateGoalFunding(goals, 60_000, 'proportional-shortfall')).toEqual([
      { categoryId: 1, amount: 10_000 },
      { categoryId: 2, amount: 50_000 },
    ]);
    expect(allocateGoalFunding(goals, 60_000, 'equal-completion')).toEqual([
      { categoryId: 2, amount: 60_000 },
    ]);
    expect(allocateGoalFunding(goals, 100_000, 'equal-completion')).toEqual([
      { categoryId: 1, amount: 10_000 },
      { categoryId: 2, amount: 90_000 },
    ]);
  });

  it('equalizes ratios for different targets after catching up', () => {
    expect(
      allocateGoalFunding([need(1, 50, 100), need(2, 200, 200)], 130, 'equal-completion')
    ).toEqual([
      { categoryId: 1, amount: 10 },
      { categoryId: 2, amount: 120 },
    ]);
  });

  it('recovers negative progress before funding categories already at zero', () => {
    const goals = [need(1, 150, 100), need(2, 100, 100)];
    expect(allocateGoalFunding(goals, 40, 'equal-completion')).toEqual([
      { categoryId: 1, amount: 40 },
    ]);
    expect(allocateGoalFunding(goals, 70, 'equal-completion')).toEqual([
      { categoryId: 1, amount: 60 },
      { categoryId: 2, amount: 10 },
    ]);
  });

  it('falls back to proportional shortfalls for a tier with nonpositive targets', () => {
    const goals = [need(1, 20, 0), need(2, 100, 100)];
    expect(allocateGoalFunding(goals, 60, 'equal-completion')).toEqual([
      { categoryId: 1, amount: 10 },
      { categoryId: 2, amount: 50 },
    ]);
  });

  it.each(methods)(
    'caps funding, handles empty/zero allowances, and rounds ties by ID: %s',
    (method) => {
      const goals = [need(3, 1), need(1, 1), need(2, 1)];
      expect(allocateGoalFunding(goals, 2, method)).toEqual([
        { categoryId: 1, amount: 1 },
        { categoryId: 2, amount: 1 },
      ]);
      expect(allocateGoalFunding(goals, 10, method).reduce((sum, a) => sum + a.amount, 0)).toBe(3);
      expect(allocateGoalFunding(goals, 0, method)).toEqual([]);
      expect(allocateGoalFunding(goals, -1, method)).toEqual([]);
      expect(allocateGoalFunding([], 100, method)).toEqual([]);
    }
  );

  it.each(methods)(
    'conserves exact milliunits across varied tiers, deficits and reordering: %s',
    (method) => {
      for (let seed = 1; seed <= 200; seed++) {
        const goals = Array.from({ length: 7 }, (_, i) =>
          need(i + 1, (seed * (i + 11)) % 103, ((seed * (i + 7)) % 81) + 1, ((seed + i) % 3) + 1)
        );
        const allowance = seed * 3;
        const allocations = allocateGoalFunding(goals, allowance, method);
        expect(allocations).toEqual(allocateGoalFunding([...goals].reverse(), allowance, method));
        expect(allocations.reduce((sum, a) => sum + a.amount, 0)).toBe(
          Math.min(
            allowance,
            goals.reduce((sum, g) => sum + g.needed, 0)
          )
        );
        for (const allocation of allocations) {
          const goal = goals.find((g) => g.categoryId === allocation.categoryId)!;
          expect(Number.isSafeInteger(allocation.amount)).toBe(true);
          expect(allocation.amount).toBeGreaterThan(0);
          expect(allocation.amount).toBeLessThanOrEqual(goal.needed);
          for (const earlier of goals.filter((g) => g.priority < goal.priority)) {
            expect(allocations.find((a) => a.categoryId === earlier.categoryId)?.amount ?? 0).toBe(
              earlier.needed
            );
          }
        }
      }
    }
  );

  it.each(methods)('avoids precision loss in intermediate multiplications: %s', (method) => {
    const max = Number.MAX_SAFE_INTEGER;
    expect(allocateGoalFunding([need(2, max), need(1, max)], max, method)).toEqual([
      { categoryId: 1, amount: 4_503_599_627_370_496 },
      { categoryId: 2, amount: 4_503_599_627_370_495 },
    ]);
  });

  it('rejects unsafe or fractional amounts and priorities', () => {
    for (const priority of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        allocateGoalFunding([need(1, 100, 100, priority)], 10, 'equal-completion')
      ).toThrow();
    }
    expect(() => allocateGoalFunding([need(1, 1.5)], 10, 'equal-completion')).toThrow();
    expect(() => allocateGoalFunding([need(1, 1), need(1, 1)], 10, 'equal-completion')).toThrow();
  });
});
