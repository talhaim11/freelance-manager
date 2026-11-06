import type { SupabaseClient } from '@supabase/supabase-js';
import type { VatStatusPeriod } from '../domain/classification';
import { AppError, ERROR_MESSAGES } from '../domain/errors';
import { fileExtension } from '../domain/expenses';
import type {
  AllocationRecord, AttachmentUpload, AuditEntry, Customer, Doc, DocumentOutput, DraftInput, Expense, ExpenseAttachment, ExpenseInput,
  InvoiceBalance, Profile, Repo, Series, Submission, SubmissionInput, TaxProfile,
} from './types';

const BUCKET = 'expense-files';
const CUSTOMER_COLS = 'id,name,tax_id,address,email,phone';
const EXPENSE_COLS = 'id,client_key,supplier,supplier_tax_id,doc_number,doc_date,amount_agorot,vat_agorot,category,business_use_pct,status,deductible_status,input_vat_status,notes,created_at,attachments:expense_attachments(id,expense_id,storage_path,sha256,mime_type,size_bytes,original_name,created_at)';

type PgError = { message: string; code?: string; details?: string | null; hint?: string | null };

/**
 * Maps a PostgREST / RPC error to an AppError code:
 *  - codes raised by our SQL functions (FINALIZED_DOCUMENT, …) pass through;
 *  - an expired / invalid token (HTTP 401, PGRST301/302/303) becomes SESSION_EXPIRED;
 *  - a missing connection becomes NETWORK (the outcome of a write is then unknown).
 */
export function mapError(e: PgError, status?: number): AppError {
  const msg = e.message ?? '';
  const own = /\b([A-Z][A-Z_]{3,})\b/.exec(msg)?.[1];
  if (own && (own in ERROR_MESSAGES || own.includes('_'))) return new AppError(own, msg);
  if (status === 401 || /^PGRST30[1-3]$/.test(e.code ?? '') || /jwt|token is expired|invalid claim/i.test(msg)) {
    return new AppError('SESSION_EXPIRED', msg);
  }
  if (!status || /fetch|network|load failed|timed? ?out/i.test(msg)) return new AppError('NETWORK', msg);
  if (e.code === '42501') return new AppError('NOT_ALLOWED', msg);
  if (e.code === '23505') return new AppError('DUPLICATE', msg);
  return new AppError('UNKNOWN', msg);
}

function check<T>(res: { data: T; error: PgError | null; status?: number }): T {
  if (res.error) throw mapError(res.error, res.status);
  return res.data;
}

export class SupabaseRepo implements Repo {
  readonly mode = 'supabase' as const;
  constructor(private sb: SupabaseClient, private onSessionExpired: () => void = () => {}) {}

  /**
   * Every call first makes sure a valid session exists (refreshing it if needed).
   * Without this, a lost session would silently fall back to the anonymous role.
   */
  private async authed(): Promise<void> {
    let res;
    try { res = await this.sb.auth.getSession(); } catch (e) { throw new AppError('NETWORK', String(e)); }
    if (res.error) {
      const retryable = res.error.name === 'AuthRetryableFetchError' || /fetch|network/i.test(res.error.message);
      throw this.expired(new AppError(retryable ? 'NETWORK' : 'SESSION_EXPIRED', res.error.message));
    }
    if (!res.data.session) throw this.expired(new AppError('SESSION_EXPIRED'));
  }

  private expired(e: AppError): AppError {
    if (e.code === 'SESSION_EXPIRED') this.onSessionExpired();
    return e;
  }

  /** check() that also reports an expired session to the app (which then asks to sign in again). */
  private c<T>(res: { data: T; error: PgError | null; status?: number }): T {
    try { return check(res); } catch (e) { throw this.expired(e as AppError); }
  }

