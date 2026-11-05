import { useState } from 'react';
import { useRepo } from '../App';
import { errorMessage } from '../domain/errors';
import { DataState, Field, useAsync, useBusy, useToast } from '../ui/kit';
import type { Customer } from '../data/types';

const empty: Omit<Customer, 'id'> = { name: '', tax_id: '', address: '', email: '', phone: '' };

export function IncomePage() {
  const repo = useRepo();
  const toast = useToast();
  const { busy, run } = useBusy();
  const [state, retry] = useAsync(() => repo.listCustomers(), [repo]);
  const [form, setForm] = useState(empty);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = () => run(async () => {
    setError(null);
    if (!form.name.trim()) { setError('שם הלקוח הוא שדה חובה'); return; }
    try {
      if (editing) await repo.updateCustomer({ ...form, id: editing });
      else await repo.addCustomer(form);
      toast(editing ? 'הלקוח עודכן. מסמכים שהופקו שומרים את הפרטים מיום הפקתם.' : 'הלקוח נוסף', 'success');
      setForm(empty); setEditing(null); retry();
    } catch (e) { setError(errorMessage(e)); }
  });

  return (
    <>
      <h1>הכנסות ולקוחות</h1>
      <div className="notice notice-info">רישום תשלום מתבצע כרגע בהפקת <a href="#/documents/new?type=receipt">קבלה</a>. שיוך תשלומים לחשבוניות ויתרות פתוחות — בשלב הבא.</div>
      <section className="card" aria-labelledby="cust-form-h">
        <h2 id="cust-form-h">{editing ? 'עריכת לקוח' : 'לקוח חדש'}</h2>
        <form onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate>
          <div className="grid grid-2">
            <Field label="שם (חובה)" error={error && !form.name.trim() ? error : null}>{(a) => <input {...a} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
            <Field label="ח.פ. / ת.ז.">{(a) => <input {...a} dir="ltr" inputMode="numeric" value={form.tax_id} onChange={(e) => setForm({ ...form, tax_id: e.target.value })} />}</Field>
            <Field label="כתובת" hint="נדרשת להפקת חשבונית עסקה.">{(a) => <input {...a} value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />}</Field>
            <Field label="דוא״ל">{(a) => <input {...a} type="email" dir="ltr" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />}</Field>
            <Field label="טלפון">{(a) => <input {...a} type="tel" dir="ltr" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />}</Field>
          </div>
          {error && form.name.trim() && <div className="notice notice-error" role="alert">{error}</div>}
          <div className="btn-row">
            <button className="btn" type="submit" disabled={busy}>{busy ? 'שומר…' : editing ? 'שמירת שינויים' : 'הוספת לקוח'}</button>
            {editing && <button className="btn btn-secondary" type="button" onClick={() => { setEditing(null); setForm(empty); }}>ביטול עריכה</button>}
          </div>
        </form>
      </section>
      <DataState state={state} retry={retry}>
        {(customers) => customers.length ? (
          <section className="card table-wrap" aria-labelledby="cust-list-h">
            <h2 id="cust-list-h">לקוחות</h2>
            <table>
              <thead><tr><th scope="col">שם</th><th scope="col">כתובת</th><th scope="col">ח.פ./ת.ז.</th><th scope="col"><span className="sr-only">פעולות</span></th></tr></thead>
              <tbody>{customers.map((c) => (
                <tr key={c.id}>
                  <td><bdi>{c.name}</bdi></td><td><bdi>{c.address}</bdi></td><td className="num">{c.tax_id}</td>
                  <td><button className="btn btn-secondary" onClick={() => { setEditing(c.id); const { id: _id, ...rest } = c; setForm(rest); window.scrollTo(0, 0); }}>עריכה</button></td>
                </tr>))}
              </tbody>
            </table>
          </section>
        ) : <p className="muted">אין לקוחות עדיין.</p>}
      </DataState>
    </>
  );
}
