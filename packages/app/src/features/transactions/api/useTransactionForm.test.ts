import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { getLastUsedTransactionStorageKey, readLastUsedAccountId } from '../lib/last-used-storage';
import { mergeLastUsedFields, useTransactionForm } from './useTransactionForm';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('remembered transaction scope', () => {
  const open = (spaceId: string | null, budgetId: number, disableLastUsed = false) =>
    renderHook(() =>
      useTransactionForm({
        lastUsedStorageKey: getLastUsedTransactionStorageKey(spaceId, budgetId),
        disableLastUsed,
      })
    );

  it('keeps defaults separate by both budget and space and restores them when returning', () => {
    const fieldsA = { payee: 'Cafe A', category: 'Dining', accountId: '10', labelId: 8 };
    const a = open('space-a', 1);
    act(() => a.result.current.persistLastUsed('outflow', fieldsA));
    a.unmount();

    const b = open('space-a', 5);
    expect(b.result.current.lastUsed.outflow).toEqual({});
    act(() => b.result.current.persistLastUsed('outflow', { payee: 'Cafe B', accountId: '20' }));
    b.unmount();

    const otherSpace = open('space-b', 1);
    expect(otherSpace.result.current.lastUsed.outflow).toEqual({});
    otherSpace.unmount();

    const restored = open('space-a', 1);
    expect(restored.result.current.lastUsed.outflow).toEqual(fieldsA);
    // The mobile entry point reads exactly the same scoped defaults.
    expect(readLastUsedAccountId(getLastUsedTransactionStorageKey('space-a', 1))).toBe(10);
    expect(readLastUsedAccountId(getLastUsedTransactionStorageKey('space-a', 5))).toBe(20);
    expect(readLastUsedAccountId(getLastUsedTransactionStorageKey('space-b', 1))).toBeUndefined();
  });

  it('ignores legacy defaults with unknown ownership', () => {
    localStorage.setItem(
      'budgero:add-transaction:last-used',
      JSON.stringify({
        outflow: { payee: 'Foreign payee', labelId: 8, accountId: '10' },
      })
    );
    const form = open('space-a', 5);
    expect(form.result.current.lastUsed.outflow).toEqual({});
    expect(form.result.current.selectedFromAccount).toBe('');
    expect(readLastUsedAccountId(getLastUsedTransactionStorageKey('space-a', 5))).toBeUndefined();
  });

  it.each([null, 'space-a'])('does not write defaults without a valid scope (%s)', (spaceId) => {
    const form = open(spaceId, spaceId ? 0 : 1);
    act(() => form.result.current.persistLastUsed('outflow', { payee: 'Cafe' }));
    expect(localStorage.length).toBe(0);
  });

  it('honors disabled remembering and recurring forms', () => {
    const form = open('space-a', 1);
    act(() => form.result.current.setRememberLast(false));
    act(() => form.result.current.persistLastUsed('outflow', { payee: 'Cafe' }));
    expect(localStorage.getItem(getLastUsedTransactionStorageKey('space-a', 1)!)).toBeNull();
    form.unmount();

    const recurring = open('space-a', 1, true);
    act(() => recurring.result.current.persistLastUsed('outflow', { payee: 'Recurring' }));
    expect(localStorage.getItem(getLastUsedTransactionStorageKey('space-a', 1)!)).toBeNull();
  });
});

describe('mergeLastUsedFields', () => {
  it('remembers a newly selected label', () => {
    const next = mergeLastUsedFields({}, { labelId: 5 });
    expect(next.labelId).toBe(5);
  });

  it('clears the remembered label when the user saves with "No label" (null)', () => {
    // Regression: previously null was coerced to undefined and ignored, so a
    // stale label (e.g. "Corolla") kept re-appearing on the next transaction.
    const next = mergeLastUsedFields({ labelId: 5 }, { labelId: null });
    expect(next.labelId).toBeNull();
  });

  it('keeps the remembered label when labelId is absent from the update', () => {
    const next = mergeLastUsedFields({ labelId: 5 }, { payee: 'Amazon' });
    expect(next.labelId).toBe(5);
    expect(next.payee).toBe('Amazon');
  });

  it('ignores non-positive label ids', () => {
    const next = mergeLastUsedFields({ labelId: 5 }, { labelId: 0 });
    expect(next.labelId).toBe(5);
  });

  it('merges category, payee, and account without disturbing the label', () => {
    const next = mergeLastUsedFields(
      { labelId: 3 },
      { category: 'Groceries', payee: 'Amazon', accountId: '2' }
    );
    expect(next).toEqual({ labelId: 3, category: 'Groceries', payee: 'Amazon', accountId: '2' });
  });
});
