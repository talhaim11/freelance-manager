import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { formatILS } from '../domain/money';
import { errorCode, errorMessage } from '../domain/errors';

/** Labeled form field with hint and error wired to aria-describedby. */
export function Field(props: {
  label: string; hint?: string; error?: string | null;
  children: (a: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }) => ReactNode;
}) {
  const id = useId();
  const hintId = props.hint ? `${id}-hint` : undefined;
  const errId = props.error ? `${id}-err` : undefined;
  const describedBy = [hintId, errId].filter(Boolean).join(' ') || undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{props.label}</label>
      {props.children({ id, 'aria-describedby': describedBy, 'aria-invalid': props.error ? true : undefined })}
      {props.hint && <span id={hintId} className="hint">{props.hint}</span>}
      {props.error && <span id={errId} className="error">{props.error}</span>}
    </div>
  );
}

export function Money({ agorot }: { agorot: number | null | undefined }) {
  if (agorot === null || agorot === undefined) return <span className="muted">—</span>;
  return <span className="num">{formatILS(agorot)}</span>;
}

/** Native <dialog> with built-in focus trapping; returns focus to the opener on close. */
export function Dialog(props: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (props.open && !d.open) d.showModal();
    if (!props.open && d.open) d.close();
  }, [props.open]);
  return (
    <dialog ref={ref} aria-labelledby={titleId} onClose={props.onClose} onCancel={props.onClose}>
      <h2 id={titleId}>{props.title}</h2>
      {props.children}
    </dialog>
  );
}

export type AsyncState<T> = { status: 'loading' } | { status: 'error'; message: string; code: string } | { status: 'ready'; data: T };

/** Fired after signing in again, so pages that failed to load retry. */
export const RECONNECTED_EVENT = 'fm:reconnected';

/** navigator.onLine with live updates. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  return online;
}

/**
 * Loads data with explicit loading / error+retry states. A failed load is retried
 * automatically when the connection comes back (reads only; writes are never replayed).
 */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): [AsyncState<T>, () => void] {
  const [state, setState] = useState<AsyncState<T>>({ status: 'loading' });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setState({ status: 'loading' });
    fn().then(
      (data) => alive && setState({ status: 'ready', data }),
      (e) => alive && setState({ status: 'error', message: errorMessage(e), code: errorCode(e) }),
    );
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const failed = state.status === 'error';
  useEffect(() => {
    if (!failed) return;
    const on = () => setTick((t) => t + 1);
    window.addEventListener('online', on);
    window.addEventListener(RECONNECTED_EVENT, on);
    return () => { window.removeEventListener('online', on); window.removeEventListener(RECONNECTED_EVENT, on); };
  }, [failed]);
  return [state, () => setTick((t) => t + 1)];
}

export function DataState<T>(props: { state: AsyncState<T>; retry: () => void; children: (data: T) => ReactNode }) {
  if (props.state.status === 'loading') return <p role="status">טוען…</p>;
  if (props.state.status === 'error') {
    return (
      <div className="notice notice-error" role="alert">
        <p>הטעינה נכשלה. לא נעשה שום שינוי בנתונים.</p>
        <p>{props.state.message}</p>
        <button className="btn btn-secondary" onClick={props.retry}>נסה שוב</button>
      </div>
    );
  }
  return <>{props.children(props.state.data)}</>;
}

type Toast = { id: number; text: string; kind: 'success' | 'error' | 'info' };
const ToastCtx = createContext<(text: string, kind?: Toast['kind']) => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => <div key={t.id} className={`toast notice-${t.kind}`}>{t.text}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}

/** Prevents double submission: the action runs at most once at a time. */
export function useBusy() {
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    if (running.current) return undefined;
    running.current = true; setBusy(true);
    try { return await fn(); } finally { running.current = false; setBusy(false); }
  }, []);
  return { busy, run };
}

export function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function fmtDate(d: string | null | undefined): string {
  if (!d) return '';
  const [y, m, day] = d.slice(0, 10).split('-');
  return `${day}/${m}/${y}`;
}
