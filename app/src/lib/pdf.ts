/**
 * Hebrew A4 PDF of a document, drawn with an embedded font (Alef, SIL OFL). Text is laid out
 * right-to-left with the Unicode bidi algorithm, so numbers and Latin text keep their order.
 * Marking (תקנות/הוראות ניהול פנקסים): the first output of an issued document says "מקור",
 * every later output says "העתק" (identical content). Drafts say "טיוטה — לא הופק".
 */
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import bidiFactory from 'bidi-js';
import { DOC_TYPE_LABEL, exemptTotals, lineTotal, PAYMENT_METHOD_LABEL } from '../domain/documents';
import { formatILS } from '../domain/money';
import type { Customer, Doc, Profile } from '../data/types';

export type Marking = 'original' | 'copy' | 'draft';
export interface PdfFonts { regular: Uint8Array; bold: Uint8Array }
export interface PdfInput {
  doc: Doc;
  related: Doc | null;
  issuer: Profile | null;
  customer: (Omit<Customer, 'id'> & { id?: string }) | null;
  /** "חשבונית עסקה מס' 12 (₪100.00)" lines for a receipt */
  paidInvoices: { number: number | null; amount_agorot: number }[];
  marking: Marking;
  generatedAt?: Date;
}

const bidi = bidiFactory();

/** Logical string → visual (left-to-right drawing) order, with mirrored brackets. */
export function visual(text: string): string {
  if (!/[֐-׿]/.test(text)) return text;
  const levels = bidi.getEmbeddingLevels(text, 'rtl');
  // Indices are UTF-16 positions; document text here has no astral characters.
  const chars = text.split('');
  // Mirror brackets in logical positions first, then reorder runs for drawing.
  chars.forEach((ch, i) => { if (levels.levels[i] & 1) chars[i] = bidi.getMirroredCharacter(ch) ?? ch; });
  for (const [start, end] of bidi.getReorderSegments(text, levels)) {
    const seg = chars.slice(start, end + 1).reverse();
    chars.splice(start, seg.length, ...seg);
  }
  return chars.join('');
}

export interface BidiRun { text: string; offset: number }
/**
 * Splits a logical line into directional runs, in LOGICAL order, each with the text to draw
 * (Hebrew runs already reversed) and its offset (in characters) inside the visual line.
 * Drawing runs separately, in logical order, lets PDF text extraction / copy-paste recover
 * correct Hebrew and keep numbers like "12" or "1,234.50" unreversed.
 */
export function bidiRuns(text: string): { visual: string; runs: BidiRun[] } {
  if (!/[\u0590-\u05FF]/.test(text)) return { visual: text, runs: [{ text, offset: 0 }] };
  const lv = bidi.getEmbeddingLevels(text, 'rtl');
  const chars = text.split('');
  chars.forEach((ch, i) => { if (lv.levels[i] & 1) chars[i] = bidi.getMirroredCharacter(ch) ?? ch; });
  const order = chars.map((_, i) => i);                     // visual position -> logical index
  for (const [start, end] of bidi.getReorderSegments(text, lv)) {
    const seg = order.slice(start, end + 1).reverse();
    order.splice(start, seg.length, ...seg);
  }
  const posOf = new Array<number>(order.length);
  order.forEach((logical, pos) => { posOf[logical] = pos; });
  const vis = order.map((i) => chars[i]).join('');
  const runs: BidiRun[] = [];
  let i = 0;
  while (i < chars.length) {
    let j = i;
    while (j + 1 < chars.length && lv.levels[j + 1] === lv.levels[i]) j++;
    let min = Infinity, max = -Infinity;
    for (let k = i; k <= j; k++) { min = Math.min(min, posOf[k]); max = Math.max(max, posOf[k]); }
    runs.push({ text: vis.slice(min, max + 1), offset: min });
    i = j + 1;
  }
  return { visual: vis, runs };
}

