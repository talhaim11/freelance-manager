/**
 * Backup format (version 1), its manifest, and conversion of the previous app's data.
 * Pure functions: no network. The manifest is what a restore is verified against.
 */
import type { VatStatusPeriod } from './classification';
import type { Customer, Doc, Expense, ExpenseAttachment, Profile, Series, Submission, TaxProfile } from '../data/types';
import type { AllocationRecord } from './payments';
import { roundHalfAwayFromZero } from './money';

export interface BackupPayload {
  format: 'freelance-manager-backup';
  version: 1;
  exported_at: string;
  source: 'demo' | 'supabase' | 'legacy-app';
  profile: Profile | null;
  vat_periods: Omit<VatStatusPeriod, 'id'>[];
  tax_profile: TaxProfile | null;
  customers: (Customer & { created_at?: string })[];
  series: Series[];
  documents: Doc[];
  allocations: AllocationRecord[];
  expenses: Omit<Expense, 'attachments'>[];
  attachments: ExpenseAttachment[];
  submissions: Submission[];
}

export interface Manifest {
  counts: Record<string, number>;
  /** "doc_type|series name|legacy" -> sorted issued numbers */
  numbers: Record<string, number[]>;
  /** "year|doc_type|status" -> sum of totals (agorot) */
  documentTotals: Record<string, number>;
  /** year -> sum of expense amounts (agorot) */
  expenseTotals: Record<string, number>;
  allocationsTotal: number;
  attachmentSha256: string[];
}

export function manifestOf(p: BackupPayload): Manifest {
  const seriesKey = (id: string) => { const s = p.series.find((x) => x.id === id); return s ? `${s.doc_type}|${s.name}|${s.is_legacy ? 'legacy' : 'new'}` : `?|${id}`; };
  const numbers: Record<string, number[]> = {};
  const documentTotals: Record<string, number> = {};
  for (const d of p.documents) {
    if (d.number !== null) (numbers[seriesKey(d.series_id)] ??= []).push(d.number);
    if (d.status !== 'draft') {
      const k = `${d.issue_date.slice(0, 4)}|${d.doc_type}|${d.status}`;
      documentTotals[k] = (documentTotals[k] ?? 0) + (d.total_agorot ?? 0);
    }
  }
  Object.values(numbers).forEach((n) => n.sort((a, b) => a - b));
  const expenseTotals: Record<string, number> = {};
  for (const e of p.expenses) expenseTotals[e.doc_date.slice(0, 4)] = (expenseTotals[e.doc_date.slice(0, 4)] ?? 0) + e.amount_agorot;
  return {
    counts: {
      customers: p.customers.length, series: p.series.length, documents: p.documents.length,
      issued: p.documents.filter((d) => d.status === 'issued').length, cancelled: p.documents.filter((d) => d.status === 'cancelled').length,
      drafts: p.documents.filter((d) => d.status === 'draft').length, allocations: p.allocations.length, expenses: p.expenses.length,
      attachments: p.attachments.length, submissions: p.submissions.length,
    },
    numbers, documentTotals, expenseTotals,
    allocationsTotal: p.allocations.reduce((s, a) => s + a.amount_agorot, 0),
    attachmentSha256: p.attachments.map((a) => a.sha256).sort(),
  };
}

/** Differences between two manifests (empty = identical). Submissions are optional on the target side. */
export function compareManifests(expected: Manifest, actual: Manifest, ignore: string[] = []): string[] {
  const out: string[] = [];
  const cmp = (label: string, a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) out.push(`${label}: צפוי ${JSON.stringify(a)}, נמצא ${JSON.stringify(b)}`); };
  for (const k of Object.keys(expected.counts)) if (!ignore.includes(k)) cmp(`מספר ${k}`, expected.counts[k], actual.counts[k]);
  const sortObj = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
  cmp('מספרי מסמכים לפי סדרה', sortObj(expected.numbers), sortObj(actual.numbers));
  cmp('סכומי מסמכים לפי שנה', sortObj(expected.documentTotals), sortObj(actual.documentTotals));
  cmp('סכומי הוצאות לפי שנה', sortObj(expected.expenseTotals), sortObj(actual.expenseTotals));
  cmp('סך השיוכים', expected.allocationsTotal, actual.allocationsTotal);
  cmp('טביעות SHA-256 של קבצים', expected.attachmentSha256, actual.attachmentSha256);
  return out;
}

