import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { TestDb, newUser, seedOwner, createDraft, type TestUser } from './harness';

const db = new TestDb();
const owner = newUser('pay-owner@example.test');
const second = newUser('pay-second@example.test');     // allow-listed, different owner
const intruder = newUser('pay-intruder@example.test'); // signed in, not allow-listed

beforeAll(async () => {
  await db.start();
  await db.allow(owner.email);
  await db.allow(second.email);
}, 180_000);
afterAll(async () => { await db.stop(); });

const issue = (u: TestUser, id: string) => db.as(u, async (c) => (await c.query('select * from issue_document($1)', [id])).rows[0]);
const cancel = (u: TestUser, id: string) =>
  db.as(u, async (c) => (await c.query('select * from cancel_document($1, $2, $3)', [id, 'בדיקה', randomUUID()])).rows[0]);
const balance = async (u: TestUser, invoiceId: string) =>
  db.as(u, async (c) => (await c.query('select paid_agorot::int paid, balance_agorot::int balance from invoice_balances where invoice_id = $1', [invoiceId])).rows[0]);

/** An issued invoice of `amount` agorot plus a receipt series, for one customer. */
async function invoiceFor(u: TestUser, amount: number) {
  const { seriesId, customerId } = await seedOwner(db, u);
  const invId = await createDraft(db, u, seriesId, customerId, { lines: [{ description: 'שירות', quantity: 1, unit_price_agorot: amount }] });
  await issue(u, invId);
  const receiptSeries = await db.as(u, async (c) => (await c.query(
    `insert into document_series(doc_type, name, next_number) values ('receipt', $1, 1) returning id`, ['קבלות-' + randomUUID().slice(0, 8)])).rows[0].id as string);
  return { invId, customerId, receiptSeries };
}

async function receiptDraft(u: TestUser, seriesId: string, customerId: string, amount: number, allocations: unknown, docType = 'receipt') {
  return db.as(u, async (c) => (await c.query(
    `insert into documents(idempotency_key, series_id, doc_type, issue_date, customer_id, lines, payment_details, allocations)
     values ($1, $2, $3, '2026-11-06', $4, $5, '{"method":"bank_transfer"}', $6) returning id`,
    [randomUUID(), seriesId, docType, customerId, JSON.stringify([{ description: 'תשלום', quantity: 1, unit_price_agorot: amount }]),
      JSON.stringify(allocations)])).rows[0].id as string);
}

