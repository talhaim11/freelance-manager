-- Read-only check of grants, RLS and private storage (SELECT only; changes nothing).
-- Run in the Supabase SQL Editor after applying the migrations. Every row should say ✅.
with t(name) as (values ('business_profiles'),('vat_status_periods'),('customers'),('document_series'),('documents'),('audit_log'),
                        ('payment_allocations'),('expenses'),('expense_attachments'),
                        ('document_outputs'),('tax_profiles'),('submissions')),
checks(n, bad) as (
  select 1, (select count(*) from t join pg_class c on c.relname = t.name and c.relnamespace = 'public'::regnamespace where not c.relrowsecurity)
         + (12 - (select count(*) from t join pg_class c on c.relname = t.name and c.relnamespace = 'public'::regnamespace))
  union all select 2, (select count(*) from t where not exists (
      select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = t.name and 'authenticated' = any(p.roles)))
  union all select 3, (select count(*) from information_schema.role_table_grants where table_schema = 'public' and grantee = 'anon'
                         and table_name in (select name from t union all select 'invoice_balances'))
                    + (select count(*) from information_schema.column_privileges where table_schema = 'public' and grantee = 'anon'
                         and table_name in (select name from t))
  union all select 4, (select count(*) from t, unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) p
                       where has_table_privilege('authenticated', 'public.' || t.name, p) <> (p = any(case t.name
                         when 'business_profiles' then array['SELECT','INSERT','UPDATE']
                         when 'vat_status_periods' then array['SELECT','INSERT','UPDATE','DELETE']
                         when 'customers' then array['SELECT','INSERT','UPDATE']
                         when 'document_series' then array['SELECT','INSERT']
                         when 'documents' then array['SELECT','DELETE']
                         when 'expenses' then array['SELECT']
                         else array['SELECT'] end)))
  union all select 5, (select count(*) from unnest(array['status','number','owner_id','issued_at','total_agorot']) col
                       where has_column_privilege('authenticated', 'public.documents', col, 'UPDATE')
                          or has_column_privilege('authenticated', 'public.documents', col, 'INSERT'))
                    + (case when has_column_privilege('authenticated', 'public.documents', 'lines', 'UPDATE') then 0 else 1 end)
                    + (select count(*) from unnest(array['owner_id','deductible_status','input_vat_status']) col
                       where has_column_privilege('authenticated', 'public.expenses', col, 'UPDATE')
                          or has_column_privilege('authenticated', 'public.expenses', col, 'INSERT'))
  union all select 6, (select count(*) from unnest(array['public.issue_document(uuid)','public.cancel_document(uuid,text,uuid)','public.am_i_allowed()',
                                     'public.register_document_output(uuid,text,text)','public.import_records(jsonb,text)']) f
                       where has_function_privilege('anon', f, 'execute') or not has_function_privilege('authenticated', f, 'execute'))
  union all select 7, (case when has_schema_privilege('anon', 'app', 'usage') then 1 else 0 end)
                    + (case when has_table_privilege('authenticated', 'app.allowed_users', 'select') then 1 else 0 end)
                    + (case when has_table_privilege('anon', 'app.allowed_users', 'select') then 1 else 0 end)
  union all select 8, (case when has_table_privilege('authenticated', 'public.invoice_balances', 'select') then 0 else 1 end)
                    + (select count(*) from pg_class c where c.oid = 'public.invoice_balances'::regclass
                         and not coalesce(c.reloptions @> array['security_invoker=true'], false))
  union all select 9, (select count(*) from unnest(array['payment_allocations','expense_attachments']) x
                       where has_table_privilege('authenticated', 'public.' || x, 'UPDATE') or has_table_privilege('authenticated', 'public.' || x, 'DELETE'))
                    + (select count(*) from pg_trigger where tgrelid in ('public.payment_allocations'::regclass, 'public.expense_attachments'::regclass)
                         and tgname in ('payment_allocations_immutable', 'expense_attachments_immutable')) * -1 + 2
  union all select 10, (select case when count(*) = 1 and bool_and(not public) then 0 else 1 end from storage.buckets where id = 'expense-files')
                     + (2 - (select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects'
                              and policyname in ('expense_files_read', 'expense_files_insert')
                              and coalesce(qual, with_check) like '%foldername%' and coalesce(qual, with_check) like '%is_allowed%'))
                     + (select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects'
                          and (qual like '%expense-files%' or with_check like '%expense-files%') and cmd in ('UPDATE', 'DELETE', 'ALL'))
  union all select 11, (case when has_function_privilege('anon', 'public.admin_set_allowed(text,boolean)', 'execute')
                               or has_function_privilege('authenticated', 'public.admin_set_allowed(text,boolean)', 'execute') then 1 else 0 end)
                     + (select count(*) from unnest(array['tax_profiles','submissions','document_outputs']) x
                        where has_column_privilege('authenticated', 'public.' || x, 'owner_id', 'INSERT')
                           or has_column_privilege('authenticated', 'public.' || x, 'owner_id', 'UPDATE'))
                     + (case when has_table_privilege('authenticated', 'public.document_outputs', 'INSERT')
                               or has_column_privilege('authenticated', 'public.document_outputs', 'sha256', 'UPDATE') then 1 else 0 end)
)
select n as "#", case n
  when 1 then 'RLS פעיל על 12 הטבלאות'
  when 2 then 'מדיניות גישה לבעלים בכל טבלה'
  when 3 then 'למשתמש לא מחובר אין גישה לטבלאות'
  when 4 then 'משתמש מחובר: רק ההרשאות הנדרשות'
  when 5 then 'אי אפשר לקבוע מספר/סטטוס/סכום או טיפול מס ידנית'
  when 6 then 'פונקציות הפקה/ביטול: רק למחוברים'
  when 7 then 'רשימת המורשים חסויה'
  when 8 then 'יתרות חשבוניות: לפי הרשאות המשתמש בלבד'
  when 9 then 'שיוכי תשלום וקבצים מצורפים: לא ניתנים לשינוי'
  when 10 then 'אחסון הקבצים פרטי, לפי תיקיית המשתמש, בלי מחיקה/דריסה'
  else 'ניהול מורשים רק לשרת; טביעות PDF ובעלות לא ניתנות לשינוי' end as "בדיקה",
  case when bad = 0 then 'תקין ✅' else 'בעיה ❌ (' || bad || ')' end as "תוצאה"
from checks order by n;
