import type { VatStatus, VatStatusPeriod } from '../domain/classification';
import type { DocLine, DocStatus, DocType, PaymentDetails } from '../domain/documents';

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
}

export interface Repo {
  readonly mode: 'demo' | 'supabase';
  getProfile(): Promise<Profile | null>;
  saveProfile(p: Profile): Promise<void>;
  listVatPeriods(): Promise<VatStatusPeriod[]>;
  addVatPeriod(p: Omit<VatStatusPeriod, 'id'>): Promise<void>;
  listCustomers(): Promise<Customer[]>;
  addCustomer(c: Omit<Customer, 'id'>): Promise<Customer>;
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
}
