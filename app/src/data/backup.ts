import JSZip from 'jszip';
import {
  compareManifests, dataUrlToBytes, manifestOf, shekels, toCsv, type BackupPayload, type LegacyPlan, type Manifest,
} from '../domain/backup';
import { DOC_TYPE_LABEL } from '../domain/documents';
import { attachmentProblem, EXPENSE_CATEGORIES } from '../domain/expenses';
import { AppError } from '../domain/errors';
import { sha256Hex } from '../lib/sha256';
import { uuid } from '../lib/uuid';
import type { ExpenseAttachment, Repo } from './types';

export interface ExportResult { payload: BackupPayload; files: Map<string, Uint8Array>; manifest: Manifest }

/** Reads everything the account owns, including the original attachment bytes (checked against their SHA-256). */
export async function exportAll(repo: Repo): Promise<ExportResult> {
  const [profile, vat, taxProfile, customers, series, documents, allocations, expenses, submissions] = await Promise.all([
    repo.getProfile(), repo.listVatPeriods(), repo.getTaxProfile(), repo.listCustomers(), repo.listSeries(), repo.listDocuments(),
    repo.listAllocations(), repo.listExpenses(), repo.listSubmissions()]);
  const attachments = expenses.flatMap((e) => e.attachments);
  const files = new Map<string, Uint8Array>();
  for (const a of attachments) {
    const bytes = await repo.downloadAttachment(a);
    if (await sha256Hex(bytes) !== a.sha256) throw new AppError('BACKUP_FILE_MISMATCH', a.id);
    files.set(a.id, bytes);
  }
  const payload: BackupPayload = {
    format: 'freelance-manager-backup', version: 1, exported_at: new Date().toISOString(), source: repo.mode,
    profile, vat_periods: vat.map(({ id: _id, ...v }) => v), tax_profile: taxProfile,
    customers, series, documents, allocations,
    expenses: expenses.map(({ attachments: _a, ...e }) => e), attachments, submissions,
  };
  return { payload, files, manifest: manifestOf(payload) };
}

/** A complete export: backup.json (restorable), manifest.json, CSV tables for an accountant, and every original file. */
export async function buildZip({ payload, files, manifest }: ExportResult): Promise<Blob> {
  const zip = new JSZip();
  zip.file('backup.json', JSON.stringify(payload, null, 1));
  zip.file('manifest.json', JSON.stringify({ ...manifest, exported_at: payload.exported_at,
    files: payload.attachments.map((a) => ({ path: filePath(a.id, a.original_name), sha256: a.sha256, size: a.size_bytes })) }, null, 1));
  const cust = new Map(payload.customers.map((c) => [c.id, c.name]));
  const series = new Map(payload.series.map((s) => [s.id, s.name]));
  zip.file('csv/documents.csv', toCsv(payload.documents.map((d) => ({
    type: DOC_TYPE_LABEL[d.doc_type], series: series.get(d.series_id) ?? '', number: d.number ?? '', status: d.status, date: d.issue_date,
    customer: d.customer_snapshot?.name ?? cust.get(d.customer_id ?? '') ?? '', total: shekels(d.total_agorot),
    payment_method: d.payment_details?.method ?? '', notes: d.notes, issued_at: d.issued_at ?? '',
  })), ['type', 'series', 'number', 'status', 'date', 'customer', 'total', 'payment_method', 'notes', 'issued_at']));
  const docNum = new Map(payload.documents.map((d) => [d.id, d.number]));
  zip.file('csv/payment_allocations.csv', toCsv(payload.allocations.map((a) => ({
    receipt_number: docNum.get(a.receipt_id) ?? '', invoice_number: docNum.get(a.invoice_id) ?? '', amount: shekels(a.amount_agorot),
  })), ['receipt_number', 'invoice_number', 'amount']));
  zip.file('csv/customers.csv', toCsv(payload.customers as unknown as Record<string, unknown>[], ['name', 'tax_id', 'address', 'email', 'phone']));
  zip.file('csv/expenses.csv', toCsv(payload.expenses.map((e) => ({
    date: e.doc_date, supplier: e.supplier, supplier_tax_id: e.supplier_tax_id, doc_number: e.doc_number, amount: shekels(e.amount_agorot),
    vat_on_document: shekels(e.vat_agorot), category: EXPENSE_CATEGORIES[e.category] ?? e.category, business_use_pct: e.business_use_pct,
    status: e.status, deductible: e.deductible_status, files: payload.attachments.filter((a) => a.expense_id === e.id).map((a) => filePath(a.id, a.original_name)).join(' | '),
  })), ['date', 'supplier', 'supplier_tax_id', 'doc_number', 'amount', 'vat_on_document', 'category', 'business_use_pct', 'status', 'deductible', 'files']));
  for (const a of payload.attachments) { const b = files.get(a.id); if (b) zip.file(filePath(a.id, a.original_name), b); }
  zip.file('README.txt', 'גיבוי של ניהול עסק עצמאי.\nbackup.json — לשחזור מלא באפליקציה (הגדרות → גיבוי ושחזור).\nmanifest.json — ספירות, סכומים, מספרי מסמכים וטביעות SHA-256 לאימות.\ncsv/ — טבלאות לרו"ח (UTF-8).\nfiles/ — הקבצים המקוריים.\n');
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
}

