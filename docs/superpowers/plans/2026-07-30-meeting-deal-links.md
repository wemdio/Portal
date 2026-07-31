# Привязка записей встреч к сделкам — план

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Считать встречи на дашборде первички по записям разговоров, а не по этапу AMO.

**Architecture:** Сырьё (`tg_video_transcripts`) остаётся нетронутым; привязка живёт в отдельной таблице `meeting_deal_links`. Автоматчер — SQL-функция, вызываемая после синка; ручная привязка им не перезаписывается. Метрика «Встречи» переключается на привязки.

**Tech Stack:** Postgres, TypeScript (Next.js), Jest.

---

## Зачем

Егор считает встречу так: есть запись разговора в телеграм-чате. Метрика по этапу AMO даёт 200+ в месяц против его 64 — этап засорён.

Проверка на боевых данных (2026-07-30):

| Что | Число |
|---|---|
| Записей с подписью в чате встреч за 2026 | 400 |
| Из них привязались автоматом (домен + название) | 222 (56%) |
| Июль: записей / привязалось | 100 / 72 |
| Июль у Егора | 64 встречи |

72 против 64 — сходится в пределах повторных записей одной встречи.

**Два факта, которые определяют дизайн:**

1. **Одна запись матчится на несколько сделок.** За июль 72 записи дали 78 пар (сделка, дата) — подписи вроде `laserstyle` цепляют несколько компаний. Без явного разрешения неоднозначности метрика будет тихо задваивать.

2. **Одна встреча разрезана на несколько файлов.** В выборке `denvic.tech` дважды за один день, файлы `1.mp4` и `2.mp4`. Считать записи нельзя — только пары (сделка, дата).

**Глубина:** подписи стали регулярными с мая 2026. Март — 18 привязок, апрель — 6, июнь — 72, июль — 72. За более ранние периоды метрика показывает прочерк, а не ноль — тот же принцип, что для договоров.

**Чат:** записи встреч лежат в `tg_chat_id = -1001852890744`. Второй чат (`-1002179160904`) — внутренние созвоны, в метрику не входит.

---

## Структура файлов

| Файл | Ответственность |
|---|---|
| `supabase/migrations/20260731_0001_meeting_deal_links.sql` | Таблица привязок, функция автоматчинга, индексы, RLS, гранты |
| `app/src/lib/firstSales/meetings.ts` | Чтение привязок, подсчёт встреч по окну |
| `app/src/lib/firstSales/metrics.ts` | Переключение метрики «Встречи» на привязки |
| `app/src/app/api/analytics/first-sales/meeting-links/route.ts` | GET очередь непривязанных, PUT ручная привязка |
| `app/src/components/first-sales/MeetingLinksEditor.tsx` | Экран доразметки |

---

## Task 1: Миграция — таблица привязок и автоматчер

**Files:**
- Create: `supabase/migrations/20260731_0001_meeting_deal_links.sql`
- Test: `app/tests/migrations/meetingDealLinks.test.ts`

- [ ] **Step 1: Написать падающий тест схемы**

```typescript
// app/tests/migrations/meetingDealLinks.test.ts
import fs from 'fs';
import path from 'path';

const SQL = fs.readFileSync(
  path.resolve(__dirname, '../../../supabase/migrations/20260731_0001_meeting_deal_links.sql'),
  'utf8',
);

describe('миграция привязки записей встреч к сделкам', () => {
  it('создаёт таблицу привязок', () => {
    expect(SQL).toMatch(/create table if not exists public\.meeting_deal_links/);
  });

  it('одна запись — одна сделка', () => {
    // Без этого одна запись матчится на несколько компаний с похожими
    // названиями, и встречи тихо задваиваются: за июль 72 записи давали
    // 78 пар (сделка, дата).
    expect(SQL).toMatch(/unique[\s\S]{0,80}transcript_id/);
  });

  it('ручную привязку автоматчер не перезаписывает', () => {
    expect(SQL).toMatch(/where[\s\S]{0,120}method\s*(<>|!=)\s*'manual'/i);
  });

  it('ограничивает способ привязки списком', () => {
    for (const m of ['domain', 'name', 'manual']) expect(SQL).toContain(`'${m}'`);
  });

  it('выдаёт гранты service_role', () => {
    expect(SQL).toMatch(/grant all on public\.meeting_deal_links\s+to service_role/);
  });

  it('включает RLS без select-политики для authenticated', () => {
    expect(SQL).toMatch(/alter table public\.meeting_deal_links\s+enable row level security/);
    expect(SQL).not.toMatch(/create policy .* on public\.meeting_deal_links for select/);
  });
});
```

