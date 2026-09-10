import { beforeEach, describe, expect, it, vi } from 'vitest';
import { executeMutationOp, getUndoSpec } from '@shared/mutations/op-code-registry';

const mocks = vi.hoisted(() => ({
  addTransaction: vi.fn(),
  findOperation: vi.fn(),
  identities: vi.fn(),
  getTransactionByID: vi.fn(),
  deleteTransaction: vi.fn(),
}));
vi.mock('@shared/runtime/global', () => ({
  getRuntime: () => ({
    services: () => ({ transactions: mocks, importHistory: { duplicates: mocks } }),
  }),
}));
const identity = {
  operationId: 'attempt:row-1',
  fileRowKey: 'file:row-1',
  date: '2026-09-01',
  inflow: 0,
  outflow: 10000,
  payee: 'Coffee',
  memo: 'Statement memo',
  currency: 'USD',
};
const args = {
  budgetId: 1,
  accountId: 2,
  categoryId: 3,
  date: identity.date,
  inflow: 0,
  outflow: 10000,
  memo: identity.memo,
  payee: identity.payee,
  importIdentities: [identity],
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.addTransaction.mockResolvedValue(42);
  mocks.identities.mockReturnValue([identity]);
  mocks.getTransactionByID.mockReturnValue({
    ID: 42,
    BudgetID: 1,
    AccountID: 2,
    CategoryID: 3,
    Date: identity.date,
    InflowNative: 0,
    OutflowNative: 10000,
    Payee: 'Edited payee',
    Memo: 'Edited memo',
  });
});
describe('import mutations', () => {
  it('passes provenance into the atomic add and returns a replay-safe result', async () => {
    const result = await executeMutationOp('transactions.import', args);
    expect(result).toEqual({ transactionId: 42, created: true });
    expect(mocks.addTransaction.mock.calls[0].at(-1)).toEqual([identity]);
    expect(getUndoSpec('transactions.import')?.build?.(args, result, undefined)).toEqual([
      { op: 'transactions.delete', args: { id: 42 } },
    ]);
    mocks.findOperation.mockReturnValue(42);
    const replay = await executeMutationOp('transactions.import', args);
    expect(replay).toEqual({ transactionId: 42, created: false });
    expect(mocks.addTransaction).toHaveBeenCalledOnce();
    expect(getUndoSpec('transactions.import')?.build?.(args, replay, undefined)).toEqual([]);
  });
  it('restores source identities alongside edited ledger fields when undoing deletion', async () => {
    const undo = getUndoSpec('transactions.delete')!;
    const before = await undo.capture!({ id: 42 });
    const restore = undo.build!({ id: 42 }, undefined, before)[0];
    expect(restore.args).toMatchObject({
      payee: 'Edited payee',
      memo: 'Edited memo',
      importIdentities: [identity],
    });
    await executeMutationOp(restore.op, restore.args);
    expect(mocks.addTransaction.mock.calls[0].at(-1)).toEqual([identity]);
  });
});
