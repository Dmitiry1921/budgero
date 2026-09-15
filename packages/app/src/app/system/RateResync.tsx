import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getRuntime } from '@shared/runtime/global';
import { useUiStore } from '@shared/store/useUiStore';
import { getTodayISO } from '@shared/lib/date-utils';

const OFFICIAL_RATE_REFRESH_PREFIX = 'budgero:official-rate-refresh:';

/**
 * Re-resolves offline/manual-rate conversions to official rates when the app
 * (re)gains connectivity. Runs once on mount and on every browser online
 * event; the official daily-rate refresh is limited to once per calendar day
 * per budget and browser. The manual-rate resync is gated by the user_meta
 * ResyncRatesOnReconnect opt-in (default on).
 * Rows the user pinned (ExchangeRateOverride) are never touched.
 */
export function RateResync() {
  const queryClient = useQueryClient();
  const selectedBudget = useUiStore((state) => state.selectedBudget);
  const budgetId = selectedBudget?.ID;
  const spaceId = selectedBudget?.SpaceID;
  const lastOfficialRefreshKey = useRef<string | null>(null);

  useEffect(() => {
    if (!budgetId || !spaceId) return undefined;
    let running = false;
    let cancelled = false;

    const resync = async () => {
      if (running || cancelled) return;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      const runtime = getRuntime();
      if (!runtime || runtime.getActiveSpaceId() !== spaceId || !runtime.servicesReady()) return;
      const services = runtime.services();
      const isCurrent = () =>
        !cancelled && runtime.getActiveSpaceId() === spaceId && runtime.services() === services;
      running = true;
      try {
        let changed = 0;
        let refreshedOfficialRates = false;
        const refreshKey = `${spaceId}:${budgetId}:${getTodayISO()}`;
        const refreshStorageKey = `${OFFICIAL_RATE_REFRESH_PREFIX}${spaceId}:${budgetId}`;
        let refreshedToday = lastOfficialRefreshKey.current === refreshKey;
        if (!refreshedToday) {
          try {
            refreshedToday = window.localStorage.getItem(refreshStorageKey) === refreshKey;
          } catch {
            // Private browsing or storage restrictions should not block resync.
          }
        }
        if (!refreshedToday) {
          try {
            await services.currency.refreshOfficialRates(budgetId);
            refreshedOfficialRates = true;
          } catch {
            // A provider outage must not block reconciliation with cached or
            // custom rates. Leave the refresh unmarked so reconnect can retry.
          }
        }
        if (!isCurrent()) return;
        if (services.userMeta.getResyncRatesOnReconnect()) {
          changed += await services.currency.resyncPendingConversions(budgetId);
        }
        if (!isCurrent()) return;
        // Daily true-up: converted balances follow native × latest rate,
        // journaled per account in account_revaluations.
        changed += await services.currency.revalueAccounts(budgetId);
        if (!isCurrent()) return;
        if (refreshedOfficialRates || changed > 0) {
          // These service calls bypass the mutation executor and therefore
          // have no mutation-log entry or automatic local/snapshot persist.
          await runtime.finalizeOutOfBandMutation({ uploadSnapshot: true });
          if (!isCurrent()) return;
          if (refreshedOfficialRates) {
            lastOfficialRefreshKey.current = refreshKey;
            try {
              window.localStorage.setItem(refreshStorageKey, refreshKey);
            } catch {
              // The in-memory marker still avoids repeat work this session.
            }
          }
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: ['transactions'] }),
            queryClient.invalidateQueries({ queryKey: ['allTransactions'] }),
            queryClient.invalidateQueries({ queryKey: ['allTransactionsDetailed'] }),
            queryClient.invalidateQueries({ queryKey: ['allTransactionsAnalytics'] }),
            queryClient.invalidateQueries({ queryKey: ['accounts'] }),
            queryClient.invalidateQueries({ queryKey: ['monthlyBudget'] }),
            queryClient.invalidateQueries({ queryKey: ['readyToAssign'] }),
            queryClient.invalidateQueries({ queryKey: ['revaluationSummary'] }),
            queryClient.invalidateQueries({ queryKey: ['balanceByDates'] }),
            queryClient.invalidateQueries({ queryKey: ['onBudgetBalance'] }),
            queryClient.invalidateQueries({ queryKey: ['onBudgetBalanceByDates'] }),
            queryClient.invalidateQueries({ queryKey: ['recurringOccurrences'] }),
          ]);
        }
      } catch {
        // Best-effort: a failed resync retries on the next online event.
      } finally {
        running = false;
      }
    };

    void resync();
    window.addEventListener('online', resync);
    return () => {
      cancelled = true;
      window.removeEventListener('online', resync);
    };
  }, [budgetId, spaceId, queryClient]);

  return null;
}
