export type CategoryPriorityMode = 'five-levels' | 'numeric';
export type GoalFundingDistribution = 'proportional-shortfall' | 'equal-completion';

export interface GoalFundingSettings {
  CategoryPriorityMode: CategoryPriorityMode;
  GoalFundingDistribution: GoalFundingDistribution;
  ShowCategoryPriorities: boolean;
}

export const DEFAULT_FUNDING_PRIORITY = 3;

export interface FundingPriorityUpdate {
  categoryId: number;
  priority: number;
}

/** Also handles SQLite booleans and records from older backups. */
export function getGoalFundingSettings(
  budget?:
    | (Partial<Omit<GoalFundingSettings, 'ShowCategoryPriorities'>> & {
        ShowCategoryPriorities?: boolean | number;
      })
    | null
): GoalFundingSettings {
  return {
    CategoryPriorityMode: budget?.CategoryPriorityMode === 'numeric' ? 'numeric' : 'five-levels',
    GoalFundingDistribution:
      budget?.GoalFundingDistribution === 'equal-completion'
        ? 'equal-completion'
        : 'proportional-shortfall',
    ShowCategoryPriorities:
      budget?.ShowCategoryPriorities !== false && budget?.ShowCategoryPriorities !== 0,
  };
}

export function isValidFundingPriority(
  value: unknown,
  mode: CategoryPriorityMode
): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    (mode === 'numeric' || value <= 5)
  );
}

export interface GoalFundingNeed {
  categoryId: number;
  priority: number;
  needed: number;
  target: number;
}

export interface GoalFundingAllocation {
  categoryId: number;
  amount: number;
}

/** Exact largest-remainder apportionment. Category ID only breaks sub-milli ties. */
function apportion(
  entries: { goal: GoalFundingNeed; numerator: bigint }[],
  denominator: bigint,
  allowance: number
): GoalFundingAllocation[] {
  const shares = entries.map(({ goal, numerator }) => ({
    categoryId: goal.categoryId,
    amount: Number(numerator / denominator),
    remainder: numerator % denominator,
  }));
  let remaining = allowance - shares.reduce((sum, share) => sum + share.amount, 0);
  shares.sort((a, b) =>
    a.remainder === b.remainder ? a.categoryId - b.categoryId : a.remainder > b.remainder ? -1 : 1
  );
  for (const share of shares) {
    if (remaining <= 0) break;
    share.amount += 1;
    remaining -= 1;
  }
  return shares
    .filter((share) => share.amount > 0)
    .map(({ categoryId, amount }) => ({ categoryId, amount }));
}

function allocateTier(
  goals: GoalFundingNeed[],
  allowance: number,
  distribution: GoalFundingDistribution
) {
  if (distribution === 'proportional-shortfall' || goals.some((goal) => goal.target <= 0)) {
    const total = goals.reduce((sum, goal) => sum + BigInt(goal.needed), 0n);
    return apportion(
      goals.map((goal) => ({
        goal,
        numerator: BigInt(allowance) * BigInt(goal.needed),
      })),
      total,
      allowance
    );
  }

  // Raise the lowest completion ratios together, adding another category when
  // their waterline reaches it. Negative progress represents an existing deficit.
  const sorted = goals
    .map((goal) => ({
      goal,
      funded: BigInt(goal.target) - BigInt(goal.needed),
      target: BigInt(goal.target),
    }))
    .sort((a, b) => {
      const difference = a.funded * b.target - b.funded * a.target;
      return difference === 0n ? a.goal.categoryId - b.goal.categoryId : difference < 0n ? -1 : 1;
    });
  let funded = 0n;
  let target = 0n;
  const active: typeof sorted = [];
  for (let index = 0; index < sorted.length; index += 1) {
    const entry = sorted[index];
    active.push(entry);
    funded += entry.funded;
    target += entry.target;
    const next = sorted[index + 1];
    if (!next || (BigInt(allowance) + funded) * next.target <= next.funded * target) break;
  }
  return apportion(
    active.map((entry) => ({
      goal: entry.goal,
      numerator: (BigInt(allowance) + funded) * entry.target - entry.funded * target,
    })),
    target,
    allowance
  );
}

/** Pure allocator: inputs and outputs are integer budget-currency milliunits. */
export function allocateGoalFunding(
  needs: GoalFundingNeed[],
  allowance: number,
  distribution: GoalFundingDistribution
): GoalFundingAllocation[] {
  if (!Number.isSafeInteger(allowance))
    throw new Error('Funding allowance must be integer milliunits');
  if (allowance <= 0) return [];
  const seen = new Set<number>();
  for (const goal of needs) {
    if (
      !Number.isSafeInteger(goal.needed) ||
      goal.needed < 0 ||
      !Number.isSafeInteger(goal.target) ||
      !isValidFundingPriority(goal.priority, 'numeric') ||
      !Number.isSafeInteger(goal.categoryId) ||
      goal.categoryId <= 0 ||
      seen.has(goal.categoryId)
    ) {
      throw new Error('Invalid or duplicate goal funding input');
    }
    seen.add(goal.categoryId);
  }
  const priorities = [...new Set(needs.map((goal) => goal.priority))].sort((a, b) => a - b);
  const allocations: GoalFundingAllocation[] = [];
  let remaining = allowance;
  for (const priority of priorities) {
    if (remaining <= 0) break;
    const tier = needs.filter((goal) => goal.priority === priority && goal.needed > 0);
    const total = tier.reduce((sum, goal) => sum + BigInt(goal.needed), 0n);
    if (total <= BigInt(remaining)) {
      allocations.push(
        ...tier.map((goal) => ({ categoryId: goal.categoryId, amount: goal.needed }))
      );
      remaining -= Number(total);
    } else {
      allocations.push(...allocateTier(tier, remaining, distribution));
      remaining = 0;
    }
  }
  return allocations.sort((a, b) => a.categoryId - b.categoryId);
}
