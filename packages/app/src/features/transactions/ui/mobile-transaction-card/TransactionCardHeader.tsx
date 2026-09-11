import React, { useMemo } from 'react';
import { TransactionSelectionCheckbox } from '@features/transactions/ui/TransactionSelectionCheckbox';
import { Calendar as CalendarIcon, Tag } from 'lucide-react';
import type { GetTransactionsByAccountRow } from '@budgero/core/browser';
import { formatShortDate } from '@shared/lib/date-utils';
import { parseISO } from 'date-fns';
import { asMilli, formatMilli } from '@shared/lib/currency/milli';
import { StatusIndicatorPopover } from '@features/transactions/ui/StatusIndicatorPopover';
import { TransactionLabelBadge } from '@features/transactions/ui/TransactionLabelBadge';

interface TransactionCardHeaderProps {
  transaction: GetTransactionsByAccountRow;
  isSelected: boolean;
  hideSelection?: boolean;
  isFutureTransaction?: boolean;
  displayCategoryOverride?: string;
  accountLocalizer: Intl.NumberFormat;
  onSelectionChange: (checked: boolean) => void;
}

export const TransactionCardHeader = React.memo(function TransactionCardHeader({
  transaction,
  isSelected,
  hideSelection = false,
  isFutureTransaction = false,
  displayCategoryOverride,
  accountLocalizer,
  onSelectionChange,
}: TransactionCardHeaderProps) {
  const displayDate = useMemo(() => {
    const rawDate = transaction.Date;
    if (!rawDate) return 'No date';
    const dateObj = parseISO(rawDate);
    if (isNaN(dateObj.getTime())) return 'No date';
    return formatShortDate(dateObj, { hideCurrentYear: true });
  }, [transaction]);

  const categoryDisplay = displayCategoryOverride || transaction.Category || '';
  return (
    <div className="flex flex-1 items-center gap-2 min-w-0">
      {!hideSelection && (
        <div className="flex-shrink-0">
          <TransactionSelectionCheckbox
            checked={isSelected}
            onCheckedChange={onSelectionChange}
            aria-label={`Select transaction: ${transaction.Memo || 'No memo'} - ${formatMilli(accountLocalizer, asMilli(transaction.InflowConverted > 0 ? transaction.InflowConverted : transaction.OutflowConverted))}`}
            className="rounded-full"
          />
        </div>
      )}

      <div className="flex-1 min-w-0">
        <div className="flex items-start gap-1.5">
          <CalendarIcon className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
          <div className="flex-1 min-w-0 max-w-[10rem] sm:max-w-[14rem] md:max-w-[18rem] min-[1900px]:max-w-[24rem] text-[11px] font-medium leading-tight text-current truncate sm:text-xs min-[1900px]:text-sm">
            {displayDate}
          </div>
          {transaction.Reconciled == true && (
            <StatusIndicatorPopover
              status="reconciled"
              buttonSize="h-6 w-6"
              iconSize="h-3.5 w-3.5"
              contentWidth="w-60"
            />
          )}
          {isFutureTransaction && (
            <StatusIndicatorPopover
              status="future"
              buttonSize="h-6 w-6"
              iconSize="h-3.5 w-3.5"
              contentWidth="w-64"
            />
          )}
        </div>
        <div className="text-xs text-muted-foreground truncate flex items-center gap-2 min-[1900px]:text-sm">
          <span className="inline-flex items-center gap-1 min-w-0 truncate">
            <Tag className="h-3 w-3" />
            <span className="truncate">{categoryDisplay}</span>
          </span>
          {transaction.Label && (
            <TransactionLabelBadge
              label={transaction.Label}
              color={transaction.LabelColor}
              className="max-w-[1.625rem] sm:max-w-[12rem]"
              hideTextOnSmallScreens
            />
          )}
        </div>
      </div>
    </div>
  );
});
