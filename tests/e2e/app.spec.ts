import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const APP = 'http://localhost:5173/';

async function openDemo(page: Page) {
  await page.goto(APP);
  await page.evaluate(() => localStorage.clear());
  await page.goto(APP);
  await expect(page.getByRole('heading', { name: /גרסה חדשה/ })).toBeVisible();
  await page.getByRole('button', { name: 'פתיחה במצב דמו' }).click();
  await expect(page.getByRole('note').filter({ hasText: 'מצב דמו' })).toBeVisible();
}

async function newInvoice(page: Page, description: string, price: string) {
  await page.goto(APP + '#/documents/new');
  await page.getByLabel('לקוח').selectOption({ label: 'לקוח לדוגמה בע"מ' });
  await page.getByLabel('תיאור (שורה 1)').fill(description);
  await page.getByLabel('מחיר ליחידה (₪)').fill(price);
  await page.getByRole('button', { name: 'שמירה והמשך להפקה' }).click();
  await expect(page.getByRole('dialog', { name: 'להפיק את המסמך?' })).toBeVisible();
}

test('starts without a backend only in clearly labelled demo mode, RTL Hebrew', async ({ page }) => {
  await openDemo(page);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('lang', 'he');
  await expect(page.getByRole('navigation', { name: 'ניווט ראשי' })).toBeVisible();
  for (const label of ['בית', 'הכנסות ולקוחות', 'הוצאות', 'מסים ודוחות', 'מסמכים', 'עוזר', 'הגדרות']) {
    await expect(page.getByRole('navigation', { name: 'ניווט ראשי' }).getByRole('link', { name: label })).toBeVisible();
  }
});

