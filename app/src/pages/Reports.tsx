import { useState } from 'react';
import { useRepo } from '../App';
import { vatStatusOn } from '../domain/classification';
import { yearSummary } from '../domain/dashboard';
import { errorMessage } from '../domain/errors';
import { formatILS } from '../domain/money';
import { rulesFor } from '../domain/tax/rules';
import { DataState, Field, useAsync, useBusy, useToast } from '../ui/kit';
import type { Submission, SubmissionKind, TaxProfile } from '../data/types';

interface ReportDef { kind: SubmissionKind; title: string; url: string; when: string; note: string }
const DEFS: Record<SubmissionKind, ReportDef> = {
  vat_exempt_declaration: { kind: 'vat_exempt_declaration', title: 'הצהרת מחזור שנתית — עוסק פטור', url: 'https://www.gov.il/he/service/vat-declarationisexempt',
    when: 'עד 31 בינואר של השנה הבאה', note: 'מדווחים את מחזור העסקאות של השנה. לא נמצא API רשמי — ההגשה באתר רשות המסים (אזור אישי).' },
  small_business_report: { kind: 'small_business_report', title: 'בעל עסק זעיר — דוח מקוצר ותשלום', url: 'https://www.gov.il/he/service/report-and-payment-for-micro-business-owner',
    when: 'לפי המועדים באתר הרשמי', note: 'ניכוי בשיעור קבוע של 30% מהמחזור במקום הוצאות בפועל. לא נמצא API רשמי.' },
  annual_1301: { kind: 'annual_1301', title: 'דוח שנתי ליחיד (1301)', url: 'https://www.gov.il/he/service/reporting-and-payment-2025-annual-tax-report-for-individuals',
    when: 'לפי המועדים שמפורסמים לכל שנה', note: 'הגשה מקוונת באתר רשות המסים. API ל-1301 מלא לא קיים לנישום (קיים חלקית למייצגים דרך בתי תוכנה).' },
  income_tax_advance: { kind: 'income_tax_advance', title: 'מקדמות מס הכנסה', url: 'https://www.gov.il/he/service/itc-payment-online-incometax',
    when: 'עד ה-19 בחודש שאחרי התקופה', note: 'דיווח ותשלום באתר. API קיים לבתי תוכנה רשומים בלבד — לא מחובר.' },
  national_insurance: { kind: 'national_insurance', title: 'ביטוח לאומי — עצמאי', url: 'https://www.btl.gov.il',
    when: 'לפי פנקס המקדמות', note: 'צפייה, תשלום ועדכון הכנסה באתר ביטוח לאומי. לא נמצא API.' },
};

/** Which reports apply, from the VAT status and the tax profile. Unknown answers keep a report visible. */
export function applicableReports(vat: 'exempt' | 'licensed' | null, t: TaxProfile | null): SubmissionKind[] {
  const out: SubmissionKind[] = [];
  if (vat === 'exempt') out.push('vat_exempt_declaration');
  if (t?.income_tax_regime === 'small_business') out.push('small_business_report');
  else out.push('annual_1301');
  if (t?.advances_book !== 'no') out.push('income_tax_advance');
  if (t?.ni_self_employed !== 'no') out.push('national_insurance');
  return out;
}

const STATUS_LABEL = { prepared: 'מוכן להגשה ידנית', submitted: 'הוגש (לפי אסמכתה שהוזנה)', accepted: 'התקבל אישור', rejected: 'נדחה' };

export function GuidedReports() {
  const repo = useRepo();
  const [year, setYear] = useState(new Date().getFullYear() - 1);
  const [state, retry] = useAsync(async () => {
    const [docs, allocations, expenses, vat, tax, subs] = await Promise.all([repo.listDocuments(), repo.listAllocations(), repo.listExpenses(),
      repo.listVatPeriods(), repo.getTaxProfile(), repo.listSubmissions()]);
    return { docs, allocations, expenses, vat, tax, subs };
  }, [repo]);
  return (
    <section className="card" aria-labelledby="rep-h">
      <h2 id="rep-h">דוחות והגשות — הכנה והגשה מודרכת</h2>
      <div className="notice notice-warning" role="note">
        אין חיבור ישיר למערכות רשות המסים או ביטוח לאומי: חיבור כזה מחייב רישום כבית תוכנה בשע"ם, שלא בוצע. כאן מוכנים הנתונים, ההגשה עצמה נעשית באתר הרשמי,
        ואחריה מזינים את מספר האסמכתה. האפליקציה לא מגישה ולא משלמת.
      </div>
      <label>שנת מס <select value={year} onChange={(e) => setYear(Number(e.target.value))} style={{ width: 'auto' }}>
        {[0, 1, 2].map((i) => new Date().getFullYear() - i).map((y) => <option key={y}>{y}</option>)}</select></label>
      <DataState state={state} retry={retry}>
        {(d) => {
          const s = yearSummary(d.docs, d.allocations, year);
          const vat = vatStatusOn(d.vat, `${year}-12-31`);
          const expenses = d.expenses.filter((e) => e.doc_date.startsWith(String(year))).reduce((x, e) => x + e.amount_agorot, 0);
          const rules = rulesFor(year);
          const values: Record<SubmissionKind, [string, string][]> = {
            vat_exempt_declaration: [['מחזור לפי קבלות (תקבולים בפועל)', formatILS(s.received)], ['לבדיקה: סכום חשבוניות עסקה שהופקו', formatILS(s.invoiced)],
              ...(rules ? [['תקרת עוסק פטור לשנה', formatILS(rules.exemptDealerCeiling.amount)] as [string, string]] : [])],
            small_business_report: [['מחזור לפי קבלות', formatILS(s.received)], ['ניכוי 30%', formatILS(Math.round(s.received * 0.3))], ['הכנסה חייבת משוערת מהעסק (70%)', formatILS(s.received - Math.round(s.received * 0.3))]],
            annual_1301: [['הכנסות מהעסק לפי קבלות', formatILS(s.received)], ['הוצאות שנרשמו (לא כולן מוכרות)', formatILS(expenses)],
              ['משכורת', d.tax?.employed === 'yes' ? 'כן — צרפו טופס 106 מהמעסיק' : d.tax?.employed === 'no' ? 'לא' : 'לא ידוע']],
            income_tax_advance: [['תקבולים בשנה (לפי קבלות)', formatILS(s.received)]],
            national_insurance: [['הכנסות מהעסק לפי קבלות', formatILS(s.received)]],
          };
          const kinds = applicableReports(vat, d.tax);
          return (<>
            {!d.tax?.onboarding_done && <p className="notice notice-info">הרשימה מבוססת על תשובות "לא יודע/ת". <a href="#/onboarding">השלמת הגדרה ראשונית</a> תצמצם אותה לדוחות שרלוונטיים לך.</p>}
            {kinds.map((k) => <ReportCard key={k} def={DEFS[k]} year={year} values={values[k]} existing={d.subs.find((x) => x.kind === k && x.tax_year === year && x.period === '') ?? null} onSaved={retry} />)}
          </>);
        }}
      </DataState>
    </section>
  );
}

