import { describe, it, expect } from 'vitest';
import { bracketTax, estimateIncomeTax, type EstimateInput } from '../../app/src/domain/tax/engine';
import { RULES_2026, RULES_2025, rulesFor } from '../../app/src/domain/tax/rules';

const ILS = (n: number) => n * 100;

/** Independent reference implementation from the official 2026 bracket table (annual, ₪). */
function reference2026(income: number): number {
  const b: [number, number][] = [[84120, .10], [120720, .14], [228000, .20], [301200, .31], [560280, .35], [Infinity, .47]];
  let tax = 0, prev = 0;
  for (const [top, r] of b) { if (income <= prev) break; tax += (Math.min(income, top) - prev) * r; prev = top; }
  if (income > 721560) tax += (income - 721560) * 0.03;
  return tax;
}

describe('2026 rule set (verified against the official 2026 deductions booklet)', () => {
  it('has the widened 20% and 31% brackets', () => {
    expect(RULES_2026.incomeTax.brackets.map((b) => b.upTo)).toEqual(
      [ILS(84_120), ILS(120_720), ILS(228_000), ILS(301_200), ILS(560_280), null]);
    expect(RULES_2025.incomeTax.brackets[2].upTo).toBe(ILS(193_800));
    expect(RULES_2026.incomeTax.creditPointAnnual).toBe(ILS(2_904));
    expect(RULES_2026.exemptDealerCeiling.amount).toBe(ILS(122_833));
  });
  it('every rule set carries a source and verification date', () => {
    for (const r of [RULES_2025, RULES_2026]) {
      for (const s of [...r.incomeTax.sources, ...r.exemptDealerCeiling.sources, ...r.smallBusiness.sources]) {
        expect(s.url).toMatch(/^https:\/\//);
        expect(s.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
  });
  it.each([0, 84_120, 84_121, 120_720, 120_721, 228_000, 228_001, 301_200, 301_201, 560_280, 560_281, 721_560, 721_561, 1_000_000])(
    'bracket tax at %i ₪ matches the reference within 1 agora per bracket', (income) => {
      const { tax } = bracketTax(ILS(income), RULES_2026);
      expect(Math.abs(tax - Math.round(reference2026(income) * 100))).toBeLessThanOrEqual(7);
    });
  it('228,000 ₪ in 2026 is taxed at 20% at the margin; 228,001 ₪ adds 31%', () => {
    const a = bracketTax(ILS(228_000), RULES_2026).tax;
    const b = bracketTax(ILS(228_001), RULES_2026).tax;
    expect(b - a).toBe(31);
    expect(bracketTax(ILS(228_001), RULES_2025).tax - bracketTax(ILS(228_000), RULES_2025).tax).toBe(31);
    expect(bracketTax(ILS(200_000), RULES_2026).tax).toBeLessThan(bracketTax(ILS(200_000), RULES_2025).tax);
  });
});

const complete: EstimateInput = {
  taxYear: 2026, salaryTaxable: ILS(180_000), salaryTaxWithheld: ILS(20_000), businessTurnover: ILS(60_000),
  regime: 'small_business', allowedBusinessExpenses: null, creditPoints: 2.25, advancesPaid: 0, withheldByCustomers: 0,
};

describe('income tax estimate', () => {
  it('never computes business tax in isolation: salary is required', () => {
    const r = estimateIncomeTax({ ...complete, salaryTaxable: null });
    expect(r.status).toBe('incomplete');
    expect(r.taxLiability).toBeNull();
    expect(r.missing.join()).toMatch(/106/);
  });
  it('is incomplete without credit points or regime, and for the regular regime without allowed expenses', () => {
    expect(estimateIncomeTax({ ...complete, creditPoints: null }).status).toBe('incomplete');
    expect(estimateIncomeTax({ ...complete, regime: null }).status).toBe('incomplete');
    const r = estimateIncomeTax({ ...complete, regime: 'regular', allowedBusinessExpenses: null });
    expect(r.status).toBe('incomplete');
    expect(r.missing.join()).toMatch(/הוצאות מותרות/);
  });
  it('refuses unverified tax years', () => {
    expect(estimateIncomeTax({ ...complete, taxYear: 2027 }).status).toBe('unsupported_year');
    expect(rulesFor(2024)).toBeNull();
  });
  it('taxes salary and business together, applying brackets once', () => {
    const r = estimateIncomeTax(complete);
    expect(r.status).toBe('estimate');
    const taxable = 180_000 + 60_000 * 0.7;
    const expected = Math.round(reference2026(taxable) * 100) - 225 * 2904; // 2.25 points × 2,904 ₪
    expect(Math.abs((r.taxLiability as number) - expected)).toBeLessThanOrEqual(7);
    expect(r.remainingToPay).toBe((r.taxLiability as number) - ILS(20_000));
    expect(r.excluded.length).toBeGreaterThan(0);
  });
  it('small business: 30% standard deduction replaces actual expenses (no double deduction)', () => {
    const withExpenses = estimateIncomeTax({ ...complete, allowedBusinessExpenses: ILS(50_000) });
    const without = estimateIncomeTax(complete);
    expect(withExpenses.taxLiability).toBe(without.taxLiability);
    expect(without.steps.some((s) => s.value === -ILS(18_000))).toBe(true);
    expect(without.steps.some((s) => /52%/.test(s.label))).toBe(false);
  });
  it('regular regime uses allowed expenses and warns that the NI deduction is excluded', () => {
    const r = estimateIncomeTax({ ...complete, regime: 'regular', allowedBusinessExpenses: ILS(10_000) });
    expect(r.status).toBe('estimate');
    expect(r.excluded[0]).toMatch(/52%/);
  });
  it('warns when turnover exceeds the small-business ceiling', () => {
    const r = estimateIncomeTax({ ...complete, businessTurnover: ILS(122_834) });
    expect(r.warnings.join()).toMatch(/תקרת/);
  });
  it('credit points never produce negative tax; overpayment shows as a refund', () => {
    const r = estimateIncomeTax({ ...complete, salaryTaxable: 0, salaryTaxWithheld: null, businessTurnover: ILS(10_000), withheldByCustomers: ILS(500) });
    expect(r.taxLiability).toBe(0);
    expect(r.remainingToPay).toBe(-ILS(500));
  });
});
