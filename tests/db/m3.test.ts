import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { TestDb, newUser, seedOwner, createDraft, type TestUser } from './harness';
import pg from 'pg';
// Read DATE columns as 'YYYY-MM-DD' strings, as PostgREST returns them to the app.
pg.types.setTypeParser(1082, (v: string) => v);

const db = new TestDb();
const owner = newUser('m3-owner@example.test');
const other = newUser('m3-other@example.test');
const intruder = newUser('m3-intruder@example.test');

beforeAll(async () => {
  await db.start();
  for (const u of [owner, other]) await db.allow(u.email);
}, 180_000);
afterAll(async () => { await db.stop(); });

const q = <T = Record<string, unknown>>(u: TestUser | null, sql: string, args: unknown[] = []) =>
  db.as(u, async (c) => (await c.query(sql, args)).rows as T[]);
const issue = (u: TestUser, id: string) => q(u, 'select * from issue_document($1)', [id]);

describe('original / copy registry', () => {
  it('the first output of an issued document is the original, all later ones are copies — also under concurrency', async () => {
    const { seriesId, customerId } = await seedOwner(db, owner);
    const id = await createDraft(db, owner, seriesId, customerId);
    await expect(q(owner, 'select register_document_output($1, null, null) k', [id])).rejects.toThrow(/NOT_ISSUED/);
    await issue(owner, id);
    const kinds = await Promise.all(Array.from({ length: 8 }, () => q<{ k: string }>(owner, 'select register_document_output($1, null, null) k', [id]).then((r) => r[0].k)));
    expect(kinds.filter((k) => k === 'original')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'copy')).toHaveLength(7);
    await expect(q(other, 'select register_document_output($1, null, null) k', [id])).rejects.toThrow(/NOT_FOUND/);
    await expect(q(intruder, 'select register_document_output($1, null, null) k', [id])).rejects.toThrow(/NOT_ALLOWED/);
    await expect(q(owner, `delete from document_outputs where document_id = $1`, [id])).rejects.toThrow(/permission denied/);
    await expect(db.admin.query(`update document_outputs set kind = 'original' where document_id = $1`, [id])).rejects.toThrow(/OUTPUT_IMMUTABLE/);
  });
});

describe('guided submissions', () => {
  it('cannot be marked submitted without a reference or paid without a payment reference; isolated per user', async () => {
    const ins = (status: string, ref: string, pay = 'not_due', payRef = '') => q(owner,
      `insert into submissions(kind, tax_year, status, reference, payment_status, payment_reference) values ('vat_exempt_declaration', $5, $1, $2, $3, $4) returning id`,
      [status, ref, pay, payRef, 2000 + Math.floor(Math.random() * 99)]);
    await expect(ins('submitted', '')).rejects.toThrow(/check constraint/);
    await expect(ins('prepared', '', 'paid', '')).rejects.toThrow(/check constraint/);
    const [row] = await ins('submitted', 'ASM-123');
    expect(await q(other, 'select * from submissions where id = $1', [(row as { id: string }).id])).toEqual([]);
    await expect(q(null, 'select * from submissions')).rejects.toThrow(/permission denied/);
  });
});

/** A small but complete backup of `owner`, produced with the same shape the app exports. */
async function exportOf(u: TestUser) {
  const one = async (sql: string) => q(u, sql);
  return {
    format: 'freelance-manager-backup', version: 1, exported_at: new Date().toISOString(), source: 'supabase',
    profile: (await one('select legal_name, business_name, id_number, address, phone, email from business_profiles'))[0] ?? null,
    vat_periods: await one('select status, effective_from::text, effective_to::text, note from vat_status_periods'),
    tax_profile: null,
    customers: await one('select * from customers'),
    series: await one('select * from document_series'),
    documents: await one('select * from documents'),
    allocations: await one('select receipt_id, invoice_id, amount_agorot::int from payment_allocations'),
    expenses: await one('select * from expenses'),
    attachments: [],
    submissions: await one('select * from submissions'),
  };
}

