import {
  useGoalFundingSettings,
  useUpdateGoalFundingSettings,
} from '@entities/budget/api/useGoalFundingSettings';
import { useUiStore } from '@shared/store/useUiStore';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@shared/ui/card';
import { Label } from '@shared/ui/label';
import { RadioGroup, RadioGroupItem } from '@shared/ui/radio-group';
import { Switch } from '@shared/ui/switch';
import { toast } from 'sonner';
import type { GoalFundingSettings } from '@budgero/core/browser';

export function GoalFundingSettingsCard() {
  const budgetId = useUiStore((state) => state.selectedBudget?.ID ?? 0);
  const settings = useGoalFundingSettings(budgetId);
  const mutation = useUpdateGoalFundingSettings();
  const disabled = !settings.isReady || mutation.isPending;
  const save = (patch: Partial<GoalFundingSettings>) =>
    mutation.mutate(
      { budgetId, settings: patch },
      {
        onError: () => toast.error('Could not update goal funding settings'),
      }
    );
  return (
    <Card>
      <CardHeader>
        <CardTitle>Goal funding</CardTitle>
        <CardDescription>
          Choose how this budget funds goals. These settings sync across devices.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm font-medium">Priority choices</legend>
          <RadioGroup
            value={settings.CategoryPriorityMode}
            disabled={disabled}
            onValueChange={(value) =>
              save({ CategoryPriorityMode: value as GoalFundingSettings['CategoryPriorityMode'] })
            }
          >
            <div className="flex gap-2 items-center">
              <RadioGroupItem id="priority-five" value="five-levels" />
              <Label htmlFor="priority-five">Five levels (default)</Label>
            </div>
            <div className="flex gap-2 items-center">
              <RadioGroupItem id="priority-numeric" value="numeric" />
              <Label htmlFor="priority-numeric">Any positive whole number</Label>
            </div>
          </RadioGroup>
          <p className="text-xs text-muted-foreground">
            1 is highest. New categories start at 3 — Normal. Switching to five levels sets
            priorities above 5 to 5; you can undo this change.
          </p>
        </fieldset>
        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm font-medium">Sharing within a priority</legend>
          <RadioGroup
            value={settings.GoalFundingDistribution}
            disabled={disabled}
            onValueChange={(value) =>
              save({
                GoalFundingDistribution: value as GoalFundingSettings['GoalFundingDistribution'],
              })
            }
          >
            <div className="flex gap-2 items-center">
              <RadioGroupItem id="fund-proportional" value="proportional-shortfall" />
              <Label htmlFor="fund-proportional">Proportional shortfalls (default)</Label>
            </div>
            <p className="text-xs text-muted-foreground">
              Cover the same fraction of each goal’s remaining need.
            </p>
            <div className="flex gap-2 items-center">
              <RadioGroupItem id="fund-equal" value="equal-completion" />
              <Label htmlFor="fund-equal">Equal completion percentage</Label>
            </div>
            <p className="text-xs text-muted-foreground">
              Help the least-funded goals catch up toward the same percentage of this month’s
              target.
            </p>
          </RadioGroup>
        </fieldset>
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <Label htmlFor="show-priorities">Show priority badges</Label>
            <p className="text-xs text-muted-foreground">
              Show a small badge for categories with a priority other than 3. Funding is unaffected.
            </p>
          </div>
          <Switch
            id="show-priorities"
            checked={settings.ShowCategoryPriorities}
            disabled={disabled}
            onCheckedChange={(ShowCategoryPriorities) => save({ ShowCategoryPriorities })}
          />
        </div>
      </CardContent>
    </Card>
  );
}
