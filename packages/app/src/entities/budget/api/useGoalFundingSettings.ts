import { useMutation } from '@tanstack/react-query';
import { getGoalFundingSettings, type GoalFundingSettings } from '@budgero/core/browser';
import { useRuntime } from '@shared/runtime/runtime-provider';
import { executeSpaceMutation } from '@shared/runtime/mutation-router';
import { useBudgets } from './useBudgets';

export function useGoalFundingSettings(budgetId: number) {
  const query = useBudgets();
  const budget = query.data?.find((item) => item.ID === budgetId);
  return {
    ...getGoalFundingSettings(budget),
    isReady: query.isSuccess && !query.isFetching && !!budget,
  };
}

export function useUpdateGoalFundingSettings() {
  const runtime = useRuntime();
  return useMutation<void, Error, { budgetId: number; settings: Partial<GoalFundingSettings> }>({
    mutationFn: ({ budgetId, settings }) =>
      executeSpaceMutation(runtime, {
        op: 'budgets.updateGoalFundingSettings',
        payload: { id: budgetId, settings },
      }),
  });
}
