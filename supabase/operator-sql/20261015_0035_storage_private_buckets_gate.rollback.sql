-- ROLLBACK of 20261015_0035_storage_private_buckets_gate.sql. Run as postgres.
-- Restores today's bucket-wide access to briefs and knowledge-base for every signed-in
-- account, and drops the anon gate on the two buckets (the repo has no anon policy that
-- it would reopen; a hand-made one on prod would become active again).
-- Takes ACCESS EXCLUSIVE on storage.objects for a moment; each wait is capped at 3s.
-- Keep the 0035 row in public.portal_migrations.
begin;
set local lock_timeout = '3s';
drop policy if exists lockdown_private_buckets_anon_gate on storage.objects;
drop policy if exists lockdown_private_buckets_gate on storage.objects;
commit;
