/** Money is always integer agorot (1 ₪ = 100 agorot). */
export type Agorot = number;

/** Half-up rounding for non-negative values; half away from zero for negatives (matches PostgreSQL numeric round). */
export function roundHalfAwayFromZero(x: number): number {
  // Guard against binary artefacts such as 1.005 * 100 = 100.49999999999999
  const r = Math.round(Math.abs(x) + 1e-9);
  return x < 0 ? -r : r;
}

/** Parses user input in shekels ("1,234.5", "1234,50") into agorot. Returns null if invalid. */
export function parseShekels(input: string): Agorot | null {
  const s = input.trim().replace(/[₪\s]/g, '');
  if (!s) return null;
  let normalized = s;
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) normalized = s.replace(/,/g, '');
  else if (/^\d+,\d{1,2}$/.test(s)) normalized = s.replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) return null;
  const [whole, frac = ''] = normalized.replace('-', '').split('.');
  if (frac.length > 2) return null;
  const value = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  return normalized.startsWith('-') ? -value : value;
}

const ilsFormatter = new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', minimumFractionDigits: 2 });
export function formatILS(agorot: Agorot): string {
  return ilsFormatter.format(agorot / 100);
}

export function agorotToShekelInput(agorot: Agorot): string {
  return (agorot / 100).toFixed(2);
}
