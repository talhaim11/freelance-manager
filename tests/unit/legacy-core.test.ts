import { describe, it, expect, beforeAll } from 'vitest';

type Core = Record<string, any>;
let C: Core;
beforeAll(async () => {
  await import('../../legacy/legacy-core.js');
  C = (globalThis as unknown as { LegacyCore: Core }).LegacyCore;
});

const inv = (id: number, number: number, extra: object = {}) =>
  ({ id, number, clientName: 'לקוח ' + id, date: '2026-02-01', items: [{ desc: 'x', qty: 1, price: 100 }], total: 100, ...extra });

describe('legacy esc()', () => {
  it('neutralises HTML and attribute injection', () => {
    expect(C.esc('<img src=x onerror="alert(1)">')).toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(C.esc("' `")).toBe('&#39; &#96;');
    expect(C.esc(null)).toBe('');
  });
});

describe('legacy localDateISO()', () => {
  it('uses the local calendar day, not UTC', () => {
    const justAfterMidnight = new Date(2026, 0, 2, 0, 30); // local time
    expect(C.localDateISO(justAfterMidnight)).toBe('2026-01-02');
  });
});

describe('legacy mergeData()', () => {
  it('keeps records that exist on only one side (no overwrite)', () => {
    const local = { invoices: [inv(2, 1)], expenses: [{ id: 5, desc: 'מקומי', amount: 10 }], nextInvoiceNum: 2 };
    const remote = { invoices: [inv(1, 1)], expenses: [], nextInvoiceNum: 2 };
    const r = C.mergeData(local, remote);
    expect(r.data.invoices.map((i: any) => i.id).sort()).toEqual([1, 2]);
    expect(r.data.expenses).toHaveLength(1);
    expect(r.addedFromLocal).toBe(2);
    expect(r.data.nextInvoiceNum).toBe(2);
    expect(C.nextNumber(r.data)).toBe(2);
  });
  it('preserves both versions when the same record was edited differently', () => {
    const local = { invoices: [inv(1, 1, { status: 'cancelled', cancelReason: 'טעות' })] };
    const remote = { invoices: [inv(1, 1)] };
    const r = C.mergeData(local, remote);
    expect(r.data.invoices).toHaveLength(1);
    expect(r.newConflicts).toHaveLength(1);
    expect(r.data.conflicts[0].local.status).toBe('cancelled');
    // merging again does not duplicate the conflict
    expect(C.mergeData(r.data, r.data).data.conflicts).toHaveLength(1);
  });
  it('never moves numbering backwards', () => {
    const r = C.mergeData({ invoices: [inv(1, 9)], nextInvoiceNum: 3 }, { invoices: [], nextInvoiceNum: 5 });
    expect(r.data.nextInvoiceNum).toBe(10);
  });
  it('fills an empty remote profile from local, and flags a real profile conflict', () => {
    const p = { name: 'שם', id: '1', business: '', address: '', phone: '', email: '' };
    expect(C.mergeData({ profile: p }, {}).data.profile.name).toBe('שם');
    const r = C.mergeData({ profile: p }, { profile: { ...p, name: 'אחר' } });
    expect(r.data.profile.name).toBe('אחר');
    expect(r.newConflicts[0].kind).toBe('profile');
  });
  it('content comparison ignores sync metadata', () => {
    expect(C.contentKey({ invoices: [inv(1, 1)], meta: { updatedAt: 'a' } }))
      .toBe(C.contentKey({ invoices: [inv(1, 1)], meta: { updatedAt: 'b' } }));
  });
});

describe('legacy audit manifest', () => {
  it('reports gaps, duplicates, cancelled items, totals and attachment hashes', async () => {
    const pdf = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4 synthetic').toString('base64');
    const data = {
      invoices: [inv(1, 1), inv(2, 3, { status: 'cancelled' }), inv(3, 3), inv(4, 5, { date: '2025-12-31' })],
      expenses: [
        { id: 10, desc: 'ציוד', amount: 50.5, date: '2026-01-05', receipt: { data: pdf, name: 'r.pdf', type: 'application/pdf' } },
        { id: 11, desc: 'נמחק', amount: 20, date: '2026-01-06', deletedAt: '2026-02-01' },
        { id: 12, desc: 'פגום', amount: 1, date: '2026-01-07', receipt: { data: 'not-a-data-url', name: 'x', type: '' } },
      ],
      nextInvoiceNum: 6,
    };
    const m = await C.buildManifest(data, 'test');
    expect(m.numbering).toEqual({ gaps: [2, 4], duplicates: [3] });
    expect(m.counts).toMatchObject({ invoices: 4, invoicesCancelled: 1, expenses: 3, expensesDeleted: 1, attachments: 2, invalidAttachments: 1 });
    expect(m.totalsByYear['2026']).toMatchObject({ invoices: 200, invoiceCount: 2, expenses: 51.5, expenseCount: 2 });
    expect(m.totalsByYear['2025']).toMatchObject({ invoices: 100, invoiceCount: 1 });
    expect(m.attachments[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(m.attachments[0].bytes).toBe('%PDF-1.4 synthetic'.length);
  });
});
