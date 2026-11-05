-- M1 foundation: single-owner access, business profile, VAT status history,
-- customers, document series, documents with transactional numbering,
-- finalized-document protection, traceable cancellation, append-only audit log.
--
-- Money is stored as integer agorot (bigint). Dates are local calendar dates.
-- Targets Supabase Postgres (auth.uid(), auth.jwt(), roles anon/authenticated).

create schema if not exists app;

-- ───────────────────────── access control ─────────────────────────
-- Only e-mail addresses listed here can read or write anything, even if the
-- Supabase project accidentally allows sign-ups. Managed from the SQL editor.
create table app.allowed_users (
  email text primary key check (email = lower(email)),
  added_at timestamptz not null default now()
);
revoke all on app.allowed_users from public;

create or replace function app.is_allowed() returns boolean
language sql stable security definer set search_path = app, pg_temp as $$
  select exists (
    select 1 from app.allowed_users
    where email = lower(coalesce(auth.jwt() ->> 'email', ''))
  ) and auth.uid() is not null;
$$;
revoke all on function app.is_allowed() from public;
grant usage on schema app to authenticated;
grant execute on function app.is_allowed() to authenticated;

-- ───────────────────────── reference types ─────────────────────────
create type public.vat_status as enum ('exempt', 'licensed');
create type public.doc_type as enum (
  'quote',               -- הצעת מחיר
  'transaction_invoice', -- חשבונית עסקה / דרישת תשלום
  'receipt',             -- קבלה
  'tax_invoice',         -- חשבונית מס (licensed only)
  'tax_invoice_receipt', -- חשבונית מס/קבלה (licensed only)
  'credit_invoice',      -- חשבונית זיכוי (licensed only)
  'cancellation'         -- מסמך ביטול (references the cancelled document)
);
create type public.doc_status as enum ('draft', 'issued', 'cancelled');

-- ───────────────────────── tables ─────────────────────────
create table public.business_profiles (
  owner_id uuid primary key default auth.uid(),
  legal_name text not null default '',
  business_name text not null default '',
  id_number text not null default '',
  address text not null default '',
  phone text not null default '',
  email text not null default '',
  updated_at timestamptz not null default now()
);

-- Classification history: a status change never reinterprets the past.
create table public.vat_status_periods (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid(),
  status public.vat_status not null,
  effective_from date not null,
  effective_to date,
  note text not null default '',
  created_at timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from)
);
create index on public.vat_status_periods (owner_id, effective_from);

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid(),
  name text not null check (length(trim(name)) > 0),
  tax_id text not null default '',
  address text not null default '',
  email text not null default '',
  phone text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.document_series (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid(),
  doc_type public.doc_type not null,
  name text not null,
  next_number integer not null default 1 check (next_number > 0),
  is_legacy boolean not null default false,
  created_at timestamptz not null default now(),
  unique (owner_id, doc_type, name)
);

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid(),
  idempotency_key uuid not null unique,
  series_id uuid not null references public.document_series(id),
  doc_type public.doc_type not null,
  status public.doc_status not null default 'draft',
  number integer,
  issue_date date not null,
  customer_id uuid references public.customers(id),
  lines jsonb not null default '[]'::jsonb,
  notes text not null default '',
  payment_details jsonb not null default '{}'::jsonb,
  -- Filled by issue_document(); never trusted from the client.
  customer_snapshot jsonb,
  issuer_snapshot jsonb,
  subtotal_agorot bigint,
  vat_rate_bp integer,
  vat_agorot bigint,
  total_agorot bigint,
  vat_status_at_issue public.vat_status,
  rule_set_version text,
  corrects_document_id uuid references public.documents(id),
  correction_reason text,
  cancelled_by_document_id uuid references public.documents(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  issued_at timestamptz,
  cancelled_at timestamptz,
  unique (series_id, number),
  check ((status = 'draft') = (number is null)),
  check (status = 'draft' or (issued_at is not null and total_agorot is not null))
);
create index on public.documents (owner_id, status, issue_date);

