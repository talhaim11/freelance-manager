// Live browser suite for M2 against a real Supabase stack: computer + phone (Pixel 7).
import { test, expect, devices, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { loadLiveTarget } from './env';

const { target } = loadLiveTarget();
test.skip(!target, 'no live Supabase target configured');
const T = target!;
// FM_LIVE_BASE_URL runs the suite against a deployed site (e.g. a Netlify draft deploy) instead of local vite.
const BASE = process.env.FM_LIVE_BASE_URL ?? 'http://localhost:5175/';
const RUN = randomUUID().slice(0, 6);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function loginOwner(page: Page) {
  await page.goto(BASE);
  await expect(page.getByRole('heading', { name: 'כניסה' })).toBeVisible();
  await page.getByLabel('כתובת דוא״ל').fill(T.owner.email);
  await page.getByLabel('סיסמה').fill(T.owner.password);
  await page.getByRole('button', { name: 'כניסה', exact: true }).click();
  await expect(page.getByTestId('mode-badge')).toContainText('מחובר לענן');
}

async function ensureSeries(page: Page) {
  const create = page.getByRole('button', { name: 'יצירת סדרה' });
  if (await create.isVisible().catch(() => false)) { await create.click(); await expect(page.getByLabel('סדרת מספור')).toBeVisible(); }
}

test('computer and phone: inline customer, invoice, partial payment from the phone, private receipt photo', async ({ page, browser }) => {
  const phoneCtx = await browser.newContext({ ...devices['Pixel 7'], locale: 'he-IL', timezoneId: 'Asia/Jerusalem' });
  const phone = await phoneCtx.newPage();
  await loginOwner(page);
  await loginOwner(phone);

  // Computer: invoice for a customer added from inside the document.
  const customer = `לקוח M2 ${RUN}`;
  await page.goto(BASE + '#/documents/new?type=transaction_invoice');
  await ensureSeries(page);
  await page.getByLabel('תיאור (שורה 1)').fill('ליווי פרויקט');
  await page.getByLabel('מחיר ליחידה (₪)').fill('250');
  await page.getByRole('button', { name: '+ לקוח חדש' }).click();
  const dialog = page.getByRole('dialog', { name: 'לקוח חדש' });
  await dialog.getByLabel('שם (חובה)').fill(customer);
  await dialog.getByLabel(/כתובת/).fill('רחוב הבדיקה 9, חיפה');
  await dialog.getByRole('button', { name: 'שמירת לקוח' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByLabel('תיאור (שורה 1)')).toHaveValue('ליווי פרויקט');
  await page.getByRole('button', { name: 'שמירה והמשך להפקה' }).click();
  await page.getByRole('button', { name: 'כן, להפיק' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/חשבונית עסקה \d+/);
  const invoiceUrl = page.url();
  const invNo = (await page.getByRole('heading', { level: 1 }).locator('.num').textContent())!.trim();

  // Phone: sees the open invoice and records a partial payment from it.
  await phone.goto(BASE + '#/income');
  await phone.reload();
  const row = phone.getByRole('row').filter({ hasText: customer }).filter({ hasText: 'קבלה על תשלום' });
  await expect(row).toContainText('250.00');
  await row.getByRole('link', { name: 'קבלה על תשלום' }).click();
  await ensureSeries(phone);
  await expect(phone.getByLabel('מחיר ליחידה (₪)')).toHaveValue('250.00');
  await phone.getByLabel('מחיר ליחידה (₪)').fill('100');
  await expect(phone.getByLabel(`סכום לשיוך לחשבונית ${invNo}`)).toHaveValue('100.00');
  await phone.getByLabel('אמצעי תשלום').selectOption({ label: 'אפליקציית תשלום' });
  await phone.getByRole('button', { name: 'שמירה והמשך להפקה' }).click();
  await phone.getByRole('button', { name: 'כן, להפיק' }).click();
  await expect(phone.getByRole('heading', { level: 1 })).toContainText(/קבלה \d+/);
  expect(await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);

  // Computer: after refreshing, the invoice shows the payment and the open balance.
  await page.goto(invoiceUrl);
  await page.reload();
  await expect(page.getByTestId('invoice-balance')).toContainText(/שולם\s*\S?100\.00/);
  await expect(page.getByTestId('invoice-balance')).toContainText(/יתרה פתוחה\s*\S?150\.00/);

  // Phone: an expense with a photo of the supplier's receipt.
  const supplier = `ספק M2 ${RUN}`;
  await phone.goto(BASE + '#/expenses/new');
  await phone.getByLabel('ספק (חובה)').fill(supplier);
  await phone.getByLabel('סכום ששולם (₪, חובה)').fill('59.90');
  await phone.getByTestId('expense-file').setInputFiles({ name: 'צילום-קבלה.png', mimeType: 'image/png', buffer: PNG });
  await phone.getByRole('button', { name: 'שמירה' }).click();
  await expect(phone.getByRole('heading', { level: 1 })).toHaveText('הוצאה');
  await expect(phone.getByText('צילום-קבלה.png')).toBeVisible();
  await phone.screenshot({ path: 'test-results/live-phone-expense.png' });

  // Computer: the expense and its private file are there after refreshing, viewable through a signed link.
  await page.goto(BASE + '#/expenses');
  await page.reload();
  const exp = page.getByRole('row').filter({ hasText: supplier });
  await expect(exp).toContainText('📎 1');
  await exp.getByRole('link', { name: supplier }).click();
  await page.getByRole('button', { name: 'הצגה' }).click();
  const img = page.getByRole('img', { name: /מסמך מקור/ });
  await expect(img).toBeVisible();
  expect(await img.getAttribute('src')).toMatch(/\/storage\/v1\/object\/sign\/expense-files\//);
  await page.screenshot({ path: 'test-results/live-computer-expense.png' });
  await phoneCtx.close();
});

test('an attachment upload that fails keeps the expense and the chosen file; retrying stores it once', async ({ page }) => {
  await loginOwner(page);
  const supplier = `ספק ניסיון חוזר ${RUN}`;
  await page.goto(BASE + '#/expenses/new');
  await page.getByLabel('ספק (חובה)').fill(supplier);
  await page.getByLabel('סכום ששולם (₪, חובה)').fill('20');
  await page.getByTestId('expense-file').setInputFiles({ name: 'קבלה.png', mimeType: 'image/png', buffer: PNG });
  // The upload request is lost on its way to the storage server.
  await page.route('**/storage/v1/object/expense-files/**', (route) => route.abort('failed'), { times: 1 });
  await page.getByRole('button', { name: 'שמירה' }).click();
  await expect(page.getByRole('alert')).toContainText('ההוצאה נשמרה, אבל הקובץ');
  await expect(page.getByTestId('pending-file')).toContainText('קבלה.png');
  await page.getByRole('button', { name: 'שמירה' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('הוצאה');
  await page.goto(BASE + '#/expenses');
  await page.reload();
  const rows = page.getByRole('row').filter({ hasText: supplier });
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('📎 1');
});
