import { useGoalFundingSettings } from '@entities/budget/api/useGoalFundingSettings';

export function FundingPriorityBadge({
  budgetId,
  priority = 3,
}: {
  budgetId: number;
  priority?: number;
}) {
  const settings = useGoalFundingSettings(budgetId);
  if (!settings.isReady || !settings.ShowCategoryPriorities || priority === 3) return null;
  return (
    <span
      className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] font-medium text-muted-foreground tabular-nums"
      title={`Funding priority ${priority}`}
      aria-label={`Funding priority ${priority}`}
    >
      P{priority}
    </span>
  );
}
