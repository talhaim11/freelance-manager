import { useRef, useState } from 'react';
import { useRepo } from '../App';
import { errorMessage } from '../domain/errors';
import { uuid } from '../lib/uuid';
import { DataState, Money, fmtDate, todayLocal, useAsync, useBusy, useToast } from '../ui/kit';
import { CustomerFields, EMPTY_CUSTOMER } from './CustomerForm';
import type { InvoiceBalance } from '../data/types';

const AGE_BUCKETS = [
  { label: '0–30 ימים', max: 30 },
  { label: '31–60 ימים', max: 60 },
  { label: '61+ ימים', max: Infinity },
];

const ageDays = (issueDate: string, today: string) => Math.floor((Date.parse(today) - Date.parse(issueDate)) / 86_400_000);

export function IncomePage() {
  const repo = useRepo();
  const toast = useToast();
  const { busy, run } = useBusy();
  const [state, retry] = useAsync(async () => {
    const [customers, balances] = await Promise.all([repo.listCustomers(), repo.listInvoiceBalances()]);
    return { customers, balances };
  }, [repo]);
  const [form, setForm] = useState(EMPTY_CUSTOMER);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const addKey = useRef(uuid());

  const submit = () => run(async () => {
    setError(null); setTried(true);
    if (!form.name.trim()) return;
    try {
      if (editing) await repo.updateCustomer({ ...form, id: editing });
      else { await repo.addCustomer(form, addKey.current); addKey.current = uuid(); }
      toast(editing ? 'הלקוח עודכן. מסמכים שהופקו שומרים את הפרטים מיום הפקתם.' : 'הלקוח נוסף', 'success');
      setForm(EMPTY_CUSTOMER); setEditing(null); setTried(false); retry();
    } catch (e) { setError(errorMessage(e)); }
  });

  return (
    <>
      <h1>הכנסות ולקוחות</h1>
      <div className="btn-row" style={{ marginBottom: 16 }}>
        <a className="btn" href="#/documents/new?type=receipt">₪ רישום תשלום (קבלה)</a>
        <a className="btn btn-secondary" href="#/documents/new?type=transaction_invoice">+ חשבונית עסקה</a>
      </div>
      {/* The form stays mounted while lists load or fail, so typed input is never lost. */}
      <section className="card" aria-labelledby="cust-form-h">
        <h2 id="cust-form-h">{editing ? 'עריכת לקוח' : 'לקוח חדש'}</h2>
        <form onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate>
          <CustomerFields form={form} setForm={setForm} nameError={tried && !form.name.trim() ? 'שם הלקוח הוא שדה חובה' : null} />
          {error && <div className="notice notice-error" role="alert">{error}</div>}
          <div className="btn-row">
            <button className="btn" type="submit" disabled={busy}>{busy ? 'שומר…' : editing ? 'שמירת שינויים' : 'הוספת לקוח'}</button>
            {editing && <button className="btn btn-secondary" type="button" onClick={() => { setEditing(null); setForm(EMPTY_CUSTOMER); setTried(false); }}>ביטול עריכה</button>}
          </div>
        </form>
      </section>
      <DataState state={state} retry={retry}>
        {({ customers, balances }) => {
          const open = balances.filter((b) => b.balance_agorot > 0);
          const byCustomer = (id: string) => open.filter((b) => b.customer_id === id).reduce((s, b) => s + b.balance_agorot, 0);
          return (<>
            {customers.length ? (
              <section className="card table-wrap" aria-labelledby="cust-list-h">
                <h2 id="cust-list-h">לקוחות</h2>
                <table>
                  <thead><tr><th scope="col">שם</th><th scope="col">כתובת</th><th scope="col">יתרה פתוחה</th><th scope="col"><span className="sr-only">פעולות</span></th></tr></thead>
                  <tbody>{customers.map((c) => (
                    <tr key={c.id}>
                      <td><a href={`#/customers/${c.id}`}><bdi>{c.name}</bdi></a></td><td><bdi>{c.address}</bdi></td>
                      <td><Money agorot={byCustomer(c.id)} /></td>
                      <td><button className="btn btn-secondary" onClick={() => { setEditing(c.id); const { id: _id, ...rest } = c; setForm(rest); window.scrollTo(0, 0); }}>עריכה</button></td>
                    </tr>))}
                  </tbody>
                </table>
              </section>
            ) : <p className="muted">אין לקוחות עדיין.</p>}
            <Debtors open={open} customers={customers} />
          </>);
        }}
      </DataState>
    </>
  );
}

function Debtors({ open, customers }: { open: InvoiceBalance[]; customers: { id: string; name: string }[] }) {
  const today = todayLocal();
  const total = open.reduce((s, b) => s + b.balance_agorot, 0);
  const name = (id: string | null) => customers.find((c) => c.id === id)?.name ?? '';
  return (
    <section className="card" aria-labelledby="debt-h">
      <h2 id="debt-h">מי חייב לי</h2>
      {open.length === 0 ? <p className="muted">אין חשבוניות עסקה פתוחות.</p> : (<>
        <p>סה"כ פתוח: <strong><Money agorot={total} /></strong> ב-{open.length} חשבוניות.
          <span className="muted"> לפי חשבוניות עסקה שהופקו כאן, פחות תשלומים ששויכו אליהן בקבלות.</span></p>
        <div className="grid grid-cards" style={{ marginBottom: 12 }}>
          {AGE_BUCKETS.map((bucket, i) => {
            const min = i === 0 ? -Infinity : AGE_BUCKETS[i - 1].max;
            const sum = open.filter((b) => { const d = ageDays(b.issue_date, today); return d > min && d <= bucket.max; })
              .reduce((s, b) => s + b.balance_agorot, 0);
            return <div className="metric" key={bucket.label}><div className="kind">{bucket.label}</div><div className="value"><Money agorot={sum} /></div></div>;
          })}
        </div>
        <div className="table-wrap"><table>
          <thead><tr><th scope="col">לקוח</th><th scope="col">חשבונית</th><th scope="col">תאריך</th><th scope="col">שולם</th><th scope="col">יתרה</th><th scope="col"><span className="sr-only">פעולות</span></th></tr></thead>
          <tbody>{open.map((b) => (
            <tr key={b.invoice_id}>
              <td><a href={`#/customers/${b.customer_id}`}><bdi>{name(b.customer_id)}</bdi></a></td>
              <td><a href={`#/documents/${b.invoice_id}`}>מס' <span className="num">{b.number}</span></a></td>
              <td className="num">{fmtDate(b.issue_date)}</td>
              <td><Money agorot={b.paid_agorot} /></td>
              <td><Money agorot={b.balance_agorot} /></td>
              <td><a className="btn btn-secondary" href={`#/documents/new?type=receipt&from=${b.invoice_id}`}>קבלה על תשלום</a></td>
            </tr>))}
          </tbody>
        </table></div>
      </>)}
    </section>
  );
}
