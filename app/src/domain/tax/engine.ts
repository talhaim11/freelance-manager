/**
 * Deterministic income-tax ESTIMATE for an individual with salary and business income.
 * It never fills in unknown inputs: if a material input is missing, the result is
 * 'incomplete' with no amount. A computed result is always an estimate with
 * explicitly listed exclusions — never an official amount.
 */
import { roundHalfAwayFromZero, type Agorot } from '../money';
import { rulesFor, type RuleSet } from './rules';

export type Regime = 'regular' | 'small_business';

export interface EstimateInput {
  taxYear: number;
  /** Taxable salary for the year (Form 106). 0 if no salary. null = unknown. */
  salaryTaxable: Agorot | null;
  /** Tax withheld from salary (Form 106). */
  salaryTaxWithheld: Agorot | null;
  businessTurnover: Agorot;
  regime: Regime | null;
  /** Expenses allowed as deductions (regular regime only). null = not determined. */
  allowedBusinessExpenses: Agorot | null;
  /** Total credit points (e.g. 2.25 for a resident man, 2.75 for a resident woman, plus others). */
  creditPoints: number | null;
  advancesPaid: Agorot;
  withheldByCustomers: Agorot;
}

export interface Step { label: string; value: Agorot | string; detail?: string }

export interface EstimateResult {
  status: 'incomplete' | 'unsupported_year' | 'estimate';
  taxYear: number;
  ruleSetId: string | null;
  missing: string[];
  steps: Step[];
  excluded: string[];
  warnings: string[];
  taxLiability: Agorot | null;
  remainingToPay: Agorot | null; // negative = estimated refund
}

export function bracketTax(taxable: Agorot, rules: RuleSet): { tax: Agorot; steps: Step[] } {
  let prev = 0;
  let tax = 0;
  const steps: Step[] = [];
  for (const b of rules.incomeTax.brackets) {
    if (taxable <= prev) break;
    const top = b.upTo === null ? taxable : Math.min(taxable, b.upTo);
    const portion = top - prev;
    const t = roundHalfAwayFromZero((portion * b.rateBp) / 10_000);
    steps.push({ label: `מדרגה ${b.rateBp / 100}%`, value: t, detail: `${portion / 100} ₪ × ${b.rateBp / 100}%` });
    tax += t;
    if (b.upTo === null) break;
    prev = b.upTo;
  }
  const { threshold, rateBp } = rules.incomeTax.surtax;
  if (taxable > threshold) {
    const s = roundHalfAwayFromZero(((taxable - threshold) * rateBp) / 10_000);
    steps.push({ label: 'מס יסף', value: s, detail: `${rateBp / 100}% מעל ${threshold / 100} ₪` });
    tax += s;
  }
  return { tax, steps };
}

export function estimateIncomeTax(input: EstimateInput): EstimateResult {
  const rules = rulesFor(input.taxYear);
  const base: EstimateResult = {
    status: 'incomplete', taxYear: input.taxYear, ruleSetId: rules?.id ?? null,
    missing: [], steps: [], excluded: [], warnings: [], taxLiability: null, remainingToPay: null,
  };
  if (!rules) return { ...base, status: 'unsupported_year', missing: [`כללי מס לשנת ${input.taxYear} לא אומתו במערכת`] };

  const missing: string[] = [];
  if (input.salaryTaxable === null) missing.push('הכנסה חייבת ממשכורת (טופס 106) — הזינו 0 אם אין משכורת');
  if (input.salaryTaxable !== null && input.salaryTaxable > 0 && input.salaryTaxWithheld === null) missing.push('מס שנוכה מהמשכורת (טופס 106)');
  if (input.regime === null) missing.push('מסלול מס הכנסה לעסק (רגיל או בעל עסק זעיר)');
  if (input.regime === 'regular' && input.allowedBusinessExpenses === null) missing.push('הוצאות מותרות בניכוי (לא כל הוצאה בפועל מותרת)');
  if (input.creditPoints === null) missing.push('מספר נקודות הזיכוי');
  if (missing.length) return { ...base, missing };

  const warnings: string[] = [];
  const steps: Step[] = [];
  let businessIncome: Agorot;
  if (input.regime === 'small_business') {
    const deduction = roundHalfAwayFromZero((input.businessTurnover * rules.smallBusiness.standardDeductionBp) / 10_000);
    businessIncome = input.businessTurnover - deduction;
    steps.push({ label: 'מחזור עסקי', value: input.businessTurnover });
    steps.push({ label: 'ניכוי קבוע לבעל עסק זעיר (30%) — במקום הוצאות בפועל', value: -deduction,
      detail: 'הניכוי כולל פחת ותשלומי ביטוח לאומי; לא מוסיפים הוצאות בפועל.' });
    if (input.businessTurnover > rules.smallBusiness.turnoverCeiling) {
      warnings.push(`המחזור עולה על תקרת בעל עסק זעיר (${rules.smallBusiness.turnoverCeiling / 100} ₪) — המסלול כנראה אינו חל.`);
    }
  } else {
    const expenses = input.allowedBusinessExpenses as Agorot;
    businessIncome = input.businessTurnover - expenses;
    steps.push({ label: 'מחזור עסקי', value: input.businessTurnover });
    steps.push({ label: 'הוצאות מותרות בניכוי', value: -expenses });
  }
  if (businessIncome < 0) {
    warnings.push('הפסד עסקי: קיזוז הפסדים מול משכורת אינו מחושב כאן.');
    businessIncome = 0;
  }
  steps.push({ label: 'הכנסה חייבת מעסק', value: businessIncome });

  const salary = input.salaryTaxable as Agorot;
  const taxable = salary + businessIncome;
  steps.push({ label: 'הכנסה חייבת ממשכורת', value: salary });
  steps.push({ label: 'סה"כ הכנסה חייבת (משכורת + עסק יחד)', value: taxable });

  const bt = bracketTax(taxable, rules);
  steps.push(...bt.steps);
  steps.push({ label: 'מס לפי מדרגות', value: bt.tax });

  const credits = roundHalfAwayFromZero((input.creditPoints as number) * rules.incomeTax.creditPointAnnual);
  const liability = Math.max(0, bt.tax - credits);
  steps.push({ label: `נקודות זיכוי (${input.creditPoints} × ${rules.incomeTax.creditPointAnnual / 100} ₪)`, value: -Math.min(credits, bt.tax) });
  steps.push({ label: 'מס הכנסה שנתי משוער', value: liability });

  const paid = (input.salaryTaxWithheld ?? 0) + input.advancesPaid + input.withheldByCustomers;
  steps.push({ label: 'שולם/נוכה כבר (משכורת, מקדמות, ניכוי במקור)', value: -paid });
  const remaining = liability - paid;
  steps.push({ label: remaining >= 0 ? 'יתרה משוערת לתשלום' : 'החזר משוער', value: remaining });

  const excluded = [...rules.limitations];
  if (input.regime === 'regular') excluded.unshift('במסלול הרגיל לא נוכו 52% מדמי הביטוח הלאומי — ההערכה עשויה להיות גבוהה מהמס בפועל.');

  return { ...base, status: 'estimate', steps, excluded, warnings, taxLiability: liability, remainingToPay: remaining };
}