const filePath = (id: string, name: string) => `files/${id}-${(name || 'file').replace(/[\\/:*?"<>|]/g, '_')}`;

export async function readZip(blob: Blob | ArrayBuffer | Uint8Array): Promise<{ payload: BackupPayload; files: Map<string, Uint8Array> }> {
  const zip = await JSZip.loadAsync(blob);
  const json = await zip.file('backup.json')?.async('string');
  if (!json) throw new AppError('IMPORT_INVALID', 'backup.json missing');
  const payload = JSON.parse(json) as BackupPayload;
  if (payload.format !== 'freelance-manager-backup' || payload.version !== 1) throw new AppError('IMPORT_INVALID');
  const files = new Map<string, Uint8Array>();
  for (const a of payload.attachments) {
    const f = zip.file(filePath(a.id, a.original_name));
    if (!f) throw new AppError('BACKUP_FILE_MISMATCH', `missing ${a.id}`);
    const bytes = await f.async('uint8array');
    if (await sha256Hex(bytes) !== a.sha256) throw new AppError('BACKUP_FILE_MISMATCH', a.id);
    files.set(a.id, bytes);
  }
  return { payload, files };
}

export interface RestoreResult { counts: Record<string, number>; differences: string[] }

/**
 * Restores a backup into an EMPTY account: uploads the files privately (new ids), imports all records in one
 * transaction, then exports again and compares the manifest (counts, numbers, totals, file fingerprints).
 */
export async function restoreBackup(repo: Repo, payload: BackupPayload, files: Map<string, Uint8Array>): Promise<RestoreResult> {
  const attachments: ExpenseAttachment[] = [];
  for (const a of payload.attachments) {
    const bytes = files.get(a.id);
    if (!bytes || await sha256Hex(bytes) !== a.sha256) throw new AppError('BACKUP_FILE_MISMATCH', a.id);
    const id = uuid();
    attachments.push({ ...a, id, storage_path: await repo.uploadFile(id, bytes, a.mime_type) });
  }
  const counts = await repo.importRecords({ ...payload, attachments }, 'restore');
  const after = await exportAll(repo);
  return { counts, differences: compareManifests(manifestOf(payload), after.manifest) };
}

/** Uploads the previous app's files, imports in one transaction, then verifies the imported legacy records. */
export async function importLegacy(repo: Repo, plan: LegacyPlan): Promise<RestoreResult & { skippedFiles: string[] }> {
  const skippedFiles: string[] = [];
  const attachments: ExpenseAttachment[] = [];
  for (const meta of plan.payload.attachments) {
    const f = plan.files.find((x) => x.key === meta.id)!;
    const bytes = dataUrlToBytes(f.dataUrl);
    const problem = attachmentProblem({ type: f.type, size: bytes.length });
    if (problem) { skippedFiles.push(`${f.name}: ${problem}`); continue; }
    const id = uuid();
    attachments.push({ ...meta, id, sha256: await sha256Hex(bytes), size_bytes: bytes.length, mime_type: f.type, storage_path: await repo.uploadFile(id, bytes, f.type) });
  }
  const payload = { ...plan.payload, attachments };
  const counts = await repo.importRecords(payload, 'legacy');
  const after = await exportAll(repo);
  const legacySeries = new Set(after.payload.series.filter((s) => s.is_legacy).map((s) => s.id));
  const imported: BackupPayload = { ...after.payload,
    customers: [], series: after.payload.series.filter((s) => s.is_legacy), documents: after.payload.documents.filter((d) => legacySeries.has(d.series_id)),
    allocations: [], submissions: [],
    expenses: after.payload.expenses.filter((e) => plan.payload.expenses.some((x) => x.supplier === e.supplier && x.doc_date === e.doc_date && x.amount_agorot === e.amount_agorot)),
    attachments: after.payload.attachments.filter((a) => attachments.some((x) => x.sha256 === a.sha256)) };
  const expected = manifestOf({ ...payload, customers: [] });
  return { counts, skippedFiles, differences: compareManifests(expected, manifestOf(imported), ['customers', 'expenses']) };
}
