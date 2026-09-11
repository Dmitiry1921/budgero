import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Table, TableBody } from '@shared/ui/table';
import { asMilli } from '@shared/lib/currency/milli';
import type { BudgetRow } from '../../lib/budget-transforms';
import { DesktopBudgetCategoryRow } from './DesktopBudgetCategoryRow';

vi.mock('@features/budget-planning/ui/AvailableInfoPopover', () => ({
  AvailableInfoPopover: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@entities/budget/api/useGoalFundingSettings', () => ({
  useGoalFundingSettings: () => ({
    CategoryPriorityMode: 'five-levels',
    ShowCategoryPriorities: true,
    isReady: true,
  }),
}));

const row: BudgetRow = {
  id: 'c1',
  name: 'Groceries',
  assigned: asMilli(100_000),
  activity: asMilli(0),
  available: asMilli(100_000),
  totalTransactions: 0,
  isGroup: false,
  categoryId: 1,
  categoryGroupId: 1,
  parentId: 'g1',
};

function renderRow(onSelect = vi.fn()) {
  render(
    <Table>
      <TableBody>
        <DesktopBudgetCategoryRow
          row={row}
          globalLocalizer={new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })}
          currentMonth="2026-08"
          selectedBudgetId={1}
          onEditCategory={() => {}}
          onDeleteCategory={() => {}}
          onUpdateAssignment={async () => {}}
          onActivityClick={() => {}}
          onSelect={onSelect}
          isSelected={false}
          selectable
        />
      </TableBody>
    </Table>
  );
  return onSelect;
}

describe('DesktopBudgetCategoryRow selection', () => {
  it('passes shift/ctrl modifiers from a row click to onSelect', async () => {
    const user = userEvent.setup();
    const onSelect = renderRow();
    await user.keyboard('{Shift>}');
    await user.click(screen.getByText('Groceries'));
    await user.keyboard('{/Shift}');
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].shiftKey).toBe(true);
    expect(onSelect.mock.calls[0][1]).toBe(row);
  });

  it('shift-clicking the checkbox range-selects (shiftKey forwarded)', async () => {
    const user = userEvent.setup();
    const onSelect = renderRow();
    await user.keyboard('{Shift>}');
    await user.click(screen.getByRole('checkbox'));
    await user.keyboard('{/Shift}');
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].shiftKey).toBe(true);
  });
});
