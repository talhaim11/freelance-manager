import { useEffect, useMemo, useRef, useState } from 'react';
import { useRepo } from '../App';
import { vatStatusOn } from '../domain/classification';
import {
  creatableDocTypes, DOC_TYPE_LABEL, exemptTotals, issueProblems, lineProblems,
  PAYMENT_METHOD_LABEL, type DocLine, type DocType, type PaymentDetails, type PaymentMethod,
} from '../domain/documents';
import { errorMessage, ERROR_MESSAGES } from '../domain/errors';
import { agorotToShekelInput, parseShekels } from '../domain/money';
import { navigate } from '../router';
import { DataState, Field, Money, todayLocal, useAsync, useBusy, useToast } from '../ui/kit';

interface LineForm { description: string; quantity: string; price: string; discount: string }
const emptyLine = (): LineForm => ({ description: '', quantity: '1', price: '', discount: '' });

function toLines(forms: LineForm[]): { lines: DocLine[]; invalid: number[] } {
  const invalid: number[] = [];
  const lines = forms.map((f, i) => {
    const q = Number(f.quantity.replace(',', '.'));
    const p = parseShekels(f.price);
    const d = f.discount.trim() ? parseShekels(f.discount) : 0;
    if (!Number.isFinite(q) || p === null || d === null) invalid.push(i);
    return { description: f.description, quantity: Number.isFinite(q) ? q : 0, unit_price_agorot: p ?? -1, discount_agorot: d ?? -1 };
  });
  return { lines, invalid };
}

export function DocumentEditor({ draftId, initialType }: { draftId?: string; initialType?: string | null }) {
  const repo = useRepo();
  const [state, retry] = useAsync(async () => {
    const [series, customers, vat, profile, draft] = await Promise.all([
      repo.listSeries(), repo.listCustomers(), repo.listVatPeriods(), repo.getProfile(),
      draftId ? repo.getDocument(draftId) : Promise.resolve(null),
    ]);
    return { series, customers, vat, profile, draft };
  }, [repo, draftId]);
  return (
    <>
      <h1>{draftId ? 'עריכת טיוטה' : 'מסמך חדש'}</h1>
      <DataState state={state} retry={retry}>
        {(d) => {
          if (draftId && (!d.draft || d.draft.status !== 'draft')) {
            return <div className="notice notice-error" role="alert">{ERROR_MESSAGES.FINALIZED_DOCUMENT}</div>;
          }
          return <EditorForm {...d} initialType={initialType} onSeriesAdded={retry} />;
        }}
      </DataState>
    </>
  );
}

