import { useMemo, useState } from 'react';
import { useRepo } from '../App';
import { DOC_TYPE_LABEL, type DocType } from '../domain/documents';
import { DataState, Money, fmtDate, useAsync } from '../ui/kit';
import type { Doc } from '../data/types';

export const STATUS_LABEL: Record<Doc['status'], string> = { draft: 'טיוטה', issued: 'הופק', cancelled: 'בוטל' };

export function StatusTag({ status }: { status: Doc['status'] }) {
  return <span className={`tag tag-${status}`}>{STATUS_LABEL[status]}</span>;
}

const norm = (s: string) => s.toLowerCase().replace(/["'״׳]/g, '').trim();

/** Free-text match on number, customer, line descriptions and notes. */
export function matchesQuery(d: Doc, customerName: string, q: string): boolean {
  if (!q.trim()) return true;
  const hay = norm([d.number ?? '', customerName, d.notes, ...d.lines.map((l) => l.description), DOC_TYPE_LABEL[d.doc_type]].join(' '));
  return norm(q).split(/\s+/).every((t) => hay.includes(t));
}

export function DocumentsPage() {
  const repo = useRepo();
  const [state, retry] = useAsync(async () => {
    const [docs, customers] = await Promise.all([repo.listDocuments(), repo.listCustomers()]);
    return { docs, customers };
  }, [repo]);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'all' | Doc['status']>('all');
  const [type, setType] = useState<'all' | DocType>('all');
  const [year, setYear] = useState('all');
  const [customer, setCustomer] = useState('all');
  return (
    <>
      <h1>מסמכים</h1>
      <div className="btn-row" style={{ marginBottom: 12 }}>
        <a className="btn" href="#/documents/new">+ מסמך חדש</a>
      </div>
      <p className="muted">מסמך שהופק אינו ניתן לעריכה או למחיקה. תיקון נעשה במסמך ביטול שמפנה למקור.</p>
      <DataState state={state} retry={retry}>
        {({ docs, customers }) => {
          const custName = (d: Doc) => d.customer_snapshot?.name ?? customers.find((c) => c.id === d.customer_id)?.name ?? '';
          return <DocumentsTable docs={docs} custName={custName} customers={customers} filters={{ q, setQ, status, setStatus, type, setType, year, setYear, customer, setCustomer }} />;
        }}
      </DataState>
    </>
  );
}

interface Filters {
  q: string; setQ: (v: string) => void; status: 'all' | Doc['status']; setStatus: (v: 'all' | Doc['status']) => void;
  type: 'all' | DocType; setType: (v: 'all' | DocType) => void; year: string; setYear: (v: string) => void; customer: string; setCustomer: (v: string) => void;
}

function DocumentsTable({ docs, custName, customers, filters: f }: { docs: Doc[]; custName: (d: Doc) => string; customers: { id: string; name: string }[]; filters: Filters }) {
  const years = useMemo(() => [...new Set(docs.map((d) => d.issue_date.slice(0, 4)))].sort().reverse(), [docs]);
  const types = useMemo(() => [...new Set(docs.map((d) => d.doc_type))], [docs]);
  const list = docs.filter((d) => (f.status === 'all' || d.status === f.status) && (f.type === 'all' || d.doc_type === f.type)
    && (f.year === 'all' || d.issue_date.startsWith(f.year)) && (f.customer === 'all' || d.customer_id === f.customer)
    && matchesQuery(d, custName(d), f.q));
  const total = list.filter((d) => d.status !== 'draft').reduce((s, d) => s + (d.total_agorot ?? 0), 0);
  return (<>
    <form className="card filters" role="search" aria-label="חיפוש וסינון מסמכים" onSubmit={(e) => e.preventDefault()}>
      <div className="grid grid-filters">
        <label>חיפוש<input type="search" value={f.q} onChange={(e) => f.setQ(e.target.value)} placeholder="מספר, לקוח, תיאור…" /></label>
        <label>סוג<select value={f.type} onChange={(e) => f.setType(e.target.value as Filters['type'])}>
          <option value="all">הכל</option>{types.map((t) => <option key={t} value={t}>{DOC_TYPE_LABEL[t]}</option>)}</select></label>
        <label>מצב<select value={f.status} onChange={(e) => f.setStatus(e.target.value as Filters['status'])}>
          <option value="all">הכל</option><option value="draft">טיוטות</option><option value="issued">הופקו</option><option value="cancelled">בוטלו</option></select></label>
        <label>שנה<select value={f.year} onChange={(e) => f.setYear(e.target.value)}><option value="all">הכל</option>{years.map((y) => <option key={y}>{y}</option>)}</select></label>
        <label>לקוח<select value={f.customer} onChange={(e) => f.setCustomer(e.target.value)}><option value="all">הכל</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      </div>
    </form>
    <p role="status" data-testid="documents-count">{list.length} מסמכים{list.length ? <> · סכום (ללא טיוטות) <Money agorot={total} /></> : null}</p>
    {!list.length ? <div className="card"><p>אין מסמכים להצגה.</p></div> : (
      <div className="card table-wrap">
        <table>
          <caption className="sr-only">רשימת מסמכים</caption>
          <thead><tr><th scope="col">סוג</th><th scope="col">מספר</th><th scope="col">לקוח</th><th scope="col">תאריך</th><th scope="col">סכום</th><th scope="col">מצב</th></tr></thead>
          <tbody>
            {list.map((d) => (
              <tr key={d.id}>
                <td><a href={`#/documents/${d.id}`}>{DOC_TYPE_LABEL[d.doc_type]}</a></td>
                <td className="num">{d.number ?? '—'}</td>
                <td>{d.customer_id ? <a href={`#/customers/${d.customer_id}`}><bdi>{custName(d)}</bdi></a> : <bdi>{custName(d)}</bdi>}</td>
                <td className="num">{fmtDate(d.issue_date)}</td>
                <td><Money agorot={d.total_agorot} /></td>
                <td><StatusTag status={d.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}
  </>);
}
