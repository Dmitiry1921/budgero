import { act, render, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useUiStore } from '@shared/store/useUiStore';
import { RateResync } from './RateResync';

const mocks = vi.hoisted(() => ({
  refreshOfficialRates: vi.fn(),
  resyncPendingConversions: vi.fn(),
  revalueAccounts: vi.fn(),
  finalizeOutOfBandMutation: vi.fn(),
  invalidateQueries: vi.fn(),
  getResyncRatesOnReconnect: vi.fn(),
}));
const queryClient = { invalidateQueries: mocks.invalidateQueries };
const services = { currency: mocks, userMeta: mocks };
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => queryClient }));
vi.mock('@shared/runtime/global', () => ({
  getRuntime: () => ({
    services: () => services,
    servicesReady: () => true,
    getActiveSpaceId: () => useUiStore.getState().selectedBudget?.SpaceID,
    finalizeOutOfBandMutation: mocks.finalizeOutOfBandMutation,
  }),
}));

beforeEach(() => {
  vi.resetAllMocks();
  window.localStorage.clear();
  mocks.refreshOfficialRates.mockResolvedValue(undefined);
  mocks.resyncPendingConversions.mockResolvedValue(0);
  mocks.revalueAccounts.mockResolvedValue(0);
  mocks.finalizeOutOfBandMutation.mockResolvedValue({});
  mocks.getResyncRatesOnReconnect.mockReturnValue(true);
  useUiStore.setState({
    selectedBudget: {
      ID: 1,
      SpaceID: 'space-a',
      Name: 'A',
      DisplayCurrency: 'USD',
      BadgeIcon: '',
      NumberFormat: '$1,096.56',
      RtaMode: 'cumulative',
    },
  });
});
afterEach(cleanup);

it('continues reconciliation after a provider failure and retries refresh on reconnect', async () => {
  mocks.refreshOfficialRates.mockRejectedValueOnce(new Error('provider unavailable'));
  mocks.revalueAccounts.mockResolvedValue(1);
  render(<RateResync />);
  await waitFor(() => expect(mocks.finalizeOutOfBandMutation).toHaveBeenCalledOnce());
  expect(mocks.resyncPendingConversions).toHaveBeenCalledWith(1);
  expect(mocks.revalueAccounts).toHaveBeenCalledWith(1);
  expect(window.localStorage.length).toBe(0);
  act(() => window.dispatchEvent(new Event('online')));
  await waitFor(() => expect(mocks.finalizeOutOfBandMutation).toHaveBeenCalledTimes(2));
  expect(mocks.refreshOfficialRates).toHaveBeenCalledTimes(2);
});

it('refreshes another space with the same budget ID without remounting', async () => {
  render(<RateResync />);
  await waitFor(() => expect(mocks.finalizeOutOfBandMutation).toHaveBeenCalledOnce());
  act(() =>
    useUiStore.setState({
      selectedBudget: { ...useUiStore.getState().selectedBudget!, SpaceID: 'space-b', Name: 'B' },
    })
  );
  await waitFor(() => expect(mocks.finalizeOutOfBandMutation).toHaveBeenCalledTimes(2));
  expect(mocks.refreshOfficialRates).toHaveBeenCalledTimes(2);
  expect(window.localStorage.getItem('budgero:official-rate-refresh:space-a:1')).not.toBeNull();
  expect(window.localStorage.getItem('budgero:official-rate-refresh:space-b:1')).not.toBeNull();
});

it('keeps the daily limit across remounts but still reconciles cached rates', async () => {
  const view = render(<RateResync />);
  await waitFor(() => expect(mocks.finalizeOutOfBandMutation).toHaveBeenCalledOnce());
  view.unmount();
  render(<RateResync />);
  await waitFor(() => expect(mocks.revalueAccounts).toHaveBeenCalledTimes(2));
  expect(mocks.refreshOfficialRates).toHaveBeenCalledOnce();
  expect(mocks.resyncPendingConversions).toHaveBeenCalledTimes(2);
});

it('does not mark a refresh complete before persistence succeeds', async () => {
  mocks.finalizeOutOfBandMutation.mockRejectedValueOnce(new Error('storage unavailable'));
  render(<RateResync />);
  await waitFor(() => expect(mocks.finalizeOutOfBandMutation).toHaveBeenCalledOnce());
  expect(window.localStorage.length).toBe(0);
  act(() => window.dispatchEvent(new Event('online')));
  await waitFor(() => expect(mocks.finalizeOutOfBandMutation).toHaveBeenCalledTimes(2));
  expect(mocks.refreshOfficialRates).toHaveBeenCalledTimes(2);
});

it('discards an old space’s completion after switching spaces during a refresh', async () => {
  let finishOldRefresh!: () => void;
  mocks.refreshOfficialRates.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishOldRefresh = resolve;
      })
  );
  render(<RateResync />);
  await waitFor(() => expect(mocks.refreshOfficialRates).toHaveBeenCalledOnce());
  act(() =>
    useUiStore.setState({
      selectedBudget: { ...useUiStore.getState().selectedBudget!, SpaceID: 'space-b' },
    })
  );
  await waitFor(() => expect(mocks.finalizeOutOfBandMutation).toHaveBeenCalledOnce());
  await act(async () => finishOldRefresh());
  expect(mocks.refreshOfficialRates).toHaveBeenCalledTimes(2);
  expect(mocks.resyncPendingConversions).toHaveBeenCalledOnce();
  expect(mocks.finalizeOutOfBandMutation).toHaveBeenCalledOnce();
  expect(window.localStorage.getItem('budgero:official-rate-refresh:space-a:1')).toBeNull();
});

it('respects the opt-out for pending conversions while refreshing balances', async () => {
  mocks.getResyncRatesOnReconnect.mockReturnValue(false);
  render(<RateResync />);
  await waitFor(() => expect(mocks.finalizeOutOfBandMutation).toHaveBeenCalledOnce());
  expect(mocks.resyncPendingConversions).not.toHaveBeenCalled();
  expect(mocks.revalueAccounts).toHaveBeenCalledWith(1);
});
