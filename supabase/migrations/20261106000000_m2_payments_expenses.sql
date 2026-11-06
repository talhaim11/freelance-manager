-- M2: payments allocated to invoices (partial payments), idempotent customer creation,
-- expenses with private file attachments.
--
-- Additive: no existing row is changed or removed. issue_document() and cancel_document()
-- are replaced with versions that keep every M1 rule and add the allocation rules.
-- Every new table has RLS and explicit grants (works with automatic table exposure off).

-- ───────────────────────── customers: idempotent creation ─────────────────────────
-- A repeated "add customer" (double click, retry after a lost response) creates one row.
alter table public.customers add column client_key uuid unique;

-- ───────────────────────── payment allocations ─────────────────────────
-- A receipt draft carries the allocations the user asked for. issue_document() validates
-- them under row locks and records them in payment_allocations, which is immutable.
alter table public.documents add column allocations jsonb not null default '[]'::jsonb
  check (jsonb_typeof(allocations) = 'array');
grant insert (allocations), update (allocations) on public.documents to authenticated;

create table public.payment_allocations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  receipt_id uuid not null references public.documents(id),
  invoice_id uuid not null references public.documents(id),
  amount_agorot bigint not null check (amount_agorot > 0),
  created_at timestamptz not null default now(),
  unique (receipt_id, invoice_id)
);
create index on public.payment_allocations (owner_id, invoice_id);

create or replace function app.block_allocation_changes() returns trigger
language plpgsql as $$
begin
  raise exception 'ALLOCATION_IMMUTABLE: allocations of an issued receipt cannot change; cancel the receipt instead'
    using errcode = 'P0001';
end $$;
create trigger payment_allocations_immutable
  before update or delete on public.payment_allocations
  for each row execute function app.block_allocation_changes();

alter table public.payment_allocations enable row level security;
create policy owner_read on public.payment_allocations for select to authenticated
  using (owner_id = auth.uid() and app.is_allowed());
revoke all on public.payment_allocations from anon, authenticated;
grant select on public.payment_allocations to authenticated;

-- Paid and open amount per issued invoice. A cancelled receipt no longer counts.
-- security_invoker: the caller's RLS applies (the view never bypasses it).
create view public.invoice_balances with (security_invoker = true) as
select d.id as invoice_id, d.customer_id, d.number, d.issue_date, d.total_agorot,
       coalesce(sum(a.amount_agorot) filter (where r.status = 'issued'), 0)::bigint as paid_agorot,
       (d.total_agorot - coalesce(sum(a.amount_agorot) filter (where r.status = 'issued'), 0))::bigint as balance_agorot
from public.documents d
left join public.payment_allocations a on a.invoice_id = d.id
left join public.documents r on r.id = a.receipt_id
where d.doc_type = 'transaction_invoice' and d.status = 'issued'
group by d.id;
revoke all on public.invoice_balances from anon, authenticated;
grant select on public.invoice_balances to authenticated;

-- Validates and records a receipt's allocations. Called inside issue_document() after the
-- receipt row is locked. Invoices are locked in id order, so two receipts paying the same
-- invoice at the same moment are serialized and cannot over-allocate it.
create or replace function app.apply_allocations(d public.documents, p_total bigint) returns void
language plpgsql as $$
declare
  a jsonb; inv public.documents; inv_id uuid; amt bigint; paid bigint; sum_alloc bigint := 0;
begin
  if jsonb_typeof(d.allocations) <> 'array' or jsonb_array_length(d.allocations) = 0 then
    return;
  end if;
  if d.doc_type <> 'receipt' then
    raise exception 'ALLOCATION_INVALID: only a receipt can pay invoices' using errcode = 'P0001';
  end if;
  if (select count(*) from jsonb_array_elements(d.allocations) x)
     <> (select count(distinct x ->> 'invoice_id') from jsonb_array_elements(d.allocations) x) then
    raise exception 'ALLOCATION_INVALID: an invoice appears twice' using errcode = 'P0001';
  end if;

  for a in select x from jsonb_array_elements(d.allocations) x order by x ->> 'invoice_id' loop
    begin
      inv_id := (a ->> 'invoice_id')::uuid;
      amt := (a ->> 'amount_agorot')::bigint;
    exception when others then
      raise exception 'ALLOCATION_INVALID: invoice id or amount is malformed' using errcode = 'P0001';
    end;
    if amt is null or amt <= 0 then
      raise exception 'ALLOCATION_INVALID: amount must be positive' using errcode = 'P0001';
    end if;
    select * into inv from public.documents
      where id = inv_id and owner_id = d.owner_id for update;
    if not found or inv.doc_type <> 'transaction_invoice' or inv.status <> 'issued' then
      raise exception 'ALLOCATION_INVALID: only an issued, not cancelled invoice can be paid' using errcode = 'P0001';
    end if;
    if inv.customer_id is distinct from d.customer_id then
      raise exception 'ALLOCATION_INVALID: the invoice belongs to another customer' using errcode = 'P0001';
    end if;
    select coalesce(sum(pa.amount_agorot), 0) into paid
      from public.payment_allocations pa join public.documents r on r.id = pa.receipt_id
      where pa.invoice_id = inv.id and r.status = 'issued';
    if amt > inv.total_agorot - paid then
      raise exception 'ALLOCATION_EXCEEDS_BALANCE: invoice % has % agorot open', inv.number, inv.total_agorot - paid
        using errcode = 'P0001';
    end if;
    sum_alloc := sum_alloc + amt;
    insert into public.payment_allocations (owner_id, receipt_id, invoice_id, amount_agorot)
      values (d.owner_id, d.id, inv.id, amt);
  end loop;

  if sum_alloc > p_total then
    raise exception 'ALLOCATION_EXCEEDS_RECEIPT: allocated % of a % agorot receipt', sum_alloc, p_total
      using errcode = 'P0001';
  end if;
