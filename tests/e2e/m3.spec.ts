import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import JSZip from 'jszip';
import { readFileSync } from 'node:fs';

const APP = `http://localhost:${process.env.FM_E2E_PORT ?? 5173}/`;

async function openDemo(page: Page) {
  await page.goto(APP);
  await page.evaluate(() => localStorage.clear());
  await page.goto(APP);
  await page.getByRole('button', { name: 'פתיחה במצב דמו' }).click();
  await expect(page.getByTestId('mode-badge')).toHaveText('מצב דמו · מקומי בלבד');
}
async function issueInvoice(page: Page, description: string, price: string) {
  await page.goto(APP + '#/documents/new');
  await page.getByLabel('לקוח', { exact: true }).selectOption({ label: 'לקוח לדוגמה בע"מ' });
  await page.getByLabel('תיאור (שורה 1)').fill(description);
  await page.getByLabel('מחיר ליחידה (₪)').fill(price);
  await page.getByRole('button', { name: 'שמירה והמשך להפקה' }).click();
  await page.getByRole('button', { name: 'כן, להפיק' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('חשבונית עסקה');
}

test('PDF: the first download is the original, later ones are copies; the PDF is a real Hebrew PDF', async ({ page }) => {
  await openDemo(page);
  await issueInvoice(page, 'עיצוב לוגו', '850');
  await expect(page.getByTestId('outputs-summary')).toContainText('הראשון יסומן "מקור"');
  const first = page.waitForEvent('download');
  await page.getByRole('button', { name: '⬇ הורדת PDF' }).click();
  const d1 = await first;
  expect(d1.suggestedFilename()).toMatch(/מקור\.pdf$/);
  const bytes = readFileSync((await d1.path())!);
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  await expect(page.getByTestId('outputs-summary')).toContainText('הופקו 1');
  const second = page.waitForEvent('download');
  await page.getByRole('button', { name: '⬇ הורדת PDF' }).click();
  expect((await second).suggestedFilename()).toMatch(/העתק\.pdf$/);
  await expect(page.getByTestId('outputs-summary')).toContainText('ועוד 1 העתקים');
});

test('documents: search and filters; customer page shows balance and history', async ({ page }) => {
  await openDemo(page);
  await issueInvoice(page, 'צילום אירוע', '1,200');
  await issueInvoice(page, 'עריכת וידאו', '300');
  await page.goto(APP + '#/documents');
  await expect(page.getByTestId('documents-count')).toContainText('2 מסמכים');
  await page.getByRole('searchbox').fill('וידאו');
  await expect(page.getByTestId('documents-count')).toContainText('1 מסמכים');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await page.getByRole('searchbox').fill('');
  await page.getByLabel('מצב').selectOption('draft');
  await expect(page.getByText('אין מסמכים להצגה.')).toBeVisible();
  await page.getByLabel('מצב').selectOption('all');
  await page.locator('tbody tr').first().getByRole('link', { name: 'לקוח לדוגמה בע"מ' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('לקוח לדוגמה בע"מ');
  await expect(page.locator('.metric', { hasText: 'יתרה פתוחה' })).toContainText('1,500.00');
  await expect(page.getByRole('region', { name: 'היסטוריה' }).or(page.locator('section', { has: page.getByRole('heading', { name: 'היסטוריה' }) })).locator('tbody tr')).toHaveCount(2);
});

test('backup: complete ZIP with records, CSV, manifest; restore into a non-empty account is refused without changes', async ({ page }) => {
  await openDemo(page);
  await issueInvoice(page, 'שירות לגיבוי', '400');
  await page.goto(APP + '#/settings');
  const dl = page.waitForEvent('download');
  await page.getByRole('button', { name: '⬇ הורדת גיבוי מלא' }).click();
  const file = await dl;
  expect(file.suggestedFilename()).toMatch(/^freelance-backup-DEMO-.*\.zip$/);
  const zip = await JSZip.loadAsync(readFileSync((await file.path())!));
  expect(Object.keys(zip.files)).toEqual(expect.arrayContaining(['backup.json', 'manifest.json', 'csv/documents.csv', 'csv/expenses.csv', 'README.txt']));
  const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
  expect(manifest.counts.documents).toBe(1);
  expect(await zip.file('csv/documents.csv')!.async('string')).toContain('400.00');
  await page.getByTestId('restore-file').setInputFiles({ name: 'b.zip', mimeType: 'application/zip', buffer: readFileSync((await file.path())!) });
  await expect(page.getByTestId('restore-preview')).toContainText('1 מסמכים');
  await page.getByRole('button', { name: 'שחזור לחשבון הזה' }).click();
  await expect(page.getByRole('alert')).toContainText('שחזור אפשרי רק לחשבון ריק');
});

test('import from the previous app: dry-run report first, then import with original numbers, verified', async ({ page }) => {
  await openDemo(page);
  await page.goto(APP + '#/settings');
  const legacy = { profile: { name: 'בעל עסק', id: '000000018' }, nextInvoiceNum: 8,
    invoices: [{ number: 5, clientName: 'לקוח היסטורי', date: '2025-04-01', items: [{ desc: 'עבודה', qty: 1, price: 700 }], total: 700, status: 'issued' },
      { number: 7, clientName: 'לקוח היסטורי', date: '2025-05-01', items: [{ desc: 'עוד', qty: 1, price: 100 }], total: 100, status: 'cancelled' }],
    expenses: [{ desc: 'כבל', amount: 39.9, category: 'ציוד', date: '2025-04-02', receipt: null }] };
  await page.getByTestId('legacy-file').setInputFiles({ name: 'freelance-local-original.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(legacy)) });
  const preview = page.getByTestId('legacy-preview');
  await expect(preview).toContainText('2 חשבוניות (1 מבוטלות)');
  await expect(preview).toContainText('מספרים 5–7');
  await expect(preview).toContainText('חסרים מספרים ברצף: 6');
  await page.getByRole('button', { name: 'ייבוא', exact: true }).click();
  await expect(page.getByTestId('import-result')).toContainText('זהים לקובץ ✅');
  await page.goto(APP + '#/documents');
  const numbers = await page.locator('tbody tr td:nth-child(2)').allTextContents();
  expect(numbers.sort()).toEqual(['5', '7']);
});

test('onboarding, guided reports and assistant: honest about what is and is not connected', async ({ page }) => {
  await openDemo(page);
  await page.goto(APP + '#/onboarding');
  await page.getByLabel('מסלול מס הכנסה לעסק').selectOption('small_business');
  await page.getByLabel('האם את/ה גם שכיר/ה?').selectOption('yes');
  await page.getByLabel('רשום/ה בביטוח לאומי כעצמאי/ת?').selectOption('no');
  await page.getByLabel('יש פנקס מקדמות למס הכנסה?').selectOption('no');
  await page.getByRole('button', { name: 'שמירה וסיום' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('בית');
  await page.goto(APP + '#/taxes');
  await expect(page.getByText('אין חיבור ישיר למערכות רשות המסים')).toBeVisible();
  await expect(page.getByTestId('report-vat_exempt_declaration')).toBeVisible();
  await expect(page.getByTestId('report-small_business_report')).toBeVisible();
  await expect(page.getByTestId('report-annual_1301')).toHaveCount(0);
  await expect(page.getByTestId('report-national_insurance')).toHaveCount(0);
  await expect(page.getByText(/מחובר/)).toHaveCount(0);
  const card = page.getByTestId('report-vat_exempt_declaration');
  await card.getByText('אחרי ההגשה: תיעוד אסמכתה ותשלום').click();
  await card.getByLabel('מצב').selectOption('submitted');
  await card.getByRole('button', { name: 'שמירת תיעוד' }).click();
  await expect(card.getByRole('alert')).toContainText('יש להזין מספר אסמכתה');
  await card.getByLabel('מספר אסמכתה מהאתר הרשמי').fill('ASM-2026-1');
  await card.getByRole('button', { name: 'שמירת תיעוד' }).click();
  await expect(card.getByRole('heading')).toContainText('הוגש (לפי אסמכתה שהוזנה)');
  await page.goto(APP + '#/assistant');
  await expect(page.getByText('במצב דמו העוזר כבוי ושום מידע לא נשלח.')).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([]);
});

test('@mobile new screens fit a phone: documents filters, customer page, settings backup, taxes', async ({ page }) => {
  await openDemo(page);
  await issueInvoice(page, 'טלפון', '100');
  for (const r of ['#/documents', '#/settings', '#/taxes', '#/onboarding', '#/assistant']) {
    await page.goto(APP + r);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), r).toBeLessThanOrEqual(1);
  }
});