let cachedFonts: Promise<PdfFonts> | null = null;
export function loadFonts(base = '/'): Promise<PdfFonts> {
  cachedFonts ??= Promise.all(['Alef-Regular', 'Alef-Bold'].map(async (n) => {
    const r = await fetch(`${base}fonts/${n}.ttf`);
    if (!r.ok) throw new Error(`font ${n}: HTTP ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  })).then(([regular, bold]) => ({ regular, bold }));
  return cachedFonts;
}

const fmtDate = (d: string | null | undefined) => (d ? d.slice(0, 10).split('-').reverse().join('/') : '');
const money = (agorot: number | null | undefined) => formatILS(agorot ?? 0).replace(/‏|‎/g, '');

export async function renderDocumentPdf(input: PdfInput, fonts: PdfFonts): Promise<Uint8Array> {
  const { doc, related, issuer, customer, marking } = input;
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const regular = await pdf.embedFont(fonts.regular, { subset: true });
  const bold = await pdf.embedFont(fonts.bold, { subset: true });
  const title = `${DOC_TYPE_LABEL[doc.doc_type]}${doc.number !== null ? ` מס' ${doc.number}` : ''}`;
  pdf.setTitle(title);
  pdf.setLanguage('he-IL');
  pdf.setCreator('ניהול עסק עצמאי');
  pdf.setProducer('ניהול עסק עצמאי');
  if (input.generatedAt) { pdf.setCreationDate(input.generatedAt); pdf.setModificationDate(input.generatedAt); }

  const W = 595.28, H = 841.89, M = 48, R = W - M;
  let page = pdf.addPage([W, H]);
  let y = H - M;
  const black = rgb(0.07, 0.07, 0.07), grey = rgb(0.4, 0.4, 0.4);

  const text = (p: PDFPage, s: string, x: number, yy: number, o: { size?: number; font?: PDFFont; align?: 'right' | 'left' | 'center'; color?: ReturnType<typeof rgb> } = {}) => {
    const font = o.font ?? regular, size = o.size ?? 10;
    const { visual: v, runs } = bidiRuns(s);
    const w = font.widthOfTextAtSize(v, size);
    const left = o.align === 'left' ? x : o.align === 'center' ? x - w / 2 : x - w;
    for (const r of runs) {
      if (!r.text) continue;
      p.drawText(r.text, { x: left + font.widthOfTextAtSize(v.slice(0, r.offset), size), y: yy, size, font, color: o.color ?? black });
    }
    return w;
  };
  /** Word-wraps logical text to a width; returns lines (logical). */
  const wrap = (s: string, width: number, font: PDFFont, size: number): string[] => {
    const out: string[] = [];
    for (const para of s.split('\n')) {
      let line = '';
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const t = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(visual(t), size) > width && line) { out.push(line); line = word; } else line = t;
      }
      out.push(line);
    }
    return out;
  };
  const ensure = (needed: number) => {
    if (y - needed > M + 40) return;
    page = pdf.addPage([W, H]);
    y = H - M;
  };

  // marking box (top-left), watermark for drafts/cancelled
  const mark = marking === 'original' ? 'מקור' : marking === 'copy' ? 'העתק נאמן למקור' : 'טיוטה — לא הופק';
  const mw = bold.widthOfTextAtSize(visual(mark), 14) + 16;
  page.drawRectangle({ x: M, y: y - 22, width: mw, height: 24, borderColor: black, borderWidth: 1.2 });
  text(page, mark, M + 8, y - 15, { font: bold, size: 14, align: 'left' });

  text(page, title, R, y - 14, { font: bold, size: 20 });
  y -= 34;
  text(page, `תאריך: ${fmtDate(doc.issue_date)}`, R, y);
  y -= 22;

  // issuer
  if (issuer) {
    text(page, issuer.legal_name, R, y, { font: bold, size: 12 }); y -= 15;
    if (issuer.business_name) { text(page, issuer.business_name, R, y); y -= 13; }
    if (issuer.address) { text(page, issuer.address, R, y); y -= 13; }
    const exempt = (doc.vat_status_at_issue ?? 'exempt') === 'exempt';
    text(page, `ת.ז./מס' עוסק: ${issuer.id_number}${exempt ? ' · עוסק פטור' : ''}`, R, y); y -= 13;
    const contact = [issuer.phone, issuer.email].filter(Boolean).join(' · ');
    if (contact) { text(page, contact, R, y, { color: grey }); y -= 13; }
  }
  y -= 6;
  page.drawLine({ start: { x: M, y }, end: { x: R, y }, thickness: 1.5, color: black });
  y -= 20;

  // customer
  text(page, doc.doc_type === 'receipt' ? 'התקבל מאת' : 'לכבוד', R, y, { color: grey }); y -= 15;
  if (customer) {
    text(page, customer.name, R, y, { font: bold, size: 12 }); y -= 14;
    if (customer.address) { text(page, customer.address, R, y); y -= 13; }
    if (customer.tax_id) { text(page, `ח.פ./ת.ז.: ${customer.tax_id}`, R, y); y -= 13; }
  }
  y -= 10;
  if (doc.doc_type === 'cancellation' && related) {
    for (const l of wrap(`מבטל את ${DOC_TYPE_LABEL[related.doc_type]} מס' ${related.number} מיום ${fmtDate(related.issue_date)}. סיבה: ${doc.correction_reason ?? ''}`, R - M, bold, 11)) {
      text(page, l, R, y, { font: bold, size: 11 }); y -= 15;
    }
    y -= 6;
  }

  // lines table — columns from the right: description | qty | price | discount | total
  const cols = [{ label: 'תיאור', x: R }, { label: 'כמות', x: R - 250 }, { label: 'מחיר', x: R - 300 }, { label: 'הנחה', x: R - 380 }, { label: 'סה"כ', x: R - 440 }];
  page.drawRectangle({ x: M, y: y - 6, width: R - M, height: 20, color: rgb(0.93, 0.93, 0.93) });
  cols.forEach((c) => text(page, c.label, c.x - 4, y, { font: bold }));
  y -= 22;
  for (const l of doc.lines) {
    const descLines = wrap(l.description, 240, regular, 10);
    ensure(descLines.length * 13 + 8);
    descLines.forEach((dl, i) => text(page, dl, R - 4, y - i * 13));
    text(page, String(l.quantity), R - 254, y);
    text(page, money(l.unit_price_agorot), R - 304, y);
    text(page, l.discount_agorot ? money(l.discount_agorot) : '—', R - 384, y);
    text(page, money(lineTotal(l)), R - 444, y);
    y -= descLines.length * 13 + 6;
    page.drawLine({ start: { x: M, y: y + 2 }, end: { x: R, y: y + 2 }, thickness: 0.3, color: grey });
  }
  y -= 14;
  ensure(60);
  const total = doc.total_agorot ?? exemptTotals(doc.lines).total;
  text(page, `${doc.doc_type === 'receipt' ? 'סכום שהתקבל' : 'סה"כ לתשלום'}: ${money(total)}`, R, y, { font: bold, size: 14 });
  y -= 22;

  if (doc.doc_type === 'receipt') {
    const pd = doc.payment_details;
    if (pd.method) {
      let s = `אמצעי תשלום: ${PAYMENT_METHOD_LABEL[pd.method]}`;
      if (pd.reference) s += ` · אסמכתה ${pd.reference}`;
      if (pd.method === 'cheque') s += ` · צ'ק ${pd.cheque_number ?? ''}, בנק ${pd.bank ?? ''}, סניף ${pd.branch ?? ''}, לפירעון ${fmtDate(pd.due_date)}`;
      for (const l of wrap(s, R - M, regular, 10)) { ensure(14); text(page, l, R, y); y -= 14; }
    }
    if (input.paidInvoices.length) {
      const s = 'על חשבון: ' + input.paidInvoices.map((p) => `חשבונית עסקה מס' ${p.number} (${money(p.amount_agorot)})`).join(', ');
      for (const l of wrap(s, R - M, regular, 10)) { ensure(14); text(page, l, R, y); y -= 14; }
    }
  }
  if (doc.notes) {
    y -= 6;
    for (const l of wrap(doc.notes, R - M, regular, 10)) { ensure(14); text(page, l, R, y); y -= 14; }
  }

  // footer on every page
  const exempt = (doc.vat_status_at_issue ?? 'exempt') === 'exempt';
  const pages = pdf.getPages();
  pages.forEach((p, i) => {
    const fy = M;
    if (exempt) { text(p, 'עוסק פטור — עסקאותיו פטורות ממע"מ לפי סעיף 31(3) לחוק מע"מ', R, fy + 14, { size: 8, color: grey }); }
    text(p, `הופק במערכת ממוחשבת · ${mark} · עמוד ${i + 1} מתוך ${pages.length}`, R, fy, { size: 8, color: grey });
    if (doc.status === 'cancelled') {
      p.drawText(visual('בוטל'), { x: W / 2 - 60, y: H / 2, size: 72, font: bold, color: rgb(0.85, 0.2, 0.2), opacity: 0.18 });
    }
  });
  return pdf.save({ useObjectStreams: false });
}
