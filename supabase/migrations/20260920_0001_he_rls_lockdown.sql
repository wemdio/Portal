-- Hypothesis Engine (he_*): закрыть таблицы от роли `authenticated`.
--
-- ЧТО ТЕЧЁТ. `20260724_0001_create_hypothesis_engine.sql:240-249` и
-- `20260728_0001_hypothesis_engine_dossier_cases.sql:70-82` вешают на 10 таблиц
-- политику `%I_select_auth ... for select using (auth.uid() is not null)` — без
-- `to`-роли, то есть для PUBLIC. Табличный грант при этом выдан молча:
-- `20260509_0003_public_default_privileges_for_postgres.sql:52-68` объявляет
-- `alter default privileges for role postgres ... grant select, insert, update,
-- delete on tables to authenticated` (и `select` для `anon`), а миграции гоняет
-- `app/scripts/db/ensureDatabase.js` именно под `postgres` — he_* созданы 24.07,
-- то есть ПОСЛЕ 09.05, и права унаследовали.
--
-- Эксплуатируется ровно одна роль — `authenticated`. У `anon` `auth.uid()` равен
-- null, предикат политики ложен, и грант ему ничего не даёт: отзываем его не
-- потому, что он течёт сегодня, а чтобы завтрашняя permissive-политика не
-- зарядила уже выданный пистолет. INSERT/UPDATE/DELETE у `authenticated` тоже
-- пожалованы, но политик на запись нет — RLS их режет, течёт только чтение.
--
-- Почему это про клиента, а не про своих: `20260730_0001_harden_team_data_acl.sql:27-30`
-- фиксирует, что прямой GoTrue-signup включён в проде, а PostgREST проброшен на
-- клиентский домен (`deploy/nginx/app.outreachos.xyz.conf`). Значит любой
-- самозарегистрировавшийся человек из devtools делал `GET /rest/v1/he_bases` и
-- получал чужие строки лидов, брифы (`he_projects.brief`) и тексты писем
-- (`he_chains`, `he_templates`).
--
-- ОБРАЗЕЦ. В vertical_engine_v2 копировать нечего: там нет ни одного `revoke`,
-- ve_* закрыты тем, что политик для `authenticated` просто не создавали (RLS без
-- политик = ноль строк). Поимённый отзыв в этом дереве делают
-- `20260818_0002_payment_request_control.sql:948-962` и
-- `20260730_0001_harden_team_data_acl.sql:9-10` — форма взята оттуда.
--
-- ЧТО НЕ ЛОМАЕТСЯ. Приложение и воркеры ходят в he_* только под service_role
-- (`supabaseAdmin`); браузерных чтений he_* нет. Realtime-подписка на `he_jobs`
-- (`20260730_0004`) — это воркер под service_role, RLS он обходит; браузеру этот
-- канал закрывается тем же движением, и это желаемый исход. Роль `readonly`
-- (диагностика, portal-db MCP) сохраняется явно.
--
-- Гранты `service_role`/`postgres` продублированы НИЖЕ отзыва намеренно: если на
-- инсталляции они где-то наследовали право от PUBLIC, отзыв у PUBLIC срезал бы
-- его вместе с дырой — и это был бы полный простой ENG (`permission denied for
-- table he_projects` в кабинете и застрявшие джобы в воркере). Явный grant после
-- revoke делает исход независимым от того, откуда право пришло раньше.
--
-- Миграция идемпотентна: `drop policy if exists` + `revoke`/`grant` можно гонять
-- повторно. lock_timeout не ставим — раннер уже держит его на сессии
-- (`ensureDatabase.js:304-317`, 30с) и ретраит 55P03.

-- ─── 1. Снять политики «любой залогиненный читает всё» ───────────────────
-- Имена — те, что собирал `format('%I_select_auth', tbl)` в миграциях-создателях.
-- 10 политик на 10 таблицах; у he_auto_pipeline_* политик не было никогда
-- (`20260804_0005:64-65` — только enable RLS), поэтому их здесь нет.

