import { describe, it, expect } from 'vitest';
import { parseShekels, roundHalfAwayFromZero, formatILS } from '../../app/src/domain/money';
import { vatStatusOn, type VatStatusPeriod } from '../../app/src/domain/classification';
import { lineTotal, exemptTotals, issueProblems, creatableDocTypes, lineProblems } from '../../app/src/domain/documents';
import { errorCode, errorMessage } from '../../app/src/domain/errors';

describe('money', () => {
  it('parses Hebrew-locale shekel input into integer agorot', () => {
    expect(parseShekels('1,234.50')).toBe(123450);
    expect(parseShekels('99,9')).toBe(9990);
    expect(parseShekels('₪ 10')).toBe(1000);
    expect(parseShekels('0.05')).toBe(5);
    expect(parseShekels('1.005')).toBeNull();     // sub-agora precision rejected, not silently rounded
    expect(parseShekels('abc')).toBeNull();
    expect(parseShekels('')).toBeNull();
  });
  it('rounds half away from zero, robust to binary artefacts', () => {
    expect(roundHalfAwayFromZero(49999.5)).toBe(50000);
    expect(roundHalfAwayFromZero(1.005 * 100)).toBe(101);
    expect(roundHalfAwayFromZero(-2.5)).toBe(-3);
  });
  it('formats ILS with two decimals', () => {
    expect(formatILS(123450)).toMatch(/1,234\.50/);
  });
});

describe('VAT status history', () => {
  const periods: VatStatusPeriod[] = [
    { id: 'a', status: 'exempt', effective_from: '2024-01-01', effective_to: '2026-06-30' },
    { id: 'b', status: 'licensed', effective_from: '2026-07-01', effective_to: null },
  ];
  it('uses the status in force on the document date, not today', () => {
    expect(vatStatusOn(periods, '2026-06-30')).toBe('exempt');
    expect(vatStatusOn(periods, '2026-07-01')).toBe('licensed');
  });
  it('returns null (unknown) before any period — never guesses', () => {
    expect(vatStatusOn(periods, '2023-12-31')).toBeNull();
    expect(vatStatusOn([], '2026-01-01')).toBeNull();
  });
});

describe('document rules', () => {
  const base = {
    docType: 'transaction_invoice' as const, vatStatus: 'exempt' as const,
    profile: { legal_name: 'א', id_number: '1', address: 'כתובת' },
    customer: { name: 'ל', address: 'כ' },
    lines: [{ description: 'שירות', quantity: 1.5, unit_price_agorot: 33333 }],
    payment: {},
  };
  it('matches the SQL rounding for line totals and never adds VAT for an exempt dealer', () => {
    expect(lineTotal({ description: 'x', quantity: 1.5, unit_price_agorot: 33333 })).toBe(50000);
    const t = exemptTotals([
      { description: 'שעה', quantity: 1.5, unit_price_agorot: 33333 },
      { description: 'הנחה בשורה', quantity: 1, unit_price_agorot: 10000, discount_agorot: 2500 },
    ]);
    expect(t).toEqual({ subtotal: 57500, vatRateBp: 0, vat: 0, total: 57500 });
  });
  it('blocks a tax invoice for an exempt dealer', () => {
    expect(issueProblems({ ...base, docType: 'tax_invoice' })).toContain('EXEMPT_CANNOT_ISSUE_TAX_INVOICE');
    expect(creatableDocTypes('exempt')).not.toContain('tax_invoice');
  });
  it('requires a known VAT status, issuer details, customer address on invoices and payment method on receipts', () => {
    expect(issueProblems({ ...base, vatStatus: null })).toContain('VAT_STATUS_UNKNOWN');
    expect(issueProblems({ ...base, profile: { legal_name: 'א', id_number: '', address: 'x' } })).toContain('PROFILE_INCOMPLETE');
    expect(issueProblems({ ...base, customer: { name: 'ל', address: ' ' } })).toContain('CUSTOMER_ADDRESS_REQUIRED');
    expect(issueProblems({ ...base, docType: 'receipt', customer: { name: 'ל', address: '' } })).toEqual(['PAYMENT_METHOD_REQUIRED']);
    expect(issueProblems({ ...base, docType: 'receipt', payment: { method: 'cash' } })).toEqual([]);
    expect(creatableDocTypes(null)).toEqual([]);
  });
  it('rejects discounts larger than the line', () => {
    expect(lineProblems([{ description: 'x', quantity: 1, unit_price_agorot: 100, discount_agorot: 101 }])).toHaveLength(1);
  });
  it('maps database error messages to Hebrew explanations', () => {
    expect(errorCode(new Error('FINALIZED_DOCUMENT: issued documents cannot be edited'))).toBe('FINALIZED_DOCUMENT');
    expect(errorMessage({ message: 'EXEMPT_CANNOT_ISSUE_TAX_INVOICE: x' })).toMatch(/עוסק פטור/);
    expect(errorCode(new TypeError('Failed to fetch'))).toBe('NETWORK');
  });
});
