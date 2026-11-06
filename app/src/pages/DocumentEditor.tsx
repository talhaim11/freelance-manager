import { useEffect, useMemo, useRef, useState } from 'react';
import { uuid } from '../lib/uuid';
import { useRepo } from '../App';
import { vatStatusOn } from '../domain/classification';
import {
  creatableDocTypes, DOC_TYPE_LABEL, exemptTotals, issueProblems, lineProblems,
  PAYMENT_METHOD_LABEL, type DocLine, type DocType, type PaymentDetails, type PaymentMethod,
} from '../domain/documents';
import { errorMessage, ERROR_MESSAGES } from '../domain/errors';
import { agorotToShekelInput, parseShekels } from '../domain/money';
import { allocationProblems, autoAllocate, sumAllocations, type Allocation } from '../domain/payments';
import type { Customer, InvoiceBalance } from '../data/types';
import { NewCustomerDialog } from './CustomerForm';
import { navigate } from '../router';
import { DataState, Field, Money, fmtDate, todayLocal, useAsync, useBusy, useToast } from '../ui/kit';

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

export function DocumentEditor({ draftId, initialType, fromInvoice }: { draftId?: string; initialType?: string | null; fromInvoice?: string | null }) {
  const repo = useRepo();
  const [state, retry] = useAsync(async () => {
    const [series, customers, vat, profile, draft, balances] = await Promise.all([
      repo.listSeries(), repo.listCustomers(), repo.listVatPeriods(), repo.getProfile(),
      draftId ? repo.getDocument(draftId) : Promise.resolve(null),
      repo.listInvoiceBalances(),
    ]);
    return { series, customers, vat, profile, draft, balances };
  }, [repo, draftId]);
  return (
    <>
      <h1>{draftId ? 'עריכת טיוטה' : fromInvoice ? 'קבלה על תשלום' : 'מסמך חדש'}</h1>
      <DataState state={state} retry={retry}>
        {(d) => {
          if (draftId && (!d.draft || d.draft.status !== 'draft')) {
            return <div className="notice notice-error" role="alert">{ERROR_MESSAGES.FINALIZED_DOCUMENT}</div>;
          }
          return <EditorForm {...d} initialType={initialType} fromInvoice={fromInvoice} onSeriesAdded={retry} />;
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
  balances: InvoiceBalance[];
  initialType?: string | null;
  fromInvoice?: string | null;
  onSeriesAdded: () => void;
}) {
  const repo = useRepo();
  const toast = useToast();
  const { busy, run } = useBusy();
  const draft = props.draft;
  // One key per editor session: repeated submits create a single draft.
  const idempotencyKey = useRef(draft?.idempotency_key ?? uuid());
  // "Receipt for this invoice": prefilled from the invoice's open balance.
  const source = !draft && props.fromInvoice ? props.balances.find((b) => b.invoice_id === props.fromInvoice && b.balance_agorot > 0) ?? null : null;
  const [customers, setCustomers] = useState<Customer[]>(props.customers);
  const [newCustomerOpen, setNewCustomerOpen] = useState(false);

  const [issueDate, setIssueDate] = useState(draft?.issue_date ?? todayLocal());
  const vatStatus = vatStatusOn(props.vat, issueDate);
  const allowedTypes = creatableDocTypes(vatStatus);
  const [docType, setDocType] = useState<DocType>(
    draft?.doc_type ?? (source ? 'receipt' : allowedTypes.includes(props.initialType as DocType) ? (props.initialType as DocType) : 'transaction_invoice'));
  const seriesForType = props.series.filter((s) => s.doc_type === docType && !s.is_legacy);
  const [seriesId, setSeriesId] = useState(draft?.series_id ?? '');
  const [customerId, setCustomerId] = useState(draft?.customer_id ?? source?.customer_id ?? '');
  const [notes, setNotes] = useState(draft?.notes ?? '');
  const [payment, setPayment] = useState<PaymentDetails>(draft?.payment_details ?? {});
  const [lineForms, setLineForms] = useState<LineForm[]>(draft?.lines.length
    ? draft.lines.map((l) => ({ description: l.description, quantity: String(l.quantity), price: agorotToShekelInput(l.unit_price_agorot), discount: l.discount_agorot ? agorotToShekelInput(l.discount_agorot) : '' }))
    : source ? [{ description: `תשלום עבור חשבונית עסקה מס' ${source.number}`, quantity: '1', price: agorotToShekelInput(source.balance_agorot), discount: '' }]
    : [emptyLine()]);
  // Allocation amounts per invoice (shekel strings). While "linked", a single allocation follows the receipt total.
  const [allocForms, setAllocForms] = useState<Record<string, string>>(() => Object.fromEntries(
    (draft?.allocations ?? (source ? [{ invoice_id: source.invoice_id, amount_agorot: source.balance_agorot }] : []))
      .map((a) => [a.invoice_id, agorotToShekelInput(a.amount_agorot)])));
  const [allocLinked, setAllocLinked] = useState(!!source);
  const [newSeriesStart, setNewSeriesStart] = useState('1');
  const [error, setError] = useState<string | null>(null);
  // Validation messages appear only after the user leaves a field or tries to save/issue —
  // never on a fresh, untouched form.
  const [attempted, setAttempted] = useState(false);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const touch = (k: string) => () => setTouched((t) => (t[k] ? t : { ...t, [k]: true }));
  const shown = (k: string) => attempted || !!touched[k];
  const summaryRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!seriesForType.some((s) => s.id === seriesId)) setSeriesId(seriesForType[0]?.id ?? '');
  }, [docType, props.series]); // eslint-disable-line react-hooks/exhaustive-deps

  const { lines, invalid } = useMemo(() => toLines(lineForms), [lineForms]);
  const totals = exemptTotals(lines.filter((_, i) => !invalid.includes(i)));
  const customer = customers.find((c) => c.id === customerId) ?? null;

  // Open invoices of this customer (plus any already chosen in this draft).
  const openInvoices = docType === 'receipt' && customerId
    ? props.balances.filter((b) => b.customer_id === customerId && (b.balance_agorot > 0 || b.invoice_id in allocForms))
    : [];
  const allocParsed = Object.entries(allocForms).filter(([, v]) => v.trim() !== '')
    .map(([invoice_id, v]) => ({ invoice_id, amount_agorot: parseShekels(v) }));
  const allocInvalid = docType === 'receipt' && allocParsed.some((a) => a.amount_agorot === null);
  const allocations: Allocation[] = docType === 'receipt'
    ? allocParsed.filter((a): a is Allocation => a.amount_agorot !== null && a.amount_agorot !== 0) : [];
  useEffect(() => {
    if (!allocLinked || !source) return;
    const amt = Math.min(totals.total, source.balance_agorot);
    setAllocForms({ [source.invoice_id]: agorotToShekelInput(Math.max(amt, 0)) });
  }, [allocLinked, totals.total]); // eslint-disable-line react-hooks/exhaustive-deps
  const allocProblems = docType === 'receipt'
    ? [...new Set([...allocationProblems(totals.total, customerId || null, allocations, props.balances), ...(allocInvalid ? ['ALLOCATION_INVALID'] : [])])]
    : [];
  const problems = [...issueProblems({ docType, vatStatus, profile: props.profile, customer, lines, payment }), ...allocProblems];
  const lineErrs = lineProblems(lines);
  const fieldError = (i: number, field: 'd' | 'q' | 'p' | 'x'): string | null => {
    if (!shown(`${field}${i}`)) return null;
    const f = lineForms[i];
    if (field === 'd') return f.description.trim() ? null : 'חסר תיאור';
    if (field === 'q') { const q = Number(f.quantity.replace(',', '.')); return Number.isFinite(q) && q > 0 ? null : 'הכמות חייבת להיות חיובית'; }
    if (field === 'p') { if (!f.price.trim()) return 'יש להזין מחיר'; const p = parseShekels(f.price); return p === null || p < 0 ? 'מחיר לא תקין' : null; }
    if (!f.discount.trim()) return null;
    const d = parseShekels(f.discount);
    if (d === null || d < 0) return 'הנחה לא תקינה';
    return lineErrs.some((x) => x.index === i && x.message === 'ההנחה גדולה מסכום השורה') ? 'ההנחה גדולה מסכום השורה' : null;
  };
  const tryIssue = () => {
    if (problems.length === 0) { void save(true); return; }
    setAttempted(true);
    setTimeout(() => summaryRef.current?.focus(), 0);
  };

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
    if (invalid.length) {
      setTouched((t) => ({ ...t, ...Object.fromEntries(invalid.flatMap((i) => [[`p${i}`, true], [`x${i}`, true], [`q${i}`, true]])) }));
      setError('יש סכומים לא תקינים בשורות'); return;
    }
    if (allocInvalid) { setAttempted(true); setError('יש סכום שיוך לא תקין'); return; }
    const input = { series_id: seriesId, doc_type: docType, issue_date: issueDate, customer_id: customerId || null, lines, notes,
      payment_details: docType === 'receipt' ? payment : {}, allocations };
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

  const allocated = sumAllocations(allocations);
  const changeCustomer = (id: string) => {
    setCustomerId(id);
    // Allocations belong to one customer's invoices.
    setAllocForms((f) => Object.fromEntries(Object.entries(f).filter(([inv]) => props.balances.find((b) => b.invoice_id === inv)?.customer_id === id)));
    setAllocLinked(false);
  };

  return (
    <>
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
          <Field label="לקוח" hint={customers.length ? undefined : 'אין לקוחות עדיין — אפשר להוסיף כאן בלי לאבד את מה שמילאת.'}
            error={problems.includes('CUSTOMER_ADDRESS_REQUIRED') ? ERROR_MESSAGES.CUSTOMER_ADDRESS_REQUIRED
              : attempted && problems.includes('CUSTOMER_REQUIRED') ? ERROR_MESSAGES.CUSTOMER_REQUIRED : null}>
            {(a) => (
              <select {...a} value={customerId} onChange={(e) => changeCustomer(e.target.value)}>
                <option value="">בחירת לקוח…</option>
                {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            )}
          </Field>
        </div>
        <button type="button" className="btn btn-secondary" onClick={() => setNewCustomerOpen(true)}>+ לקוח חדש</button>
      </section>

      <section className="card" aria-labelledby="lines-h">
        <h2 id="lines-h">שורות</h2>
        {lineForms.map((l, i) => {
          return (
            <div className="line-row" key={i}>
              <Field label={`תיאור (שורה ${i + 1})`} error={fieldError(i, 'd')}>
                {(a) => <input {...a} value={l.description} onBlur={touch(`d${i}`)} onChange={(e) => updateLine(i, { description: e.target.value })} />}
              </Field>
              <Field label="כמות" error={fieldError(i, 'q')}>{(a) => <input {...a} inputMode="decimal" value={l.quantity} onBlur={touch(`q${i}`)} onChange={(e) => updateLine(i, { quantity: e.target.value })} />}</Field>
              <Field label="מחיר ליחידה (₪)" error={fieldError(i, 'p')}>{(a) => <input {...a} inputMode="decimal" dir="ltr" value={l.price} onBlur={touch(`p${i}`)} onChange={(e) => updateLine(i, { price: e.target.value })} />}</Field>
              <Field label="הנחה (₪)" error={fieldError(i, 'x')}>{(a) => <input {...a} inputMode="decimal" dir="ltr" value={l.discount} onBlur={touch(`x${i}`)} onChange={(e) => updateLine(i, { discount: e.target.value })} />}</Field>
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
            <Field label="אמצעי תשלום" error={shown('pay') && problems.includes('PAYMENT_METHOD_REQUIRED') ? 'חובה בקבלה' : null}>
              {(a) => (
                <select {...a} value={payment.method ?? ''} onBlur={touch('pay')} onChange={(e) => setPayment({ ...payment, method: (e.target.value || undefined) as PaymentMethod | undefined })}>
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

      {docType === 'receipt' && customerId && (
        <section className="card" aria-labelledby="alloc-h">
          <h2 id="alloc-h">על חשבון אילו חשבוניות?</h2>
          {openInvoices.length === 0 ? (
            <p className="muted">אין ללקוח חשבוניות עסקה פתוחות. התשלום יירשם כתשלום שאינו משויך לחשבונית (למשל מקדמה).</p>
          ) : (<>
            <p className="muted">אפשר לשלם חשבונית חלקית או כמה חשבוניות בבת אחת. מה שלא משויך נשאר כיתרת זכות של הלקוח.</p>
            <div className="table-wrap"><table>
              <thead><tr><th scope="col">חשבונית</th><th scope="col">תאריך</th><th scope="col">סה"כ</th><th scope="col">יתרה פתוחה</th><th scope="col">סכום לשיוך (₪)</th></tr></thead>
              <tbody>{openInvoices.map((b) => (
                <tr key={b.invoice_id}>
                  <td>מס' <span className="num">{b.number}</span></td>
                  <td className="num">{fmtDate(b.issue_date)}</td>
                  <td><Money agorot={b.total_agorot} /></td>
                  <td><Money agorot={b.balance_agorot} /></td>
                  <td><input aria-label={`סכום לשיוך לחשבונית ${b.number}`} inputMode="decimal" dir="ltr" value={allocForms[b.invoice_id] ?? ''}
                    onChange={(e) => { setAllocLinked(false); setAllocForms((f) => ({ ...f, [b.invoice_id]: e.target.value })); }} /></td>
                </tr>))}
              </tbody>
            </table></div>
            <div className="btn-row" style={{ marginTop: 8 }}>
              <button type="button" className="btn btn-secondary" onClick={() => {
                setAllocLinked(false);
                setAllocForms(Object.fromEntries(autoAllocate(totals.total, openInvoices).map((a) => [a.invoice_id, agorotToShekelInput(a.amount_agorot)])));
              }}>שיוך אוטומטי (הישנה קודם)</button>
              <button type="button" className="btn btn-secondary" onClick={() => { setAllocLinked(false); setAllocForms({}); }}>ניקוי שיוך</button>
            </div>
          </>)}
          <p data-testid="alloc-summary">סכום הקבלה <Money agorot={totals.total} /> · משויך לחשבוניות <Money agorot={allocated} /> · לא משויך <Money agorot={totals.total - allocated} /></p>
          {attempted && allocProblems.length > 0 && (
            <ul className="error" role="alert">{allocProblems.map((p) => <li key={p}>{ERROR_MESSAGES[p]}</li>)}</ul>
          )}
        </section>
      )}

      <section className="card">
        <Field label="הערות">{(a) => <textarea {...a} value={notes} onChange={(e) => setNotes(e.target.value)} />}</Field>
      </section>

      {problems.includes('PROFILE_INCOMPLETE') && !attempted && (
        <div className="notice notice-info">כדי להפיק מסמכים צריך קודם להשלים את פרטי העסק ב<a href="#/settings">הגדרות</a>. אפשר לשמור טיוטה כבר עכשיו.</div>
      )}
      {attempted && problems.length > 0 && (
        <div className="notice notice-error" role="alert" tabIndex={-1} ref={summaryRef}>
          <p>אי אפשר עדיין להפיק. יש להשלים:</p>
          <ul>{problems.map((p) => <li key={p}>{ERROR_MESSAGES[p] ?? p}</li>)}</ul>
        </div>
      )}
      {error && <div className="notice notice-error" role="alert">{error}</div>}
      <div className="btn-row">
        <button className="btn btn-secondary" type="submit" disabled={busy}>{busy ? 'שומר…' : 'שמירת טיוטה'}</button>
        <button className="btn" type="button" disabled={busy} onClick={tryIssue}>שמירה והמשך להפקה</button>
      </div>
    </form>
    {newCustomerOpen && <NewCustomerDialog open onClose={() => setNewCustomerOpen(false)} requireAddress={docType === 'transaction_invoice'}
      onCreated={(c) => {
        setCustomers((cs) => [...cs.filter((x) => x.id !== c.id), c].sort((a, b) => a.name.localeCompare(b.name, 'he')));
        changeCustomer(c.id);
        setNewCustomerOpen(false);
        toast(`הלקוח "${c.name}" נוסף ונבחר`, 'success');
      }} />}
    </>
  );
}