describe('import_records: restore and legacy import', () => {
  it('restores a backup into an empty account with identical numbers, statuses, totals and links', async () => {
    const src = newUser('m3-src@example.test');
    const dst = newUser('m3-dst@example.test');
    await db.allow(src.email); await db.allow(dst.email);
    const { seriesId, customerId } = await seedOwner(db, src, { startAt: 501 });
    const inv1 = await createDraft(db, src, seriesId, customerId); await issue(src, inv1);
    const inv2 = await createDraft(db, src, seriesId, customerId); await issue(src, inv2);
    const recSeries = (await q<{ id: string }>(src, `insert into document_series(doc_type, name, next_number) values ('receipt', 'קבלות', 7) returning id`))[0].id;
    const rec = (await q<{ id: string }>(src, `insert into documents(idempotency_key, series_id, doc_type, issue_date, customer_id, lines, payment_details, allocations)
      values ($1, $2, 'receipt', '2026-03-11', $3, '[{"description":"תשלום","quantity":1,"unit_price_agorot":10000}]', '{"method":"cash"}', $4) returning id`,
      [randomUUID(), recSeries, customerId, JSON.stringify([{ invoice_id: inv1, amount_agorot: 10000 }])]))[0].id;
    await issue(src, rec);
    await q(src, 'select cancel_document($1, $2, $3)', [inv2, 'טעות', randomUUID()]);
    await createDraft(db, src, seriesId, customerId);
    await q(src, `insert into expenses(client_key, supplier, doc_date, amount_agorot) values ($1, 'ספק', '2026-02-02', 4321)`, [randomUUID()]);
    const backup = await exportOf(src);

    const res = (await q<{ r: Record<string, number> }>(dst, 'select import_records($1, $2) r', [JSON.stringify(backup), 'restore']))[0].r;
    expect(res).toMatchObject({ customers: 1, documents: backup.documents.length, allocations: 1, expenses: 1 });
    const restored = await exportOf(dst);
    const key = (d: Record<string, unknown>) => `${d.doc_type}|${d.number}|${d.status}|${d.total_agorot}|${d.issue_date}`;
    expect(restored.documents.map(key).sort()).toEqual(backup.documents.map(key).sort());
    expect(restored.series.map((s) => `${s.doc_type}|${s.name}|${s.next_number}`).sort()).toEqual(backup.series.map((s) => `${s.doc_type}|${s.name}|${s.next_number}`).sort());
    // links survived: the cancelled invoice points at its cancellation, which points back
    const cancelled = restored.documents.find((d) => d.status === 'cancelled')!;
    const cancellation = restored.documents.find((d) => d.id === cancelled.cancelled_by_document_id)!;
    expect(cancellation.corrects_document_id).toBe(cancelled.id);
    // balances are the same as in the source
    const bal = async (u: TestUser) => (await q<{ number: number; balance: string }>(u, 'select number, balance_agorot::text balance from invoice_balances order by number')).map((b) => `${b.number}:${b.balance}`);
    expect(await bal(dst)).toEqual(await bal(src));
    // restored documents are as immutable as the originals, and numbering continues where it was
    await expect(q(dst, `update documents set notes = 'x' where id = $1`, [cancelled.id])).rejects.toThrow(/FINALIZED_DOCUMENT/);
    const draft = restored.documents.find((d) => d.status === 'draft')!;
    expect((await issue(dst, draft.id as string))[0]).toMatchObject({ number: 503 });
    // a second restore into a non-empty account is refused
    await expect(q(dst, 'select import_records($1, $2)', [JSON.stringify(backup), 'restore'])).rejects.toThrow(/IMPORT_TARGET_NOT_EMPTY/);
    // the source account was not touched
    expect((await exportOf(src)).documents).toHaveLength(backup.documents.length);
  });

  it('a failed import changes nothing (single transaction)', async () => {
    const u = newUser('m3-atomic@example.test'); await db.allow(u.email);
    const bad = { format: 'freelance-manager-backup', version: 1, customers: [{ id: 'c1', name: 'לקוח' }],
      series: [{ id: 's1', doc_type: 'transaction_invoice', name: 'א', next_number: 3, is_legacy: true }],
      documents: [{ id: 'd1', series_id: 's1', doc_type: 'transaction_invoice', status: 'issued', number: 1, issue_date: '2024-01-01', lines: [], total_agorot: 100, subtotal_agorot: 100, issued_at: '2024-01-01T00:00:00Z' },
                  { id: 'd2', series_id: 's1', doc_type: 'transaction_invoice', status: 'issued', number: 1, issue_date: '2024-01-02', lines: [], total_agorot: 100, subtotal_agorot: 100, issued_at: '2024-01-02T00:00:00Z' }] };
    await expect(q(u, 'select import_records($1, $2)', [JSON.stringify(bad), 'legacy'])).rejects.toThrow(/duplicate key/);
    expect(await q(u, 'select * from customers')).toEqual([]);
    expect(await q(u, 'select * from document_series')).toEqual([]);
  });

  it('legacy import: legacy invoice series only, once; numbers kept; refuses foreign attachment paths; not for intruders', async () => {
    const u = newUser('m3-legacy@example.test'); await db.allow(u.email);
    const payload = (over: Record<string, unknown> = {}) => JSON.stringify({ format: 'freelance-manager-backup', version: 1,
      customers: [{ id: 'c1', name: 'לקוח היסטורי' }],
      series: [{ id: 's1', doc_type: 'transaction_invoice', name: 'היסטורי', next_number: 13, is_legacy: true }],
      documents: [{ id: 'd7', series_id: 's1', doc_type: 'transaction_invoice', status: 'issued', number: 7, issue_date: '2025-05-01', customer_id: 'c1',
                    lines: [{ description: 'עבודה', quantity: 1, unit_price_agorot: 50000 }], total_agorot: 50000, subtotal_agorot: 50000, issued_at: '2025-05-01T10:00:00Z' },
                  { id: 'd12', series_id: 's1', doc_type: 'transaction_invoice', status: 'cancelled', number: 12, issue_date: '2025-06-01', customer_id: 'c1',
                    lines: [], total_agorot: 1000, subtotal_agorot: 1000, issued_at: '2025-06-01T10:00:00Z', cancelled_at: '2025-06-02T10:00:00Z' }],
      expenses: [], attachments: [], ...over });
    await expect(q(intruder, 'select import_records($1, $2)', [payload(), 'legacy'])).rejects.toThrow(/NOT_ALLOWED/);
    await expect(q(u, 'select import_records($1, $2)', [payload({ series: [{ id: 's1', doc_type: 'transaction_invoice', name: 'x', next_number: 1, is_legacy: false }] }), 'legacy'])).rejects.toThrow(/IMPORT_INVALID/);
    await expect(q(u, 'select import_records($1, $2)', [payload({ attachments: [{ id: randomUUID(), expense_id: 'e1', storage_path: `${other.id}/x.png`, sha256: 'a'.repeat(64), mime_type: 'image/png', size_bytes: 1 }] }), 'legacy'])).rejects.toThrow(/IMPORT_INVALID/);
    await q(u, 'select import_records($1, $2)', [payload(), 'legacy']);
    const docs = await q<{ number: number; status: string }>(u, 'select number, status from documents order by number');
    expect(docs).toEqual([{ number: 7, status: 'issued' }, { number: 12, status: 'cancelled' }]);
    expect((await q<{ next_number: number; is_legacy: boolean }>(u, 'select next_number, is_legacy from document_series'))[0]).toEqual({ next_number: 13, is_legacy: true });
    await expect(q(u, 'select import_records($1, $2)', [payload(), 'legacy'])).rejects.toThrow(/IMPORT_ALREADY_DONE/);
    // a legacy series never issues new documents
    const legacySeries = (await q<{ id: string }>(u, 'select id from document_series'))[0].id;
    const cust = (await q<{ id: string }>(u, 'select id from customers'))[0].id;
    await q(u, `insert into business_profiles(legal_name, id_number, address) values ('א', '1', 'ב') on conflict do nothing`);
    await q(u, `insert into vat_status_periods(status, effective_from) values ('exempt', '2020-01-01')`);
    const draft = await createDraft(db, u, legacySeries, cust);
    await expect(issue(u, draft)).rejects.toThrow(/LEGACY_SERIES/);
  });
});
