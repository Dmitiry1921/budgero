import {
  planImportRows,
  importSourceKey,
  type ImportDuplicateService,
} from '@budgero/core/browser';
import { toDecimal } from '@shared/lib/currency/milli';
import type { ParsedData, ColumnMapping, ImportConfig, PreviewRow } from '../model/types';

interface FilePreviewOptions {
  parsedData: ParsedData;
  budgetId: number;
  columnMapping: ColumnMapping;
  importConfig: ImportConfig;
  accounts: { ID: number; Name: string; Currency: string }[];
  skippedRowIndices: Set<number>;
  selectedHeaderIndex: number | null;
  runKey: string;
  duplicates: Pick<ImportDuplicateService, 'plan'>;
}

export async function buildFileImportPreview({
  parsedData,
  budgetId,
  columnMapping,
  importConfig,
  accounts,
  skippedRowIndices,
  selectedHeaderIndex,
  runKey,
  duplicates,
}: FilePreviewOptions): Promise<PreviewRow[]> {
  const bytes = await parsedData.source.file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const fileHash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join(
    ''
  );
  const plans = planImportRows(parsedData.rows, columnMapping, importConfig);
  const inputs = plans.map((plan) => {
    const row = parsedData.rows[plan.index];
    const accountName = columnMapping.account ? row[columnMapping.account]?.trim() : '';
    const matches = accountName
      ? accounts?.filter((a) => a.Name.toLowerCase() === accountName.toLowerCase())
      : [];
    const destinationId = matches?.length === 1 ? matches[0].ID : importConfig.defaultAccountId;
    const account = accounts?.find((a) => a.ID === destinationId);
    const valid = plan.status === 'ready' && !skippedRowIndices.has(plan.index);
    if (valid && !account && destinationId !== -1)
      throw new Error(
        `Choose a destination account in Configuration for row ${plan.index + 1}${accountName ? ` (${accountName})` : ''}.`
      );
    const currency = account?.Currency ?? importConfig.accountCurrency;
    if (
      valid &&
      (parsedData.source.type === 'ofx' || parsedData.source.type === 'camt') &&
      row.Currency &&
      row.Currency !== currency
    ) {
      throw new Error(
        `Row ${plan.index + 1} is in ${row.Currency}; choose an account in that currency.`
      );
    }
    const interpretation = [
      plan.date,
      plan.inflow,
      plan.outflow,
      plan.payee,
      plan.memo,
      currency,
      columnMapping.category ? row[columnMapping.category] : '',
      importConfig.skipRows,
      selectedHeaderIndex,
    ];
    const fileRowKey = JSON.stringify(['v1', fileHash, plan.index, interpretation]);
    return {
      ...plan,
      valid,
      budgetId,
      accountId: destinationId ?? 0,
      currency,
      operationId: `${runKey}:${budgetId}:${destinationId}:${fileRowKey}`,
      fileRowKey,
      sourceKey: importSourceKey(parsedData.source.type, row),
    };
  });
  const matches = duplicates.plan(inputs);
  return inputs.map((input, index) => ({
    input,
    duplicate: matches[index],
    decision: matches[index].status === 'already-imported' ? 'skip' : undefined,
    original: parsedData.rows[index],
    errors: plans[index].errors,
    parsed: {
      date: input.date,
      amount: toDecimal(input.inflow) - toDecimal(input.outflow),
      payee: input.payee,
      memo: input.memo,
      account: accounts?.find((a) => a.ID === input.accountId)?.Name ?? 'Import Account (new)',
    },
  }));
}
