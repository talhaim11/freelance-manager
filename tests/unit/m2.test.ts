import { describe, it, expect } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { allocationProblems, autoAllocate, type InvoiceBalance } from '../../app/src/domain/payments';
import { attachmentProblem, expenseProblems, possibleDuplicates } from '../../app/src/domain/expenses';
import { sha256Fallback, sha256Hex } from '../../app/src/lib/sha256';
import { DemoRepo } from '../../app/src/data/demoRepo';
import { errorCode } from '../../app/src/domain/errors';

const bal = (id: string, balance: number, date = '2026-01-01', customer = 'c1', number = 1): InvoiceBalance =>
  ({ invoice_id: id, customer_id: customer, number, issue_date: date, total_agorot: balance, paid_agorot: 0, balance_agorot: balance });

describe('allocation rules', () => {
  const balances = [bal('a', 10000, '2026-01-01', 'c1', 1), bal('b', 5000, '2026-02-01', 'c1', 2), bal('x', 7000, '2026-01-01', 'c2', 3)];
  it('accepts partial and multi-invoice allocations within the receipt total', () => {
    expect(allocationProblems(12000, 'c1', [{ invoice_id: 'a', amount_agorot: 7000 }, { invoice_id: 'b', amount_agorot: 5000 }], balances)).toEqual([]);
  });
  it('flags over-paying an invoice, exceeding the receipt, another customer, duplicates and non-positive amounts', () => {
    expect(allocationProblems(20000, 'c1', [{ invoice_id: 'a', amount_agorot: 10001 }], balances)).toEqual(['ALLOCATION_EXCEEDS_BALANCE']);
    expect(allocationProblems(100, 'c1', [{ invoice_id: 'a', amount_agorot: 200 }], balances)).toEqual(['ALLOCATION_EXCEEDS_RECEIPT']);
    expect(allocationProblems(9000, 'c1', [{ invoice_id: 'x', amount_agorot: 100 }], balances)).toEqual(['ALLOCATION_INVALID']);
    expect(allocationProblems(9000, 'c1', [{ invoice_id: 'a', amount_agorot: 100 }, { invoice_id: 'a', amount_agorot: 100 }], balances)).toContain('ALLOCATION_INVALID');
    expect(allocationProblems(9000, 'c1', [{ invoice_id: 'a', amount_agorot: 0 }], balances)).toEqual(['ALLOCATION_INVALID']);
    expect(allocationProblems(9000, 'c1', [{ invoice_id: 'gone', amount_agorot: 10 }], balances)).toEqual(['ALLOCATION_INVALID']);
  });
  it('auto-allocation pays the oldest invoices first and never more than received', () => {
    expect(autoAllocate(12000, balances.filter((b) => b.customer_id === 'c1'))).toEqual([
      { invoice_id: 'a', amount_agorot: 10000 }, { invoice_id: 'b', amount_agorot: 2000 }]);
    expect(autoAllocate(30000, [bal('b', 5000, '2026-02-01'), bal('a', 10000, '2026-01-01')]).map((a) => a.invoice_id)).toEqual(['a', 'b']);
    expect(autoAllocate(0, balances)).toEqual([]);
  });
});

describe('expenses', () => {
  const ok = { supplier: 'ספק', doc_date: '2026-11-01', amount_agorot: 10000, vat_agorot: 0, business_use_pct: 100 };
  it('validates required fields and amounts', () => {
    expect(expenseProblems(ok)).toEqual({});
    expect(Object.keys(expenseProblems({ ...ok, supplier: ' ', amount_agorot: null, doc_date: '' })).sort()).toEqual(['amount', 'doc_date', 'supplier']);
    expect(expenseProblems({ ...ok, vat_agorot: 20000 }).vat).toBeTruthy();
    expect(expenseProblems({ ...ok, business_use_pct: 101 }).business_use_pct).toBeTruthy();
  });
  it('accepts only images and PDFs up to 10MB', () => {
    expect(attachmentProblem({ type: 'image/jpeg', size: 1000 })).toBeNull();
    expect(attachmentProblem({ type: 'application/pdf', size: 10 * 1024 * 1024 })).toBeNull();
    expect(attachmentProblem({ type: 'text/html', size: 10 })).toBeTruthy();
    expect(attachmentProblem({ type: 'image/png', size: 10 * 1024 * 1024 + 1 })).toBeTruthy();
  });
  it('warns about duplicates: same supplier and document number, or same amount within 3 days', () => {
    const list = [
      { id: '1', supplier: 'חברת  חשמל', doc_number: 'A-17', doc_date: '2026-10-01', amount_agorot: 5000 },
      { id: '2', supplier: 'ספק אחר', doc_number: '', doc_date: '2026-10-02', amount_agorot: 9900 },
    ];
    expect(possibleDuplicates({ supplier: 'חברת חשמל', doc_number: 'A-17', doc_date: '2026-11-20', amount_agorot: 1 }, list).map((x) => x.id)).toEqual(['1']);
    expect(possibleDuplicates({ supplier: 'ספק אחר', doc_number: '', doc_date: '2026-10-05', amount_agorot: 9900 }, list).map((x) => x.id)).toEqual(['2']);
    expect(possibleDuplicates({ supplier: 'ספק אחר', doc_number: '', doc_date: '2026-10-06', amount_agorot: 9900 }, list)).toEqual([]);
    expect(possibleDuplicates({ id: '2', supplier: 'ספק אחר', doc_number: '', doc_date: '2026-10-02', amount_agorot: 9900 }, list)).toEqual([]);
  });
});