// ───────────────────────── CSV (for the accountant) ─────────────────────────
const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  // Prevent spreadsheet formula injection; quote everything.
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
};
export function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  return '﻿' + [columns.map(csvCell).join(','), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(','))].join('\r\n') + '\r\n';
}
export const shekels = (agorot: number | null | undefined) => (agorot === null || agorot === undefined ? '' : (agorot / 100).toFixed(2));

// ───────────────────────── previous app ("legacy") ─────────────────────────
interface LegacyInvoice { id?: unknown; number?: unknown; clientName?: unknown; clientId?: unknown; date?: unknown; notes?: unknown;
  items?: { desc?: unknown; qty?: unknown; price?: unknown }[]; total?: unknown; status?: unknown; cancelReason?: unknown; cancelledAt?: unknown; createdAt?: unknown }
interface LegacyExpense { id?: unknown; desc?: unknown; amount?: unknown; category?: unknown; date?: unknown; receipt?: { data?: string; name?: string; type?: string } | null }
export interface LegacyData { profile?: Record<string, unknown>; invoices?: LegacyInvoice[]; expenses?: LegacyExpense[]; nextInvoiceNum?: unknown }

export interface LegacyFile { key: string; dataUrl: string; name: string; type: string }
export interface LegacyPlan {
  payload: BackupPayload;
  /** Files to upload before import: key = temporary attachment id */
  files: LegacyFile[];
  issues: string[];
  summary: { invoices: number; cancelled: number; expenses: number; files: number; customers: number; invoiceTotal: number; expenseTotal: number;
    numbers: { min: number; max: number } | null; gaps: number[]; duplicates: number[]; nextInvoiceNum: number | null };
}

const isoDate = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
const agorot = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? roundHalfAwayFromZero(n * 100) : null; };
const LEGACY_CATEGORY: Record<string, string> = { 'ציוד': 'equipment', 'תוכנה': 'software', 'נסיעות': 'vehicle', 'שיווק': 'marketing', 'משרד': 'office', 'תקשורת': 'communication', 'הכשרה': 'training' };

/**
 * Converts the previous app's data file into a backup payload for import (mode "legacy"),
 * without writing anything. Invoice numbers are kept exactly; a duplicate number goes into a
 * separate legacy series so no number is changed or dropped. Payment status of old invoices is
 * unknown, so no receipts are created.
 */
