/**
 * useAddTransactionForm Hook
 *
 * Custom hook that wraps and consolidates form state for the AddTransactionForm.
 * Combines the base useTransactionForm hook with additional local state and derived values.
 */

import * as React from 'react';
import { toast } from 'sonner';

import { useConnectivity } from '@shared/hooks/useConnectivity';
import { useActiveSpaceId } from '@shared/runtime/runtime-provider';
import { getLastUsedTransactionStorageKey } from '@features/transactions/lib/last-used-storage';
import {
  useTransactionForm,
  type TransactionFormInitialValues,
} from '@features/transactions/api/useTransactionForm';
import { getExchangeRate, getLocalOrManualRate } from '@entities/currency/lib/currency-utils';
import { buildCurrencyLocalizer, useUiStore } from '@shared/store/useUiStore';
import { useCategories } from '@entities/category/api/useCategories';
import { useLabels } from '@entities/label/api/useLabels';
import { useDeleteTransaction, useUpsertSplits } from '@entities/transaction/api/useTransactions';
import { useActiveAccounts } from '@entities/account/api/useActiveAccounts';
import {
  asMilli,
  convertScaled,
  isAccountOnBudget,
  resolveTransferPayees,
  transferInvolvesOffBudgetAccount,
} from '@budgero/core/browser';
import type { AddTransferRequest } from '@features/transactions/api/useAddTransactionHandler';
import type { AddTransferResult } from '@entities/transaction/api/useTransactions';
import { useAutofillIntegration } from './useAutofillIntegration';

import type { SplitLine } from '../form';
import {
  convertAmountToFlow,
  validateTransaction,
  validateSplitTotal,
  generateTransferId,
  formatTransferMemo,
  getCurrentDate,
  calculateSplitRemaining,
  calculateTransferRateOverrides,
  calculateImpliedTransferRate,
  resolveTransferCategories,
} from './add-transaction.utils';

export interface UseAddTransactionFormOptions {
  budgetId: number;
  selectedAccountId?: number;
  onAddTransaction: (
    date: Date | null,
    category: string,
    memo: string,
    payee: string,
    outflow: number, // milliunits
    inflow: number, // milliunits
    accountId: number,
    labelId: number | null,
    transferId: string | null,
    keepDialogOpen?: boolean,
    exchangeRateOverride?: number | null
  ) => Promise<number>;
  onAddTransfer: (request: AddTransferRequest) => Promise<AddTransferResult>;
  onCancel: () => void;
  initialValues?: TransactionFormInitialValues;
  disableLastUsed?: boolean;
  disableAutofill?: boolean;
  disableCurrencyConversion?: boolean;
}