- [ ] **Step 2: Прогнать — должен упасть на отсутствии файла**

```bash
cd app && npm test -- tests/migrations/meetingDealLinks.test.ts
```

- [ ] **Step 3: Написать миграцию**

```sql
-- supabase/migrations/20260731_0001_meeting_deal_links.sql
-- Привязка записей встреч (tg_video_transcripts) к сделкам AMO.
-- Зачем: Егор считает встречей наличие записи разговора, а этап AMO
-- «Встреча проведена» засорён — 200+ в месяц против его 64.

create table if not exists public.meeting_deal_links (
  id            bigserial primary key,
  transcript_id uuid   not null references public.tg_video_transcripts(id) on delete cascade,
  amo_deal_id   bigint not null,
  method        text   not null check (method in ('domain','name','manual')),
  matched_at    timestamptz not null default now(),
  matched_by    uuid references public.profiles(id) on delete set null
);

-- Одна запись — ровно одна сделка. Без этого подписи вроде «laserstyle»
-- цепляют несколько компаний, и встречи задваиваются: за июль 2026
-- 72 записи давали 78 пар (сделка, дата).
create unique index if not exists uq_meeting_deal_links_transcript
  on public.meeting_deal_links(transcript_id);

create index if not exists idx_meeting_deal_links_deal
  on public.meeting_deal_links(amo_deal_id);

comment on table public.meeting_deal_links is
  'Запись разговора → сделка AMO. Автоматчинг по домену и названию компании, хвост размечается руками на /analytics/first-sales. method=manual никогда не перезаписывается автоматчером.';

-- ─── Автоматчер ──────────────────────────────────────────────────────────

-- Нормализация домена: снять протокол, www и путь.
create or replace function public.fsd_norm_domain(v text)
returns text language sql immutable as $$
  select lower(split_part(regexp_replace(btrim(coalesce(v,'')), '^(https?://)?(www\.)?', '', 'i'), '/', 1))
$$;

create or replace function public.apply_meeting_deal_links()
returns integer language plpgsql as $$
declare
  affected integer;
begin
  with tr as (
    select t.id,
           lower(btrim(t.caption)) as cap,
           public.fsd_norm_domain(t.caption) as dom
    from public.tg_video_transcripts t
    where t.tg_chat_id = -1001852890744          -- чат встреч; второй чат внутренний
      and coalesce(t.caption, '') <> ''
  ),
  site as (
    select l.amo_id,
           public.fsd_norm_domain(coalesce(nullif(f->'values'->0->>'value',''), l.company_website)) as dom,
           lower(btrim(l.company_name)) as cname
    from public.amo_leads l
    left join lateral jsonb_array_elements(
        case when jsonb_typeof(l.raw->'custom_fields_values') = 'array'
             then l.raw->'custom_fields_values' else '[]'::jsonb end) f
      on f->>'field_name' = 'Сайт'
    where l.pipeline_id = 7670334
  ),
  cand as (
    select tr.id as transcript_id, s.amo_id,
           -- Домен надёжнее названия: сайт уникален, название — нет.
           case when s.dom <> '' and length(s.dom) > 4
                     and (s.dom = tr.dom or split_part(s.dom,'.',1) = tr.cap)
                then 'domain' else 'name' end as method
    from tr join site s
      on (s.dom <> '' and length(s.dom) > 4 and (s.dom = tr.dom or split_part(s.dom,'.',1) = tr.cap))
      or (s.cname <> '' and length(s.cname) > 3 and tr.cap like '%' || s.cname || '%')
  ),
  ranked as (
    select transcript_id, amo_id, method,
           row_number() over (
             partition by transcript_id
             order by case method when 'domain' then 0 else 1 end, amo_id
           ) as rn,
           count(*) over (partition by transcript_id) as n
    from cand
  )
  -- Берём только однозначные: если запись зацепила несколько сделок по слабому
  -- признаку (название), автомат не выбирает за человека — строка остаётся в
  -- очереди ручной разметки. Молчаливый выбор «первой попавшейся» дал бы
  -- цифру, которую невозможно проверить.
  insert into public.meeting_deal_links (transcript_id, amo_deal_id, method)
  select transcript_id, amo_id, method
  from ranked
  where rn = 1 and (method = 'domain' or n = 1)
  on conflict (transcript_id) do update
    set amo_deal_id = excluded.amo_deal_id,
        method      = excluded.method,
        matched_at  = now()
    where meeting_deal_links.method <> 'manual';

  get diagnostics affected = row_count;
  return affected;
end $$;

comment on function public.apply_meeting_deal_links() is
  'Автопривязка записей к сделкам. Домен сильнее названия; неоднозначные по названию оставляет человеку. Ручные привязки не трогает.';

-- ─── RLS и гранты ────────────────────────────────────────────────────────

alter table public.meeting_deal_links enable row level security;

grant all on public.meeting_deal_links to service_role, postgres;
grant usage, select on sequence public.meeting_deal_links_id_seq to service_role, postgres;
grant execute on function public.apply_meeting_deal_links() to service_role, postgres;
grant execute on function public.fsd_norm_domain(text) to service_role, postgres;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'readonly') then
    execute 'grant select on public.meeting_deal_links to readonly';
  end if;
end $$;
```