drop policy if exists he_projects_select_auth          on public.he_projects;
drop policy if exists he_jobs_select_auth              on public.he_jobs;
drop policy if exists he_hypotheses_select_auth        on public.he_hypotheses;
drop policy if exists he_verticals_select_auth         on public.he_verticals;
drop policy if exists he_chains_select_auth            on public.he_chains;
drop policy if exists he_vocab_select_auth             on public.he_vocab;
drop policy if exists he_bases_select_auth             on public.he_bases;
drop policy if exists he_templates_select_auth         on public.he_templates;
drop policy if exists he_vertical_dossiers_select_auth on public.he_vertical_dossiers;
drop policy if exists he_cases_select_auth             on public.he_cases;

-- ─── 2. Отозвать унаследованные гранты поимённо ──────────────────────────
-- Оптовый `revoke ... from public` роли `anon`/`authenticated` НЕ покрывает:
-- права им выданы прямым грантом из default privileges, а не через PUBLIC.
-- Поэтому все три адресата названы явно. `service_role`, `postgres` и
-- `readonly` в списке отсутствуют сознательно — см. шапку и пункт 3.

revoke all privileges on table public.he_projects            from public, anon, authenticated;
revoke all privileges on table public.he_jobs                from public, anon, authenticated;
revoke all privileges on table public.he_hypotheses          from public, anon, authenticated;
revoke all privileges on table public.he_verticals           from public, anon, authenticated;
revoke all privileges on table public.he_chains              from public, anon, authenticated;
revoke all privileges on table public.he_vocab               from public, anon, authenticated;
revoke all privileges on table public.he_bases               from public, anon, authenticated;
revoke all privileges on table public.he_templates           from public, anon, authenticated;
revoke all privileges on table public.he_vertical_dossiers   from public, anon, authenticated;
revoke all privileges on table public.he_cases               from public, anon, authenticated;
revoke all privileges on table public.he_auto_pipeline_configs from public, anon, authenticated;
revoke all privileges on table public.he_auto_pipeline_runs    from public, anon, authenticated;

-- ─── 3. Пере-подтвердить рабочие роли ────────────────────────────────────
-- service_role — весь ENG (кабинет /client/eng, staff-инструмент, воркеры);
-- postgres — раннер миграций. Потерять их = уронить продукт, поэтому не
-- полагаемся на то, что права уцелели, а выдаём заново.

grant all on table public.he_projects              to service_role, postgres;
grant all on table public.he_jobs                  to service_role, postgres;
grant all on table public.he_hypotheses            to service_role, postgres;
grant all on table public.he_verticals             to service_role, postgres;
grant all on table public.he_chains                to service_role, postgres;
grant all on table public.he_vocab                 to service_role, postgres;
grant all on table public.he_bases                 to service_role, postgres;
grant all on table public.he_templates             to service_role, postgres;
grant all on table public.he_vertical_dossiers     to service_role, postgres;
grant all on table public.he_cases                 to service_role, postgres;
grant all on table public.he_auto_pipeline_configs to service_role, postgres;
grant all on table public.he_auto_pipeline_runs    to service_role, postgres;

-- readonly — диагностика и portal-db MCP (docs/portal-db-mcp-guide.md). Роль
-- заводится не на всех инсталляциях, поэтому под тем же гардом, что и в
-- миграциях-создателях he_*.
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'readonly') then
    execute 'grant select on public.he_projects, public.he_jobs, public.he_hypotheses, public.he_verticals, public.he_chains, public.he_vocab, public.he_bases, public.he_templates to readonly';
    execute 'grant select on public.he_vertical_dossiers, public.he_cases to readonly';
    execute 'grant select on public.he_auto_pipeline_configs, public.he_auto_pipeline_runs to readonly';
  end if;
end $$;
