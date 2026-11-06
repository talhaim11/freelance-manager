/**
 * DEMO repository: synthetic data stored only in this browser under a separate key.
 * It applies the same rules as the database functions (shared domain code) so the
 * UI can be tried before Supabase is set up. It is never used for real records and
 * cannot be connected to the real dataset.
 */
import { vatStatusOn, type VatStatusPeriod } from '../domain/classification';
import { exemptTotals, issueProblems } from '../domain/documents';
import { allocationProblems, type AllocationRecord, type InvoiceBalance } from '../domain/payments';
import { AppError } from '../domain/errors';
import type { AttachmentUpload, Customer, Doc, DraftInput, Expense, ExpenseAttachment, ExpenseInput, Profile, Repo, Series } from './types';

const KEY = 'fm_demo_v1';
/** Demo attachment bytes, kept apart from the records (base64 by attachment id). */
const FILES_KEY = 'fm_demo_files_v1';
const DEMO_MAX_FILE = 1024 * 1024; // the browser's local storage is small

interface DemoState {
  profile: Profile | null;
  vat: VatStatusPeriod[];
  customers: Customer[];
  series: Series[];
  docs: Doc[];
  allocations?: (AllocationRecord & { id: string })[];
  expenses?: Expense[];
  customerKeys?: Record<string, string>;
  audit: { action: string; entity_id: string; at: string; details: unknown }[];
}

import { uuid } from '../lib/uuid';
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function seed(): DemoState {
  const cust: Customer = { id: uuid(), name: 'לקוח לדוגמה בע"מ', tax_id: '', address: 'רחוב הדוגמה 10, עיר לדוגמה', email: '', phone: '' };
  return {
    profile: { legal_name: 'משתמש/ת דמו', business_name: 'עסק לדוגמה', id_number: '000000018', address: 'רחוב הבדיקה 1, עיר', phone: '', email: '' },
    vat: [{ id: uuid(), status: 'exempt', effective_from: '2024-01-01', effective_to: null, note: 'דמו' }],
    customers: [cust],
    series: [
      { id: uuid(), doc_type: 'transaction_invoice', name: 'חשבוניות עסקה', next_number: 1, is_legacy: false },
      { id: uuid(), doc_type: 'receipt', name: 'קבלות', next_number: 1, is_legacy: false },
      { id: uuid(), doc_type: 'quote', name: 'הצעות מחיר', next_number: 1, is_legacy: false },
    ],
    docs: [],
    audit: [],
  };
}

export class DemoRepo implements Repo {
  readonly mode = 'demo' as const;
  private state: DemoState;
  private lock: Promise<unknown> = Promise.resolve();

  constructor(private storage: Storage | null = typeof localStorage !== 'undefined' ? localStorage : null) {
    let s: DemoState | null = null;
    try { s = JSON.parse(this.storage?.getItem(KEY) ?? 'null'); } catch { s = null; }
    this.state = s ?? seed();
    // Older demo data (before M2) lacks the new collections.
    this.state.allocations ??= [];
    this.state.expenses ??= [];
    this.state.customerKeys ??= {};
    this.state.docs.forEach((d) => { d.allocations ??= []; });
    this.save();
  }

  static reset(storage: Storage = localStorage) { storage.removeItem(KEY); storage.removeItem(FILES_KEY); }

  private save() { try { this.storage?.setItem(KEY, JSON.stringify(this.state)); } catch { /* demo only */ } }
  private clone<T>(x: T): T { return JSON.parse(JSON.stringify(x)); }
  /** Serializes mutations, like row locks in the database. */
  private exclusive<T>(fn: () => T): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  async getProfile() { return this.clone(this.state.profile); }
  async saveProfile(p: Profile) { await this.exclusive(() => { this.state.profile = { ...p }; this.save(); }); }
  async listVatPeriods() { return this.clone(this.state.vat); }
  async addVatPeriod(p: Omit<VatStatusPeriod, 'id'>) { await this.exclusive(() => { this.state.vat.push({ ...p, id: uuid() }); this.save(); }); }
  async listCustomers() { return this.clone(this.state.customers); }
  async addCustomer(c: Omit<Customer, 'id'>, clientKey: string) {
    return this.exclusive(() => {
      const known = this.state.customerKeys![clientKey];
      const existing = known && this.state.customers.find((x) => x.id === known);
      if (existing) return this.clone(existing);
      const n = { ...c, id: uuid() };
      this.state.customers.push(n); this.state.customerKeys![clientKey] = n.id; this.save(); return this.clone(n);
    });
  }
  async updateCustomer(c: Customer) {
    await this.exclusive(() => { const i = this.state.customers.findIndex((x) => x.id === c.id); if (i >= 0) this.state.customers[i] = { ...c }; this.save(); });
  }
  async listSeries() { return this.clone(this.state.series); }
  async addSeries(s: { doc_type: Series['doc_type']; name: string; next_number: number }) {
    return this.exclusive(() => {
      if (this.state.series.some((x) => x.doc_type === s.doc_type && x.name === s.name)) throw new AppError('DUPLICATE_SERIES');
      const n: Series = { ...s, id: uuid(), is_legacy: false };
      this.state.series.push(n); this.save(); return this.clone(n);
    });
  }
  async listDocuments() { return this.clone([...this.state.docs].sort((a, b) => (a.created_at < b.created_at ? 1 : -1))); }
  async getDocument(id: string) { return this.clone(this.state.docs.find((d) => d.id === id) ?? null); }