-- Append-only audit trail.
create table public.audit_log (
  id bigserial primary key,
  owner_id uuid not null,
  action text not null,
  entity text not null,
  entity_id uuid,
  details jsonb not null default '{}'::jsonb,
  at timestamptz not null default now()
);
create index on public.audit_log (owner_id, at);

-- ───────────────────────── protection triggers ─────────────────────────
create or replace function app.protect_documents() returns trigger
language plpgsql as $$
declare
  mode text := coalesce(current_setting('app.doc_mode', true), '');
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'FINALIZED_DOCUMENT: issued documents cannot be deleted (document %)', old.id
        using errcode = 'P0001';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'draft' and mode <> 'issuing' then
      raise exception 'DRAFT_ONLY: documents must be created as drafts' using errcode = 'P0001';
    end if;
    return new;
  end if;

  -- UPDATE
  if old.status = 'draft' then
    if new.status = 'draft' then
      if new.owner_id <> old.owner_id or new.idempotency_key <> old.idempotency_key then
        raise exception 'IMMUTABLE_FIELD: owner and idempotency key cannot change' using errcode = 'P0001';
      end if;
      new.updated_at := now();
      return new;
    end if;
    if new.status = 'issued' and mode = 'issuing' then
      return new;
    end if;
    raise exception 'ISSUE_VIA_FUNCTION: use issue_document() to finalize' using errcode = 'P0001';
  end if;

  -- old.status is issued or cancelled: only issued -> cancelled via cancel_document()
  if old.status = 'issued' and new.status = 'cancelled' and mode = 'cancelling'
     and (to_jsonb(new) - array['status','cancelled_at','cancelled_by_document_id','updated_at'])
       = (to_jsonb(old) - array['status','cancelled_at','cancelled_by_document_id','updated_at']) then
    return new;
  end if;
  raise exception 'FINALIZED_DOCUMENT: issued documents cannot be edited (document %); issue a correction instead', old.id
    using errcode = 'P0001';
end $$;

create trigger documents_protect
  before insert or update or delete on public.documents
  for each row execute function app.protect_documents();

create or replace function app.block_audit_changes() returns trigger
language plpgsql as $$
begin
  raise exception 'AUDIT_APPEND_ONLY' using errcode = 'P0001';
end $$;
create trigger audit_log_append_only
  before update or delete on public.audit_log
  for each row execute function app.block_audit_changes();

create or replace function app.protect_series() returns trigger
language plpgsql as $$
begin
  if new.next_number <> old.next_number and coalesce(current_setting('app.doc_mode', true), '') <> 'issuing' then
    raise exception 'SERIES_NUMBER_LOCKED: numbering advances only when a document is issued' using errcode = 'P0001';
  end if;
  if new.next_number < old.next_number then
    raise exception 'SERIES_NUMBER_LOCKED: numbering cannot move backwards' using errcode = 'P0001';
  end if;
  if new.doc_type <> old.doc_type or new.owner_id <> old.owner_id then
    raise exception 'IMMUTABLE_FIELD: series type and owner cannot change' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger series_protect before update on public.document_series
  for each row execute function app.protect_series();
create or replace function app.block_series_delete() returns trigger
language plpgsql as $$
begin
  if exists (select 1 from public.documents d where d.series_id = old.id and d.status <> 'draft') then
    raise exception 'SERIES_IN_USE: a series with issued documents cannot be deleted' using errcode = 'P0001';
  end if;
  return old;
end $$;
create trigger series_no_delete before delete on public.document_series
  for each row execute function app.block_series_delete();

-- ───────────────────────── domain helpers ─────────────────────────
create or replace function app.vat_status_on(p_owner uuid, p_date date) returns public.vat_status
language sql stable as $$
  select status from public.vat_status_periods
  where owner_id = p_owner and effective_from <= p_date
    and (effective_to is null or effective_to >= p_date)
  order by effective_from desc limit 1;
$$;

-- Line total = round_half_up(quantity × unit price) − discount, in agorot.
create or replace function app.lines_subtotal(p_lines jsonb) returns bigint
language plpgsql immutable as $$
declare
  l jsonb; total bigint := 0; qty numeric; price bigint; disc bigint; line bigint;
