import { useRepo } from '../App';
import { vatStatusOn, VAT_STATUS_LABEL } from '../domain/classification';
import { rulesFor } from '../domain/tax/rules';
import { DataState, Money, useAsync, todayLocal } from '../ui/kit';
import type { Doc } from '../data/types';

const yearOf = (d: string) => Number(d.slice(0, 4));

/** Sums issued (not cancelled) documents of one type in a year. Cancellations are excluded with their original. */
function sumIssued(docs: Doc[], type: Doc['doc_type'], year: number) {
  const list = docs.filter((d) => d.doc_type === type && d.status === 'issued' && yearOf(d.issue_date) === year);
  return { total: list.reduce((s, d) => s + (d.total_agorot ?? 0), 0), count: list.length };
}

export function HomePage() {
  const repo = useRepo();
  const [state, retry] = useAsync(async () => {
    const [docs, vat, profile] = await Promise.all([repo.listDocuments(), repo.listVatPeriods(), repo.getProfile()]);
    return { docs, vat, profile };
  }, [repo]);
  const year = new Date().getFullYear();

  return (
    <>
      <h1>בית</h1>
      <div className="btn-row" style={{ marginBottom: 16 }}>
        <a className="btn" href="#/documents/new">+ מסמך חדש</a>
        <a className="btn btn-secondary" href="#/documents/new?type=receipt">₪ רישום תשלום (קבלה)</a>
        <button className="btn btn-secondary" aria-disabled="true" aria-describedby="expense-later"
          onClick={(e) => e.preventDefault()}>📷 הוצאה</button>
        <span id="expense-later" className="muted">קליטת הוצאות — בשלב הבא</span>
      </div>
      <DataState state={state} retry={retry}>
        {({ docs, vat, profile }) => {
          const invoices = sumIssued(docs, 'transaction_invoice', year);
          const receipts = sumIssued(docs, 'receipt', year);
          const status = vatStatusOn(vat, todayLocal());
          const rules = rulesFor(year);
          const ceiling = rules?.exemptDealerCeiling.amount ?? null;
          const drafts = docs.filter((d) => d.status === 'draft');
          const todo: { text: string; href: string }[] = [];
          if (!profile || !profile.legal_name || !profile.id_number || !profile.address) todo.push({ text: 'השלמת פרטי העסק (נדרשים להפקת מסמכים)', href: '#/settings' });
          if (!status) todo.push({ text: 'הגדרת סטטוס מע"מ ותאריך תחילה', href: '#/settings' });
          if (drafts.length) todo.push({ text: `${drafts.length} טיוטות ממתינות להפקה או למחיקה`, href: '#/documents' });
          return (
            <>
              <section aria-labelledby="year-h">
                <h2 id="year-h">שנת {year} {status && <span className="tag">{VAT_STATUS_LABEL[status]}</span>}</h2>
                <div className="grid grid-cards">
                  <div className="metric">
                    <div className="kind">חשבוניות עסקה שהופקו</div>
                    <div className="value"><Money agorot={invoices.total} /></div>
                    <div className="def">{invoices.count} מסמכים. דרישות תשלום — לא בהכרח שולמו. ללא מבוטלים.</div>
                  </div>
                  <div className="metric">
                    <div className="kind">התקבל בפועל (לפי קבלות)</div>
                    <div className="value"><Money agorot={receipts.total} /></div>
                    <div className="def">{receipts.count} קבלות שהופקו כאן. תשלומים בלי קבלה אינם נספרים.</div>
                  </div>
                  <div className="metric">
                    <div className="kind">מי חייב לי</div>
                    <div className="value muted" style={{ fontSize: '1.1rem' }}>לא זמין עדיין</div>
                    <div className="def">חישוב יתרות דורש שיוך תשלומים לחשבוניות — בשלב הבא.</div>
                  </div>
                  <div className="metric">
                    <div className="kind">כמה לשריין למסים <span className="tag tag-estimate">הערכה</span></div>
                    <div className="value muted" style={{ fontSize: '1.1rem' }}>חסרים נתונים</div>
                    <div className="def">נדרשים משכורת (106), מסלול מס ונקודות זיכוי. <a href="#/taxes">להערכה</a></div>
                  </div>
                  {ceiling !== null && (
                    <div className="metric">
                      <div className="kind">התקדמות לתקרת עוסק פטור {year}</div>
                      <div className="value num">{Math.round((receipts.total / ceiling) * 100)}%</div>
                      <div className="def"><Money agorot={receipts.total} /> מתוך <Money agorot={ceiling} />, לפי קבלות. המחזור הקובע נקבע לפי כללי מע"מ.</div>
                      <progress max={ceiling} value={Math.min(receipts.total, ceiling)} style={{ width: '100%' }} aria-label="התקדמות לתקרה" />
                    </div>
                  )}
                </div>
              </section>
              <section className="card" aria-labelledby="todo-h" style={{ marginTop: 16 }}>
                <h2 id="todo-h">מה דורש פעולה</h2>
                {todo.length ? (
                  <ul>{todo.map((t) => <li key={t.text}><a href={t.href}>{t.text}</a></li>)}</ul>
                ) : <p className="muted">אין פעולות פתוחות שהמערכת יודעת עליהן. לוח מועדים אישי יתווסף בשלב 3.</p>}
              </section>
            </>
          );
        }}
      </DataState>
    </>
  );
}