  async createDraft(d: DraftInput) {
    return this.exclusive(() => {
      const existing = this.state.docs.find((x) => x.idempotency_key === d.idempotency_key);
      if (existing) return this.clone(existing);
      const doc: Doc = {
        ...d, id: uuid(), status: 'draft', number: null, customer_snapshot: null, issuer_snapshot: null,
        subtotal_agorot: null, vat_agorot: null, total_agorot: null, vat_status_at_issue: null,
        corrects_document_id: null, correction_reason: null, cancelled_by_document_id: null,
        issued_at: null, cancelled_at: null, created_at: new Date().toISOString(),
      };
      this.state.docs.push(doc); this.save(); return this.clone(doc);
    });
  }

  async updateDraft(id: string, patch: Partial<Omit<DraftInput, 'idempotency_key'>>) {
    await this.exclusive(() => {
      const d = this.state.docs.find((x) => x.id === id);
      if (!d) throw new AppError('NOT_FOUND');
      if (d.status !== 'draft') throw new AppError('FINALIZED_DOCUMENT');
      Object.assign(d, patch); this.save();
    });
  }

  async deleteDraft(id: string) {
    await this.exclusive(() => {
      const d = this.state.docs.find((x) => x.id === id);
      if (!d) return;
      if (d.status !== 'draft') throw new AppError('FINALIZED_DOCUMENT');
      this.state.docs = this.state.docs.filter((x) => x.id !== id); this.save();
    });
  }

  async issueDocument(id: string) {
    return this.exclusive(() => {
      const d = this.state.docs.find((x) => x.id === id);
      if (!d) throw new AppError('NOT_FOUND');
      if (d.status !== 'draft') return this.clone(d);
      const series = this.state.series.find((s) => s.id === d.series_id);
      if (!series || series.doc_type !== d.doc_type) throw new AppError('SERIES_MISMATCH');
      if (series.is_legacy) throw new AppError('LEGACY_SERIES');
      const vs = vatStatusOn(this.state.vat, d.issue_date);
      const customer = this.state.customers.find((c) => c.id === d.customer_id) ?? null;
      const problems = issueProblems({ docType: d.doc_type, vatStatus: vs, profile: this.state.profile, customer, lines: d.lines, payment: d.payment_details });
      if (problems.length) throw new AppError(problems[0]);
      const totals = exemptTotals(d.lines);
      const allocs = d.allocations ?? [];
      if (allocs.length) {
        if (d.doc_type !== 'receipt') throw new AppError('ALLOCATION_INVALID');
        const ap = allocationProblems(totals.total, d.customer_id, allocs, this.balances());
        if (ap.length) throw new AppError(ap[0]);
        for (const a of allocs) this.state.allocations!.push({ id: uuid(), receipt_id: d.id, invoice_id: a.invoice_id, amount_agorot: a.amount_agorot });
      }
      d.number = series.next_number;
      series.next_number += 1;
      Object.assign(d, {
        status: 'issued', issued_at: new Date().toISOString(),
        customer_snapshot: { ...customer! }, issuer_snapshot: { ...this.state.profile! },
        subtotal_agorot: totals.subtotal, vat_agorot: 0, total_agorot: totals.total, vat_status_at_issue: vs,
      });
      this.state.audit.push({ action: 'document.issued', entity_id: d.id, at: d.issued_at!, details: { number: d.number } });
      this.save();
      return this.clone(d);
    });
  }

