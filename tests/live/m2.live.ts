// Live M2 suite: payments/allocations, expenses and PRIVATE file storage, through real
// Supabase Auth + PostgREST + Storage, using only the publishable key and synthetic accounts.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SupabaseRepo } from '../../app/src/data/supabaseRepo';
import { errorCode } from '../../app/src/domain/errors';
import { loadLiveTarget, type Account } from './env';

const { target, reason } = loadLiveTarget();
const T = target!;
const RUN = randomUUID().slice(0, 8);
const BUCKET = 'expense-files';
const PNG = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

const client = () => createClient(T.url, T.publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
async function signedIn(a: Account) {
  const c = client();
  const { error } = await c.auth.signInWithPassword(a);
  if (error) throw new Error(`sign-in failed for a test account: ${error.message}`);
  return c;
}
const uid = async (c: SupabaseClient) => (await c.auth.getUser()).data.user!.id;

describe.skipIf(!target)(`live Supabase M2 (${target?.kind ?? reason})`, () => {
  let computer: SupabaseClient;
  let phone: SupabaseClient;
  let outsider: SupabaseClient;
  let customerId: string;
  let invSeries: string;
  let recSeries: string;

  beforeAll(async () => {
    [computer, phone, outsider] = await Promise.all([signedIn(T.owner), signedIn(T.owner), signedIn(T.outsider)]);
    const prof = await computer.from('business_profiles').select('legal_name').maybeSingle();
    if (!prof.data?.legal_name) {
      expect((await computer.from('business_profiles').upsert({ legal_name: 'חשבון בדיקות אוטומטיות', id_number: '000000018', address: 'כתובת בדיקה 1' }, { onConflict: 'owner_id' })).error).toBeNull();
    }
    if (!(await computer.from('vat_status_periods').select('id')).data?.length) {
      expect((await computer.from('vat_status_periods').insert({ status: 'exempt', effective_from: '2024-01-01' })).error).toBeNull();
    }
    customerId = (await new SupabaseRepo(computer).addCustomer({ name: `לקוח M2 ${RUN}`, tax_id: '', address: 'רחוב בדיקה 3', email: '', phone: '' }, randomUUID())).id;
    invSeries = (await computer.from('document_series').insert({ doc_type: 'transaction_invoice', name: `M2 ${RUN}`, next_number: 1 }).select('id').single()).data!.id;
    recSeries = (await computer.from('document_series').insert({ doc_type: 'receipt', name: `M2 ${RUN}`, next_number: 1 }).select('id').single()).data!.id;
  });
  afterAll(async () => { await Promise.all([computer, phone, outsider].map((c) => c?.auth.signOut({ scope: 'local' }))); });

  const doc = (docType: 'transaction_invoice' | 'receipt', amount: number, allocations: { invoice_id: string; amount_agorot: number }[] = []) => ({
    idempotency_key: randomUUID(), series_id: docType === 'receipt' ? recSeries : invSeries, doc_type: docType, issue_date: '2026-11-06',
    customer_id: customerId, lines: [{ description: docType === 'receipt' ? 'תשלום' : 'שירות', quantity: 1, unit_price_agorot: amount }],
    notes: '', payment_details: docType === 'receipt' ? { method: 'bank_transfer' as const } : {}, allocations,
  });

  it('anonymous and non-allow-listed accounts cannot reach payments, balances, expenses or files', async () => {
    const anon = client();
    for (const t of ['payment_allocations', 'invoice_balances', 'expenses', 'expense_attachments']) {
      expect((await anon.from(t).select('*').limit(1)).error?.code, `anon ${t}`).toBe('42501');
      const o = await outsider.from(t).select('*');
      expect(o.error, t).toBeNull();
      expect(o.data, `outsider ${t}`).toEqual([]);
    }
    expect((await outsider.from('expenses').insert({ client_key: randomUUID(), supplier: 'x', doc_date: '2026-11-01', amount_agorot: 100 })).error?.code).toBe('42501');
    expect((await anon.storage.from(BUCKET).upload(`${randomUUID()}/x.png`, PNG, { contentType: 'image/png' })).error).not.toBeNull();
  });

  it('partial payments from computer and phone: balances agree on both; the phone cannot over-pay', async () => {
    const pc = new SupabaseRepo(computer);
    const mobile = new SupabaseRepo(phone);
    const inv = await pc.issueDocument((await pc.createDraft(doc('transaction_invoice', 100000))).id);
    const r1 = await pc.issueDocument((await pc.createDraft(doc('receipt', 40000, [{ invoice_id: inv.id, amount_agorot: 40000 }]))).id);
    const fromPhone = (await mobile.listInvoiceBalances()).find((b) => b.invoice_id === inv.id)!;
    expect(fromPhone).toMatchObject({ paid_agorot: 40000, balance_agorot: 60000 });
    const over = await mobile.createDraft(doc('receipt', 70000, [{ invoice_id: inv.id, amount_agorot: 70000 }]));
    await expect(mobile.issueDocument(over.id)).rejects.toSatisfy((e: unknown) => errorCode(e) === 'ALLOCATION_EXCEEDS_BALANCE');
    expect((await mobile.getDocument(over.id))!.status).toBe('draft');
    await mobile.deleteDraft(over.id);
    // Both devices pay the remaining 600 at the same moment: exactly one succeeds.
    const [a, b] = await Promise.all([pc.createDraft(doc('receipt', 60000, [{ invoice_id: inv.id, amount_agorot: 60000 }])),
      mobile.createDraft(doc('receipt', 60000, [{ invoice_id: inv.id, amount_agorot: 60000 }]))]);
    const results = await Promise.allSettled([pc.issueDocument(a.id), mobile.issueDocument(b.id)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await pc.listInvoiceBalances()).find((x) => x.invoice_id === inv.id)!.balance_agorot).toBe(0);
    expect(await pc.listAllocationsFor(r1.id)).toEqual([{ receipt_id: r1.id, invoice_id: inv.id, amount_agorot: 40000 }]);
    // A paid invoice cannot be cancelled; allocations cannot be edited through the API.
    await expect(pc.cancelDocument(inv.id, 'בדיקה', randomUUID())).rejects.toSatisfy((e: unknown) => errorCode(e) === 'INVOICE_HAS_PAYMENTS');
    expect((await computer.from('payment_allocations').update({ amount_agorot: 1 }).eq('receipt_id', r1.id)).error?.code).toBe('42501');
    await Promise.all([a, b].map(async (d) => { if ((await pc.getDocument(d.id))?.status === 'draft') await pc.deleteDraft(d.id); }));
  });

  it('customers and expenses created twice at once (double tap, two devices) exist once', async () => {
    const key = randomUUID();
    const c = { name: `פעם אחת ${RUN}`, tax_id: '', address: '', email: '', phone: '' };
    const [x, y] = await Promise.all([new SupabaseRepo(computer).addCustomer(c, key), new SupabaseRepo(phone).addCustomer(c, key)]);
    expect(x.id).toBe(y.id);
    const e = { client_key: randomUUID(), supplier: `ספק ${RUN}`, supplier_tax_id: '', doc_number: '', doc_date: '2026-11-01', amount_agorot: 2500,
      vat_agorot: 0, category: 'other', business_use_pct: 100, status: 'needs_review' as const, notes: '' };
    const [e1, e2] = await Promise.all([new SupabaseRepo(computer).saveExpense(e), new SupabaseRepo(phone).saveExpense(e)]);
    expect(e1.id).toBe(e2.id);
    expect((await computer.from('expenses').select('id').eq('client_key', e.client_key)).data).toHaveLength(1);
  });

  it('attachments are private: owner can upload once (retry-safe) and view; nobody else can read, overwrite or delete', async () => {
    const pc = new SupabaseRepo(computer);
    const exp = await pc.saveExpense({ client_key: randomUUID(), supplier: `ספק קבצים ${RUN}`, supplier_tax_id: '', doc_number: 'S-1', doc_date: '2026-11-02',
      amount_agorot: 11800, vat_agorot: 1800, category: 'software', business_use_pct: 100, status: 'needs_review', notes: '' });
    const upload = { id: randomUUID(), bytes: PNG, sha256: sha(PNG), mime_type: 'image/png', original_name: 'קבלה.png' };
    const att = await pc.addExpenseAttachment(exp.id, upload);
    await pc.addExpenseAttachment(exp.id, upload);                                   // retry after a "lost response"
    expect((await new SupabaseRepo(phone).listExpenses()).find((e) => e.id === exp.id)!.attachments).toHaveLength(1);
    expect(att.storage_path.startsWith(`${await uid(computer)}/`)).toBe(true);

    // The owner (on the phone) views it through a short-lived signed link; content is intact.
    const url = await new SupabaseRepo(phone).attachmentUrl(att);
    const got = new Uint8Array(await (await fetch(url)).arrayBuffer());
    expect(sha(got)).toBe(att.sha256);

    // No public URL works for a private bucket.
    const pub = computer.storage.from(BUCKET).getPublicUrl(att.storage_path).data.publicUrl;
    expect((await fetch(pub)).ok).toBe(false);
    // Anonymous and non-allow-listed accounts cannot download or sign it.
    expect((await client().storage.from(BUCKET).download(att.storage_path)).error).not.toBeNull();
    expect((await outsider.storage.from(BUCKET).download(att.storage_path)).error).not.toBeNull();
    expect((await outsider.storage.from(BUCKET).createSignedUrl(att.storage_path, 60)).error).not.toBeNull();
    // Nobody can write into the owner's folder, and an outsider cannot even use their own folder.
    expect((await outsider.storage.from(BUCKET).upload(`${await uid(computer)}/${randomUUID()}.png`, PNG, { contentType: 'image/png' })).error).not.toBeNull();
    expect((await outsider.storage.from(BUCKET).upload(`${await uid(outsider)}/${randomUUID()}.png`, PNG, { contentType: 'image/png' })).error).not.toBeNull();
    // The owner cannot overwrite or delete the original either.
    expect((await computer.storage.from(BUCKET).upload(att.storage_path, new Uint8Array([1, 2, 3]), { contentType: 'image/png', upsert: true })).error).not.toBeNull();
    await computer.storage.from(BUCKET).remove([att.storage_path]);
    const again = new Uint8Array(await (await fetch(await pc.attachmentUrl(att))).arrayBuffer());
    expect(sha(again)).toBe(att.sha256);
    expect((await computer.from('expense_attachments').delete().eq('id', att.id)).error?.code).toBe('42501');
  });

  it.skipIf(!target?.owner2)('a second allow-listed account cannot read the first account’s files or expenses', async () => {
    const other = await signedIn(T.owner2!);
    const pc = new SupabaseRepo(computer);
    const exp = await pc.saveExpense({ client_key: randomUUID(), supplier: `ספק בידוד ${RUN}`, supplier_tax_id: '', doc_number: '', doc_date: '2026-11-03',
      amount_agorot: 900, vat_agorot: 0, category: 'other', business_use_pct: 100, status: 'needs_review', notes: '' });
    const att = await pc.addExpenseAttachment(exp.id, { id: randomUUID(), bytes: PNG, sha256: sha(PNG), mime_type: 'image/png', original_name: 'x.png' });
    expect((await other.from('expenses').select('id').eq('id', exp.id)).data).toEqual([]);
    expect((await other.storage.from(BUCKET).download(att.storage_path)).error).not.toBeNull();
    const listing = await other.storage.from(BUCKET).list(await uid(computer));
    expect(listing.data ?? []).toEqual([]);
    await other.auth.signOut({ scope: 'local' });
  });

  it('the bucket refuses file types and sizes the app does not allow', async () => {
    const me = await uid(computer);
    const html = await computer.storage.from(BUCKET).upload(`${me}/${randomUUID()}.html`, new TextEncoder().encode('<script>x</script>'), { contentType: 'text/html' });
    expect(html.error).not.toBeNull();
    const big = await computer.storage.from(BUCKET).upload(`${me}/${randomUUID()}.pdf`, new Uint8Array(10 * 1024 * 1024 + 1), { contentType: 'application/pdf' });
    expect(big.error).not.toBeNull();
  }, 60_000);
});
