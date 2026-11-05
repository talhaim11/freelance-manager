import { test, expect, type Page } from '@playwright/test';
import { FakeDrive } from './fake-google';

const LEGACY = `http://localhost:${process.env.FM_E2E_LEGACY_PORT ?? 4173}/`;

async function open(page: Page, drive: FakeDrive) {
  await drive.install(page);
  await page.addInitScript(() => localStorage.setItem('cfg_client_id', 'test-client.apps.googleusercontent.com'));
  await page.goto(LEGACY);
  await expect(page.locator('#drive-status')).not.toHaveText('טוען…');
}

const tab = (page: Page, name: string) => page.click(`nav button[onclick*="'${name}'"]`);

async function signIn(page: Page) {
  await page.waitForFunction(() => (window as any).google?.accounts);
  await page.click('#btn-signin');
  await expect(page.locator('#drive-status')).toHaveAttribute('data-state', /synced|error/);
}

async function addInvoice(page: Page, client: string, price = '500', notes = '') {
  await tab(page, 'new-invoice');
  await page.fill('#inv-client', client);
  await page.fill('#item-desc-0', 'שירות בדיקה');
  await page.fill('#item-price-0', price);
  if (notes) await page.fill('#inv-notes', notes);
  await page.click('#btn-save-invoice');
  await expect(page.locator('#tab-invoices')).toHaveClass(/active/);
}

