-- ENG («Движок вертикалей», he_*): ПЕРЕНОС НЕОТПРАВЛЕННЫХ КОМПАНИЙ ночного
-- добора на следующие ночи (решение владельца 04.10.2026: «неотправленные
-- компании не выбрасывать»).
--
-- ЗАЧЕМ. Ночной добор готовит не меньше ста компаний (поиск, гейт
-- релевантности — платный вызов модели, краул сайта и SMTP-проба — свой
-- скрейпер), а отправляет не больше дневного капа проекта (по умолчанию 50
-- адресов). Компании, которым письма не досталось, оставались в 'analyzed'-базе
-- ночи, а исключение будущих сборок проекта (loadOtherBaseExclusionKeys,
-- stages/baseCollect.ts) видит КАЖДУЮ компанию не-'failed' базы — то есть они
-- терялись навсегда вместе с оплаченной подготовкой.
--
-- ЧТО ЗДЕСЬ ЛЕЖИТ. Строка на КОМПАНИЮ, готовую к отправке и не получившую
-- письма: её допущенные строки базы (адреса с вердиктом валидации) и колонки
-- для маппинга в лиды. Следующая ночь вертикали предлагает их ПЕРВЫМИ, раньше
-- новых компаний, и не покупает новую сборку, пока перенесённых хватает на
-- остаток дня (lib/hypothesisEngine/stages/baseCollectRefill.ts,
-- autoPipeline.ts). Кладут три исхода ночи: успешная ('appended'), отказ после
-- частичной доставки и ночь, которой дневной бюджет не дал ни строки
-- ('cap_exhausted'); у последней база остаётся 'analyzed' только если эта
-- запись легла (одним запросом), иначе — прежний возврат в пул.
--
-- ПОЧЕМУ ОТДЕЛЬНАЯ ТАБЛИЦА. Состояние, которое должно пережить ночь, не может
-- жить в строке ночи: каждая ночь заводит НОВУЮ he_bases-строку, а базу
-- прошлой ночи никто уже не читает. Компания при этом остаётся в `data` своей
-- базы (source_base_id) — именно это держит её исключённой из новых сборок,
-- пока она ждёт отправки, и второй подготовки той же компании не бывает.
--
-- СОСТОЯНИЯ (status) — весь набор:
--   'pending'  — ждёт отправки; ни один адрес компании до провайдера не дошёл;
--   'claimed'  — её взяла на отправку ночь claimed_base_id;
--   'sent'     — хотя бы один адрес отдан провайдеру (принят или мог быть);
--   'released' — срок вышел ('pending' старше expires_at): компания больше не
--                предлагается и перестаёт исключаться — следующая сборка
--                может подготовить её заново (адреса и вакансия к этому времени
--                устарели). Такой же считается 'pending' с прошедшим
--                expires_at, пока его никто не перевёл. Сразу 'released'
--                пишется и компания, чей крючок найма не доживёт до отправки
--                свежим (settle_reason 'hiring_post_age_unknown' /
--                'hiring_post_stale', см. СРОК);
--   'dropped'  — больше не предлагается и ОСТАЁТСЯ исключённой (settle_reason):
--                'no_sendable_address' — все адреса сняты чёрным списком;
--                'source_base_released' — база-источник ушла в 'failed';
--                'prepared_elsewhere' — ту же компанию подготовила параллельная
--                база проекта, и письмо достаётся её копии;
--                'fate_unknown' / 'claim_abandoned' — судьба неизвестна (ночь,
--                взявшая её, умерла до записи итога, или бронь держал прошлый
--                прогон той же базы). Сомнение решается в сторону «второго
--                письма не будет», как и у брони дня. Первые три причины —
--                «письмом не уходила», последние две — «могла уйти».
--
-- СРОК — 7 суток от подготовки (expires_at = prepared_at + 7 дней, константа
-- HE_REFILL_CARRYOVER_MAX_AGE_DAYS). У компании с крючком найма (непустая
-- vacancy_title) — не позже, чем фид последний раз видел её вакансию, плюс
-- окно свежести ENG_HIRING_FEED_FRESH_DAYS (14 суток; решение владельца
-- 04.10.2026: вакансия в письме не старше окна). Даты у такой строки нет —
-- компания не ждёт, а сразу 'released'. В норме очередь пустеет за 1–2 ночи
-- (у проекта с тремя вертикалями — до 5); дольше она живёт, только когда
-- отправка стоит (пауза по ёмкости, кампания снята, сбои подряд).
--
-- ПОРЯДОК ВЫКАТА: миграция ДО кода, но код без неё не ломается — каждое
-- чтение и запись этой таблицы best-effort и при ошибке ведёт себя как до
-- переноса (компании ночи остаются исключёнными, как раньше).
--
-- МИГРАЦИЯ НЕ ПРИМЕНЕНА.

