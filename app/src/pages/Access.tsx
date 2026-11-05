import { useEffect, useRef, useState } from 'react';
import { supabase } from '../data/backend';
import { authErrorMessage } from '../domain/errors';
import { Field, useBusy } from '../ui/kit';

function Frame({ children }: { children: React.ReactNode }) {
  return <main id="main" className="content" style={{ maxWidth: 560 }}>{children}</main>;
}

const PROBLEM_TEXT: Record<string, string> = {
  privileged_key: 'הוגדר מפתח בעל הרשאות מלאות (secret / service_role). מפתח כזה אסור בדפדפן, ולכן האפליקציה לא התחברה. החליפו אותו במפתח הציבורי (publishable) בקובץ .env.local, והחליפו (rotate) את המפתח שנחשף.',
  bad_url: 'כתובת הפרויקט (VITE_SUPABASE_URL) אינה תקינה.',
};

export function SetupPage({ onDemo, problem }: { onDemo: () => void; problem?: string }) {
  return (
    <Frame>
      <h1>ניהול עסק עצמאי — גרסה חדשה</h1>
      {problem ? (
        <div className="notice notice-error" role="alert">{PROBLEM_TEXT[problem] ?? problem}</div>
      ) : (
        <div className="notice notice-warning" role="note">
          השרת (Supabase) עדיין לא הוגדר לגרסה הזו, ולכן אין גישה לרשומות אמיתיות.
          הוראות ההגדרה נמצאות בקובץ <span className="ltr">docs/SETUP.md</span>.
        </div>
      )}
      <div className="card">
        <h2>לנסות בינתיים</h2>
        <p>מצב דמו מציג את המסכים עם נתונים סינתטיים בלבד, שנשמרים רק בדפדפן הזה ונפרדים לגמרי מהנתונים האמיתיים.</p>
        <button className="btn" onClick={onDemo}>פתיחה במצב דמו</button>
      </div>
    </Frame>
  );
}

function PasswordForm({ email: fixedEmail, submitLabel, onSuccess }: { email?: string; submitLabel: string; onSuccess?: () => void }) {
  const [email, setEmail] = useState(fixedEmail ?? '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useBusy();
  const submit = () => run(async () => {
    setError(null);
    if (!email.trim() || !password) { setError('יש למלא דוא״ל וסיסמה.'); return; }
    let res;
    try { res = await supabase().auth.signInWithPassword({ email: email.trim(), password }); }
    catch (e) { setError(authErrorMessage(e as Error)); return; }
    if (res.error) { setError(authErrorMessage(res.error)); return; }
    setPassword('');
    onSuccess?.();
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate>
      {fixedEmail ? (
        <p>חשבון: <span className="ltr">{fixedEmail}</span></p>
      ) : (
        <Field label="כתובת דוא״ל">
          {(a) => <input {...a} type="email" dir="ltr" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />}
        </Field>
      )}
      <Field label="סיסמה">
        {(a) => <input {...a} type="password" dir="ltr" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
      </Field>
      {error && <p className="notice notice-error" role="alert">{error}</p>}
      <button className="btn" type="submit" disabled={busy}>{busy ? 'מתחבר…' : submitLabel}</button>
    </form>
  );
}

export function LoginPage({ onDemo }: { onDemo: () => void }) {
  return (
    <Frame>
      <h1>כניסה</h1>
      <div className="card">
        <p className="muted">כניסה לחשבון הקיים בלבד. אין הרשמה ציבורית — החשבון נוצר מראש בלוח הבקרה של Supabase.</p>
        <PasswordForm submitLabel="כניסה" />
        <details style={{ marginTop: 12 }}>
          <summary>שכחתי סיסמה</summary>
          <p>איפוס סיסמה נעשה בלוח הבקרה של Supabase (Authentication → Users). שליחת דוא״ל איפוס תתווסף כשיוגדר שרת דוא״ל.</p>
        </details>
      </div>
      <button className="btn btn-secondary" onClick={onDemo}>פתיחה במצב דמו (נתונים סינתטיים, מקומי בלבד)</button>
    </Frame>
  );
}

/** Shown over the app when the session expired: the page and any unsaved form stay intact underneath. */
export function ReauthDialog({ email, onDone, onSignOut }: { email: string; onDone: () => void; onSignOut: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const d = ref.current; if (d && !d.open) d.showModal(); }, []);
  return (
    <dialog ref={ref} aria-labelledby="reauth-h" onCancel={(e) => e.preventDefault()}>
      <h2 id="reauth-h">צריך להתחבר מחדש</h2>
      <p>החיבור לחשבון פג. שום דבר לא נמחק: מה שהקלדת נשאר על המסך. פעולה שנכשלה לא בוצעה — אחרי הכניסה אפשר לנסות שוב.</p>
      <PasswordForm email={email} submitLabel="כניסה מחדש" onSuccess={onDone} />
      <button className="btn btn-secondary" style={{ marginTop: 8 }} onClick={onSignOut}>התנתקות</button>
    </dialog>
  );
}

export function ConnectionErrorPage({ onRetry, onSignOut }: { onRetry: () => void; onSignOut: () => void }) {
  return (
    <Frame>
      <h1>אין תקשורת עם השרת</h1>
      <div className="notice notice-error" role="alert">לא ניתן לבדוק את ההרשאה כרגע. לא הוצגו ולא נשמרו נתונים.</div>
      <div className="btn-row">
        <button className="btn" onClick={onRetry}>נסה שוב</button>
        <button className="btn btn-secondary" onClick={onSignOut}>התנתקות</button>
      </div>
    </Frame>
  );
}

export function NotAllowedPage({ email, onSignOut }: { email: string; onSignOut: () => void }) {
  return (
    <Frame>
      <h1>אין הרשאה</h1>
      <div className="notice notice-error" role="alert">
        החשבון <span className="ltr">{email}</span> מחובר, אבל אינו ברשימת המורשים. לא מוצגים ולא נשמרים נתונים.
      </div>
      <button className="btn btn-secondary" onClick={onSignOut}>התנתקות</button>
    </Frame>
  );
}
