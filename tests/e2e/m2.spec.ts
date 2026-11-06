import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const APP = `http://localhost:${process.env.FM_E2E_PORT ?? 5173}/`;
// 1×1 PNG, synthetic.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function openDemo(page: Page) {
  await page.goto(APP);
  await page.evaluate(() => localStorage.clear());
  await page.goto(APP);
  await page.getByRole('button', { name: 'פתיחה במצב דמו' }).click();
  await expect(page.getByTestId('mode-badge')).toHaveText('מצב דמו · מקומי בלבד');
}

async function issueInvoice(page: Page, description: string, price: string) {
  await page.goto(APP + '#/documents/new');
  await page.getByLabel('לקוח').selectOption({ label: 'לקוח לדוגמה בע"מ' });
  await page.getByLabel('תיאור (שורה 1)').fill(description);
  await page.getByLabel('מחיר ליחידה (₪)').fill(price);
  await page.getByRole('button', { name: 'שמירה והמשך להפקה' }).click();
  await page.getByRole('button', { name: 'כן, להפיק' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('חשבונית עסקה');
  return (await page.getByRole('heading', { level: 1 }).locator('.num').textContent())!.trim();
}

async function issueFromEditor(page: Page) {
  await page.getByRole('button', { name: 'שמירה והמשך להפקה' }).click();
  await page.getByRole('button', { name: 'כן, להפיק' }).click();
}

test('adding a customer from inside a document keeps everything already typed', async ({ page }) => {
  await openDemo(page);
  await page.goto(APP + '#/documents/new');
  await page.getByLabel('תיאור (שורה 1)').fill('פיתוח אתר');
  await page.getByLabel('מחיר ליחידה (₪)').fill('2,400');
  await page.getByLabel('הערות').fill('לפי הצעה מספר 7');

  await page.getByRole('button', { name: '+ לקוח חדש' }).click();
  const dialog = page.getByRole('dialog', { name: 'לקוח חדש' });
  await dialog.getByRole('button', { name: 'שמירת לקוח' }).click();
  await expect(dialog.getByText('שם הלקוח הוא שדה חובה')).toBeVisible();
  await dialog.getByLabel('שם (חובה)').fill('לקוחה חדשה בדיקה');
  await dialog.getByLabel(/כתובת/).fill('רחוב הבדיקה 5, עיר');
  await dialog.getByRole('button', { name: 'שמירת לקוח' }).dblclick();
  await expect(dialog).toBeHidden();

  // The new customer is selected, and the document input is intact.
  await expect(page.getByLabel('לקוח').locator('option:checked')).toHaveText('לקוחה חדשה בדיקה');
  await expect(page.getByLabel('תיאור (שורה 1)')).toHaveValue('פיתוח אתר');
  await expect(page.getByLabel('מחיר ליחידה (₪)')).toHaveValue('2,400');
  await expect(page.getByLabel('הערות')).toHaveValue('לפי הצעה מספר 7');
  // A double click created one customer.
  expect(await page.getByLabel('לקוח').locator('option', { hasText: 'לקוחה חדשה בדיקה' }).count()).toBe(1);

  await issueFromEditor(page);
  await expect(page.getByRole('article')).toContainText('לקוחה חדשה בדיקה');
  await expect(page.getByRole('article')).toContainText('2,400.00');
});

test('receipt from an invoice is prefilled; two partial payments close it; a paid invoice cannot be cancelled', async ({ page }) => {
  await openDemo(page);
  const invNo = await issueInvoice(page, 'ליווי חודשי', '1,000');
  const invoiceUrl = page.url();
  await expect(page.getByTestId('invoice-balance')).toContainText('1,000.00');

  // First payment: partial (400 of 1,000).
  await page.getByRole('link', { name: '₪ קבלה על תשלום' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('קבלה על תשלום');
  await expect(page.getByLabel('סוג מסמך')).toHaveValue('receipt');
  await expect(page.getByLabel('לקוח').locator('option:checked')).toHaveText('לקוח לדוגמה בע"מ');
  await expect(page.getByLabel('תיאור (שורה 1)')).toHaveValue(`תשלום עבור חשבונית עסקה מס' ${invNo}`);
  await expect(page.getByLabel('מחיר ליחידה (₪)')).toHaveValue('1000.00');
  await page.getByLabel('מחיר ליחידה (₪)').fill('400');
  await expect(page.getByLabel(`סכום לשיוך לחשבונית ${invNo}`)).toHaveValue('400.00');   // follows the amount received
  await expect(page.getByTestId('alloc-summary')).toContainText(/לא משויך\s*\S?0\.00/);
  await page.getByLabel('אמצעי תשלום').selectOption({ label: 'העברה בנקאית' });
  await issueFromEditor(page);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('קבלה');
  await expect(page.getByRole('article')).toContainText(`חשבונית עסקה מס' ${invNo}`);

  await page.goto(invoiceUrl);
  await expect(page.getByTestId('invoice-balance')).toContainText(/שולם\s*\S?400\.00/);
  await expect(page.getByTestId('invoice-balance')).toContainText(/יתרה פתוחה\s*\S?600\.00/);

  // Trying to over-pay is caught before issuing.
  await page.getByRole('link', { name: '₪ קבלה על תשלום' }).click();
  await expect(page.getByLabel('מחיר ליחידה (₪)')).toHaveValue('600.00');
  await page.getByLabel(`סכום לשיוך לחשבונית ${invNo}`).fill('700');
  await page.getByLabel('אמצעי תשלום').selectOption({ label: 'מזומן' });
  await page.getByRole('button', { name: 'שמירה והמשך להפקה' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'אי אפשר עדיין להפיק' })).toContainText('גדול מהיתרה הפתוחה');
  await page.getByLabel(`סכום לשיוך לחשבונית ${invNo}`).fill('600');
  await issueFromEditor(page);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('קבלה');

  await page.goto(invoiceUrl);
  await expect(page.getByTestId('invoice-balance')).toContainText(/יתרה פתוחה\s*\S?0\.00/);
  await expect(page.getByRole('link', { name: '₪ קבלה על תשלום' })).toHaveCount(0);
  await page.getByRole('button', { name: 'ביטול באמצעות מסמך ביטול' }).click();
  const dialog = page.getByRole('dialog', { name: 'ביטול מסמך' });
  await dialog.getByLabel('סיבת הביטול (חובה)').fill('בדיקה');
  await dialog.getByRole('button', { name: 'הפקת מסמך ביטול' }).click();
  await expect(dialog.getByRole('alert')).toContainText('יש לבטל קודם את הקבלות');

  await page.goto(APP + '#/income');
  await expect(page.getByText('אין חשבוניות עסקה פתוחות.')).toBeVisible();
});

test('one receipt pays two invoices with automatic oldest-first allocation; debtors and home update', async ({ page }) => {
  await openDemo(page);
  const first = await issueInvoice(page, 'עבודה ראשונה', '300');
  const second = await issueInvoice(page, 'עבודה שנייה', '500');
  await page.goto(APP + '#/income');
  await expect(page.getByRole('region', { name: 'מי חייב לי' }).or(page.locator('section', { has: page.getByRole('heading', { name: 'מי חייב לי' }) })))
    .toContainText('800.00');
  await page.goto(APP + '#/documents/new?type=receipt');
  await page.getByLabel('לקוח').selectOption({ label: 'לקוח לדוגמה בע"מ' });
  await page.getByLabel('תיאור (שורה 1)').fill('תשלום מרוכז');
  await page.getByLabel('מחיר ליחידה (₪)').fill('650');
  await page.getByRole('button', { name: 'שיוך אוטומטי (הישנה קודם)' }).click();
  await expect(page.getByLabel(`סכום לשיוך לחשבונית ${first}`)).toHaveValue('300.00');
  await expect(page.getByLabel(`סכום לשיוך לחשבונית ${second}`)).toHaveValue('350.00');
  await page.getByLabel('אמצעי תשלום').selectOption({ label: 'מזומן' });
  await issueFromEditor(page);
  await expect(page.getByTestId('receipt-unallocated')).toContainText('0.00');
  await page.goto(APP + '#/');
  await expect(page.locator('.metric', { hasText: 'מי חייב לי' })).toContainText('150.00');
});

test('expense with a private attachment: validation after trying, duplicate warning, file kept and viewable', async ({ page }) => {
  await openDemo(page);
  await page.goto(APP + '#/expenses/new');
  await expect(page.getByText('יש להזין שם ספק')).toHaveCount(0);       // no errors on a fresh form
  await page.getByRole('button', { name: 'שמירה' }).click();
  await expect(page.getByText('יש להזין שם ספק')).toBeVisible();
  await page.getByLabel('ספק (חובה)').fill('ספק תוכנה סינתטי');
  await page.getByLabel('סכום ששולם (₪, חובה)').fill('118');
  await page.getByLabel('מע"מ שמופיע במסמך (₪, אם יש)').fill('18');
  await page.getByLabel('קטגוריה').selectOption({ label: 'תוכנה ומנויים' });
  await page.getByTestId('expense-file').setInputFiles({ name: 'קבלה-ספק.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.getByTestId('pending-file')).toContainText('קבלה-ספק.png');
  await page.getByRole('button', { name: 'שמירה' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('הוצאה');
  await expect(page.getByText('קבלה-ספק.png')).toBeVisible();
  await page.getByRole('button', { name: 'הצגה' }).click();
  await expect(page.getByRole('img', { name: /מסמך מקור/ })).toBeVisible();

  // Same supplier and amount two days later: warned, not blocked.
  await page.goto(APP + '#/expenses/new');
  await page.getByLabel('ספק (חובה)').fill('ספק תוכנה סינתטי');
  await page.getByLabel('סכום ששולם (₪, חובה)').fill('118');
  await expect(page.getByRole('note').filter({ hasText: 'ייתכן שזו הוצאה כפולה' })).toBeVisible();
  // The same file again is recognised by its fingerprint.
  await page.getByTestId('expense-file').setInputFiles({ name: 'עותק.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.getByRole('note').filter({ hasText: 'קובץ זהה כבר מצורף' })).toBeVisible();

  // Wrong file type is refused before upload.
  await page.getByTestId('expense-file').setInputFiles({ name: 'x.html', mimeType: 'text/html', buffer: Buffer.from('<b>x</b>') });
  await expect(page.getByText('אפשר לצרף תמונה')).toBeVisible();

  await page.goto(APP + '#/expenses');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page.locator('tbody tr').first()).toContainText('📎 1');
  await expect(page.locator('tbody tr').first()).toContainText('טרם נקבע');
});

test('@mobile receipt from invoice and expense entry fit a phone screen', async ({ page }) => {
  await openDemo(page);
  await issueInvoice(page, 'שירות בטלפון', '250');
  await page.getByRole('link', { name: '₪ קבלה על תשלום' }).click();
  await expect(page.getByLabel('מחיר ליחידה (₪)')).toHaveValue('250.00');
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(await overflow()).toBeLessThanOrEqual(1);
  await page.goto(APP + '#/expenses/new');
  await expect(page.getByText('📷 צילום')).toBeVisible();
  expect(await overflow()).toBeLessThanOrEqual(1);
});

test('new M2 screens have no serious accessibility violations', async ({ page }) => {
  await openDemo(page);
  const invNo = await issueInvoice(page, 'בדיקת נגישות', '120');
  const scan = async (label: string) => {
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
    const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(serious.map((v) => `${label} ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
  };
  await page.getByRole('link', { name: '₪ קבלה על תשלום' }).click();
  await expect(page.getByLabel(`סכום לשיוך לחשבונית ${invNo}`)).toBeVisible();
  await scan('receipt-editor');
  await page.getByRole('button', { name: '+ לקוח חדש' }).click();
  await expect(page.getByRole('dialog', { name: 'לקוח חדש' })).toBeVisible();
  await scan('customer-dialog');
  await page.goto(APP + '#/income');
  await expect(page.getByRole('heading', { name: 'מי חייב לי' })).toBeVisible();
  await scan('income');
  await page.goto(APP + '#/expenses/new');
  await expect(page.getByLabel('ספק (חובה)')).toBeVisible();
  await scan('expense-form');
});