const localData = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('freelance_local') || 'null'));
const snapshotCount = (page: Page) => page.evaluate(() => new Promise<number>((resolve) => {
  const r = indexedDB.open('freelance_snapshots', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('snapshots', { keyPath: 'at' });
  r.onsuccess = () => { const c = r.result.transaction('snapshots').objectStore('snapshots').count(); c.onsuccess = () => resolve(c.result); };
}));

test.describe('legacy app — reliable saving', () => {
  test('expired Google token: the save is reported as failed and the data survives a reload', async ({ page }) => {
    const drive = new FakeDrive();
    await open(page, drive);
    await signIn(page);
    await expect(page.locator('#drive-status')).toHaveAttribute('data-state', 'synced');

    drive.fail401 = true;
    await addInvoice(page, 'לקוח אחרי פקיעה');
    const status = page.locator('#drive-status');
    await expect(status).toHaveAttribute('data-state', 'error');
    await expect(status).toContainText('פג');
    await expect(status).not.toContainText('מסונכרן');
    await expect(page.locator('#btn-retry')).toBeVisible();
    expect(drive.json().invoices ?? []).toHaveLength(0); // nothing claimed to be in Drive

    await page.reload();
    await expect(page.locator('#drive-status')).toContainText('לא סונכרנו');
    await tab(page, 'invoices');
    await expect(page.locator('#invoices-table')).toContainText('לקוח אחרי פקיעה');
  });

  test('server error (500) shows a recoverable error, and retry succeeds', async ({ page }) => {
    const drive = new FakeDrive();
    await open(page, drive);
    await signIn(page);
    drive.failStatus = 500;
    await addInvoice(page, 'לקוח שגיאת שרת');
    await expect(page.locator('#drive-status')).toContainText('קוד 500');
    drive.failStatus = null;
    await page.click('#btn-retry');
    await expect(page.locator('#drive-status')).toHaveAttribute('data-state', 'synced');
    expect(drive.json().invoices.map((i: any) => i.clientName)).toContain('לקוח שגיאת שרת');
  });
});

test.describe('legacy app — no Drive overwrites', () => {
  test('signing in merges records saved on this device with the Drive file instead of replacing them', async ({ page }) => {
    const drive = new FakeDrive();
    drive.seed({ profile: {}, invoices: [{ id: 1, number: 1, clientName: 'מ-Drive', date: '2026-01-10', items: [], total: 100 }], expenses: [], nextInvoiceNum: 2 });
    await open(page, drive);
    await addInvoice(page, 'רק במכשיר'); // created offline: number 1 as well
    await signIn(page);
    await expect(page.locator('#drive-status')).toHaveAttribute('data-state', 'synced');
    const names = drive.json().invoices.map((i: any) => i.clientName).sort();
    expect(names).toEqual(['מ-Drive', 'רק במכשיר'].sort());
    expect(drive.json().nextInvoiceNum).toBe(2);
    expect((await localData(page)).invoices).toHaveLength(2);
    expect(await snapshotCount(page)).toBeGreaterThanOrEqual(3); // pre-upgrade + before-merge local/remote
    // the next invoice number cannot collide with either copy
    await tab(page, 'new-invoice');
    await expect(page.locator('#inv-num-display')).toHaveValue('#2');
  });

  test('a write from another device between load and save is merged, not overwritten', async ({ page }) => {
    const drive = new FakeDrive();
    drive.seed({ profile: {}, invoices: [], expenses: [], nextInvoiceNum: 1 });
    await open(page, drive);
    await signIn(page);
    drive.externalWrite((d) => { d.invoices.push({ id: 111, number: 1, clientName: 'מהטלפון', date: '2026-02-01', items: [], total: 50 }); d.nextInvoiceNum = 2; });
    await addInvoice(page, 'מהמחשב');
    await expect(page.locator('#drive-status')).toHaveAttribute('data-state', 'synced');
    const inv = drive.json().invoices;
    expect(inv.map((i: any) => i.clientName).sort()).toEqual(['מהטלפון', 'מהמחשב'].sort());
    // both devices produced number 1 → the duplicate is visible in the audit tool, never silently dropped
    expect(inv.map((i: any) => i.number).sort()).toEqual([1, 1]);
  });

  test('the same record edited on two devices keeps both versions as a visible conflict', async ({ page }) => {
    const drive = new FakeDrive();
    drive.seed({ profile: {}, invoices: [{ id: 5, number: 1, clientName: 'משותף', date: '2026-01-10', items: [], total: 100 }], expenses: [], nextInvoiceNum: 2 });
    await open(page, drive);
    await signIn(page);
    drive.externalWrite((d) => { d.invoices[0].notes = 'נערך בטלפון'; });
    page.once('dialog', (d) => d.accept('ביטול בדיקה'));
    await tab(page, 'invoices');
    await page.click("tr[data-invoice-id='5'] button:has-text('סמן כמבוטלת')");
    await expect(page.locator('#drive-status')).toHaveAttribute('data-state', 'synced');
    expect(drive.json().conflicts).toHaveLength(1);
    await tab(page, 'dashboard');
    await expect(page.locator('#conflict-banner')).toContainText('התנגשויות');
  });
});

test.describe('legacy app — integrity and safety', () => {
  test('script injection in customer name, notes and expense text is rendered as text', async ({ page }) => {
    const drive = new FakeDrive();
    await open(page, drive);
    const payload = '<img src=x onerror="window.__xss=1">';
    await addInvoice(page, payload, '100', '<script>window.__xss=2</script>');
    await tab(page, 'dashboard');
    await tab(page, 'invoices');
    await expect(page.locator('#invoices-table')).toContainText(payload);
    await page.click("button:has-text('הצג')");
    await expect(page.locator('#invoice-print-content')).toContainText(payload);
    await expect(page.locator('#invoice-print-content')).toContainText('<script>');
    await page.click("#invoice-modal button:has-text('סגור')");
    await tab(page, 'expenses');
    await page.fill('#exp-desc', '<svg onload="window.__xss=3">');
    await page.fill('#exp-amount', '10');
    await page.click('#btn-save-expense');
    await expect(page.locator('#expenses-table')).toContainText('<svg onload');
    expect(await page.evaluate(() => (window as any).__xss)).toBeUndefined();
  });

  test('double-clicking save creates exactly one invoice', async ({ page }) => {
    const drive = new FakeDrive();
    await open(page, drive);
    await tab(page, 'new-invoice');
    await page.fill('#inv-client', 'לחיצה כפולה');
    await page.fill('#item-desc-0', 'x');
    await page.fill('#item-price-0', '10');
    await page.locator('#btn-save-invoice').dblclick();
    await expect(page.locator('#tab-invoices')).toHaveClass(/active/);
    expect((await localData(page)).invoices).toHaveLength(1);
  });

  test('saved invoices cannot be deleted; cancelling requires a reason and keeps the record', async ({ page }) => {
    const drive = new FakeDrive();
    await open(page, drive);
    await addInvoice(page, 'לביטול', '300');
    await expect(page.locator('#invoices-table button:has-text("✕")')).toHaveCount(0);
    page.once('dialog', (d) => d.accept('סכום שגוי'));
    await page.click("button:has-text('סמן כמבוטלת')");
    await expect(page.locator('#invoices-table')).toContainText('מבוטלת');
    const inv = (await localData(page)).invoices[0];
    expect(inv).toMatchObject({ status: 'cancelled', cancelReason: 'סכום שגוי', number: 1 });
    await tab(page, 'dashboard');
    await expect(page.locator('#stats-grid')).toContainText('0 חשבוניות');
  });

  test('cancelling without a reason does nothing', async ({ page }) => {
    const drive = new FakeDrive();
    await open(page, drive);
    await addInvoice(page, 'נשאר', '300');
    page.once('dialog', (d) => d.accept(''));
    await page.click("button:has-text('סמן כמבוטלת')");
    expect((await localData(page)).invoices[0].status).toBe('issued');
  });

  test('deleted expenses go to a recoverable bin with their attachment', async ({ page }) => {
    const drive = new FakeDrive();
    await open(page, drive);
    await tab(page, 'expenses');
    await page.fill('#exp-desc', 'מחשב');
    await page.fill('#exp-amount', '1000');
    await page.setInputFiles('#exp-receipt', { name: 'r.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 synthetic') });
    await page.click('#btn-save-expense');
    page.once('dialog', (d) => d.accept());
    await page.click("#expenses-table button[aria-label='העבר לסל']");
    await expect(page.locator('#deleted-expenses')).toContainText('מחשב');
    const e = (await localData(page)).expenses[0];
    expect(e.deletedAt).toBeTruthy();
    expect(e.receipt.name).toBe('r.pdf');
    await page.click("#deleted-expenses button:has-text('שחזר')");
    await expect(page.locator('#expenses-table')).toContainText('מחשב');
  });
});

