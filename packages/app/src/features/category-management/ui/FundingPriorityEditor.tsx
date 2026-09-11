import { useState } from 'react';
import { isValidFundingPriority } from '@budgero/core/browser';
import { useGoalFundingSettings } from '@entities/budget/api/useGoalFundingSettings';
import { useUpdateFundingPriorities } from '@entities/category/api/useCategories';
import { Button } from '@shared/ui/button';
import { FundingPriorityInput } from './FundingPriorityInput';

interface Props {
  budgetId: number;
  categoryIds: number[];
  priority: number | null;
}

export function FundingPriorityEditor(props: Props) {
  const settings = useGoalFundingSettings(props.budgetId);
  return (
    <PriorityEditor
      key={JSON.stringify([
        props.budgetId,
        props.categoryIds,
        props.priority,
        settings.CategoryPriorityMode,
      ])}
      {...props}
      settings={settings}
    />
  );
}

function PriorityEditor({
  budgetId,
  categoryIds,
  priority,
  settings,
}: Props & {
  settings: ReturnType<typeof useGoalFundingSettings>;
}) {
  const [value, setValue] = useState(priority === null ? '' : String(priority));
  const [error, setError] = useState('');
  const mutation = useUpdateFundingPriorities();
  const save = async (raw: string) => {
    const next = Number(raw);
    if (!isValidFundingPriority(next, settings.CategoryPriorityMode)) {
      setError('Enter a positive whole number.');
      return;
    }
    setError('');
    try {
      await mutation.mutateAsync({ budgetId, categoryIds, priority: next });
    } catch (cause) {
      if (settings.CategoryPriorityMode === 'five-levels')
        setValue(priority === null ? '' : String(priority));
      setError(cause instanceof Error ? cause.message : 'Could not change funding priority.');
    }
  };
  return (
    <div
      role="presentation"
      className="space-y-2 min-w-0"
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <FundingPriorityInput
        value={value}
        mode={settings.CategoryPriorityMode}
        disabled={!settings.isReady || mutation.isPending}
        onChange={(next) => {
          setValue(next);
          if (settings.CategoryPriorityMode === 'five-levels') void save(next);
        }}
      />
      {settings.CategoryPriorityMode === 'numeric' && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!settings.isReady || mutation.isPending || !categoryIds.length}
          onClick={() => void save(value)}
        >
          {mutation.isPending ? 'Saving…' : 'Apply priority'}
        </Button>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
