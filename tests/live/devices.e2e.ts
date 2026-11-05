// Live browser suite: the real app against a real Supabase stack, on a desktop
// browser ("computer") and an emulated Pixel 7 ("phone") with separate sessions.
import { test, expect, devices, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { loadLiveTarget, type Account } from './env';

const { target } = loadLiveTarget();
test.skip(!target, 'no live Supabase target configured');
const T = target!;
const BASE = 'http://localhost:5175/';
const RUN = randomUUID().slice(0, 6);

async function phoneContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ ...devices['Pixel 7'], locale: 'he-IL', timezoneId: 'Asia/Jerusalem' });
}

async function login(page: Page, acct: Account = T.owner, base = BASE) {
  await page.goto(base);
  await expect(page.getByRole('heading', { name: 'כניסה' })).toBeVisible();
  await page.getByLabel('כתובת דוא״ל').fill(acct.email);
  await page.getByLabel('סיסמה').fill(acct.password);
  await page.getByRole('button', { name: 'כניסה', exact: true }).click();
}

async function loginOwner(page: Page, base = BASE) {
  await login(page, T.owner, base);
  await expect(page.getByTestId('mode-badge')).toContainText('מחובר לענן');
}

async function addCustomer(page: Page, name: string) {
  await page.goto(BASE + '#/income');
  await page.getByLabel('שם (חובה)').fill(name);
  await page.getByLabel('כתובת').fill('רחוב הבדיקה 5, תל אביב');
  await page.getByRole('button', { name: 'הוספת לקוח' }).click();
  await expect(page.getByText('הלקוח נוסף')).toBeVisible();
}

async function ensureInvoiceSeries(page: Page) {
  await page.goto(BASE + '#/documents/new');
  const create = page.getByRole('button', { name: 'יצירת סדרה' });
  if (await create.isVisible().catch(() => false)) { await create.click(); await expect(page.getByLabel('סדרת מספור')).toBeVisible(); }
}

/** Creates a draft invoice through the UI and leaves the page on the issue-confirmation dialog. */
async function draftInvoice(page: Page, customer: string, description: string) {
  await ensureInvoiceSeries(page);
  await page.getByLabel('לקוח').selectOption({ label: customer });
  await page.getByLabel('תיאור (שורה 1)').fill(description);
  await page.getByLabel('מחיר ליחידה (₪)').fill('250');
  await page.getByRole('button', { name: 'שמירה והמשך להפקה' }).click();
  await expect(page.getByRole('dialog', { name: 'להפיק את המסמך?' })).toBeVisible();
}

async function issuedNumber(page: Page): Promise<number> {
  const h = page.getByRole('heading', { level: 1 });
  await expect(h).toContainText(/חשבונית עסקה \d+/);
  return Number(/(\d+)/.exec((await h.textContent())!)![1]);
}

async function ownerApi() {
  const c = createClient(T.url, T.publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await c.auth.signInWithPassword(T.owner);
  if (error) throw error;
  return c;
}

test('sign-in: no public registration, wrong password and non-allow-listed accounts are refused, owner sees cloud mode', async ({ page }) => {
  await page.goto(BASE);
  await expect(page.getByRole('heading', { name: 'כניסה' })).toBeVisible();
  await expect(page.getByText(/הרשמה|sign up/i).filter({ hasNot: page.getByText('אין הרשמה ציבורית') })).toHaveCount(0);
  await login(page, { email: T.owner.email, password: 'wrong-password-123' });
  await expect(page.getByRole('alert')).toContainText('הדוא״ל או הסיסמה שגויים');

  await login(page, T.outsider);
  await expect(page.getByRole('heading', { name: 'אין הרשאה' })).toBeVisible();
  await page.getByRole('button', { name: 'התנתקות' }).click();
  await expect(page.getByRole('heading', { name: 'כניסה' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'כניסה' }), 'sign-out must survive a reload').toBeVisible();

  await loginOwner(page);
  await expect(page.getByRole('note').filter({ hasText: 'מצב דמו' })).toHaveCount(0);
  await expect(page).toHaveTitle('ניהול עסק עצמאי');
});

test('computer ↔ phone: records created on one device appear on the other after refreshing', async ({ page, browser }) => {
  const phoneCtx = await phoneContext(browser);
  const phone = await phoneCtx.newPage();
  await loginOwner(page);
  await loginOwner(phone);
  await expect(phone.getByRole('navigation', { name: 'ניווט ראשי (נייד)' })).toBeVisible();
  for (const route of ['#/', '#/documents/new', '#/income']) {
    await phone.goto(BASE + route);
    await expect(phone.getByTestId('mode-badge')).toBeVisible();
    expect(await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), route).toBeLessThanOrEqual(0);
  }
  await phone.goto(BASE);
  await phone.screenshot({ path: 'test-results/live-phone-cloud.png' });
  await page.screenshot({ path: 'test-results/live-computer-cloud.png' });

  const fromComputer = `לקוח מהמחשב ${RUN}`;
  await addCustomer(page, fromComputer);
  await phone.goto(BASE + '#/income');
  await phone.reload();
  await expect(phone.getByRole('cell', { name: fromComputer })).toBeVisible();

  const fromPhone = `לקוח מהטלפון ${RUN}`;
  await addCustomer(phone, fromPhone);
  await page.reload();
  await expect(page.getByRole('cell', { name: fromPhone })).toBeVisible();

  // A document issued on the phone shows up on the computer with the same number.
  await draftInvoice(phone, fromPhone, 'הופק בטלפון');
  await phone.getByRole('button', { name: 'כן, להפיק' }).click();
  const n = await issuedNumber(phone);
  await page.goto(BASE + '#/documents');
  await page.reload();
  const row = page.getByRole('row').filter({ hasText: fromPhone });
  await expect(row).toContainText(String(n));
  await expect(row).toContainText('הופק');
  await phoneCtx.close();
});