- [ ] **Step 4: Прогнать тесты**

```bash
cd app && npm test -- tests/migrations
```

Ожидаемо: всё зелёное, включая `grants.test.ts`.

- [ ] **Step 5: Закоммитить**

```bash
git add supabase/migrations/20260731_0001_meeting_deal_links.sql app/tests/migrations/meetingDealLinks.test.ts
git commit -m "feat(first-sales): таблица привязки записей встреч к сделкам"
```

---

## Task 2: Метрика встреч по привязкам

**Files:**
- Create: `app/src/lib/firstSales/meetings.ts`
- Modify: `app/src/lib/firstSales/metrics.ts`
- Test: `app/tests/lib/firstSales/meetings.test.ts`

Правила, которые надо реализовать и покрыть тестами:

1. **Встреча = пара (сделка, дата записи).** Одна встреча часто разрезана на несколько файлов — за один день у одной сделки может быть `1.mp4` и `2.mp4`, это одна встреча. Считать записи нельзя.
2. **Дата — по МСК**, через `bucketKey` из `buckets.ts`.
3. **Канал берётся у сделки**, не у записи — фильтр по каналам должен работать.
4. **Достоверность с 2026-05-01**: раньше подписи ставили нерегулярно (март 18 привязок, апрель 6, июнь 72). За более ранние окна `meetingsReliable = false`, UI показывает прочерк, а не ноль — тот же принцип, что для договоров (`CONTRACT_RULE_SINCE`).
5. Старая метрика по этапу AMO **удаляется**, а не остаётся рядом: две цифры «встреч» под одним названием — гарантированный спор о том, какая правильная.

Дата вынести в `MEETINGS_RELIABLE_SINCE` с переопределением через окружение.

---

## Task 3: Экран доразметки

**Files:**
- Create: `app/src/app/api/analytics/first-sales/meeting-links/route.ts`
- Create: `app/src/components/first-sales/MeetingLinksEditor.tsx`
- Modify: `app/src/components/first-sales/FirstSalesView.tsx`

- GET отдаёт непривязанные записи чата встреч за период: дата, подпись, имя файла, начало расшифровки — чтобы человек понял, о ком речь, не открывая видео.
- PUT привязывает запись к сделке с `method='manual'`.
- Поиск сделки по названию компании и сайту.
- Кнопка «не встреча» — чтобы внутренние созвоны убирались из очереди навсегда, а не всплывали каждый раз. Нужна отдельная пометка, иначе очередь не разгребается никогда.
- Экран рядом со справочником источников, тем же переключателем.

---

## Проверка на боевых данных

После деплоя и первого прогона автоматчера:

- за июль привязок ожидается около 72, встреч после дедупа — около 78;
- у Егора за июль 64 — расхождение должно объясняться повторными записями и сделками из других воронок, а не чем-то третьим;
- очередь ручной разметки за июль — порядка 28 записей.

Если привязок сильно меньше — смотреть, не отвалилась ли нормализация домена.

---

## Что остаётся за рамками

- Записи без подписи (около 10%) — привязать нечем, только руками.
- Второй чат (внутренние созвоны) — в метрику не входит вообще.
- Автопривязка по тексту расшифровки (упоминание компании в разговоре) — возможна, но это уже LLM и отдельная стоимость.
