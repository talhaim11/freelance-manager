import { useState } from 'react';
import { estimateIncomeTax, type EstimateInput, type Regime } from '../domain/tax/engine';
import { RULE_SETS, SUPPORTED_TAX_YEARS } from '../domain/tax/rules';
import { formatILS, parseShekels } from '../domain/money';
import { Field, Money } from '../ui/kit';

type Form = Record<'salary' | 'withheld' | 'turnover' | 'expenses' | 'points' | 'advances' | 'customersWithheld', string> & { regime: '' | Regime; year: string };

const opt = (s: string) => (s.trim() === '' ? null : parseShekels(s));

export function TaxesPage() {
  const [f, setF] = useState<Form>({ year: String(SUPPORTED_TAX_YEARS[SUPPORTED_TAX_YEARS.length - 1]), salary: '', withheld: '', turnover: '', expenses: '', points: '', advances: '', customersWithheld: '', regime: '' });
  const set = (k: keyof Form) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const input: EstimateInput = {
    taxYear: Number(f.year),
    salaryTaxable: opt(f.salary),
    salaryTaxWithheld: opt(f.withheld),
    businessTurnover: opt(f.turnover) ?? 0,
    regime: f.regime || null,
    allowedBusinessExpenses: opt(f.expenses),
    creditPoints: f.points.trim() === '' || !Number.isFinite(Number(f.points)) ? null : Number(f.points),
    advancesPaid: opt(f.advances) ?? 0,
    withheldByCustomers: opt(f.customersWithheld) ?? 0,
  };
  const r = estimateIncomeTax(input);
  const rules = RULE_SETS[Number(f.year)];

  return (
    <>
      <h1>מסים ודוחות</h1>
      <div className="notice notice-warning" role="note">
        <strong>הערכה בלבד.</strong> זה אינו ייעוץ מס ואינו סכום רשמי. ההערכה מחושבת בכללים קבועים ומתועדים, וחלקים ממנה אינם נכללים (פירוט למטה).
        לוח מועדים אישי ודוחות מודרכים יתווספו בשלב 3.
      </div>

      <section className="card" aria-labelledby="est-h">
        <h2 id="est-h">הערכת מס הכנסה שנתי — משכורת ועסק יחד</h2>
        <form onSubmit={(e) => e.preventDefault()}>
          <div className="grid grid-2">
            <Field label="שנת מס">{(a) => <select {...a} value={f.year} onChange={set('year')}>{SUPPORTED_TAX_YEARS.map((y) => <option key={y}>{y}</option>)}</select>}</Field>
            <Field label="מסלול מס הכנסה לעסק" hint='"עוסק פטור" הוא סטטוס מע"מ; "בעל עסק זעיר" הוא מסלול נפרד במס הכנסה, בכפוף לזכאות.'>
              {(a) => <select {...a} value={f.regime} onChange={set('regime')}>
                <option value="">לא ידוע</option><option value="regular">רגיל (הוצאות בפועל)</option><option value="small_business">בעל עסק זעיר (ניכוי 30%)</option>
              </select>}
            </Field>
            <Field label="הכנסה חייבת ממשכורת לשנה (₪)" hint="מטופס 106. אם אין משכורת — הזינו 0.">{(a) => <input {...a} inputMode="decimal" dir="ltr" value={f.salary} onChange={set('salary')} />}</Field>
            <Field label="מס שנוכה מהמשכורת (₪)" hint="מטופס 106.">{(a) => <input {...a} inputMode="decimal" dir="ltr" value={f.withheld} onChange={set('withheld')} />}</Field>
            <Field label="מחזור עסקי לשנה (₪)">{(a) => <input {...a} inputMode="decimal" dir="ltr" value={f.turnover} onChange={set('turnover')} />}</Field>
            {f.regime === 'regular' && <Field label="הוצאות מותרות בניכוי (₪)" hint="לא כל הוצאה בפועל מותרת בניכוי. אם לא ידוע — השאירו ריק.">{(a) => <input {...a} inputMode="decimal" dir="ltr" value={f.expenses} onChange={set('expenses')} />}</Field>}
            <Field label="נקודות זיכוי" hint="לתושב/ת: 2.25 לגבר, 2.75 לאישה, ועוד לפי נסיבות (ילדים, תואר ועוד). לא נניח בשבילך.">{(a) => <input {...a} inputMode="decimal" dir="ltr" value={f.points} onChange={set('points')} />}</Field>
            <Field label="מקדמות ששולמו (₪)">{(a) => <input {...a} inputMode="decimal" dir="ltr" value={f.advances} onChange={set('advances')} />}</Field>
            <Field label="מס שנוכה במקור ע״י לקוחות (₪)" hint="מאישורי 857.">{(a) => <input {...a} inputMode="decimal" dir="ltr" value={f.customersWithheld} onChange={set('customersWithheld')} />}</Field>
          </div>
        </form>

        <div role="status" aria-live="polite">
          {r.status === 'unsupported_year' && <div className="notice notice-error">{r.missing[0]}</div>}
          {r.status === 'incomplete' && (
            <div className="notice notice-warning"><strong>ההערכה לא שלמה — לא מוצג סכום.</strong><ul>{r.missing.map((m) => <li key={m}>{m}</li>)}</ul></div>
          )}
          {r.status === 'estimate' && (
            <>
              <p style={{ fontSize: '1.25rem' }}>
                <span className="tag tag-estimate">הערכה חלקית</span>{' '}
                מס שנתי משוער: <strong><Money agorot={r.taxLiability} /></strong> ·{' '}
                {r.remainingToPay! >= 0 ? <>יתרה משוערת לתשלום: <strong><Money agorot={r.remainingToPay} /></strong></> : <>החזר משוער: <strong><Money agorot={-r.remainingToPay!} /></strong></>}
              </p>
              {r.warnings.map((w) => <div key={w} className="notice notice-warning">{w}</div>)}
              <details>
                <summary>איך חושב</summary>
                <table><tbody>{r.steps.map((s, i) => (
                  <tr key={i}><td>{s.label}{s.detail && <div className="muted">{s.detail}</div>}</td><td>{typeof s.value === 'number' ? <span className="num">{formatILS(s.value)}</span> : s.value}</td></tr>
                ))}</tbody></table>
                <p className="muted">כללים: {r.ruleSetId} · שנת מס {r.taxYear} · חושב {new Date().toLocaleString('he-IL')}</p>
              </details>
              <details>
                <summary>מה לא נכלל</summary>
                <ul>{r.excluded.map((x) => <li key={x}>{x}</li>)}</ul>
              </details>
            </>
          )}
        </div>
      </section>

      {rules && (
        <section className="card" aria-labelledby="rules-h">
          <h2 id="rules-h">הכללים שבשימוש — {rules.taxYear} <span className="muted">({rules.id})</span></h2>
          <div className="table-wrap"><table>
            <thead><tr><th scope="col">מדרגה</th><th scope="col">עד הכנסה שנתית</th></tr></thead>
            <tbody>{rules.incomeTax.brackets.map((b) => (
              <tr key={b.rateBp}><td className="num">{b.rateBp / 100}%</td><td>{b.upTo === null ? 'ומעלה' : <Money agorot={b.upTo} />}</td></tr>
            ))}</tbody>
          </table></div>
          <ul>
            <li>מס יסף: {rules.incomeTax.surtax.rateBp / 100}% מעל <Money agorot={rules.incomeTax.surtax.threshold} /></li>
            <li>נקודת זיכוי: <Money agorot={rules.incomeTax.creditPointAnnual} /> לשנה</li>
            <li>תקרת עוסק פטור / בעל עסק זעיר: <Money agorot={rules.exemptDealerCeiling.amount} /></li>
          </ul>
          <p className="muted">מקורות (אומתו {rules.incomeTax.sources[0].verifiedAt}):</p>
          <ul className="muted">
            {[...rules.incomeTax.sources, ...rules.exemptDealerCeiling.sources, ...rules.smallBusiness.sources].map((s) => (
              <li key={s.url}><a href={s.url} target="_blank" rel="noopener noreferrer">{s.title}</a></li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
