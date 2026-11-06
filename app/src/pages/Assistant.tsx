import { useState } from 'react';
import { useRepo } from '../App';
import { supabase } from '../data/backend';
import { vatStatusOn } from '../domain/classification';
import { yearSummary } from '../domain/dashboard';
import { rulesFor } from '../domain/tax/rules';
import { DataState, useAsync, useBusy, todayLocal } from '../ui/kit';

const MESSAGES: Record<string, string> = {
  AI_NOT_CONFIGURED: 'העוזר לא הוגדר בשרת: חסר מפתח ANTHROPIC_API_KEY בהגדרות האתר ב-Netlify. שום מידע לא נשלח.',
  NOT_ALLOWED: 'החשבון אינו מורשה.',
  SESSION_EXPIRED: 'החיבור פג. התחברו מחדש ונסו שוב.',
  AI_REFUSED: 'העוזר לא יכול לענות על השאלה הזו.',
  AI_BUSY: 'העוזר עמוס כרגע. נסו שוב בעוד דקה.',
  INVALID_REQUEST: 'השאלה ארוכה מדי או ריקה.',
};

/** AI assistant: shows exactly what will be sent, sends only on request, never changes data. */
export function AssistantPage() {
  const repo = useRepo();
  const year = new Date().getFullYear();
  const [state, retry] = useAsync(async () => {
    const [docs, allocations, balances, expenses, vat, tax, customers] = await Promise.all([repo.listDocuments(), repo.listAllocations(), repo.listInvoiceBalances(),
      repo.listExpenses(), repo.listVatPeriods(), repo.getTaxProfile(), repo.listCustomers()]);
    return { docs, allocations, balances, expenses, vat, tax, customers };
  }, [repo]);
  const [includeNames, setIncludeNames] = useState(false);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useBusy();

  return (
    <>
      <h1>עוזר</h1>
      <div className="notice notice-info" role="note">
        העוזר עונה על שאלות על הנתונים שלך. הוא <strong>לא</strong> משנה נתונים, לא מגיש דוחות ולא מחליף רו"ח. חישובי המס באפליקציה באים ממנוע הכללים — לא מהעוזר.
      </div>
      {repo.mode === 'demo' ? (
        <div className="card"><p>במצב דמו העוזר כבוי ושום מידע לא נשלח. הוא זמין בחשבון המחובר לענן, אם הוגדר מפתח בשרת.</p></div>
      ) : (
        <DataState state={state} retry={retry}>
          {(d) => {
            const s = yearSummary(d.docs, d.allocations, year);
            const data: Record<string, unknown> = {
              today: todayLocal(), tax_year: year, vat_status: vatStatusOn(d.vat, todayLocal()),
              income_tax_regime: d.tax?.income_tax_regime ?? 'unknown', employed: d.tax?.employed ?? 'unknown',
              invoiced_shekels: s.invoiced / 100, received_by_receipts_shekels: s.received / 100,
              open_invoices: d.balances.filter((b) => b.balance_agorot > 0).length,
              open_balance_shekels: d.balances.reduce((x, b) => x + b.balance_agorot, 0) / 100,
              expenses_this_year_shekels: d.expenses.filter((e) => e.doc_date.startsWith(String(year))).reduce((x, e) => x + e.amount_agorot, 0) / 100,
              expenses_waiting_review: d.expenses.filter((e) => e.status === 'needs_review').length,
              exempt_ceiling_shekels: (rulesFor(year)?.exemptDealerCeiling.amount ?? 0) / 100,
            };
            if (includeNames) {
              data.open_balance_by_customer = d.balances.filter((b) => b.balance_agorot > 0).map((b) => ({
                customer: d.customers.find((c) => c.id === b.customer_id)?.name ?? '', invoice: b.number, open_shekels: b.balance_agorot / 100 }));
            }
            const ask = () => run(async () => {
              setError(null); setAnswer(null);
              const { data: sess } = await supabase().auth.getSession();
              try {
                const r = await fetch('/api/assistant', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${sess.session?.access_token ?? ''}` },
                  body: JSON.stringify({ question, data }) });
                const body = await r.json().catch(() => ({}));
                if (!r.ok) { setError(MESSAGES[body.code] ?? 'העוזר אינו זמין כרגע (השירות לא נמצא או נכשל). שום נתון לא השתנה.'); return; }
                setAnswer(body.answer || '(אין תשובה)');
              } catch { setError('אין תקשורת עם השרת. שום נתון לא השתנה.'); }
            });
            return (
              <section className="card" aria-labelledby="ask-h">
                <h2 id="ask-h">שאלה</h2>
                <form onSubmit={(e) => { e.preventDefault(); if (question.trim()) void ask(); }}>
                  <label htmlFor="q">מה תרצה לדעת?</label>
                  <textarea id="q" value={question} maxLength={2000} onChange={(e) => setQuestion(e.target.value)} placeholder="למשל: כמה נשאר לי עד תקרת עוסק פטור השנה?" />
                  <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
                    <input type="checkbox" checked={includeNames} onChange={(e) => setIncludeNames(e.target.checked)} style={{ width: 'auto' }} />
                    לכלול שמות לקוחות (כבוי כברירת מחדל)
                  </label>
                  <details style={{ marginTop: 8 }}>
                    <summary>מה יישלח לספק ה-AI</summary>
                    <pre className="ltr" style={{ whiteSpace: 'pre-wrap', fontSize: '.85rem' }} data-testid="ai-payload">{JSON.stringify(data, null, 2)}</pre>
                    <p className="muted">לא נשלחים מספרי זהות, כתובות, טלפונים או קבצים.</p>
                  </details>
                  <button className="btn" type="submit" disabled={busy || !question.trim()} style={{ marginTop: 8 }}>{busy ? 'שולח…' : 'שליחה'}</button>
                </form>
                {error && <p className="notice notice-warning" role="alert">{error}</p>}
                {answer && <div className="card" role="status" style={{ whiteSpace: 'pre-wrap', marginTop: 12 }}>{answer}<p className="muted">תשובת AI — יש לבדוק לפני הסתמכות.</p></div>}
              </section>
            );
          }}
        </DataState>
      )}
    </>
  );
}
