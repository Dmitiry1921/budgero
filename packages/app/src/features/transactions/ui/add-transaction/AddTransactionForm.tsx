'use client';

/**
 * Add Transaction Form
 *
 * Main shell component that composes the transaction form from sub-components.
 * Uses useAddTransactionForm hook for state management.
 */

import * as React from 'react';
import { toast } from 'sonner';

import { ManualRatePrompt } from '@features/currencies/ui/ManualRatePrompt';
import { saveManualRate } from '@entities/currency/lib/currency-utils';
import { toastError } from '@shared/lib/errors';
import { useActiveSpaceId } from '@shared/runtime/runtime-provider';
import { Card, CardContent } from '@shared/ui/card';
import { Button } from '@shared/ui/button';
import { DialogHeader, DialogTitle, DialogDescription } from '@shared/ui/dialog';
import { AddAccountDialog } from '@features/account-management/ui/AddAccountDialog';
import type { AddTransferRequest } from '@features/transactions/api/useAddTransactionHandler';
import type { AddTransferResult } from '@entities/transaction/api/useTransactions';
import { useCreateRecurringTransaction } from '@entities/recurring/api/useRecurringTransactions';
import { getCurrentDate } from './add-transaction.utils';

import { TransactionFormHeader } from './TransactionFormHeader';
import { TransactionDetailsSection } from './TransactionDetailsSection';
import { TransactionSplitSection } from './TransactionSplitSection';
import { TransactionFormActions } from './TransactionFormActions';
import { RecurringOptionsSection } from './RecurringOptionsSection';
import { useAddTransactionForm } from './useAddTransactionForm';
import {
  buildRecurringSchedule,
  createRecurringFormSettings,
  isRecurringEndConditionValid,
  recurringInitialToTransactionValues,
  type RecurringFormSettings,
  type RecurringTransactionFormInitialValues,
  type RecurringTransactionFormSubmit,
} from './recurring-form';

export interface AddTransactionRecurringOptions {
  initialEnabled?: boolean;
  locked?: boolean;
  mode?: 'create' | 'edit';
  initialValues?: RecurringTransactionFormInitialValues;
  onSubmit?: (values: RecurringTransactionFormSubmit) => Promise<void> | void;
  isSubmitting?: boolean;
}

export interface AddTransactionFormProps {
  budgetId: number;
  selectedAccountId?: number;
  onAddTransaction: (
    date: Date | null,
    category: string,
    memo: string,
    payee: string,
    outflow: number,
    inflow: number,
    accountId: number,
    labelId: number | null,
    transferId: string | null,
    keepDialogOpen?: boolean,
    exchangeRateOverride?: number | null
  ) => Promise<number>;
  onAddTransfer: (request: AddTransferRequest) => Promise<AddTransferResult>;
  onCancel: () => void;
  recurring?: AddTransactionRecurringOptions;
}

export function AddTransactionForm(props: AddTransactionFormProps) {
  const spaceId = useActiveSpaceId();
  // Reset all form, split, and autofill state when its owning budget changes.
  return <BudgetTransactionForm key={JSON.stringify([spaceId, props.budgetId])} {...props} />;
}