export function planLegacyImport(raw: unknown, ids: () => string, now = new Date().toISOString()): LegacyPlan {
  const d = (raw && typeof raw === 'object' ? raw : {}) as LegacyData;
  const issues: string[] = [];
  const invoices = Array.isArray(d.invoices) ? d.invoices : [];
  const expensesIn = Array.isArray(d.expenses) ? d.expenses : [];
  if (!Array.isArray(d.invoices) && !Array.isArray(d.expenses)) issues.push('הקובץ אינו נראה כגיבוי של האפליקציה הקודמת (אין חשבוניות או הוצאות).');
  const prof = d.profile ?? {};
  const profile: Profile | null = Object.values(prof).some((v) => String(v ?? '').trim()) ? {
    legal_name: String(prof.name ?? ''), business_name: String(prof.business ?? ''), id_number: String(prof.id ?? ''),
    address: String(prof.address ?? ''), phone: String(prof.phone ?? ''), email: String(prof.email ?? ''),
  } : null;

  const customers = new Map<string, Customer>();
  const mainSeries: Series = { id: ids(), doc_type: 'transaction_invoice', name: 'היסטורי — האפליקציה הקודמת', next_number: 1, is_legacy: true };
  const dupSeries: Series = { id: ids(), doc_type: 'transaction_invoice', name: 'היסטורי — מספרים כפולים לבדיקה', next_number: 1, is_legacy: true };
  const seen = new Set<number>();
  const duplicates: number[] = [];
  const documents: Doc[] = [];
  let usedDup = false;
  for (const inv of invoices) {
    const number = Number(inv.number);
    const date = isoDate(inv.date);
    const total = agorot(inv.total);
    const name = String(inv.clientName ?? '').trim();
    if (!Number.isInteger(number) || number <= 0 || !date || total === null || !name) {
      issues.push(`חשבונית ${String(inv.number ?? '?')} דולגה: חסר מספר, תאריך, סכום או שם לקוח.`); continue;
    }
    let series = mainSeries;
    if (seen.has(number)) { duplicates.push(number); series = dupSeries; usedDup = true; issues.push(`מספר חשבונית ${number} מופיע יותר מפעם אחת — העותק הנוסף נשמר בסדרה "מספרים כפולים לבדיקה".`); }
    seen.add(number);
    const key = `${name}|${String(inv.clientId ?? '').trim()}`;
    if (!customers.has(key)) customers.set(key, { id: ids(), name, tax_id: String(inv.clientId ?? '').trim(), address: '', email: '', phone: '' });
    const cust = customers.get(key)!;
    const items = Array.isArray(inv.items) ? inv.items : [];
    const lines = items.map((it) => ({ description: String(it.desc ?? '').trim() || 'פריט', quantity: Number(it.qty) > 0 ? Number(it.qty) : 1, unit_price_agorot: agorot(it.price) ?? 0 }));
    const linesSum = lines.reduce((s, l) => s + roundHalfAwayFromZero(l.quantity * l.unit_price_agorot), 0);
    if (lines.length && linesSum !== total) issues.push(`חשבונית ${number}: סכום השורות (${(linesSum / 100).toFixed(2)}) שונה מהסה"כ השמור (${(total / 100).toFixed(2)}). נשמר הסה"כ המקורי.`);
    const cancelled = inv.status === 'cancelled';
    const created = typeof inv.createdAt === 'string' ? inv.createdAt : `${date}T12:00:00.000Z`;
    documents.push({
      id: ids(), idempotency_key: ids(), series_id: series.id, doc_type: 'transaction_invoice', status: cancelled ? 'cancelled' : 'issued',
      number, issue_date: date, customer_id: cust.id, lines: lines.length ? lines : [{ description: 'סכום כולל (מהאפליקציה הקודמת)', quantity: 1, unit_price_agorot: total }],
      notes: [String(inv.notes ?? '').trim(), 'יובא מהאפליקציה הקודמת. מצב התשלום לא ידוע — לא הופקה קבלה.', cancelled ? `סומנה כמבוטלת באפליקציה הקודמת${inv.cancelReason ? `: ${String(inv.cancelReason)}` : ''}.` : '']
        .filter(Boolean).join('\n'),
      payment_details: {}, allocations: [],
      customer_snapshot: { name: cust.name, tax_id: cust.tax_id, address: '', email: '', phone: '' }, issuer_snapshot: profile,
      subtotal_agorot: total, vat_agorot: 0, total_agorot: total, vat_status_at_issue: 'exempt',
      corrects_document_id: null, correction_reason: null, cancelled_by_document_id: null,
      issued_at: created, cancelled_at: cancelled ? (typeof inv.cancelledAt === 'string' ? inv.cancelledAt : created) : null, created_at: created,
      // vat_rate_bp / rule_set_version are not part of Doc's TS type but are accepted by the import
      ...({ vat_rate_bp: 0, rule_set_version: 'legacy-app' } as object),
    } as Doc);
  }
  const nums = [...seen].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let n = nums[0]; nums.length && n < nums[nums.length - 1]; n++) if (!seen.has(n)) gaps.push(n);
  if (gaps.length) issues.push(`חסרים מספרים ברצף: ${gaps.slice(0, 30).join(', ')}${gaps.length > 30 ? '…' : ''} (למשל חשבוניות שנמחקו). המספרים לא ימולאו ולא ישונו.`);
  const legacyNext = Number(d.nextInvoiceNum);
  mainSeries.next_number = Math.max(nums.length ? nums[nums.length - 1] + 1 : 1, Number.isInteger(legacyNext) && legacyNext > 0 ? legacyNext : 1);
  dupSeries.next_number = mainSeries.next_number;
  if (Number.isInteger(legacyNext) && nums.length && legacyNext !== nums[nums.length - 1] + 1) issues.push(`המספר הבא שנשמר באפליקציה הקודמת (${legacyNext}) אינו "האחרון + 1" (${nums[nums.length - 1] + 1}).`);

  const files: LegacyFile[] = [];
  const expenses: BackupPayload['expenses'] = [];
  const attachments: ExpenseAttachment[] = [];
  for (const e of expensesIn) {
    const date = isoDate(e.date);
    const amount = agorot(e.amount);
    if (!date || amount === null || amount <= 0) { issues.push(`הוצאה "${String(e.desc ?? '')}" דולגה: תאריך או סכום לא תקינים.`); continue; }
    const id = ids();
    const cat = String(e.category ?? '');
    expenses.push({ id, client_key: ids(), supplier: String(e.desc ?? '').trim() || 'לא צוין', supplier_tax_id: '', doc_number: '', doc_date: date,
      amount_agorot: amount, vat_agorot: 0, category: LEGACY_CATEGORY[cat] ?? 'other', business_use_pct: 100, status: 'needs_review',
      deductible_status: 'undetermined', input_vat_status: 'undetermined', notes: cat ? `קטגוריה באפליקציה הקודמת: ${cat}` : '', created_at: `${date}T12:00:00.000Z` });
    const r = e.receipt;
    if (r && typeof r.data === 'string' && r.data.startsWith('data:')) {
      const key = ids();
      files.push({ key, dataUrl: r.data, name: String(r.name ?? 'receipt'), type: String(r.type ?? '') });
      attachments.push({ id: key, expense_id: id, storage_path: '', sha256: '', mime_type: String(r.type ?? ''), size_bytes: 0, original_name: String(r.name ?? 'receipt'), created_at: `${date}T12:00:00.000Z` });
    } else if (r) issues.push(`הקובץ של ההוצאה "${String(e.desc ?? '')}" פגום ולא יובא.`);
  }

  const payload: BackupPayload = {
    format: 'freelance-manager-backup', version: 1, exported_at: now, source: 'legacy-app', profile,
    vat_periods: [], tax_profile: null, customers: [...customers.values()], series: usedDup ? [mainSeries, dupSeries] : [mainSeries],
    documents, allocations: [], expenses, attachments, submissions: [],
  };
  return {
    payload, files, issues,
    summary: { invoices: documents.length, cancelled: documents.filter((x) => x.status === 'cancelled').length, expenses: expenses.length, files: files.length,
      customers: customers.size, invoiceTotal: documents.filter((x) => x.status === 'issued').reduce((s, x) => s + (x.total_agorot ?? 0), 0),
      expenseTotal: expenses.reduce((s, x) => s + x.amount_agorot, 0),
      numbers: nums.length ? { min: nums[0], max: nums[nums.length - 1] } : null, gaps, duplicates, nextInvoiceNum: Number.isInteger(legacyNext) ? legacyNext : null },
  };
}

export function dataUrlToBytes(dataUrl: string): Uint8Array {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