describe('partial payments and allocation', () => {
  it('two partial payments close an invoice; a third cannot over-pay it and takes no number', async () => {
    const { invId, customerId, receiptSeries } = await invoiceFor(owner, 30000);
    const r1 = await receiptDraft(owner, receiptSeries, customerId, 10000, [{ invoice_id: invId, amount_agorot: 10000 }]);
    expect((await issue(owner, r1)).number).toBe(1);
    expect(await balance(owner, invId)).toEqual({ paid: 10000, balance: 20000 });

    const r2 = await receiptDraft(owner, receiptSeries, customerId, 20000, [{ invoice_id: invId, amount_agorot: 20000 }]);
    await issue(owner, r2);
    expect(await balance(owner, invId)).toEqual({ paid: 30000, balance: 0 });

    const r3 = await receiptDraft(owner, receiptSeries, customerId, 100, [{ invoice_id: invId, amount_agorot: 100 }]);
    await expect(issue(owner, r3)).rejects.toThrow(/ALLOCATION_EXCEEDS_BALANCE/);
    const after = await db.admin.query('select status, number from documents where id = $1', [r3]);
    expect(after.rows[0]).toEqual({ status: 'draft', number: null });
    const s = await db.admin.query('select next_number from document_series where id = $1', [receiptSeries]);
    expect(s.rows[0].next_number).toBe(3);
  });

  it('one receipt pays two invoices; the unallocated rest stays as the customer’s credit', async () => {
    const a = await invoiceFor(owner, 5000);
    const inv2 = await createDraft(db, owner, (await db.admin.query('select series_id from documents where id = $1', [a.invId])).rows[0].series_id,
      a.customerId, { lines: [{ description: 'שירות 2', quantity: 1, unit_price_agorot: 7000 }] });
    await issue(owner, inv2);
    const r = await receiptDraft(owner, a.receiptSeries, a.customerId, 15000,
      [{ invoice_id: a.invId, amount_agorot: 5000 }, { invoice_id: inv2, amount_agorot: 7000 }]);
    await issue(owner, r);
    expect((await balance(owner, a.invId)).balance).toBe(0);
    expect((await balance(owner, inv2)).balance).toBe(0);
    const rows = await db.admin.query('select sum(amount_agorot)::int s from payment_allocations where receipt_id = $1', [r]);
    expect(rows.rows[0].s).toBe(12000); // 3,000 of 15,000 unallocated
  });

  it('allocating more than the receipt total is rejected', async () => {
    const { invId, customerId, receiptSeries } = await invoiceFor(owner, 50000);
    const r = await receiptDraft(owner, receiptSeries, customerId, 1000, [{ invoice_id: invId, amount_agorot: 2000 }]);
    await expect(issue(owner, r)).rejects.toThrow(/ALLOCATION_EXCEEDS_RECEIPT/);
  });

  it('10 receipts paying the full balance of one invoice at the same moment: exactly one succeeds', async () => {
    const { invId, customerId, receiptSeries } = await invoiceFor(owner, 40000);
    // Two receipt series, so the series lock alone cannot serialize them: the invoice lock must.
    const otherSeries = await db.as(owner, async (c) => (await c.query(
      `insert into document_series(doc_type, name, next_number) values ('receipt', $1, 1) returning id`, ['קבלות-ב-' + randomUUID().slice(0, 8)])).rows[0].id as string);
    const drafts = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      receiptDraft(owner, i % 2 ? otherSeries : receiptSeries, customerId, 40000, [{ invoice_id: invId, amount_agorot: 40000 }])));
    const results = await Promise.allSettled(drafts.map((id) => issue(owner, id)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((x) => x.status === 'rejected')) expect(String((r as PromiseRejectedResult).reason)).toMatch(/ALLOCATION_EXCEEDS_BALANCE/);
    expect(await balance(owner, invId)).toEqual({ paid: 40000, balance: 0 });
    const s = await db.admin.query('select sum(next_number)::int n from document_series where id = any($1)', [[receiptSeries, otherSeries]]);
    expect(s.rows[0].n).toBe(3); // one number taken in total
  }, 60_000);

  it('a second device paying the same invoice waits for the first and then sees it paid (row lock, deterministic)', async () => {
    const { invId, customerId, receiptSeries } = await invoiceFor(owner, 25000);
    const otherSeries = await db.as(owner, async (c) => (await c.query(
      `insert into document_series(doc_type, name, next_number) values ('receipt', $1, 1) returning id`, ['קבלות-ג-' + randomUUID().slice(0, 8)])).rows[0].id as string);
    const a = await receiptDraft(owner, receiptSeries, customerId, 25000, [{ invoice_id: invId, amount_agorot: 25000 }]);
    const b = await receiptDraft(owner, otherSeries, customerId, 25000, [{ invoice_id: invId, amount_agorot: 25000 }]);
    const session = async () => {
      const c = await db.admin.connect();
      await c.query('begin');
      await c.query('set local role authenticated');
      await c.query("select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)",
        [owner.id, JSON.stringify({ sub: owner.id, email: owner.email, role: 'authenticated' })]);
      return c;
    };
    const c1 = await session();
    const c2 = await session();
    try {
      await c1.query('select issue_document($1)', [a]);          // first device: issued, not yet committed
      let settled = false;
      const second = c2.query('select issue_document($1)', [b]).then((r) => { settled = true; return r; }, (e) => { settled = true; throw e; });
      second.catch(() => {});
      await new Promise((r) => setTimeout(r, 400));
      expect(settled).toBe(false);                                // must wait for the first device's lock
      await c1.query('commit');
      await expect(second).rejects.toThrow(/ALLOCATION_EXCEEDS_BALANCE/);
      await c2.query('rollback');
    } finally {
      c1.release(); c2.release();
    }
    expect(await balance(owner, invId)).toEqual({ paid: 25000, balance: 0 });
  });

  it('rejects allocations to another customer, a draft, a cancelled invoice, a duplicate or a non-receipt', async () => {
    const { invId, customerId, receiptSeries } = await invoiceFor(owner, 9000);
    const other = await db.as(owner, async (c) => (await c.query(`insert into customers(name, address) values ('לקוח אחר', 'כתובת') returning id`)).rows[0].id);
    const wrongCustomer = await receiptDraft(owner, receiptSeries, other, 100, [{ invoice_id: invId, amount_agorot: 100 }]);
    await expect(issue(owner, wrongCustomer)).rejects.toThrow(/ALLOCATION_INVALID/);

    const seriesOfInv = (await db.admin.query('select series_id from documents where id = $1', [invId])).rows[0].series_id;
    const draftInv = await createDraft(db, owner, seriesOfInv, customerId);
    const toDraft = await receiptDraft(owner, receiptSeries, customerId, 100, [{ invoice_id: draftInv, amount_agorot: 100 }]);
    await expect(issue(owner, toDraft)).rejects.toThrow(/ALLOCATION_INVALID/);

    const dup = await receiptDraft(owner, receiptSeries, customerId, 300,
      [{ invoice_id: invId, amount_agorot: 100 }, { invoice_id: invId, amount_agorot: 100 }]);
    await expect(issue(owner, dup)).rejects.toThrow(/ALLOCATION_INVALID/);

    const negative = await receiptDraft(owner, receiptSeries, customerId, 300, [{ invoice_id: invId, amount_agorot: -100 }]);
    await expect(issue(owner, negative)).rejects.toThrow(/ALLOCATION_INVALID/);

    const malformed = await receiptDraft(owner, receiptSeries, customerId, 300, [{ invoice_id: 'not-a-uuid', amount_agorot: 100 }]);
    await expect(issue(owner, malformed)).rejects.toThrow(/ALLOCATION_INVALID/);

    const asInvoice = await createDraft(db, owner, seriesOfInv, customerId);
    await db.as(owner, (c) => c.query(`update documents set allocations = $2 where id = $1`, [asInvoice, JSON.stringify([{ invoice_id: invId, amount_agorot: 100 }])]));
    await expect(issue(owner, asInvoice)).rejects.toThrow(/ALLOCATION_INVALID/);

    const inv2 = await createDraft(db, owner, seriesOfInv, customerId);
    await issue(owner, inv2);
    await cancel(owner, inv2);
    const toCancelled = await receiptDraft(owner, receiptSeries, customerId, 100, [{ invoice_id: inv2, amount_agorot: 100 }]);
    await expect(issue(owner, toCancelled)).rejects.toThrow(/ALLOCATION_INVALID/);
  });

  it('cannot pay another user’s invoice', async () => {
    const theirs = await invoiceFor(second, 5000);
    const mine = await invoiceFor(owner, 5000);
    const r = await receiptDraft(owner, mine.receiptSeries, mine.customerId, 100, [{ invoice_id: theirs.invId, amount_agorot: 100 }]);
    await expect(issue(owner, r)).rejects.toThrow(/ALLOCATION_INVALID/);
  });

  it('cancelling a receipt reopens the balance; a paid invoice cannot be cancelled until its receipts are', async () => {
    const { invId, customerId, receiptSeries } = await invoiceFor(owner, 12000);
    const r = await receiptDraft(owner, receiptSeries, customerId, 12000, [{ invoice_id: invId, amount_agorot: 12000 }]);
    await issue(owner, r);
    await expect(cancel(owner, invId)).rejects.toThrow(/INVOICE_HAS_PAYMENTS/);
    await cancel(owner, r);
    expect(await balance(owner, invId)).toEqual({ paid: 0, balance: 12000 });
    const kept = await db.admin.query('select count(*)::int n from payment_allocations where receipt_id = $1', [r]);
    expect(kept.rows[0].n).toBe(1); // the history stays; it simply no longer counts
    await expect(cancel(owner, invId)).resolves.toBeTruthy();
  });

  it('recorded allocations are immutable and cannot be written by the client', async () => {
    const { invId, customerId, receiptSeries } = await invoiceFor(owner, 8000);
    const r = await receiptDraft(owner, receiptSeries, customerId, 8000, [{ invoice_id: invId, amount_agorot: 8000 }]);
    await issue(owner, r);
    await expect(db.as(owner, (c) => c.query('update payment_allocations set amount_agorot = 1 where receipt_id = $1', [r]))).rejects.toThrow(/permission denied/);
    await expect(db.as(owner, (c) => c.query('delete from payment_allocations where receipt_id = $1', [r]))).rejects.toThrow(/permission denied/);
    await expect(db.as(owner, (c) => c.query(
      `insert into payment_allocations(owner_id, receipt_id, invoice_id, amount_agorot) values ($1, $2, $3, 1)`, [owner.id, r, invId]))).rejects.toThrow(/permission denied/);
    await expect(db.admin.query('update payment_allocations set amount_agorot = 1 where receipt_id = $1', [r])).rejects.toThrow(/ALLOCATION_IMMUTABLE/);
    // and the issued receipt's planned allocations cannot be edited either
    await expect(db.as(owner, (c) => c.query(`update documents set allocations = '[]' where id = $1`, [r]))).rejects.toThrow(/FINALIZED_DOCUMENT/);
  });

  it('balances and allocations are invisible to other users and to non-allow-listed accounts', async () => {
    const { invId, customerId, receiptSeries } = await invoiceFor(owner, 6000);
    const r = await receiptDraft(owner, receiptSeries, customerId, 6000, [{ invoice_id: invId, amount_agorot: 6000 }]);
    await issue(owner, r);
    for (const u of [second, intruder]) {
      const seen = await db.as(u, async (c) => ({
        bal: (await c.query('select * from invoice_balances where invoice_id = $1', [invId])).rowCount,
        alloc: (await c.query('select * from payment_allocations where receipt_id = $1', [r])).rowCount,
      }));
      expect(seen).toEqual({ bal: 0, alloc: 0 });
    }
    await expect(db.as(null, (c) => c.query('select * from invoice_balances'))).rejects.toThrow(/permission denied/);
    await expect(db.as(null, (c) => c.query('select * from payment_allocations'))).rejects.toThrow(/permission denied/);
  });
});