begin
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'INVALID_LINES: at least one line is required' using errcode = 'P0001';
  end if;
  for l in select * from jsonb_array_elements(p_lines) loop
    if length(trim(coalesce(l ->> 'description', ''))) = 0 then
      raise exception 'INVALID_LINES: every line needs a description' using errcode = 'P0001';
    end if;
    qty := (l ->> 'quantity')::numeric;
    price := (l ->> 'unit_price_agorot')::bigint;
    disc := coalesce((l ->> 'discount_agorot')::bigint, 0);
    if qty is null or qty <= 0 or price is null or disc < 0 then
      raise exception 'INVALID_LINES: quantity must be positive, price and discount valid' using errcode = 'P0001';
    end if;
    line := round(qty * price) - disc;  -- numeric round(): half away from zero
    if line < 0 then
      raise exception 'INVALID_LINES: discount exceeds line amount' using errcode = 'P0001';
    end if;
    total := total + line;
  end loop;
  return total;
end $$;

-- ───────────────────────── issue_document ─────────────────────────
-- Finalizes a draft in one transaction: locks the document and its series,
-- assigns the next number, computes totals and snapshots server-side.
-- Idempotent: calling it again for an issued document returns it unchanged.
create or replace function public.issue_document(p_document_id uuid)
returns public.documents
language plpgsql security definer set search_path = public, app, pg_temp as $$
declare
  d public.documents;
  s public.document_series;
  prof public.business_profiles;
  cust public.customers;
  vs public.vat_status;
  sub bigint;
  num integer;
begin
  if not app.is_allowed() then
    raise exception 'NOT_ALLOWED' using errcode = '42501';
  end if;

  select * into d from public.documents where id = p_document_id and owner_id = auth.uid() for update;
  if not found then
    raise exception 'NOT_FOUND: document %', p_document_id using errcode = 'P0002';
  end if;
  if d.status <> 'draft' then
    return d;  -- already issued (retry, double click, second device)
  end if;

  select * into s from public.document_series where id = d.series_id and owner_id = auth.uid() for update;
  if not found or s.doc_type <> d.doc_type then
    raise exception 'SERIES_MISMATCH: series does not match document type' using errcode = 'P0001';
  end if;
  if s.is_legacy then
    raise exception 'LEGACY_SERIES: new documents cannot be issued in a legacy series' using errcode = 'P0001';
  end if;

  vs := app.vat_status_on(auth.uid(), d.issue_date);
  if vs is null then
    raise exception 'VAT_STATUS_UNKNOWN: set the VAT status that applies on %', d.issue_date using errcode = 'P0001';
  end if;
  if vs = 'exempt' and d.doc_type in ('tax_invoice', 'tax_invoice_receipt', 'credit_invoice') then
    raise exception 'EXEMPT_CANNOT_ISSUE_TAX_INVOICE: an exempt dealer may not issue %', d.doc_type using errcode = 'P0001';
  end if;
  if vs = 'licensed' and d.doc_type in ('tax_invoice', 'tax_invoice_receipt', 'credit_invoice') then
    -- VAT documents are not implemented in M1 (rates, allocation numbers, credit rules pending).
    raise exception 'NOT_SUPPORTED_YET: % is not supported in this version', d.doc_type using errcode = 'P0001';
  end if;
  if d.doc_type = 'cancellation' then
    raise exception 'USE_CANCEL_DOCUMENT: cancellations are created by cancel_document()' using errcode = 'P0001';
  end if;

  select * into prof from public.business_profiles where owner_id = auth.uid();
  if not found or length(trim(prof.legal_name)) = 0 or length(trim(prof.id_number)) = 0
     or length(trim(prof.address)) = 0 then
    raise exception 'PROFILE_INCOMPLETE: issuer name, ID number and address are required' using errcode = 'P0001';
  end if;

  if d.customer_id is null then
    raise exception 'CUSTOMER_REQUIRED' using errcode = 'P0001';
  end if;
  select * into cust from public.customers where id = d.customer_id and owner_id = auth.uid();
  if not found then
    raise exception 'CUSTOMER_REQUIRED' using errcode = 'P0001';
  end if;
  if d.doc_type = 'transaction_invoice' and length(trim(cust.address)) = 0 then
    raise exception 'CUSTOMER_ADDRESS_REQUIRED: an invoice must show the customer address' using errcode = 'P0001';
  end if;
  if d.doc_type = 'receipt' and length(trim(coalesce(d.payment_details ->> 'method', ''))) = 0 then
    raise exception 'PAYMENT_METHOD_REQUIRED: a receipt must state how payment was made' using errcode = 'P0001';
  end if;

  sub := app.lines_subtotal(d.lines);
  if sub <= 0 then
    raise exception 'INVALID_TOTAL: total must be positive' using errcode = 'P0001';
  end if;

  num := s.next_number;
  perform set_config('app.doc_mode', 'issuing', true);
  update public.document_series set next_number = num + 1 where id = s.id;
  update public.documents set
    status = 'issued',
    number = num,
    issued_at = now(),
    customer_snapshot = to_jsonb(cust) - array['owner_id','created_at','updated_at'],
    issuer_snapshot = to_jsonb(prof) - array['owner_id','updated_at'],
    subtotal_agorot = sub,
    vat_rate_bp = 0,
    vat_agorot = 0,
    total_agorot = sub,
    vat_status_at_issue = vs,
    rule_set_version = 'IL-2026.1'
  where id = d.id
  returning * into d;
  perform set_config('app.doc_mode', '', true);

  insert into public.audit_log (owner_id, action, entity, entity_id, details)
  values (auth.uid(), 'document.issued', 'document', d.id,
          jsonb_build_object('doc_type', d.doc_type, 'series_id', s.id, 'number', num, 'total_agorot', sub));
  return d;
