import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { YNABImportPreview } from '@budgero/core/browser';
import { YnabImportTab } from './YnabImportTab';

vi.mock('@features/currencies/ui/CurrencySelector', () => ({
  CurrencySelector: () => <div data-testid="currency-selector" />,
}));

vi.mock('@features/budget-management/ui/IconPicker', () => ({
  IconPicker: () => <div data-testid="icon-picker" />,
}));

vi.mock('@features/budget-management/ui/FormatSelector', () => ({
  FormatSelector: () => <div data-testid="format-selector" />,
}));

vi.mock('./YnabExportGuide', () => ({
  YnabExportGuide: () => <div data-testid="ynab-export-guide" />,
}));

const preview: YNABImportPreview = {
  registerRowCount: 4,
  accountCount: 1,
  categoryCount: 4,
  missingCategories: [
    {
      categoryGroup: 'Archive',
      category: 'Missing From Plan',
      transactionCount: 1,
    },
  ],
  splitTransactions: [
    {
      account: 'Checking',
      date: '2026-08-30',
      payees: ['Split Store'],
      partCount: 3,
    },
  ],
};

describe('YnabImportTab', () => {
  it('previews counts, account-type guidance, created categories, and automatic splits', () => {
    render(
      <YnabImportTab
        sourceMode="zip"
        onSourceModeChange={vi.fn()}
        personalAccessToken=""
        onPersonalAccessTokenChange={vi.fn()}
        plans={[]}
        selectedPlanId=""
        onSelectedPlanChange={vi.fn()}
        isConnecting={false}
        onConnect={vi.fn()}
        budgetName="Imported budget"
        onBudgetNameChange={vi.fn()}
        currency="USD"
        onCurrencyChange={vi.fn()}
        numberFormat="123,456.78"
        onNumberFormatChange={vi.fn()}
        importBadgeIcon="💰"
        onImportBadgeIconChange={vi.fn()}
        fileInputRef={React.createRef<HTMLInputElement>()}
        file={new File(['zip'], 'edge-cases.zip', { type: 'application/zip' })}
        onFileChange={vi.fn()}
        onDateOrderChange={vi.fn()}
        preview={preview}
        isInspecting={false}
        isImporting={false}
        onReset={vi.fn()}
        onImport={vi.fn()}
      />
    );

    expect(screen.getByText(/1 account · 4 categories · 4 register rows/)).toBeInTheDocument();
    expect(screen.getByText('Review account types after import')).toBeInTheDocument();
    expect(screen.getByText(/Archive › Missing From Plan/)).toBeInTheDocument();
    expect(screen.getByText(/as split transactions automatically/)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Dates in this export' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import' })).toBeEnabled();
  });

  it('offers a direct API connection without persisting the token', () => {
    render(
      <YnabImportTab
        sourceMode="api"
        onSourceModeChange={vi.fn()}
        personalAccessToken="secret"
        onPersonalAccessTokenChange={vi.fn()}
        plans={[
          {
            id: 'plan-1',
            name: 'Test plan',
            last_modified_on: '2026-09-03T00:00:00Z',
            first_month: '2026-01-01',
            last_month: '2026-09-01',
            currency_format: {
              iso_code: 'USD',
              example_format: '123,456.78',
              decimal_digits: 2,
              decimal_separator: '.',
              symbol_first: true,
              group_separator: ',',
              currency_symbol: '$',
              display_symbol: true,
            },
          },
        ]}
        selectedPlanId="plan-1"
        onSelectedPlanChange={vi.fn()}
        isConnecting={false}
        onConnect={vi.fn()}
        budgetName="Imported budget"
        onBudgetNameChange={vi.fn()}
        currency="USD"
        onCurrencyChange={vi.fn()}
        numberFormat="123,456.78"
        onNumberFormatChange={vi.fn()}
        importBadgeIcon="💰"
        onImportBadgeIconChange={vi.fn()}
        fileInputRef={React.createRef<HTMLInputElement>()}
        file={null}
        onFileChange={vi.fn()}
        onDateOrderChange={vi.fn()}
        preview={preview}
        isInspecting={false}
        isImporting={false}
        onReset={vi.fn()}
        onImport={vi.fn()}
      />
    );

    expect(screen.getByLabelText('YNAB personal access token')).toHaveAttribute('type', 'password');
    expect(screen.getByText('Test plan')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'YNAB plan' }).tagName).toBe('BUTTON');
    expect(screen.getByText(/never saved to Budgero or browser storage/)).toBeInTheDocument();
    expect(screen.getByText(/Account types and on-budget status/)).toBeInTheDocument();
    expect(screen.queryByTestId('ynab-export-guide')).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: 'How to create a YNAB personal access token' })
    );
    expect(screen.getByText(/open Account Settings/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open YNAB Developer Settings/ })).toHaveAttribute(
      'href',
      'https://app.ynab.com/settings/developer'
    );
  });
});

describe('ambiguous ZIP date choice', () => {
  it.each(['Month first', 'Day first'])(
    'requires an explicit %s choice before enabling Import',
    (label) => {
      const onImport = vi.fn();
      const props: React.ComponentProps<typeof YnabImportTab> = {
        sourceMode: 'zip',
        onSourceModeChange: vi.fn(),
        personalAccessToken: '',
        onPersonalAccessTokenChange: vi.fn(),
        plans: [],
        selectedPlanId: '',
        onSelectedPlanChange: vi.fn(),
        isConnecting: false,
        onConnect: vi.fn(),
        budgetName: 'Synthetic dates',
        onBudgetNameChange: vi.fn(),
        currency: 'USD',
        onCurrencyChange: vi.fn(),
        numberFormat: '$1,096.56',
        onNumberFormatChange: vi.fn(),
        importBadgeIcon: 'Wallet',
        onImportBadgeIconChange: vi.fn(),
        fileInputRef: React.createRef<HTMLInputElement>(),
        file: new File(['synthetic'], 'dates.zip'),
        onFileChange: vi.fn(),
        preview: { ...preview, dateOrderAmbiguous: true },
        onDateOrderChange: vi.fn(),
        isInspecting: false,
        isImporting: false,
        onReset: vi.fn(),
        onImport,
      };
      function Form() {
        const [dateOrder, setDateOrder] =
          React.useState<React.ComponentProps<typeof YnabImportTab>['dateOrder']>();
        return <YnabImportTab {...props} dateOrder={dateOrder} onDateOrderChange={setDateOrder} />;
      }
      render(<Form />);
      const button = screen.getByRole('button', { name: 'Import' });
      expect(button).toBeDisabled();
      fireEvent.click(screen.getByRole('radio', { name: new RegExp(label) }));
      expect(button).toBeEnabled();
      fireEvent.click(button);
      expect(onImport).toHaveBeenCalledOnce();
    }
  );
});
