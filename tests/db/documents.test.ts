import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { TestDb, newUser, seedOwner, createDraft } from './harness';

const db = new TestDb();
const owner = newUser('owner@example.test');
const intruder = newUser('intruder@example.test');   // signed in but not allow-listed
const second = newUser('second@example.test');        // allow-listed, different owner

beforeAll(async () => {
  await db.start();
  await db.allow(owner.email);
  await db.allow(second.email);
}, 180_000);
afterAll(async () => { await db.stop(); });

const issue = (u = owner, id: string) =>
  db.as(u, async (c) => (await c.query('select * from issue_document($1)', [id])).rows[0]);

describe('transactional numbering', () => {
  it('assigns unique, gap-free numbers to 50 drafts issued concurrently', async () => {
    const { seriesId, customerId } = await seedOwner(db, owner);
    const drafts = await Promise.all(Array.from({ length: 50 }, () => createDraft(db, owner, seriesId, customerId)));
    const issued = await Promise.all(drafts.map((id) => issue(owner, id)));
    const numbers = issued.map((d) => d.number).sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    const series = await db.admin.query('select next_number from document_series where id = $1', [seriesId]);
    expect(series.rows[0].next_number).toBe(51);
  }, 60_000);

  it('issuing the same draft 20 times in parallel (double click / retry / second device) yields one number', async () => {
    const { seriesId, customerId } = await seedOwner(db, owner, { startAt: 1001 });
    const id = await createDraft(db, owner, seriesId, customerId);
    const results = await Promise.all(Array.from({ length: 20 }, () => issue(owner, id)));
    expect(new Set(results.map((r) => r.number))).toEqual(new Set([1001]));
    const after = await db.admin.query('select next_number from document_series where id = $1', [seriesId]);
    expect(after.rows[0].next_number).toBe(1002);
    const audits = await db.admin.query(`select count(*)::int n from audit_log where entity_id = $1 and action = 'document.issued'`, [id]);
    expect(audits.rows[0].n).toBe(1);
  }, 60_000);

  it('rejects a second draft with a reused idempotency key (duplicate draft creation)', async () => {
    const { seriesId, customerId } = await seedOwner(db, owner);
    const key = randomUUID();
    await createDraft(db, owner, seriesId, customerId, { key });
    await expect(createDraft(db, owner, seriesId, customerId, { key })).rejects.toThrow(/duplicate key/);
  });

  it('does not let the client move a series number', async () => {
    const { seriesId } = await seedOwner(db, owner);
    await expect(db.as(owner, (c) => c.query('update document_series set next_number = 1 where id = $1', [seriesId])))
      .rejects.toThrow(/permission denied/);
  });

  it('computes totals server-side, ignoring anything the client claims', async () => {
    const { seriesId, customerId } = await seedOwner(db, owner);
    const id = await createDraft(db, owner, seriesId, customerId, {
      lines: [
        { description: 'שעה', quantity: 1.5, unit_price_agorot: 33333 },          // 49999.5 → 50000
        { description: 'הנחה בשורה', quantity: 1, unit_price_agorot: 10000, discount_agorot: 2500 },
      ],
    });
    await expect(db.as(owner, (c) => c.query('update documents set total_agorot = 1 where id = $1', [id])))
      .rejects.toThrow(/permission denied/);
    const d = await issue(owner, id);
    expect(Number(d.subtotal_agorot)).toBe(57500);
    expect(Number(d.total_agorot)).toBe(57500);
    expect(Number(d.vat_agorot)).toBe(0);
  });
});

