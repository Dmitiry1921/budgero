import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@shared/ui/card';
import { Switch } from '@shared/ui/switch';
import { Label } from '@shared/ui/label';
import { RadioGroup, RadioGroupItem } from '@shared/ui/radio-group';
import { AlertTriangle, Percent, SlidersHorizontal, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import {
  useAllowOverAssignmentPreference,
  useShowGroupPercentPreference,
} from '@shared/hooks/useUserPreferences';
import { useBudgets, useUpdateBudgetRtaMode } from '@entities/budget/api/useBudgets';
import { useUiStore } from '@shared/store/useUiStore';
import { cn } from '@shared/lib/utils';
import { SettingsPageHeader } from '@pages/settings/SettingsPageHeader';
import { IncomeCategoriesCard } from './components/IncomeCategoriesCard';
import { GoalFundingSettingsCard } from './components/GoalFundingSettingsCard';

type RtaMode = 'cumulative' | 'monthly';

const RTA_OPTIONS: { value: RtaMode; title: string; blurb: string }[] = [
  {
    value: 'cumulative',
    title: 'Cumulative',
    blurb:
      'All income and assignments add up across all time, so Ready to Assign is one running total that ignores the month you are viewing. Overspending stays inside the category and carries forward.',
  },
  {
    value: 'monthly',
    title: 'Monthly',
    blurb:
      'Ready to Assign reflects money received through the month you are viewing, minus anything already assigned in future months, and a category’s overspending is pulled out of the next month’s Ready to Assign instead of carrying inside the category. This matches what people moving from YNAB expect.',
  },
];

function RtaModeCard() {
  const selectedBudget = useUiStore((s) => s.selectedBudget);
  const { data: budgets = [] } = useBudgets();
  const updateRtaMode = useUpdateBudgetRtaMode();

  const budgetId = selectedBudget?.ID ?? 0;
  // Read from the live budgets query so the choice reflects the last saved value.
  const activeBudget = budgets.find((b) => b.ID === budgetId) ?? selectedBudget ?? null;
  const mode: RtaMode = activeBudget?.RtaMode === 'monthly' ? 'monthly' : 'cumulative';

  const handleChange = (next: string) => {
    if (!budgetId || next === mode) return;
    updateRtaMode.mutate(
      { id: budgetId, mode: next as RtaMode },
      {
        onSuccess: () =>
          toast.success(
            next === 'monthly'
              ? 'Ready to Assign is now calculated monthly'
              : 'Ready to Assign is now calculated cumulatively'
          ),
        onError: () => toast.error('Could not change the Ready to Assign calculation'),
      }
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Wallet className="h-5 w-5" />
          Ready to Assign calculation
        </CardTitle>
        <CardDescription>
          Choose how this budget computes Ready to Assign. Switching is instant and non-destructive
          — it only changes the math, never your transactions or assignments.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <RadioGroup
          value={mode}
          onValueChange={handleChange}
          className="gap-3"
          disabled={!budgetId || updateRtaMode.isPending}
        >
          {RTA_OPTIONS.map((opt) => (
            <label
              key={opt.value}
              htmlFor={`rta-${opt.value}`}
              className={cn(
                'flex cursor-pointer items-start gap-3 rounded-lg border p-4 transition',
                mode === opt.value ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'
              )}
            >
              <RadioGroupItem id={`rta-${opt.value}`} value={opt.value} className="mt-1" />
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{opt.title}</span>
                  {opt.value === 'cumulative' && (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                      Default
                    </span>
                  )}
                </div>
                <p className="text-sm text-muted-foreground">{opt.blurb}</p>
              </div>
            </label>
          ))}
        </RadioGroup>

        <div className="rounded-lg border bg-muted/50 p-4">
          <h4 className="mb-2 text-sm font-medium">Which should I pick?</h4>
          <ul className="list-inside list-disc space-y-2 text-sm text-muted-foreground">
            <li>
              <strong className="text-foreground">Cumulative</strong> is best if you think of the
              budget as one continuous pool and don’t mind Ready to Assign staying the same across
              months.
            </li>
            <li>
              <strong className="text-foreground">Monthly</strong> is best if you’re coming from
              YNAB or want each month to stand on its own — income counts as it arrives, money
              assigned in future months is already spoken for, and last month’s overspending reduces
              this month’s Ready to Assign.
            </li>
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}

function GroupPercentCard() {
  const { showGroupPercent, isLoading, updateShowGroupPercent, isUpdating } =
    useShowGroupPercentPreference();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Percent className="h-5 w-5" />
          Category Group Percentages
        </CardTitle>
        <CardDescription>
          See how your month&apos;s budget is split across category groups, e.g. Needs 50% / Wants
          30% / Savings 20%.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <Label htmlFor="show-group-percent" className="font-medium">
              Show percentage of assigned on group rows
            </Label>
            <p className="text-sm text-muted-foreground max-w-md">
              Each category group on the Planning page shows its share of everything assigned in the
              selected month, next to its allocated total.
            </p>
          </div>
          <Switch
            id="show-group-percent"
            checked={showGroupPercent}
            onCheckedChange={(checked) => updateShowGroupPercent(checked)}
            disabled={isLoading || isUpdating}
            className={cn(isUpdating && 'opacity-50 cursor-not-allowed')}
          />
        </div>
      </CardContent>
    </Card>
  );
}

export default function BudgetSettingsPage() {
  const { allowOverAssignment, isLoading, updateAllowOverAssignment, isUpdating } =
    useAllowOverAssignmentPreference();

  const handleToggle = (checked: boolean) => {
    updateAllowOverAssignment(checked);
  };

  return (
    <div className="container max-w-4xl mx-auto p-4 sm:p-6 pb-20 sm:pb-6 space-y-6 sm:space-y-8">
      <SettingsPageHeader
        title="Budget Settings"
        description="Manage income categories, budget calculations, and assignment preferences."
      />

      <RtaModeCard />
      <GoalFundingSettingsCard />

      <IncomeCategoriesCard />

      <GroupPercentCard />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <SlidersHorizontal className="h-5 w-5" />
            Assignment Behavior
          </CardTitle>
          <CardDescription>
            Control whether Budgero enforces the Ready to Assign limit when funding categories.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <Label htmlFor="allow-over-assignment" className="font-medium">
                  Allow over-assignment
                </Label>
                {allowOverAssignment && (
                  <span className="inline-flex items-center rounded-full bg-yellow-100 px-2 py-0.5 text-xs font-medium text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200">
                    <AlertTriangle className="mr-1 h-3 w-3" />
                    Enabled
                  </span>
                )}
              </div>
              <p className="text-sm text-muted-foreground max-w-md">
                When enabled, you can assign more money to categories than you have available in
                Ready to Assign. This will result in a negative Ready to Assign amount.
              </p>
            </div>
            <Switch
              id="allow-over-assignment"
              checked={allowOverAssignment}
              onCheckedChange={handleToggle}
              disabled={isLoading || isUpdating}
              className={cn(
                'data-[state=checked]:bg-yellow-500',
                isUpdating && 'opacity-50 cursor-not-allowed'
              )}
            />
          </div>

          <div className="rounded-lg border bg-muted/50 p-4">
            <h4 className="text-sm font-medium mb-2">What this means</h4>
            <ul className="text-sm text-muted-foreground space-y-2 list-disc list-inside">
              <li>
                <strong className="text-foreground">Disabled (default):</strong> Budgero prevents
                you from assigning more than your Ready to Assign amount. You must have cash
                available before funding categories.
              </li>
              <li>
                <strong className="text-foreground">Enabled:</strong> You can assign any amount to
                categories regardless of Ready to Assign. This creates negative Ready to Assign,
                indicating you&apos;ve assigned more money than you currently have.
              </li>
            </ul>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
