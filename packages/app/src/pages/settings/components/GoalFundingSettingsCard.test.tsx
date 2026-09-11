import { render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PropsWithChildren } from 'react';
import { useGoalFundingSettings } from '@entities/budget/api/useGoalFundingSettings';
import { useUiStore } from '@shared/store/useUiStore';
import type { Budget } from '@budgero/core/browser';
import { GoalFundingSettingsCard } from './GoalFundingSettingsCard';

const mock = vi.hoisted(() => ({
  execute: vi.fn(),
  success: true,
  fetching: false,
  budgets: [
    {
      ID: 1,
      CategoryPriorityMode: 'five-levels',
      GoalFundingDistribution: 'proportional-shortfall',
      ShowCategoryPriorities: true,
    },
    {
      ID: 2,
      CategoryPriorityMode: 'numeric',
      GoalFundingDistribution: 'equal-completion',
      ShowCategoryPriorities: false,
    },
  ],
}));
vi.mock('@entities/budget/api/useBudgets', () => ({
  useBudgets: () => ({ data: mock.budgets, isSuccess: mock.success, isFetching: mock.fetching }),
}));
vi.mock('@shared/runtime/runtime-provider', () => ({ useRuntime: () => ({}) }));
vi.mock('@shared/runtime/mutation-router', () => ({
  executeSpaceMutation: (...args: unknown[]) => mock.execute(...args),
}));

beforeEach(() => {
  mock.execute.mockReset().mockResolvedValue(undefined);
  mock.success = true;
  mock.fetching = false;
  useUiStore.setState({ selectedBudget: { ID: 1, CategoryPriorityMode: 'numeric' } as Budget });
});
const wrapper = ({ children }: PropsWithChildren) => (
  <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
);

describe('per-budget goal funding settings', () => {
  it('reads live budgets instead of stale selected-budget fields and follows budget changes', () => {
    const { result, rerender } = renderHook(({ id }) => useGoalFundingSettings(id), {
      initialProps: { id: 1 },
    });
    expect(result.current).toMatchObject({ CategoryPriorityMode: 'five-levels', isReady: true });
    rerender({ id: 2 });
    expect(result.current).toMatchObject({
      CategoryPriorityMode: 'numeric',
      ShowCategoryPriorities: false,
    });
    rerender({ id: 999 });
    expect(result.current.isReady).toBe(false);
    mock.fetching = true;
    rerender({ id: 1 });
    expect(result.current.isReady).toBe(false);
  });

  it('saves settings through mutations scoped to the selected budget', async () => {
    render(<GoalFundingSettingsCard />, { wrapper });
    expect(screen.getByRole('radio', { name: 'Five levels (default)' })).toBeChecked();
    expect(screen.getByText(/Switching to five levels/)).toHaveTextContent('above 5 to 5');
    await userEvent.click(screen.getByRole('radio', { name: 'Any positive whole number' }));
    expect(mock.execute).toHaveBeenLastCalledWith(
      {},
      {
        op: 'budgets.updateGoalFundingSettings',
        payload: { id: 1, settings: { CategoryPriorityMode: 'numeric' } },
      }
    );
    await userEvent.click(screen.getByRole('radio', { name: 'Equal completion percentage' }));
    expect(mock.execute).toHaveBeenLastCalledWith(
      {},
      {
        op: 'budgets.updateGoalFundingSettings',
        payload: { id: 1, settings: { GoalFundingDistribution: 'equal-completion' } },
      }
    );
    await userEvent.click(screen.getByRole('switch', { name: 'Show priority badges' }));
    expect(mock.execute).toHaveBeenLastCalledWith(
      {},
      {
        op: 'budgets.updateGoalFundingSettings',
        payload: { id: 1, settings: { ShowCategoryPriorities: false } },
      }
    );
  });
});
