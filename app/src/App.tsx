import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { backendConfigured, supabase } from './data/backend';
import { DemoRepo } from './data/demoRepo';
import { SupabaseRepo } from './data/supabaseRepo';
import type { Repo } from './data/types';
import { useRoute } from './router';
import { ToastProvider } from './ui/kit';
import { HomePage } from './pages/Home';
import { IncomePage } from './pages/Income';
import { ExpensesPlaceholder as ExpensesPage, AssistantPlaceholder as AssistantPage } from './pages/Simple';
import { TaxesPage } from './pages/Taxes';
import { DocumentsPage } from './pages/Documents';
import { DocumentEditor } from './pages/DocumentEditor';
import { DocumentView } from './pages/DocumentView';
import { SettingsPage } from './pages/Settings';
import { LoginPage, SetupPage, NotAllowedPage } from './pages/Access';

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
  if (path === '/taxes') return <TaxesPage />;
  if (path === '/documents') return <DocumentsPage />;
  if (path === '/documents/new') return <DocumentEditor initialType={params.get('type')} />;
  const edit = /^\/documents\/([\w-]+)\/edit$/.exec(path);
  if (edit) return <DocumentEditor draftId={edit[1]} />;
  const view = /^\/documents\/([\w-]+)$/.exec(path);
  if (view) return <DocumentView id={view[1]} />;
  if (path === '/assistant') return <AssistantPage />;
  if (path === '/settings') return <SettingsPage />;
  return <div className="card"><h1>הדף לא נמצא</h1><a href="#/">חזרה לבית</a></div>;
}

function Shell({ repo, onExit, accountLabel, children }: { repo: Repo; onExit: () => void; accountLabel: string; children?: ReactNode }) {
  const route = useRoute();
  const path = route.split('?')[0];
  const lastPath = useRef(path);
  // Move focus to the new page's content on navigation (not on first load, so the skip link stays first).
  useEffect(() => {
    if (lastPath.current === path) return;
    lastPath.current = path;
    document.getElementById('main')?.focus();
  }, [path]);
  return (
    <RepoCtx.Provider value={repo}>
      <a className="skip-link" href="#main" onClick={(e) => { e.preventDefault(); document.getElementById('main')?.focus(); }}>דלג לתוכן</a>
      {repo.mode === 'demo' && (
        <div className="demo-banner" role="note">
          מצב דמו — נתונים סינתטיים שנשמרים רק בדפדפן הזה. אינם רשומות עסקיות אמיתיות ואינם מסונכרנים.
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
            <span className="spacer" />
            <span className="muted">{accountLabel}</span>
            <button className="btn btn-secondary" onClick={onExit}>{repo.mode === 'demo' ? 'יציאה ממצב דמו' : 'התנתקות'}</button>
          </header>
          <main id="main" className="content" tabIndex={-1}>
            {children ?? <Page route={route} />}
          </main>
        </div>
        <nav className="bottom-nav" aria-label="ניווט ראשי (נייד)">
          <NavList route={route} compact />
        </nav>
      </div>
    </RepoCtx.Provider>
  );
}

export function App() {
  const [demo, setDemo] = useState(() => { try { return localStorage.getItem(DEMO_FLAG) === '1'; } catch { return false; } });
  const [session, setSession] = useState<Session | null | undefined>(backendConfigured ? undefined : null);
  const [allowed, setAllowed] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    if (!backendConfigured) return;
    const sb = supabase();
    sb.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = sb.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) { setAllowed(undefined); return; }
    supabase().rpc('am_i_allowed').then(({ data, error }) => setAllowed(error ? false : Boolean(data)));
  }, [session]);

  const repo = useMemo<Repo | null>(() => {
    if (demo) return new DemoRepo();
    if (session && allowed) return new SupabaseRepo(supabase());
    return null;
  }, [demo, session, allowed]);

  const startDemo = () => { try { localStorage.setItem(DEMO_FLAG, '1'); } catch { /* ignore */ } setDemo(true); };
  const exitDemo = () => { try { localStorage.removeItem(DEMO_FLAG); } catch { /* ignore */ } setDemo(false); window.location.hash = '/'; };
  const signOut = async () => { await supabase().auth.signOut(); window.location.hash = '/'; };

  let body: ReactNode;
  if (repo) {
    body = <Shell repo={repo} onExit={demo ? exitDemo : signOut} accountLabel={demo ? 'דמו' : session?.user.email ?? ''} />;
  } else if (!backendConfigured) {
    body = <SetupPage onDemo={startDemo} />;
  } else if (session === undefined || (session && allowed === undefined)) {
    body = <p role="status" style={{ padding: 24 }}>טוען…</p>;
  } else if (!session) {
    body = <LoginPage onDemo={startDemo} />;
  } else {
    body = <NotAllowedPage email={session.user.email ?? ''} onSignOut={signOut} />;
  }
  return <ToastProvider>{body}</ToastProvider>;
}
