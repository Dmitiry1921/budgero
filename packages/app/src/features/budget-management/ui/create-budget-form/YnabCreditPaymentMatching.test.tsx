import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { YnabCreditPaymentMatching } from './YnabCreditPaymentMatching';
import {
  hasCompleteCreditPaymentMappings,
  type CreditPaymentMatching,
  type CreditPaymentMappings,
} from './ynab-credit-payment-matching';

const matching: CreditPaymentMatching = {
  planId: 'plan-1',
  serverKnowledge: 42,
  accounts: [
    {
      accountId: 'card-a',
      name: 'Visa',
      balance: -120_000,
      closed: false,
      note: 'Personal card',
      candidateCategoryIds: ['cat-a', 'cat-b'],
      recentTransactions: [{ date: '2026-09-01', payee: 'Groceries', amount: -25_000 }],
    },
    {
      accountId: 'card-b',
      name: 'Visa',
      balance: -240_000,
      closed: true,
      candidateCategoryIds: ['cat-a', 'cat-b'],
      recentTransactions: [],
    },
  ],
  categories: [
    {
      categoryId: 'cat-a',
      name: 'Visa',
      available: 40_000,
      assigned: 10_000,
      note: 'Personal payments',
    },
    { categoryId: 'cat-b', name: 'Visa', available: 30_000, assigned: 20_000 },
  ],
};

it('requires explicit distinct choices and shows context for duplicate names', () => {
  function Form() {
    const [value, onChange] = React.useState<CreditPaymentMappings>();
    return (
      <>
        <YnabCreditPaymentMatching
          matching={matching}
          value={value}
          onChange={onChange}
          currency="USD"
        />
        <button disabled={!hasCompleteCreditPaymentMappings(matching, value)}>Import</button>
      </>
    );
  }
  render(<Form />);
  const first = screen.getByRole('combobox', { name: 'Visa · Card 1' });
  const second = screen.getByRole('combobox', { name: 'Visa · Card 2 · Closed' });
  expect(first).toHaveValue('');
  expect(second).toHaveValue('');
  expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();
  expect(screen.getByText('Account balance: -$120.00')).toBeInTheDocument();
  expect(screen.getByText('Personal card')).toBeInTheDocument();
  expect(screen.getByText('2026-09-01 · Groceries · -$25.00')).toBeInTheDocument();
  const firstOption = within(first).getByRole('option', { name: /Category 1/ });
  expect(firstOption).toHaveTextContent('Available $40.00 · Assigned $10.00 · Personal payments');
  fireEvent.change(first, { target: { value: 'cat-b' } });
  expect(within(second).getByRole('option', { name: /Category 2/ })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();
  fireEvent.change(second, { target: { value: 'cat-a' } });
  expect(screen.getByRole('button', { name: 'Import' })).toBeEnabled();
  fireEvent.change(first, { target: { value: '' } });
  expect(within(second).getByRole('option', { name: /Category 2/ })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();
});

it.each([
  {
    planId: 'another-plan',
    serverKnowledge: 42,
    byAccountId: { 'card-a': 'cat-a', 'card-b': 'cat-b' },
  },
  { planId: 'plan-1', serverKnowledge: 41, byAccountId: { 'card-a': 'cat-a', 'card-b': 'cat-b' } },
  { planId: 'plan-1', serverKnowledge: 42, byAccountId: { 'card-a': 'cat-a', 'card-b': 'cat-a' } },
  {
    planId: 'plan-1',
    serverKnowledge: 42,
    byAccountId: { 'card-a': 'cat-a', 'card-b': 'unrelated-category' },
  },
])('rejects stale, duplicate, or unrelated selections: %j', (value) => {
  expect(hasCompleteCreditPaymentMappings(matching, value)).toBe(false);
});

it('does not display selections made for a different snapshot', () => {
  render(
    <YnabCreditPaymentMatching
      matching={matching}
      value={{ planId: 'plan-1', serverKnowledge: 41, byAccountId: { 'card-a': 'cat-a' } }}
      onChange={vi.fn()}
      currency="USD"
    />
  );
  expect(screen.getByRole('combobox', { name: 'Visa · Card 1' })).toHaveValue('');
});
