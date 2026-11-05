// Runs the real Supabase migration against an embedded PostgreSQL 17 server,
// with minimal stand-ins for Supabase's auth schema and roles.
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const SUPABASE_STUBS = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  end $$;
  create schema if not exists auth;
  create or replace function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create or replace function auth.jwt() returns jsonb language sql stable as
    $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
  grant usage on schema auth to anon, authenticated;
  grant usage on schema public to anon, authenticated;
`;

export interface TestUser { id: string; email: string }
export const newUser = (email: string): TestUser => ({ id: randomUUID(), email });

export class TestDb {
  private server!: EmbeddedPostgres;
  private dir!: string;
  readonly port = 54000 + Math.floor(Math.random() * 900);
  admin!: pg.Pool;

  async start() {
    this.dir = mkdtempSync(join(tmpdir(), 'fm-pg-'));
    this.server = new EmbeddedPostgres({
      databaseDir: this.dir, user: 'postgres', password: 'test', port: this.port,
      persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'], onLog: () => {}, onError: () => {},
    });
    await this.server.initialise();
    await this.server.start();
    this.admin = new pg.Pool({ port: this.port, user: 'postgres', password: 'test', database: 'postgres', max: 60 });
    await this.admin.query(SUPABASE_STUBS);
    const dir = join(process.cwd(), 'supabase', 'migrations');
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
      await this.admin.query(readFileSync(join(dir, f), 'utf8'));
    }
  }

  async stop() {
    await this.admin?.end();
    await this.server?.stop();
    try { rmSync(this.dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  async allow(email: string) {
    await this.admin.query('insert into app.allowed_users(email) values ($1) on conflict do nothing', [email]);
  }

  /** Runs fn in one transaction as the given Supabase user (role authenticated). */
  async as<T>(user: TestUser | null, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await this.admin.connect();
    try {
      await c.query('begin');
      if (user) {
        await c.query('set local role authenticated');
        await c.query("select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)",
          [user.id, JSON.stringify({ sub: user.id, email: user.email, role: 'authenticated' })]);
      } else {
        await c.query('set local role anon');
      }
      const r = await fn(c);
      await c.query('commit');
      return r;
    } catch (e) {
      await c.query('rollback').catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }
}

/** Creates profile, exempt VAT period, a customer and a series for the user. */
export async function seedOwner(db: TestDb, u: TestUser, opts: { docType?: string; startAt?: number } = {}) {
  return db.as(u, async (c) => {
    await c.query(`insert into business_profiles(legal_name, id_number, address) values ('בדיקה סינתטית', '000000018', 'רחוב הדוגמה 1, עיר')
                   on conflict (owner_id) do nothing`);
    await c.query(`insert into vat_status_periods(status, effective_from) values ('exempt', '2020-01-01')`);
    const cust = await c.query(`insert into customers(name, address) values ('לקוח דמו בע"מ', 'שדרות הבדיקה 2') returning id`);
    const series = await c.query(
      `insert into document_series(doc_type, name, next_number) values ($1, $3, $2) returning id`,
      [opts.docType ?? 'transaction_invoice', opts.startAt ?? 1, 'סדרה-' + randomUUID().slice(0, 8)]);
    return { customerId: cust.rows[0].id as string, seriesId: series.rows[0].id as string };
  });
}

export async function createDraft(db: TestDb, u: TestUser, seriesId: string, customerId: string,
  over: Partial<{ docType: string; lines: unknown; issueDate: string; payment: unknown; key: string }> = {}) {
  return db.as(u, async (c) => {
    const r = await c.query(
      `insert into documents(idempotency_key, series_id, doc_type, issue_date, customer_id, lines, payment_details)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [over.key ?? randomUUID(), seriesId, over.docType ?? 'transaction_invoice', over.issueDate ?? '2026-03-10',
        customerId, JSON.stringify(over.lines ?? [{ description: 'ייעוץ', quantity: 2, unit_price_agorot: 15050 }]),
        JSON.stringify(over.payment ?? {})]);
    return r.rows[0].id as string;
  });
}