end $$;

-- ───────────────────────── issue_document (M1 rules + allocations) ─────────────────────────
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

  -- Allocations are checked before a number is taken, in the same transaction.
  perform app.apply_allocations(d, sub);

  num := s.next_number;
  perform set_config('app.doc_mode', 'issuing', true);
  update public.document_series set next_number = num + 1 where id = s.id;
  update public.documents set
    status = 'issued',
    number = num,
    issued_at = now(),
    customer_snapshot = to_jsonb(cust) - array['owner_id','created_at','updated_at','client_key'],
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
          jsonb_build_object('doc_type', d.doc_type, 'series_id', s.id, 'number', num, 'total_agorot', sub,
                             'allocations', d.allocations));
  return d;
end $$;

-- ───────────────────────── cancel_document (M1 rules + paid-invoice guard) ─────────────────────────
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
  -- A paid invoice keeps its payments' trail: cancel the receipts first.
  if orig.doc_type = 'transaction_invoice' and exists (
       select 1 from public.payment_allocations pa join public.documents r on r.id = pa.receipt_id
       where pa.invoice_id = orig.id and r.status = 'issued') then
    raise exception 'INVOICE_HAS_PAYMENTS: cancel the receipts that pay this invoice first' using errcode = 'P0001';
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

-- ───────────────────────── expenses ─────────────────────────
create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid(),
  client_key uuid not null unique,          -- idempotent creation (retry after a lost response)
  supplier text not null check (length(trim(supplier)) > 0),
  supplier_tax_id text not null default '',
  doc_number text not null default '',
  doc_date date not null,
  amount_agorot bigint not null check (amount_agorot > 0),
  vat_agorot bigint not null default 0 check (vat_agorot >= 0),  -- VAT printed on the supplier's document
  category text not null default 'other',
  business_use_pct integer not null default 100 check (business_use_pct between 0 and 100),
  status text not null default 'needs_review' check (status in ('needs_review', 'confirmed')),
  -- Tax treatment is decided later (with the tax rules / accountant), never assumed.
  deductible_status text not null default 'undetermined',
  input_vat_status text not null default 'undetermined',
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (vat_agorot <= amount_agorot)
);
create index on public.expenses (owner_id, doc_date);

create or replace function app.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;
create trigger expenses_touch before update on public.expenses
  for each row execute function app.touch_updated_at();

-- Original files are kept as uploaded. Rows are append-only evidence.
create table public.expense_attachments (
  id uuid primary key,                      -- chosen by the client, so a retry inserts nothing new
  owner_id uuid not null default auth.uid(),
  expense_id uuid not null references public.expenses(id),
  storage_path text not null unique,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  mime_type text not null,
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 10485760),
  original_name text not null default '',
  created_at timestamptz not null default now(),
  check (storage_path like owner_id::text || '/%')
);
create index on public.expense_attachments (owner_id, sha256);

create or replace function app.block_attachment_changes() returns trigger
language plpgsql as $$
begin
  raise exception 'ATTACHMENT_IMMUTABLE: an attached original cannot be changed or removed' using errcode = 'P0001';
end $$;
create trigger expense_attachments_immutable
  before update or delete on public.expense_attachments
  for each row execute function app.block_attachment_changes();

alter table public.expenses enable row level security;
alter table public.expense_attachments enable row level security;
create policy owner_all on public.expenses for all to authenticated
  using (owner_id = auth.uid() and app.is_allowed()) with check (owner_id = auth.uid() and app.is_allowed());
create policy owner_read on public.expense_attachments for select to authenticated
  using (owner_id = auth.uid() and app.is_allowed());
create policy owner_insert on public.expense_attachments for insert to authenticated
  with check (owner_id = auth.uid() and app.is_allowed()
              and exists (select 1 from public.expenses e where e.id = expense_id and e.owner_id = auth.uid()));

revoke all on public.expenses, public.expense_attachments from anon, authenticated;
grant select on public.expenses to authenticated;
grant insert (client_key, supplier, supplier_tax_id, doc_number, doc_date, amount_agorot, vat_agorot,
              category, business_use_pct, status, notes) on public.expenses to authenticated;
grant update (supplier, supplier_tax_id, doc_number, doc_date, amount_agorot, vat_agorot,
              category, business_use_pct, status, notes) on public.expenses to authenticated;
grant select on public.expense_attachments to authenticated;
grant insert (id, expense_id, storage_path, sha256, mime_type, size_bytes, original_name)
  on public.expense_attachments to authenticated;

-- Internal helpers are reachable only from the functions and triggers above.
revoke all on function app.apply_allocations(public.documents, bigint) from public;
revoke all on function app.block_allocation_changes() from public;
revoke all on function app.block_attachment_changes() from public;
revoke all on function app.touch_updated_at() from public;

-- ───────────────────────── private file storage ─────────────────────────
-- Private bucket: no public URLs. Each user can only reach files under "<their user id>/",
-- and only while allow-listed. Files cannot be overwritten or deleted from the app.
-- (Skipped where the Supabase storage schema does not exist, e.g. the plain-Postgres test harness.)
do $do$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('expense-files', 'expense-files', false, 10485760,
            array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'])
    on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

    execute $p$
      create policy expense_files_read on storage.objects for select to authenticated
      using (bucket_id = 'expense-files' and (storage.foldername(name))[1] = auth.uid()::text and app.is_allowed())
    $p$;
    execute $p$
      create policy expense_files_insert on storage.objects for insert to authenticated
      with check (bucket_id = 'expense-files' and (storage.foldername(name))[1] = auth.uid()::text and app.is_allowed())
    $p$;
  end if;
end
$do$;
