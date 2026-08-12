-- База контактов принадлежит кампании, а не порталу целиком.
--
-- Как было: у `tg_outreach_bases` есть только `user_id`, а связь с кампанией
-- живёт в `tg_outreach_campaign_bases` (many-to-many). Задумка была «одну базу
-- можно запустить на разных кампаниях и сравнить результат», но на практике это
-- дало три проблемы:
--
--   1. Вкладка «Базы» любой кампании показывала ВСЕ базы портала. Оператор
--      открывал свою кампанию и видел чужую базу на 2206 контактов со своими
--      счётчиками — выглядит как «чужое попало ко мне».
--   2. Одна галочка — и чужая база становится очередью этой кампании.
--   3. Счётчики нельзя разделить: у контакта нет кампании, статус один на всех.
--      Если базу подключить к двум кампаниям, они едят общий пул `pending`, и
--      чей это `sent` — уже не восстановить.
--
-- Как стало: у базы ровно одна кампания. Удалили кампанию — ушли её базы и
-- контакты (cascade). Переиспользование становится явным действием «скопировать
-- базу в другую кампанию», и у копии свои счётчики.
--
-- `tg_outreach_campaign_bases` остаётся, но меняет смысл: теперь это не «чья
-- база», а «участвует ли база в рассылке» — выключатель, которым базу можно
-- поставить на паузу, не удаляя. Воркер (`loadCampaignBaseIds`) читает её
-- по-прежнему, поэтому логика отправки не меняется.

alter table public.tg_outreach_bases
  add column if not exists campaign_id uuid
    references public.tg_outreach_campaigns(id) on delete cascade;

create index if not exists tg_outreach_bases_campaign_idx
  on public.tg_outreach_bases (campaign_id, created_at desc);

comment on column public.tg_outreach_bases.campaign_id is
  'Кампания-владелец. NULL — база, заведённая до этой миграции и ни разу не подключённая ни к одной кампании; такие показываются отдельным списком, пока оператор не перенесёт их руками.';

-- ---------------------------------------------------------------------------
-- Бэкфилл 1: база подключена ровно к одной кампании — она и владелец.
-- ---------------------------------------------------------------------------
update public.tg_outreach_bases b
set campaign_id = link.campaign_id
from (
  select base_id, min(campaign_id::text)::uuid as campaign_id
  from public.tg_outreach_campaign_bases
  group by base_id
  having count(*) = 1
) as link
where b.id = link.base_id
  and b.campaign_id is null;

-- ---------------------------------------------------------------------------
-- Бэкфилл 2: база подключена к нескольким кампаниям.
--
-- Оригинал достаётся самой ранней связи, остальным — независимые копии вместе
-- с контактами и их статусами. Копия, а не общий доступ: смысл миграции в том,
-- чтобы у каждой кампании были свои счётчики, а один общий пул `pending` этого
-- не даёт. Дублирование контактов безопасно — `unique (base_id, username)`
-- считается внутри базы.
-- ---------------------------------------------------------------------------
do $$
declare
  multi record;
  extra record;
  new_base_id uuid;
  owner_campaign uuid;
begin
  for multi in
    select base_id
    from public.tg_outreach_campaign_bases
    group by base_id
    having count(*) > 1
  loop
    -- Владельцем оригинала делаем кампанию, подключившую базу первой.
    select campaign_id into owner_campaign
    from public.tg_outreach_campaign_bases
    where base_id = multi.base_id
    order by created_at asc, campaign_id asc
    limit 1;

    update public.tg_outreach_bases
    set campaign_id = owner_campaign
    where id = multi.base_id and campaign_id is null;

    for extra in
      select campaign_id
      from public.tg_outreach_campaign_bases
      where base_id = multi.base_id and campaign_id <> owner_campaign
    loop
      insert into public.tg_outreach_bases (user_id, campaign_id, name, notes, created_at, updated_at)
      select b.user_id, extra.campaign_id, b.name, b.notes, b.created_at, now()
      from public.tg_outreach_bases b
      where b.id = multi.base_id
      returning id into new_base_id;

      insert into public.tg_outreach_base_contacts
        (base_id, username, message, raw, status, skip_reason, attempts, account_id, tg_user_id, sent_at, created_at, updated_at)
      select new_base_id, c.username, c.message, c.raw, c.status, c.skip_reason, c.attempts,
             c.account_id, c.tg_user_id, c.sent_at, c.created_at, now()
      from public.tg_outreach_base_contacts c
      where c.base_id = multi.base_id;

      -- Связь-выключатель переезжает на копию: кампания продолжает слать, но
      -- уже из своей базы.
      update public.tg_outreach_campaign_bases
      set base_id = new_base_id
      where base_id = multi.base_id and campaign_id = extra.campaign_id;
    end loop;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Чистка: связь, ведущая в чужую кампанию, после бэкфилла — мусор. Оставить её
-- значило бы, что кампания шлёт из базы, которой не владеет, а на экране этой
-- базы уже не увидит.
-- ---------------------------------------------------------------------------
delete from public.tg_outreach_campaign_bases link
using public.tg_outreach_bases b
where link.base_id = b.id
  and b.campaign_id is not null
  and b.campaign_id <> link.campaign_id;

-- `not null` намеренно НЕ ставим: базы, ни разу не подключённые к кампании,
-- остаются с NULL. Их создавала кнопка «Создать базу», которая кампанию не
-- спрашивала. Ставить им кампанию наугад — значит запустить чужие контакты в
-- чужой рассылке; вместо этого портал показывает их отдельным списком с
-- кнопкой «перенести в эту кампанию». Когда таких не останется, колонку можно
-- будет сделать not null отдельной миграцией.
