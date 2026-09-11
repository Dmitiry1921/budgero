import type { YNABImportConfig, YNABImportPreview } from '@budgero/core/browser';

export type CreditPaymentMatching = NonNullable<YNABImportPreview['creditPaymentMatching']>;
export type CreditPaymentMappings = NonNullable<YNABImportConfig['creditPaymentMappings']>;

export function hasCompleteCreditPaymentMappings(
  matching: CreditPaymentMatching | undefined,
  mappings: CreditPaymentMappings | undefined
): boolean {
  if (!matching) return true;
  if (
    !mappings ||
    mappings.planId !== matching.planId ||
    mappings.serverKnowledge !== matching.serverKnowledge
  ) {
    return false;
  }
  const used = new Set<string>();
  return matching.accounts.every((account) => {
    const categoryId = mappings.byAccountId[account.accountId];
    if (
      !categoryId ||
      !account.candidateCategoryIds.includes(categoryId) ||
      !matching.categories.some((category) => category.categoryId === categoryId) ||
      used.has(categoryId)
    ) {
      return false;
    }
    used.add(categoryId);
    return true;
  });
}
