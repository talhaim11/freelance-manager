import { useRef, useState } from 'react';
import { useRepo } from '../App';
import {
  attachmentProblem, EXPENSE_CATEGORIES, EXPENSE_STATUS_LABEL, expenseProblems, possibleDuplicates, type ExpenseStatus,
} from '../domain/expenses';
import { errorCode, errorMessage } from '../domain/errors';
import { agorotToShekelInput, parseShekels } from '../domain/money';
import { sha256Hex } from '../lib/sha256';
import { uuid } from '../lib/uuid';
import { navigate } from '../router';
import { DataState, Field, Money, fmtDate, todayLocal, useAsync, useBusy, useToast } from '../ui/kit';
import type { AttachmentUpload, Expense, ExpenseAttachment } from '../data/types';

const yearOf = (d: string) => Number(d.slice(0, 4));

export function ExpensesPage() {
  const repo = useRepo();
  const [state, retry] = useAsync(() => repo.listExpenses(), [repo]);
  const year = new Date().getFullYear();
  return (
    <>
      <h1>הוצאות</h1>
      <div className="btn-row" style={{ marginBottom: 12 }}>
        <a className="btn" href="#/expenses/new">+ הוצאה חדשה</a>
      </div>
      <p className="muted">הקבצים נשמרים באחסון פרטי: רק החשבון שלך יכול לפתוח אותם, דרך קישור זמני. קובץ מקור שצורף אינו נמחק ואינו מוחלף.</p>
      <DataState state={state} retry={retry}>
        {(list) => {
          const thisYear = list.filter((e) => yearOf(e.doc_date) === year);
          const review = list.filter((e) => e.status === 'needs_review').length;
          if (!list.length) return <div className="card"><p>אין הוצאות עדיין.</p></div>;
          return (<>
            <div className="grid grid-cards" style={{ marginBottom: 12 }}>
              <div className="metric">
                <div className="kind">הוצאות שנרשמו ב-{year}</div>
                <div className="value"><Money agorot={thisYear.reduce((s, e) => s + e.amount_agorot, 0)} /></div>
                <div className="def">{thisYear.length} הוצאות. סכום ששולם בפועל — מה מוכר לניכוי במס עדיין לא נקבע.</div>
              </div>
              <div className="metric">
                <div className="kind">ממתינות לבדיקה</div>
                <div className="value num">{review}</div>
                <div className="def">הוצאות שעוד לא סימנת שבדקת מול המסמך.</div>
              </div>
            </div>
            <div className="card table-wrap">
              <table>
                <caption className="sr-only">רשימת הוצאות</caption>
                <thead><tr>
                  <th scope="col">תאריך</th><th scope="col">ספק</th><th scope="col">קטגוריה</th><th scope="col">סכום בפועל</th>
                  <th scope="col">מוכר בניכוי</th><th scope="col">מצב</th><th scope="col">קובץ</th>
                </tr></thead>
                <tbody>{list.map((e) => (
                  <tr key={e.id}>
                    <td className="num">{fmtDate(e.doc_date)}</td>
                    <td><a href={`#/expenses/${e.id}`}><bdi>{e.supplier}</bdi></a></td>
                    <td>{EXPENSE_CATEGORIES[e.category] ?? e.category}</td>
                    <td><Money agorot={e.amount_agorot} /></td>
                    <td className="muted">טרם נקבע</td>
                    <td><span className={`tag ${e.status === 'needs_review' ? 'tag-draft' : 'tag-issued'}`}>{EXPENSE_STATUS_LABEL[e.status]}</span></td>
                    <td>{e.attachments.length ? <span aria-label={`${e.attachments.length} קבצים`}>📎 {e.attachments.length}</span> : <span className="muted">—</span>}</td>
                  </tr>))}
                </tbody>
              </table>
            </div>
          </>);
        }}
      </DataState>
    </>
  );
}

