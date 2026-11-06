import type { Agorot } from './money';

/** A receipt draft's request to pay part or all of an invoice. */
export interface Allocation { invoice_id: string; amount_agorot: Agorot }

/** Paid and open amount of one issued invoice (cancelled receipts do not count). */
export interface InvoiceBalance {
  invoice_id: string;
  customer_id: string | null;
  number: number | null;
  issue_date: string;
  total_agorot: Agorot;
  paid_agorot: Agorot;
  balance_agorot: Agorot;
}

/** Recorded allocation of an issued receipt (immutable). */
export interface AllocationRecord { receipt_id: string; invoice_id: string; amount_agorot: Agorot }

/**
 * Same rules as app.apply_allocations() in SQL, as error codes (the server stays authoritative).
 * `balances` are the current open amounts of issued invoices.
 */
export function allocationProblems(receiptTotal: Agorot, customerId: string | null, allocations: Allocation[],
  balances: InvoiceBalance[]): string[] {
  const out = new Set<string>();
  const seen = new Set<string>();
  let sum = 0;
  for (const a of allocations) {
    const b = balances.find((x) => x.invoice_id === a.invoice_id);
    if (seen.has(a.invoice_id) || !b || b.customer_id !== customerId || !Number.isInteger(a.amount_agorot) || a.amount_agorot <= 0) {
      out.add('ALLOCATION_INVALID');
    } else if (a.amount_agorot > b.balance_agorot) {
      out.add('ALLOCATION_EXCEEDS_BALANCE');
    }
    seen.add(a.invoice_id);
    sum += a.amount_agorot;
  }
  if (sum > receiptTotal) out.add('ALLOCATION_EXCEEDS_RECEIPT');
  return [...out];
}

/** Pays the oldest open invoices first, up to the amount received. */
export function autoAllocate(amount: Agorot, open: InvoiceBalance[]): Allocation[] {
  const out: Allocation[] = [];
  let left = amount;
  const sorted = [...open].filter((b) => b.balance_agorot > 0)
    .sort((a, b) => (a.issue_date === b.issue_date ? (a.number ?? 0) - (b.number ?? 0) : a.issue_date < b.issue_date ? -1 : 1));
  for (const b of sorted) {
    if (left <= 0) break;
    const amt = Math.min(left, b.balance_agorot);
    out.push({ invoice_id: b.invoice_id, amount_agorot: amt });
    left -= amt;
  }
  return out;
}

export const sumAllocations = (a: Allocation[]) => a.reduce((s, x) => s + x.amount_agorot, 0);
