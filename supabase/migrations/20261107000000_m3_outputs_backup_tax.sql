-- M3: original/copy registry for document PDFs, tax profile, guided government submissions,
-- and a transactional import used by backup restore and by the legacy-app import.
-- Additive: no existing row is changed or removed. RLS + explicit grants on every new table.

-- ───────────────────────── document outputs ("מקור" / "העתק") ─────────────────────────
-- The first PDF/print of an issued document is the original; every later one is a copy.
create table public.document_outputs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  document_id uuid not null references public.documents(id),
  kind text not null check (kind in ('original', 'copy')),
  sha256 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);
create unique index document_outputs_one_original on public.document_outputs (document_id) where kind = 'original';
create index on public.document_outputs (owner_id, document_id);

create or replace function app.block_output_changes() returns trigger
language plpgsql as $$
begin
  raise exception 'OUTPUT_IMMUTABLE: the print/PDF history cannot be changed' using errcode = 'P0001';
end $$;
create trigger document_outputs_immutable before update or delete on public.document_outputs
  for each row execute function app.block_output_changes();

alter table public.document_outputs enable row level security;
create policy owner_read on public.document_outputs for select to authenticated
  using (owner_id = auth.uid() and app.is_allowed());
revoke all on public.document_outputs from anon, authenticated;
grant select on public.document_outputs to authenticated;

-- Records one output and says whether it is the original or a copy. Serialized per document.
-- The client renders both variants first and passes both fingerprints; the one that matches the
-- assigned marking is stored, so the registry always describes the file the user received.
create or replace function public.register_document_output(p_document_id uuid, p_sha_original text, p_sha_copy text)
returns text
language plpgsql security definer set search_path = public, app, pg_temp as $$
declare d public.documents; k text;
begin
  if not app.is_allowed() then raise exception 'NOT_ALLOWED' using errcode = '42501'; end if;
  select * into d from public.documents where id = p_document_id and owner_id = auth.uid() for update;
  if not found then raise exception 'NOT_FOUND: document %', p_document_id using errcode = 'P0002'; end if;
  if d.status = 'draft' then raise exception 'NOT_ISSUED: a draft has no original' using errcode = 'P0001'; end if;
  k := case when exists (select 1 from public.document_outputs where document_id = d.id and kind = 'original') then 'copy' else 'original' end;
  insert into public.document_outputs (owner_id, document_id, kind, sha256)
  values (auth.uid(), d.id, k, case k when 'original' then p_sha_original else p_sha_copy end);
  return k;
end $$;
revoke all on function public.register_document_output(uuid, text, text) from public, anon;
grant execute on function public.register_document_output(uuid, text, text) to authenticated;

-- ───────────────────────── tax profile ─────────────────────────
create table public.tax_profiles (
  owner_id uuid primary key default auth.uid(),
  income_tax_regime text not null default 'unknown' check (income_tax_regime in ('unknown', 'regular', 'small_business')),
  employed text not null default 'unknown' check (employed in ('unknown', 'yes', 'no')),
  ni_self_employed text not null default 'unknown' check (ni_self_employed in ('unknown', 'yes', 'no')),
  advances_book text not null default 'unknown' check (advances_book in ('unknown', 'yes', 'no')),
  onboarding_done boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table public.tax_profiles enable row level security;
create policy owner_all on public.tax_profiles for all to authenticated
  using (owner_id = auth.uid() and app.is_allowed()) with check (owner_id = auth.uid() and app.is_allowed());
revoke all on public.tax_profiles from anon, authenticated;
grant select on public.tax_profiles to authenticated;
grant insert (income_tax_regime, employed, ni_self_employed, advances_book, onboarding_done),
      update (income_tax_regime, employed, ni_self_employed, advances_book, onboarding_done, updated_at)
  on public.tax_profiles to authenticated;

-- ───────────────────────── guided submissions (level B) ─────────────────────────
-- What the user prepared and submitted on an official site. Never "accepted" without a reference.
create table public.submissions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid(),
  kind text not null check (kind in ('vat_exempt_declaration', 'small_business_report', 'annual_1301', 'income_tax_advance', 'national_insurance')),
  tax_year integer not null check (tax_year between 2000 and 2100),
  period text not null default '',
  status text not null default 'prepared' check (status in ('prepared', 'submitted', 'accepted', 'rejected')),
  reference text not null default '',
  submitted_on date,
  payment_status text not null default 'not_due' check (payment_status in ('not_due', 'payment_pending', 'paid')),
  payment_reference text not null default '',
  prepared_values jsonb not null default '{}'::jsonb,
  attachment_path text check (attachment_path is null or attachment_path like owner_id::text || '/%'),
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, kind, tax_year, period),
  check (status = 'prepared' or length(trim(reference)) > 0),
  check (payment_status <> 'paid' or length(trim(payment_reference)) > 0)
);
create trigger submissions_touch before update on public.submissions
  for each row execute function app.touch_updated_at();
