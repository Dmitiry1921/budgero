/** Entity IDs and names in remembered transactions belong to one budget in one space. */
export function getLastUsedTransactionStorageKey(
  spaceId: string | null,
  budgetId: number | null | undefined
): string | null {
  if (!spaceId || !budgetId || !Number.isInteger(budgetId) || budgetId <= 0) return null;
  return `budgero:add-transaction:last-used:${encodeURIComponent(spaceId)}:${budgetId}`;
}

export function readLastUsedAccountId(storageKey: string | null): number | undefined {
  if (!storageKey || typeof window === 'undefined') return undefined;
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw);
    const candidate =
      parsed?.outflow?.accountId || parsed?.inflow?.accountId || parsed?.transfer?.accountId;
    const numeric = Number(candidate);
    return Number.isInteger(numeric) && numeric > 0 ? numeric : undefined;
  } catch {
    return undefined;
  }
}