test.describe('legacy app — tax content', () => {
  test('obsolete brackets, deadlines and estimates are gone; verified ceiling is shown; no AI calls', async ({ page }) => {
    const drive = new FakeDrive();
    await open(page, drive);
    const html = await page.content();
    for (const stale of ['81480', '81,480', '30 ביוני', '31 במרץ', 'נספח ד', 'הערכת מס גסה', 'claude-sonnet']) expect(html).not.toContain(stale);
    await tab(page, 'tax');
    await expect(page.locator('#tab-tax')).toContainText('הוסרה');
    await expect(page.locator('#tab-tax')).toContainText('1320');
    await tab(page, 'dashboard');
    await expect(page.locator('#stats-grid')).toContainText('122,833');
    await expect(page.locator('#stats-grid')).toContainText('אינו רווח לצורכי מס');
    expect(drive.requests.filter((r) => r.startsWith('ANTHROPIC'))).toHaveLength(0);
  });
});

test.describe('legacy backup page', () => {
  test('reads local data, reports numbering problems and downloads the original unchanged', async ({ page }) => {
    const drive = new FakeDrive();
    await drive.install(page);
    const original = JSON.stringify({ profile: { name: 'סינתטי' }, invoices: [
      { id: 1, number: 1, clientName: 'א', date: '2026-01-01', items: [], total: 10 },
      { id: 2, number: 3, clientName: 'ב', date: '2026-01-02', items: [], total: 20 }], expenses: [], nextInvoiceNum: 4 });
    await page.addInitScript((o) => localStorage.setItem('freelance_local', o), original);
    await page.goto(LEGACY + 'backup.html');
    await expect(page.locator('#local-summary')).toContainText('חסרים מספרי חשבונית');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btn-local-raw')]);
    const text = await (await import('node:fs/promises')).readFile(await dl.path(), 'utf8');
    expect(text).toBe(original);
    expect(await page.evaluate(() => localStorage.getItem('freelance_local'))).toBe(original);
  });
});
