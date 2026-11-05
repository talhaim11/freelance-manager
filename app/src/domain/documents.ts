import { roundHalfAwayFromZero, type Agorot } from './money';
import type { VatStatus } from './classification';

export type DocType =
  | 'quote' | 'transaction_invoice' | 'receipt'
  | 'tax_invoice' | 'tax_invoice_receipt' | 'credit_invoice' | 'cancellation';
export type DocStatus = 'draft' | 'issued' | 'cancelled';

export const DOC_TYPE_LABEL: Record<DocType, string> = {
  quote: 'הצעת מחיר',
  transaction_invoice: 'חשבונית עסקה',
  receipt: 'קבלה',
  tax_invoice: 'חשבונית מס',
  tax_invoice_receipt: 'חשבונית מס/קבלה',
  credit_invoice: 'חשבונית זיכוי',
  cancellation: 'מסמך ביטול',
};

export const VAT_DOC_TYPES: DocType[] = ['tax_invoice', 'tax_invoice_receipt', 'credit_invoice'];

/** Document types the user may create directly in this version, by VAT status. */
export function creatableDocTypes(status: VatStatus | null): DocType[] {
  if (status === null) return [];
  // VAT documents for licensed dealers are deliberately not implemented in M1.
  return ['quote', 'transaction_invoice', 'receipt'];
}

export interface DocLine {
  description: string;
  quantity: number;
  unit_price_agorot: Agorot;
  discount_agorot?: Agorot;
}

export type PaymentMethod = 'bank_transfer' | 'cash' | 'cheque' | 'credit_card' | 'bit_paybox' | 'other';
export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  bank_transfer: 'העברה בנקאית',
  cash: 'מזומן',
  cheque: "צ'ק",
  credit_card: 'כרטיס אשראי',
  bit_paybox: 'אפליקציית תשלום',
  other: 'אחר',
};

export interface PaymentDetails {
  method?: PaymentMethod;
  reference?: string;
  cheque_number?: string;
  bank?: string;
  branch?: string;
  due_date?: string;
}

/** Line total = round(quantity × unit price) − discount. Mirrors app.lines_subtotal(). */
export function lineTotal(l: DocLine): Agorot {
  return roundHalfAwayFromZero(l.quantity * l.unit_price_agorot) - (l.discount_agorot ?? 0);
}

export interface LineProblem { index: number; message: string }

export function lineProblems(lines: DocLine[]): LineProblem[] {
  const out: LineProblem[] = [];
  lines.forEach((l, index) => {
    if (!l.description.trim()) out.push({ index, message: 'חסר תיאור' });
    if (!(l.quantity > 0)) out.push({ index, message: 'הכמות חייבת להיות חיובית' });
    if (!Number.isInteger(l.unit_price_agorot) || l.unit_price_agorot < 0) out.push({ index, message: 'מחיר לא תקין' });
    if ((l.discount_agorot ?? 0) < 0) out.push({ index, message: 'הנחה לא תקינה' });
    else if (l.quantity > 0 && lineTotal(l) < 0) out.push({ index, message: 'ההנחה גדולה מסכום השורה' });
  });
  return out;
}

export interface Totals { subtotal: Agorot; vatRateBp: number; vat: Agorot; total: Agorot }

/** Totals for an exempt dealer: no VAT is ever added. */
export function exemptTotals(lines: DocLine[]): Totals {
  const subtotal = lines.reduce((s, l) => s + lineTotal(l), 0);
  return { subtotal, vatRateBp: 0, vat: 0, total: subtotal };
}

export interface IssueContext {
  docType: DocType;
  vatStatus: VatStatus | null;
  profile: { legal_name: string; id_number: string; address: string } | null;
  customer: { name: string; address: string } | null;
  lines: DocLine[];
  payment: PaymentDetails;
}

/** Same rules as issue_document() in SQL, returned as error codes (server stays authoritative). */
export function issueProblems(ctx: IssueContext): string[] {
  const errors: string[] = [];
  if (ctx.vatStatus === null) errors.push('VAT_STATUS_UNKNOWN');
  if (ctx.vatStatus === 'exempt' && VAT_DOC_TYPES.includes(ctx.docType)) errors.push('EXEMPT_CANNOT_ISSUE_TAX_INVOICE');
  if (ctx.vatStatus === 'licensed' && VAT_DOC_TYPES.includes(ctx.docType)) errors.push('NOT_SUPPORTED_YET');
  if (ctx.docType === 'cancellation') errors.push('USE_CANCEL_DOCUMENT');
  const p = ctx.profile;
  if (!p || !p.legal_name.trim() || !p.id_number.trim() || !p.address.trim()) errors.push('PROFILE_INCOMPLETE');
  if (!ctx.customer) errors.push('CUSTOMER_REQUIRED');
  else if (ctx.docType === 'transaction_invoice' && !ctx.customer.address.trim()) errors.push('CUSTOMER_ADDRESS_REQUIRED');
  if (ctx.docType === 'receipt' && !ctx.payment.method) errors.push('PAYMENT_METHOD_REQUIRED');
  if (ctx.lines.length === 0 || lineProblems(ctx.lines).length) errors.push('INVALID_LINES');
  else if (exemptTotals(ctx.lines).total <= 0) errors.push('INVALID_TOTAL');
  return errors;
}
