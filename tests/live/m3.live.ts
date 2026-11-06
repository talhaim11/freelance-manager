// Live M3 suite against real Supabase: verified backup → restore (with private files), legacy import,
// original/copy registry, tax profile, guided submissions, and the admin-only allow-list function.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SupabaseRepo } from '../../app/src/data/supabaseRepo';
import { exportAll, importLegacy, restoreBackup, buildZip, readZip } from '../../app/src/data/backup';
import { planLegacyImport } from '../../app/src/domain/backup';
import { errorCode } from '../../app/src/domain/errors';
import { loadLiveTarget, type Account } from './env';

const { target, reason } = loadLiveTarget();
const T = target!;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const client = () => createClient(T.url, T.publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
async function signedIn(a: Account) {
  const c = client();
  const { error } = await c.auth.signInWithPassword(a);
  if (error) throw new Error(`sign-in failed for a test account: ${error.message}`);
  return c;
}
/** Takes the next unused (empty) restore account; restored accounts cannot be emptied again. */
async function freshAccount(): Promise<SupabaseClient> {
  for (const a of T.restore) {
    const c = await signedIn(a);
    const [x, y] = await Promise.all([c.from('documents').select('id').limit(1), c.from('customers').select('id').limit(1)]);
    if (!x.data?.length && !y.data?.length) return c;
    await c.auth.signOut({ scope: 'local' });
  }
  throw new Error('no empty restore account left — re-run the live setup script to create fresh ones');
}

describe.skipIf(!target || !target.restore.length)(`live Supabase M3 (${target?.kind ?? reason})`, () => {
  let owner: SupabaseClient;
  let outsider: SupabaseClient;
  beforeAll(async () => { [owner, outsider] = await Promise.all([signedIn(T.owner), signedIn(T.outsider)]); });
  afterAll(async () => { await Promise.all([owner, outsider].map((c) => c?.auth.signOut({ scope: 'local' }))); });

  it('backup → ZIP → restore into an empty account: identical numbers, totals, links and file fingerprints', async () => {
    const src = new SupabaseRepo(owner);
    // make sure the source has a file to carry
    const e = await src.saveExpense({ client_key: randomUUID(), supplier: 'ספק גיבוי', supplier_tax_id: '', doc_number: '', doc_date: '2026-10-10',
      amount_agorot: 777, vat_agorot: 0, category: 'other', business_use_pct: 100, status: 'confirmed', notes: '' });
    await src.addExpenseAttachment(e.id, { id: randomUUID(), bytes: new Uint8Array(PNG), sha256: createHash('sha256').update(PNG).digest('hex'), mime_type: 'image/png', original_name: 'גיבוי.png' });
    const exported = await exportAll(src);
    expect(exported.manifest.counts.documents).toBeGreaterThan(0);
    const zip = await buildZip(exported);
    const { payload, files } = await readZip(new Uint8Array(await zip.arrayBuffer()));

    const dstClient = await freshAccount();
    const dst = new SupabaseRepo(dstClient);
    const res = await restoreBackup(dst, payload, files);
    expect(res.differences).toEqual([]);
    expect(res.counts.documents).toBe(exported.manifest.counts.documents);
    // a second restore is refused, and the source account is unchanged
    await expect(dst.importRecords(payload, 'restore')).rejects.toSatisfy((x: unknown) => errorCode(x) === 'IMPORT_TARGET_NOT_EMPTY');
    expect((await exportAll(src)).manifest.counts.documents).toBe(exported.manifest.counts.documents);
    // restored files live in the new account's private folder and are not readable by anyone else
    const restored = (await dst.listExpenses()).flatMap((x) => x.attachments);
    const me = (await dstClient.auth.getUser()).data.user!.id;
    expect(restored.every((a) => a.storage_path.startsWith(`${me}/`))).toBe(true);
    expect((await outsider.storage.from('expense-files').download(restored[0].storage_path)).error).not.toBeNull();
    await dstClient.auth.signOut({ scope: 'local' });
  }, 120_000);

  it('legacy import keeps the original invoice numbers, verifies the result, and runs only once', async () => {
    const legacy = {
      profile: { name: 'בעל עסק סינתטי', id: '000000018', business: '', address: 'כתובת 1', phone: '', email: '' },
      invoices: [
        { id: 1, number: 41, clientName: 'לקוח ישן', date: '2025-02-01', items: [{ desc: 'עבודה', qty: 1, price: 1200 }], total: 1200, status: 'issued', createdAt: '2025-02-01T10:00:00Z' },
        { id: 2, number: 43, clientName: 'לקוח ישן', date: '2025-03-01', items: [{ desc: 'עוד', qty: 2, price: 50.5 }], total: 101, status: 'cancelled', cancelReason: 'טעות', createdAt: '2025-03-01T10:00:00Z' },
      ],
      expenses: [{ id: 3, desc: 'מקלדת', amount: 199.9, category: 'ציוד', date: '2025-02-10', receipt: { data: `data:image/png;base64,${PNG.toString('base64')}`, name: 'kb.png', type: 'image/png' } }],
      nextInvoiceNum: 44,
    };
    const plan = planLegacyImport(legacy, randomUUID);
    expect(plan.summary.gaps).toEqual([42]);
    const c = await freshAccount();
    const repo = new SupabaseRepo(c);
    const r = await importLegacy(repo, plan);
    expect(r.differences).toEqual([]);
    const docs = await repo.listDocuments();
    expect(docs.map((d) => `${d.number}:${d.status}`).sort()).toEqual(['41:issued', '43:cancelled']);
    expect((await repo.listSeries())[0]).toMatchObject({ is_legacy: true, next_number: 44 });
    await expect(repo.importRecords(plan.payload, 'legacy')).rejects.toSatisfy((x: unknown) => errorCode(x) === 'IMPORT_ALREADY_DONE');
    await c.auth.signOut({ scope: 'local' });
  }, 120_000);

  it('the first PDF of an issued document is the original; concurrent requests get exactly one original', async () => {
    const repo = new SupabaseRepo(owner);
    const issued = (await repo.listDocuments()).find((d) => d.status === 'issued' && d.doc_type !== 'cancellation')!;
    const before = (await repo.listOutputs(issued.id)).filter((o) => o.kind === 'original').length;
    const kinds = await Promise.all(Array.from({ length: 5 }, () => repo.registerOutput(issued.id, { original: 'a'.repeat(64), copy: 'b'.repeat(64) })));
    expect(kinds.filter((k) => k === 'original').length).toBe(before ? 0 : 1);
    const outs = await repo.listOutputs(issued.id);
    expect(outs.filter((o) => o.kind === 'original')).toHaveLength(1);
    expect(outs.filter((o) => o.kind === 'copy').every((o) => o.sha256 === 'b'.repeat(64))).toBe(true);
    expect((await outsider.rpc('register_document_output', { p_document_id: issued.id, p_sha_original: null, p_sha_copy: null })).error?.message).toMatch(/NOT_ALLOWED/);
  });

  it('tax profile and guided submissions: owner-only, references required for submitted/paid', async () => {
    const repo = new SupabaseRepo(owner);
    await repo.saveTaxProfile({ income_tax_regime: 'small_business', employed: 'yes', ni_self_employed: 'unknown', advances_book: 'no', onboarding_done: true });
    expect(await repo.getTaxProfile()).toMatchObject({ income_tax_regime: 'small_business', employed: 'yes' });
    const year = 2000 + Math.floor(Math.random() * 90);
    const base = { kind: 'vat_exempt_declaration' as const, tax_year: year, period: '', status: 'prepared' as const, reference: '', submitted_on: null,
      payment_status: 'not_due' as const, payment_reference: '', prepared_values: { turnover_agorot: 123 }, attachment_path: null, notes: '' };
    const s = await repo.saveSubmission(base);
    await expect(repo.saveSubmission({ ...base, status: 'submitted' }, s.id)).rejects.toBeTruthy();
    expect((await repo.saveSubmission({ ...base, status: 'submitted', reference: 'ASM-1', submitted_on: '2026-01-20' }, s.id)).status).toBe('submitted');
    expect((await outsider.from('submissions').select('id')).data).toEqual([]);
    expect((await outsider.from('tax_profiles').select('owner_id')).data).toEqual([]);
  });

  it('the admin allow-list function cannot be called by the app (anonymous or signed in)', async () => {
    for (const c of [client(), owner, outsider]) {
      const r = await c.rpc('admin_set_allowed', { p_email: 'attacker@example.com', p_allowed: true });
      expect(r.error, 'must be refused').not.toBeNull();
    }
  });
});
