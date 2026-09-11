import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { YNABApiPlanSnapshot, YNABImportPreview } from '@budgero/core/browser';
import { INITIAL_STATE, ONBOARDING_STEPS, type OnboardingFormState } from '../onboarding-data';
import { YnabImportStep } from './YnabImportStep';

const mocks = vi.hoisted(() => ({ listPlans: vi.fn(), getPlan: vi.fn() }));
vi.mock('@budgero/core/browser', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@budgero/core/browser')>()),
  YNABApiClient: class {
    listPlans = mocks.listPlans;

    getPlan = mocks.getPlan;
  },
}));

vi.mock('@shared/ui/select', () => ({
  Select: ({
    children,
    value,
    onValueChange,
    disabled,
  }: {
    children: React.ReactNode;
    value: string;
    onValueChange: (value: string) => void;
    disabled?: boolean;
  }) => (
    <select
      aria-label="YNAB plan"
      value={value}
      disabled={disabled}
      onChange={(event) => onValueChange(event.target.value)}
    >
      {children}
    </select>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <option value={value}>{children}</option>
  ),
}));

const preview: YNABImportPreview = {
  accountCount: 2,
  categoryCount: 2,
  registerRowCount: 0,
  missingCategories: [],
  splitTransactions: [],
  creditPaymentMatching: {
    planId: 'plan',
    serverKnowledge: 42,
    accounts: ['a', 'b'].map((id) => ({
      accountId: `card-${id}`,
      name: 'Visa',
      closed: false,
      balance: 0,
      recentTransactions: [],
      candidateCategoryIds: ['cat-a', 'cat-b'],
    })),
    categories: ['a', 'b'].map((id) => ({
      categoryId: `cat-${id}`,
      name: 'Visa',
      available: 0,
      assigned: 0,
    })),
  },
};
const snapshot = { plan: { id: 'plan', name: 'Test plan' } } as YNABApiPlanSnapshot;

function Form() {
  const [state, setState] = React.useState<OnboardingFormState>(INITIAL_STATE);
  const set = (patch: Partial<OnboardingFormState>) =>
    setState((current) => ({ ...current, ...patch }));
  return (
    <>
      <YnabImportStep
        cur={ONBOARDING_STEPS.find((step) => step.id === 'ynab_import')!}
        state={state}
        set={set}
        isInspecting={false}
        onFileSelected={vi.fn()}
        onApiSnapshotSelected={(ynabApiSnapshot) =>
          set({ ynabApiSnapshot, ynabPreview: preview, ynabCreditPaymentMappings: undefined })
        }
      />
      <span>Mappings: {JSON.stringify(state.ynabCreditPaymentMappings)}</span>
      <span>Source: {state.ynabApiSnapshot?.plan.id ?? 'none'}</span>
    </>
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.listPlans.mockResolvedValue([
    { id: 'plan', name: 'Test plan' },
    { id: 'other-plan', name: 'Another plan' },
  ]);
  mocks.getPlan.mockResolvedValue(snapshot);
});

async function connectAndMatch() {
  render(<Form />);
  fireEvent.change(screen.getByLabelText('YNAB personal access token'), {
    target: { value: 'test-token' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'CONNECT' }));
  const first = await screen.findByRole('combobox', { name: 'Visa · Card 1' });
  expect(screen.getByText('MATCH CARDS')).toBeInTheDocument();
  fireEvent.change(first, { target: { value: 'cat-b' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Visa · Card 2' }), {
    target: { value: 'cat-a' },
  });
  expect(screen.getByText('✓ READY')).toBeInTheDocument();
}

it('collects mappings and clears them when switching sources', async () => {
  await connectAndMatch();
  expect(screen.getByText(/^Mappings:/)).toHaveTextContent('"card-a":"cat-b"');
  fireEvent.click(screen.getByRole('button', { name: 'EXPORT ZIP' }));
  expect(screen.getByText(/^Mappings:/)).not.toHaveTextContent('card-a');
  expect(screen.getByText('Source: none')).toBeInTheDocument();
});

it('clears selected mappings before a plan reload, including when the reload fails', async () => {
  await connectAndMatch();
  mocks.getPlan.mockRejectedValue(new Error('Reload failed'));
  fireEvent.change(screen.getByRole('combobox', { name: 'YNAB plan' }), {
    target: { value: 'other-plan' },
  });
  expect(screen.getByText(/^Mappings:/)).not.toHaveTextContent('card-a');
  expect(screen.getByText('Source: none')).toBeInTheDocument();
  expect(await screen.findByText('Reload failed')).toBeInTheDocument();
  expect(screen.getByText('Source: none')).toBeInTheDocument();
});

it('does not restore a late connection after switching sources', async () => {
  let resolve!: (snapshot: YNABApiPlanSnapshot) => void;
  mocks.getPlan.mockReturnValue(
    new Promise<YNABApiPlanSnapshot>((done) => {
      resolve = done;
    })
  );
  render(<Form />);
  fireEvent.change(screen.getByLabelText('YNAB personal access token'), {
    target: { value: 'test-token' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'CONNECT' }));
  await waitFor(() => expect(mocks.getPlan).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button', { name: 'EXPORT ZIP' }));
  await act(async () => resolve(snapshot));
  expect(screen.getByText('Source: none')).toBeInTheDocument();
});
