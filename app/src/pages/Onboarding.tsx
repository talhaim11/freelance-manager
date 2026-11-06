import { useState } from 'react';
import { useRepo } from '../App';
import { errorMessage } from '../domain/errors';
import { navigate } from '../router';
import { DataState, Field, todayLocal, useAsync, useBusy, useToast } from '../ui/kit';
import type { Profile, Series, TaxProfile, Tristate } from '../data/types';

/** First-run setup in one page; every question can be answered "לא יודע/ת". Nothing is assumed. */
export function OnboardingPage() {
  const repo = useRepo();
  const [state, retry] = useAsync(async () => {
    const [profile, vat, series, tax] = await Promise.all([repo.getProfile(), repo.listVatPeriods(), repo.listSeries(), repo.getTaxProfile()]);
    return { profile, vat, series, tax };
  }, [repo]);
  return (
    <>
      <h1>הגדרה ראשונית</h1>
      <p className="muted">כמה דקות. אפשר לענות "לא יודע/ת" ולהשלים אחר כך בהגדרות. שום דבר לא מוגש לשום רשות.</p>
      <DataState state={state} retry={retry}>{(d) => <OnboardingForm {...d} />}</DataState>
    </>
  );
}

function OnboardingForm({ profile, vat, series, tax }: { profile: Profile | null; vat: { status: string }[]; series: Series[]; tax: TaxProfile | null }) {
  const repo = useRepo();
  const toast = useToast();
  const { busy, run } = useBusy();
  const [p, setP] = useState<Profile>(profile ?? { legal_name: '', business_name: '', id_number: '', address: '', phone: '', email: '' });
  const [vatStatus, setVatStatus] = useState<'exempt' | 'licensed' | ''>(vat.length ? '' : 'exempt');
  const [vatFrom, setVatFrom] = useState(`${new Date().getFullYear()}-01-01`);
  const [t, setT] = useState<Omit<TaxProfile, 'updated_at'>>(tax ?? { income_tax_regime: 'unknown', employed: 'unknown', ni_self_employed: 'unknown', advances_book: 'unknown', onboarding_done: false });
  const has = (type: Series['doc_type']) => series.some((s) => s.doc_type === type && !s.is_legacy);
  const [invStart, setInvStart] = useState('1');
  const [recStart, setRecStart] = useState('1');
  const [error, setError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const tri = (k: 'employed' | 'ni_self_employed' | 'advances_book', label: string, hint?: string) => (
    <Field label={label} hint={hint}>{(a) => (
      <select {...a} value={t[k]} onChange={(e) => setT({ ...t, [k]: e.target.value as Tristate })}>
        <option value="unknown">לא יודע/ת</option><option value="yes">כן</option><option value="no">לא</option>
      </select>)}</Field>
  );
  const save = () => run(async () => {
    setTried(true); setError(null);
    const starts = [invStart, recStart].map(Number);
    if (starts.some((n) => !Number.isInteger(n) || n < 1)) { setError('מספר התחלה חייב להיות מספר שלם חיובי'); return; }
    try {
      await repo.saveProfile(p);
      if (!vat.length && vatStatus) await repo.addVatPeriod({ status: vatStatus, effective_from: vatFrom, effective_to: null, note: 'הגדרה ראשונית' });
      if (!has('transaction_invoice')) await repo.addSeries({ doc_type: 'transaction_invoice', name: 'חשבוניות עסקה', next_number: starts[0] });
      if (!has('receipt')) await repo.addSeries({ doc_type: 'receipt', name: 'קבלות', next_number: starts[1] });
      await repo.saveTaxProfile({ ...t, onboarding_done: true });
      toast('ההגדרה נשמרה', 'success');
      navigate('/');
    } catch (e) { setError(errorMessage(e)); }
  });
  const missing = !p.legal_name.trim() || !p.id_number.trim() || !p.address.trim();
  return (
    <form onSubmit={(e) => { e.preventDefault(); void save(); }} noValidate>
      <section className="card" aria-labelledby="ob1"><h2 id="ob1">1. פרטי העסק (מודפסים על המסמכים)</h2>
        <div className="grid grid-2">
          <Field label="שם מלא (חובה להפקת מסמכים)" error={tried && !p.legal_name.trim() ? 'נדרש להפקת מסמכים' : null}>{(a) => <input {...a} value={p.legal_name} onChange={(e) => setP({ ...p, legal_name: e.target.value })} />}</Field>
          <Field label="שם העסק (אם יש)">{(a) => <input {...a} value={p.business_name} onChange={(e) => setP({ ...p, business_name: e.target.value })} />}</Field>
          <Field label="ת.ז. / מספר עוסק (חובה להפקה)" error={tried && !p.id_number.trim() ? 'נדרש להפקת מסמכים' : null}>{(a) => <input {...a} dir="ltr" inputMode="numeric" value={p.id_number} onChange={(e) => setP({ ...p, id_number: e.target.value })} />}</Field>
          <Field label="כתובת (חובה להפקה)" error={tried && !p.address.trim() ? 'נדרש להפקת מסמכים' : null}>{(a) => <input {...a} value={p.address} onChange={(e) => setP({ ...p, address: e.target.value })} />}</Field>
          <Field label="טלפון">{(a) => <input {...a} type="tel" dir="ltr" value={p.phone} onChange={(e) => setP({ ...p, phone: e.target.value })} />}</Field>
          <Field label="דוא״ל">{(a) => <input {...a} type="email" dir="ltr" value={p.email} onChange={(e) => setP({ ...p, email: e.target.value })} />}</Field>
        </div>
        {missing && tried && <p className="muted">אפשר לשמור גם בלי — אבל לא ניתן יהיה להפיק מסמכים עד שיושלם.</p>}
      </section>
      <section className="card" aria-labelledby="ob2"><h2 id="ob2">2. סטטוס מע"מ</h2>
        {vat.length ? <p>כבר מוגדר (אפשר לעדכן בהגדרות).</p> : (
          <div className="grid grid-2">
            <Field label="סטטוס" hint='עוסק פטור אינו גובה מע"מ ואינו מפיק חשבונית מס.'>{(a) => (
              <select {...a} value={vatStatus} onChange={(e) => setVatStatus(e.target.value as typeof vatStatus)}>
                <option value="exempt">עוסק פטור</option><option value="licensed">עוסק מורשה</option><option value="">לא יודע/ת — אגדיר אחר כך</option>
              </select>)}</Field>
            <Field label="בתוקף מתאריך">{(a) => <input {...a} type="date" value={vatFrom} max={todayLocal()} onChange={(e) => setVatFrom(e.target.value)} />}</Field>
          </div>)}
      </section>
      <section className="card" aria-labelledby="ob3"><h2 id="ob3">3. מס הכנסה וביטוח לאומי</h2>
        <div className="grid grid-2">
          <Field label="מסלול מס הכנסה לעסק" hint='"בעל עסק זעיר" הוא מסלול נפרד (ניכוי 30%) בכפוף לזכאות ולבקשה.'>{(a) => (
            <select {...a} value={t.income_tax_regime} onChange={(e) => setT({ ...t, income_tax_regime: e.target.value as TaxProfile['income_tax_regime'] })}>
              <option value="unknown">לא יודע/ת</option><option value="regular">רגיל (הוצאות בפועל, דוח שנתי)</option><option value="small_business">בעל עסק זעיר</option>
            </select>)}</Field>
          {tri('employed', 'האם את/ה גם שכיר/ה?', 'משפיע על דוח שנתי ותיאום מס.')}
          {tri('ni_self_employed', 'רשום/ה בביטוח לאומי כעצמאי/ת?')}
          {tri('advances_book', 'יש פנקס מקדמות למס הכנסה?')}
        </div>
      </section>
      <section className="card" aria-labelledby="ob4"><h2 id="ob4">4. מספור מסמכים</h2>
        <p className="muted">אם כבר הפקת חשבוניות או קבלות במקום אחר — המשך מהמספר הבא, כדי שלא יהיה מספר כפול. מסמכים מהאפליקציה הקודמת נשמרים בסדרה נפרדת עם המספרים המקוריים (ייבוא בהגדרות).</p>
        <div className="grid grid-2">
          {has('transaction_invoice') ? <p>סדרת חשבוניות עסקה קיימת.</p> :
            <Field label="המספר הבא לחשבונית עסקה">{(a) => <input {...a} inputMode="numeric" dir="ltr" value={invStart} onChange={(e) => setInvStart(e.target.value)} />}</Field>}
          {has('receipt') ? <p>סדרת קבלות קיימת.</p> :
            <Field label="המספר הבא לקבלה">{(a) => <input {...a} inputMode="numeric" dir="ltr" value={recStart} onChange={(e) => setRecStart(e.target.value)} />}</Field>}
        </div>
      </section>
      {error && <p className="notice notice-error" role="alert">{error}</p>}
      <div className="btn-row">
        <button className="btn" type="submit" disabled={busy}>{busy ? 'שומר…' : 'שמירה וסיום'}</button>
        <a className="btn btn-secondary" href="#/">אחר כך</a>
      </div>
    </form>
  );
}
