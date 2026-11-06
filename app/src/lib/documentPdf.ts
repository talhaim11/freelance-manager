import { DOC_TYPE_LABEL } from '../domain/documents';
import type { AllocationRecord, Customer, Doc, Profile, Repo } from '../data/types';
import { loadFonts, renderDocumentPdf, type Marking } from './pdf';
import { sha256Hex } from './sha256';

export interface PdfContext { doc: Doc; related: Doc | null; profile: Profile | null; customers: Customer[]; allocations: AllocationRecord[]; docs: Doc[] }

/**
 * Produces the PDF the user downloads. For an issued document both variants are rendered first,
 * then the server decides (atomically) whether this output is the original or a copy and records
 * the fingerprint of exactly that file. Drafts are rendered as "טיוטה — לא הופק" and not recorded.
 */
export async function producePdf(repo: Repo, c: PdfContext): Promise<{ bytes: Uint8Array; marking: Marking; filename: string }> {
  const fonts = await loadFonts(import.meta.env.BASE_URL ?? '/');
  const base = {
    doc: c.doc, related: c.related,
    issuer: c.doc.issuer_snapshot ?? c.profile,
    customer: c.doc.customer_snapshot ?? c.customers.find((x) => x.id === c.doc.customer_id) ?? null,
    paidInvoices: c.allocations.filter((a) => a.receipt_id === c.doc.id)
      .map((a) => ({ number: c.docs.find((d) => d.id === a.invoice_id)?.number ?? null, amount_agorot: a.amount_agorot })),
  };
  const name = `${DOC_TYPE_LABEL[c.doc.doc_type]}${c.doc.number !== null ? `-${c.doc.number}` : '-טיוטה'}`;
  if (c.doc.status === 'draft') {
    return { bytes: await renderDocumentPdf({ ...base, marking: 'draft' }, fonts), marking: 'draft', filename: `${name}.pdf` };
  }
  const now = new Date();
  const [original, copy] = await Promise.all([
    renderDocumentPdf({ ...base, marking: 'original', generatedAt: now }, fonts),
    renderDocumentPdf({ ...base, marking: 'copy', generatedAt: now }, fonts),
  ]);
  const kind = await repo.registerOutput(c.doc.id, { original: await sha256Hex(original), copy: await sha256Hex(copy) });
  return { bytes: kind === 'original' ? original : copy, marking: kind, filename: `${name}-${kind === 'original' ? 'מקור' : 'העתק'}.pdf` };
}

export function downloadBytes(bytes: Uint8Array, filename: string, type = 'application/pdf') {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
