import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { YNABImportResult } from '@budgero/core/browser';

import OnboardingFlow from './OnboardingFlow';

const { mockRunOnboardingApply, mockReviewDecision } = vi.hoisted(() => ({
  mockRunOnboardingApply: vi.fn(),
  mockReviewDecision: vi.fn(),
}));

vi.mock('./apply-onboarding', () => ({
  runOnboardingApply: mockRunOnboardingApply,
}));

vi.mock('./onboarding-data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./onboarding-data')>();
  return {
    ...actual,
    INITIAL_STATE: {
      ...actual.INITIAL_STATE,
      startMode: 'ynab',
      budgetName: 'YNAB test plan',
      password: 'test-password',
      passwordConfirm: 'test-password',
      acknowledgedRules: true,
      ynabApiSnapshot: { plan: { name: 'YNAB test plan' } },
      ynabPreview: {
        registerRowCount: 10,
        accountCount: 1,
        categoryCount: 1,
        missingCategories: [],
        splitTransactions: [],
      },
    },
    PATH_STEPS: {
      ...actual.PATH_STEPS,
      ynab: ['ynab_import', 'password', 'done'],
    },
  };
});

vi.mock('./steps', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./steps')>();
  return {
    ...actual,
    YnabImportStep: ({ set }: { set: (value: Record<string, unknown>) => void }) => (
      <div>
        YNAB source selection
        <button
          onClick={() =>
            set({
              ynabApiSnapshot: null,
              ynabFile: { name: 'synthetic.zip', bytes: new ArrayBuffer(1), size: '1 B' },
              ynabPreview: { dateOrderAmbiguous: true },
              ynabDateOrder: undefined,
            })
          }
        >
          Load ambiguous ZIP
        </button>
        <button onClick={() => set({ ynabDateOrder: 'month-first' })}>Use month-first dates</button>
      </div>
    ),
    PasswordStep: () => <div>Master password</div>,
  };
});

vi.mock('@shared/runtime/runtime-provider', () => ({
  useRuntime: () => ({}),
}));

vi.mock('@entities/user/api/useAuth', () => ({
  useLogout: () => ({ mutate: vi.fn() }),
  useProfile: () => ({ data: { id: 'profile-1' } }),
  useUpdateOnboarding: () => ({ mutateAsync: vi.fn() }),
}));

vi.mock('@shared/contexts/ThemePresetContext', () => ({
  useThemePreset: () => ({ setThemeId: vi.fn() }),
}));

vi.mock('@features/budget-sharing/lib/pending-space-invite', () => ({
  readPendingSpaceInvite: () => Promise.resolve(null),
}));

const warnedResult: YNABImportResult = {
  budgetId: 7,
  summary: {
    registerRowsImported: 10,
    transactionsCreated: 10,
    missingCategoriesCreated: [],
    splitTransactionsImported: 0,
  },
  verification: {
    status: 'warning',
    source: { transactions: 10, subtransactions: 0, registerRows: 10 },
    accounts: { checked: 1, matched: 1, debtBalanceAdjustments: [] },
    categories: { checked: 3, matched: 3, mismatches: [], omittedMismatches: 0 },
    readyToAssign: {
      checked: 1,
      matched: 0,
      mismatches: [
        {
          month: '2026-09',
          expectedReadyToAssign: 10_000,
          computedReadyToAssign: 9_000,
          difference: -1_000,
          breakdown: {
            income: 10_000,
            assignments: 1_000,
            offBudgetTransfers: 0,
            inBudgetTransfers: 0,
            revaluations: 0,
            priorCashOverspend: 0,
          },
        },
      ],
    },
  },
};

const passedResult: YNABImportResult = {
  ...warnedResult,
  verification: {
    ...warnedResult.verification!,
    status: 'passed',
    readyToAssign: { checked: 1, matched: 1, mismatches: [] },
  },
};

describe('OnboardingFlow YNAB import verification', () => {
  beforeEach(() => {
    mockRunOnboardingApply.mockReset();
    mockReviewDecision.mockReset();
  });

  it('shows live progress and pauses on warnings until the user removes the import', async () => {
    let continueImport: (() => void) | undefined;
    const importGate = new Promise<void>((resolve) => {
      continueImport = resolve;
    });

    mockRunOnboardingApply.mockImplementation(async (_state, deps) => {
      deps.setApplyStatus('running');
      await deps.onYnabProgress({
        stage: 'categories',
        status: 'running',
        progress: 42,
        label: 'Importing categories',
        detail: '1 category mapping',
      });
      await importGate;
      deps.onYnabResult(warnedResult);
      const reviewDecision = deps.reviewYnabImport(warnedResult);
      await deps.onYnabProgress({
        stage: 'complete',
        status: 'warning',
        progress: 99,
        label: 'Waiting for your review',
      });
      const decision = await reviewDecision;
      mockReviewDecision(decision);
      if (decision === 'cancel') {
        deps.setApplyStatus('idle');
        deps.onYnabImportCancelled();
      }
    });

    render(
      <MemoryRouter>
        <QueryClientProvider client={new QueryClient()}>
          <OnboardingFlow onComplete={vi.fn()} />
        </QueryClientProvider>
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole('button', { name: /Let’s begin/ }));
    expect(screen.getByText('Master password')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Import my budget/ }));

    expect(await screen.findByText('Importing from YNAB')).toBeInTheDocument();
    expect(await screen.findByText('42%')).toBeInTheDocument();
    expect(screen.getByText('1 category mapping')).toBeInTheDocument();

    await act(async () => continueImport?.());

    expect(await screen.findByText('Review YNAB differences')).toBeInTheDocument();
    expect(screen.getByText('10 rows exact')).toBeInTheDocument();
    expect(screen.getByText('1 of 1 exact')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import anyway' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel and remove' }));

    await waitFor(() => expect(mockReviewDecision).toHaveBeenCalledWith('cancel'));
    expect(await screen.findByText('YNAB source selection')).toBeInTheDocument();
  });

  it('keeps a successful verification report open until the user continues', async () => {
    const onComplete = vi.fn();
    mockRunOnboardingApply.mockImplementation(async (_state, deps) => {
      deps.setApplyStatus('running');
      deps.onYnabResult(passedResult);
      const continueFromReport = deps.waitForYnabContinue();
      await deps.onYnabProgress({
        stage: 'complete',
        status: 'passed',
        progress: 100,
        label: 'Imported budget saved',
      });
      if (await continueFromReport) deps.onComplete();
    });

    render(
      <MemoryRouter>
        <QueryClientProvider client={new QueryClient()}>
          <OnboardingFlow onComplete={onComplete} />
        </QueryClientProvider>
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole('button', { name: /Let’s begin/ }));
    expect(screen.getByText('Master password')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Import my budget/ }));

    expect(await screen.findByText('YNAB import verified')).toBeInTheDocument();
    expect(screen.getByText('100%')).toBeInTheDocument();
    expect(onComplete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Open imported budget' }));
    await waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
  });
});

it('requires a date-order choice before advancing an ambiguous ZIP through onboarding', async () => {
  render(
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient()}>
        <OnboardingFlow onComplete={vi.fn()} />
      </QueryClientProvider>
    </MemoryRouter>
  );
  fireEvent.click(screen.getByRole('button', { name: 'Load ambiguous ZIP' }));
  expect(screen.getByRole('button', { name: /Let’s begin/ })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Use month-first dates' }));
  expect(screen.getByRole('button', { name: /Let’s begin/ })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: /Let’s begin/ }));
  expect(screen.getByText('Master password')).toBeInTheDocument();
});
