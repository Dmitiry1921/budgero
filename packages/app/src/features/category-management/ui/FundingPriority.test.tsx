import { CategoryRowTableLayout } from '@features/budget-planning/ui/category-row/CategoryRowTableLayout';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  CategoryRowHeader,
  DesktopCompactHeader,
} from '@features/budget-planning/ui/category-row/CategoryRowHeader';
import type { BudgetRow } from '@features/budget-planning/lib/budget-transforms';
import { asMilli } from '@shared/lib/currency/milli';
import { FundingPriorityEditor } from './FundingPriorityEditor';
import { FundingPriorityBadge } from './FundingPriorityBadge';
import { CategoryEditDialog } from './CategoryEditDialog';

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  mode: 'numeric',
  ready: true,
  show: true,
  pending: false,
}));
vi.mock('@entities/budget/api/useGoalFundingSettings', () => ({
  useGoalFundingSettings: () => ({
    CategoryPriorityMode: mocks.mode,
    ShowCategoryPriorities: mocks.show,
    isReady: mocks.ready,
  }),
}));
vi.mock('@entities/category/api/useCategories', () => ({
  useUpdateFundingPriorities: () => ({ mutateAsync: mocks.save, isPending: mocks.pending }),
}));
vi.mock('@features/budget-planning/ui/category-row/AvailableCell', () => ({
  AvailableCell: () => null,
}));
vi.mock('@features/budget-planning/ui/category-row/AllocatedCell', () => ({
  AllocatedCell: () => null,
}));
vi.mock('@features/budget-planning/ui/category-row/ActivityButton', () => ({
  ActivityButton: () => null,
}));
vi.mock('@features/goal-management', () => ({ GoalSection: () => null }));
beforeAll(() => {
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.scrollIntoView = () => {};
});
beforeEach(() => {
  mocks.save.mockReset().mockResolvedValue(undefined);
  mocks.mode = 'numeric';
  mocks.ready = true;
  mocks.show = true;
  mocks.pending = false;
});
const row: BudgetRow = {
  id: 'c1',
  categoryId: 1,
  categoryGroupId: 1,
  name: 'Rent',
  fundingPriority: 1,
  assigned: asMilli(0),
  activity: asMilli(0),
  available: asMilli(0),
  isGroup: false,
  totalTransactions: 0,
};

describe('funding priority controls', () => {
  it('shows mixed selection and applies numeric values only on explicit Apply', async () => {
    render(<FundingPriorityEditor budgetId={7} categoryIds={[1, 2]} priority={null} />);
    const input = screen.getByRole('spinbutton', { name: 'Funding priority' });
    expect(input).toHaveAttribute('placeholder', 'Mixed');
    fireEvent.change(input, { target: { value: '8' } });
    expect(mocks.save).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Apply priority' }));
    expect(mocks.save).toHaveBeenCalledWith({ budgetId: 7, categoryIds: [1, 2], priority: 8 });
  });
  it.each(['0', '-1', '1.5', '9007199254740992', ''])(
    'rejects invalid numeric priority %s',
    async (value) => {
      render(<FundingPriorityEditor budgetId={7} categoryIds={[1]} priority={3} />);
      fireEvent.change(screen.getByRole('spinbutton'), { target: { value } });
      await userEvent.click(screen.getByRole('button', { name: 'Apply priority' }));
      expect(mocks.save).not.toHaveBeenCalled();
      expect(screen.getByRole('alert')).toBeInTheDocument();
    }
  );
  it('keeps failed drafts available for retry and reports the failure', async () => {
    mocks.save.mockRejectedValueOnce(new Error('Unable to save'));
    render(<FundingPriorityEditor budgetId={7} categoryIds={[1]} priority={3} />);
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '7' } });
    await userEvent.click(screen.getByRole('button', { name: 'Apply priority' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to save');
    expect(screen.getByRole('spinbutton')).toHaveValue(7);
    await userEvent.click(screen.getByRole('button', { name: 'Apply priority' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });
  it.each([CategoryRowHeader, DesktopCompactHeader])(
    'exposes named priorities directly in row menus',
    async (Header) => {
      mocks.mode = 'five-levels';
      render(
        <Header item={row} budgetId={7} onEditCategory={vi.fn()} onDeleteCategory={vi.fn()} />
      );
      expect(screen.getByText('P1')).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button'));
      await userEvent.click(screen.getByRole('combobox', { name: 'Funding priority' }));
      await userEvent.click(screen.getByRole('option', { name: '2 — High' }));
      expect(mocks.save).toHaveBeenCalledWith({ budgetId: 7, categoryIds: [1], priority: 2 });
    }
  );
  it('shows badges and edits priorities in the expanded mobile table layout', async () => {
    const noop = vi.fn();
    const mobile = () => (
      <CategoryRowTableLayout
        item={row}
        isExpanded
        isHighlighted={false}
        isSelected={false}
        globalLocalizer={new Intl.NumberFormat('en', { style: 'currency', currency: 'EUR' })}
        currentMonth="2026-09"
        selectedBudgetId={7}
        highlightAllocated={false}
        highlightGoalSection={false}
        onEditCategory={noop}
        onDeleteCategory={noop}
        onUpdateAssignment={async () => {}}
        onActivityClick={noop}
        setIsEditingAllocated={noop}
        moveOpen={false}
        setMoveOpen={noop}
        moveAmount={asMilli(0)}
        setMoveAmount={noop}
        moveTarget={null}
        setMoveTarget={noop}
        initMovePopover={noop}
        confirmMove={async () => {}}
        handlePointerDown={noop}
        handlePointerUp={noop}
        handlePointerLeave={noop}
        handlePointerCancel={noop}
        handleClick={noop}
      />
    );
    const { rerender } = render(mobile());
    expect(screen.getByText('P1')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '12' } });
    await userEvent.click(screen.getByRole('button', { name: 'Apply priority' }));
    expect(mocks.save).toHaveBeenCalledWith({ budgetId: 7, categoryIds: [1], priority: 12 });
    mocks.show = false;
    rerender(mobile());
    expect(screen.queryByText('P1')).not.toBeInTheDocument();
    expect(screen.getByRole('spinbutton')).toBeInTheDocument();
  });

  it('hides normal badges and respects the visibility toggle', () => {
    const { rerender } = render(<FundingPriorityBadge budgetId={7} priority={3} />);
    expect(screen.queryByText('P3')).not.toBeInTheDocument();
    rerender(<FundingPriorityBadge budgetId={7} priority={27} />);
    expect(screen.getByText('P27')).toBeInTheDocument();
    mocks.show = false;
    rerender(<FundingPriorityBadge budgetId={7} priority={27} />);
    expect(screen.queryByText('P27')).not.toBeInTheDocument();
  });
  it('saves name, pace and priority from Edit Category together', async () => {
    const save = vi.fn();
    render(
      <CategoryEditDialog
        open
        onClose={vi.fn()}
        categoryName="Rent"
        budgetId={7}
        fundingPriority={3}
        excludeFromBudgetPace={false}
        onSave={save}
      />
    );
    await act(async () => {});
    fireEvent.change(screen.getByRole('textbox', { name: 'Category Name' }), {
      target: { value: 'Mortgage' },
    });
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '8' } });
    await userEvent.click(screen.getByRole('switch'));
    await userEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(save).toHaveBeenCalledWith('Mortgage', true, 8);
  });
  it('disables priority editing until settings have loaded', () => {
    mocks.ready = false;
    render(<FundingPriorityEditor budgetId={7} categoryIds={[1]} priority={3} />);
    expect(screen.getByRole('spinbutton')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Apply priority' })).toBeDisabled();
  });
});
