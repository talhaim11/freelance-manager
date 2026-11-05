import { useState } from 'react';
import { supabase } from '../data/backend';
import { Field, useBusy } from '../ui/kit';

function Frame({ children }: { children: React.ReactNode }) {
  return <main id="main" className="content" style={{ maxWidth: 560 }}>{children}</main>;
}

export function SetupPage({ onDemo }: { onDemo: () => void }) {
  return (
    <Frame>
      <h1>ניהול עסק עצמאי — גרסה חדשה</h1>
      <div className="notice notice-warning" role="note">
        השרת (Supabase) עדיין לא הוגדר לגרסה הזו, ולכן אין גישה לרשומות אמיתיות.
        הוראות ההגדרה נמצאות בקובץ <span className="ltr">docs/SETUP.md</span>.
      </div>
      <div className="card">
        <h2>לנסות בינתיים</h2>
        <p>מצב דמו מציג את המסכים עם נתונים סינתטיים בלבד, שנשמרים רק בדפדפן הזה ונפרדים לגמרי מהנתונים האמיתיים.</p>
        <button className="btn" onClick={onDemo}>פתיחה במצב דמו</button>
      </div>
    </Frame>
  );
}

export function LoginPage({ onDemo }: { onDemo: () => void }) {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'sent' | 'error'>('idle');
  const { busy, run } = useBusy();
  const send = () => run(async () => {
    // shouldCreateUser:false — no public registration; only an existing, allow-listed account can sign in.
    const { error } = await supabase().auth.signInWithOtp({
      email: email.trim(), options: { shouldCreateUser: false, emailRedirectTo: window.location.origin + window.location.pathname },
    });
    setState(error ? 'error' : 'sent');
  });
  return (
    <Frame>
      <h1>כניסה</h1>
      <div className="card">
        <form onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <Field label="כתובת דוא״ל" hint="יישלח קישור כניסה חד-פעמי. אין הרשמה ציבורית.">
            {(a) => <input {...a} type="email" dir="ltr" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />}
          </Field>
          <button className="btn" type="submit" disabled={busy}>{busy ? 'שולח…' : 'שליחת קישור כניסה'}</button>
        </form>
        <div role="status" aria-live="polite" style={{ marginTop: 12 }}>
          {state === 'sent' && <p className="notice notice-success">אם הכתובת מורשית, נשלח אליה קישור כניסה. פתחו אותו במכשיר הזה.</p>}
          {state === 'error' && <p className="notice notice-error">השליחה נכשלה. בדקו את הכתובת ונסו שוב.</p>}
        </div>
      </div>
      <button className="btn btn-secondary" onClick={onDemo}>פתיחה במצב דמו (נתונים סינתטיים)</button>
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