describe('finalized-document protection', () => {
  it('blocks UPDATE and DELETE of an issued document, even for the database owner role', async () => {
    const { seriesId, customerId } = await seedOwner(db, owner);
    const id = await createDraft(db, owner, seriesId, customerId);
    await issue(owner, id);
    await expect(db.as(owner, (c) => c.query(`update documents set notes = 'שונה' where id = $1`, [id])))
      .rejects.toThrow(/FINALIZED_DOCUMENT/);
    await expect(db.as(owner, (c) => c.query('delete from documents where id = $1', [id])))
      .rejects.toThrow(/FINALIZED_DOCUMENT/);
    await expect(db.admin.query(`update documents set lines = '[]' where id = $1`, [id])).rejects.toThrow(/FINALIZED_DOCUMENT/);
    await expect(db.admin.query('delete from documents where id = $1', [id])).rejects.toThrow(/FINALIZED_DOCUMENT/);
  });

  it('does not let a client mark a draft issued without issue_document()', async () => {
    const { seriesId, customerId } = await seedOwner(db, owner);
    const id = await createDraft(db, owner, seriesId, customerId);
    await expect(db.as(owner, (c) => c.query(`update documents set status = 'issued', number = 7 where id = $1`, [id])))
      .rejects.toThrow(/permission denied/);
    await expect(db.admin.query(`update documents set status = 'issued', number = 7, issued_at = now(), total_agorot = 1 where id = $1`, [id]))
      .rejects.toThrow(/ISSUE_VIA_FUNCTION/);
  });

  it('allows editing and deleting drafts', async () => {
    const { seriesId, customerId } = await seedOwner(db, owner);
    const id = await createDraft(db, owner, seriesId, customerId);
    await db.as(owner, (c) => c.query(`update documents set notes = 'טיוטה מעודכנת' where id = $1`, [id]));
    await db.as(owner, (c) => c.query('delete from documents where id = $1', [id]));
    const r = await db.admin.query('select count(*)::int n from documents where id = $1', [id]);
    expect(r.rows[0].n).toBe(0);
  });

  it('keeps the audit log append-only', async () => {
    await expect(db.admin.query(`update audit_log set action = 'x'`)).rejects.toThrow(/AUDIT_APPEND_ONLY/);
    await expect(db.admin.query('delete from audit_log')).rejects.toThrow(/AUDIT_APPEND_ONLY/);
  });
});

describe('traceable correction', () => {
  it('cancels by issuing a linked cancellation document; the original content is unchanged', async () => {
    const { seriesId, customerId } = await seedOwner(db, owner);
    const id = await createDraft(db, owner, seriesId, customerId);
    const original = await issue(owner, id);
    const key = randomUUID();
    const cancel = (k = key) =>
      db.as(owner, async (c) => (await c.query('select * from cancel_document($1, $2, $3)', [id, 'סכום שגוי', k])).rows[0]);
    const [c1, c2] = await Promise.all([cancel(), cancel()]);
    expect(c1.id).toBe(c2.id);
    expect(c1.doc_type).toBe('cancellation');
    expect(c1.corrects_document_id).toBe(id);
    expect(Number(c1.total_agorot)).toBe(-Number(original.total_agorot));
    const after = (await db.admin.query('select * from documents where id = $1', [id])).rows[0];
    expect(after.status).toBe('cancelled');
    expect(after.cancelled_by_document_id).toBe(c1.id);
    expect(after.lines).toEqual(original.lines);
    expect(after.number).toBe(original.number);
    // a different key after cancellation returns the existing cancellation, not a second one
    const again = await cancel(randomUUID());
    expect(again.id).toBe(c1.id);
    const audit = await db.admin.query(`select details from audit_log where entity_id = $1 and action = 'document.cancelled'`, [id]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].details.reason).toBe('סכום שגוי');
  });

  it('requires a reason', async () => {
    const { seriesId, customerId } = await seedOwner(db, owner);
    const id = await createDraft(db, owner, seriesId, customerId);
    await issue(owner, id);
    await expect(db.as(owner, (c) => c.query('select cancel_document($1, $2, $3)', [id, ' ', randomUUID()])))
      .rejects.toThrow(/REASON_REQUIRED/);
  });
});