function ReportCard({ def, year, values, existing, onSaved }: { def: ReportDef; year: number; values: [string, string][]; existing: Submission | null; onSaved: () => void }) {
  const repo = useRepo();
  const toast = useToast();
  const { busy, run } = useBusy();
  const [f, setF] = useState({ status: existing?.status ?? 'prepared', reference: existing?.reference ?? '', submitted_on: existing?.submitted_on ?? '',
    payment_status: existing?.payment_status ?? 'not_due', payment_reference: existing?.payment_reference ?? '', notes: existing?.notes ?? '' });
  const [error, setError] = useState<string | null>(null);
  const save = () => run(async () => {
    setError(null);
    if (f.status !== 'prepared' && !f.reference.trim()) { setError('יש להזין מספר אסמכתה מהאתר הרשמי לפני סימון כהוגש.'); return; }
    if (f.payment_status === 'paid' && !f.payment_reference.trim()) { setError('יש להזין אסמכתת תשלום לפני סימון כשולם.'); return; }
    try {
      await repo.saveSubmission({ kind: def.kind, tax_year: year, period: '', status: f.status as Submission['status'], reference: f.reference.trim(),
        submitted_on: f.submitted_on || null, payment_status: f.payment_status as Submission['payment_status'], payment_reference: f.payment_reference.trim(),
        prepared_values: Object.fromEntries(values), attachment_path: null, notes: f.notes }, existing?.id);
      toast('נשמר', 'success'); onSaved();
    } catch (e) { setError(errorMessage(e)); }
  });
  const copy = (v: string) => { void navigator.clipboard?.writeText(v.replace(/[^\d.,-]/g, '')).then(() => toast('הועתק', 'info'), () => {}); };
  return (
    <article className="card" aria-label={def.title} data-testid={`report-${def.kind}`}>
      <h3>{def.title} — {year} <span className="tag">{STATUS_LABEL[(existing?.status ?? 'prepared') as keyof typeof STATUS_LABEL]}</span></h3>
      <p className="muted">{def.when}. {def.note}</p>
      <table><tbody>{values.map(([k, v]) => (
        <tr key={k}><td>{k}</td><td className="num">{v}</td><td>{/[\d]/.test(v) && <button type="button" className="btn btn-secondary" onClick={() => copy(v)} aria-label={`העתקת ${k}`}>העתקה</button>}</td></tr>
      ))}</tbody></table>
      <p className="muted">הנתונים מחושבים ממה שנרשם באפליקציה ואינם בדיקת זכאות או ייעוץ מס. לפני הגשה — בדקו מול המסמכים ובמידת הצורך מול רו"ח.</p>
      <a className="btn" href={def.url} target="_blank" rel="noopener noreferrer">פתיחת השירות הרשמי ↗</a>
      <details style={{ marginTop: 8 }} open={!!existing}>
        <summary>אחרי ההגשה: תיעוד אסמכתה ותשלום</summary>
        <form onSubmit={(e) => { e.preventDefault(); void save(); }} noValidate>
          <div className="grid grid-2">
            <Field label="מצב">{(a) => <select {...a} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as typeof f.status })}>
              {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>}</Field>
            <Field label="מספר אסמכתה מהאתר הרשמי">{(a) => <input {...a} dir="ltr" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} />}</Field>
            <Field label="תאריך הגשה">{(a) => <input {...a} type="date" value={f.submitted_on} onChange={(e) => setF({ ...f, submitted_on: e.target.value })} />}</Field>
            <Field label="תשלום">{(a) => <select {...a} value={f.payment_status} onChange={(e) => setF({ ...f, payment_status: e.target.value as typeof f.payment_status })}>
              <option value="not_due">אין תשלום / לא ידוע</option><option value="payment_pending">ממתין לתשלום</option><option value="paid">שולם</option></select>}</Field>
            <Field label="אסמכתת תשלום">{(a) => <input {...a} dir="ltr" value={f.payment_reference} onChange={(e) => setF({ ...f, payment_reference: e.target.value })} />}</Field>
            <Field label="הערות">{(a) => <input {...a} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />}</Field>
          </div>
          {error && <p className="notice notice-error" role="alert">{error}</p>}
          <button className="btn btn-secondary" type="submit" disabled={busy}>{busy ? 'שומר…' : 'שמירת תיעוד'}</button>
        </form>
      </details>
    </article>
  );
}