test('the same draft issued on computer and phone at the same moment gets a single number', async ({ page, browser }) => {
  const phoneCtx = await phoneContext(browser);
  const phone = await phoneCtx.newPage();
  await loginOwner(page);
  await loginOwner(phone);
  const cust = `לקוח הפקה כפולה ${RUN}`;
  await addCustomer(page, cust);
  await draftInvoice(page, cust, 'הפקה כפולה');
  const url = page.url().replace('?issue=1', '');
  await phone.goto(url);
  await phone.getByRole('button', { name: 'הפקת מסמך' }).click();
  await Promise.all([
    page.getByRole('button', { name: 'כן, להפיק' }).click(),
    phone.getByRole('button', { name: 'כן, להפיק' }).click(),
  ]);
  const [a, b] = [await issuedNumber(page), await issuedNumber(phone)];
  expect(a).toBe(b);

  // The series advanced exactly once: the next document gets the next number.
  await draftInvoice(page, cust, 'המסמך הבא');
  await page.getByRole('button', { name: 'כן, להפיק' }).click();
  expect(await issuedNumber(page)).toBe(a + 1);
  await phoneCtx.close();
});

test('a failed save says so, keeps what was typed, and a retry saves exactly once', async ({ page }) => {
  await loginOwner(page);
  await page.goto(BASE + '#/income');
  const name = `לקוח שמירה שנכשלה ${RUN}`;
  await page.route('**/rest/v1/customers**', (r) => (r.request().method() === 'POST' ? r.abort('connectionfailed') : r.continue()));
  await page.getByLabel('שם (חובה)').fill(name);
  await page.getByRole('button', { name: 'הוספת לקוח' }).click();
  await expect(page.getByRole('alert')).toContainText('אין תקשורת עם השרת');
  await expect(page.getByText('הלקוח נוסף')).toHaveCount(0);
  await expect(page.getByLabel('שם (חובה)')).toHaveValue(name);
  await page.unroute('**/rest/v1/customers**');
  await page.getByRole('button', { name: 'הוספת לקוח' }).click();
  await expect(page.getByText('הלקוח נוסף')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('cell', { name })).toHaveCount(1);
});

test('lost response while issuing: the app says the outcome is unknown, and retrying does not create a second number', async ({ page }) => {
  await loginOwner(page);
  const cust = `לקוח תגובה אבודה ${RUN}`;
  await addCustomer(page, cust);
  await draftInvoice(page, cust, 'תגובה אבודה');
  const api = await ownerApi();
  const seriesBefore = (await api.from('document_series').select('id,next_number').eq('doc_type', 'transaction_invoice').eq('is_legacy', false).order('created_at').limit(1).single()).data!;

  // The request reaches the server and is executed, but the response never arrives.
  await page.route('**/rest/v1/rpc/issue_document', async (r) => { await r.fetch(); await r.abort('connectionreset'); });
  await page.getByRole('button', { name: 'כן, להפיק' }).click();
  await expect(page.getByRole('alert')).toContainText('ייתכן שהמסמך כבר הופק');
  await page.unroute('**/rest/v1/rpc/issue_document');
  await page.getByRole('button', { name: 'נסה שוב' }).click();
  const n = await issuedNumber(page);
  expect(n).toBe(seriesBefore.next_number);
  const after = (await api.from('document_series').select('next_number').eq('id', seriesBefore.id).single()).data!;
  expect(after.next_number).toBe(seriesBefore.next_number + 1);
  await api.auth.signOut({ scope: 'local' });
});

test('offline: the app shows it, nothing claims to be saved, and it works again after reconnecting', async ({ page, context }) => {
  await loginOwner(page);
  await page.goto(BASE + '#/income');
  await context.setOffline(true);
  await expect(page.getByTestId('mode-badge')).toContainText('אין חיבור לרשת');
  const name = `לקוח אופליין ${RUN}`;
  await page.getByLabel('שם (חובה)').fill(name);
  await page.getByRole('button', { name: 'הוספת לקוח' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'אין תקשורת עם השרת' }).first()).toBeVisible();
  await expect(page.getByText('הלקוח נוסף')).toHaveCount(0);
  await context.setOffline(false);
  await expect(page.getByTestId('mode-badge')).toContainText('מחובר לענן');
  await expect(page.getByText('הטעינה נכשלה'), 'failed loads retry by themselves after reconnecting').toHaveCount(0);
  await page.getByRole('button', { name: 'הוספת לקוח' }).click();
  await expect(page.getByText('הלקוח נוסף')).toBeVisible();
});