  async getProfile() {
    await this.authed();
    return this.c(await this.sb.from('business_profiles')
      .select('legal_name,business_name,id_number,address,phone,email').maybeSingle()) as Profile | null;
  }
  async saveProfile(p: Profile) {
    await this.authed();
    this.c(await this.sb.from('business_profiles').upsert({ ...p, updated_at: new Date().toISOString() }, { onConflict: 'owner_id' }));
  }
  async listVatPeriods() {
    await this.authed();
    return this.c(await this.sb.from('vat_status_periods').select('id,status,effective_from,effective_to,note')
      .order('effective_from')) as VatStatusPeriod[];
  }
  async addVatPeriod(p: Omit<VatStatusPeriod, 'id'>) {
    await this.authed();
    this.c(await this.sb.from('vat_status_periods').insert(p));
  }
  async listCustomers() {
    await this.authed();
    return this.c(await this.sb.from('customers').select(CUSTOMER_COLS).order('name')) as Customer[];
  }
  async addCustomer(c: Omit<Customer, 'id'>, clientKey: string) {
    await this.authed();
    // ON CONFLICT DO NOTHING on the client key, then read back: a retry returns the same customer.
    this.c(await this.sb.from('customers').upsert({ ...c, client_key: clientKey }, { onConflict: 'client_key', ignoreDuplicates: true }));
    return this.c(await this.sb.from('customers').select(CUSTOMER_COLS).eq('client_key', clientKey).single()) as Customer;
  }
  async updateCustomer(c: Customer) {
    await this.authed();
    const { id, ...rest } = c;
    const rows = this.c(await this.sb.from('customers').update({ ...rest, updated_at: new Date().toISOString() }).eq('id', id).select('id'));
    if (!rows?.length) throw new AppError('NOT_FOUND');
  }
  async listSeries() {
    await this.authed();
    return this.c(await this.sb.from('document_series').select('id,doc_type,name,next_number,is_legacy').order('created_at')) as Series[];
  }
  async addSeries(s: { doc_type: Series['doc_type']; name: string; next_number: number }) {
    await this.authed();
    return this.c(await this.sb.from('document_series').insert(s).select('id,doc_type,name,next_number,is_legacy').single()) as Series;
  }
  async listDocuments() {
    await this.authed();
    return this.c(await this.sb.from('documents').select('*').order('created_at', { ascending: false })) as Doc[];
  }
  async getDocument(id: string) {
    await this.authed();
    return this.c(await this.sb.from('documents').select('*').eq('id', id).maybeSingle()) as Doc | null;
  }
  async createDraft(d: DraftInput) {
    await this.authed();
    // ON CONFLICT DO NOTHING on the idempotency key, then read back: double submits create one draft.
    this.c(await this.sb.from('documents').upsert(d, { onConflict: 'idempotency_key', ignoreDuplicates: true }));
    return this.c(await this.sb.from('documents').select('*').eq('idempotency_key', d.idempotency_key).single()) as Doc;
  }
  async updateDraft(id: string, patch: Partial<Omit<DraftInput, 'idempotency_key'>>) {
    await this.authed();
    // Zero rows means the draft was issued (e.g. from another device) or no longer exists.
    const rows = this.c(await this.sb.from('documents').update(patch).eq('id', id).eq('status', 'draft').select('id'));
    if (!rows?.length) throw new AppError('FINALIZED_DOCUMENT');
  }
  async deleteDraft(id: string) {
    await this.authed();
    const rows = this.c(await this.sb.from('documents').delete().eq('id', id).eq('status', 'draft').select('id'));
    if (!rows?.length) throw new AppError('FINALIZED_DOCUMENT');
  }
  async issueDocument(id: string) {
    await this.authed();
    return this.c(await this.sb.rpc('issue_document', { p_document_id: id }).single()) as Doc;
  }
  async cancelDocument(id: string, reason: string, idempotencyKey: string) {
    await this.authed();
    return this.c(await this.sb.rpc('cancel_document', { p_document_id: id, p_reason: reason, p_idempotency_key: idempotencyKey }).single()) as Doc;
  }

  async listInvoiceBalances() {
    await this.authed();
    return this.c(await this.sb.from('invoice_balances').select('*').order('issue_date')) as InvoiceBalance[];
  }
  async listAllocationsFor(documentId: string) {
    await this.authed();
    return this.c(await this.sb.from('payment_allocations').select('receipt_id,invoice_id,amount_agorot')
      .or(`receipt_id.eq.${documentId},invoice_id.eq.${documentId}`)) as AllocationRecord[];
  }

  async listAllocations() {
    await this.authed();
    return this.c(await this.sb.from('payment_allocations').select('receipt_id,invoice_id,amount_agorot').order('created_at')) as AllocationRecord[];
  }