function EditorForm(props: {
  series: Awaited<ReturnType<ReturnType<typeof useRepo>['listSeries']>>;
  customers: Awaited<ReturnType<ReturnType<typeof useRepo>['listCustomers']>>;
  vat: Awaited<ReturnType<ReturnType<typeof useRepo>['listVatPeriods']>>;
  profile: Awaited<ReturnType<ReturnType<typeof useRepo>['getProfile']>>;
  draft: Awaited<ReturnType<ReturnType<typeof useRepo>['getDocument']>>;
  initialType?: string | null;
  onSeriesAdded: () => void;
}) {
  const repo = useRepo();
  const toast = useToast();
  const { busy, run } = useBusy();
  const draft = props.draft;
  // One key per editor session: repeated submits create a single draft.
  const idempotencyKey = useRef(draft?.idempotency_key ?? crypto.randomUUID());

  const [issueDate, setIssueDate] = useState(draft?.issue_date ?? todayLocal());
  const vatStatus = vatStatusOn(props.vat, issueDate);
  const allowedTypes = creatableDocTypes(vatStatus);
  const [docType, setDocType] = useState<DocType>(
    draft?.doc_type ?? (allowedTypes.includes(props.initialType as DocType) ? (props.initialType as DocType) : 'transaction_invoice'));
  const seriesForType = props.series.filter((s) => s.doc_type === docType && !s.is_legacy);
  const [seriesId, setSeriesId] = useState(draft?.series_id ?? '');
  const [customerId, setCustomerId] = useState(draft?.customer_id ?? '');
  const [notes, setNotes] = useState(draft?.notes ?? '');
  const [payment, setPayment] = useState<PaymentDetails>(draft?.payment_details ?? {});
  const [lineForms, setLineForms] = useState<LineForm[]>(draft?.lines.length
    ? draft.lines.map((l) => ({ description: l.description, quantity: String(l.quantity), price: agorotToShekelInput(l.unit_price_agorot), discount: l.discount_agorot ? agorotToShekelInput(l.discount_agorot) : '' }))
    : [emptyLine()]);
  const [newSeriesStart, setNewSeriesStart] = useState('1');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!seriesForType.some((s) => s.id === seriesId)) setSeriesId(seriesForType[0]?.id ?? '');
  }, [docType, props.series]); // eslint-disable-line react-hooks/exhaustive-deps

  const { lines, invalid } = useMemo(() => toLines(lineForms), [lineForms]);
  const totals = exemptTotals(lines.filter((_, i) => !invalid.includes(i)));
  const customer = props.customers.find((c) => c.id === customerId) ?? null;
  const problems = issueProblems({ docType, vatStatus, profile: props.profile, customer, lines, payment });
  const lineErrs = lineProblems(lines);

  const updateLine = (i: number, patch: Partial<LineForm>) => setLineForms((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const addSeries = () => run(async () => {
    const n = Number(newSeriesStart);
    if (!Number.isInteger(n) || n < 1) { setError('מספר התחלה חייב להיות מספר שלם חיובי'); return; }
    try {
      await repo.addSeries({ doc_type: docType, name: DOC_TYPE_LABEL[docType], next_number: n });
      toast('נוצרה סדרת מספור', 'success');
      props.onSeriesAdded();
    } catch (e) { setError(errorMessage(e)); }
  });

  const save = (thenIssue: boolean) => run(async () => {
    setError(null);
    if (!seriesId) { setError('יש ליצור סדרת מספור לסוג המסמך'); return; }
    if (invalid.length) { setError('יש סכומים לא תקינים בשורות'); return; }
    const input = { series_id: seriesId, doc_type: docType, issue_date: issueDate, customer_id: customerId || null, lines, notes, payment_details: docType === 'receipt' ? payment : {} };
    try {
      let id = draft?.id;
      if (id) await repo.updateDraft(id, input);
      else id = (await repo.createDraft({ ...input, idempotency_key: idempotencyKey.current })).id;
      toast('הטיוטה נשמרה. עדיין לא הופק מסמך.', 'success');
      navigate(`/documents/${id}${thenIssue ? '?issue=1' : ''}`);
    } catch (e) { setError(errorMessage(e)); }
  });

  if (!vatStatus) {
    return <div className="notice notice-warning" role="alert">לא הוגדר סטטוס מע"מ לתאריך {issueDate}. <a href="#/settings">הגדירו אותו בהגדרות</a> לפני יצירת מסמכים.
      <Field label="תאריך המסמך">{(a) => <input {...a} type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} />}</Field></div>;
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); void save(false); }} noValidate>
      <section className="card">
        <div className="grid grid-2">
          <Field label="סוג מסמך" hint={vatStatus === 'exempt' ? 'עוסק פטור אינו מפיק חשבונית מס ואינו גובה מע"מ.' : undefined}>
            {(a) => (
              <select {...a} value={docType} disabled={!!draft} onChange={(e) => setDocType(e.target.value as DocType)}>
                {allowedTypes.map((t) => <option key={t} value={t}>{DOC_TYPE_LABEL[t]}</option>)}
              </select>
            )}
          </Field>
          <Field label="תאריך המסמך">{(a) => <input {...a} type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} />}</Field>
          {seriesForType.length > 0 ? (
            <Field label="סדרת מספור" hint="המספר נקבע רק ברגע ההפקה, בשרת.">
              {(a) => (
                <select {...a} value={seriesId} onChange={(e) => setSeriesId(e.target.value)}>
                  {seriesForType.map((s) => <option key={s.id} value={s.id}>{s.name} (הבא: {s.next_number})</option>)}
                </select>
              )}
            </Field>
          ) : (
            <div className="notice notice-info">
              <p>אין עדיין סדרת מספור ל{DOC_TYPE_LABEL[docType]}.</p>
              <Field label="מספר המסמך הראשון בסדרה" hint="אם כבר הפקת מסמכים מסוג זה במקום אחר — המשך מהמספר הבא.">
                {(a) => <input {...a} inputMode="numeric" value={newSeriesStart} onChange={(e) => setNewSeriesStart(e.target.value)} />}
              </Field>
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void addSeries()}>יצירת סדרה</button>
            </div>
          )}
          <Field label="לקוח" hint={props.customers.length ? undefined : 'אין לקוחות עדיין — הוסיפו בעמוד הכנסות ולקוחות.'}
            error={problems.includes('CUSTOMER_ADDRESS_REQUIRED') ? ERROR_MESSAGES.CUSTOMER_ADDRESS_REQUIRED : null}>
            {(a) => (
              <select {...a} value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                <option value="">בחירת לקוח…</option>
                {props.customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            )}
          </Field>
        </div>
        <a href="#/income">+ לקוח חדש</a>
      </section>

      <section className="card" aria-labelledby="lines-h">
        <h2 id="lines-h">שורות</h2>
        {lineForms.map((l, i) => {
          const errs = lineErrs.filter((x) => x.index === i).map((x) => x.message);
          if (invalid.includes(i)) errs.unshift('סכום לא תקין');
          return (
            <div className="line-row" key={i}>
              <Field label={`תיאור (שורה ${i + 1})`} error={errs.length ? errs.join(' · ') : null}>
                {(a) => <input {...a} value={l.description} onChange={(e) => updateLine(i, { description: e.target.value })} />}
              </Field>
              <Field label="כמות">{(a) => <input {...a} inputMode="decimal" value={l.quantity} onChange={(e) => updateLine(i, { quantity: e.target.value })} />}</Field>
              <Field label="מחיר ליחידה (₪)">{(a) => <input {...a} inputMode="decimal" dir="ltr" value={l.price} onChange={(e) => updateLine(i, { price: e.target.value })} />}</Field>
              <Field label="הנחה (₪)">{(a) => <input {...a} inputMode="decimal" dir="ltr" value={l.discount} onChange={(e) => updateLine(i, { discount: e.target.value })} />}</Field>
              <button type="button" className="btn btn-danger" aria-label={`הסרת שורה ${i + 1}`} disabled={lineForms.length === 1}
                onClick={() => setLineForms((ls) => ls.filter((_, j) => j !== i))}>הסרה</button>
            </div>
          );
        })}
        <button type="button" className="btn btn-secondary" style={{ marginTop: 12 }} onClick={() => setLineForms((ls) => [...ls, emptyLine()])}>+ שורה</button>
        <p style={{ marginTop: 12, fontSize: '1.15rem' }}>סה"כ: <strong><Money agorot={totals.total} /></strong> {vatStatus === 'exempt' && <span className="muted">(ללא מע"מ — עוסק פטור)</span>}</p>
      </section>

      {docType === 'receipt' && (
        <section className="card" aria-labelledby="pay-h">
          <h2 id="pay-h">פרטי התשלום</h2>
          <div className="grid grid-2">
            <Field label="אמצעי תשלום" error={problems.includes('PAYMENT_METHOD_REQUIRED') ? 'חובה בקבלה' : null}>
              {(a) => (
                <select {...a} value={payment.method ?? ''} onChange={(e) => setPayment({ ...payment, method: (e.target.value || undefined) as PaymentMethod | undefined })}>
                  <option value="">בחירה…</option>
                  {Object.entries(PAYMENT_METHOD_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              )}
            </Field>
            <Field label="אסמכתה (אופציונלי)">{(a) => <input {...a} dir="ltr" value={payment.reference ?? ''} onChange={(e) => setPayment({ ...payment, reference: e.target.value })} />}</Field>
            {payment.method === 'cheque' && (<>
              <Field label="מספר צ'ק">{(a) => <input {...a} dir="ltr" value={payment.cheque_number ?? ''} onChange={(e) => setPayment({ ...payment, cheque_number: e.target.value })} />}</Field>
              <Field label="בנק">{(a) => <input {...a} value={payment.bank ?? ''} onChange={(e) => setPayment({ ...payment, bank: e.target.value })} />}</Field>
              <Field label="סניף">{(a) => <input {...a} dir="ltr" value={payment.branch ?? ''} onChange={(e) => setPayment({ ...payment, branch: e.target.value })} />}</Field>
              <Field label="תאריך פירעון">{(a) => <input {...a} type="date" value={payment.due_date ?? ''} onChange={(e) => setPayment({ ...payment, due_date: e.target.value })} />}</Field>
            </>)}
          </div>
        </section>
      )}

      <section className="card">
        <Field label="הערות">{(a) => <textarea {...a} value={notes} onChange={(e) => setNotes(e.target.value)} />}</Field>
      </section>

      {problems.length > 0 && (
        <div className="notice notice-warning" role="status">
          <p>לפני הפקה יש להשלים:</p>
          <ul>{problems.map((p) => <li key={p}>{ERROR_MESSAGES[p] ?? p}</li>)}</ul>
        </div>
      )}
      {error && <div className="notice notice-error" role="alert">{error}</div>}
      <div className="btn-row">
        <button className="btn btn-secondary" type="submit" disabled={busy}>{busy ? 'שומר…' : 'שמירת טיוטה'}</button>
        <button className="btn" type="button" disabled={busy || problems.length > 0} onClick={() => void save(true)}>שמירה והמשך להפקה</button>
      </div>
    </form>
  );
}
