import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { backendConfigured, backendLabel, backendState, supabase } from './data/backend';
import { DemoRepo } from './data/demoRepo';
import { SupabaseRepo } from './data/supabaseRepo';
import type { Repo } from './data/types';
import { useRoute } from './router';
import { RECONNECTED_EVENT, useOnline, useToast } from './ui/kit';
import { HomePage } from './pages/Home';
import { IncomePage } from './pages/Income';
import { AssistantPlaceholder as AssistantPage } from './pages/Simple';
import { ExpenseEditor, ExpensesPage } from './pages/Expenses';
import { TaxesPage } from './pages/Taxes';
import { DocumentsPage } from './pages/Documents';
import { DocumentEditor } from './pages/DocumentEditor';
import { DocumentView } from './pages/DocumentView';
import { SettingsPage } from './pages/Settings';
import { ConnectionErrorPage, LoginPage, NotAllowedPage, ReauthDialog, SetupPage } from './pages/Access';

const RepoCtx = createContext<Repo | null>(null);
export function useRepo(): Repo {
  const r = useContext(RepoCtx);
  if (!r) throw new Error('Repo missing');
  return r;
}

const DEMO_FLAG = 'fm_demo_mode';
const NAV = [
  { path: '/', icon: '🏠', label: 'בית' },
  { path: '/income', icon: '👥', label: 'הכנסות ולקוחות', short: 'הכנסות' },
  { path: '/expenses', icon: '🧾', label: 'הוצאות' },
  { path: '/taxes', icon: '📊', label: 'מסים ודוחות', short: 'מסים' },
  { path: '/documents', icon: '📄', label: 'מסמכים' },
  { path: '/assistant', icon: '💬', label: 'עוזר' },
  { path: '/settings', icon: '⚙️', label: 'הגדרות' },
];

function isCurrent(route: string, path: string) {
  return path === '/' ? route === '/' : route === path || route.startsWith(path + '/');
}