describe('sha256 (also without Web Crypto, as on a phone over plain http)', () => {
  it('matches Node for known vectors and block-boundary sizes', async () => {
    expect(sha256Fallback(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 1000, 100_003]) {
      const data = new Uint8Array(randomBytes(n));
      const expected = createHash('sha256').update(data).digest('hex');
      expect(sha256Fallback(data)).toBe(expected);
      expect(await sha256Hex(data)).toBe(expected);
    }
  });
});

class MemStorage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  clear() { this.m.clear(); }
  getItem(k: string) { return this.m.get(k) ?? null; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  removeItem(k: string) { this.m.delete(k); }
  setItem(k: string, v: string) { this.m.set(k, v); }
}

describe('demo repository: same payment rules as the database', () => {
  const setup = async () => {
    const repo = new DemoRepo(new MemStorage() as unknown as Storage);
    const series = await repo.listSeries();
    const inv = series.find((s) => s.doc_type === 'transaction_invoice')!;
    const rec = series.find((s) => s.doc_type === 'receipt')!;
    const customer = (await repo.listCustomers())[0];
    const draft = await repo.createDraft({ idempotency_key: crypto.randomUUID(), series_id: inv.id, doc_type: 'transaction_invoice', issue_date: '2026-11-01',
      customer_id: customer.id, lines: [{ description: 'שירות', quantity: 1, unit_price_agorot: 30000 }], notes: '', payment_details: {}, allocations: [] });
    const invoice = await repo.issueDocument(draft.id);
    const receipt = async (amount: number, alloc: number) => {
      const d = await repo.createDraft({ idempotency_key: crypto.randomUUID(), series_id: rec.id, doc_type: 'receipt', issue_date: '2026-11-02',
        customer_id: customer.id, lines: [{ description: 'תשלום', quantity: 1, unit_price_agorot: amount }], notes: '',
        payment_details: { method: 'cash' }, allocations: [{ invoice_id: invoice.id, amount_agorot: alloc }] });
      return repo.issueDocument(d.id);
    };
    return { repo, invoice, receipt };
  };

  it('partial payments, over-payment refused, cancel order enforced', async () => {
    const { repo, invoice, receipt } = await setup();
    const r1 = await receipt(10000, 10000);
    expect((await repo.listInvoiceBalances())[0].balance_agorot).toBe(20000);
    await expect(receipt(25000, 25000)).rejects.toSatisfy((e: unknown) => errorCode(e) === 'ALLOCATION_EXCEEDS_BALANCE');
    await expect(repo.cancelDocument(invoice.id, 'בדיקה', crypto.randomUUID())).rejects.toSatisfy((e: unknown) => errorCode(e) === 'INVOICE_HAS_PAYMENTS');
    await repo.cancelDocument(r1.id, 'בדיקה', crypto.randomUUID());
    expect((await repo.listInvoiceBalances())[0].balance_agorot).toBe(30000);
    expect(await repo.listAllocationsFor(invoice.id)).toHaveLength(1);
  });

  it('customer and expense creation are idempotent; demo attachments stay in the browser', async () => {
    const { repo } = await setup();
    const key = crypto.randomUUID();
    const [a, b] = await Promise.all([repo.addCustomer({ name: 'פעם אחת', tax_id: '', address: '', email: '', phone: '' }, key),
      repo.addCustomer({ name: 'פעם אחת', tax_id: '', address: '', email: '', phone: '' }, key)]);
    expect(a.id).toBe(b.id);
    const input = { client_key: crypto.randomUUID(), supplier: 'ספק', supplier_tax_id: '', doc_number: '', doc_date: '2026-11-01', amount_agorot: 500,
      vat_agorot: 0, category: 'other', business_use_pct: 100, status: 'needs_review' as const, notes: '' };
    const e1 = await repo.saveExpense(input);
    const e2 = await repo.saveExpense(input);
    expect(e1.id).toBe(e2.id);
    const file = { id: crypto.randomUUID(), bytes: new Uint8Array([1, 2, 3]), sha256: 'f'.repeat(64), mime_type: 'image/png', original_name: 'x.png' };
    await repo.addExpenseAttachment(e1.id, file);
    await repo.addExpenseAttachment(e1.id, file);
    const [saved] = await repo.listExpenses();
    expect(saved.attachments).toHaveLength(1);
    expect(await repo.attachmentUrl(saved.attachments[0])).toBe('data:image/png;base64,AQID');
  });
});

import { yearSummary } from '../../app/src/domain/dashboard';
describe('dashboard totals never double count', () => {
  const d = (id: string, doc_type: string, status: string, total: number, date = '2026-05-01') =>
    ({ id, doc_type, status, total_agorot: total, issue_date: date } as unknown as import('../../app/src/data/types').Doc);
  it('invoice + its receipts are one income, shown in two separate views; cancellations excluded', () => {
    const docs = [d('i1', 'transaction_invoice', 'issued', 100000), d('r1', 'receipt', 'issued', 60000), d('r2', 'receipt', 'cancelled', 40000),
      d('c1', 'cancellation', 'issued', -40000), d('i2', 'transaction_invoice', 'issued', 5000, '2025-12-31'), d('r3', 'receipt', 'issued', 5000, '2026-01-02')];
    const s = yearSummary(docs, [{ receipt_id: 'r1', invoice_id: 'i1', amount_agorot: 60000 }, { receipt_id: 'r2', invoice_id: 'i1', amount_agorot: 40000 }], 2026);
    expect(s.invoiced).toBe(100000);
    expect(s.received).toBe(65000);                 // r1 + r3 (cash basis, by receipt date); r2 cancelled
    expect(s.receivedAgainstInvoices).toBe(60000);  // cancelled r2's allocation no longer counts
    expect(s.excludedCancelled).toBe(1);
  });
});
