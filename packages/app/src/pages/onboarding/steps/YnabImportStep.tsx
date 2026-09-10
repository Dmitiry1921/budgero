import React from 'react';
import type { YNABApiPlanSnapshot, YNABApiPlanSummary } from '@budgero/core/browser';
import { YNABApiClient } from '@budgero/core/browser';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@shared/ui/select';
import { YnabPatHelpPopover } from '@features/budget-management/ui/create-budget-form/YnabPatHelpPopover';
import { YnabDateOrderChoice } from '@features/budget-management/ui/create-budget-form/YnabDateOrderChoice';
import { Title, type StepProps } from './shared';

interface YnabStepProps extends StepProps {
  onFileSelected: (file: File) => Promise<void> | void;
  onApiSnapshotSelected: (snapshot: YNABApiPlanSnapshot) => Promise<void> | void;
  isInspecting: boolean;
}

export const YnabImportStep: React.FC<YnabStepProps> = ({
  cur,
  state,
  set,
  onFileSelected,
  onApiSnapshotSelected,
  isInspecting,
}) => {
  const file = state.ynabFile;
  const apiSnapshot = state.ynabApiSnapshot;
  const preview = state.ynabPreview;
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const [sourceMode, setSourceMode] = React.useState<'api' | 'zip'>('api');
  const [token, setToken] = React.useState('');
  const [plans, setPlans] = React.useState<YNABApiPlanSummary[]>([]);
  const [selectedPlanId, setSelectedPlanId] = React.useState('');
  const [isConnecting, setIsConnecting] = React.useState(false);
  const [connectionError, setConnectionError] = React.useState('');
  const hasSource = Boolean(file || apiSnapshot);
  const needsDateOrder = Boolean(file && preview?.dateOrderAmbiguous && !state.ynabDateOrder);

  const loadPlan = async (planId: string, accessToken = token) => {
    if (!planId || !accessToken.trim()) return;
    setIsConnecting(true);
    setConnectionError('');
    try {
      const snapshot = await new YNABApiClient(accessToken).getPlan(planId);
      setSelectedPlanId(planId);
      await onApiSnapshotSelected(snapshot);
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : 'Could not read that plan');
    } finally {
      setIsConnecting(false);
    }
  };

  const connect = async () => {
    if (!token.trim()) return;
    setIsConnecting(true);
    setConnectionError('');
    try {
      const availablePlans = await new YNABApiClient(token).listPlans();
      if (availablePlans.length === 0) throw new Error('No plans are available for this token');
      setPlans(availablePlans);
      const firstPlanId = availablePlans[0].id;
      const snapshot = await new YNABApiClient(token).getPlan(firstPlanId);
      setSelectedPlanId(firstPlanId);
      await onApiSnapshotSelected(snapshot);
    } catch (error) {
      setPlans([]);
      setConnectionError(error instanceof Error ? error.message : 'Could not connect to YNAB');
    } finally {
      setIsConnecting(false);
    }
  };

  const switchSource = (mode: 'api' | 'zip') => {
    setSourceMode(mode);
    set({
      ynabFile: null,
      ynabApiSnapshot: null,
      ynabPreview: null,
      ynabDateOrder: undefined,
      ynabSourceNumberFormat: undefined,
    });
  };

  return (
    <div>
      <Title h={cur.title} sub={cur.subtitle} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 12 }}>
        <button
          type="button"
          onClick={() => switchSource('api')}
          style={{
            padding: 9,
            border: '1px solid #141414',
            background: sourceMode === 'api' ? '#141414' : 'transparent',
            color: sourceMode === 'api' ? '#fbf7eb' : '#141414',
            fontFamily: 'inherit',
            fontWeight: 700,
          }}
        >
          CONNECT DIRECTLY
        </button>
        <button
          type="button"
          onClick={() => switchSource('zip')}
          style={{
            padding: 9,
            border: '1px solid #141414',
            background: sourceMode === 'zip' ? '#141414' : 'transparent',
            color: sourceMode === 'zip' ? '#fbf7eb' : '#141414',
            fontFamily: 'inherit',
            fontWeight: 700,
          }}
        >
          EXPORT ZIP
        </button>
      </div>

      {sourceMode === 'api' && !apiSnapshot && (
        <div style={{ marginTop: 12, display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{ fontSize: 11, fontWeight: 700 }}>YNAB PERSONAL ACCESS TOKEN</div>
            <YnabPatHelpPopover className="text-[#393939] hover:bg-black/10 hover:text-[#141414]" />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              id="onboarding-ynab-token"
              aria-label="YNAB personal access token"
              type="password"
              autoComplete="off"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder="Used for this import only"
              disabled={isConnecting}
              style={{ flex: 1, minWidth: 0, padding: 9, border: '1px solid #141414' }}
            />
            <button
              type="button"
              disabled={!token.trim() || isConnecting}
              onClick={() => void connect()}
              style={{
                padding: '8px 14px',
                border: '1px solid #141414',
                background: '#141414',
                color: '#fbf7eb',
                fontFamily: 'inherit',
                fontWeight: 700,
              }}
            >
              {isConnecting ? 'CONNECTING…' : 'CONNECT'}
            </button>
          </div>
          <div style={{ fontSize: 10, color: '#393939' }}>
            Kept in memory for this import and never saved to Budgero or browser storage.
          </div>
          {connectionError && (
            <div style={{ fontSize: 11, color: '#9f2d24' }}>{connectionError}</div>
          )}
        </div>
      )}

      {sourceMode === 'api' && plans.length > 0 && (
        <Select
          value={selectedPlanId}
          disabled={isConnecting}
          onValueChange={(planId) => void loadPlan(planId)}
        >
          <SelectTrigger
            aria-label="YNAB plan"
            className="mt-2.5 w-full min-w-0 border-[#141414] bg-[#fbf7eb] text-[#141414]"
          >
            <SelectValue placeholder="Select a YNAB plan" />
          </SelectTrigger>
          <SelectContent>
            {plans.map((plan) => (
              <SelectItem key={plan.id} value={plan.id}>
                {plan.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {sourceMode === 'zip' && !file && (
        <div
          style={{
            marginTop: 12,
            padding: 10,
            fontSize: 11,
            color: '#393939',
            lineHeight: 1.6,
            border: '1px dashed rgba(57,57,57,0.3)',
          }}
        >
          <span style={{ fontWeight: 700, color: '#141414' }}>Before you export:</span> in YNAB’s{' '}
          <em>Plan Settings</em>, set Date Format to <code>2025-12-30</code>, Number Format to{' '}
          <code>123,456.78</code> and Currency Placement to “Don’t Show”. Skipping this can shift
          dates and break amounts. Details in the{' '}
          <a
            href="https://budgero.app/docs/ynab-import"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: '#141414', fontWeight: 700 }}
          >
            import guide
          </a>
          .
        </div>
      )}
      {sourceMode === 'zip' && !file && (
        // Presentation wrapper: the click merely widens the hit area of the
        // fully keyboard-accessible "Browse files" button inside.
        <div
          role="presentation"
          aria-busy={isInspecting}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
          }}
          onDrop={(e) => {
            e.preventDefault();
            const f = e.dataTransfer.files?.[0];
            if (f && !isInspecting) void onFileSelected(f);
          }}
          style={{
            marginTop: 12,
            padding: '36px 20px',
            textAlign: 'center',
            cursor: 'pointer',
            border: '2px dashed rgba(57,57,57,0.55)',
            background: '#fffdf8',
          }}
        >
          <div style={{ fontSize: 32, marginBottom: 8 }}>☁</div>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>
            {isInspecting ? 'Inspecting your YNAB export…' : 'Drop your YNAB export here'}
          </div>
          <div style={{ fontSize: 11, color: '#393939', lineHeight: 1.5 }}>
            In YNAB: <em>File › Export Budget</em>. Drop the .zip here —<br />
            nothing leaves your device until you finish.
          </div>
          <button
            type="button"
            disabled={isInspecting}
            onClick={(e) => {
              e.stopPropagation();
              inputRef.current?.click();
            }}
            style={{
              marginTop: 14,
              padding: '8px 16px',
              border: '1px solid #141414',
              background: 'transparent',
              fontFamily: 'inherit',
              fontSize: 11,
              letterSpacing: 1,
              cursor: 'pointer',
            }}
          >
            {isInspecting ? 'INSPECTING…' : 'BROWSE FILES'}
          </button>
          <input
            ref={inputRef}
            type="file"
            accept=".zip,application/zip"
            disabled={isInspecting}
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onFileSelected(f);
            }}
          />
        </div>
      )}
      {hasSource && (
        <div style={{ marginTop: 12, display: 'grid', gap: 12 }}>
          <div
            style={{
              padding: 14,
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              border: '1px dashed rgba(57,57,57,0.5)',
              background: '#fbf7eb',
            }}
          >
            <div
              style={{
                width: 34,
                height: 34,
                border: '1.5px solid #141414',
                background: '#141414',
                color: '#fbf7eb',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 16,
                fontWeight: 700,
              }}
            >
              Y
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>
                {file?.name || apiSnapshot?.plan.name}
              </div>
              <div style={{ fontSize: 10, color: '#393939' }}>
                {file ? `${file.size} · ` : 'Connected through YNAB API · '}
                {needsDateOrder ? 'select the date format below' : 'ready to import on finish'}
              </div>
            </div>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#2f7d31', letterSpacing: 1 }}>
              {needsDateOrder ? 'DATE FORMAT' : '✓ READY'}
            </div>
          </div>
          {preview && (
            <div
              style={{
                padding: 12,
                display: 'grid',
                gap: 10,
                border: '1px dashed rgba(57,57,57,0.35)',
                background: '#fffdf8',
                fontSize: 11,
                color: '#393939',
                lineHeight: 1.5,
              }}
            >
              <div>
                <span style={{ fontWeight: 700, color: '#141414' }}>Detected in this export:</span>{' '}
                {preview.accountCount.toLocaleString()}{' '}
                {preview.accountCount === 1 ? 'account' : 'accounts'} ·{' '}
                {preview.categoryCount.toLocaleString()}{' '}
                {preview.categoryCount === 1 ? 'category' : 'categories'} ·{' '}
                {preview.registerRowCount.toLocaleString()} register{' '}
                {preview.registerRowCount === 1 ? 'row' : 'rows'}
              </div>

              {file && (
                <label htmlFor="onboarding-ynab-source-format" style={{ display: 'grid', gap: 5 }}>
                  <span style={{ fontWeight: 700 }}>Number format in YNAB</span>
                  <select
                    id="onboarding-ynab-source-format"
                    value={state.ynabSourceNumberFormat ?? ''}
                    onChange={(event) => set({ ynabSourceNumberFormat: event.target.value })}
                    style={{
                      padding: 8,
                      border: '1px solid #141414',
                      background: '#fffdf8',
                      color: '#141414',
                    }}
                  >
                    <option value="">Detect from file</option>
                    <option value="1,234.567">Decimal point (1,234.567)</option>
                    <option value="1.234,567">Decimal comma (1.234,567)</option>
                  </select>
                  <span>
                    Choose the separator explicitly if your amounts use three decimal places.
                  </span>
                </label>
              )}

              {file && preview.dateOrderAmbiguous && (
                <YnabDateOrderChoice
                  value={state.ynabDateOrder}
                  onChange={(ynabDateOrder) => set({ ynabDateOrder })}
                  disabled={isInspecting}
                />
              )}

              {file && (
                <div
                  style={{
                    padding: 9,
                    border: '1px solid rgba(198, 137, 44, 0.5)',
                    background: 'rgba(255, 240, 190, 0.35)',
                  }}
                >
                  <span style={{ fontWeight: 700, color: '#141414' }}>
                    Review account types after import.
                  </span>{' '}
                  YNAB does not reliably export account types. Budgero recognizes credit cards where
                  possible and imports other accounts as Checking, so verify every account before
                  budgeting.
                </div>
              )}

              {preview.missingCategories.length > 0 && (
                <div style={{ padding: 9, border: '1px solid rgba(198,57,44,0.35)' }}>
                  <span style={{ fontWeight: 700, color: '#141414' }}>
                    Categories missing from Plan.csv:
                  </span>{' '}
                  {preview.missingCategories
                    .map((category) => `${category.categoryGroup} › ${category.category}`)
                    .join(', ')}
                  . Budgero will create them and report them when the import finishes.
                </div>
              )}

              {preview.splitTransactions.length > 0 && (
                <div
                  style={{
                    padding: 9,
                    border: '1px solid rgba(57,57,57,0.35)',
                  }}
                >
                  <span style={{ display: 'block', fontWeight: 700, color: '#141414' }}>
                    {preview.splitTransactions.length} split transaction
                    {preview.splitTransactions.length === 1 ? '' : 's'} detected
                  </span>
                  Complete contiguous Split (1/n)…Split (n/n) sequences will be imported as split
                  transactions automatically.
                </div>
              )}
            </div>
          )}
          <div
            style={{
              padding: 10,
              fontSize: 11,
              color: '#393939',
              lineHeight: 1.5,
              border: '1px dashed rgba(57,57,57,0.3)',
            }}
          >
            <span style={{ fontWeight: 700, color: '#141414' }}>Heads up:</span> YNAB’s “Age of
            Money”, scheduled transactions, and goals don’t carry over. Accounts, categories,
            assignments, and transaction history do.
          </div>
        </div>
      )}
    </div>
  );
};
