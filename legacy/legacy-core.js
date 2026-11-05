/* Pure helpers shared by legacy/index.html, legacy/backup.html and unit tests.
 * No DOM access, no network. Works as a browser global (window.LegacyCore)
 * and as a CommonJS/ESM-importable module for tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.LegacyCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };
  /** Escapes any value for safe interpolation into HTML text or quoted attributes. */
  function esc(v) {
    return String(v === null || v === undefined ? '' : v).replace(/[&<>"'`]/g, (c) => ESC[c]);
  }

  /** Local calendar date YYYY-MM-DD (not UTC — avoids "yesterday" after midnight in Israel). */
  function localDateISO(d) {
    d = d || new Date();
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function yearOf(dateStr) {
    const y = parseInt(String(dateStr || '').slice(0, 4), 10);
    return Number.isFinite(y) ? y : null;
  }
  function monthOf(dateStr) {
    const m = parseInt(String(dateStr || '').slice(5, 7), 10);
    return Number.isFinite(m) ? m - 1 : null;
  }

  function emptyProfile() {
    return { name: '', id: '', business: '', address: '', phone: '', email: '' };
  }

  function normalize(d) {
    d = d && typeof d === 'object' ? d : {};
    return {
      profile: Object.assign(emptyProfile(), d.profile || {}),
      invoices: Array.isArray(d.invoices) ? d.invoices.slice() : [],
      expenses: Array.isArray(d.expenses) ? d.expenses.slice() : [],
      nextInvoiceNum: Number.isFinite(+d.nextInvoiceNum) && +d.nextInvoiceNum > 0 ? +d.nextInvoiceNum : 1,
      conflicts: Array.isArray(d.conflicts) ? d.conflicts.slice() : [],
      meta: Object.assign({ schema: 2 }, d.meta || {}),
    };
  }

  /** Deterministic JSON (sorted keys) for content comparison. */
  function stable(v) {
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    if (v && typeof v === 'object') {
      return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined)
        .map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
    }
    return JSON.stringify(v === undefined ? null : v);
  }

  /** Business content only (ignores sync metadata such as timestamps). */
  function contentKey(d) {
    const n = normalize(d);
    return stable({ profile: n.profile, invoices: n.invoices, expenses: n.expenses,
      nextInvoiceNum: n.nextInvoiceNum, conflicts: n.conflicts });
  }

  function hasContent(d) {
    const n = normalize(d);
    return n.invoices.length > 0 || n.expenses.length > 0 ||
      Object.values(n.profile).some((v) => String(v || '').trim() !== '');
  }

  function maxInvoiceNumber(invoices) {
    return invoices.reduce((m, i) => Math.max(m, +i.number || 0), 0);
  }

  /** Next invoice number that cannot collide with any known invoice. */
  function nextNumber(d) {
    const n = normalize(d);
    return Math.max(n.nextInvoiceNum, maxInvoiceNumber(n.invoices) + 1);
  }

  /**
   * Non-destructive merge of two copies of the data (e.g. this device and Drive).
   * - Records are matched by id; records present on only one side are kept.
   * - Same id with different content: the remote version stays in place and the
   *   local version is preserved in `conflicts` for review. Nothing is dropped.
   * - Numbering never moves backwards.
   */
  function mergeData(local, remote, now) {
    const l = normalize(local);
    const r = normalize(remote);
    const at = now || new Date().toISOString();
    const newConflicts = [];
    let addedFromLocal = 0;

    function mergeList(kind, localList, remoteList) {
      const byId = new Map(remoteList.map((x) => [String(x.id), x]));
      const out = remoteList.slice();
      for (const x of localList) {
        const key = String(x.id);
        if (!byId.has(key)) { out.push(x); byId.set(key, x); addedFromLocal++; continue; }
        const rx = byId.get(key);
        if (stable(rx) !== stable(x)) newConflicts.push({ kind, id: x.id, local: x, remote: rx, detectedAt: at });
      }
      return out.sort((a, b) => (+b.id || 0) - (+a.id || 0));
    }

    const invoices = mergeList('invoice', l.invoices, r.invoices);
    const expenses = mergeList('expense', l.expenses, r.expenses);

    let profile = r.profile;
    if (stable(l.profile) !== stable(r.profile)) {
      const remoteEmpty = !Object.values(r.profile).some((v) => String(v || '').trim());
      const localEmpty = !Object.values(l.profile).some((v) => String(v || '').trim());
      if (remoteEmpty) profile = l.profile;
      else if (!localEmpty) newConflicts.push({ kind: 'profile', id: 'profile', local: l.profile, remote: r.profile, detectedAt: at });
    }

    const seen = new Set();
    const conflicts = [];
    for (const c of r.conflicts.concat(l.conflicts, newConflicts)) {
      const k = c.kind + '|' + c.id + '|' + stable(c.local) + '|' + stable(c.remote);
      if (!seen.has(k)) { seen.add(k); conflicts.push(c); }
    }

    const merged = {
      profile, invoices, expenses, conflicts,
      nextInvoiceNum: Math.max(l.nextInvoiceNum, r.nextInvoiceNum, maxInvoiceNumber(invoices) + 1),
      meta: Object.assign({}, r.meta, { schema: 2 }),
    };
    return { data: merged, newConflicts, addedFromLocal };
  }

  /** Gaps and duplicates in invoice numbering (deleted or concurrently created invoices). */
  function numberingIssues(invoices) {
    const nums = invoices.map((i) => +i.number).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
    const duplicates = [];
    const gaps = [];
    for (let i = 1; i < nums.length; i++) {
      if (nums[i] === nums[i - 1] && duplicates[duplicates.length - 1] !== nums[i]) duplicates.push(nums[i]);
      for (let g = nums[i - 1] + 1; g < nums[i]; g++) gaps.push(g);
    }
    if (nums.length && nums[0] > 1) for (let g = 1; g < nums[0]; g++) gaps.unshift(g);
    return { gaps: gaps.sort((a, b) => a - b), duplicates };
  }

  const isActiveInvoice = (i) => i.status !== 'cancelled';
  const isActiveExpense = (e) => !e.deletedAt;

  function totalsByYear(d) {
    const n = normalize(d);
    const out = {};
    const slot = (y) => (out[y] = out[y] || { invoices: 0, invoiceCount: 0, expenses: 0, expenseCount: 0 });
    for (const i of n.invoices.filter(isActiveInvoice)) { const s = slot(yearOf(i.date) || 'unknown'); s.invoices += +i.total || 0; s.invoiceCount++; }
    for (const e of n.expenses.filter(isActiveExpense)) { const s = slot(yearOf(e.date) || 'unknown'); s.expenses += +e.amount || 0; s.expenseCount++; }
    return out;
  }

  function dataUrlInfo(dataUrl) {
    const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(String(dataUrl || ''));
    if (!m) return null;
    return { mime: m[1] || 'application/octet-stream', base64: !!m[2], payload: m[3] };
  }

  function dataUrlToBytes(dataUrl) {
    const info = dataUrlInfo(dataUrl);
    if (!info) return null;
    if (!info.base64) return new TextEncoder().encode(decodeURIComponent(info.payload));
    const bin = atob(info.payload);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  async function sha256Hex(input) {
    const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  /** Read-only audit manifest: counts, totals, numbering problems and attachment hashes. */
  async function buildManifest(raw, source) {
    const n = normalize(raw);
    const attachments = [];
    for (const e of n.expenses) {
      if (!e.receipt) continue;
      const bytes = dataUrlToBytes(e.receipt.data);
      attachments.push({
        expenseId: e.id, name: e.receipt.name || '', type: e.receipt.type || '',
        bytes: bytes ? bytes.length : null, sha256: bytes ? await sha256Hex(bytes) : null,
        valid: !!bytes,
      });
    }
    const issues = numberingIssues(n.invoices);
    return {
      source: source || 'unknown',
      generatedAt: new Date().toISOString(),
      schema: n.meta.schema,
      counts: {
        invoices: n.invoices.length,
        invoicesCancelled: n.invoices.filter((i) => !isActiveInvoice(i)).length,
        expenses: n.expenses.length,
        expensesDeleted: n.expenses.filter((e) => !isActiveExpense(e)).length,
        attachments: attachments.length,
        invalidAttachments: attachments.filter((a) => !a.valid).length,
        conflicts: n.conflicts.length,
      },
      totalsByYear: totalsByYear(n),
      invoiceNumbers: n.invoices.map((i) => +i.number).sort((a, b) => a - b),
      numbering: issues,
      nextInvoiceNum: n.nextInvoiceNum,
      attachments,
      contentSha256: await sha256Hex(contentKey(n)),
    };
  }

  // Verified exempt-dealer turnover ceilings (see UPGRADE_SPEC.md §6.1).
  // 2026: gov.il/he/pages/vat-rate-amount-new ; 2024–2025: VAT Law s.1 (120,000).
  const EXEMPT_CEILING = { 2024: 120000, 2025: 120000, 2026: 122833 };

  return {
    esc, localDateISO, yearOf, monthOf, normalize, stable, contentKey, hasContent,
    nextNumber, mergeData, numberingIssues, totalsByYear, isActiveInvoice, isActiveExpense,
    dataUrlInfo, dataUrlToBytes, sha256Hex, buildManifest, EXEMPT_CEILING,
  };
});
