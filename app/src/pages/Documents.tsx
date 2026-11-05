import { useState } from 'react';
import { useRepo } from '../App';
import { DOC_TYPE_LABEL } from '../domain/documents';
import { DataState, Money, fmtDate, useAsync } from '../ui/kit';
import type { Doc } from '../data/types';

export const STATUS_LABEL: Record<Doc['status'], string> = { draft: 'טיוטה', issued: 'הופק', cancelled: 'בוטל' };

export function StatusTag({ status }: { status: Doc['status'] }) {
  return <span className={`tag tag-${status}`}>{STATUS_LABEL[status]}</span>;
}

export function DocumentsPage() {
  const repo = useRepo();
  const [filter, setFilter] = useState<'all' | Doc['status']>('all');
  const [state, retry] = useAsync(() => repo.listDocuments(), [repo]);
  return (
    <>
      <h1>מסמכים</h1>
      <div className="btn-row" style={{ marginBottom: 12 }}>
        <a className="btn" href="#/documents/new">+ מסמך חדש</a>
        <label className="muted" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          סינון
          <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} style={{ width: 'auto' }}>
            <option value="all">הכל</option><option value="draft">טיוטות</option>
            <option value="issued">הופקו</option><option value="cancelled">בוטלו</option>
          </select>
        </label>
      </div>
      <p className="muted">מסמך שהופק אינו ניתן לעריכה או למחיקה. תיקון נעשה במסמך ביטול שמפנה למקור.</p>
      <DataState state={state} retry={retry}>
        {(docs) => {
          const list = docs.filter((d) => filter === 'all' || d.status === filter);
          if (!list.length) return <div className="card"><p>אין מסמכים להצגה.</p></div>;
          return (
            <div className="card table-wrap">
              <table>
                <caption className="sr-only">רשימת מסמכים</caption>
                <thead><tr><th scope="col">סוג</th><th scope="col">מספר</th><th scope="col">לקוח</th><th scope="col">תאריך</th><th scope="col">סכום</th><th scope="col">מצב</th></tr></thead>
                <tbody>
                  {list.map((d) => (
                    <tr key={d.id}>
                      <td><a href={`#/documents/${d.id}`}>{DOC_TYPE_LABEL[d.doc_type]}</a></td>
                      <td className="num">{d.number ?? '—'}</td>
                      <td><bdi>{d.customer_snapshot?.name ?? ''}</bdi></td>
                      <td className="num">{fmtDate(d.issue_date)}</td>
                      <td><Money agorot={d.total_agorot} /></td>
                      <td><StatusTag status={d.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }}
      </DataState>
    </>
  );
}