alter table public.submissions enable row level security;
create policy owner_all on public.submissions for all to authenticated
  using (owner_id = auth.uid() and app.is_allowed()) with check (owner_id = auth.uid() and app.is_allowed());
revoke all on public.submissions from anon, authenticated;
grant select on public.submissions to authenticated;
grant insert (kind, tax_year, period, status, reference, submitted_on, payment_status, payment_reference, prepared_values, attachment_path, notes),
      update (status, reference, submitted_on, payment_status, payment_reference, prepared_values, attachment_path, notes)
  on public.submissions to authenticated;

-- ───────────────────────── import: backup restore and legacy-app import ─────────────────────────
-- One transaction: everything is imported or nothing is. Ids are re-generated (the source account
-- may still exist); document numbers, series, dates, snapshots and statuses are preserved exactly.
--   mode 'restore': the account must be empty.
--   mode 'legacy' : only legacy series may be created, and only once.
create or replace function public.import_records(p jsonb, p_mode text)
returns jsonb
language plpgsql security definer set search_path = public, app, pg_temp as $$
declare
  me uuid := auth.uid();
  m jsonb := '{}'::jsonb;   -- old id -> new id
  r jsonb; nid uuid;
  n_cust int := 0; n_series int := 0; n_docs int := 0; n_alloc int := 0; n_exp int := 0; n_att int := 0; n_sub int := 0;
  sum_docs bigint := 0;
