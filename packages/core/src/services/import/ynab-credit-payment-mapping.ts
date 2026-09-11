import type {
  YNABApiPlanSnapshot,
  YNABCreditPaymentMappings,
  YNABCreditPaymentMatching,
} from './types.js';

/** Source IDs identify the entities; YNAB does not expose their payment link. */
export function inspectYNABCreditPaymentMappings(snapshot: YNABApiPlanSnapshot): {
  automatic: Map<string, string>;
  matching?: YNABCreditPaymentMatching;
} {
  const { plan } = snapshot;
  const accounts = plan.accounts.filter(
    (account) =>
      !account.deleted && (account.type === 'creditCard' || account.type === 'lineOfCredit')
  );
  const paymentGroupIds = new Set(
    plan.category_groups
      .filter((group) => !group.deleted && group.internal && group.name === 'Credit Card Payments')
      .map((group) => group.id)
  );
  const categories = plan.categories.filter(
    (category) => !category.deleted && paymentGroupIds.has(category.category_group_id)
  );
  const automatic = new Map<string, string>();
  for (const account of accounts) {
    const sameNamedAccounts = accounts.filter((other) => other.name === account.name);
    const sameNamedCategories = categories.filter((category) => category.name === account.name);
    if (sameNamedAccounts.length === 1 && sameNamedCategories.length === 1) {
      automatic.set(account.id, sameNamedCategories[0].id);
    }
  }

  const claimed = new Set(automatic.values());
  const available = categories.filter((category) => !claimed.has(category.id));
  const unresolved = accounts.filter((account) => !automatic.has(account.id));
  // With no unclaimed source envelope there is no source funding to associate.
  // AccountService can create a new, exclusively owned empty payment category.
  if (unresolved.length === 0 || available.length === 0) return { automatic };

  const payees = new Map(plan.payees.map((payee) => [payee.id, payee.name]));
  return {
    automatic,
    matching: {
      planId: plan.id,
      serverKnowledge: snapshot.serverKnowledge,
      accounts: unresolved.map((account) => {
        const sameNamed = available.filter((category) => category.name === account.name);
        return {
          accountId: account.id,
          name: account.name,
          balance: account.balance,
          closed: account.closed,
          ...(account.note ? { note: account.note } : {}),
          candidateCategoryIds: (sameNamed.length ? sameNamed : available).map(
            (category) => category.id
          ),
          recentTransactions: plan.transactions
            .filter((transaction) => !transaction.deleted && transaction.account_id === account.id)
            .sort(
              (left, right) =>
                right.date.localeCompare(left.date) || left.id.localeCompare(right.id)
            )
            .slice(0, 3)
            .map((transaction) => ({
              date: transaction.date,
              payee: (transaction.payee_id && payees.get(transaction.payee_id)) || '',
              amount: transaction.amount,
            })),
        };
      }),
      categories: available.map((category) => ({
        categoryId: category.id,
        name: category.name,
        available: category.balance,
        assigned: category.budgeted,
        ...(category.note ? { note: category.note } : {}),
      })),
    },
  };
}

/** Validate all choices before the importer creates a budget or writes rows. */
export function resolveYNABCreditPaymentMappings(
  snapshot: YNABApiPlanSnapshot,
  selection?: YNABCreditPaymentMappings
): Map<string, string> {
  const { automatic, matching } = inspectYNABCreditPaymentMappings(snapshot);
  if (
    selection &&
    (selection.planId !== snapshot.plan.id ||
      selection.serverKnowledge !== snapshot.serverKnowledge)
  ) {
    throw new Error(
      'The YNAB plan changed. Match its credit-card payment categories again before importing.'
    );
  }
  const unresolved = new Map(
    matching?.accounts.map((account) => [account.accountId, account]) ?? []
  );
  const resolved = new Map(automatic);
  const claimed = new Set(automatic.values());
  for (const [accountId, categoryId] of Object.entries(selection?.byAccountId ?? {})) {
    if (automatic.get(accountId) === categoryId) continue;
    const account = unresolved.get(accountId);
    if (!account || !account.candidateCategoryIds.includes(categoryId)) {
      throw new Error(
        'A selected YNAB payment category does not belong to this card’s available choices.'
      );
    }
    if (claimed.has(categoryId)) {
      throw new Error(
        'Each YNAB credit card needs its own payment category. Match each category only once.'
      );
    }
    resolved.set(accountId, categoryId);
    claimed.add(categoryId);
  }
  if ([...unresolved.keys()].some((accountId) => !resolved.has(accountId))) {
    throw new Error('Match each YNAB credit card to its payment category before importing.');
  }
  return resolved;
}
