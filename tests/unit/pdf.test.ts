import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { renderDocumentPdf, visual, type PdfFonts } from '../../app/src/lib/pdf';
import type { Doc } from '../../app/src/data/types';

let fonts: PdfFonts;
beforeAll(() => {
  fonts = { regular: new Uint8Array(readFileSync('app/public/fonts/Alef-Regular.ttf')), bold: new Uint8Array(readFileSync('app/public/fonts/Alef-Bold.ttf')) };
});

const issuer = { legal_name: 'ישראלה ישראלי', business_name: 'סטודיו לדוגמה', id_number: '000000018', address: 'רחוב הבדיקה 1, תל אביב', phone: '050-0000000', email: 'demo@example.com' };
const doc = (over: Partial<Doc> = {}): Doc => ({
  id: 'd', idempotency_key: 'k', series_id: 's', doc_type: 'receipt', status: 'issued', number: 12, issue_date: '2026-11-06', customer_id: 'c',
  lines: [{ description: 'ייעוץ (שעתיים) לפרויקט ABC-7', quantity: 2, unit_price_agorot: 61725 }], notes: 'תודה!', payment_details: { method: 'bank_transfer', reference: 'TX-991' },
  allocations: [], customer_snapshot: { name: 'לקוח בע"מ', tax_id: '512345678', address: 'שדרות הדוגמה 5', email: '', phone: '' }, issuer_snapshot: issuer,
  subtotal_agorot: 123450, vat_agorot: 0, total_agorot: 123450, vat_status_at_issue: 'exempt', corrects_document_id: null, correction_reason: null,
  cancelled_by_document_id: null, issued_at: '2026-11-06T10:00:00Z', cancelled_at: null, created_at: '2026-11-06T09:00:00Z', ...over,
});

const MIRROR: Record<string, string> = { '(': ')', ')': '(', '[': ']', ']': '[', '<': '>', '>': '<', '{': '}', '}': '{' };
/**
 * Extracted text in logical order, the way a viewer's RTL text layer presents it: each drawn run is
 * one item, and a right-to-left run (drawn reversed) is read back reversed. Numbers and Latin runs are
 * returned exactly as drawn, so a reversed "12" or "1,234.50" would fail these tests.
 */
async function textOf(bytes: Uint8Array): Promise<string[]> {
  const pdf = await getDocument({ data: bytes.slice(), useSystemFonts: false, isEvalSupported: false }).promise;
  const out: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const c = await (await pdf.getPage(i)).getTextContent();
    for (const it of c.items) {
      if (!('str' in it)) continue;
      const rtl = /[\u0590-\u05FF]/.test(it.str);
      out.push(rtl ? [...it.str].reverse().map((ch) => MIRROR[ch] ?? ch).join('') : it.str);
    }
  }
  return out;
}

describe('bidi layout for drawing', () => {
  it('reverses Hebrew runs but keeps numbers, amounts and Latin text in reading order', () => {
    expect(visual('קבלה מס\' 12')).toBe('12 \'סמ הלבק');
    expect(visual('סכום: ₪1,234.50')).toContain('1,234.50');
    expect(visual('פרויקט ABC-7')).toBe('ABC-7 טקיורפ');
    expect(visual('(שעתיים)')).toBe('(םייתעש)');          // brackets stay visually correct
    expect(visual('Plain English 123')).toBe('Plain English 123');
  });
});

describe('document PDF', () => {
  it('embeds the Hebrew font, shows the right marking and the amounts; an exempt dealer never gets "חשבונית מס"', async () => {
    const bytes = await renderDocumentPdf({ doc: doc(), related: null, issuer, customer: doc().customer_snapshot,
      paidInvoices: [{ number: 7, amount_agorot: 123450 }], marking: 'original', generatedAt: new Date('2026-11-06T10:00:00Z') }, fonts);
    mkdirSync('test-results', { recursive: true });
    writeFileSync('test-results/receipt-original.pdf', bytes);
    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getPageCount()).toBe(1);
    expect(loaded.getTitle()).toBe("קבלה מס' 12");
    // pdf.js drops spaces at run boundaries, so compare without whitespace.
    const ns = (x: string) => x.replace(/\s+/g, '');
    const text = ns((await textOf(bytes)).join(''));
    for (const expected of ['מקור', "קבלה מס' 12", 'תאריך: 06/11/2026', '1,234.50', '617.25', 'אסמכתה TX-991', 'ת.ז./מס\' עוסק: 000000018',
      'ייעוץ (שעתיים) לפרויקט ABC-7', 'עוסק פטור — עסקאותיו פטורות ממע"מ לפי סעיף 31', "חשבונית עסקה מס' 7"]) {
      expect(text, expected).toContain(ns(expected));
    }
    expect(text).not.toContain('חשבונית מס ');
    expect(text).not.toMatch(/חשבונית מס($|[^'])/);
  });

  it('later outputs are marked as a copy; drafts as not issued; long documents get more pages', async () => {
    const copy = await textOf(await renderDocumentPdf({ doc: doc(), related: null, issuer, customer: null, paidInvoices: [], marking: 'copy' }, fonts));
    expect(copy.join('')).toContain('העתק נאמן למקור');
    expect(copy.join('')).not.toMatch(/(^|[^ל])מקור/);
    const draft = await textOf(await renderDocumentPdf({ doc: doc({ status: 'draft', number: null }), related: null, issuer, customer: null, paidInvoices: [], marking: 'draft' }, fonts));
    expect(draft.join('')).toContain('טיוטה — לא הופק');
    const many = Array.from({ length: 60 }, (_, i) => ({ description: `שורה ${i + 1} עם תיאור ארוך שנמשך ונמשך כדי לבדוק גלישה לשורה נוספת בטבלה`, quantity: 1, unit_price_agorot: 100 }));
    const long = await renderDocumentPdf({ doc: doc({ doc_type: 'transaction_invoice', lines: many, total_agorot: 6000 }), related: null, issuer, customer: null, paidInvoices: [], marking: 'original' }, fonts);
    writeFileSync('test-results/invoice-long.pdf', long);
    const p = await PDFDocument.load(long);
    expect(p.getPageCount()).toBeGreaterThan(1);
    expect((await textOf(long)).join('').replace(/\s+/g, '')).toContain(`עמוד${p.getPageCount()}מתוך${p.getPageCount()}`);
  });
});

describe('right-to-left placement', () => {
  it('numbers inside a Hebrew line sit at its left end, as in the HTML view', async () => {
    const bytes = await renderDocumentPdf({ doc: doc(), related: null, issuer, customer: null, paidInvoices: [], marking: 'original' }, fonts);
    const pdf = await getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
    const items = (await (await pdf.getPage(1)).getTextContent()).items.filter((i) => 'str' in i) as { str: string; transform: number[] }[];
    const x = (s: string) => items.find((i) => i.str === s)!.transform[4];
    expect(x('12')).toBeLessThan(x("'סמ הלבק"));               // "קבלה מס' 12": number on the left
    expect(x('06/11/2026')).toBeLessThan(x(':ךיראת'));         // "תאריך: 06/11/2026"
  });
});