begin
  if not app.is_allowed() then raise exception 'NOT_ALLOWED' using errcode = '42501'; end if;
  if p_mode not in ('restore', 'legacy') then raise exception 'IMPORT_INVALID: unknown mode' using errcode = 'P0001'; end if;
  if coalesce(p ->> 'format', '') <> 'freelance-manager-backup' or coalesce((p ->> 'version')::int, 0) <> 1 then
    raise exception 'IMPORT_INVALID: not a supported backup file' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtext('import:' || me::text));

  if p_mode = 'restore' and (exists (select 1 from public.customers where owner_id = me)
      or exists (select 1 from public.documents where owner_id = me)
      or exists (select 1 from public.document_series where owner_id = me)
      or exists (select 1 from public.expenses where owner_id = me)) then
    raise exception 'IMPORT_TARGET_NOT_EMPTY: restoring needs an account without records' using errcode = 'P0001';
  end if;
  if p_mode = 'legacy' then
    if exists (select 1 from public.document_series where owner_id = me and is_legacy) then
      raise exception 'IMPORT_ALREADY_DONE: the previous app was already imported' using errcode = 'P0001';
    end if;
    if exists (select 1 from jsonb_array_elements(coalesce(p -> 'series', '[]')) s where not coalesce((s ->> 'is_legacy')::boolean, false))
       or exists (select 1 from jsonb_array_elements(coalesce(p -> 'documents', '[]')) d where d ->> 'doc_type' <> 'transaction_invoice') then
      raise exception 'IMPORT_INVALID: a legacy import may only add legacy invoice series' using errcode = 'P0001';
    end if;
  end if;

  -- profile: filled only when the account has none (never overwritten)
  if jsonb_typeof(p -> 'profile') = 'object' then
    insert into public.business_profiles (owner_id, legal_name, business_name, id_number, address, phone, email)
    values (me, coalesce(p -> 'profile' ->> 'legal_name', ''), coalesce(p -> 'profile' ->> 'business_name', ''),
            coalesce(p -> 'profile' ->> 'id_number', ''), coalesce(p -> 'profile' ->> 'address', ''),
            coalesce(p -> 'profile' ->> 'phone', ''), coalesce(p -> 'profile' ->> 'email', ''))
    on conflict (owner_id) do nothing;
  end if;
  if not exists (select 1 from public.vat_status_periods where owner_id = me) then
    insert into public.vat_status_periods (owner_id, status, effective_from, effective_to, note)
    select me, (v ->> 'status')::public.vat_status, (v ->> 'effective_from')::date, (v ->> 'effective_to')::date, coalesce(v ->> 'note', '')
    from jsonb_array_elements(coalesce(p -> 'vat_periods', '[]')) v;
  end if;
  if p_mode = 'restore' and jsonb_typeof(p -> 'tax_profile') = 'object' then
    insert into public.tax_profiles (owner_id, income_tax_regime, employed, ni_self_employed, advances_book, onboarding_done)
    values (me, coalesce(p -> 'tax_profile' ->> 'income_tax_regime', 'unknown'), coalesce(p -> 'tax_profile' ->> 'employed', 'unknown'),
            coalesce(p -> 'tax_profile' ->> 'ni_self_employed', 'unknown'), coalesce(p -> 'tax_profile' ->> 'advances_book', 'unknown'),
            coalesce((p -> 'tax_profile' ->> 'onboarding_done')::boolean, false))
    on conflict (owner_id) do nothing;
  end if;

  for r in select * from jsonb_array_elements(coalesce(p -> 'customers', '[]')) loop
    nid := gen_random_uuid(); m := m || jsonb_build_object(r ->> 'id', nid);
    insert into public.customers (id, owner_id, name, tax_id, address, email, phone, created_at)
    values (nid, me, r ->> 'name', coalesce(r ->> 'tax_id', ''), coalesce(r ->> 'address', ''), coalesce(r ->> 'email', ''),
            coalesce(r ->> 'phone', ''), coalesce((r ->> 'created_at')::timestamptz, now()));
    n_cust := n_cust + 1;
  end loop;

  for r in select * from jsonb_array_elements(coalesce(p -> 'series', '[]')) loop
    nid := gen_random_uuid(); m := m || jsonb_build_object(r ->> 'id', nid);
    insert into public.document_series (id, owner_id, doc_type, name, next_number, is_legacy)
    values (nid, me, (r ->> 'doc_type')::public.doc_type, r ->> 'name', (r ->> 'next_number')::int, coalesce((r ->> 'is_legacy')::boolean, false));
    n_series := n_series + 1;
  end loop;
  for r in select * from jsonb_array_elements(coalesce(p -> 'documents', '[]')) loop
    m := m || jsonb_build_object(r ->> 'id', gen_random_uuid());
  end loop;

  -- documents: originals first, cancellations after (they reference their original)
  perform set_config('app.doc_mode', 'issuing', true);
  for r in select x from jsonb_array_elements(coalesce(p -> 'documents', '[]')) x
           order by (x ->> 'doc_type' = 'cancellation'), x ->> 'created_at' loop
    if (m ->> (r ->> 'series_id')) is null then
      raise exception 'IMPORT_INVALID: document % refers to a missing series', r ->> 'id' using errcode = 'P0001';
    end if;
    insert into public.documents (
      id, owner_id, idempotency_key, series_id, doc_type, status, number, issue_date, customer_id, lines, notes,
      payment_details, allocations, customer_snapshot, issuer_snapshot, subtotal_agorot, vat_rate_bp, vat_agorot,
      total_agorot, vat_status_at_issue, rule_set_version, corrects_document_id, correction_reason, issued_at, created_at)
    values (
      (m ->> (r ->> 'id'))::uuid, me, gen_random_uuid(), (m ->> (r ->> 'series_id'))::uuid,
      (r ->> 'doc_type')::public.doc_type,
      case when r ->> 'status' = 'cancelled' then 'issued' else r ->> 'status' end::public.doc_status,
      (r ->> 'number')::int, (r ->> 'issue_date')::date, (m ->> (r ->> 'customer_id'))::uuid,
      coalesce(r -> 'lines', '[]'), coalesce(r ->> 'notes', ''), coalesce(r -> 'payment_details', '{}'),
      case when r ->> 'status' = 'draft' then coalesce((select jsonb_agg(jsonb_build_object('invoice_id', m ->> (a ->> 'invoice_id'), 'amount_agorot', a -> 'amount_agorot'))
                                                       from jsonb_array_elements(coalesce(r -> 'allocations', '[]')) a where m ? (a ->> 'invoice_id')), '[]')
           else '[]' end,
      r -> 'customer_snapshot', r -> 'issuer_snapshot', (r ->> 'subtotal_agorot')::bigint, (r ->> 'vat_rate_bp')::int,
      (r ->> 'vat_agorot')::bigint, (r ->> 'total_agorot')::bigint, (r ->> 'vat_status_at_issue')::public.vat_status,
      r ->> 'rule_set_version', (m ->> (r ->> 'corrects_document_id'))::uuid, r ->> 'correction_reason',
      (r ->> 'issued_at')::timestamptz, coalesce((r ->> 'created_at')::timestamptz, now()));
    n_docs := n_docs + 1;
    if r ->> 'status' <> 'draft' then sum_docs := sum_docs + coalesce((r ->> 'total_agorot')::bigint, 0); end if;
  end loop;

  perform set_config('app.doc_mode', 'cancelling', true);
  for r in select x from jsonb_array_elements(coalesce(p -> 'documents', '[]')) x where x ->> 'status' = 'cancelled' loop
    update public.documents set status = 'cancelled', cancelled_at = coalesce((r ->> 'cancelled_at')::timestamptz, now()),
      cancelled_by_document_id = (m ->> (r ->> 'cancelled_by_document_id'))::uuid
    where id = (m ->> (r ->> 'id'))::uuid;
  end loop;
  perform set_config('app.doc_mode', '', true);

  for r in select * from jsonb_array_elements(coalesce(p -> 'allocations', '[]')) loop
    insert into public.payment_allocations (owner_id, receipt_id, invoice_id, amount_agorot)
    values (me, (m ->> (r ->> 'receipt_id'))::uuid, (m ->> (r ->> 'invoice_id'))::uuid, (r ->> 'amount_agorot')::bigint);
    n_alloc := n_alloc + 1;
  end loop;

  for r in select * from jsonb_array_elements(coalesce(p -> 'expenses', '[]')) loop
    nid := gen_random_uuid(); m := m || jsonb_build_object(r ->> 'id', nid);
    insert into public.expenses (id, owner_id, client_key, supplier, supplier_tax_id, doc_number, doc_date, amount_agorot, vat_agorot,
      category, business_use_pct, status, deductible_status, input_vat_status, notes, created_at)
    values (nid, me, gen_random_uuid(), r ->> 'supplier', coalesce(r ->> 'supplier_tax_id', ''), coalesce(r ->> 'doc_number', ''),
      (r ->> 'doc_date')::date, (r ->> 'amount_agorot')::bigint, coalesce((r ->> 'vat_agorot')::bigint, 0), coalesce(r ->> 'category', 'other'),
      coalesce((r ->> 'business_use_pct')::int, 100), coalesce(r ->> 'status', 'needs_review'),
      coalesce(r ->> 'deductible_status', 'undetermined'), coalesce(r ->> 'input_vat_status', 'undetermined'),
      coalesce(r ->> 'notes', ''), coalesce((r ->> 'created_at')::timestamptz, now()));
    n_exp := n_exp + 1;
  end loop;

  -- attachments: the files were already uploaded by the client to the caller's own folder
  for r in select * from jsonb_array_elements(coalesce(p -> 'attachments', '[]')) loop
    if (r ->> 'storage_path') not like me::text || '/%' then
      raise exception 'IMPORT_INVALID: attachment path outside the account folder' using errcode = 'P0001';
    end if;
    insert into public.expense_attachments (id, owner_id, expense_id, storage_path, sha256, mime_type, size_bytes, original_name, created_at)
    values ((r ->> 'id')::uuid, me, (m ->> (r ->> 'expense_id'))::uuid, r ->> 'storage_path', r ->> 'sha256', r ->> 'mime_type',
            (r ->> 'size_bytes')::bigint, coalesce(r ->> 'original_name', ''), coalesce((r ->> 'created_at')::timestamptz, now()));
    n_att := n_att + 1;
  end loop;

  if p_mode = 'restore' then
    for r in select * from jsonb_array_elements(coalesce(p -> 'submissions', '[]')) loop
      insert into public.submissions (owner_id, kind, tax_year, period, status, reference, submitted_on, payment_status, payment_reference, prepared_values, notes, created_at)
      values (me, r ->> 'kind', (r ->> 'tax_year')::int, coalesce(r ->> 'period', ''), r ->> 'status', coalesce(r ->> 'reference', ''),
              (r ->> 'submitted_on')::date, r ->> 'payment_status', coalesce(r ->> 'payment_reference', ''), coalesce(r -> 'prepared_values', '{}'),
              coalesce(r ->> 'notes', ''), coalesce((r ->> 'created_at')::timestamptz, now()));
      n_sub := n_sub + 1;
    end loop;
  end if;

  insert into public.audit_log (owner_id, action, entity, details)
  values (me, case p_mode when 'restore' then 'backup.restored' else 'legacy.imported' end, 'account',
          jsonb_build_object('customers', n_cust, 'series', n_series, 'documents', n_docs, 'allocations', n_alloc,
                             'expenses', n_exp, 'attachments', n_att, 'submissions', n_sub, 'documents_total_agorot', sum_docs,
                             'source_exported_at', p ->> 'exported_at'));
  return jsonb_build_object('customers', n_cust, 'series', n_series, 'documents', n_docs, 'allocations', n_alloc,
                            'expenses', n_exp, 'attachments', n_att, 'submissions', n_sub);
end $$;
revoke all on function public.import_records(jsonb, text) from public, anon;
grant execute on function public.import_records(jsonb, text) to authenticated;
revoke all on function app.block_output_changes() from public;

-- ───────────────────────── administration (secret key only) ─────────────────────────
-- Lets setup scripts that hold the project's SECRET key manage the allow-list through the API.
-- Never callable from the app: not by anon, not by signed-in users.
create or replace function public.admin_set_allowed(p_email text, p_allowed boolean)
returns void
language plpgsql security definer set search_path = app, pg_temp as $$
begin
  if p_allowed then
    insert into app.allowed_users (email) values (lower(trim(p_email))) on conflict do nothing;
  else
    delete from app.allowed_users where email = lower(trim(p_email));
  end if;
end $$;
revoke all on function public.admin_set_allowed(text, boolean) from public, anon, authenticated;
grant execute on function public.admin_set_allowed(text, boolean) to service_role;