end $$;

-- ───────────────────────── cancel_document ─────────────────────────
-- Issues a cancellation document that references the original and marks the
-- original as cancelled. The original's content is never changed.
-- Idempotent through p_idempotency_key.
create or replace function public.cancel_document(p_document_id uuid, p_reason text, p_idempotency_key uuid)
returns public.documents
language plpgsql security definer set search_path = public, app, pg_temp as $$
declare
  orig public.documents;
  existing public.documents;
  s public.document_series;
  c public.documents;
  num integer;
begin
  if not app.is_allowed() then
    raise exception 'NOT_ALLOWED' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_reason, ''))) = 0 then
    raise exception 'REASON_REQUIRED: a cancellation must state its reason' using errcode = 'P0001';
  end if;

  select * into existing from public.documents where idempotency_key = p_idempotency_key;
  if found then
    if existing.owner_id <> auth.uid() or existing.corrects_document_id is distinct from p_document_id then
      raise exception 'IDEMPOTENCY_KEY_REUSED' using errcode = 'P0001';
    end if;
    return existing;
  end if;

  select * into orig from public.documents where id = p_document_id and owner_id = auth.uid() for update;
  if not found then
    raise exception 'NOT_FOUND: document %', p_document_id using errcode = 'P0002';
  end if;
  if orig.status = 'cancelled' then
    select * into existing from public.documents where id = orig.cancelled_by_document_id;
    return existing;
  end if;
  if orig.status <> 'issued' then
    raise exception 'NOT_ISSUED: only issued documents can be cancelled; delete the draft instead' using errcode = 'P0001';
  end if;
  if orig.doc_type = 'cancellation' then
    raise exception 'CANNOT_CANCEL_CANCELLATION' using errcode = 'P0001';
  end if;

  select * into s from public.document_series
  where owner_id = auth.uid() and doc_type = 'cancellation' and not is_legacy
  order by created_at limit 1 for update;
  if not found then
    insert into public.document_series (owner_id, doc_type, name, next_number)
    values (auth.uid(), 'cancellation', 'ביטולים', 1) returning * into s;
    perform 1 from public.document_series where id = s.id for update;
  end if;

  num := s.next_number;
  perform set_config('app.doc_mode', 'issuing', true);
  update public.document_series set next_number = num + 1 where id = s.id;
  insert into public.documents (
    owner_id, idempotency_key, series_id, doc_type, status, number, issue_date, customer_id,
    lines, notes, customer_snapshot, issuer_snapshot, subtotal_agorot, vat_rate_bp, vat_agorot,
    total_agorot, vat_status_at_issue, rule_set_version, corrects_document_id, correction_reason, issued_at)
  values (
    auth.uid(), p_idempotency_key, s.id, 'cancellation', 'issued', num,
    (now() at time zone 'Asia/Jerusalem')::date, orig.customer_id,
    orig.lines, '', orig.customer_snapshot, orig.issuer_snapshot,
    -orig.subtotal_agorot, orig.vat_rate_bp, -orig.vat_agorot, -orig.total_agorot,
    orig.vat_status_at_issue, orig.rule_set_version, orig.id, trim(p_reason), now())
  returning * into c;

  perform set_config('app.doc_mode', 'cancelling', true);
  update public.documents set status = 'cancelled', cancelled_at = now(), cancelled_by_document_id = c.id
  where id = orig.id;
  perform set_config('app.doc_mode', '', true);

  insert into public.audit_log (owner_id, action, entity, entity_id, details)
  values (auth.uid(), 'document.cancelled', 'document', orig.id,
          jsonb_build_object('cancellation_id', c.id, 'cancellation_number', num, 'reason', trim(p_reason)));
  return c;