describe('customers', () => {
  it('a repeated creation with the same client key is a conflict, not a second customer', async () => {
    const key = randomUUID();
    const add = () => db.as(owner, (c) => c.query(`insert into customers(name, client_key) values ('לקוח פעם אחת', $1) on conflict (client_key) do nothing`, [key]));
    await add(); await add();
    const n = await db.admin.query('select count(*)::int n from customers where client_key = $1', [key]);
    expect(n.rows[0].n).toBe(1);
  });
});

describe('expenses and attachments', () => {
  const addExpense = (u: TestUser, over: Record<string, unknown> = {}) => db.as(u, async (c) => (await c.query(
    `insert into expenses(client_key, supplier, doc_date, amount_agorot, vat_agorot, category)
     values ($1, $2, $3, $4, $5, 'software') returning id`,
    [over.key ?? randomUUID(), over.supplier ?? 'ספק סינתטי', over.date ?? '2026-11-01', over.amount ?? 11800, over.vat ?? 1800])).rows[0].id as string);
  const sha = 'a'.repeat(64);
  const addAttachment = (u: TestUser, expenseId: string, path: string, id = randomUUID()) => db.as(u, (c) => c.query(
    `insert into expense_attachments(id, expense_id, storage_path, sha256, mime_type, size_bytes, original_name)
     values ($1, $2, $3, $4, 'image/png', 1234, 'קבלה.png')`, [id, expenseId, path, sha]));

  it('owner creates, edits and reads an expense; the client key prevents duplicates', async () => {
    const key = randomUUID();
    const id = await addExpense(owner, { key });
    await expect(addExpense(owner, { key })).rejects.toThrow(/duplicate key/);
    await db.as(owner, (c) => c.query(`update expenses set status = 'confirmed', business_use_pct = 50 where id = $1`, [id]));
    const row = await db.as(owner, async (c) => (await c.query('select status, business_use_pct, deductible_status, owner_id from expenses where id = $1', [id])).rows[0]);
    expect(row).toEqual({ status: 'confirmed', business_use_pct: 50, deductible_status: 'undetermined', owner_id: owner.id });
  });

  it('rejects invalid amounts and cannot set tax treatment or owner from the client', async () => {
    await expect(addExpense(owner, { amount: 0 })).rejects.toThrow(/check constraint/);
    await expect(addExpense(owner, { amount: 100, vat: 200 })).rejects.toThrow(/check constraint/);
    await expect(addExpense(owner, { supplier: '  ' })).rejects.toThrow(/check constraint/);
    const id = await addExpense(owner);
    await expect(db.as(owner, (c) => c.query(`update expenses set deductible_status = 'deductible' where id = $1`, [id]))).rejects.toThrow(/permission denied/);
    await expect(db.as(owner, (c) => c.query(`update expenses set owner_id = $2 where id = $1`, [id, second.id]))).rejects.toThrow(/permission denied/);
  });

  it('other users and non-allow-listed accounts cannot see, add or change expenses', async () => {
    const id = await addExpense(owner);
    expect(await db.as(second, async (c) => (await c.query('select * from expenses where id = $1', [id])).rowCount)).toBe(0);
    expect(await db.as(second, async (c) => (await c.query(`update expenses set supplier = 'x' where id = $1`, [id])).rowCount)).toBe(0);
    expect(await db.as(intruder, async (c) => (await c.query('select * from expenses')).rowCount)).toBe(0);
    await expect(addExpense(intruder)).rejects.toThrow(/row-level security/);
    await expect(db.as(null, (c) => c.query('select * from expenses'))).rejects.toThrow(/permission denied/);
  });

  it('attachments: only under the owner’s own folder, only on the owner’s expense, and never changed or removed', async () => {
    const id = await addExpense(owner);
    const attId = randomUUID();
    await addAttachment(owner, id, `${owner.id}/${attId}.png`, attId);
    await expect(addAttachment(owner, id, `${second.id}/${randomUUID()}.png`)).rejects.toThrow(/check constraint/);
    const theirs = await addExpense(second);
    await expect(addAttachment(owner, theirs, `${owner.id}/${randomUUID()}.png`)).rejects.toThrow(/row-level security/);
    await expect(db.as(owner, (c) => c.query(`update expense_attachments set original_name = 'x' where id = $1`, [attId]))).rejects.toThrow(/permission denied/);
    await expect(db.as(owner, (c) => c.query('delete from expense_attachments where id = $1', [attId]))).rejects.toThrow(/permission denied/);
    await expect(db.admin.query('delete from expense_attachments where id = $1', [attId])).rejects.toThrow(/ATTACHMENT_IMMUTABLE/);
    expect(await db.as(second, async (c) => (await c.query('select * from expense_attachments where id = $1', [attId])).rowCount)).toBe(0);
    // a retry with the same attachment id inserts nothing new
    await db.as(owner, (c) => c.query(
      `insert into expense_attachments(id, expense_id, storage_path, sha256, mime_type, size_bytes) values ($1, $2, $3, $4, 'image/png', 1234) on conflict (id) do nothing`,
      [attId, id, `${owner.id}/${attId}.png`, sha]));
    const n = await db.admin.query('select count(*)::int n from expense_attachments where expense_id = $1', [id]);
    expect(n.rows[0].n).toBe(1);
  });
});
