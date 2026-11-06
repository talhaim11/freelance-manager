// Production smoke check in a SEPARATE, temporary account. Nothing here touches the owner's data or
// the owner's numbering series (series are per account), and NO document is issued — drafts only.
// Everything the temporary account created is deleted at the end, and so is the account itself.
//   node scripts/prod-smoke.mjs <prod-project-ref> <site-url>
// Requires `npx supabase login`. The secret key is fetched through the CLI and kept in memory only.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { chromium, devices } from '@playwright/test';

const [ref, site] = process.argv.slice(2);
if (!/^[a-z0-9]{20}$/.test(ref ?? '') || !/^https:\/\//.test(site ?? '')) throw new Error('usage: node scripts/prod-smoke.mjs <ref> <https-site-url>');
const BASE = site.endsWith('/') ? site : site + '/';
const keys = JSON.parse(execFileSync('npx', ['supabase', 'projects', 'api-keys', '--project-ref', ref, '--reveal', '-o', 'json'],
  { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'ignore'] }));
const secret = keys.find((k) => k.type === 'secret')?.api_key;
const publishable = keys.find((k) => k.type === 'publishable')?.api_key;
const url = `https://${ref}.supabase.co`;
const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
// SQL goes through a file: dollar quotes and newlines do not survive the Windows shell.
const sql = (q) => {
  const dir = mkdtempSync(join(tmpdir(), 'fm-smoke-')); const f = join(dir, 'q.sql');
  writeFileSync(f, q);
  try { return execFileSync('npx', ['supabase', 'db', 'query', '--linked', '--project-ref', ref, '-f', f, '-o', 'json'], { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
  finally { rmSync(dir, { recursive: true, force: true }); }
};
const cleanupOnly = process.argv[4] === '--cleanup';

const run = Date.now().toString(36);
const smoke = { email: `fm-smoke-${run}@example.com`, password: randomBytes(18).toString('base64url') + 'a1' };
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`); };

let uid = null;
// Removes every row the temporary account created, its allow-list entry, its files and the account itself.
async function cleanup(id, email) {
  try {
    const files = await admin.storage.from('expense-files').list(id);
    if (files.data?.length) await admin.storage.from('expense-files').remove(files.data.map((f) => `${id}/${f.name}`));
    sql(`begin;
      set local session_replication_role = replica;
      do $$ declare t record; begin
        for t in select c.table_name from information_schema.columns c join information_schema.tables b
                   on b.table_schema = c.table_schema and b.table_name = c.table_name and b.table_type = 'BASE TABLE'
                 where c.table_schema = 'public' and c.column_name = 'owner_id'
        loop execute format('delete from public.%I where owner_id = %L', t.table_name, '${id}'); end loop;
      end $$;
      delete from app.allowed_users where email = lower('${email}');
      commit;`);
    const d = await admin.auth.admin.deleteUser(id);
    if (d.error) throw d.error;
    const left = sql(`select (select count(*) from auth.users where id = '${id}')
      + (select count(*) from app.allowed_users where email = lower('${email}'))
      + (select count(*) from public.documents where owner_id = '${id}')
      + (select count(*) from public.customers where owner_id = '${id}')
      + (select count(*) from public.audit_log where owner_id = '${id}') as n`);
    check(`cleanup: ${email} and all its rows removed`, /"n":\s*0\b/.test(left));
  } catch (e) { check('cleanup', false, String(e?.message ?? e).slice(0, 300)); }
}
if (cleanupOnly) {
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  for (const u of data.users.filter((x) => /^fm-smoke-[a-z0-9]+@example\.com$/.test(x.email ?? ''))) { await cleanup(u.id, u.email); }
  process.exit(results.some((r) => !r.ok) ? 1 : 0);
}
const browser = await chromium.launch();
try {
  // 1. Anonymous: nothing readable, no function callable, no upload.
  const anon = createClient(url, publishable, { auth: { persistSession: false } });
  let leaks = 0;
  for (const t of ['documents', 'customers', 'expenses', 'payment_allocations', 'audit_log', 'submissions', 'tax_profiles', 'document_outputs']) {
    const r = await anon.from(t).select('*').limit(1);
    if (!r.error && r.data?.length) leaks++;
  }
  const up = await anon.storage.from('expense-files').upload(`x/${run}.txt`, new Blob(['x']), { contentType: 'text/plain' });
  check('anonymous: no rows readable, upload refused', leaks === 0 && !!up.error);

  // 2. Temporary account, NOT allow-listed yet: refused in the real app.
  const c = await admin.auth.admin.createUser({ email: smoke.email, password: smoke.password, email_confirm: true, user_metadata: { synthetic_test_account: true, prod_smoke: true } });
  if (c.error) throw c.error;
  uid = c.data.user.id;
  const desk = await browser.newContext({ locale: 'he-IL', timezoneId: 'Asia/Jerusalem', viewport: { width: 1280, height: 900 } });
  const page = await desk.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const login = async (p) => {
    await p.goto(BASE);
    await p.getByRole('heading', { name: 'כניסה' }).waitFor();
    await p.getByLabel('כתובת דוא״ל').fill(smoke.email);
    await p.getByLabel('סיסמה').fill(smoke.password);
    await p.getByRole('button', { name: 'כניסה', exact: true }).click();
  };
  await login(page);
  await page.getByRole('heading', { name: 'אין הרשאה' }).waitFor({ timeout: 20000 });
  check('not allow-listed account is refused (HTTPS site, production project)', true);
  await page.getByRole('button', { name: 'התנתקות' }).click();

  // 3. Allow-listed: cloud mode on computer and phone, a customer syncs, a DRAFT only.
  const a = await admin.rpc('admin_set_allowed', { p_email: smoke.email, p_allowed: true });
  if (a.error) throw new Error(a.error.message);
  // A new account declares its VAT status before it can create documents (as the owner does in Settings).
  const api = createClient(url, publishable, { auth: { persistSession: false, autoRefreshToken: false } });
  const si = await api.auth.signInWithPassword(smoke);
  if (si.error) throw si.error;
  const v = await api.from('vat_status_periods').insert({ status: 'exempt', effective_from: '2020-01-01', note: 'smoke' });
  if (v.error) throw new Error(v.error.message);
  await api.auth.signOut();
  await login(page);
  await page.getByTestId('mode-badge').filter({ hasText: 'מחובר לענן' }).waitFor({ timeout: 20000 });
  check('allow-listed account: cloud mode on the computer', true);
  const name = `בדיקת עשן ${run}`;
  await page.goto(BASE + '#/income');
  await page.getByLabel('שם (חובה)').fill(name);
  await page.getByRole('button', { name: 'הוספת לקוח' }).click();
  await page.getByText('הלקוח נוסף').waitFor();

  const phoneCtx = await browser.newContext({ ...devices['Pixel 7'], locale: 'he-IL', timezoneId: 'Asia/Jerusalem' });
  const phone = await phoneCtx.newPage();
  await login(phone);
  await phone.getByTestId('mode-badge').filter({ hasText: 'מחובר לענן' }).waitFor({ timeout: 20000 });
  await phone.goto(BASE + '#/income');
  await phone.getByRole('cell', { name }).waitFor({ timeout: 20000 });
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('phone (emulated Pixel 7): sees the customer created on the computer, no horizontal overflow', overflow <= 0);

  await phone.goto(BASE + '#/documents/new');
  const create = phone.getByRole('button', { name: 'יצירת סדרה' });
  await create.or(phone.getByLabel('סדרת מספור')).first().waitFor({ timeout: 20000 });
  if (await create.isVisible()) { await create.click(); await phone.getByLabel('סדרת מספור').waitFor(); }
  await phone.getByLabel('לקוח').selectOption({ label: name });
  await phone.getByLabel('תיאור (שורה 1)').fill('טיוטת בדיקה — לא להפקה');
  await phone.getByLabel('מחיר ליחידה (₪)').fill('1');
  await phone.getByRole('button', { name: 'שמירת טיוטה' }).click();
  for (let i = 0; i < 40 && !/#\/documents\/[0-9a-f-]{36}/.test(phone.url()); i++) await phone.waitForTimeout(500);
  const docs = await admin.from('documents').select('status, number').eq('owner_id', uid);
  check('phone: draft saved to the cloud, nothing issued', !docs.error && docs.data.length === 1 && docs.data[0].status === 'draft' && docs.data[0].number == null,
    `url=${phone.url().replace(/^.*#/, '#')} rows=${JSON.stringify(docs.data ?? docs.error?.message)} alerts=${(await phone.getByRole('alert').allInnerTexts()).join(' / ').slice(0, 200)}`);

  const assistant = await page.evaluate(async () => (await fetch('/api/assistant', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status);
  check('assistant endpoint refuses requests without a session', assistant === 401);
  check('no uncaught page errors', errors.length === 0, errors.join(' | '));
  await phoneCtx.close(); await desk.close();
} catch (e) {
  check('smoke run', false, String(e?.message ?? e).slice(0, 300));
} finally {
  await browser.close();
  if (uid) await cleanup(uid, smoke.email);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\nproduction smoke: ${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
