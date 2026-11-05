import { useEffect, useRef, useState } from 'react';
import { uuid } from '../lib/uuid';
import { useRepo } from '../App';
import { DOC_TYPE_LABEL, exemptTotals, lineTotal, PAYMENT_METHOD_LABEL } from '../domain/documents';
import { errorCode, errorMessage } from '../domain/errors';
import { navigate, useRoute } from '../router';
import { DataState, Dialog, Field, Money, fmtDate, useAsync, useBusy, useToast } from '../ui/kit';
import { StatusTag } from './Documents';
import type { Customer, Doc, Profile } from '../data/types';

export function DocumentView({ id }: { id: string }) {
  const repo = useRepo();
  const route = useRoute();
  const [state, retry] = useAsync(async () => {
    const doc = await repo.getDocument(id);
    const related = doc?.cancelled_by_document_id ? await repo.getDocument(doc.cancelled_by_document_id)
      : doc?.corrects_document_id ? await repo.getDocument(doc.corrects_document_id) : null;
    const [profile, customers] = await Promise.all([repo.getProfile(), repo.listCustomers()]);
    return { doc, related, profile, customers };
  }, [repo, id]);
  return (
    <DataState state={state} retry={retry}>
      {({ doc, related, profile, customers }) => doc
        ? <View doc={doc} related={related} profile={profile} customers={customers} reload={retry} autoIssue={route.includes('issue=1')} />
        : <div className="notice notice-error" role="alert">המסמך לא נמצא.</div>}
    </DataState>
  );
}

