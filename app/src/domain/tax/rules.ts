/**
 * Versioned, source-attributed Israeli tax rules. Values change only through a
 * reviewed code change with an official source and verification date — never
 * through the AI assistant or user input.
 */
import type { Agorot } from '../money';

export interface Source { title: string; url: string; verifiedAt: string; confidence: 'official' | 'law-text' | 'secondary' }

export interface Bracket { upTo: Agorot | null; rateBp: number } // null = no upper limit

export interface RuleSet {
  id: string;
  taxYear: number;
  incomeTax: {
    brackets: Bracket[];
    surtax: { threshold: Agorot; rateBp: number };
    creditPointAnnual: Agorot;
    sources: Source[];
  };
  exemptDealerCeiling: { amount: Agorot; sources: Source[] };
  smallBusiness: { turnoverCeiling: Agorot; standardDeductionBp: number; sources: Source[] };
  limitations: string[];
}

const ILS = (n: number): Agorot => n * 100;

const BOOKLET_2026: Source = {
  title: 'רשות המסים — חוברת ניכויים 2026 (עודכנה אפריל 2026), פרקים א–ג',
  url: 'https://www.gov.il/BlobFolder/generalpage/income-tax-monthly-deductions-booklet/he/generalInformation_income-tax-monthly-deductions-booklet_monthly-deductions-booklet-2026.pdf',
  verifiedAt: '2026-11-05', confidence: 'official',
};
const BOOKLET_2025: Source = {
  title: 'רשות המסים — חוברת ניכויים 2025',
  url: 'https://www.gov.il/BlobFolder/generalpage/income-tax-monthly-deductions-booklet/he/generalInformation_income-tax-monthly-deductions-booklet_monthly-deductions-booklet-2025.pdf',
  verifiedAt: '2026-11-05', confidence: 'official',
};
const AMOUNTS_PAGE: Source = {
  title: 'gov.il — שיעורי מע"מ וסכומים מעודכנים (תקרת עוסק פטור)',
  url: 'https://www.gov.il/he/pages/vat-rate-amount-new', verifiedAt: '2026-11-05', confidence: 'official',
};
const VAT_LAW_S1: Source = {
  title: 'חוק מע"מ, סעיף 1 — הגדרת "עוסק פטור" (נוסח משולב, לא רשמי)',
  url: 'https://he.wikisource.org/wiki/חוק_מס_ערך_מוסף', verifiedAt: '2026-11-05', confidence: 'law-text',
};
const SMALL_BUSINESS_FAQ: Source = {
  title: 'gov.il — בעל עסק זעיר: שאלות ותשובות (עודכן 24.02.2026)',
  url: 'https://www.gov.il/he/pages/faq-small-business-owner', verifiedAt: '2026-11-05', confidence: 'official',
};

const COMMON_LIMITATIONS = [
  'אינו כולל ביטוח לאומי ודמי בריאות, ואת הניכוי של 52% מדמי הביטוח הלאומי במסלול הרגיל.',
  'אינו כולל ניכויים וזיכויים בגין הפקדות לפנסיה, קרן השתלמות, תרומות וזיכויים אישיים מעבר לנקודות הזיכוי שהוזנו.',
  'אינו כולל הכנסות שאינן משכורת או עסק (שכירות, ריבית, רווחי הון וכו\').',
  'אינו מתחשב בתיאומי מס, בהכנסה מכמה מעסיקים ובחישוב חודשי של ניכוי במקור.',
];

export const RULES_2026: RuleSet = {
  id: 'IL-2026.1',
  taxYear: 2026,
  incomeTax: {
    brackets: [
      { upTo: ILS(84_120), rateBp: 1000 },
      { upTo: ILS(120_720), rateBp: 1400 },
      { upTo: ILS(228_000), rateBp: 2000 },
      { upTo: ILS(301_200), rateBp: 3100 },
      { upTo: ILS(560_280), rateBp: 3500 },
      { upTo: null, rateBp: 4700 },
    ],
    surtax: { threshold: ILS(721_560), rateBp: 300 },
    creditPointAnnual: ILS(2_904),
    sources: [BOOKLET_2026],
  },
  exemptDealerCeiling: { amount: ILS(122_833), sources: [AMOUNTS_PAGE] },
  smallBusiness: { turnoverCeiling: ILS(122_833), standardDeductionBp: 3000, sources: [SMALL_BUSINESS_FAQ] },
  limitations: COMMON_LIMITATIONS,
};

export const RULES_2025: RuleSet = {
  id: 'IL-2025.1',
  taxYear: 2025,
  incomeTax: {
    brackets: [
      { upTo: ILS(84_120), rateBp: 1000 },
      { upTo: ILS(120_720), rateBp: 1400 },
      { upTo: ILS(193_800), rateBp: 2000 },
      { upTo: ILS(269_280), rateBp: 3100 },
      { upTo: ILS(560_280), rateBp: 3500 },
      { upTo: null, rateBp: 4700 },
    ],
    surtax: { threshold: ILS(721_560), rateBp: 300 },
    creditPointAnnual: ILS(2_904),
    sources: [BOOKLET_2025],
  },
  exemptDealerCeiling: { amount: ILS(120_000), sources: [VAT_LAW_S1] },
  smallBusiness: { turnoverCeiling: ILS(120_000), standardDeductionBp: 3000, sources: [SMALL_BUSINESS_FAQ] },
  limitations: COMMON_LIMITATIONS,
};

export const RULE_SETS: Record<number, RuleSet> = { 2025: RULES_2025, 2026: RULES_2026 };

export function rulesFor(taxYear: number): RuleSet | null {
  return RULE_SETS[taxYear] ?? null;
}

export const SUPPORTED_TAX_YEARS = Object.keys(RULE_SETS).map(Number).sort();
