import { BackupPanel } from './Backup';
import { useEffect, useState } from 'react';
import { useRepo } from '../App';
import { VAT_STATUS_LABEL, type VatStatus } from '../domain/classification';
import { DOC_TYPE_LABEL, creatableDocTypes, type DocType } from '../domain/documents';
import { errorMessage } from '../domain/errors';
import { DemoRepo } from '../data/demoRepo';
import { DataState, Field, fmtDate, useAsync, useBusy, useToast } from '../ui/kit';
import type { Profile } from '../data/types';

const emptyProfile: Profile = { legal_name: '', business_name: '', id_number: '', address: '', phone: '', email: '' };

export function SettingsPage() {
  const repo = useRepo();
  const toast = useToast();
  const { busy, run } = useBusy();
  const [state, retry] = useAsync(async () => {
    const [profile, vat, series] = await Promise.all([repo.getProfile(), repo.listVatPeriods(), repo.listSeries()]);
    return { profile, vat, series };
  }, [repo]);
  const [profile, setProfile] = useState<Profile>(emptyProfile);
  const [vatForm, setVatForm] = useState<{ status: VatStatus; from: string }>({ status: 'exempt', from: '' });
  const [seriesForm, setSeriesForm] = useState<{ type: DocType; start: string }>({ type: 'transaction_invoice', start: '1' });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (state.status === 'ready') setProfile(state.data.profile ?? emptyProfile); }, [state]);

  const act = (fn: () => Promise<void>, ok: string) => run(async () => {
    setError(null);
    try { await fn(); toast(ok, 'success'); retry(); } catch (e) { setError(errorMessage(e)); }
  });

  return (
    <>
      <h1>הגדרות</h1>
      {error && <div className="notice notice-error" role="alert">{error}</div>}
      <DataState state={state} retry={retry}>
        {({ vat, series }) => (
          <>
            <section className="card" aria-labelledby="profile-h">
              <h2 id="profile-h">פרטי העסק</h2>
              <p className="muted">מופיעים על כל מסמך. שינוי כאן לא משנה מסמכים שכבר הופקו.</p>
              <form onSubmit={(e) => { e.preventDefault(); void act(() => repo.saveProfile(profile), 'פרטי העסק נשמרו'); }}>
                <div className="grid grid-2">
                  <Field label="שם מלא (חובה להפקה)">{(a) => <input {...a} value={profile.legal_name} onChange={(e) => setProfile({ ...profile, legal_name: e.target.value })} />}</Field>
                  <Field label="שם העסק">{(a) => <input {...a} value={profile.business_name} onChange={(e) => setProfile({ ...profile, business_name: e.target.value })} />}</Field>
                  <Field label="מספר זהות / עוסק (חובה להפקה)">{(a) => <input {...a} dir="ltr" inputMode="numeric" value={profile.id_number} onChange={(e) => setProfile({ ...profile, id_number: e.target.value })} />}</Field>
                  <Field label="כתובת (חובה להפקה)">{(a) => <input {...a} value={profile.address} onChange={(e) => setProfile({ ...profile, address: e.target.value })} />}</Field>
                  <Field label="טלפון">{(a) => <input {...a} type="tel" dir="ltr" value={profile.phone} onChange={(e) => setProfile({ ...profile, phone: e.target.value })} />}</Field>
                  <Field label="דוא״ל">{(a) => <input {...a} type="email" dir="ltr" value={profile.email} onChange={(e) => setProfile({ ...profile, email: e.target.value })} />}</Field>
                </div>
                <button className="btn" type="submit" disabled={busy}>שמירה</button>
              </form>
            </section>

            <section className="card" aria-labelledby="vat-h">
              <h2 id="vat-h">סטטוס מע"מ — היסטוריה</h2>
              <p className="muted">כל מסמך נבדק מול הסטטוס שחל בתאריך שלו. הוספת סטטוס חדש לא משנה את העבר.</p>
              {vat.length ? (
                <ul>{vat.map((p) => <li key={p.id}>{VAT_STATUS_LABEL[p.status]} מ-<span className="num">{fmtDate(p.effective_from)}</span>{p.effective_to ? <> עד <span className="num">{fmtDate(p.effective_to)}</span></> : ' ואילך'}</li>)}</ul>
              ) : <p className="notice notice-warning">לא הוגדר סטטוס. בלי סטטוס לא ניתן להפיק מסמכים.</p>}
              <form className="grid grid-2" onSubmit={(e) => { e.preventDefault(); if (!vatForm.from) { setError('יש לבחור תאריך תחילה'); return; }
                void act(() => repo.addVatPeriod({ status: vatForm.status, effective_from: vatForm.from, effective_to: null, note: '' }), 'הסטטוס נוסף'); }}>
                <Field label="סטטוס">{(a) => <select {...a} value={vatForm.status} onChange={(e) => setVatForm({ ...vatForm, status: e.target.value as VatStatus })}>
                  <option value="exempt">עוסק פטור</option><option value="licensed">עוסק מורשה</option></select>}</Field>
                <Field label="בתוקף מתאריך">{(a) => <input {...a} type="date" value={vatForm.from} onChange={(e) => setVatForm({ ...vatForm, from: e.target.value })} />}</Field>
                <div><button className="btn btn-secondary" type="submit" disabled={busy}>הוספת סטטוס</button></div>
              </form>
              {vatForm.status === 'licensed' && <p className="muted">מסמכי מע"מ (חשבונית מס וכו') עדיין לא נתמכים בגרסה הזו.</p>}
            </section>

            <section className="card" aria-labelledby="series-h">
              <h2 id="series-h">סדרות מספור</h2>
              <p className="muted">המספר מוקצה בשרת רק בהפקה, בטרנזקציה אחת — גם משני מכשירים במקביל לא ייווצר מספר כפול. אי אפשר להחזיר מספור לאחור.</p>
              {series.length ? (
                <ul>{series.map((s) => <li key={s.id}>{DOC_TYPE_LABEL[s.doc_type]} — {s.name}: המספר הבא <span className="num">{s.next_number}</span>{s.is_legacy && ' (היסטורית)'}</li>)}</ul>
              ) : <p>אין סדרות עדיין.</p>}
              <form className="grid grid-2" onSubmit={(e) => { e.preventDefault(); const n = Number(seriesForm.start);
                if (!Number.isInteger(n) || n < 1) { setError('מספר התחלה חייב להיות שלם וחיובי'); return; }
                void act(async () => { await repo.addSeries({ doc_type: seriesForm.type, name: DOC_TYPE_LABEL[seriesForm.type], next_number: n }); }, 'הסדרה נוצרה'); }}>
                <Field label="סוג מסמך">{(a) => <select {...a} value={seriesForm.type} onChange={(e) => setSeriesForm({ ...seriesForm, type: e.target.value as DocType })}>
                  {creatableDocTypes('exempt').map((t) => <option key={t} value={t}>{DOC_TYPE_LABEL[t]}</option>)}</select>}</Field>
                <Field label="מספר ראשון">{(a) => <input {...a} inputMode="numeric" value={seriesForm.start} onChange={(e) => setSeriesForm({ ...seriesForm, start: e.target.value })} />}</Field>
                <div><button className="btn btn-secondary" type="submit" disabled={busy}>יצירת סדרה</button></div>
              </form>
            </section>

            <section className="card" aria-labelledby="data-h">
              <h2 id="data-h">נתונים ופרטיות</h2>
              {repo.mode === 'demo' ? (
                <>
                  <p>אתם במצב דמו. הנתונים סינתטיים ונשמרים רק בדפדפן הזה.</p>
                  <button className="btn btn-danger" onClick={() => { if (window.confirm('לאפס את נתוני הדמו?')) { DemoRepo.reset(); window.location.reload(); } }}>איפוס נתוני דמו</button>
                </>
              ) : (
                <p>הנתונים נשמרים בבסיס הנתונים המשותף (Supabase), עם גישה לחשבון שלך בלבד. גיבוי מלא, שחזור וייבוא — למטה.</p>
              )}
            </section>
            <BackupPanel />
          </>
        )}
      </DataState>
    </>
  );
}