function View({ doc, related, profile, customers, reload, autoIssue }: {
  doc: Doc; related: Doc | null; profile: Profile | null; customers: Customer[]; reload: () => void; autoIssue: boolean;
}) {
  const repo = useRepo();
  const toast = useToast();
  const { busy, run } = useBusy();
  const [confirmIssue, setConfirmIssue] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [unknownOutcome, setUnknownOutcome] = useState(false);
  const cancelKey = useRef(uuid());

  useEffect(() => { if (autoIssue && doc.status === 'draft') setConfirmIssue(true); }, [autoIssue, doc.status]);

  const issue = () => run(async () => {
    setError(null); setUnknownOutcome(false);
    try {
      const d = await repo.issueDocument(doc.id);
      setConfirmIssue(false);
      toast(`הופק ${DOC_TYPE_LABEL[d.doc_type]} מספר ${d.number}`, 'success');
      navigate(`/documents/${d.id}`);
      reload();
    } catch (e) {
      // Network failure: the server may or may not have issued it. Retrying is safe (idempotent).
      // Close the dialog so the explanation and the retry button on the page are reachable.
      if (errorCode(e) === 'NETWORK') { setUnknownOutcome(true); setConfirmIssue(false); }
      setError(errorMessage(e));
    }
  });

  const cancel = () => run(async () => {
    setError(null);
    if (!reason.trim()) { setError('יש לציין סיבת ביטול'); return; }
    try {
      const c = await repo.cancelDocument(doc.id, reason, cancelKey.current);
      setConfirmCancel(false);
      toast(`הופק מסמך ביטול מספר ${c.number}`, 'success');
      reload();
    } catch (e) { setError(errorMessage(e)); }
  });

  const removeDraft = () => run(async () => {
    if (!window.confirm('למחוק את הטיוטה? טיוטה אינה מסמך שהופק ולכן ניתן למחוק אותה.')) return;
    try { await repo.deleteDraft(doc.id); toast('הטיוטה נמחקה', 'info'); navigate('/documents'); }
    catch (e) { setError(errorMessage(e)); }
  });

  const isDraft = doc.status === 'draft';
  return (
    <>
      <div className="no-print">
        <h1>{DOC_TYPE_LABEL[doc.doc_type]} {doc.number !== null && <span className="num">{doc.number}</span>} <StatusTag status={doc.status} /></h1>
        {isDraft && <div className="notice notice-info">זו טיוטה: אין לה מספר והיא אינה מסמך שהופק. אפשר לערוך או למחוק אותה.</div>}
        {doc.status === 'cancelled' && related && (
          <div className="notice notice-warning">המסמך בוטל ב<a href={`#/documents/${related.id}`}>מסמך ביטול מספר {related.number}</a>. תוכנו המקורי נשמר ללא שינוי.</div>
        )}
        {doc.doc_type === 'cancellation' && related && (
          <div className="notice notice-info">מסמך זה מבטל את <a href={`#/documents/${related.id}`}>{DOC_TYPE_LABEL[related.doc_type]} מספר {related.number}</a>.</div>
        )}
        {error && !confirmIssue && !confirmCancel && (
          <div className="notice notice-error" role="alert">
            <p>{error}</p>
            {unknownOutcome && <p>ייתכן שהמסמך כבר הופק. לחיצה על "נסה שוב" בטוחה — לא ייווצר מסמך כפול.</p>}
            {unknownOutcome && <div className="btn-row"><button className="btn" disabled={busy} onClick={() => void issue()}>נסה שוב</button>
              <button className="btn btn-secondary" onClick={reload}>בדוק מצב</button></div>}
          </div>
        )}
        <div className="btn-row" style={{ marginBottom: 16 }}>
          {isDraft && <>
            <button className="btn" onClick={() => { setError(null); setUnknownOutcome(false); setConfirmIssue(true); }} disabled={busy}>הפקת מסמך</button>
            <a className="btn btn-secondary" href={`#/documents/${doc.id}/edit`}>עריכה</a>
            <button className="btn btn-danger" onClick={() => void removeDraft()} disabled={busy}>מחיקת טיוטה</button>
          </>}
          {!isDraft && <button className="btn btn-secondary" onClick={() => window.print()}>הדפסה / שמירה כ-PDF</button>}
          {doc.status === 'issued' && doc.doc_type !== 'cancellation' &&
            <button className="btn btn-danger" onClick={() => { setError(null); setConfirmCancel(true); }}>ביטול באמצעות מסמך ביטול</button>}
          <a className="btn btn-secondary" href="#/documents">חזרה לרשימה</a>
        </div>
      </div>

      <Paper doc={doc} related={related} profile={profile} customers={customers} />

      <Dialog open={confirmIssue} title="להפיק את המסמך?" onClose={() => setConfirmIssue(false)}>
        <p>לאחר ההפקה יוקצה מספר רץ, והמסמך לא יהיה ניתן לעריכה או למחיקה. תיקון ייעשה רק במסמך ביטול.</p>
        {error && !unknownOutcome && <p className="notice notice-error" role="alert">{error}</p>}
        <div className="btn-row">
          <button className="btn" onClick={() => void issue()} disabled={busy}>{busy ? 'מפיק…' : 'כן, להפיק'}</button>
          <button className="btn btn-secondary" onClick={() => setConfirmIssue(false)} disabled={busy}>חזרה</button>
        </div>
      </Dialog>

      <Dialog open={confirmCancel} title="ביטול מסמך" onClose={() => setConfirmCancel(false)}>
        <p>יופק מסמך ביטול חדש עם מספר משלו, שמפנה למסמך המקורי. המסמך המקורי יישמר כפי שהוא ויסומן כמבוטל.</p>
        <Field label="סיבת הביטול (חובה)">{(a) => <input {...a} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
        {error && <p className="notice notice-error" role="alert">{error}</p>}
        <p className="muted">שימו לב: אם המסמך כבר נמסר ללקוח, ייתכן שנדרש למסור לו גם את מסמך הביטול. מומלץ לאמת את הנוהל עם רו"ח.</p>
        <div className="btn-row">
          <button className="btn btn-danger" onClick={() => void cancel()} disabled={busy}>{busy ? 'מבטל…' : 'הפקת מסמך ביטול'}</button>
          <button className="btn btn-secondary" onClick={() => setConfirmCancel(false)} disabled={busy}>חזרה</button>
        </div>
      </Dialog>
    </>
  );
}

function Paper({ doc, related, profile, customers }: { doc: Doc; related: Doc | null; profile: Profile | null; customers: Customer[] }) {
  // Issued documents always render from their snapshots; drafts preview current details.
  const issuer = doc.issuer_snapshot ?? profile;
  const customer = doc.customer_snapshot ?? customers.find((c) => c.id === doc.customer_id) ?? null;
  const total = doc.total_agorot ?? exemptTotals(doc.lines).total;
  const exempt = (doc.vat_status_at_issue ?? 'exempt') === 'exempt';
  return (
    <article className="doc-paper" aria-label="תצוגת המסמך">
      {doc.status === 'draft' && <div className="watermark">טיוטה — לא הופק</div>}
      {doc.status === 'cancelled' && <div className="watermark">בוטל{related ? ` — מסמך ביטול מס' ${related.number}` : ''}</div>}
      <header style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', borderBottom: '2px solid #111', paddingBottom: 12, marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: '1.4rem', fontWeight: 700 }}>{DOC_TYPE_LABEL[doc.doc_type]} {doc.number !== null && <span className="num">מס' {doc.number}</span>}</div>
          <div>תאריך: <span className="num">{fmtDate(doc.issue_date)}</span></div>
        </div>
        <div>
          <div style={{ fontWeight: 700 }}><bdi>{issuer?.legal_name}</bdi></div>
          {issuer?.business_name && <div><bdi>{issuer.business_name}</bdi></div>}
          <div><bdi>{issuer?.address}</bdi></div>
          <div>ת.ז./מס' עוסק: <span className="num">{issuer?.id_number}</span>{exempt && ' · עוסק פטור'}</div>
        </div>
      </header>
      <section style={{ marginBottom: 16 }}>
        <div className="muted">{doc.doc_type === 'receipt' ? 'התקבל מאת' : 'לכבוד'}</div>
        <div style={{ fontWeight: 600 }}><bdi>{customer?.name}</bdi></div>
        {customer?.address && <div><bdi>{customer.address}</bdi></div>}
        {customer?.tax_id && <div>ח.פ./ת.ז.: <span className="num">{customer.tax_id}</span></div>}
      </section>
      {doc.doc_type === 'cancellation' && related && (
        <p><strong>מבטל את {DOC_TYPE_LABEL[related.doc_type]} מס' <span className="num">{related.number}</span> מיום <span className="num">{fmtDate(related.issue_date)}</span>.</strong> סיבה: <bdi>{doc.correction_reason}</bdi></p>
      )}
      <table>
        <thead><tr><th>תיאור</th><th>כמות</th><th>מחיר</th><th>הנחה</th><th>סה"כ</th></tr></thead>
        <tbody>
          {doc.lines.map((l, i) => (
            <tr key={i}>
              <td><bdi>{l.description}</bdi></td>
              <td className="num">{l.quantity}</td>
              <td><Money agorot={l.unit_price_agorot} /></td>
              <td>{l.discount_agorot ? <Money agorot={l.discount_agorot} /> : '—'}</td>
              <td><Money agorot={lineTotal(l)} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ fontSize: '1.2rem', marginTop: 16 }}>{doc.doc_type === 'receipt' ? 'סכום שהתקבל' : 'סה"כ'}: <strong><Money agorot={total} /></strong></p>
      {doc.doc_type === 'receipt' && doc.payment_details.method && (
        <p>אמצעי תשלום: {PAYMENT_METHOD_LABEL[doc.payment_details.method]}
          {doc.payment_details.reference && <> · אסמכתה <span className="num">{doc.payment_details.reference}</span></>}
          {doc.payment_details.method === 'cheque' && <> · צ'ק <span className="num">{doc.payment_details.cheque_number}</span>, בנק {doc.payment_details.bank}, סניף <span className="num">{doc.payment_details.branch}</span>, לפירעון <span className="num">{fmtDate(doc.payment_details.due_date)}</span></>}
        </p>
      )}
      {doc.notes && <p style={{ whiteSpace: 'pre-wrap' }}><bdi>{doc.notes}</bdi></p>}
      <footer className="muted" style={{ borderTop: '1px solid #ddd', paddingTop: 8, marginTop: 16, fontSize: '.85rem' }}>
        {exempt && <div>עוסק פטור — עסקאותיו פטורות ממע"מ לפי סעיף 31(3) לחוק מע"מ</div>}
        <div>הופק במערכת ממוחשבת. תצוגה להדפסה — אינה "מסמך ממוחשב" חתום דיגיטלית.</div>
      </footer>
    </article>
  );
}
