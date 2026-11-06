import type { Agorot } from './money';

export const EXPENSE_CATEGORIES: Record<string, string> = {
  office: 'משרד וציוד מתכלה',
  equipment: 'ציוד ומחשבים',
  software: 'תוכנה ומנויים',
  communication: 'תקשורת וטלפון',
  vehicle: 'רכב ונסיעות',
  professional: 'שירותים מקצועיים (רו"ח, עו"ד)',
  training: 'השתלמויות וספרות מקצועית',
  marketing: 'פרסום ושיווק',
  rent: 'שכירות',
  other: 'אחר',
};

export const EXPENSE_STATUS_LABEL = { needs_review: 'לבדיקה', confirmed: 'נבדק' } as const;
export type ExpenseStatus = keyof typeof EXPENSE_STATUS_LABEL;

export const ALLOWED_ATTACHMENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'];
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export interface ExpenseDraft {
  supplier: string;
  doc_date: string;
  amount_agorot: Agorot | null;
  vat_agorot: Agorot | null;
  business_use_pct: number;
}

/** Field errors keyed by field name (Hebrew). Mirrors the table's check constraints. */
export function expenseProblems(e: ExpenseDraft): Record<string, string> {
  const out: Record<string, string> = {};
  if (!e.supplier.trim()) out.supplier = 'יש להזין שם ספק';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.doc_date)) out.doc_date = 'יש להזין תאריך';
  if (e.amount_agorot === null) out.amount = 'יש להזין סכום תקין';
  else if (e.amount_agorot <= 0) out.amount = 'הסכום חייב להיות חיובי';
  if (e.vat_agorot === null || e.vat_agorot < 0) out.vat = 'סכום מע"מ לא תקין';
  else if (e.amount_agorot !== null && e.vat_agorot > e.amount_agorot) out.vat = 'המע"מ לא יכול להיות גדול מהסכום';
  if (!Number.isInteger(e.business_use_pct) || e.business_use_pct < 0 || e.business_use_pct > 100) out.business_use_pct = 'אחוז בין 0 ל-100';
  return out;
}

export function attachmentProblem(f: { type: string; size: number }): string | null {
  if (!ALLOWED_ATTACHMENT_TYPES.includes(f.type)) return 'אפשר לצרף תמונה (JPG, PNG, WEBP, HEIC) או PDF בלבד';
  if (f.size <= 0) return 'הקובץ ריק';
  if (f.size > MAX_ATTACHMENT_BYTES) return 'הקובץ גדול מ-10MB';
  return null;
}

interface Comparable { id?: string; supplier: string; doc_number: string; doc_date: string; amount_agorot: Agorot }

const daysBetween = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** Possible duplicates: same supplier and document number, or same supplier and amount within 3 days. */
export function possibleDuplicates<T extends Comparable>(e: Comparable, existing: T[]): T[] {
  return existing.filter((x) => x.id !== e.id && norm(x.supplier) === norm(e.supplier) && (
    (e.doc_number.trim() !== '' && x.doc_number.trim() === e.doc_number.trim())
    || (x.amount_agorot === e.amount_agorot && daysBetween(x.doc_date, e.doc_date) <= 3)));
}

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif', 'application/pdf': 'pdf',
};
export function fileExtension(mime: string): string {
  return EXT_BY_MIME[mime] ?? 'bin';
}
