import type { VatStatus, VatStatusPeriod } from '../domain/classification';
import type { DocLine, DocStatus, DocType, PaymentDetails } from '../domain/documents';
import type { ExpenseStatus } from '../domain/expenses';
import type { Allocation, AllocationRecord, InvoiceBalance } from '../domain/payments';
export type { Allocation, AllocationRecord, InvoiceBalance };

export interface Profile {
  legal_name: string;
  business_name: string;
  id_number: string;
  address: string;
  phone: string;
  email: string;
}

export interface Customer {
  id: string;
  name: string;
  tax_id: string;
  address: string;
  email: string;
  phone: string;
}

export interface Series {
  id: string;
  doc_type: DocType;
  name: string;
  next_number: number;
  is_legacy: boolean;
}

export interface Doc {
  id: string;
  idempotency_key: string;
  series_id: string;
  doc_type: DocType;
  status: DocStatus;
  number: number | null;
  issue_date: string;
  customer_id: string | null;
  lines: DocLine[];
  notes: string;
  payment_details: PaymentDetails;
  /** Receipt drafts: invoices this payment should pay. Recorded in payment_allocations on issue. */
  allocations: Allocation[];
  customer_snapshot: (Omit<Customer, 'id'> & { id?: string }) | null;
  issuer_snapshot: Profile | null;
  subtotal_agorot: number | null;
  vat_agorot: number | null;
  total_agorot: number | null;
  vat_status_at_issue: VatStatus | null;
  corrects_document_id: string | null;
  correction_reason: string | null;
  cancelled_by_document_id: string | null;
  issued_at: string | null;
  cancelled_at: string | null;
  created_at: string;
}

export interface DraftInput {
  idempotency_key: string;
  series_id: string;
  doc_type: DocType;
  issue_date: string;
  customer_id: string | null;
  lines: DocLine[];
  notes: string;
  payment_details: PaymentDetails;
  allocations: Allocation[];
}

export interface Repo {
  readonly mode: 'demo' | 'supabase';
  getProfile(): Promise<Profile | null>;
  saveProfile(p: Profile): Promise<void>;
  listVatPeriods(): Promise<VatStatusPeriod[]>;
  addVatPeriod(p: Omit<VatStatusPeriod, 'id'>): Promise<void>;
  listCustomers(): Promise<Customer[]>;
  /** Idempotent by clientKey: a repeated call returns the customer created the first time. */
  addCustomer(c: Omit<Customer, 'id'>, clientKey: string): Promise<Customer>;
  updateCustomer(c: Customer): Promise<void>;
  listSeries(): Promise<Series[]>;
  addSeries(s: { doc_type: DocType; name: string; next_number: number }): Promise<Series>;
  listDocuments(): Promise<Doc[]>;
  getDocument(id: string): Promise<Doc | null>;
  /** Idempotent by idempotency_key: a repeated call returns the existing draft. */
  createDraft(d: DraftInput): Promise<Doc>;
  updateDraft(id: string, patch: Partial<Omit<DraftInput, 'idempotency_key'>>): Promise<void>;
  deleteDraft(id: string): Promise<void>;
  /** Transactional and idempotent: issuing an already-issued document returns it unchanged. */
  issueDocument(id: string): Promise<Doc>;
  /** Idempotent by key: issues one cancellation document referencing the original. */
  cancelDocument(id: string, reason: string, idempotencyKey: string): Promise<Doc>;

  /** Open and paid amounts of issued invoices. */
  listInvoiceBalances(): Promise<InvoiceBalance[]>;
  /** Recorded allocations where the document is the receipt or the invoice. */
  listAllocationsFor(documentId: string): Promise<AllocationRecord[]>;
  listAllocations(): Promise<AllocationRecord[]>;

  listExpenses(): Promise<Expense[]>;
  /** Creates (idempotent by client_key) or updates an expense. */
  saveExpense(e: ExpenseInput, id?: string): Promise<Expense>;
  /** Uploads the original file privately; repeating with the same attachment id is safe. */
  addExpenseAttachment(expenseId: string, file: AttachmentUpload): Promise<ExpenseAttachment>;
  /** Short-lived link to view a private attachment. */
  attachmentUrl(a: ExpenseAttachment): Promise<string>;
  /** The original bytes of a private attachment (for backups). */
  downloadAttachment(a: ExpenseAttachment): Promise<Uint8Array>;
  /** Uploads a file to the account's private folder under a fixed id; returns its storage path. Retry-safe. */
  uploadFile(id: string, bytes: Uint8Array, mime: string): Promise<string>;

  /** Records a PDF/print of an issued document: the first is the original, later ones are copies. */
  registerOutput(documentId: string, sha: { original: string; copy: string } | null): Promise<'original' | 'copy'>;
  listOutputs(documentId?: string): Promise<DocumentOutput[]>;

  getTaxProfile(): Promise<TaxProfile | null>;
  saveTaxProfile(t: Omit<TaxProfile, 'updated_at'>): Promise<void>;
  listSubmissions(): Promise<Submission[]>;
  saveSubmission(s: SubmissionInput, id?: string): Promise<Submission>;

  /** Imports a backup (mode restore, empty account only) or the previous app's data (mode legacy). One transaction. */
  importRecords(payload: unknown, mode: 'restore' | 'legacy'): Promise<Record<string, number>>;
  listAuditLog(): Promise<AuditEntry[]>;
}

export interface AuditEntry { action: string; entity: string; entity_id: string | null; details: Record<string, unknown>; at: string }
export interface DocumentOutput { document_id: string; kind: 'original' | 'copy'; sha256: string | null; created_at: string }

export type Tristate = 'unknown' | 'yes' | 'no';
export interface TaxProfile {
  income_tax_regime: 'unknown' | 'regular' | 'small_business';
  employed: Tristate;
  ni_self_employed: Tristate;
  advances_book: Tristate;
  onboarding_done: boolean;
  updated_at?: string;
}

export type SubmissionKind = 'vat_exempt_declaration' | 'small_business_report' | 'annual_1301' | 'income_tax_advance' | 'national_insurance';
export interface Submission {
  id: string;
  kind: SubmissionKind;
  tax_year: number;
  period: string;
  status: 'prepared' | 'submitted' | 'accepted' | 'rejected';
  reference: string;
  submitted_on: string | null;
  payment_status: 'not_due' | 'payment_pending' | 'paid';
  payment_reference: string;
  prepared_values: Record<string, unknown>;
  attachment_path: string | null;
  notes: string;
  created_at: string;
}
export type SubmissionInput = Omit<Submission, 'id' | 'created_at'>;

export interface Expense {
  id: string;
  client_key: string;
  supplier: string;
  supplier_tax_id: string;
  doc_number: string;
  doc_date: string;
  amount_agorot: number;
  vat_agorot: number;
  category: string;
  business_use_pct: number;
  status: ExpenseStatus;
  deductible_status: string;
  input_vat_status: string;
  notes: string;
  created_at: string;
  attachments: ExpenseAttachment[];
}

export type ExpenseInput = Omit<Expense, 'id' | 'created_at' | 'attachments' | 'deductible_status' | 'input_vat_status'>;

export interface ExpenseAttachment {
  id: string;
  expense_id: string;
  storage_path: string;
  sha256: string;
  mime_type: string;
  size_bytes: number;
  original_name: string;
  created_at: string;
}

export interface AttachmentUpload {
  /** Chosen once per selected file, so a retry after a lost response does not duplicate it. */
  id: string;
  bytes: Uint8Array;
  sha256: string;
  mime_type: string;
  original_name: string;
}