test('issuing assigns sequential numbers; a double click issues once', async ({ page }) => {
  await openDemo(page);
  await newInvoice(page, 'ייעוץ', '1,500');
  const confirm = page.getByRole('button', { name: 'כן, להפיק' });
  await confirm.dblclick();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('חשבונית עסקה 1');
  await expect(page.getByText('הופק', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('article')).toContainText(/1,500\.00\s*\S?₪/);
  await expect(page.getByRole('article')).toContainText('סעיף 31(3)');
  await expect(page.getByRole('article')).not.toContainText('חשבונית מס');

  await newInvoice(page, 'פיתוח', '200');
  await page.getByRole('button', { name: 'כן, להפיק' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('חשבונית עסקה 2');

  await page.goto(APP + '#/documents');
  const numbers = await page.locator('tbody tr td:nth-child(2)').allTextContents();
  expect(numbers.sort()).toEqual(['1', '2']);
});

test('issued documents offer no edit/delete; cancellation issues a linked document and keeps the original', async ({ page }) => {
  await openDemo(page);
  await newInvoice(page, 'שירות לביטול', '300');
  await page.getByRole('button', { name: 'כן, להפיק' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('חשבונית עסקה 1');
  await expect(page.getByRole('link', { name: 'עריכה' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'מחיקת טיוטה' })).toHaveCount(0);

  await page.getByRole('button', { name: 'ביטול באמצעות מסמך ביטול' }).click();
  const dialog = page.getByRole('dialog', { name: 'ביטול מסמך' });
  await dialog.getByRole('button', { name: 'הפקת מסמך ביטול' }).click();
  await expect(dialog.getByRole('alert').or(page.getByRole('alert'))).toContainText('סיבת ביטול');
  await dialog.getByLabel('סיבת הביטול (חובה)').fill('סכום שגוי');
  await dialog.getByRole('button', { name: 'הפקת מסמך ביטול' }).click();
  await expect(page.getByText('המסמך בוטל ב')).toBeVisible();
  await expect(page.getByRole('article')).toContainText('שירות לביטול');   // original content unchanged
  await page.getByRole('link', { name: /מסמך ביטול מספר 1/ }).click();
  await expect(page.getByRole('article')).toContainText('סכום שגוי');
  await expect(page.getByRole('article')).toContainText(/-\S?300\.00/);
});

test('an exempt dealer cannot choose a tax invoice; drafts are clearly separate and deletable', async ({ page }) => {
  await openDemo(page);
  await page.goto(APP + '#/documents/new');
  const options = await page.getByLabel('סוג מסמך').locator('option').allTextContents();
  expect(options).toEqual(['הצעת מחיר', 'חשבונית עסקה', 'קבלה']);
  await page.getByLabel('לקוח').selectOption({ label: 'לקוח לדוגמה בע"מ' });
  await page.getByLabel('תיאור (שורה 1)').fill('טיוטה');
  await page.getByLabel('מחיר ליחידה (₪)').fill('10');
  await page.getByRole('button', { name: 'שמירת טיוטה' }).click();
  await expect(page.getByText('זו טיוטה: אין לה מספר')).toBeVisible();
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'מחיקת טיוטה' }).click();
  await expect(page.getByRole('heading', { name: 'מסמכים' })).toBeVisible();
});

test('a receipt requires a payment method before it can be issued', async ({ page }) => {
  await openDemo(page);
  await page.goto(APP + '#/documents/new?type=receipt');
  await page.getByLabel('לקוח').selectOption({ label: 'לקוח לדוגמה בע"מ' });
  await page.getByLabel('תיאור (שורה 1)').fill('תשלום');
  await page.getByLabel('מחיר ליחידה (₪)').fill('100');
  await expect(page.getByRole('button', { name: 'שמירה והמשך להפקה' })).toBeDisabled();
  await page.getByLabel('אמצעי תשלום').selectOption({ label: 'העברה בנקאית' });
  await page.getByRole('button', { name: 'שמירה והמשך להפקה' }).click();
  await page.getByRole('button', { name: 'כן, להפיק' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('קבלה 1');
  await expect(page.getByRole('article')).toContainText('העברה בנקאית');
  await page.goto(APP + '#/');
  await expect(page.getByText('התקבל בפועל (לפי קבלות)').locator('..')).toContainText(/100\.00\s*\S?₪/);
});

test('tax estimate stays incomplete until material inputs are given, then is labelled partial', async ({ page }) => {
  await openDemo(page);
  await page.goto(APP + '#/taxes');
  await expect(page.getByText('ההערכה לא שלמה — לא מוצג סכום.')).toBeVisible();
  await page.getByLabel('מסלול מס הכנסה לעסק').selectOption('small_business');
  await page.getByLabel('הכנסה חייבת ממשכורת לשנה (₪)').fill('180000');
  await page.getByLabel('מס שנוכה מהמשכורת (₪)').fill('20000');
  await page.getByLabel('מחזור עסקי לשנה (₪)').fill('60000');
  await expect(page.getByText('ההערכה לא שלמה — לא מוצג סכום.')).toBeVisible(); // credit points still missing
  await page.getByLabel('נקודות זיכוי').fill('2.25');
  await expect(page.getByText('הערכה חלקית')).toBeVisible();
  await page.getByText('איך חושב').click();
  await expect(page.getByText('ניכוי קבוע לבעל עסק זעיר (30%)')).toBeVisible();
  await expect(page.getByText('228,000').first()).toBeVisible();
});

test('keyboard: skip link moves focus to the main content; focus is visible', async ({ page }) => {
  await openDemo(page);
  await page.reload(); // a fresh visit (demo mode is remembered)
  await expect(page.getByRole('heading', { name: 'בית' })).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'דלג לתוכן' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main')).toBeFocused();
  await page.keyboard.press('Tab');
  const outline = await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle);
  expect(outline).not.toBe('none');
});

for (const route of ['#/', '#/documents/new', '#/taxes', '#/settings', '#/income']) {
  test(`no serious accessibility violations on ${route}`, async ({ page }) => {
    await openDemo(page);
    await page.goto(APP + route);
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#main')).not.toContainText('טוען…');
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
    const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
  });
}

test('@mobile phone layout: bottom navigation, no horizontal scrolling, full issuing flow', async ({ page }) => {
  await openDemo(page);
  await expect(page.getByRole('navigation', { name: 'ניווט ראשי (נייד)' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'ניווט ראשי', exact: true })).toBeHidden();
  for (const route of ['#/', '#/documents/new', '#/taxes', '#/settings']) {
    await page.goto(APP + route);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, route).toBeLessThanOrEqual(0);
  }
  const box = await page.getByRole('navigation', { name: 'ניווט ראשי (נייד)' }).getByRole('link', { name: 'מסמכים' }).boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  await newInvoice(page, 'מהטלפון', '99');
  await page.getByRole('button', { name: 'כן, להפיק' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('חשבונית עסקה 1');
});
