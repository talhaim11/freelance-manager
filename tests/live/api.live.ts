// Live suite: real Supabase Auth + PostgREST + Postgres (RLS, grants, triggers,
// SECURITY DEFINER functions), through supabase-js and the app's own SupabaseRepo.
// Uses only the publishable key and synthetic test accounts.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SupabaseRepo, mapError } from '../../app/src/data/supabaseRepo';
import { AppError } from '../../app/src/domain/errors';
import { loadLiveTarget, type Account } from './env';

const { target, reason } = loadLiveTarget();
const T = target!;
const RUN = randomUUID().slice(0, 8);
const TABLES = ['business_profiles', 'vat_status_periods', 'customers', 'document_series', 'documents', 'audit_log'];

function client(): SupabaseClient {
  return createClient(T.url, T.publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
}
async function signedIn(a: Account): Promise<SupabaseClient> {
  const c = client();
  const { error } = await c.auth.signInWithPassword(a);
  if (error) throw new Error(`sign-in failed for a test account: ${error.message}`);
  return c;
}
const line = (description: string, shekels: number) => ({ description, quantity: 1, unit_price_agorot: shekels * 100 });

describe.skipIf(!target)(`live Supabase (${target?.kind ?? reason})`, () => {
  let ownerA: SupabaseClient; // "computer"
  let ownerB: SupabaseClient; // "phone": a second, independent session of the same account
  let outsider: SupabaseClient;
  let customerId: string;
  let seriesId: string;

  beforeAll(async () => {
    [ownerA, ownerB, outsider] = await Promise.all([signedIn(T.owner), signedIn(T.owner), signedIn(T.outsider)]);
    // Synthetic issuer profile and VAT status for the automation account only.
    const prof = await ownerA.from('business_profiles').select('legal_name').maybeSingle();
    if (!prof.data?.legal_name) {
      const r = await ownerA.from('business_profiles').upsert({ legal_name: 'חשבון בדיקות אוטומטיות', id_number: '000000018', address: 'כתובת בדיקה 1' }, { onConflict: 'owner_id' });
      expect(r.error).toBeNull();
    }
    const vat = await ownerA.from('vat_status_periods').select('id');
    if (!vat.data?.length) expect((await ownerA.from('vat_status_periods').insert({ status: 'exempt', effective_from: '2024-01-01' })).error).toBeNull();
    const c = await ownerA.from('customers').insert({ name: `לקוח בדיקה ${RUN}`, address: 'רחוב בדיקה 2' }).select('id').single();
    expect(c.error).toBeNull();
    customerId = c.data!.id;
    const s = await ownerA.from('document_series').insert({ doc_type: 'transaction_invoice', name: `בדיקה ${RUN}`, next_number: 1 }).select('id').single();
    expect(s.error).toBeNull();
    seriesId = s.data!.id;
  });

  afterAll(async () => {
    await Promise.all([ownerA, ownerB, outsider].map((c) => c?.auth.signOut({ scope: 'local' })));
  });

  const draft = (c: SupabaseClient, extra: Record<string, unknown> = {}) =>
    c.from('documents').insert({
      idempotency_key: randomUUID(), series_id: seriesId, doc_type: 'transaction_invoice', issue_date: '2026-11-05',
      customer_id: customerId, lines: [line('שירות בדיקה', 100)], ...extra,
    }).select('id').single();

  // ───────────── authentication and authorization ─────────────
  it('public sign-up is disabled', async () => {
    const { data, error } = await client().auth.signUp({ email: `probe-${RUN}@example.com`, password: `Probe-${RUN}-12345` });
    expect(error, 'sign-up must be rejected').not.toBeNull();
    expect(data.user).toBeNull();
    expect(error!.message).toMatch(/signups? not allowed|disabled/i);
  });

  it('a wrong password is rejected', async () => {
    const { error } = await client().auth.signInWithPassword({ email: T.owner.email, password: 'wrong-password-123' });
    expect(error).not.toBeNull();
    expect(error!.status).toBe(400);
  });

  it('anonymous requests can read nothing, write nothing and call no functions', async () => {
    const anon = client();
    for (const t of TABLES) {
      const r = await anon.from(t).select('*').limit(1);
      expect(r.error?.code, `anon select ${t}`).toBe('42501');
    }
    expect((await anon.from('customers').insert({ name: 'x' })).error).not.toBeNull();
    for (const [fn, args] of [['issue_document', { p_document_id: randomUUID() }], ['am_i_allowed', {}],
      ['cancel_document', { p_document_id: randomUUID(), p_reason: 'x', p_idempotency_key: randomUUID() }]] as const) {
      expect((await anon.rpc(fn, args)).error, `anon rpc ${fn}`).not.toBeNull();
    }
  });

  it('a signed-in account that is not allow-listed sees nothing and can change nothing', async () => {
    const own = await draft(ownerA);
    expect(own.error).toBeNull();
    expect((await outsider.rpc('am_i_allowed')).data).toBe(false);
    for (const t of TABLES) {
      const r = await outsider.from(t).select('*');
      expect(r.error, t).toBeNull();
      expect(r.data, `outsider must see no ${t}`).toEqual([]);
    }
    expect((await outsider.from('customers').insert({ name: 'פולש' })).error?.code).toBe('42501');
    const upd = await outsider.from('documents').update({ notes: 'פריצה' }).eq('id', own.data!.id).select('id');
    expect(upd.data ?? []).toEqual([]);
    const issue = await outsider.rpc('issue_document', { p_document_id: own.data!.id });
    expect(issue.error?.message).toMatch(/NOT_ALLOWED/);
    expect((await ownerA.from('documents').select('notes,status').eq('id', own.data!.id).single()).data).toMatchObject({ notes: '', status: 'draft' });
    await ownerA.from('documents').delete().eq('id', own.data!.id);
  });

  it.skipIf(!target?.owner2)('two allow-listed accounts are isolated from each other', async () => {
    const other = await signedIn(T.owner2!);
    const own = await draft(ownerA);
    expect((await other.from('customers').select('id').eq('id', customerId)).data).toEqual([]);
    expect((await other.from('documents').select('id').eq('id', own.data!.id)).data).toEqual([]);
    expect((await other.rpc('issue_document', { p_document_id: own.data!.id })).error?.message).toMatch(/NOT_FOUND/);
    expect((await other.from('documents').delete().eq('id', own.data!.id).select('id')).data).toEqual([]);
    await ownerA.from('documents').delete().eq('id', own.data!.id);
    await other.auth.signOut({ scope: 'local' });
  });

  // ───────────── documents, numbering, immutability ─────────────
  it('the same draft submitted twice (double click / retry) creates one row', async () => {
    const repo = new SupabaseRepo(ownerA);
    const input = { idempotency_key: randomUUID(), series_id: seriesId, doc_type: 'transaction_invoice' as const, issue_date: '2026-11-05',
      customer_id: customerId, lines: [line('טיוטה כפולה', 10)], notes: '', payment_details: {} };
    const [a, b] = await Promise.all([repo.createDraft(input), new SupabaseRepo(ownerB).createDraft(input)]);
    expect(a.id).toBe(b.id);
    expect((await ownerA.from('documents').select('id').eq('idempotency_key', input.idempotency_key)).data).toHaveLength(1);
    await repo.deleteDraft(a.id);
  });

  it('issuing the same draft from two devices at once assigns exactly one number', async () => {
    const d = await draft(ownerA);
    const calls = Array.from({ length: 10 }, (_, i) => (i % 2 ? ownerA : ownerB).rpc('issue_document', { p_document_id: d.data!.id }).single());
    const results = await Promise.all(calls);
    results.forEach((r) => expect(r.error).toBeNull());
    const numbers = new Set(results.map((r) => (r.data as { number: number }).number));
    expect([...numbers]).toEqual([1]);
    expect((await ownerA.from('document_series').select('next_number').eq('id', seriesId).single()).data!.next_number).toBe(2);
  });

  it('issuing different drafts concurrently from two devices gives unique, gap-free numbers', async () => {
    const drafts = await Promise.all(Array.from({ length: 12 }, (_, i) => draft(i % 2 ? ownerA : ownerB)));
    const issued = await Promise.all(drafts.map((d, i) => (i % 2 ? ownerB : ownerA).rpc('issue_document', { p_document_id: d.data!.id }).single()));
    issued.forEach((r) => expect(r.error).toBeNull());
    const nums = issued.map((r) => (r.data as { number: number }).number).sort((x, y) => x - y);
    expect(nums).toEqual(Array.from({ length: 12 }, (_, i) => i + 2));
  });

  it('issued documents cannot be edited or deleted, and clients cannot forge status or numbers', async () => {
    const d = await draft(ownerA);
    const id = d.data!.id;
    await ownerA.rpc('issue_document', { p_document_id: id });
    const edit = await ownerA.from('documents').update({ notes: 'שינוי אחרי הפקה' }).eq('id', id);
    expect(edit.error?.message).toMatch(/FINALIZED_DOCUMENT/);
    const del = await ownerA.from('documents').delete().eq('id', id);
    expect(del.error?.message).toMatch(/FINALIZED_DOCUMENT/);
    const d2 = await draft(ownerA);
    expect((await ownerA.from('documents').update({ status: 'issued', number: 999 }).eq('id', d2.data!.id)).error?.code).toBe('42501');
    expect((await ownerA.from('documents').insert({ idempotency_key: randomUUID(), series_id: seriesId, doc_type: 'transaction_invoice',
      issue_date: '2026-11-05', status: 'issued', number: 998 })).error?.code).toBe('42501');
    expect((await ownerA.from('document_series').update({ next_number: 1 }).eq('id', seriesId)).error?.code).toBe('42501');
    expect((await ownerA.from('audit_log').delete().gt('id', 0)).error?.code).toBe('42501');
    await ownerA.from('documents').delete().eq('id', d2.data!.id);
  });

  it('the app repository reports a draft issued on another device instead of silently "saving" it', async () => {
    const d = await draft(ownerA);
    await ownerB.rpc('issue_document', { p_document_id: d.data!.id });
    const repo = new SupabaseRepo(ownerA);
    await expect(repo.updateDraft(d.data!.id, { notes: 'עריכה מהמחשב' })).rejects.toMatchObject({ code: 'FINALIZED_DOCUMENT' });
    await expect(repo.deleteDraft(d.data!.id)).rejects.toMatchObject({ code: 'FINALIZED_DOCUMENT' });
  });

  it('cancellation is idempotent and leaves the original content unchanged', async () => {
    const d = await draft(ownerA);
    const issued = (await ownerA.rpc('issue_document', { p_document_id: d.data!.id }).single()).data as { id: string; lines: unknown; total_agorot: number };
    const key = randomUUID();
    const [c1, c2] = await Promise.all([
      new SupabaseRepo(ownerA).cancelDocument(issued.id, 'בדיקת ביטול', key),
      new SupabaseRepo(ownerB).cancelDocument(issued.id, 'בדיקת ביטול', key),
    ]);
    expect(c1.id).toBe(c2.id);
    expect(c1.total_agorot).toBe(-issued.total_agorot);
    const orig = (await ownerA.from('documents').select('*').eq('id', issued.id).single()).data;
    expect(orig).toMatchObject({ status: 'cancelled', cancelled_by_document_id: c1.id, lines: issued.lines, total_agorot: issued.total_agorot });
    const audit = await ownerA.from('audit_log').select('action').eq('entity_id', issued.id);
    expect(audit.data!.map((a) => a.action).sort()).toEqual(['document.cancelled', 'document.issued']);
  });

  // ───────────── sessions and failures ─────────────
  it('an invalid or tampered access token is reported as SESSION_EXPIRED, not as empty data', async () => {
    const { data } = await ownerA.auth.getSession();
    const t = data.session!.access_token;
    const tampered = t.slice(0, -4) + (t.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    const c = createClient(T.url, T.publishableKey, { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${tampered}` } } });
    const r = await c.from('documents').select('id').limit(1);
    expect(r.status).toBe(401);
    expect(mapError(r.error!, r.status).code).toBe('SESSION_EXPIRED');
  });

  it('the app repository refuses to run without a session instead of falling back to anonymous access', async () => {
    const expired: string[] = [];
    const repo = new SupabaseRepo(client(), () => expired.push('x'));
    await expect(repo.listDocuments()).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    expect(expired).toHaveLength(1);
  });

  it('an unreachable server is reported as NETWORK (outcome unknown), never as success', async () => {
    const c = createClient('http://127.0.0.1:9', T.publishableKey, { auth: { persistSession: false } });
    const r = await c.from('documents').select('id');
    const e = mapError(r.error!, r.status);
    expect(e).toBeInstanceOf(AppError);
    expect(e.code).toBe('NETWORK');
  });

  // Last: revokes every session of the automation account.
  it('sign-out everywhere revokes the other device session; unrelated sessions survive', async () => {
    const { data: phone } = await ownerB.auth.getSession();
    await ownerA.auth.signOut({ scope: 'global' });
    const r = await client().auth.refreshSession({ refresh_token: phone.session!.refresh_token });
    expect(r.error, 'a revoked refresh token must not yield a new session').not.toBeNull();
    expect((await outsider.auth.getUser()).error).toBeNull();
  });
});