describe('VAT status rules and classification history', () => {
  it('blocks a tax invoice for an exempt dealer', async () => {
    const { seriesId, customerId } = await seedOwner(db, owner, { docType: 'tax_invoice' });
    const id = await createDraft(db, owner, seriesId, customerId, { docType: 'tax_invoice' });
    await expect(issue(owner, id)).rejects.toThrow(/EXEMPT_CANNOT_ISSUE_TAX_INVOICE/);
  });

  it('applies the VAT status in force on the issue date, not today', async () => {
    const u = newUser('history@example.test');
    await db.allow(u.email);
    const { seriesId, customerId } = await db.as(u, async (c) => {
      await c.query(`insert into business_profiles(legal_name, id_number, address) values ('א', '1', 'כתובת')`);
      await c.query(`insert into vat_status_periods(status, effective_from, effective_to) values ('exempt', '2025-01-01', '2026-06-30')`);
      await c.query(`insert into vat_status_periods(status, effective_from) values ('licensed', '2026-07-01')`);
      const cust = await c.query(`insert into customers(name, address) values ('ל', 'כ') returning id`);
      const s = await c.query(`insert into document_series(doc_type, name) values ('tax_invoice', 'מס') returning id`);
      return { customerId: cust.rows[0].id, seriesId: s.rows[0].id };
    });
    const before = await createDraft(db, u, seriesId, customerId, { docType: 'tax_invoice', issueDate: '2026-06-30' });
    await expect(issue(u, before)).rejects.toThrow(/EXEMPT_CANNOT_ISSUE_TAX_INVOICE/);
    const after = await createDraft(db, u, seriesId, customerId, { docType: 'tax_invoice', issueDate: '2026-07-01' });
    await expect(issue(u, after)).rejects.toThrow(/NOT_SUPPORTED_YET/); // licensed path deliberately not in M1
  });

  it('refuses to issue when the VAT status is unknown', async () => {
    const u = newUser('unknown@example.test');
    await db.allow(u.email);
    const ids = await db.as(u, async (c) => {
      await c.query(`insert into business_profiles(legal_name, id_number, address) values ('א', '1', 'כתובת')`);
      const cust = await c.query(`insert into customers(name, address) values ('ל', 'כ') returning id`);
      const s = await c.query(`insert into document_series(doc_type, name) values ('transaction_invoice', 'ע') returning id`);
      return { customerId: cust.rows[0].id, seriesId: s.rows[0].id };
    });
    const id = await createDraft(db, u, ids.seriesId, ids.customerId);
    await expect(issue(u, id)).rejects.toThrow(/VAT_STATUS_UNKNOWN/);
  });

  it('requires a payment method on a receipt', async () => {
    const { seriesId, customerId } = await seedOwner(db, owner, { docType: 'receipt' });
    const id = await createDraft(db, owner, seriesId, customerId, { docType: 'receipt' });
    await expect(issue(owner, id)).rejects.toThrow(/PAYMENT_METHOD_REQUIRED/);
    const ok = await createDraft(db, owner, seriesId, customerId, { docType: 'receipt', payment: { method: 'bank_transfer' } });
    expect((await issue(owner, ok)).status).toBe('issued');
  });
});

describe('access isolation', () => {
  it('a signed-in user who is not allow-listed sees and writes nothing', async () => {
    await seedOwner(db, owner);
    const seen = await db.as(intruder, async (c) => (await c.query('select count(*)::int n from documents')).rows[0].n);
    expect(seen).toBe(0);
    await expect(db.as(intruder, (c) => c.query(`insert into customers(name) values ('x')`))).rejects.toThrow(/row-level security/);
  });

  it("an allow-listed user cannot read or issue another owner's documents", async () => {
    const { seriesId, customerId } = await seedOwner(db, owner);
    const id = await createDraft(db, owner, seriesId, customerId);
    const seen = await db.as(second, async (c) => (await c.query('select count(*)::int n from documents where owner_id = $1', [owner.id])).rows[0].n);
    expect(seen).toBe(0);
    await expect(issue(second, id)).rejects.toThrow(/NOT_FOUND/);
    await expect(db.as(second, (c) => c.query('select * from cancel_document($1, $2, $3)', [id, 'x', randomUUID()])))
      .rejects.toThrow(/NOT_FOUND/);
  });

  it('anonymous callers cannot read tables or call functions', async () => {
    await expect(db.as(null, (c) => c.query('select * from documents'))).rejects.toThrow(/permission denied/);
    await expect(db.as(null, (c) => c.query('select issue_document($1)', [randomUUID()]))).rejects.toThrow(/permission denied/);
  });
});

describe('allow-list check for the UI', () => {
  it('reports whether the signed-in account is allowed', async () => {
    const yes = await db.as(owner, async (c) => (await c.query('select am_i_allowed() a')).rows[0].a);
    const no = await db.as(intruder, async (c) => (await c.query('select am_i_allowed() a')).rows[0].a);
    expect(yes).toBe(true);
    expect(no).toBe(false);
  });
});