end $$;

revoke all on function public.issue_document(uuid) from public, anon;
revoke all on function public.cancel_document(uuid, text, uuid) from public, anon;
grant execute on function public.issue_document(uuid) to authenticated;
grant execute on function public.cancel_document(uuid, text, uuid) to authenticated;

-- ───────────────────────── row-level security ─────────────────────────
alter table public.business_profiles enable row level security;
alter table public.vat_status_periods enable row level security;
alter table public.customers enable row level security;
alter table public.document_series enable row level security;
alter table public.documents enable row level security;
alter table public.audit_log enable row level security;

create policy owner_all on public.business_profiles for all to authenticated
  using (owner_id = auth.uid() and app.is_allowed()) with check (owner_id = auth.uid() and app.is_allowed());
create policy owner_all on public.vat_status_periods for all to authenticated
  using (owner_id = auth.uid() and app.is_allowed()) with check (owner_id = auth.uid() and app.is_allowed());
create policy owner_all on public.customers for all to authenticated
  using (owner_id = auth.uid() and app.is_allowed()) with check (owner_id = auth.uid() and app.is_allowed());
create policy owner_all on public.document_series for all to authenticated
  using (owner_id = auth.uid() and app.is_allowed()) with check (owner_id = auth.uid() and app.is_allowed());
create policy owner_all on public.documents for all to authenticated
  using (owner_id = auth.uid() and app.is_allowed()) with check (owner_id = auth.uid() and app.is_allowed());
create policy owner_read on public.audit_log for select to authenticated
  using (owner_id = auth.uid() and app.is_allowed());

-- Explicit privileges (Supabase grants broad defaults on public; narrow them).
revoke all on public.business_profiles, public.vat_status_periods, public.customers,
  public.document_series, public.documents, public.audit_log from anon, authenticated;
grant select, insert, update on public.business_profiles to authenticated;
grant select, insert, update, delete on public.vat_status_periods to authenticated;
grant select, insert, update on public.customers to authenticated;
grant select, insert on public.document_series to authenticated;
grant update (name) on public.document_series to authenticated;
grant select, delete on public.documents to authenticated;
grant insert (idempotency_key, series_id, doc_type, issue_date, customer_id, lines, notes, payment_details)
  on public.documents to authenticated;
grant update (series_id, doc_type, issue_date, customer_id, lines, notes, payment_details)
  on public.documents to authenticated;
grant select on public.audit_log to authenticated;

-- Lets the signed-in client know whether its account is on the allow-list
-- (so the UI can explain an empty dataset instead of showing nothing).
create or replace function public.am_i_allowed() returns boolean
language sql stable security invoker set search_path = app, pg_temp as $$
  select app.is_allowed();
$$;
revoke all on function public.am_i_allowed() from public, anon;
grant execute on function public.am_i_allowed() to authenticated;
