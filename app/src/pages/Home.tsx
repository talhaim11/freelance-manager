import { useRepo } from '../App';
import { vatStatusOn, VAT_STATUS_LABEL } from '../domain/classification';
import { rulesFor } from '../domain/tax/rules';
import { DataState, Money, useAsync, todayLocal } from '../ui/kit';
import { yearSummary } from '../domain/dashboard';

const yearOf = (d: string) => Number(d.slice(0, 4));


export function HomePage() {
  const repo = useRepo();
  const [state, retry] = useAsync(async () => {
    const [docs, vat, profile, balances, expenses, allocations, tax] = await Promise.all([
      repo.listDocuments(), repo.listVatPeriods(), repo.getProfile(), repo.listInvoiceBalances(), repo.listExpenses(), repo.listAllocations(), repo.getTaxProfile()]);
    return { docs, vat, profile, balances, expenses, allocations, tax };
  }, [repo]);
  const year = new Date().getFullYear();

  return (
    <>
      <h1>בית</h1>
      <div className="btn-row" style={{ marginBottom: 16 }}>
        <a className="btn" href="#/documents/new">+ מסמך חדש</a>
        <a className="btn btn-secondary" href="#/documents/new?type=receipt">₪ רישום תשלום (קבלה)</a>
        <a className="btn btn-secondary" href="#/expenses/new">📷 הוצאה</a>
      </div>
      <DataState state={state} retry={retry}>
        {({ docs, vat, profile, balances, expenses, allocations, tax }) => {
          const ys = yearSummary(docs, allocations, year);
          const invoices = { total: ys.invoiced, count: ys.invoiceCount };
          const receipts = { total: ys.received, count: ys.receiptCount };
          const owed = balances.filter((b) => b.balance_agorot > 0);
          const owedTotal = owed.reduce((s, b) => s + b.balance_agorot, 0);
          const yearExpenses = expenses.filter((e) => yearOf(e.doc_date) === year);
          const toReview = expenses.filter((e) => e.status === 'needs_review').length;
          const status = vatStatusOn(vat, todayLocal());
          const rules = rulesFor(year);
          const ceiling = rules?.exemptDealerCeiling.amount ?? null;
          const drafts = docs.filter((d) => d.status === 'draft');
          const todo: { text: string; href: string }[] = [];
          if (!tax?.onboarding_done) todo.push({ text: 'הגדרה ראשונית: פרטי עסק, סטטוס מע"מ, מסלול מס ומספור (כמה דקות)', href: '#/onboarding' });
          if (!profile || !profile.legal_name || !profile.id_number || !profile.address) todo.push({ text: 'השלמת פרטי העסק (נדרשים להפקת מסמכים)', href: '#/settings' });
          if (!status) todo.push({ text: 'הגדרת סטטוס מע"מ ותאריך תחילה', href: '#/settings' });
          if (toReview) todo.push({ text: `${toReview} הוצאות ממתינות לבדיקה מול המסמך`, href: '#/expenses' });
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
                    <div className="value"><Money agorot={owedTotal} /></div>
                    <div className="def">{owed.length} חשבוניות עסקה פתוחות, פחות תשלומים ששויכו בקבלות. <a href="#/income">פירוט</a></div>
                  </div>
                  <div className="metric">
                    <div className="kind">הוצאות שנרשמו ב-{year}</div>
                    <div className="value"><Money agorot={yearExpenses.reduce((s, e) => s + e.amount_agorot, 0)} /></div>
                    <div className="def">{yearExpenses.length} הוצאות, סכום בפועל. מה מוכר במס — טרם נקבע. <a href="#/expenses">לרשימה</a></div>
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
