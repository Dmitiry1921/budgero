import { useId } from 'react';
import type { CreditPaymentMatching, CreditPaymentMappings } from './ynab-credit-payment-matching';

export function YnabCreditPaymentMatching({
  matching,
  value,
  onChange,
  currency,
  disabled = false,
}: {
  matching: CreditPaymentMatching;
  value: CreditPaymentMappings | undefined;
  onChange: (value: CreditPaymentMappings) => void;
  currency: string;
  disabled?: boolean;
}) {
  const id = useId();
  const byAccountId =
    value?.planId === matching.planId && value.serverKnowledge === matching.serverKnowledge
      ? value.byAccountId
      : {};
  const accounts = [...matching.accounts].sort((a, b) => a.accountId.localeCompare(b.accountId));
  const categories = [...matching.categories].sort((a, b) =>
    a.categoryId.localeCompare(b.categoryId)
  );
  const amount = (milliunits: number) =>
    new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: 3,
    }).format(milliunits / 1000);

  return (
    <fieldset className="space-y-3 rounded-md border p-3 text-xs" disabled={disabled}>
      <legend className="px-1 font-medium">Match credit cards to payment categories</legend>
      <p>
        Choose the payment category belonging to each card so its reserved money and future payments
        stay together.
      </p>
      <p className="text-muted-foreground">
        Card debt and money available for payment can differ. Use your YNAB plan to confirm each
        match. If you cannot identify the match, give the cards distinct names in YNAB and
        reconnect.
      </p>
      {accounts.map((account, index) => {
        const selected = categories.find(
          (category) => category.categoryId === byAccountId[account.accountId]
        );
        return (
          <div key={account.accountId} className="space-y-2 rounded-md border p-2.5">
            <label htmlFor={`${id}-${index}`} className="block font-medium">
              {account.name} · Card {index + 1}
              {account.closed ? ' · Closed' : ''}
            </label>
            <p>Account balance: {amount(account.balance)}</p>
            {account.note && <p className="whitespace-pre-wrap break-words">{account.note}</p>}
            {account.recentTransactions.length > 0 && (
              <details>
                <summary className="cursor-pointer">Recent transactions</summary>
                <ul className="mt-1 space-y-1">
                  {account.recentTransactions.map((transaction, transactionIndex) => (
                    <li key={transactionIndex}>
                      {transaction.date} · {transaction.payee || 'No payee'} ·{' '}
                      {amount(transaction.amount)}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <select
              id={`${id}-${index}`}
              value={byAccountId[account.accountId] ?? ''}
              onChange={(event) => {
                onChange({
                  planId: matching.planId,
                  serverKnowledge: matching.serverKnowledge,
                  byAccountId: { ...byAccountId, [account.accountId]: event.target.value },
                });
              }}
              className="w-full min-w-0 rounded-md border bg-background p-2 text-foreground"
            >
              <option value="">Choose its payment category</option>
              {categories.map((category, categoryIndex) => {
                if (!account.candidateCategoryIds.includes(category.categoryId)) return null;
                const used = accounts.some(
                  (other) =>
                    other.accountId !== account.accountId &&
                    byAccountId[other.accountId] === category.categoryId
                );
                return (
                  <option key={category.categoryId} value={category.categoryId} disabled={used}>
                    {category.name} · Category {categoryIndex + 1} · Available{' '}
                    {amount(category.available)} · Assigned {amount(category.assigned)}
                    {category.note ? ` · ${category.note}` : ''}
                    {used ? ' · Already matched' : ''}
                  </option>
                );
              })}
            </select>
            {selected?.note && (
              <p className="whitespace-pre-wrap break-words">
                Payment category note: {selected.note}
              </p>
            )}
          </div>
        );
      })}
    </fieldset>
  );
}