  async cancelDocument(id: string, reason: string, key: string) {
    return this.exclusive(() => {
      if (!reason.trim()) throw new AppError('REASON_REQUIRED');
      const byKey = this.state.docs.find((x) => x.idempotency_key === key);
      if (byKey) {
        if (byKey.corrects_document_id !== id) throw new AppError('IDEMPOTENCY_KEY_REUSED');
        return this.clone(byKey);
      }
      const orig = this.state.docs.find((x) => x.id === id);
      if (!orig) throw new AppError('NOT_FOUND');
      if (orig.status === 'cancelled') return this.clone(this.state.docs.find((x) => x.id === orig.cancelled_by_document_id)!);
      if (orig.status !== 'issued') throw new AppError('NOT_ISSUED');
      if (orig.doc_type === 'cancellation') throw new AppError('CANNOT_CANCEL_CANCELLATION');
      if (orig.doc_type === 'transaction_invoice' && this.state.allocations!.some((a) => a.invoice_id === orig.id
        && this.state.docs.find((r) => r.id === a.receipt_id)?.status === 'issued')) throw new AppError('INVOICE_HAS_PAYMENTS');
      let series = this.state.series.find((s) => s.doc_type === 'cancellation' && !s.is_legacy);
      if (!series) {
        series = { id: uuid(), doc_type: 'cancellation', name: 'ביטולים', next_number: 1, is_legacy: false };
        this.state.series.push(series);
      }
      const now = new Date().toISOString();
      const c: Doc = {
        ...this.clone(orig), id: uuid(), idempotency_key: key, series_id: series.id, doc_type: 'cancellation', allocations: [],
        status: 'issued', number: series.next_number, issue_date: today(), notes: '',
        subtotal_agorot: -(orig.subtotal_agorot ?? 0), vat_agorot: -(orig.vat_agorot ?? 0), total_agorot: -(orig.total_agorot ?? 0),
        corrects_document_id: orig.id, correction_reason: reason.trim(), cancelled_by_document_id: null,
        issued_at: now, cancelled_at: null, created_at: now,
      };
      series.next_number += 1;
      this.state.docs.push(c);
      orig.status = 'cancelled'; orig.cancelled_at = now; orig.cancelled_by_document_id = c.id;
      this.state.audit.push({ action: 'document.cancelled', entity_id: orig.id, at: now, details: { reason: reason.trim(), cancellation: c.id } });
      this.save();
      return this.clone(c);
    });
  }

  private balances(): InvoiceBalance[] {
    return this.state.docs.filter((d) => d.doc_type === 'transaction_invoice' && d.status === 'issued').map((d) => {
      const paid = this.state.allocations!.filter((a) => a.invoice_id === d.id
        && this.state.docs.find((r) => r.id === a.receipt_id)?.status === 'issued').reduce((x, a) => x + a.amount_agorot, 0);
      return { invoice_id: d.id, customer_id: d.customer_id, number: d.number, issue_date: d.issue_date,
        total_agorot: d.total_agorot ?? 0, paid_agorot: paid, balance_agorot: (d.total_agorot ?? 0) - paid };
    });
  }
  async listInvoiceBalances() { return this.clone(this.balances()); }
  async listAllocationsFor(id: string) {
    return this.clone(this.state.allocations!.filter((a) => a.receipt_id === id || a.invoice_id === id)
      .map(({ receipt_id, invoice_id, amount_agorot }) => ({ receipt_id, invoice_id, amount_agorot })));
  }

  async listExpenses() { return this.clone([...this.state.expenses!].sort((a, b) => (a.doc_date < b.doc_date ? 1 : -1))); }
  async saveExpense(e: ExpenseInput, id?: string) {
    return this.exclusive(() => {
      if (id) {
        const x = this.state.expenses!.find((y) => y.id === id);
        if (!x) throw new AppError('NOT_FOUND');
        const { client_key: _k, ...rest } = e;
        Object.assign(x, rest); this.save(); return this.clone(x);
      }
      const existing = this.state.expenses!.find((y) => y.client_key === e.client_key);
      if (existing) return this.clone(existing);
      const n: Expense = { ...e, id: uuid(), created_at: new Date().toISOString(), deductible_status: 'undetermined', input_vat_status: 'undetermined', attachments: [] };
      this.state.expenses!.push(n); this.save(); return this.clone(n);
    });
  }
  async addExpenseAttachment(expenseId: string, f: AttachmentUpload) {
    return this.exclusive(() => {
      const x = this.state.expenses!.find((y) => y.id === expenseId);
      if (!x) throw new AppError('NOT_FOUND');
      const already = x.attachments.find((a) => a.id === f.id);
      if (already) return this.clone(already);
      if (f.bytes.length > DEMO_MAX_FILE) throw new AppError('FILE_TOO_LARGE', 'demo limit 1MB');
      let bin = '';
      f.bytes.forEach((b) => { bin += String.fromCharCode(b); });
      try {
        const files = JSON.parse(this.storage?.getItem(FILES_KEY) ?? '{}');
        files[f.id] = btoa(bin);
        this.storage?.setItem(FILES_KEY, JSON.stringify(files));
      } catch { throw new AppError('FILE_TOO_LARGE', 'demo storage full'); }
      const a: ExpenseAttachment = { id: f.id, expense_id: expenseId, storage_path: `demo/${f.id}`, sha256: f.sha256,
        mime_type: f.mime_type, size_bytes: f.bytes.length, original_name: f.original_name, created_at: new Date().toISOString() };
      x.attachments.push(a); this.save(); return this.clone(a);
    });
  }
  async attachmentUrl(a: ExpenseAttachment) {
    const files = JSON.parse(this.storage?.getItem(FILES_KEY) ?? '{}');
    const b64 = files[a.id];
    if (!b64) throw new AppError('NOT_FOUND');
    return `data:${a.mime_type};base64,${b64}`;
  }
}