function NavList({ route, compact }: { route: string; compact?: boolean }) {
  return (
    <ul className="nav-list">
      {NAV.map((n) => (
        <li key={n.path}>
          <a className="nav-link" href={`#${n.path}`} aria-current={isCurrent(route, n.path) ? 'page' : undefined}>
            <span className="nav-icon" aria-hidden="true">{n.icon}</span>
            <span>{compact ? n.short ?? n.label : n.label}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

function Page({ route }: { route: string }) {
  const [path, query] = route.split('?');
  const params = new URLSearchParams(query ?? '');
  if (path === '/') return <HomePage />;
  if (path === '/income') return <IncomePage />;
  if (path === '/expenses') return <ExpensesPage />;
  if (path === '/expenses/new') return <ExpenseEditor />;
  const exp = /^\/expenses\/([\w-]+)$/.exec(path);
  if (exp) return <ExpenseEditor id={exp[1]} />;
  if (path === '/taxes') return <TaxesPage />;
  if (path === '/documents') return <DocumentsPage />;
  if (path === '/documents/new') return <DocumentEditor key={route} initialType={params.get('type')} fromInvoice={params.get('from')} />;
  const edit = /^\/documents\/([\w-]+)\/edit$/.exec(path);
  if (edit) return <DocumentEditor draftId={edit[1]} />;
  const view = /^\/documents\/([\w-]+)$/.exec(path);
  if (view) return <DocumentView id={view[1]} />;
  if (path === '/assistant') return <AssistantPage />;
  if (path === '/settings') return <SettingsPage />;
  return <div className="card"><h1>הדף לא נמצא</h1><a href="#/">חזרה לבית</a></div>;
}

/** Always-visible indicator of where data is going: demo (this browser only), cloud, or offline. */
function ModeBadge({ mode }: { mode: Repo['mode'] }) {
  const online = useOnline();
  if (mode === 'demo') return <span className="mode-badge mode-demo" data-testid="mode-badge">מצב דמו · מקומי בלבד</span>;
  return online
    ? <span className="mode-badge mode-cloud" data-testid="mode-badge" title="הנתונים נשמרים בשרת ומשותפים למחשב ולטלפון">☁ מחובר לענן · {backendLabel()}</span>
    : <span className="mode-badge mode-offline" data-testid="mode-badge" role="status">אין חיבור לרשת · שינויים לא יישמרו עד שהחיבור יחזור</span>;
}

function Shell({ repo, onExit, accountLabel, overlay }: { repo: Repo; onExit: () => void; accountLabel: string; overlay?: ReactNode }) {
  const route = useRoute();
  const path = route.split('?')[0];
  const lastPath = useRef(path);
  // Move focus to the new page's content on navigation (not on first load, so the skip link stays first).
  useEffect(() => {
    if (lastPath.current === path) return;
    lastPath.current = path;
    document.getElementById('main')?.focus();
  }, [path]);
  useEffect(() => { document.title = repo.mode === 'demo' ? '[דמו] ניהול עסק עצמאי' : 'ניהול עסק עצמאי'; }, [repo.mode]);
  return (
    <RepoCtx.Provider value={repo}>
      <a className="skip-link" href="#main" onClick={(e) => { e.preventDefault(); document.getElementById('main')?.focus(); }}>דלג לתוכן</a>
      {repo.mode === 'demo' && (
        <div className="demo-banner" role="note">
          מצב דמו — נתונים סינתטיים שנשמרים רק בדפדפן הזה. אינם רשומות עסקיות אמיתיות, אינם מסונכרנים ואינם מועלים לחשבון.
        </div>
      )}
      <div className="shell">
        <nav className="sidebar" aria-label="ניווט ראשי">
          <span className="brand">ניהול עסק עצמאי</span>
          <NavList route={route} />
        </nav>
        <div>
          <header className="topbar">
            <span className="brand">ניהול עסק עצמאי</span>
            <ModeBadge mode={repo.mode} />
            <span className="spacer" />
            <span className="muted account-label">{accountLabel}</span>
            <button className="btn btn-secondary" onClick={onExit}>{repo.mode === 'demo' ? 'יציאה ממצב דמו' : 'התנתקות'}</button>
          </header>
          <main id="main" className="content" tabIndex={-1}>
            <Page route={route} />
          </main>
        </div>
        <nav className="bottom-nav" aria-label="ניווט ראשי (נייד)">
          <NavList route={route} compact />
        </nav>
      </div>
      {overlay}
    </RepoCtx.Provider>
  );
}

type Account = { id: string; email: string };
type Access = 'checking' | 'allowed' | 'not_allowed' | 'error';

export function App() {
  const toast = useToast();
  const [demo, setDemo] = useState(() => { try { return localStorage.getItem(DEMO_FLAG) === '1'; } catch { return false; } });
  const [session, setSession] = useState<Session | null | undefined>(backendConfigured ? undefined : null);
  const [access, setAccess] = useState<Access>('checking');
  const [accessTick, setAccessTick] = useState(0);
  // The verified account whose data is on screen. It survives a lost session, so
  // unsaved work stays on screen while the user signs in again.
  const [account, setAccount] = useState<Account | null>(null);
  const [forceReauth, setForceReauth] = useState(false);

  useEffect(() => {
    if (!backendConfigured || demo) return;
    const sb = supabase();
    sb.auth.getSession().then(({ data }) => setSession(data.session), () => setSession(null));
    const { data: sub } = sb.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, [demo]);

  const userId = session?.user.id;
  useEffect(() => {
    if (!userId || demo) return;
    if (account?.id === userId) return; // already verified (token refresh or re-login as the same user)
    if (account && account.id !== userId) { window.location.reload(); return; } // never mix two accounts' data on screen
    let alive = true;
    setAccess('checking');
    supabase().rpc('am_i_allowed').then(({ data, error, status }) => {
      if (!alive) return;
      if (error) { setAccess(status === 403 || status === 404 ? 'not_allowed' : 'error'); return; }
      if (data === true) { setAccount({ id: userId, email: session?.user.email ?? '' }); setAccess('allowed'); }
      else setAccess('not_allowed');
    });
    return () => { alive = false; };
  }, [userId, demo, accessTick]); // eslint-disable-line react-hooks/exhaustive-deps

  // Depends on the account id only: a token refresh must not reset pages or unsaved forms.
  const accountId = account?.id;
  const repo = useMemo<Repo | null>(() => {
    if (demo) return new DemoRepo();
    if (accountId) return new SupabaseRepo(supabase(), () => setForceReauth(true));
    return null;
  }, [demo, accountId]);

  const startDemo = () => { try { localStorage.setItem(DEMO_FLAG, '1'); } catch { /* ignore */ } setDemo(true); };
  const exitDemo = () => { try { localStorage.removeItem(DEMO_FLAG); } catch { /* ignore */ } window.location.hash = '/'; window.location.reload(); };
  const signOut = async () => {
    setAccount(null); setForceReauth(false); setAccess('checking');
    try { await supabase().auth.signOut({ scope: 'local' }); } catch { /* handled below */ }
    // Signing out must work offline too: if the request failed, drop the stored session anyway.
    const { data } = await supabase().auth.getSession().catch(() => ({ data: { session: null } }));
    if (data.session) {
      try { Object.keys(localStorage).filter((k) => /^sb-.*-auth-token/.test(k)).forEach((k) => localStorage.removeItem(k)); } catch { /* ignore */ }
      window.location.hash = '/';
      window.location.reload();
      return;
    }
    window.location.hash = '/';
  };

  const needReauth = !demo && !!account && (session === null || forceReauth);

  if (repo) {
    return (
      <Shell repo={repo} onExit={demo ? exitDemo : () => void signOut()} accountLabel={demo ? 'דמו' : account?.email ?? ''}
        overlay={needReauth ? (
          <ReauthDialog email={account!.email}
            onDone={() => { setForceReauth(false); window.dispatchEvent(new Event(RECONNECTED_EVENT)); toast('התחברת מחדש. אפשר לנסות שוב את הפעולה.', 'success'); }}
            onSignOut={() => void signOut()} />
        ) : null} />
    );
  }
  if (backendState.kind === 'invalid') return <SetupPage onDemo={startDemo} problem={backendState.reason} />;
  if (!backendConfigured) return <SetupPage onDemo={startDemo} />;
  if (session === undefined || (session && access === 'checking')) return <p role="status" style={{ padding: 24 }}>טוען…</p>;
  if (!session) return <LoginPage onDemo={startDemo} />;
  if (access === 'error') return <ConnectionErrorPage onRetry={() => setAccessTick((t) => t + 1)} onSignOut={() => void signOut()} />;
  return <NotAllowedPage email={session.user.email ?? ''} onSignOut={() => void signOut()} />;
}