create table if not exists public.he_refill_carryover (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.he_projects(id) on delete cascade,
  vertical_id     uuid not null references public.he_verticals(id) on delete cascade,
  -- База, в `data` которой компания лежит и через которую исключена из новых
  -- сборок. Удалили базу — компания снова в пуле, и строка переноса уходит
  -- вместе с ней (иначе компанию могли бы подготовить заново И отправить
  -- отсюда).
  source_base_id  uuid not null references public.he_bases(id) on delete cascade,
  -- Ключ компании — тот же, по которому отрез дневного капа решает «у компании
  -- нет письма» (launchHandoff.heLaunchCompanyKey: компания + сайт).
  company_key     text not null check (company_key <> ''),
  -- Допущенные строки компании (с _email_status) в формате he_bases.data.
  lead_rows       jsonb not null check (jsonb_typeof(lead_rows) = 'array'),
  -- Колонки базы-источника — для маппинга строк в лиды.
  lead_columns    jsonb not null check (jsonb_typeof(lead_columns) = 'array'),
  prepared_at     timestamptz not null,
  expires_at      timestamptz not null,
  status          text not null default 'pending'
    check (status in ('pending', 'claimed', 'sent', 'released', 'dropped')),
  -- Снимок идентификатора без внешнего ключа (как base_id у броней дня):
  -- удаление ночной базы не должно стирать след того, кто взял компанию.
  claimed_base_id uuid,
  claimed_at      timestamptz,
  settled_at      timestamptz,
  settle_reason   text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (source_base_id, company_key)
);

create index if not exists idx_he_refill_carryover_vertical_status
  on public.he_refill_carryover(vertical_id, status, prepared_at);
create index if not exists idx_he_refill_carryover_project_status
  on public.he_refill_carryover(project_id, status);

comment on table public.he_refill_carryover is
  'ENG: компании ночного добора, подготовленные и не получившие письма. Следующая ночь вертикали предлагает их первыми; срок 7 суток от подготовки, у крючка найма — не позже показа вакансии фидом + 14 суток.';
comment on column public.he_refill_carryover.status is
  'pending — ждёт; claimed — взята ночью claimed_base_id; sent — адрес отдан провайдеру; released — срок вышел (или крючок найма не доживёт свежим), компания снова в пуле; dropped — не предлагается и остаётся исключённой (причина в settle_reason).';

-- ─── Права ───────────────────────────────────────────────────────────────
-- Движковые таблицы браузер напрямую не читает — только воркер и крон под
-- service_role (20260920_0001_he_rls_lockdown.sql, линт
-- app/tests/migrations/grants.test.ts).

alter table public.he_refill_carryover enable row level security;

revoke all privileges on table public.he_refill_carryover from public, anon, authenticated;
grant all on table public.he_refill_carryover to service_role, postgres;

do $$ begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'readonly') then
    execute 'grant select on public.he_refill_carryover to readonly';
  end if;
end $$;
