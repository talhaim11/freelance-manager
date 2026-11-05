export type VatStatus = 'exempt' | 'licensed';

export interface VatStatusPeriod {
  id: string;
  status: VatStatus;
  effective_from: string; // YYYY-MM-DD
  effective_to: string | null;
  note?: string;
}

/**
 * VAT status in force on a date. Mirrors app.vat_status_on() in SQL:
 * the latest period that started on or before the date and has not ended.
 * Returns null when unknown — callers must not guess.
 */
export function vatStatusOn(periods: VatStatusPeriod[], date: string): VatStatus | null {
  const candidates = periods
    .filter((p) => p.effective_from <= date && (p.effective_to === null || p.effective_to >= date))
    .sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1));
  return candidates[0]?.status ?? null;
}

export const VAT_STATUS_LABEL: Record<VatStatus, string> = {
  exempt: 'עוסק פטור',
  licensed: 'עוסק מורשה',
};
