import type { Doc } from '../data/types';
import type { AllocationRecord } from './payments';

export interface YearSummary {
  /** Issued (not cancelled) transaction invoices dated in the year — payment requests, "accrual" view. */
  invoiced: number; invoiceCount: number;
  /** Issued (not cancelled) receipts dated in the year — money actually received, "cash" view. */
  received: number; receiptCount: number;
  /** Part of `received` paid against invoices; the rest is unallocated (advances / credit). */
  receivedAgainstInvoices: number;
  /** Cancelled documents are excluded from both views, as are cancellation documents themselves. */
  excludedCancelled: number;
}

/**
 * Income for a year without double counting: invoices and receipts are two views of the same
 * income and are never added together. A receipt that pays an invoice is counted once in each view.
 */
export function yearSummary(docs: Doc[], allocations: AllocationRecord[], year: number): YearSummary {
  const inYear = (d: Doc) => d.issue_date.startsWith(String(year));
  const invoices = docs.filter((d) => d.doc_type === 'transaction_invoice' && d.status === 'issued' && inYear(d));
  const receipts = docs.filter((d) => d.doc_type === 'receipt' && d.status === 'issued' && inYear(d));
  const receiptIds = new Set(receipts.map((r) => r.id));
  return {
    invoiced: invoices.reduce((s, d) => s + (d.total_agorot ?? 0), 0), invoiceCount: invoices.length,
    received: receipts.reduce((s, d) => s + (d.total_agorot ?? 0), 0), receiptCount: receipts.length,
    receivedAgainstInvoices: allocations.filter((a) => receiptIds.has(a.receipt_id)).reduce((s, a) => s + a.amount_agorot, 0),
    excludedCancelled: docs.filter((d) => d.status === 'cancelled' && inYear(d)).length,
  };
}
