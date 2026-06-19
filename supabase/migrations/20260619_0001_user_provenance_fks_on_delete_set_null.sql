-- Make user deletion work from the admin UI.
--
-- Five "provenance" FKs on auth.users were ON DELETE NO ACTION, so deleting a
-- user who had created an AI campaign / lead import / tg-pool entry was blocked
-- (GoTrue deleteUser -> "Database error deleting user", admin UI 500 — required
-- a manual cleanup each time). The columns are all NULLABLE, so the correct
-- behavior is ON DELETE SET NULL: when the creator is deleted the row STAYS
-- (the campaign / import / pool entry is operational data, not the user's
-- personal data) and only loses the created_by/imported_by provenance link.
--
-- Postgres can't change a FK's ON DELETE action in place, so we drop + recreate
-- each constraint identically except for the ON DELETE clause. Idempotent: only
-- a constraint that isn't already SET NULL ('n') is touched, so re-running (e.g.
-- on the next deploy) is a no-op. All five tables are tiny, so the brief
-- ACCESS EXCLUSIVE lock during recreate is negligible.

do $$
declare
  r record;
begin
  for r in
    select * from (values
      ('ai_campaigns',           'ai_campaigns_created_by_fkey',            'created_by'),
      ('instantly_lead_imports', 'instantly_lead_imports_imported_by_fkey', 'imported_by'),
      ('tg_pool_accounts',       'tg_pool_accounts_created_by_fkey',        'created_by'),
      ('tg_pool_proxies',        'tg_pool_proxies_created_by_fkey',         'created_by'),
      ('tg_pool_tags',           'tg_pool_tags_created_by_fkey',            'created_by')
    ) as t(tbl, con, col)
  loop
    if exists (
      select 1
      from pg_constraint c
      join pg_class cl on cl.oid = c.conrelid
      join pg_namespace n on n.oid = cl.relnamespace
      where n.nspname = 'public' and cl.relname = r.tbl
        and c.conname = r.con and c.contype = 'f' and c.confdeltype <> 'n'
    ) then
      execute format('alter table public.%I drop constraint %I', r.tbl, r.con);
      execute format(
        'alter table public.%I add constraint %I foreign key (%I) references auth.users(id) on delete set null',
        r.tbl, r.con, r.col
      );
      raise notice 'FK %.% (%) -> ON DELETE SET NULL', r.tbl, r.col, r.con;
    end if;
  end loop;
end $$;