  async listExpenses() {
    await this.authed();
    return this.c(await this.sb.from('expenses').select(EXPENSE_COLS).order('doc_date', { ascending: false })) as Expense[];
  }
  async saveExpense(e: ExpenseInput, id?: string) {
    await this.authed();
    if (id) {
      const { client_key: _k, ...rest } = e;
      const rows = this.c(await this.sb.from('expenses').update(rest).eq('id', id).select(EXPENSE_COLS));
      if (!rows?.length) throw new AppError('NOT_FOUND');
      return rows[0] as Expense;
    }
    this.c(await this.sb.from('expenses').upsert(e, { onConflict: 'client_key', ignoreDuplicates: true }));
    return this.c(await this.sb.from('expenses').select(EXPENSE_COLS).eq('client_key', e.client_key).single()) as Expense;
  }
  async uploadFile(id: string, bytes: Uint8Array, mime: string) {
    await this.authed();
    const { data: s } = await this.sb.auth.getSession();
    const uid = s.session?.user.id;
    if (!uid) throw this.expired(new AppError('SESSION_EXPIRED'));
    const path = `${uid}/${id}.${fileExtension(mime)}`;
    // An object already at this path is this same upload (retry after a lost response).
    const up = await this.sb.storage.from(BUCKET).upload(path, bytes, { contentType: mime, upsert: false });
    if (up.error) {
      const status = Number((up.error as { statusCode?: string | number }).statusCode ?? (up.error as { status?: number }).status ?? 0);
      const dup = status === 409 || /already exists|duplicate/i.test(up.error.message);
      if (!dup) throw this.expired(status === 400 && /jwt|token/i.test(up.error.message) ? new AppError('SESSION_EXPIRED', up.error.message)
        : status === 403 || /row-level security|unauthori[sz]ed/i.test(up.error.message) ? new AppError('NOT_ALLOWED', up.error.message)
        : /payload too large|size/i.test(up.error.message) ? new AppError('FILE_TOO_LARGE', up.error.message)
        : /mime|type/i.test(up.error.message) ? new AppError('FILE_TYPE_NOT_ALLOWED', up.error.message)
        : mapError({ message: up.error.message }, status));
    }
    return path;
  }
  async addExpenseAttachment(expenseId: string, f: AttachmentUpload) {
    // 1. The file, privately. 2. Its record: the id is fixed per selected file, so a repeat inserts nothing new.
    const path = await this.uploadFile(f.id, f.bytes, f.mime_type);
    const row = { id: f.id, expense_id: expenseId, storage_path: path, sha256: f.sha256, mime_type: f.mime_type,
      size_bytes: f.bytes.length, original_name: f.original_name };
    this.c(await this.sb.from('expense_attachments').upsert(row, { onConflict: 'id', ignoreDuplicates: true }));
    return this.c(await this.sb.from('expense_attachments').select('*').eq('id', f.id).single()) as ExpenseAttachment;
  }
  async attachmentUrl(a: ExpenseAttachment) {
    await this.authed();
    const r = await this.sb.storage.from(BUCKET).createSignedUrl(a.storage_path, 300);
    if (r.error || !r.data) throw new AppError('NOT_FOUND', r.error?.message);
    return r.data.signedUrl;
  }
  async downloadAttachment(a: ExpenseAttachment) {
    await this.authed();
    const r = await this.sb.storage.from(BUCKET).download(a.storage_path);
    if (r.error || !r.data) throw new AppError('NETWORK', r.error?.message);
    return new Uint8Array(await r.data.arrayBuffer());
  }

  async registerOutput(documentId: string, sha: { original: string; copy: string } | null) {
    await this.authed();
    return this.c(await this.sb.rpc('register_document_output', { p_document_id: documentId, p_sha_original: sha?.original ?? null, p_sha_copy: sha?.copy ?? null })) as 'original' | 'copy';
  }
  async listOutputs(documentId?: string) {
    await this.authed();
    let q = this.sb.from('document_outputs').select('document_id,kind,sha256,created_at').order('created_at');
    if (documentId) q = q.eq('document_id', documentId);
    return this.c(await q) as DocumentOutput[];
  }

  async getTaxProfile() {
    await this.authed();
    return this.c(await this.sb.from('tax_profiles').select('income_tax_regime,employed,ni_self_employed,advances_book,onboarding_done,updated_at').maybeSingle()) as TaxProfile | null;
  }
  async saveTaxProfile(t: Omit<TaxProfile, 'updated_at'>) {
    await this.authed();
    const exists = this.c(await this.sb.from('tax_profiles').select('owner_id').maybeSingle());
    if (exists) this.c(await this.sb.from('tax_profiles').update({ ...t, updated_at: new Date().toISOString() }).eq('owner_id', (exists as { owner_id: string }).owner_id));
    else this.c(await this.sb.from('tax_profiles').insert(t));
  }
  async listSubmissions() {
    await this.authed();
    return this.c(await this.sb.from('submissions').select('*').order('tax_year', { ascending: false })) as Submission[];
  }
  async saveSubmission(sub: SubmissionInput, id?: string) {
    await this.authed();
    if (id) {
      const { kind: _k, tax_year: _y, period: _p, ...rest } = sub;
      const rows = this.c(await this.sb.from('submissions').update(rest).eq('id', id).select('*'));
      if (!rows?.length) throw new AppError('NOT_FOUND');
      return rows[0] as Submission;
    }
    return this.c(await this.sb.from('submissions').insert(sub).select('*').single()) as Submission;
  }

  async importRecords(payload: unknown, mode: 'restore' | 'legacy') {
    await this.authed();
    return this.c(await this.sb.rpc('import_records', { p: payload, p_mode: mode })) as Record<string, number>;
  }
  async listAuditLog() {
    await this.authed();
    return this.c(await this.sb.from('audit_log').select('action,entity,entity_id,details,at').order('at', { ascending: false }).limit(500)) as AuditEntry[];
  }
}