export function ExpenseEditor({ id }: { id?: string }) {
  const repo = useRepo();
  const [state, retry] = useAsync(() => repo.listExpenses(), [repo, id]);
  return (
    <>
      <h1>{id ? 'הוצאה' : 'הוצאה חדשה'}</h1>
      <DataState state={state} retry={retry}>
        {(list) => {
          const current = id ? list.find((e) => e.id === id) ?? null : null;
          if (id && !current) return <div className="notice notice-error" role="alert">ההוצאה לא נמצאה.</div>;
          return <ExpenseForm key={id ?? 'new'} expense={current} all={list} reload={retry} />;
        }}
      </DataState>
    </>
  );
}

interface PendingFile extends AttachmentUpload { size: number }

function ExpenseForm({ expense, all, reload }: { expense: Expense | null; all: Expense[]; reload: () => void }) {
  const repo = useRepo();
  const toast = useToast();
  const { busy, run } = useBusy();
  const clientKey = useRef(expense?.client_key ?? uuid());
  // Set once the expense row exists, so a retry (e.g. of a failed upload) updates it instead of creating another.
  const [savedId, setSavedId] = useState<string | null>(expense?.id ?? null);
  const [f, setF] = useState({
    supplier: expense?.supplier ?? '',
    supplier_tax_id: expense?.supplier_tax_id ?? '',
    doc_number: expense?.doc_number ?? '',
    doc_date: expense?.doc_date ?? todayLocal(),
    amount: expense ? agorotToShekelInput(expense.amount_agorot) : '',
    vat: expense?.vat_agorot ? agorotToShekelInput(expense.vat_agorot) : '',
    category: expense?.category ?? 'other',
    business_use_pct: String(expense?.business_use_pct ?? 100),
    confirmed: expense?.status === 'confirmed',
    notes: expense?.notes ?? '',
  });
  const set = (patch: Partial<typeof f>) => setF((x) => ({ ...x, ...patch }));
  const [file, setFile] = useState<PendingFile | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const touch = (k: string) => () => setTouched((t) => ({ ...t, [k]: true }));
  const shown = (k: string) => attempted || !!touched[k];

  const amount = parseShekels(f.amount);
  const vat = f.vat.trim() ? parseShekels(f.vat) : 0;
  const pct = Number(f.business_use_pct);
  const problems = expenseProblems({ supplier: f.supplier, doc_date: f.doc_date, amount_agorot: amount, vat_agorot: vat, business_use_pct: pct });
  const dupes = f.supplier.trim() && amount !== null && amount > 0
    ? possibleDuplicates({ id: savedId ?? undefined, supplier: f.supplier, doc_number: f.doc_number, doc_date: f.doc_date, amount_agorot: amount }, all)
    : [];
  const sameFile = file ? all.flatMap((e) => e.attachments.map((a) => ({ e, a }))).find((x) => x.a.sha256 === file.sha256) : undefined;

  const pick = async (input: HTMLInputElement) => {
    setFileError(null);
    const chosen = input.files?.[0];
    input.value = '';
    if (!chosen) return;
    const problem = attachmentProblem(chosen);
    if (problem) { setFile(null); setFileError(problem); return; }
    const bytes = new Uint8Array(await chosen.arrayBuffer());
    setFile({ id: uuid(), bytes, size: bytes.length, sha256: await sha256Hex(bytes), mime_type: chosen.type, original_name: chosen.name });
  };

  const save = () => run(async () => {
    setError(null);
    if (Object.keys(problems).length) { setAttempted(true); return; }
    const input = {
      client_key: clientKey.current, supplier: f.supplier.trim(), supplier_tax_id: f.supplier_tax_id.trim(), doc_number: f.doc_number.trim(),
      doc_date: f.doc_date, amount_agorot: amount!, vat_agorot: vat ?? 0, category: f.category, business_use_pct: pct,
      status: (f.confirmed ? 'confirmed' : 'needs_review') as ExpenseStatus, notes: f.notes,
    };
    let saved: Expense;
    try {
      saved = await repo.saveExpense(input, savedId ?? undefined);
      setSavedId(saved.id);
    } catch (e) { setError(errorMessage(e)); return; }
    if (file) {
      try {
        await repo.addExpenseAttachment(saved.id, file);
        setFile(null);
      } catch (e) {
        const lost = errorCode(e) === 'NETWORK';
        setError(`ההוצאה נשמרה, אבל הקובץ ${lost ? 'אולי' : ''} לא הועלה: ${errorMessage(e)} הקובץ עדיין נבחר — לחצו "שמירה" שוב כדי לנסות שוב (לא ייווצר כפל).`);
        return;
      }
    }
    toast(expense ? 'ההוצאה עודכנה' : 'ההוצאה נשמרה', 'success');
    if (!expense) navigate(`/expenses/${saved.id}`);
    else reload();
  });

  return (
    <form onSubmit={(e) => { e.preventDefault(); void save(); }} noValidate>
      <section className="card">
        <div className="grid grid-2">
          <Field label="ספק (חובה)" error={shown('supplier') ? problems.supplier : null}>
            {(a) => <input {...a} value={f.supplier} onBlur={touch('supplier')} onChange={(e) => set({ supplier: e.target.value })} />}
          </Field>
          <Field label="תאריך המסמך (חובה)" error={shown('doc_date') ? problems.doc_date : null}>
            {(a) => <input {...a} type="date" value={f.doc_date} onBlur={touch('doc_date')} onChange={(e) => set({ doc_date: e.target.value })} />}
          </Field>
          <Field label="סכום ששולם (₪, חובה)" error={shown('amount') ? problems.amount : null}>
            {(a) => <input {...a} inputMode="decimal" dir="ltr" value={f.amount} onBlur={touch('amount')} onChange={(e) => set({ amount: e.target.value })} />}
          </Field>
          <Field label='מע"מ שמופיע במסמך (₪, אם יש)' hint='לתיעוד בלבד. עוסק פטור אינו מקזז מע"מ תשומות.' error={shown('vat') ? problems.vat : null}>
            {(a) => <input {...a} inputMode="decimal" dir="ltr" value={f.vat} onBlur={touch('vat')} onChange={(e) => set({ vat: e.target.value })} />}
          </Field>
          <Field label="מספר המסמך של הספק">{(a) => <input {...a} dir="ltr" value={f.doc_number} onChange={(e) => set({ doc_number: e.target.value })} />}</Field>
          <Field label="ח.פ. / עוסק של הספק">{(a) => <input {...a} dir="ltr" inputMode="numeric" value={f.supplier_tax_id} onChange={(e) => set({ supplier_tax_id: e.target.value })} />}</Field>
          <Field label="קטגוריה">
            {(a) => <select {...a} value={f.category} onChange={(e) => set({ category: e.target.value })}>
              {Object.entries(EXPENSE_CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>}
          </Field>
          <Field label="אחוז שימוש עסקי" hint="למשל טלפון משותף. ההכרה בפועל תיקבע לפי כללי המס." error={shown('pct') ? problems.business_use_pct : null}>
            {(a) => <input {...a} inputMode="numeric" dir="ltr" value={f.business_use_pct} onBlur={touch('pct')} onChange={(e) => set({ business_use_pct: e.target.value })} />}
          </Field>
        </div>
        <Field label="הערות">{(a) => <textarea {...a} value={f.notes} onChange={(e) => set({ notes: e.target.value })} />}</Field>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
          <input type="checkbox" checked={f.confirmed} onChange={(e) => set({ confirmed: e.target.checked })} style={{ width: 'auto' }} />
          בדקתי את הפרטים מול המסמך המקורי
        </label>
      </section>

      <section className="card" aria-labelledby="tax-cols-h">
        <h2 id="tax-cols-h">איך ההוצאה תיספר</h2>
        <div className="grid grid-cards">
          <div className="metric"><div className="kind">הוצאה בפועל</div><div className="value"><Money agorot={amount !== null && amount > 0 ? amount : null} /></div></div>
          <div className="metric"><div className="kind">מוכר בניכוי (מס הכנסה)</div><div className="value muted" style={{ fontSize: '1.1rem' }}>טרם נקבע</div>
            <div className="def">ייקבע לפי מסלול המס וכללי ההכרה — לא מניחים מראש.</div></div>
          <div className="metric"><div className="kind">מע"מ תשומות לקיזוז</div><div className="value muted" style={{ fontSize: '1.1rem' }}>טרם נקבע</div>
            <div className="def">לעוסק פטור אין קיזוז מע"מ תשומות.</div></div>
        </div>
      </section>

      <section className="card" aria-labelledby="att-h">
        <h2 id="att-h">מסמך מקור (קבלה / חשבונית מהספק)</h2>
        {expense && expense.attachments.length > 0 && (
          <ul>{expense.attachments.map((a) => <AttachmentItem key={a.id} a={a} />)}</ul>
        )}
        <div className="btn-row">
          <label className="btn btn-secondary">
            📷 צילום
            <input type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => void pick(e.currentTarget)} />
          </label>
          <label className="btn btn-secondary">
            📎 בחירת קובץ (תמונה או PDF)
            <input type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf" className="sr-only"
              data-testid="expense-file" onChange={(e) => void pick(e.currentTarget)} />
          </label>
        </div>
        {fileError && <p className="error" role="alert">{fileError}</p>}
        {file && (
          <p data-testid="pending-file">נבחר: <bdi>{file.original_name}</bdi> ({Math.ceil(file.size / 1024)} KB) — יועלה בשמירה.
            {' '}<button type="button" className="btn btn-secondary" onClick={() => setFile(null)}>הסרה</button></p>
        )}
        {sameFile && (
          <p className="notice notice-warning" role="note">קובץ זהה כבר מצורף להוצאה של <bdi>{sameFile.e.supplier}</bdi> מ-{fmtDate(sameFile.e.doc_date)}. ייתכן שזו אותה הוצאה.</p>
        )}
      </section>

      {dupes.length > 0 && (
        <div className="notice notice-warning" role="note">
          ייתכן שזו הוצאה כפולה: {dupes.map((d) => <a key={d.id} href={`#/expenses/${d.id}`} style={{ marginInlineEnd: 8 }}><bdi>{d.supplier}</bdi> · {fmtDate(d.doc_date)} · <Money agorot={d.amount_agorot} /></a>)}
          <div className="muted">אפשר לשמור בכל זאת אם זו הוצאה נפרדת.</div>
        </div>
      )}
      {attempted && Object.keys(problems).length > 0 && (
        <div className="notice notice-error" role="alert">יש להשלים את השדות המסומנים.</div>
      )}
      {error && <div className="notice notice-error" role="alert">{error}</div>}
      <div className="btn-row">
        <button className="btn" type="submit" disabled={busy}>{busy ? 'שומר…' : 'שמירה'}</button>
        <a className="btn btn-secondary" href="#/expenses">חזרה לרשימה</a>
      </div>
    </form>
  );
}

function AttachmentItem({ a }: { a: ExpenseAttachment }) {
  const repo = useRepo();
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { busy, run } = useBusy();
  const open = () => run(async () => {
    setErr(null);
    try { setUrl(await repo.attachmentUrl(a)); } catch (e) { setErr(errorMessage(e)); }
  });
  return (
    <li style={{ marginBottom: 8 }}>
      📎 <bdi>{a.original_name || 'קובץ'}</bdi> <span className="muted">({Math.ceil(a.size_bytes / 1024)} KB, {fmtDate(a.created_at)})</span>{' '}
      {!url && <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void open()}>הצגה</button>}
      {url && a.mime_type.startsWith('image/') && (
        <div><img src={url} alt={`מסמך מקור: ${a.original_name}`} style={{ maxWidth: '100%', maxHeight: 480, marginTop: 8, border: '1px solid #ddd' }} /></div>
      )}
      {url && <> <a href={url} target="_blank" rel="noopener noreferrer" download={a.original_name}>פתיחה / הורדה</a> <span className="muted">(קישור זמני)</span></>}
      {err && <span className="error" role="alert"> {err}</span>}
    </li>
  );
}
