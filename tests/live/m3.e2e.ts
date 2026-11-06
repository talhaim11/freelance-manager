// Live browser checks for M3 against a real Supabase stack.
import { test, expect, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { loadLiveTarget, type Account } from './env';

const { target } = loadLiveTarget();
test.skip(!target, 'no live Supabase target configured');
const T = target!;
// FM_LIVE_BASE_URL runs the suite against a deployed site (e.g. a Netlify draft deploy) instead of local vite.
const BASE = process.env.FM_LIVE_BASE_URL ?? 'http://localhost:5175/';

async function login(page: Page, a: Account) {
  await page.goto(BASE);
  await page.getByLabel('כתובת דוא״ל').fill(a.email);
  await page.getByLabel('סיסמה').fill(a.password);
  await page.getByRole('button', { name: 'כניסה', exact: true }).click();
  await expect(page.getByTestId('mode-badge')).toContainText('מחובר לענן');
}

test('forgot password: emailed link → choose a new password → sign in with it (local mail catcher)', async ({ page, request }) => {
  test.skip(T.kind !== 'local', 'reads the local mail catcher; on the hosted project emails are real');
  const acct = T.restore[T.restore.length - 1];
  test.skip(!acct, 'no spare account');
  await page.goto(BASE);
  await page.getByText('שכחתי סיסמה').click();
  await page.getByLabel('כתובת הדוא״ל של החשבון').fill(acct.email);
  await page.getByRole('button', { name: 'שליחת קישור לאיפוס' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'אם הכתובת שייכת לחשבון קיים' })).toBeVisible();

  let link = '';
  await expect.poll(async () => {
    const list = await (await request.get(`http://127.0.0.1:54324/api/v1/search?query=${encodeURIComponent('to:' + acct.email)}`)).json();
    const id = list.messages?.[0]?.ID;
    if (!id) return '';
    const msg = await (await request.get(`http://127.0.0.1:54324/api/v1/message/${id}`)).json();
    link = (/href="([^"]+)"/.exec(msg.HTML ?? '')?.[1] ?? '').replace(/&amp;/g, '&');
    return link;
  }, { timeout: 20_000 }).toContain('/auth/v1/verify');

  await page.goto(link);
  await expect(page.getByRole('heading', { name: 'קביעת סיסמה' })).toBeVisible();
  expect(page.url()).not.toContain('access_token');             // tokens removed from the address bar
  const fresh = randomBytes(9).toString('base64url') + 'a1Z9';
  await page.getByLabel('סיסמה חדשה').fill('short1');
  await page.getByLabel('שוב, לאימות').fill('short1');
  await page.getByRole('button', { name: 'שמירת סיסמה' }).click();
  await expect(page.getByRole('alert')).toContainText('לפחות 10 תווים');
  await page.getByLabel('סיסמה חדשה').fill(fresh);
  await page.getByLabel('שוב, לאימות').fill(fresh);
  await page.getByRole('button', { name: 'שמירת סיסמה' }).click();
  await expect(page.getByTestId('mode-badge')).toContainText('מחובר לענן');
  await page.getByRole('button', { name: 'התנתקות' }).click();
  await expect(page.getByRole('heading', { name: 'כניסה' })).toBeVisible();
  await login(page, { email: acct.email, password: fresh });
});

test('PDF download from the cloud account records the original once', async ({ page }) => {
  await login(page, T.owner);
  await page.goto(BASE + '#/documents');
  await page.getByLabel('מצב').selectOption('issued');
  await page.locator('tbody tr').first().getByRole('link').first().click();
  const dl = page.waitForEvent('download');
  await page.getByRole('button', { name: '⬇ הורדת PDF' }).click();
  expect((await dl).suggestedFilename()).toMatch(/(מקור|העתק)\.pdf$/);
  await expect(page.getByTestId('outputs-summary')).toContainText('הופקו');
});
