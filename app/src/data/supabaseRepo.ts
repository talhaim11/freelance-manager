import type { SupabaseClient } from '@supabase/supabase-js';
import type { VatStatusPeriod } from '../domain/classification';
import { AppError } from '../domain/errors';
import type { Customer, Doc, DraftInput, Profile, Repo, Series } from './types';

/** Throws a mapped error; database error messages carry codes such as FINALIZED_DOCUMENT. */
function check<T>(res: { data: T; error: { message: string; code?: string } | null }): T {
  if (res.error) throw new AppError(/\b([A-Z][A-Z_]{3,})\b/.exec(res.error.message)?.[1] ?? 'UNKNOWN', res.error.message);
  return res.data;
}

export class SupabaseRepo implements Repo {
  readonly mode = 'supabase' as const;
  constructor(private sb: SupabaseClient) {}

  async getProfile() {
    return check(await this.sb.from('business_profiles')
      .select('legal_name,business_name,id_number,address,phone,email').maybeSingle()) as Profile | null;
  }
  async saveProfile(p: Profile) {
    check(await this.sb.from('business_profiles').upsert({ ...p, updated_at: new Date().toISOString() }, { onConflict: 'owner_id' }));
  }
  async listVatPeriods() {
    return check(await this.sb.from('vat_status_periods').select('id,status,effective_from,effective_to,note')
      .order('effective_from')) as VatStatusPeriod[];
  }
  async addVatPeriod(p: Omit<VatStatusPeriod, 'id'>) {
    check(await this.sb.from('vat_status_periods').insert(p));
  }
  async listCustomers() {
    return check(await this.sb.from('customers').select('id,name,tax_id,address,email,phone').order('name')) as Customer[];
  }
  async addCustomer(c: Omit<Customer, 'id'>) {
    return check(await this.sb.from('customers').insert(c).select('id,name,tax_id,address,email,phone').single()) as Customer;
  }
  async updateCustomer(c: Customer) {
    const { id, ...rest } = c;
    check(await this.sb.from('customers').update({ ...rest, updated_at: new Date().toISOString() }).eq('id', id));
  }
  async listSeries() {
    return check(await this.sb.from('document_series').select('id,doc_type,name,next_number,is_legacy').order('created_at')) as Series[];
  }
  async addSeries(s: { doc_type: Series['doc_type']; name: string; next_number: number }) {
    return check(await this.sb.from('document_series').insert(s).select('id,doc_type,name,next_number,is_legacy').single()) as Series;
  }
  async listDocuments() {
    return check(await this.sb.from('documents').select('*').order('created_at', { ascending: false })) as Doc[];
  }
  async getDocument(id: string) {
    return check(await this.sb.from('documents').select('*').eq('id', id).maybeSingle()) as Doc | null;
  }
  async createDraft(d: DraftInput) {
    // ON CONFLICT DO NOTHING on the idempotency key, then read back: double submits create one draft.
    check(await this.sb.from('documents').upsert(d, { onConflict: 'idempotency_key', ignoreDuplicates: true }));
    return check(await this.sb.from('documents').select('*').eq('idempotency_key', d.idempotency_key).single()) as Doc;
  }
  async updateDraft(id: string, patch: Partial<Omit<DraftInput, 'idempotency_key'>>) {
    check(await this.sb.from('documents').update(patch).eq('id', id).eq('status', 'draft'));
  }
  async deleteDraft(id: string) {
    check(await this.sb.from('documents').delete().eq('id', id).eq('status', 'draft'));
  }
  async issueDocument(id: string) {
    return check(await this.sb.rpc('issue_document', { p_document_id: id }).single()) as Doc;
  }
  async cancelDocument(id: string, reason: string, idempotencyKey: string) {
    return check(await this.sb.rpc('cancel_document', { p_document_id: id, p_reason: reason, p_idempotency_key: idempotencyKey }).single()) as Doc;
  }
}
