import { useState } from 'react';
import { useRepo } from '../App';
import { DOC_TYPE_LABEL } from '../domain/documents';
import { errorMessage } from '../domain/errors';
import { DataState, Money, fmtDate, useAsync, useBusy, useToast } from '../ui/kit';
import { CustomerFields } from './CustomerForm';
import { StatusTag } from './Documents';
import type { Customer } from '../data/types';

/** One customer: details, balance, and the full history of documents and payments. */
export function CustomerPage({ id }: { id: string }) {
  const repo = useRepo();
  const [state, retry] = useAsync(async () => {
    const [customers, docs, balances, allocations] = await Promise.all([repo.listCustomers(), repo.listDocuments(), repo.listInvoiceBalances(), repo.listAllocations()]);
    return { customer: customers.find((c) => c.id === id) ?? null, docs: docs.filter((d) => d.customer_id === id), balances: balances.filter((b) => b.customer_id === id), allocations };
  }, [repo, id]);
  return (
    <DataState state={state} retry={retry}>
      {({ customer, docs, balances, allocations }) => {
        if (!customer) return <div className="notice notice-error" role="alert">הלקוח לא נמצא.</div>;
        const open = balances.reduce((s, b) => s + b.balance_agorot, 0);
        const invoiced = balances.reduce((s, b) => s + b.total_agorot, 0);
        const receipts = docs.filter((d) => d.doc_type === 'receipt' && d.status === 'issued');
        const received = receipts.reduce((s, d) => s + (d.total_agorot ?? 0), 0);
        const allocated = allocations.filter((a) => receipts.some((r) => r.id === a.receipt_id)).reduce((s, a) => s + a.amount_agorot, 0);
        const sorted = [...docs].sort((a, b) => (a.issue_date === b.issue_date ? (a.created_at < b.created_at ? 1 : -1) : a.issue_date < b.issue_date ? 1 : -1));
        return (<>
          <h1><bdi>{customer.name}</bdi></h1>
          <div className="btn-row" style={{ marginBottom: 12 }}>
            <a className="btn" href={`#/documents/new?type=transaction_invoice&customer=${customer.id}`}>+ חשבונית עסקה</a>
            <a className="btn btn-secondary" href={`#/documents/new?type=receipt&customer=${customer.id}`}>₪ קבלה על תשלום</a>
            <a className="btn btn-secondary" href="#/income">חזרה ללקוחות</a>
          </div>
          <div className="grid grid-cards" style={{ marginBottom: 12 }}>
            <div className="metric"><div className="kind">יתרה פתוחה</div><div className="value"><Money agorot={open} /></div>
              <div className="def">חשבוניות עסקה פתוחות פחות תשלומים ששויכו.</div></div>
            <div className="metric"><div className="kind">חויב (חשבוניות שהופקו)</div><div className="value"><Money agorot={invoiced} /></div></div>
            <div className="metric"><div className="kind">התקבל (קבלות)</div><div className="value"><Money agorot={received} /></div>
              {received > allocated && <div className="def">מזה <Money agorot={received - allocated} /> לא שויך לחשבונית (זכות/מקדמה).</div>}</div>
          </div>
          <CustomerEdit customer={customer} onSaved={retry} />
          <section className="card table-wrap" aria-labelledby="hist-h">
            <h2 id="hist-h">היסטוריה</h2>
            {!sorted.length ? <p className="muted">אין עדיין מסמכים ללקוח הזה.</p> : (
              <table>
                <thead><tr><th scope="col">תאריך</th><th scope="col">מסמך</th><th scope="col">סכום</th><th scope="col">מצב</th><th scope="col">פרטים</th></tr></thead>
                <tbody>{sorted.map((d) => {
                  const b = balances.find((x) => x.invoice_id === d.id);
                  const paid = allocations.filter((a) => a.receipt_id === d.id);
                  return (
                    <tr key={d.id}>
                      <td className="num">{fmtDate(d.issue_date)}</td>
                      <td><a href={`#/documents/${d.id}`}>{DOC_TYPE_LABEL[d.doc_type]} {d.number !== null && <span className="num">{d.number}</span>}</a></td>
                      <td><Money agorot={d.total_agorot} /></td>
                      <td><StatusTag status={d.status} /></td>
                      <td className="muted">
                        {b && (b.balance_agorot > 0 ? <>פתוח <Money agorot={b.balance_agorot} /></> : 'שולם במלואו')}
                        {paid.length > 0 && <>על חשבון {paid.map((a) => docs.find((x) => x.id === a.invoice_id)?.number).join(', ')}</>}
                      </td>
                    </tr>
                  );
                })}</tbody>
              </table>
            )}
          </section>
        </>);
      }}
    </DataState>
  );
}

function CustomerEdit({ customer, onSaved }: { customer: Customer; onSaved: () => void }) {
  const repo = useRepo();
  const toast = useToast();
  const { busy, run } = useBusy();
  const [open, setOpen] = useState(false);
  const { id: _id, ...rest } = customer;
  const [form, setForm] = useState(rest);
  const [error, setError] = useState<string | null>(null);
  const save = () => run(async () => {
    setError(null);
    if (!form.name.trim()) { setError('שם הלקוח הוא שדה חובה'); return; }
    try { await repo.updateCustomer({ ...form, id: customer.id }); toast('הלקוח עודכן. מסמכים שהופקו שומרים את הפרטים מיום הפקתם.', 'success'); setOpen(false); onSaved(); }
    catch (e) { setError(errorMessage(e)); }
  });
  return (
    <section className="card" aria-labelledby="cust-det-h">
      <h2 id="cust-det-h">פרטים</h2>
      {!open ? (<>
        <p>{customer.address || <span className="muted">אין כתובת</span>}{customer.tax_id && <> · ח.פ./ת.ז. <span className="num">{customer.tax_id}</span></>}
          {customer.email && <> · <span className="ltr">{customer.email}</span></>}{customer.phone && <> · <span className="ltr">{customer.phone}</span></>}</p>
        <button className="btn btn-secondary" onClick={() => setOpen(true)}>עריכת פרטים</button>
      </>) : (
        <form onSubmit={(e) => { e.preventDefault(); void save(); }} noValidate>
          <CustomerFields form={form} setForm={setForm} nameError={error && !form.name.trim() ? error : null} />
          {error && form.name.trim() && <p className="notice notice-error" role="alert">{error}</p>}
          <div className="btn-row">
            <button className="btn" type="submit" disabled={busy}>{busy ? 'שומר…' : 'שמירה'}</button>
            <button className="btn btn-secondary" type="button" onClick={() => { setOpen(false); setForm(rest); }}>ביטול</button>
          </div>
        </form>
      )}
    </section>
  );
}