function BudgetTransactionForm({
  budgetId,
  selectedAccountId,
  onAddTransaction,
  onAddTransfer,
  onCancel,
  recurring,
}: AddTransactionFormProps) {
  const createRecurring = useCreateRecurringTransaction();
  const [recurringEnabled, setRecurringEnabled] = React.useState(
    recurring?.initialEnabled ?? false
  );
  const [recurringSettings, setRecurringSettings] = React.useState<RecurringFormSettings>(() =>
    createRecurringFormSettings(recurring?.initialValues)
  );
  const recurringLocked = recurring?.locked ?? false;
  const recurringMode = recurringEnabled ? (recurring?.mode ?? 'create') : null;
  const recurringInitialValues = React.useMemo(
    () => recurringInitialToTransactionValues(recurring?.initialValues),
    [recurring?.initialValues]
  );
  const {
    form,
    isSplit,
    splitLines,
    setSplitLines,
    toggleSplit,
    categories,
    categoriesLoading,
    accounts,
    accountsLoading,
    selectedAccount,
    toAccount = null,
    currencyCode,
    needsCurrencyConversion,
    transferInvolvesOffBudget = false,
    parentSigned,
    remaining,
    canUseCurrencyApi,
    selectedBudget,
    globalLocalizer,
    splitLocalizer,
    autofillAppliedFields,
    payeeCategoryApplied,
    payeeCategorySource,
    resolvedRate,
    receivedAmount,
    setReceivedAmount,
    handleSubmit,
  } = useAddTransactionForm({
    budgetId,
    selectedAccountId,
    onAddTransaction,
    onAddTransfer,
    onCancel,
    initialValues: recurringInitialValues,
    disableLastUsed: recurringLocked,
    disableAutofill: recurringLocked,
    disableCurrencyConversion: recurringEnabled,
  });

  const recurringSubmitting = recurring?.isSubmitting ?? createRecurring.isPending;

  const submitRecurring = React.useCallback(async () => {
    if (!form.selectedFromAccount) {
      toast.error('Missing account', { description: 'Please select an account.' });
      return;
    }
    if (form.isTransfer && !form.selectedToAccount) {
      toast.error('Missing destination', {
        description: 'Please select a destination account.',
      });
      return;
    }
    if (!form.isTransfer && !form.selectedCategory) {
      toast.error('Missing category', { description: 'Please select a category.' });
      return;
    }
    if (!form.amount || form.amount <= 0) {
      toast.error('Missing amount', { description: 'Please enter an amount greater than zero.' });
      return;
    }
    if (!form.transactionDate) {
      toast.error('Missing first occurrence', {
        description: 'Please select the first occurrence date.',
      });
      return;
    }
    if (!isRecurringEndConditionValid(recurringSettings)) {
      toast.error('Incomplete end condition', {
        description: 'Choose a valid end date or number of occurrences.',
      });
      return;
    }

    const category = categories.find((item) => item.Name === form.selectedCategory);
    const values: RecurringTransactionFormSubmit = {
      name: form.payee.trim() || form.memo.trim() || 'Recurring transaction',
      memo: form.memo.trim(),
      amount: form.amount,
      direction: form.isInflow ? 'inflow' : 'outflow',
      accountId: Number(form.selectedFromAccount),
      toAccountId: form.isTransfer ? Number(form.selectedToAccount) : null,
      categoryId: form.isTransfer && !transferInvolvesOffBudget ? null : (category?.ID ?? null),
      schedule: buildRecurringSchedule(form.transactionDate, recurringSettings),
      notifyDaysBefore: Math.max(0, Math.trunc(Number(recurringSettings.notifyDaysBefore) || 0)),
      active: recurringSettings.active,
    };

    if (recurring?.onSubmit) {
      await recurring.onSubmit(values);
      return;
    }

    await createRecurring.mutateAsync({
      budgetId,
      accountId: values.accountId!,
      toAccountId: values.toAccountId,
      categoryId: values.categoryId,
      name: values.name,
      memo: values.memo,
      amount: values.amount,
      direction: values.direction,
      schedule: values.schedule,
      notifyDaysBefore: values.notifyDaysBefore,
      active: values.active,
    });
    toast.success('Recurring transaction created', {
      description: 'We will remind you when it is almost due.',
    });
    onCancel();
  }, [
    form,
    recurringSettings,
    categories,
    transferInvolvesOffBudget,
    recurring,
    createRecurring,
    budgetId,
    onCancel,
  ]);

  const submitTransaction = React.useCallback(
    (addAnother: boolean) => {
      if (recurringEnabled) {
        void submitRecurring().catch((error) => {
          toastError('Failed to save recurring transaction', error, 'Please try again.');
        });
        return;
      }
      handleSubmit(addAnother).catch((error) => {
        toastError('Failed to add transaction', error, 'Please try again.');
      });
    },
    [handleSubmit, recurringEnabled, submitRecurring]
  );

  const onFormSubmit = React.useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      submitTransaction(false);
    },
    [submitTransaction]
  );

  const onQuickAdd = React.useCallback(() => {
    submitTransaction(true);
  }, [submitTransaction]);

  const handleKeyDown = React.useCallback(
    (e: React.KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      const role = target?.getAttribute?.('role');
      const inCommandLike =
        role === 'combobox' || role === 'option' || target?.closest('[role="listbox"]');

      if (form.isAmountEditing && e.key === 'Enter') return;

      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submitTransaction(false);
        return;
      }

      if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
        if (tag === 'textarea' || inCommandLike) return;
        e.preventDefault();
        submitTransaction(false);
      }
    },
    [form.isAmountEditing, submitTransaction]
  );

  const handleRatePromptConfirm = React.useCallback(
    async (rate: number, base: string, quote: string) => {
      if (selectedBudget) await saveManualRate(base, quote, rate, selectedBudget.ID);
      form.setShowRatePrompt(false);
      if (form.pendingAdd) {
        await onAddTransaction(
          form.pendingAdd.date,
          form.pendingAdd.category,
          form.pendingAdd.memo,
          form.pendingAdd.payee,
          form.pendingAdd.outflow,
          form.pendingAdd.inflow,
          form.pendingAdd.accountId,
          form.pendingAdd.labelId,
          form.pendingAdd.transferId,
          false
        );
        form.setPendingAdd(null);
        return;
      }
      setTimeout(() => form.setAmount(form.amount), 0);
    },
    [selectedBudget, form, onAddTransaction]
  );

  // No accounts prompt
  if (!accountsLoading && accounts.length === 0) {
    return (
      <div className="max-w-lg w-full mx-auto space-y-4 p-2 sm:p-4">
        <DialogHeader className="space-y-1.5">
          <DialogTitle className="text-lg sm:text-xl font-semibold">
            Add an account first
          </DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            Create an account to start recording transactions.
          </DialogDescription>
        </DialogHeader>
        <Card>
          <CardContent className="space-y-4 pt-6">
            <p className="text-sm text-muted-foreground">
              You need at least one account before adding transactions.
            </p>
            <div className="flex flex-wrap gap-2">
              <AddAccountDialog
                open={form.addAccountOpen}
                onOpenChange={form.setAddAccountOpen}
                onSuccess={(accountId) => {
                  form.setFromAccount(accountId.toString());
                  form.setAddAccountOpen(false);
                }}
                renderTrigger={(open) => (
                  <Button type="button" onClick={open}>
                    Create Account
                  </Button>
                )}
              />
              <Button type="button" variant="outline" onClick={onCancel}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <form
      onSubmit={onFormSubmit}
      onKeyDownCapture={handleKeyDown}
      className="max-w-lg w-full mx-auto max-h-[calc(100dvh-1rem)] sm:max-h-[min(92vh,calc(100dvh-2rem))] overflow-y-auto px-1 sm:px-0"
      data-testid="add-transaction-form"
    >
      {form.showRatePrompt && form.pendingRatePair && (
        <ManualRatePrompt
          from={form.pendingRatePair.from}
          to={form.pendingRatePair.to}
          budgetId={selectedBudget?.ID}
          rateDate={form.transactionDate ? getCurrentDate(form.transactionDate) : undefined}
          onCancel={() => form.setShowRatePrompt(false)}
          onConfirm={handleRatePromptConfirm}
        />
      )}

      <TransactionFormHeader
        rememberLast={form.rememberLast}
        onRememberLastChange={form.setRememberLast}
        title={
          recurringMode === 'edit'
            ? 'Edit Recurring Transaction'
            : recurringMode === 'create' && recurringLocked
              ? 'New Recurring Transaction'
              : undefined
        }
        description={
          recurringEnabled
            ? 'Fill in the transaction once, then choose when it should repeat.'
            : undefined
        }
        showRememberLast={!recurringLocked}
        recurringEnabled={recurringEnabled}
        onRecurringEnabledChange={setRecurringEnabled}
        recurringLocked={recurringLocked || isSplit}
      />

      <TransactionDetailsSection
        budgetId={budgetId}
        amount={form.amount}
        amountTouched={form.amountTouched}
        currencyCode={currencyCode}
        transactionType={form.transactionType}
        amountInputNonce={form.amountInputNonce}
        amountFocusSignal={form.amountFocusSignal}
        globalLocalizer={globalLocalizer}
        onAmountCommit={form.setAmount}
        onAmountTouched={() => form.setAmountTouched(true)}
        onAmountEditingChange={form.setAmountEditing}
        onTransactionTypeChange={form.setTransactionType}
        transactionDate={form.transactionDate}
        dateOpen={form.dateOpen}
        onDateOpenChange={form.setDateOpen}
        onDateChange={form.setDate}
        selectedFromAccount={form.selectedFromAccount}
        selectedToAccount={form.selectedToAccount}
        onFromAccountChange={form.setFromAccount}
        onToAccountChange={form.setToAccount}
        accounts={accounts}
        accountsLoading={accountsLoading}
        isTransfer={form.isTransfer}
        transferInvolvesOffBudget={transferInvolvesOffBudget}
        needsCurrencyConversion={needsCurrencyConversion}
        convertedAmount={form.convertedAmount}
        isLoadingRate={form.isLoadingRate}
        selectedAccount={selectedAccount}
        toAccount={toAccount}
        canUseCurrencyApi={canUseCurrencyApi}
        exchangeRate={resolvedRate}
        receivedAmount={receivedAmount}
        onReceivedAmountChange={setReceivedAmount}
        showCurrencyConversion={!recurringEnabled}
        payee={form.payee}
        onPayeeChange={form.setPayee}
        selectedLabelId={form.selectedLabelId}
        onLabelChange={form.setLabelId}
        showLabel={!recurringEnabled}
        selectedCategory={form.selectedCategory}
        onCategoryChange={form.setCategory}
        categories={categories}
        categoriesLoading={categoriesLoading}
        isSplit={isSplit}
        memo={form.memo}
        onMemoChange={form.setMemo}
        autofillAppliedFields={autofillAppliedFields}
        payeeCategoryApplied={payeeCategoryApplied}
        payeeCategorySource={payeeCategorySource}
      />

      {!recurringEnabled && (
        <TransactionSplitSection
          budgetId={budgetId}
          isTransfer={form.isTransfer}
          isSplit={isSplit}
          onToggleSplit={toggleSplit}
          splitLines={splitLines}
          onSplitLinesChange={setSplitLines}
          remaining={remaining}
          parentAmount={parentSigned}
          formatter={splitLocalizer}
        />
      )}

      {recurringEnabled && (
        <RecurringOptionsSection
          firstOccurrence={form.transactionDate}
          settings={recurringSettings}
          onChange={setRecurringSettings}
        />
      )}

      <TransactionFormActions
        onCancel={onCancel}
        onQuickAdd={onQuickAdd}
        isCalculatingTransfer={form.isCalculatingTransfer}
        isTransfer={form.isTransfer}
        isInflow={form.isInflow}
        isOutflow={form.isOutflow}
        recurringMode={recurringMode}
        isSubmitting={recurringSubmitting}
      />
    </form>
  );
}