test('session expiry: unsaved input survives, signing in again lets the save go through', async ({ page }) => {
  await loginOwner(page);
  const cust = `לקוח פקיעת חיבור ${RUN}`;
  await addCustomer(page, cust);
  await ensureInvoiceSeries(page);
  await page.getByLabel('לקוח').selectOption({ label: cust });
  await page.getByLabel('תיאור (שורה 1)').fill('נכתב לפני שהחיבור פג');
  await page.getByLabel('מחיר ליחידה (₪)').fill('120');

  // Another device signs out everywhere (revokes this session), then this
  // session's access token reaches its expiry time.
  const api = await ownerApi();
  await api.auth.signOut({ scope: 'global' });
  await page.evaluate(() => {
    const k = Object.keys(localStorage).find((x) => /^sb-.*-auth-token$/.test(x))!;
    const s = JSON.parse(localStorage.getItem(k)!);
    s.expires_at = Math.floor(Date.now() / 1000) - 60;
    localStorage.setItem(k, JSON.stringify(s));
  });

  await page.getByRole('button', { name: 'שמירת טיוטה' }).click();
  const dialog = page.getByRole('dialog', { name: 'צריך להתחבר מחדש' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('סיסמה').fill(T.owner.password);
  await dialog.getByRole('button', { name: 'כניסה מחדש' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByLabel('תיאור (שורה 1)')).toHaveValue('נכתב לפני שהחיבור פג');
  await page.getByRole('button', { name: 'שמירת טיוטה' }).click();
  await expect(page.getByText('זו טיוטה: אין לה מספר')).toBeVisible();
  await expect(page.getByRole('article')).toContainText('נכתב לפני שהחיבור פג');
});

test('demo mode stays local: no requests reach Supabase data, and demo records never appear in the account', async ({ page }) => {
  const dataRequests: string[] = [];
  page.on('request', (r) => { if (r.url().startsWith(T.url) && /\/rest\/v1\//.test(r.url())) dataRequests.push(r.url()); });
  await page.goto(BASE);
  await page.getByRole('button', { name: /פתיחה במצב דמו/ }).click();
  await expect(page.getByTestId('mode-badge')).toContainText('מצב דמו');
  await expect(page).toHaveTitle(/\[דמו\]/);
  const demoName = `לקוח דמו ${RUN}`;
  await addCustomer(page, demoName);
  expect(dataRequests).toEqual([]);

  await page.getByRole('button', { name: 'יציאה ממצב דמו' }).click();
  await loginOwner(page);
  await page.goto(BASE + '#/income');
  await expect(page.getByRole('cell', { name: demoName })).toHaveCount(0);
  const api = await ownerApi();
  expect((await api.from('customers').select('id').eq('name', demoName)).data).toEqual([]);
  await api.auth.signOut({ scope: 'local' });
});

test('phone over the local network (plain http, not a secure context) can sign in and save', async ({ browser }) => {
  const addrs = Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i!.address);
  const ip = addrs.find((a) => /^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(a)) ?? addrs[0];
  test.skip(!ip, 'no LAN address on this machine');
  const ctx = await phoneContext(browser);
  const phone = await ctx.newPage();
  const base = `http://${ip}:5175/`;
  if (T.kind === 'local') {
    // Chrome blocks a page served from a LAN address from calling 127.0.0.1 (the local
    // stack). A real phone would use the hosted project; here the test runner relays.
    const origin = new URL(T.url).origin;
    await phone.route(`${origin}/**`, async (r) => r.fulfill({ response: await r.fetch() }));
  }
  await loginOwner(phone, base);
  expect(await phone.evaluate(() => window.isSecureContext)).toBe(false);
  await phone.goto(base + '#/income');
  await phone.getByLabel('שם (חובה)').fill(`לקוח מהרשת המקומית ${RUN}`);
  await phone.getByRole('button', { name: 'הוספת לקוח' }).click();
  await expect(phone.getByText('הלקוח נוסף')).toBeVisible();
  await phone.goto(base + '#/documents/new');
  await phone.getByLabel('לקוח').selectOption({ label: `לקוח מהרשת המקומית ${RUN}` });
  await phone.getByLabel('תיאור (שורה 1)').fill('טיוטה מהטלפון ברשת המקומית');
  await phone.getByLabel('מחיר ליחידה (₪)').fill('80');
  await phone.getByRole('button', { name: 'שמירת טיוטה' }).click();
  await expect(phone.getByText('זו טיוטה: אין לה מספר')).toBeVisible();
  await ctx.close();
});
