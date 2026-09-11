import { useId } from 'react';
import type { CategoryPriorityMode } from '@budgero/core/browser';
import { Input } from '@shared/ui/input';
import { Label } from '@shared/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@shared/ui/select';

const FUNDING_PRIORITY_LABELS = ['Highest', 'High', 'Normal', 'Low', 'Lowest'];

export function FundingPriorityInput({
  value,
  onChange,
  mode,
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  mode: CategoryPriorityMode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>Funding priority</Label>
      {mode === 'five-levels' ? (
        <Select value={value} onValueChange={onChange} disabled={disabled}>
          <SelectTrigger id={id}>
            <SelectValue placeholder="Mixed" />
          </SelectTrigger>
          <SelectContent>
            {FUNDING_PRIORITY_LABELS.map((label, index) => (
              <SelectItem key={label} value={String(index + 1)}>
                {index + 1} — {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Input
          id={id}
          type="number"
          min={1}
          max={Number.MAX_SAFE_INTEGER}
          step={1}
          value={value}
          placeholder="Mixed"
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
        />
      )}
      <p className="text-xs text-muted-foreground">Lower numbers are funded first.</p>
    </div>
  );
}
