import { useState } from 'react';
import { useRepo } from '../App';
import type { ExportResult } from '../data/backup';
import { manifestOf, planLegacyImport, type BackupPayload, type LegacyPlan } from '../domain/backup';
import { errorMessage } from '../domain/errors';
import { uuid } from '../lib/uuid';
import { Money, useBusy, useToast } from '../ui/kit';

const backupLib = () => import('../data/backup');
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

/** Backup (complete ZIP), verified restore into an empty account, and import from the previous app. */
export function BackupPanel() {
  const repo = useRepo();
  const toast = useToast();
  const { busy, run } = useBusy();
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<ExportResult['manifest'] | null>(null);
  const [restore, setRestore] = useState<{ payload: BackupPayload; files: Map<string, Uint8Array> } | null>(null);
  const [legacy, setLegacy] = useState<LegacyPlan | null>(null);
  const [result, setResult] = useState<{ title: string; differences: string[]; notes: string[] } | null>(null);

  const doExport = () => run(async () => {
    setError(null);
    try {
      const { exportAll, buildZip } = await backupLib();
      const { downloadBytes } = await import('../lib/documentPdf');
      const r = await exportAll(repo);
      const zip = await buildZip(r);
      downloadBytes(new Uint8Array(await zip.arrayBuffer()), `freelance-backup-${repo.mode === 'demo' ? 'DEMO-' : ''}${stamp()}.zip`, 'application/zip');
      setLast(r.manifest);
      toast('הגיבוי הורד. שמרו אותו במקום בטוח (למשל Google Drive).', 'success');
    } catch (e) { setError(errorMessage(e)); }
  });

  const pickBackup = (input: HTMLInputElement) => run(async () => {
    setError(null); setResult(null); setLegacy(null);
    const f = input.files?.[0]; input.value = '';
    if (!f) return;
    try { const { readZip } = await backupLib(); setRestore(await readZip(await f.arrayBuffer())); } catch (e) { setRestore(null); setError(errorMessage(e)); }
  });
  const doRestore = () => run(async () => {
    if (!restore) return;
    setError(null);
    try {
      const { restoreBackup } = await backupLib();
      const r = await restoreBackup(repo, restore.payload, restore.files);
      setResult({ title: 'השחזור הושלם', differences: r.differences, notes: Object.entries(r.counts).map(([k, v]) => `${k}: ${v}`) });
      setRestore(null);
    } catch (e) { setError(errorMessage(e)); }
  });

  const pickLegacy = (input: HTMLInputElement) => run(async () => {
    setError(null); setResult(null); setRestore(null);
    const f = input.files?.[0]; input.value = '';
    if (!f) return;
    try { setLegacy(planLegacyImport(JSON.parse(await f.text()), uuid)); } catch { setLegacy(null); setError('הקובץ אינו JSON תקין של האפליקציה הקודמת.'); }
  });
  const doLegacy = () => run(async () => {
    if (!legacy) return;
    setError(null);
    try {
      const { importLegacy } = await backupLib();
      const r = await importLegacy(repo, legacy);
      setResult({ title: 'הייבוא מהאפליקציה הקודמת הושלם', differences: r.differences, notes: [...r.skippedFiles.map((s) => `קובץ שלא יובא: ${s}`)] });
      setLegacy(null);
    } catch (e) { setError(errorMessage(e)); }
  });

  const m = restore ? manifestOf(restore.payload) : null;
  return (
    <section className="card" aria-labelledby="backup-h">
      <h2 id="backup-h">גיבוי, שחזור וייבוא</h2>
      <h3>גיבוי מלא</h3>
      <p>קובץ ZIP אחד: כל הרשומות (לשחזור), טבלאות CSV לרו"ח, כל הקבצים המקוריים, ודוח ביקורת עם ספירות, סכומים וטביעות SHA-256.</p>
      <button className="btn" disabled={busy} onClick={() => void doExport()}>{busy ? 'מכין…' : '⬇ הורדת גיבוי מלא'}</button>
      {last && <p className="muted" data-testid="backup-summary">בגיבוי: {last.counts.documents} מסמכים, {last.counts.customers} לקוחות, {last.counts.expenses} הוצאות, {last.counts.attachments} קבצים.</p>}

      <h3 style={{ marginTop: 16 }}>שחזור מגיבוי</h3>
      <p className="muted">משחזר לחשבון <strong>ריק</strong> בלבד (למשל פרויקט חדש). כל הרשומות נכנסות בפעולה אחת — או שהכל נשמר או ששום דבר לא משתנה — ואחר כך נבדקת התאמה מלאה לגיבוי.</p>
      <label className="btn btn-secondary">בחירת קובץ גיבוי (ZIP)
        <input type="file" accept=".zip,application/zip" className="sr-only" data-testid="restore-file" onChange={(e) => void pickBackup(e.currentTarget)} /></label>
      {restore && m && (
        <div className="notice notice-info" data-testid="restore-preview">
          <p>גיבוי מ-{restore.payload.exported_at.slice(0, 10)}{restore.payload.source === 'demo' ? ' (מצב דמו)' : ''}: {m.counts.documents} מסמכים ({m.counts.issued} הופקו, {m.counts.cancelled} בוטלו, {m.counts.drafts} טיוטות),
            {' '}{m.counts.customers} לקוחות, {m.counts.expenses} הוצאות, {m.counts.attachments} קבצים (טביעות SHA-256 נבדקו).</p>
          <div className="btn-row">
            <button className="btn" disabled={busy} onClick={() => void doRestore()}>{busy ? 'משחזר…' : 'שחזור לחשבון הזה'}</button>
            <button className="btn btn-secondary" onClick={() => setRestore(null)}>ביטול</button>
          </div>
        </div>
      )}

      <h3 style={{ marginTop: 16 }}>ייבוא מהאפליקציה הקודמת</h3>
      <p className="muted">בוחרים את הקובץ שהורד בכלי הגיבוי של האפליקציה הקודמת (<a href="/legacy/backup.html" target="_blank" rel="noopener">כלי גיבוי</a>).
        קודם מוצג מה ייובא — בלי לכתוב דבר. החשבוניות נשמרות עם <strong>המספרים המקוריים</strong> בסדרה היסטורית נפרדת, ולא מופקות מחדש. מצב התשלום שלהן לא ידוע, ולכן לא נוצרות קבלות.</p>
      <label className="btn btn-secondary">בחירת קובץ מהאפליקציה הקודמת (JSON)
        <input type="file" accept=".json,application/json" className="sr-only" data-testid="legacy-file" onChange={(e) => void pickLegacy(e.currentTarget)} /></label>
      {legacy && (
        <div className="notice notice-info" data-testid="legacy-preview">
          <p><strong>בדיקה לפני ייבוא (לא נכתב דבר):</strong> {legacy.summary.invoices} חשבוניות ({legacy.summary.cancelled} מבוטלות),
            {legacy.summary.numbers ? ` מספרים ${legacy.summary.numbers.min}–${legacy.summary.numbers.max},` : ''} {legacy.summary.customers} לקוחות,
            {' '}{legacy.summary.expenses} הוצאות, {legacy.summary.files} קבצים. סכום חשבוניות פעילות <Money agorot={legacy.summary.invoiceTotal} />, הוצאות <Money agorot={legacy.summary.expenseTotal} />.</p>
          {legacy.issues.length > 0 && <><p>לתשומת לב:</p><ul>{legacy.issues.map((i) => <li key={i}>{i}</li>)}</ul></>}
          <div className="btn-row">
            <button className="btn" disabled={busy || legacy.summary.invoices + legacy.summary.expenses === 0} onClick={() => void doLegacy()}>{busy ? 'מייבא…' : 'ייבוא'}</button>
            <button className="btn btn-secondary" onClick={() => setLegacy(null)}>ביטול</button>
          </div>
        </div>
      )}

      {result && (
        <div className={`notice ${result.differences.length ? 'notice-error' : 'notice-success'}`} role="status" data-testid="import-result">
          <p><strong>{result.title}.</strong> {result.differences.length ? 'נמצאו הבדלים מול הקובץ:' : 'אימות: ספירות, מספרי מסמכים, סכומים וטביעות הקבצים זהים לקובץ ✅'}</p>
          {result.differences.length > 0 && <ul>{result.differences.map((d) => <li key={d}>{d}</li>)}</ul>}
          {result.notes.length > 0 && <ul className="muted">{result.notes.map((d) => <li key={d}>{d}</li>)}</ul>}
        </div>
      )}
      {error && <p className="notice notice-error" role="alert">{error}</p>}
    </section>
  );
}