export function useAddTransactionForm({
  budgetId,
  selectedAccountId,
  onAddTransaction,
  onAddTransfer,
  onCancel,
  initialValues,
  disableLastUsed = false,
  disableAutofill = false,
  disableCurrencyConversion = false,
}: UseAddTransactionFormOptions) {
  const upsertSplits = useUpsertSplits();
  const deleteTransaction = useDeleteTransaction();
  const spaceId = useActiveSpaceId();
  const form = useTransactionForm({
    lastUsedStorageKey: getLastUsedTransactionStorageKey(spaceId, budgetId),
    selectedAccountId,
    initialValues,
    disableLastUsed,
  });

  // Destructure setters for use in effects (stable references)
  const {
    setPayee,
    setCategory,
    setFromAccount,
    setLabelId,
    setConvertedAmount,
    setLoadingRate,
    setPendingRatePair,
    setShowRatePrompt,
    previousTransactionType,
  } = form;

  // Split mode state (kept local as it's UI-specific)
  const [isSplit, setIsSplit] = React.useState(false);
  const [splitLines, setSplitLines] = React.useState<SplitLine[]>([]);

  // Track the resolved exchange rate for the currency conversion notice
  const [resolvedRate, setResolvedRate] = React.useState<number | null>(null);
  const [receivedAmount, setReceivedAmount] = React.useState<number | null>(null);

  const { data: categories = [], isLoading: categoriesLoading } = useCategories(budgetId);
  const { labels, isSuccess: labelsLoaded } = useLabels(budgetId);
  // Hide archived accounts from the add-transaction picker; they remain visible in history.
  const { data: accounts, isLoading: accountsLoading } = useActiveAccounts(budgetId);

  const { clerkToken, apiReachable } = useConnectivity();
  const canUseCurrencyApi = clerkToken && apiReachable;

  const selectedBudget = useUiStore((state) => state.selectedBudget);
  const globalLocalizer = useUiStore((state) => state.globalLocalizer);

  const selectedAccount = React.useMemo(() => {
    return accounts.find((acc) => acc.ID.toString() === form.selectedFromAccount);
  }, [accounts, form.selectedFromAccount]);

  const toAccount = React.useMemo(() => {
    if (form.isTransfer && form.selectedToAccount) {
      return accounts.find((acc) => acc.ID.toString() === form.selectedToAccount);
    }
    return null;
  }, [form.isTransfer, form.selectedToAccount, accounts]);

  // Amounts are entered in the ACCOUNT's currency (accounts can differ from
  // the budget's display currency). When no account is selected yet — or a
  // legacy account has an empty Currency — fall back to the budget's display
  // currency, never a hardcoded USD.
  const currencyCode = selectedAccount?.Currency || selectedBudget?.DisplayCurrency || 'USD';
  const splitLocalizer = React.useMemo(
    () =>
      (selectedBudget?.NumberFormat
        ? buildCurrencyLocalizer(currencyCode, selectedBudget.NumberFormat)
        : null) ?? globalLocalizer,
    [currencyCode, globalLocalizer, selectedBudget?.NumberFormat]
  );

  const needsCurrencyConversion = React.useMemo(() => {
    if (disableCurrencyConversion) return false;
    if (!form.isTransfer) return false;
    if (!selectedAccount || !toAccount) return false;
    return selectedAccount.Currency !== toAccount.Currency;
  }, [disableCurrencyConversion, form.isTransfer, selectedAccount, toAccount]);

  React.useEffect(() => {
    setReceivedAmount(null);
  }, [form.transactionType, form.selectedFromAccount, form.selectedToAccount]);

  const transferInvolvesOffBudget = React.useMemo(() => {
    if (!form.isTransfer) return false;
    const fromAcc = accounts.find((a) => a.ID.toString() === form.selectedFromAccount);
    const toAcc = accounts.find((a) => a.ID.toString() === form.selectedToAccount);
    return Boolean(fromAcc && toAcc && transferInvolvesOffBudgetAccount(fromAcc, toAcc));
  }, [form.isTransfer, form.selectedFromAccount, form.selectedToAccount, accounts]);

  React.useEffect(() => {
    if (form.isTransfer && !transferInvolvesOffBudget && form.payee) {
      setPayee('');
    }
  }, [form.isTransfer, form.payee, setPayee, transferInvolvesOffBudget]);

  const splitNet = React.useMemo(
    () => splitLines.reduce((sum, line) => sum + (line.inflow || 0) - (line.outflow || 0), 0),
    [splitLines]
  );

  const parentSigned = React.useMemo(() => {
    const amt = form.amount ?? 0;
    if (form.isTransfer) return 0;
    return form.isInflow ? amt : -Number(amt);
  }, [form.isInflow, form.isTransfer, form.amount]);

  const remaining = calculateSplitRemaining(parentSigned, splitNet, form.isTransfer);

  // Track the last prefilled state to avoid re-prefilling when user clears fields
  // We store both transaction type AND a key representing the lastUsed data
  const lastPrefillKey = React.useRef<string | null>(null);

  // Prefill with last-used fields - only when transaction type or lastUsed data changes
  React.useEffect(() => {
    if (!form.rememberLast) {
      previousTransactionType.current = form.transactionType;
      return;
    }
    if (!labelsLoaded || categoriesLoading || accountsLoading) return;

    const lu = form.lastUsed[form.transactionType] || {};

    // Create a key that represents the current prefill state
    // This changes when transaction type changes OR when lastUsed data is loaded/updated
    const currentPrefillKey = `${form.transactionType}:${lu.payee || ''}:${lu.category || ''}:${lu.accountId || ''}:${lu.labelId || ''}`;

    // Skip if we've already prefilled with this exact data
    if (lastPrefillKey.current === currentPrefillKey) {
      return;
    }

    lastPrefillKey.current = currentPrefillKey;

    if (lu.payee) setPayee(lu.payee);
    if (
      !form.isTransfer &&
      !isSplit &&
      lu.category &&
      categories.some((cat) => cat.Name === lu.category)
    ) {
      setCategory(lu.category);
    }
    if (typeof lu.labelId === 'number') {
      setLabelId(labels.some((label) => label.ID === lu.labelId) ? lu.labelId : null);
    } else if (lu.labelId === null) {
      // Remembered "No label" — restore it explicitly so a stale label can't linger.
      setLabelId(null);
    }
    const lastAccount = lu.accountId;
    const previousAccount = form.lastUsed[previousTransactionType.current]?.accountId;
    const shouldApplyLastAccount =
      lastAccount &&
      accounts.some((account) => account.ID.toString() === lastAccount) &&
      (!form.selectedFromAccount || form.selectedFromAccount === previousAccount);
    if (shouldApplyLastAccount) {
      setFromAccount(lastAccount);
    }
    previousTransactionType.current = form.transactionType;
  }, [
    form.transactionType,
    form.lastUsed,
    form.rememberLast,
    isSplit,
    form.isTransfer,
    form.selectedFromAccount,
    setPayee,
    setCategory,
    setLabelId,
    setFromAccount,
    previousTransactionType,
    accounts,
    accountsLoading,
    categories,
    categoriesLoading,
    labels,
    labelsLoaded,
  ]);

  // A remembered label may also have been deleted since the previous transaction.
  // Wait for the directory before deciding an ID is stale.
  React.useEffect(() => {
    if (
      labelsLoaded &&
      form.selectedLabelId !== null &&
      !labels.some((label) => label.ID === form.selectedLabelId)
    ) {
      setLabelId(null);
    }
  }, [form.selectedLabelId, labels, labelsLoaded, setLabelId]);

  React.useEffect(() => {
    if (form.isInflow) {
      const incomeCategory = categories.find((cat) => cat.Name === 'Income');
      if (incomeCategory && !form.selectedCategory) {
        setCategory(incomeCategory.Name);
      }
    }
  }, [form.isInflow, categories, form.selectedCategory, setCategory]);

  React.useEffect(() => {
    if (transferInvolvesOffBudget && !form.selectedCategory) {
      const transfersCategory = categories.find((cat) => cat.Name === 'Transfers');
      if (transfersCategory) {
        setCategory(transfersCategory.Name);
      }
    }
  }, [transferInvolvesOffBudget, form.selectedCategory, categories, setCategory]);

  React.useEffect(() => {
    if (selectedAccountId) {
      setFromAccount(selectedAccountId.toString());
    }
  }, [selectedAccountId, setFromAccount]);

  React.useEffect(() => {
    async function calculatePreview() {
      if (
        !needsCurrencyConversion ||
        !form.amount ||
        !selectedAccount ||
        !toAccount ||
        !selectedBudget
      ) {
        setConvertedAmount(null);
        setResolvedRate(null);
        return;
      }

      if (receivedAmount !== null) {
        setConvertedAmount(receivedAmount);
        setResolvedRate(
          calculateImpliedTransferRate({
            sourceAmount: form.amount,
            receivedAmount,
            sourceCurrency: selectedAccount.Currency,
            destinationCurrency: toAccount.Currency,
          })
        );
        setLoadingRate(false);
        setPendingRatePair(null);
        setShowRatePrompt(false);
        return;
      }

      setLoadingRate(true);

      if (!canUseCurrencyApi) {
        const date = getCurrentDate(form.transactionDate);
        const localOrManual = await getLocalOrManualRate(
          selectedAccount.Currency,
          toAccount.Currency,
          date,
          selectedBudget.ID
        );
        if (!localOrManual) {
          setPendingRatePair({ from: selectedAccount.Currency, to: toAccount.Currency });
          setShowRatePrompt(true);
          setLoadingRate(false);
          return;
        }
      }

      const currentDate = getCurrentDate(form.transactionDate);

      try {
        const rate = await getExchangeRate(
          selectedAccount.Currency,
          toAccount.Currency,
          currentDate,
          selectedBudget.ID
        );
        // money × rate crosses storage scales (crypto is sat-scale); convertScaled rounds back
        setConvertedAmount(
          rate
            ? asMilli(
                convertScaled(form.amount, rate, selectedAccount.Currency, toAccount.Currency)
              )
            : null
        );
        setResolvedRate(rate);
      } catch (error) {
        console.error('Failed to get exchange rate:', error);
        setConvertedAmount(null);
      } finally {
        setLoadingRate(false);
      }
    }

    if (needsCurrencyConversion) {
      void calculatePreview();
    }
  }, [
    form.amount,
    needsCurrencyConversion,
    selectedAccount,
    toAccount,
    form.transactionDate,
    selectedBudget,
    canUseCurrencyApi,
    receivedAmount,
    setConvertedAmount,
    setLoadingRate,
    setPendingRatePair,
    setShowRatePrompt,
  ]);

  const {
    autofillAppliedFields,
    autofillAppliedSuggestions,
    resetAutofillSession,
    logAutofillApplications,
    payeeCategoryApplied,
    payeeCategorySource,
  } = useAutofillIntegration({
    form,
    categories,
    budgetId,
    selectedBudget,
    isSplit,
    disabled: disableAutofill,
  });

  // Reset form for "Add Another"
  const resetFormFields = React.useCallback(() => {
    form.setCategory('');
    form.setMemo('');
    form.setPayee('');
    form.setLabelId(null);
    form.setAmount(null);
    form.setAmountTouched(false);
    form.setToAccount('');
    form.setConvertedAmount(null);
    setReceivedAmount(null);
    form.incrementAmountNonce();
    form.triggerAmountFocus();
    setIsSplit(false);
    setSplitLines([]);
    resetAutofillSession();
    // Reset prefill tracking so "remember last" can run again
    lastPrefillKey.current = null;
  }, [form, resetAutofillSession]);

  const handleSubmit = React.useCallback(
    async (addAnother = false) => {
      if (form.selectedLabelId !== null && !labelsLoaded) return;
      const labelId = labels.some((label) => label.ID === form.selectedLabelId)
        ? form.selectedLabelId
        : null;
      const validation = validateTransaction({
        selectedFromAccount: form.selectedFromAccount,
        selectedToAccount: form.selectedToAccount,
        selectedCategory: form.selectedCategory,
        isTransfer: form.isTransfer,
        isSplit,
      });

      if (!validation.isValid && validation.error) {
        toast.error(validation.error.title, { description: validation.error.description });
        return;
      }

      const { inflow, outflow } = convertAmountToFlow(form.amount, form.transactionType);
      const finalCategory = isSplit ? 'Uncategorized' : form.selectedCategory;

      if (form.transactionType === 'transfer') {
        const fromAccount = accounts.find((acc) => acc.ID.toString() === form.selectedFromAccount);
        const toAcc = accounts.find((acc) => acc.ID.toString() === form.selectedToAccount);
        if (fromAccount && toAcc && selectedBudget) {
          form.setCalculatingTransfer(true);

          try {
            const amt = form.amount ?? 0;
            let inflowAmount = amt;
            let sourceRateOverride: number | null = null;
            let destinationRateOverride: number | null = null;
            const { sourcePayee, destinationPayee } = resolveTransferPayees(
              fromAccount,
              toAcc,
              form.payee
            );

            if (fromAccount.Currency !== toAcc.Currency) {
              const currentDate = getCurrentDate(form.transactionDate);
              if (receivedAmount !== null) {
                inflowAmount = receivedAmount;
                const budgetCurrency = selectedBudget.DisplayCurrency;
                const needsSourceBudgetRate =
                  fromAccount.Currency !== budgetCurrency && toAcc.Currency !== budgetCurrency;
                const sourceToBudgetRate = needsSourceBudgetRate
                  ? await getExchangeRate(
                      fromAccount.Currency,
                      budgetCurrency,
                      currentDate,
                      selectedBudget.ID
                    )
                  : null;

                if (needsSourceBudgetRate && !sourceToBudgetRate) {
                  toast.error('Exchange rate unavailable', {
                    description: `A ${fromAccount.Currency} to ${budgetCurrency} rate is required to save the received amount.`,
                  });
                  return;
                }

                ({ sourceRateOverride, destinationRateOverride } = calculateTransferRateOverrides({
                  sourceAmount: amt,
                  receivedAmount,
                  sourceCurrency: fromAccount.Currency,
                  destinationCurrency: toAcc.Currency,
                  budgetCurrency,
                  sourceToBudgetRate,
                }));
              } else {
                const rate = await getExchangeRate(
                  fromAccount.Currency,
                  toAcc.Currency,
                  currentDate,
                  selectedBudget.ID
                );
                if (rate) {
                  // money × rate crosses storage scales (crypto is sat-scale)
                  inflowAmount = asMilli(
                    convertScaled(amt, rate, fromAccount.Currency, toAcc.Currency)
                  );
                }
              }
            }

            const transferMemo = formatTransferMemo({
              fromAccountName: fromAccount.Name,
              toAccountName: toAcc.Name,
              memo: form.memo,
              amount: amt,
              convertedAmount: inflowAmount,
              fromCurrency: fromAccount.Currency,
              toCurrency: toAcc.Currency,
              needsConversion: fromAccount.Currency !== toAcc.Currency,
            });

            const transferId = generateTransferId();

            const { sourceCategory, destinationCategory } = resolveTransferCategories({
              sourceOnBudget: isAccountOnBudget(fromAccount),
              destinationOnBudget: isAccountOnBudget(toAcc),
              selectedCategory: form.selectedCategory,
            });

            await onAddTransfer({
              date: form.transactionDate,
              transferId,
              memo: transferMemo,
              labelId,
              source: {
                category: sourceCategory,
                payee: sourcePayee ?? '',
                amount: amt,
                accountId: parseInt(form.selectedFromAccount),
                exchangeRateOverride: sourceRateOverride,
              },
              destination: {
                category: destinationCategory,
                payee: destinationPayee ?? '',
                amount: inflowAmount,
                accountId: parseInt(form.selectedToAccount),
                exchangeRateOverride: destinationRateOverride,
              },
              keepDialogOpen: addAnother,
            });

            form.persistLastUsed('transfer', {
              payee: transferInvolvesOffBudget ? form.payee : '',
              accountId: form.selectedFromAccount,
              labelId,
            });

            if (addAnother) {
              resetFormFields();
            }
            toast.success('Transfer added', { description: 'Transfer created successfully.' });
          } finally {
            form.setCalculatingTransfer(false);
          }
        }
        return;
      }

      // Non-transfer transactions
      if (!isSplit) {
        if (!canUseCurrencyApi && selectedAccount && selectedBudget) {
          const budgetCurrency = selectedBudget.DisplayCurrency;
          if (budgetCurrency && selectedAccount.Currency !== budgetCurrency) {
            const d = getCurrentDate(form.transactionDate);
            const localOrManual = await getLocalOrManualRate(
              selectedAccount.Currency,
              budgetCurrency,
              d,
              selectedBudget.ID
            );
            if (!localOrManual) {
              form.setPendingRatePair({ from: selectedAccount.Currency, to: budgetCurrency });
              form.setPendingAdd({
                date: form.transactionDate,
                category: finalCategory,
                memo: form.memo,
                payee: form.payee,
                labelId,
                outflow,
                inflow,
                accountId: parseInt(form.selectedFromAccount),
                transferId: null,
              });
              form.setShowRatePrompt(true);
              return;
            }
          }
        }

        const transactionId = await onAddTransaction(
          form.transactionDate,
          finalCategory,
          form.memo,
          form.payee,
          outflow,
          inflow,
          parseInt(form.selectedFromAccount),
          labelId,
          null,
          addAnother
        );

        logAutofillApplications(transactionId, autofillAppliedSuggestions);

        form.persistLastUsed(form.transactionType, {
          category: !form.isTransfer ? finalCategory : undefined,
          payee: form.payee,
          accountId: form.selectedFromAccount,
          labelId,
        });

        if (addAnother) {
          resetFormFields();
        }
        toast.success('Transaction added', { description: 'Transaction saved successfully.' });
        return;
      }

      // Split-mode
      const splitValidation = validateSplitTotal(remaining);
      if (!splitValidation.isValid && splitValidation.error) {
        toast.error(splitValidation.error.title, {
          description: splitValidation.error.description,
        });
        return;
      }

      const invalidAmounts = splitLines.some(
        (line) =>
          line.inflow < 0 ||
          line.outflow < 0 ||
          (line.inflow === 0 && line.outflow === 0) ||
          (line.inflow > 0 && line.outflow > 0)
      );
      if (invalidAmounts) {
        toast.error('Invalid split amount', {
          description: 'Each split line needs either an inflow or an outflow amount.',
        });
        return;
      }

      const accountId = parseInt(form.selectedFromAccount);
      const uncategorized = categories.find((c) => c.Name === 'Uncategorized');
      const uncategorizedId = uncategorized?.ID ?? null;

      const missingAssignment = splitLines.some(
        (l) => (!l.categoryId && !l.transferAccountId) || (l.categoryId && l.transferAccountId)
      );
      if (missingAssignment && !uncategorizedId) {
        toast.error('Split requires category', {
          description: 'Each split line needs a category. Please assign a category to every split.',
        });
        return;
      }

      const prepared = splitLines.map((l, idx) => ({
        category_id: l.categoryId ?? (l.transferAccountId ? null : uncategorizedId),
        transfer_account_id: l.transferAccountId ?? null,
        memo: l.memo ?? '',
        payee: l.payee ?? '',
        inflow: l.inflow,
        outflow: l.outflow,
        order_index: idx,
      }));

      let transactionId: number | null = null;
      try {
        // Keep the dialog open until the parent and its split lines are both stored.
        transactionId = await onAddTransaction(
          form.transactionDate,
          finalCategory,
          form.memo,
          form.payee,
          outflow,
          inflow,
          accountId,
          labelId,
          null,
          true
        );

        await upsertSplits.mutateAsync({
          transactionId,
          splits: prepared,
          amountCurrency: 'native',
        });

        // Log autofill rule applications (if any were applied before split mode)
        logAutofillApplications(transactionId, autofillAppliedSuggestions);

        form.persistLastUsed(form.transactionType, {
          payee: form.payee,
          category: !form.isTransfer && form.selectedCategory ? form.selectedCategory : undefined,
          accountId: form.selectedFromAccount,
          labelId,
        });

        if (addAnother) {
          resetFormFields();
        } else {
          onCancel();
        }
        toast.success('Transaction with splits added', {
          description: 'Transaction saved successfully.',
        });
      } catch (e) {
        console.error('Failed to save splits', e);
        if (transactionId !== null) {
          try {
            await deleteTransaction.mutateAsync({ transactionId, accountId });
          } catch (rollbackError) {
            console.error('Failed to roll back split parent transaction', rollbackError);
          }
        }
        toast.error('Failed to save split transaction', {
          description: e instanceof Error ? e.message : 'Please try again.',
        });
      }
    },
    [
      form,
      isSplit,
      splitLines,
      accounts,
      categories,
      selectedBudget,
      selectedAccount,
      canUseCurrencyApi,
      remaining,
      onAddTransaction,
      onAddTransfer,
      upsertSplits,
      deleteTransaction,
      resetFormFields,
      logAutofillApplications,
      autofillAppliedSuggestions,
      labels,
      labelsLoaded,
      transferInvolvesOffBudget,
      receivedAmount,
      onCancel,
    ]
  );

  const toggleSplit = React.useCallback(() => {
    setIsSplit((v) => !v);
  }, []);

  return {
    // Base form state and actions
    form: {
      ...form,
      canSubmit: form.canSubmit && (form.selectedLabelId === null || labelsLoaded),
    },

    // Split state
    isSplit,
    setIsSplit,
    splitLines,
    setSplitLines,
    toggleSplit,

    // Data
    categories,
    categoriesLoading,
    accounts,
    accountsLoading,

    // Derived state
    selectedAccount,
    toAccount,
    currencyCode,
    needsCurrencyConversion,
    transferInvolvesOffBudget,
    splitNet,
    parentSigned,
    remaining,
    canUseCurrencyApi,
    selectedBudget,
    globalLocalizer,
    splitLocalizer,
    resolvedRate,
    receivedAmount,
    setReceivedAmount,

    // Autofill
    autofillAppliedFields,
    payeeCategoryApplied,
    payeeCategorySource,

    // Actions
    handleSubmit,
    resetFormFields,
    onCancel,
  };
}

export type UseAddTransactionFormReturn = ReturnType<typeof useAddTransactionForm>;
