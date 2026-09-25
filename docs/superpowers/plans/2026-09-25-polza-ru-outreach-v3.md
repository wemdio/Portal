# «Наш автоаутрич» v3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Экран русского автоаутрича с шагами как у английского, спорные/очень спорные компании, пять новых источников поводов, ползунки порогов, конкурентный выбор оффера, лимит 500.

**Architecture:** Всё внутри существующего конвейера `app/src/lib/polzaRuOutreach/` (раннер в воркере `worker-polza-outreach`). Новые источники — отдельные модули в `sources/`, признаки сомнения — `doubts.ts`, выбор оффера — переписанный `routeChain` в `router.ts`. Схема — одна миграция. UI — общий компонент шагов, вынесенный из английского аутрича.

**Tech Stack:** Next.js 16 / React, TypeScript, Supabase (Postgres), OpenRouter (через `callJson`), ExcelJS.

**Спецификация:** `docs/superpowers/specs/2026-09-25-polza-ru-outreach-v3-design.md`.

**Правила репозитория, которые меняют привычный TDD:**
- Новых `*.test.ts` не заводим (CLAUDE.md «тесты пишем скупо»). Проверка каждой задачи — eslint по изменённым файлам, в конце — `npm run typecheck:strict` и существующий `npx jest`.
- Dev-сервер локально не поднимаем (память `no-local-dev-server`).
- Коммит после каждой задачи в `dmitriy_kuladmed_new`; push — в конце. Merge/deploy делает пользователь.
- Все команды — из `G:\PycharmProjects\Portal\app` (Git Bash: `/g/PycharmProjects/Portal/app`).

---

## File Structure

| Файл | Что делает |
|---|---|
| `supabase/migrations/20260925_0001_polza_ru_outreach_v3.sql` (new) | статус `doubtful`, колонки сомнений и роутинга, вид загрузки `tenders`, кэш ФНС, RPC 2ГИС и ЯКарт |
| `app/src/lib/polzaRuOutreach/types.ts` | новые источники, типы сигналов, `min_ta_score`, лимиты, причины, коды сомнений |
| `app/src/lib/polzaRuOutreach/router.ts` | конкурентный выбор цепочки с баллом пригодности |
| `app/src/lib/polzaRuOutreach/doubts.ts` (new) | признаки сомнения готовой строки |
| `app/src/lib/polzaRuOutreach/sources/gis.ts` (new) | кандидаты из 2ГИС |
| `app/src/lib/polzaRuOutreach/sources/ymaps.ts` (new) | новые точки сетей в Яндекс Картах |
| `app/src/lib/polzaRuOutreach/sources/fnsRevenue.ts` (new) | выручка за два года из bo.nalog.gov.ru + кэш |
| `app/src/lib/polzaRuOutreach/sources/news.ts` (new) | Google News RSS + классификация LLM |
| `app/src/lib/polzaRuOutreach/sources/uploads.ts` | вид `tenders` |
| `app/src/lib/polzaRuOutreach/collect.ts` | новые источники, ошибки источников не валят запуск |
| `app/src/lib/polzaRuOutreach/runner.ts` | фильтры ползунков, обогащение, роутинг, сомнения, `doubtful` вне лимита |
| `app/src/lib/polzaRuOutreach/letters/chains.ts` | фразы-поводы для новых типов |
| `app/src/app/api/tools/polza-ru-outreach/[jobId]/results/route.ts` | новые колонки, воронка с `doubtful` |
| `app/src/app/api/tools/polza-ru-outreach/[jobId]/export/route.ts` | `?kind=doubtful`, колонка сомнений |
| `app/src/app/api/tools/polza-ru-outreach/uploads/route.ts` | вид `tenders` |
| `app/src/components/parsers/OutreachStages.tsx` (new) | общий визуальный компонент шагов |
| `app/src/components/parsers/PolzaOutreachStages.tsx` | английская обёртка над общим компонентом |
| `app/src/components/polzaRuOutreach/Stages.tsx` (new) | русские шаги + окно «кто прошёл и почему» |
| `app/src/components/polzaRuOutreach/PolzaRuOutreachView.tsx` | раскладка как у английского, вкладки |
| `app/src/components/polzaRuOutreach/Results.tsx` | убрать `Funnel`, оставить причины; метки сомнений, причина роутинга |
| `app/src/components/polzaRuOutreach/LaunchForm.tsx` | ползунки, новые источники, лимит |
| `app/src/components/polzaRuOutreach/shared.ts` | типы строки/запуска, подписи сигналов и статусов |
| `app/src/components/polzaRuOutreach/Libraries.tsx` | вид загрузки «тендеры» |
| `app/src/lib/polzaOutreach/types.ts`, `app/src/components/parsers/PolzaOutreachForm.tsx` | лимит EN = 500 |

---

### Task 1: Миграция

**Files:**
- Create: `supabase/migrations/20260925_0001_polza_ru_outreach_v3.sql`

- [ ] **Step 1: Написать миграцию**

```sql
-- «Наш автоаутрич» v3 (25.09.2026, docs/superpowers/specs/2026-09-25-polza-ru-outreach-v3-design.md):
-- очень спорные строки, причина выбора оффера, коммерческие тендеры, кэш
-- отчётности ФНС, кандидаты из 2ГИС и новые точки сетей Яндекс Карт.

-- ── Очень спорные и роутинг ─────────────────────────────────────────────────
alter table public.polza_ru_outreach_companies
  drop constraint if exists polza_ru_outreach_companies_row_status_check;
alter table public.polza_ru_outreach_companies
  add constraint polza_ru_outreach_companies_row_status_check
  check (row_status in ('processing', 'ready', 'rejected', 'manual_review', 'failed', 'doubtful'));

alter table public.polza_ru_outreach_companies
  add column if not exists doubt_flags text[] not null default '{}',
  add column if not exists doubt_detail text,
  add column if not exists route_reason text,
  add column if not exists route_runner_up text;

-- ── Коммерческие тендеры — новый вид загрузки ───────────────────────────────
alter table public.polza_ru_signal_uploads drop constraint if exists polza_ru_signal_uploads_kind_check;
alter table public.polza_ru_signal_uploads
  add constraint polza_ru_signal_uploads_kind_check check (kind in ('exhibitors', 'contracts', 'growth', 'tenders'));
alter table public.polza_ru_signal_rows drop constraint if exists polza_ru_signal_rows_kind_check;
alter table public.polza_ru_signal_rows
  add constraint polza_ru_signal_rows_kind_check check (kind in ('exhibitors', 'contracts', 'growth', 'tenders'));

-- ── Кэш бухотчётности ФНС (bo.nalog.gov.ru), 30 дней ───────────────────────
-- Пустая выручка тоже кэшируется: у компании нет отчётности — не спрашиваем снова.
create table if not exists public.polza_ru_fns_revenue (
  inn text primary key,
  bfo_org_id bigint,
  report_year integer,
  revenue bigint,
  revenue_prev bigint,
  fetched_at timestamptz not null default now()
);
alter table public.polza_ru_fns_revenue enable row level security;
grant all on public.polza_ru_fns_revenue to service_role;

-- ── Кандидаты из 2ГИС: проверенные сигнальным конвейером компании ──────────
create or replace function public.polza_ru_gis_candidates(p_since timestamptz, p_limit integer)
returns table (
  twogis_id text,
  company_name text,
  domain text,
  site text,
  sales_team boolean,
  multi_office boolean,
  evidence jsonb,
  checked_at timestamptz
)
language sql
stable
set statement_timeout = '30s'
as $$
  select s.twogis_id::text, c.company_name::text, c.domain::text, s.site::text,
         (coalesce(s.signal_sales_dept, false) or coalesce(s.signal_target_vacancy, false)),
         coalesce(s.signal_multi_office, false),
         s.evidence::jsonb,
         s.checked_at
  from public.gis_signal_company_signals s
  join public.gis_signal_seen_companies c on c.twogis_id = s.twogis_id
  where s.checked_at >= p_since
    and (s.signal_multi_office or s.signal_sales_dept or s.signal_target_vacancy)
    and coalesce(nullif(c.domain::text, ''), nullif(s.site::text, '')) is not null
  order by s.checked_at desc
  limit least(greatest(p_limit, 1), 5000);
$$;
revoke all on function public.polza_ru_gis_candidates(timestamptz, integer) from public;
grant execute on function public.polza_ru_gis_candidates(timestamptz, integer) to service_role;

-- ── Новые точки сетей в Яндекс Картах ───────────────────────────────────────
-- Точка сети, впервые увиденная в окне свежести, при том что у сети есть
-- точки старше окна. Индекса по first_seen_at нет — при таймауте источник
-- вернёт ошибку, запуск продолжится без него.
create or replace function public.polza_ru_ymaps_new_branches(p_since timestamptz, p_limit integer)
returns table (
  network_id text,
  network_name text,
  name text,
  website text,
  address text,
  city text,
  first_seen_at timestamptz,
  card_url text
)
language sql
stable
set statement_timeout = '30s'
as $$
  select distinct on (f.network_id::text)
         f.network_id::text, f.network_name::text, f.name::text, f.website::text,
         f.address::text, f.city::text, f.first_seen_at, f.card_url::text
  from public.yandex_maps_company_catalog f
  where f.network_id is not null
    and f.first_seen_at >= p_since
    and f.closed_suspected_at is null
    and coalesce(f.website::text, '') <> ''
    and exists (
      select 1 from public.yandex_maps_company_catalog o
      where o.network_id = f.network_id and o.first_seen_at < p_since
    )
  order by f.network_id::text, f.first_seen_at desc
  limit least(greatest(p_limit, 1), 5000);
$$;
revoke all on function public.polza_ru_ymaps_new_branches(timestamptz, integer) from public;
grant execute on function public.polza_ru_ymaps_new_branches(timestamptz, integer) to service_role;
```

- [ ] **Step 2: Проверить имена check-ограничений на проде (read-only)**

Через MCP `Portal DB` (или psql на 139) выполнить:

```sql
select conname from pg_constraint
where conrelid in ('public.polza_ru_outreach_companies'::regclass, 'public.polza_ru_signal_uploads'::regclass, 'public.polza_ru_signal_rows'::regclass)
  and contype = 'c';
```

Expected: среди имён есть `polza_ru_outreach_companies_row_status_check`, `polza_ru_signal_uploads_kind_check`, `polza_ru_signal_rows_kind_check`. Если имя другое — поправить `drop constraint` в миграции под фактическое. Если MCP смотрит в легаси-БД и таблиц нет — оставить имена по умолчанию Postgres (они и есть такие для inline `check`).

- [ ] **Step 3: Прогнать правило grants**

Run: `npx jest tests/migrations --silent`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add ../supabase/migrations/20260925_0001_polza_ru_outreach_v3.sql
git commit -m "feat(polza-ru-outreach): миграция v3 — очень спорные, тендеры, кэш ФНС, RPC 2ГИС и ЯКарт"
```

---

### Task 2: Типы, лимиты, коды

**Files:**
- Modify: `app/src/lib/polzaRuOutreach/types.ts`
- Modify: `app/src/lib/polzaOutreach/types.ts:40`
- Modify: `app/src/components/parsers/PolzaOutreachForm.tsx:47,89`

- [ ] **Step 1: Источники**

В `types.ts` заменить `SOURCE_CODES` и `SOURCE_LABELS`:

```ts
export const SOURCE_CODES = [
  'hh', 'direct', 'crm', 'exhibitors', 'contracts', 'tenders', 'growth', 'site_news', 'directory',
  'gis', 'ymaps', 'revenue_growth', 'news',
] as const;
export type SourceCode = (typeof SOURCE_CODES)[number];

export const SOURCE_LABELS: Record<SourceCode, string> = {
  hh: 'hh.ru: вакансии продаж',
  direct: 'Яндекс.Директ: компании в рекламной выдаче',
  crm: 'AMO: старые отказы',
  exhibitors: 'Выставки (загруженные каталоги)',
  contracts: 'Госконтракты (загруженные выгрузки ЕИС)',
  tenders: 'Коммерческие тендеры (загруженные выгрузки)',
  growth: 'Гранты / акселераторы (загруженные списки)',
  site_news: 'Новости на сайтах компаний прошлых запусков',
  directory: 'Общая база компаний (по профилю)',
  gis: '2ГИС: несколько филиалов, отдел продаж',
  ymaps: 'Яндекс Карты: новые точки сетей',
  revenue_growth: 'Рост выручки по отчётности ФНС',
  news: 'Новости о компании (Google News)',
};
```

- [ ] **Step 2: Конфиг и лимиты**

В `RuOutreachConfig` после `write_threshold` добавить:

```ts
  /** Похожесть на клиента Polza по сайту, 0–10: ниже — отсев (кроме «Возврата»). */
  min_ta_score: number;
```

Заменить константы лимитов:

```ts
export const DEFAULT_FRESHNESS_DAYS = 45;
export const MAX_FRESHNESS_DAYS = 180;
/** Готовые компании уходят в Instantly; 500 — решение 25.09.2026. */
export const DEFAULT_LIMIT = 500;
export const MAX_LIMIT = 1000;
export const DEFAULT_WRITE_THRESHOLD = 70;
export const DEFAULT_MIN_TA_SCORE = 4;
```

В `sanitizeRuOutreachConfig` заменить `const write = clampInt(raw.write_threshold, 70, 0, 100);` на
`const write = clampInt(raw.write_threshold, DEFAULT_WRITE_THRESHOLD, 0, 100);` и в возвращаемый объект после `write_threshold: write,` добавить:

```ts
    min_ta_score: clampInt(raw.min_ta_score, DEFAULT_MIN_TA_SCORE, 0, 10),
```

- [ ] **Step 3: Статусы, причины, сомнения**

```ts
export type RowStatus = 'processing' | 'ready' | 'rejected' | 'manual_review' | 'failed' | 'doubtful';
```

В `REASON_LABELS` после `SCORE_TOO_LOW` добавить:

```ts
  TA_TOO_LOW: 'Мало похожа на клиента Polza (ниже ползунка)',
  SIZE_OUT_OF_RANGE: 'Размер компании вне заданных рамок',
```

После `REASON_LABELS` добавить:

```ts
/** Признаки сомнения готовой строки: один — «спорная», два и больше — «очень спорная». */
export const DOUBT_CODES = ['GENERIC_MAILBOX', 'NEAR_THRESHOLD', 'WEAK_SIGNAL', 'COMPANY_DOUBT'] as const;
export type DoubtCode = (typeof DOUBT_CODES)[number];

export const DOUBT_LABELS: Record<DoubtCode, string> = {
  GENERIC_MAILBOX: 'Общая почта',
  NEAR_THRESHOLD: 'Оценка у порога',
  WEAK_SIGNAL: 'Слабый повод',
  COMPANY_DOUBT: 'Сомнения в компании',
};

/** С какого числа признаков строка уходит во вкладку «Очень спорные». */
export const VERY_DOUBTFUL_FROM = 2;
```

- [ ] **Step 4: Типы сигналов**

В union `SignalType` после `| 'crm_lost'` добавить:

```ts
  /** 2ГИС: на сайте есть отдел продаж / целевая вакансия. В выборе цепочки не участвует. */
  | 'sales_team'
  /** Выручка по отчётности ФНС выросла на 20% и больше. */
  | 'revenue_growth'
  /** Выигранный коммерческий тендер (загруженная выгрузка). */
  | 'tender_won'
  /** Новость об инвестициях в компанию. */
  | 'investment'
```

- [ ] **Step 5: Лимит английского аутрича**

`app/src/lib/polzaOutreach/types.ts:40`:

```ts
export const POLZA_OUTREACH_DEFAULT_LIMIT = 500;
```

`app/src/components/parsers/PolzaOutreachForm.tsx`: строка 47 `useState('100')` → `useState('500')`; строка 89 `: 100,` → `: 500,`.
Перед правкой проверить `POLZA_OUTREACH_MAX_LIMIT` в `types.ts`: если он меньше 500 — поднять до 1000.

- [ ] **Step 6: Lint**

Run: `npx eslint src/lib/polzaRuOutreach/types.ts src/lib/polzaOutreach/types.ts src/components/parsers/PolzaOutreachForm.tsx`
Expected: без ошибок.

- [ ] **Step 7: Commit**

```bash
git add src/lib/polzaRuOutreach/types.ts src/lib/polzaOutreach/types.ts src/components/parsers/PolzaOutreachForm.tsx
git commit -m "feat(polza-ru-outreach): новые источники, ползунок похожести, коды сомнений, лимит 500"
```

---

### Task 3: Конкурентный выбор оффера

**Files:**
- Modify: `app/src/lib/polzaRuOutreach/router.ts` (заменить `GROWTH_TYPES`, `RouteInput`, `Route`, `routeChain`; `scoreCompany`, `decide`, `routeCase` не трогать)

- [ ] **Step 1: Заменить шапку и роутер**

Заменить комментарий-шапку файла на:

```ts
/**
 * Роутер цепочки, роутер кейса и скоринг 0–100 (RU_OUTREACH_HANDOFF §3.1, §3.3, §4.2).
 *
 * Выбор цепочки (v3, 25.09.2026): «Возврат» — жёсткое правило при записанном
 * разговоре в AMO. Остальные цепочки с подходящими поводами соревнуются по
 * баллу пригодности 0–100: сила повода 35, свежесть 20, доказательство 20,
 * кейс под отрасль 15, размер под оффер 10, второй повод той же цепочки +5.
 * При равенстве — порядок CEO. «Только профиль» — только при ЦА ≥ 7.
 *
 * Скоринг компании (сумма 100): сила сигнала 30, свежесть 15, ЦА-балл 20, B2B 10,
 * размер 10, сайт 5, кейс 5, почта 5. Порог из формы: от него пишем, ниже — пропуск.
 */
```

Заменить блок от `const GROWTH_TYPES` до конца функции `routeChain` на:

```ts
/** Какой цепочке служит повод. Типы без записи (sales_hiring_broad, sales_team, crm_lost) цепочку не выбирают. */
const CHAIN_OF: Partial<Record<SignalType, Exclude<ChainType, 'reactivation' | 'icp_only'>>> = {
  sales_hiring: 'hiring',
  ad_running: 'ad_budget',
  trade_show_exhibitor: 'event',
  grant_or_accelerator: 'growth_event',
  contract_won: 'growth_event',
  tender_won: 'growth_event',
  revenue_growth: 'growth_event',
  investment: 'growth_event',
  product_launch: 'growth_event',
  new_region: 'growth_event',
  new_office: 'growth_event',
  new_production: 'growth_event',
  export_launch: 'growth_event',
  new_case: 'growth_event',
  partner_program: 'growth_event',
  dealer_search: 'growth_event',
};

/** Порядок CEO — только для равных баллов. */
const CEO_ORDER: ChainType[] = ['reactivation', 'hiring', 'ad_budget', 'event', 'growth_event', 'icp_only'];

const CHAIN_SHORT: Record<ChainType, string> = {
  reactivation: 'возврат',
  hiring: 'найм',
  ad_budget: 'реклама',
  event: 'выставка',
  growth_event: 'рост',
  icp_only: 'профиль',
};

export interface RouteInput {
  signals: Signal[];
  /** Давний отказ в AMO с записанным разговором. */
  reactivation: boolean;
  taScore: number;
  freshnessDays: number;
  revenue: number | null;
  employees: number | null;
  hasAdPixel: boolean;
  /** Есть ли утверждённый кейс под отрасль компании для этой цепочки. */
  hasCaseFor: (chain: ChainType) => boolean;
}

export interface Route {
  chain: ChainType;
  primary: Signal | null;
  /** Балл пригодности выбранной цепочки 0–100. */
  fit: number;
  /** Короткое «почему этот оффер» для таблицы. */
  reason: string;
  /** Второй вариант с баллом или null. */
  runnerUp: string | null;
}

function ageDays(s: Signal | null): number | null {
  if (!s?.date) return null;
  const t = new Date(s.date).getTime();
  return Number.isFinite(t) ? (Date.now() - t) / DAY : null;
}

function freshnessPoints(s: Signal | null, chain: ChainType, freshnessDays: number): number {
  const age = ageDays(s);
  if (age === null) return 0;
  // Выставка впереди — лучшее окно для встреч.
  if (chain === 'event' && age < 0) return 20;
  if (age <= 14) return 20;
  return age <= freshnessDays ? 10 : 0;
}

function evidencePoints(s: Signal | null): number {
  if (!s) return 0;
  const base = s.level === 'A' && s.quote ? 20 : s.level === 'A' || s.level === 'B' ? 10 : 0;
  return Math.max(0, base - (s.date ? 0 : 5));
}

/** Размер под оффер: неизвестный размер — нейтральные 5. */
function sizePoints(chain: ChainType, i: RouteInput): number {
  switch (chain) {
    case 'hiring':
      return i.employees == null ? 5 : i.employees >= 20 ? 10 : 0;
    case 'ad_budget':
      if (i.hasAdPixel || (i.revenue != null && i.revenue >= 30_000_000)) return 10;
      return i.revenue == null ? 5 : 0;
    case 'icp_only':
      return i.revenue == null ? 5 : i.revenue >= 100_000_000 ? 10 : 0;
    default:
      return 10;
  }
}

function strengthPoints(chain: ChainType, primary: Signal | null, taScore: number): number {
  let raw = STRENGTH[chain];
  if (chain === 'growth_event' && primary && !primary.date) raw = 15;
  if (chain === 'icp_only') raw = taScore >= 9 ? 20 : taScore >= 8 ? 15 : 10;
  return Math.round((raw / 30) * 35);
}

interface Candidate {
  chain: ChainType;
  primary: Signal | null;
  fit: number;
  parts: string;
}

function evaluate(chain: ChainType, signals: Signal[], i: RouteInput): Candidate {
  // Лучший повод цепочки — самый свежий и надёжный.
  const ranked = [...signals].sort(
    (a, b) =>
      freshnessPoints(b, chain, i.freshnessDays) + evidencePoints(b) - (freshnessPoints(a, chain, i.freshnessDays) + evidencePoints(a)),
  );
  // У найма цитата функции продаж сильнее голого названия должности.
  const primary = chain === 'hiring' ? (signals.find((s) => s.level === 'A') ?? ranked[0] ?? null) : (ranked[0] ?? null);
  const strength = strengthPoints(chain, primary, i.taScore);
  const fresh = chain === 'icp_only' ? 10 : freshnessPoints(primary, chain, i.freshnessDays);
  const evidence = evidencePoints(primary);
  const kase = chain === 'hiring' || i.hasCaseFor(chain) ? 15 : 0;
  const size = sizePoints(chain, i);
  const extra = signals.length > 1 ? 5 : 0;
  const fit = Math.min(100, strength + fresh + evidence + kase + size + extra);
  const parts = [
    `повод ${strength}`,
    `свежесть ${fresh}`,
    `доказательство ${evidence}`,
    kase ? `кейс ${kase}` : 'без кейса',
    `размер ${size}`,
    ...(extra ? [`поводов ${signals.length}`] : []),
  ].join(', ');
  return { chain, primary, fit, parts };
}

export function routeChain(input: RouteInput): Route | null {
  const usable = input.signals.filter((s) => s.level === 'A' || s.level === 'B');
  if (input.reactivation) {
    const lost = usable.filter((s) => s.type === 'crm_lost').sort((a, b) => (ageDays(a) ?? 1e9) - (ageDays(b) ?? 1e9));
    return { chain: 'reactivation', primary: lost[0] ?? null, fit: 100, reason: 'возврат: был записанный разговор в AMO', runnerUp: null };
  }

  const byChain = new Map<ChainType, Signal[]>();
  for (const s of usable) {
    const chain = CHAIN_OF[s.type];
    if (!chain) continue;
    byChain.set(chain, [...(byChain.get(chain) ?? []), s]);
  }
  const candidates: Candidate[] = [];
  for (const chain of CEO_ORDER) {
    if (chain === 'reactivation') continue;
    if (chain === 'icp_only') {
      if (input.taScore >= 7) candidates.push(evaluate('icp_only', [], input));
      continue;
    }
    const list = byChain.get(chain);
    if (list?.length) candidates.push(evaluate(chain, list, input));
  }
  if (!candidates.length) return null;

  // Устойчивая сортировка по баллу: при равенстве остаётся порядок CEO.
  const ranked = [...candidates].sort((a, b) => b.fit - a.fit);
  const [best, second] = ranked;
  return {
    chain: best.chain,
    primary: best.primary,
    fit: best.fit,
    reason: `${CHAIN_SHORT[best.chain]} ${best.fit}: ${best.parts}`,
    runnerUp: second ? `${CHAIN_SHORT[second.chain]} ${second.fit}` : null,
  };
}
```

Импорт `SignalType` в шапке файла уже есть (`import type { ChainType, IndustryGroup, Signal, SignalType } from './types';`). Константа `STRENGTH` и `DAY` остаются выше.

- [ ] **Step 2: Lint**

Run: `npx eslint src/lib/polzaRuOutreach/router.ts`
Expected: без ошибок. (Раннер пока не компилируется с новым `RouteInput` — чинится в Task 9.)

- [ ] **Step 3: Commit**

```bash
git add src/lib/polzaRuOutreach/router.ts
git commit -m "feat(polza-ru-outreach): оффер выбирается сравнением всех поводов, а не первым по очереди"
```

---

### Task 4: Признаки сомнения

**Files:**
- Create: `app/src/lib/polzaRuOutreach/doubts.ts`

- [ ] **Step 1: Написать модуль**

```ts
/**
 * Признаки сомнения готовой строки (дизайн v3 §2, решение 25.09.2026).
 *
 * Готовые компании уходят в Instantly, где место под контакты ограничено, —
 * поэтому сомнительное помечаем, а очень сомнительное (VERY_DOUBTFUL_FROM
 * признаков и больше) убираем из выгрузки в отдельную вкладку.
 */

import { companyKey } from './company';
import { VERY_DOUBTFUL_FROM, type ChainType, type DoubtCode, type Signal } from './types';

const DAY = 86_400_000;
const WEAK_AGE_DAYS = 30;
const NEAR_THRESHOLD_GAP = 10;

/** Локальная часть общего ящика: info@, sales@, office@, zakaz@ … */
const GENERIC_LOCAL =
  /^(info|sales|office|hello|mail|zakaz|order|orders|contact|contacts|support|admin|reception|secretary|priem|post|pr|marketing|market|welcome|client|clients|service|manager|opt|shop|team|general)([._-]?\d*)?$/i;

export interface DoubtInput {
  email: string;
  emailType: 'department' | 'generic' | 'person' | null;
  score: number;
  writeThreshold: number;
  chain: ChainType;
  primary: Signal | null;
  /** B2B подтверждён дословной цитатой с сайта или из вакансии. */
  b2bQuoted: boolean;
  revenue: number | null;
  employees: number | null;
  /** Название из источника и бренд со страницы. */
  sourceName: string;
  brand: string;
  /** В источнике было только доменное имя (Директ) — сравнивать нечего. */
  sourceIsDomainOnly: boolean;
}

export interface Doubts {
  flags: DoubtCode[];
  detail: string[];
  veryDoubtful: boolean;
}

function namesLookAlike(a: string, b: string): boolean {
  const x = companyKey(a);
  const y = companyKey(b);
  if (!x || !y) return true;
  if (x.includes(y) || y.includes(x)) return true;
  // Общий кусок от 4 символов — «СтройМаш» и «Строймаш-Урал» похожи.
  for (let i = 0; i + 4 <= y.length; i += 1) if (x.includes(y.slice(i, i + 4))) return true;
  return false;
}

export function computeDoubts(i: DoubtInput): Doubts {
  const flags: DoubtCode[] = [];
  const detail: string[] = [];

  const local = i.email.split('@')[0] ?? '';
  if (i.emailType === 'generic' || GENERIC_LOCAL.test(local)) {
    flags.push('GENERIC_MAILBOX');
    detail.push(`общая почта ${i.email}`);
  }

  if (i.score < i.writeThreshold + NEAR_THRESHOLD_GAP) {
    flags.push('NEAR_THRESHOLD');
    detail.push(`оценка ${i.score} при пороге ${i.writeThreshold}`);
  }

  if (i.chain !== 'reactivation') {
    const weak: string[] = [];
    if (i.chain === 'icp_only') weak.push('повода нет, только профиль');
    else if (!i.primary?.date) weak.push('повод без даты');
    else {
      const age = (Date.now() - new Date(i.primary.date).getTime()) / DAY;
      const futureEvent = i.chain === 'event' && age < 0;
      if (!futureEvent && age > WEAK_AGE_DAYS) weak.push(`повод ${Math.round(age)} дн. назад`);
    }
    if (weak.length) {
      flags.push('WEAK_SIGNAL');
      detail.push(...weak);
    }
  }

  const company: string[] = [];
  if (!i.b2bQuoted) company.push('B2B подтверждён косвенно');
  if (i.revenue == null && i.employees == null) company.push('размер неизвестен');
  if (!i.sourceIsDomainOnly && !namesLookAlike(i.sourceName, i.brand)) {
    company.push(`название на сайте «${i.brand}» не похоже на «${i.sourceName}»`);
  }
  if (company.length) {
    flags.push('COMPANY_DOUBT');
    detail.push(...company);
  }

  return { flags, detail, veryDoubtful: flags.length >= VERY_DOUBTFUL_FROM };
}
```

- [ ] **Step 2: Lint**

Run: `npx eslint src/lib/polzaRuOutreach/doubts.ts`
Expected: без ошибок.

- [ ] **Step 3: Commit**

```bash
git add src/lib/polzaRuOutreach/doubts.ts
git commit -m "feat(polza-ru-outreach): признаки сомнения готовой строки"
```

---

### Task 5: Коммерческие тендеры — загрузка

**Files:**
- Modify: `app/src/lib/polzaRuOutreach/sources/uploads.ts`
- Modify: `app/src/app/api/tools/polza-ru-outreach/uploads/route.ts:30-31`
- Modify: `app/src/components/polzaRuOutreach/Libraries.tsx:245,300-305,332`

- [ ] **Step 1: uploads.ts**

`export type UploadKind = 'exhibitors' | 'contracts' | 'growth';` → `export type UploadKind = 'exhibitors' | 'contracts' | 'growth' | 'tenders';`

В шапке файла дописать строку в комментарий: ` * Коммерческие тендеры (B2B-Center, Росэлторг) — та же форма, что контракты ЕИС: победитель = компания.`

В `parseSignalFile` условие `kind === 'contracts'` (перед сборкой `details`) заменить на `kind === 'contracts' || kind === 'tenders'`.

В `loadSignalRows` строку `if (kind === 'contracts') q = q.gte('record_date', sinceDate);` заменить на
`if (kind === 'contracts' || kind === 'tenders') q = q.gte('record_date', sinceDate);`

- [ ] **Step 2: Роут загрузки**

`uploads/route.ts:31`:

```ts
  const kind = rawKind === 'contracts' || rawKind === 'exhibitors' || rawKind === 'growth' || rawKind === 'tenders' ? rawKind : null;
```

- [ ] **Step 3: Libraries.tsx**

Тип в `useState` и в `onChange` (строки 245 и 300): `'exhibitors' | 'contracts' | 'growth'` → `'exhibitors' | 'contracts' | 'growth' | 'tenders'`.
После `<option value="contracts">Выгрузка контрактов ЕИС</option>` добавить:

```tsx
          <option value="tenders">Выгрузка коммерческих тендеров (B2B-Center, Росэлторг)</option>
```

Строка 332 — подпись вида загрузки:

```tsx
<span className="mr-2 rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">{u.kind === 'exhibitors' ? 'выставка' : u.kind === 'growth' ? 'гранты' : u.kind === 'tenders' ? 'тендеры' : 'контракты'}</span>
```

- [ ] **Step 4: Lint**

Run: `npx eslint src/lib/polzaRuOutreach/sources/uploads.ts src/app/api/tools/polza-ru-outreach/uploads/route.ts src/components/polzaRuOutreach/Libraries.tsx`
Expected: без ошибок.

- [ ] **Step 5: Commit**

```bash
git add src/lib/polzaRuOutreach/sources/uploads.ts src/app/api/tools/polza-ru-outreach/uploads/route.ts src/components/polzaRuOutreach/Libraries.tsx
git commit -m "feat(polza-ru-outreach): загрузка выгрузок коммерческих тендеров"
```

---

### Task 6: Источники 2ГИС и Яндекс Карты

**Files:**
- Create: `app/src/lib/polzaRuOutreach/sources/gis.ts`
- Create: `app/src/lib/polzaRuOutreach/sources/ymaps.ts`

- [ ] **Step 1: gis.ts**

```ts
/**
 * 2ГИС: компании, которые сигнальный конвейер 2ГИС уже проверил по сайту
 * (gis_signal_company_signals). Берём «несколько филиалов» как слабый повод
 * роста и «отдел продаж / целевая вакансия» как справку без выбора цепочки.
 * Большинство там — локальный B2C; его отсекает проверка B2B по сайту.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizeDomain } from '../company';
import type { Signal } from '../types';

export interface GisCandidate {
  twogisId: string;
  companyName: string;
  domain: string;
  signals: Signal[];
}

function evidenceText(evidence: unknown, key: string): string | null {
  if (!evidence || typeof evidence !== 'object') return null;
  const v = (evidence as Record<string, unknown>)[key];
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, 300) : null;
}

export async function loadGisCandidates(db: SupabaseClient, freshnessDays: number, limit: number): Promise<GisCandidate[]> {
  const since = new Date(Date.now() - freshnessDays * 86_400_000).toISOString();
  const { data, error } = await db.rpc('polza_ru_gis_candidates', { p_since: since, p_limit: limit });
  if (error) throw new Error(`2ГИС: ${error.message}`);
  const out: GisCandidate[] = [];
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    const domain = normalizeDomain(String(r.domain ?? '')) ?? normalizeDomain(String(r.site ?? ''));
    if (!domain) continue;
    const url = `https://2gis.ru/firm/${String(r.twogis_id)}`;
    const signals: Signal[] = [];
    if (r.multi_office) {
      signals.push({
        type: 'new_office', source: 'gis', title: 'несколько филиалов', date: null, url,
        quote: evidenceText(r.evidence, 'multiOffice'), level: 'B', meta: { twogis_id: r.twogis_id, standing: true },
      });
    }
    if (r.sales_team) {
      signals.push({
        type: 'sales_team', source: 'gis', title: 'отдел продаж / вакансия продаж на сайте', date: r.checked_at ? String(r.checked_at) : null,
        url, quote: evidenceText(r.evidence, 'salesDept') ?? evidenceText(r.evidence, 'targetVacancy'), level: 'C',
      });
    }
    out.push({ twogisId: String(r.twogis_id), companyName: String(r.company_name ?? domain), domain, signals });
  }
  return out;
}
```

- [ ] **Step 2: ymaps.ts**

```ts
/**
 * Яндекс Карты: новая точка сети, впервые увиденная в окне свежести, при том
 * что у сети есть точки старше окна. Повод «рост» с датой первого появления.
 * Каталог стоит с 28.08.2026 (прокси) — до починки свежих находок будет мало.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizeDomain } from '../company';
import type { Signal } from '../types';

export interface YmapsCandidate {
  networkId: string;
  companyName: string;
  domain: string;
  signal: Signal;
}

export async function loadYmapsNewBranches(db: SupabaseClient, freshnessDays: number, limit: number): Promise<YmapsCandidate[]> {
  const since = new Date(Date.now() - freshnessDays * 86_400_000).toISOString();
  const { data, error } = await db.rpc('polza_ru_ymaps_new_branches', { p_since: since, p_limit: limit });
  if (error) throw new Error(`Яндекс Карты: ${error.message}`);
  const out: YmapsCandidate[] = [];
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    const domain = normalizeDomain(String(r.website ?? ''));
    if (!domain) continue;
    const address = [r.city, r.address].filter((x) => typeof x === 'string' && x.trim()).join(', ');
    out.push({
      networkId: String(r.network_id),
      companyName: String(r.network_name ?? r.name ?? domain),
      domain,
      signal: {
        type: 'new_office', source: 'ymaps', title: address || 'новая точка сети', date: r.first_seen_at ? String(r.first_seen_at) : null,
        url: r.card_url ? String(r.card_url) : null, quote: null, level: 'B', meta: { network_id: r.network_id },
      },
    });
  }
  return out;
}
```

- [ ] **Step 3: Lint и commit**

Run: `npx eslint src/lib/polzaRuOutreach/sources/gis.ts src/lib/polzaRuOutreach/sources/ymaps.ts`
Expected: без ошибок.

```bash
git add src/lib/polzaRuOutreach/sources/gis.ts src/lib/polzaRuOutreach/sources/ymaps.ts
git commit -m "feat(polza-ru-outreach): источники 2ГИС и новые точки сетей Яндекс Карт"
```

---

### Task 7: Рост выручки по отчётности ФНС

**Files:**
- Create: `app/src/lib/polzaRuOutreach/sources/fnsRevenue.ts`

- [ ] **Step 1: Написать модуль**

```ts
/**
 * Выручка компании за два года из открытой бухотчётности ФНС (bo.nalog.gov.ru).
 *
 * Проверено 25.09.2026, без ключа:
 *   GET /advanced-search/organizations/search?query=<ИНН>&page=0 → content[].id, inn (с <strong>)
 *   GET /nbo/organizations/<id>/bfo/ → отчёты; typeCorrections[0].correction.financialResult
 *       .current2110 / .previous2110 — выручка отчётного и прошлого года, тыс. ₽.
 * Ответы кэшируются в polza_ru_fns_revenue на 30 дней (и пустые тоже).
 * Запросы идут по одному с паузой — сервис государственный, не нагружаем.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Signal } from '../types';

const BASE = 'https://bo.nalog.gov.ru';
const TIMEOUT_MS = 15_000;
const PAUSE_MS = 1_000;
const CACHE_DAYS = 30;
export const MIN_REVENUE_GROWTH = 0.2;

export interface RevenueFact {
  inn: string;
  orgId: number | null;
  year: number | null;
  revenue: number | null;
  revenuePrev: number | null;
}

let queue: Promise<void> = Promise.resolve();

/** Последовательные запросы с паузой между ними, даже при параллельном конвейере. */
function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn);
  queue = run.then(
    () => new Promise((r) => setTimeout(r, PAUSE_MS)),
    () => new Promise((r) => setTimeout(r, PAUSE_MS)),
  );
  return run;
}

async function getJson(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (Polza Portal)' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`ФНС ответила HTTP ${res.status}`);
  return res.json();
}

function num(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

async function fetchFromFns(inn: string): Promise<RevenueFact> {
  const found = (await throttled(() => getJson(`/advanced-search/organizations/search?query=${inn}&page=0`))) as {
    content?: Array<{ id?: number; inn?: string }>;
  };
  const org = (found.content ?? []).find((c) => String(c.inn ?? '').replace(/<[^>]+>/g, '') === inn);
  if (!org?.id) return { inn, orgId: null, year: null, revenue: null, revenuePrev: null };

  const reports = (await throttled(() => getJson(`/nbo/organizations/${org.id}/bfo/`))) as Array<{
    period?: string | number;
    typeCorrections?: Array<{ correction?: { financialResult?: { current2110?: unknown; previous2110?: unknown } } }>;
  }>;
  let best: RevenueFact = { inn, orgId: org.id, year: null, revenue: null, revenuePrev: null };
  for (const r of Array.isArray(reports) ? reports : []) {
    const year = num(r.period);
    const fin = r.typeCorrections?.[0]?.correction?.financialResult;
    const current = num(fin?.current2110);
    if (year === null || current === null) continue;
    if (best.year === null || year > best.year) {
      const prev = num(fin?.previous2110);
      best = { inn, orgId: org.id, year, revenue: current * 1000, revenuePrev: prev === null ? null : prev * 1000 };
    }
  }
  return best;
}

export async function fetchRevenue(db: SupabaseClient, inn: string): Promise<RevenueFact> {
  const since = new Date(Date.now() - CACHE_DAYS * 86_400_000).toISOString();
  const { data: cached } = await db
    .from('polza_ru_fns_revenue')
    .select('inn,bfo_org_id,report_year,revenue,revenue_prev')
    .eq('inn', inn)
    .gte('fetched_at', since)
    .maybeSingle();
  if (cached) {
    return {
      inn,
      orgId: num(cached.bfo_org_id),
      year: num(cached.report_year),
      revenue: num(cached.revenue),
      revenuePrev: num(cached.revenue_prev),
    };
  }
  const fact = await fetchFromFns(inn);
  await db.from('polza_ru_fns_revenue').upsert({
    inn,
    bfo_org_id: fact.orgId,
    report_year: fact.year,
    revenue: fact.revenue,
    revenue_prev: fact.revenuePrev,
    fetched_at: new Date().toISOString(),
  });
  return fact;
}

/**
 * Повод «рост выручки». Дата — 31 марта следующего года: к ней отчётность
 * становится публичной. Цифры роста — только в заголовке для таблицы; в
 * письмо они не идут (QA режет неподтверждённые числа).
 */
export function revenueGrowthSignal(f: RevenueFact): Signal | null {
  if (!f.year || !f.revenue || !f.revenuePrev || f.revenuePrev <= 0) return null;
  const growth = f.revenue / f.revenuePrev - 1;
  if (growth < MIN_REVENUE_GROWTH) return null;
  const pct = Math.round(growth * 100);
  return {
    type: 'revenue_growth',
    source: 'revenue_growth',
    title: `Выручка за ${f.year} выросла на ${pct}% к ${f.year - 1}`,
    date: `${f.year + 1}-03-31`,
    url: f.orgId ? `${BASE}/organizations-card/${f.orgId}` : null,
    quote: null,
    level: 'B',
    meta: { growth_pct: pct, revenue: f.revenue, revenue_prev: f.revenuePrev, year: f.year },
  };
}
```

- [ ] **Step 2: Проверить ФНС вживую тем же кодом**

Run (Git Bash, из `app/`):

```bash
node -e "(async()=>{const h={Accept:'application/json','User-Agent':'Mozilla/5.0'};const s=await (await fetch('https://bo.nalog.gov.ru/advanced-search/organizations/search?query=7734454184&page=0',{headers:h})).json();const id=s.content[0].id;const b=await (await fetch('https://bo.nalog.gov.ru/nbo/organizations/'+id+'/bfo/',{headers:h})).json();console.log(id,b.map(r=>[r.period,r.typeCorrections?.[0]?.correction?.financialResult?.current2110]))})()"
```

Expected: `11843517 [ [ '2022', 8025 ], ... [ '2025', 340985 ] ]` (числа могут обновиться). Если формат другой — поправить разбор в `fetchFromFns` под фактический ответ.

- [ ] **Step 3: Lint и commit**

Run: `npx eslint src/lib/polzaRuOutreach/sources/fnsRevenue.ts`

```bash
git add src/lib/polzaRuOutreach/sources/fnsRevenue.ts
git commit -m "feat(polza-ru-outreach): рост выручки по открытой отчётности ФНС"
```

---

### Task 8: Новости о компании

**Files:**
- Create: `app/src/lib/polzaRuOutreach/sources/news.ts`

- [ ] **Step 1: Написать модуль**

```ts
/**
 * Новости о компании: Google News RSS по бренду, пять свежих заголовков в окне
 * свежести, один вызов LLM на компанию. Модель только классифицирует; цитата —
 * дословный заголовок, сверенный кодом (acceptQuote). Заголовок не про эту
 * компанию или не повод — отбрасывается.
 */

import { acceptQuote } from '../evidence';
import { asString, callJson } from '../llm';
import type { Signal, SignalType } from '../types';

const TIMEOUT_MS = 10_000;
const MAX_ITEMS = 5;

export interface NewsItem {
  title: string;
  link: string | null;
  date: string | null;
}

const NEWS_TYPES: Record<string, SignalType> = {
  investment: 'investment',
  product_launch: 'product_launch',
  new_region: 'new_region',
  new_office: 'new_office',
  new_production: 'new_production',
  contract_won: 'contract_won',
  export_launch: 'export_launch',
};

function decode(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

function tag(block: string, name: string): string | null {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  return m ? decode(m[1]) : null;
}

/** RSS Google News → заголовки. Хвост « - Источник» у заголовка снимаем. */
export function parseNewsRss(xml: string): NewsItem[] {
  const out: NewsItem[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const block = m[1];
    const raw = tag(block, 'title');
    if (!raw) continue;
    const source = tag(block, 'source');
    const title = source && raw.endsWith(` - ${source}`) ? raw.slice(0, -(source.length + 3)).trim() : raw;
    const pub = tag(block, 'pubDate');
    const d = pub ? new Date(pub) : null;
    out.push({ title, link: tag(block, 'link'), date: d && !Number.isNaN(d.getTime()) ? d.toISOString() : null });
  }
  return out;
}

async function fetchNews(brand: string): Promise<NewsItem[]> {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(`"${brand}"`)}&hl=ru&gl=RU&ceid=RU:ru`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Polza Portal)' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Google News ответил HTTP ${res.status}`);
  return parseNewsRss(await res.text());
}

const SYSTEM = `Ты классифицируешь новостные заголовки о российской компании для B2B-аутрича. Верни СТРОГИЙ JSON:
{"items":[{"n":number,"about_company":boolean,"type":string}]}
type — одно из: "investment" (компания получила инвестиции/раунд), "product_launch" (запустила продукт/сервис), "new_region" (вышла в новый регион/город), "new_office" (открыла офис/филиал/точку), "new_production" (запустила производство/завод/цех), "contract_won" (заключила крупный контракт/выиграла тендер), "export_launch" (вышла на экспорт), "none" (иное: отчётность, суды, кадровые новости, реклама, рейтинг).
about_company = true только если заголовок именно про эту компанию, а не про тёзку или отрасль. Не угадывай.`;

export async function findNewsSignals(brand: string, freshnessDays: number): Promise<Signal[]> {
  if (brand.replace(/[^\p{L}\d]/gu, '').length < 4) return [];
  const since = Date.now() - freshnessDays * 86_400_000;
  const items = (await fetchNews(brand))
    .filter((it) => it.date && new Date(it.date).getTime() >= since)
    .slice(0, MAX_ITEMS);
  if (!items.length) return [];

  const user = [`КОМПАНИЯ: ${brand}`, '', ...items.map((it, i) => `${i + 1}. ${it.title}`)].join('\n');
  const raw = await callJson(SYSTEM, user, 'news', 400);
  const verdicts = Array.isArray(raw.items) ? (raw.items as Array<Record<string, unknown>>) : [];
  const out: Signal[] = [];
  for (const v of verdicts) {
    const item = items[Number(v.n) - 1];
    const type = NEWS_TYPES[asString(v.type)];
    if (!item || !type || v.about_company !== true) continue;
    const quote = acceptQuote(item.title, item.title);
    if (!quote) continue;
    out.push({ type, source: 'news', title: item.title, date: item.date, url: item.link, quote, level: 'A', meta: { news: true } });
  }
  return out;
}
```

- [ ] **Step 2: Проверить RSS вживую**

Run:

```bash
node -e "fetch('https://news.google.com/rss/search?q=%22%D0%9E%D0%B7%D0%BE%D0%BD%22&hl=ru&gl=RU&ceid=RU:ru').then(r=>r.text()).then(t=>console.log((t.match(/<item>/g)||[]).length, t.slice(t.indexOf('<item>'), t.indexOf('<item>')+400)))"
```

Expected: число > 0 и блок `<item><title>… - Источник</title><link>…</link>…<pubDate>…</pubDate>…<source …>Источник</source>`. Если разметка другая — поправить `parseNewsRss`.

- [ ] **Step 3: Lint и commit**

Run: `npx eslint src/lib/polzaRuOutreach/sources/news.ts`

```bash
git add src/lib/polzaRuOutreach/sources/news.ts
git commit -m "feat(polza-ru-outreach): поводы из новостей о компании"
```

---

### Task 9: Сбор кандидатов с новыми источниками

**Files:**
- Modify: `app/src/lib/polzaRuOutreach/collect.ts`

- [ ] **Step 1: Импорты**

Добавить к импортам:

```ts
import { loadGisCandidates } from './sources/gis';
import { loadYmapsNewBranches } from './sources/ymaps';
```

- [ ] **Step 2: Результат с ошибками источников**

Перед `export async function collectCandidates` добавить:

```ts
export interface CollectResult {
  pool: Candidate[];
  /** Источник упал — запуск идёт без него, причина показывается на экране. */
  sourceErrors: Partial<Record<SourceCode, string>>;
}

const SOURCE_POOL_LIMIT = 5000;
```

Сигнатуру заменить на `): Promise<CollectResult> {` и сразу после `const all: Candidate[] = [];` добавить:

```ts
  const sourceErrors: CollectResult['sourceErrors'] = {};
  const attempt = async (code: SourceCode, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      sourceErrors[code] = err instanceof Error ? err.message.slice(0, 300) : String(err);
    }
  };
```

Каждый существующий блок источника (`crm`, `hh`, `direct`, цикл загрузок, `site_news`, `directory`) обернуть в `await attempt('<код>', async () => { … });` — для цикла загрузок оборачивать тело цикла кодом `kind`.

- [ ] **Step 3: Тендеры в цикле загрузок**

Массив `uploadKinds` заменить на:

```ts
  const uploadKinds: Array<['exhibitors' | 'contracts' | 'growth' | 'tenders', Signal['type']]> = [
    ['exhibitors', 'trade_show_exhibitor'],
    ['contracts', 'contract_won'],
    ['tenders', 'tender_won'],
    ['growth', 'grant_or_accelerator'],
  ];
```

и условие суммы `if (kind === 'contracts' && …)` → `if ((kind === 'contracts' || kind === 'tenders') && !(Number(r.details.amount ?? 0) >= config.min_contract_amount)) continue;`

- [ ] **Step 4: 2ГИС, Яндекс Карты, рост выручки**

После блока `directory` (внутри функции, до `const merged = merge(all);`) добавить:

```ts
  if (src.has('gis')) {
    await attempt('gis', async () => {
      for (const g of await loadGisCandidates(db, config.freshness_days, SOURCE_POOL_LIMIT)) {
        all.push(
          base({
            key: `domain:${g.domain}`,
            source: 'gis',
            sourceRecordId: `gis:${g.twogisId}`,
            sourceUrls: [`https://2gis.ru/firm/${g.twogisId}`],
            companyName: g.companyName,
            website: `https://${g.domain}`,
            signals: g.signals,
          }),
        );
      }
    });
  }

  if (src.has('ymaps')) {
    await attempt('ymaps', async () => {
      for (const y of await loadYmapsNewBranches(db, config.freshness_days, SOURCE_POOL_LIMIT)) {
        all.push(
          base({
            key: `domain:${y.domain}`,
            source: 'ymaps',
            sourceRecordId: `ymaps:${y.networkId}`,
            sourceUrls: y.signal.url ? [y.signal.url] : [],
            companyName: y.companyName,
            website: `https://${y.domain}`,
            signals: [y.signal],
          }),
        );
      }
    });
  }

  // Рост выручки проверяется в раннере по ИНН (ФНС); здесь — компании общей
  // базы с ИНН в заданном размере, чтобы было у кого проверять.
  if (src.has('revenue_growth') && !src.has('directory')) {
    await attempt('revenue_growth', async () => {
      const rows = await loadDirectoryCandidates(db, {
        minRevenue: config.min_revenue,
        maxRevenue: config.max_revenue,
        minEmployees: config.min_employees,
        limit: Math.min(SOURCE_POOL_LIMIT, Math.max(500, poolTarget)),
      });
      for (const r of rows) {
        if (!r.inn) continue;
        all.push(
          base({
            key: `inn:${r.inn}`,
            source: 'revenue_growth',
            sourceRecordId: `inn:${r.inn}`,
            companyName: r.name,
            inn: r.inn,
            website: r.website,
            revenue: r.revenue,
            employees: r.employees,
          }),
        );
      }
    });
  }
```

Возврат функции заменить на:

```ts
  const merged = merge(all);
  // Сначала компании с поводом и несколькими источниками, затем свежие; профиль — в конце.
  const pool = merged.sort(
    (a, b) =>
      Number(b.signals.length > 0) - Number(a.signals.length > 0) ||
      b.sources.length - a.sources.length ||
      latest(b) - latest(a),
  );
  return { pool, sourceErrors };
```

- [ ] **Step 5: Lint и commit**

Run: `npx eslint src/lib/polzaRuOutreach/collect.ts`

```bash
git add src/lib/polzaRuOutreach/collect.ts
git commit -m "feat(polza-ru-outreach): сбор из 2ГИС, Яндекс Карт, тендеров и ФНС; упавший источник не валит запуск"
```

---

### Task 10: Раннер — ползунки, обогащение, роутинг, сомнения

**Files:**
- Modify: `app/src/lib/polzaRuOutreach/runner.ts`

- [ ] **Step 1: Импорты и потолок просмотра**

Добавить импорты:

```ts
import { computeDoubts } from './doubts';
import { fetchRevenue, revenueGrowthSignal } from './sources/fnsRevenue';
import { findNewsSignals } from './sources/news';
```

`maxCandidatesFor` заменить на:

```ts
export function maxCandidatesFor(target: number): number {
  return Math.min(12_000, Math.max(300, target * 15));
}
```

- [ ] **Step 2: Сбор с ошибками источников**

`const pool = await collectCandidates(db, config, amo, maxScan);` →

```ts
    const { pool, sourceErrors } = await collectCandidates(db, config, amo, maxScan);
    if (Object.keys(sourceErrors).length) log('warn', `job ${jobId}: source errors`, sourceErrors);
```

Счётчики: после `const chains: Record<string, number> = {};` добавить `const doubtful = { count: 0 };`.
В `publish` и в финальном `setProgress` в объект `progress_detail` добавить поля `source_errors: sourceErrors, doubtful: doubtful.count`.

- [ ] **Step 3: Обогащение ФНС и новостями, фильтры размера и похожести**

В `qualify` сразу после строки `reach('enriched');` вставить:

```ts
      const known = c.inn ? size.get(c.inn) : undefined;
      let revenue = c.revenue ?? known?.revenue ?? null;
      const employees = c.employees ?? known?.employees ?? null;

      // Рост выручки по ФНС: и повод, и размер, если он ещё неизвестен.
      if (c.inn && (config.sources.includes('revenue_growth') || revenue === null)) {
        const fact = await fetchRevenue(db, c.inn).catch((err) => {
          log('warn', `fns revenue failed for ${c.inn}`, err instanceof Error ? err.message : err);
          return null;
        });
        if (fact?.revenue != null && revenue === null) revenue = fact.revenue;
        const growth = fact && config.sources.includes('revenue_growth') ? revenueGrowthSignal(fact) : null;
        if (growth) signals.push(growth);
      }

      if (config.sources.includes('news')) {
        const news = await findNewsSignals(brand, config.freshness_days).catch((err) => {
          log('warn', `news failed for ${domain}`, err instanceof Error ? err.message : err);
          return [];
        });
        signals.push(...news);
      }

      const reactivation = Boolean(amoRec && amoRec.status === 'lost' && amoRec.priorContact);
      if (!reactivation) {
        const tooSmall = (revenue !== null && revenue < config.min_revenue) || (employees !== null && employees < config.min_employees);
        const tooBig = revenue !== null && revenue > config.max_revenue;
        if (tooSmall || tooBig) {
          await finish(id, {
            stage: 'scored', status: 'rejected', reason: 'SIZE_OUT_OF_RANGE',
            detail: `выручка ${revenue ?? '—'}, штат ${employees ?? '—'}`,
          }, { signals });
          return null;
        }
        if (site.taScore < config.min_ta_score) {
          await finish(id, { stage: 'scored', status: 'rejected', reason: 'TA_TOO_LOW', detail: `ЦА ${site.taScore}/10 при пороге ${config.min_ta_score}` }, { signals, ta_score: site.taScore, ta_reason: site.taReason });
          return null;
        }
      }
```

Ниже удалить старые строки `const reactivation = …;`, `const route = routeChain({ signals, reactivation, taScore: site.taScore });` и `const known = c.inn ? size.get(c.inn) : undefined;`. Вместо старого `const route = …` вставить:

```ts
      const route = routeChain({
        signals,
        reactivation,
        taScore: site.taScore,
        freshnessDays: config.freshness_days,
        revenue,
        employees,
        hasAdPixel: site.hasAdPixel,
        hasCaseFor: (chain) => Boolean(routeCase(libraries.cases, site.industryGroup, chain)),
      });
```

В вызове `scoreCompany` заменить `revenue: c.revenue ?? known?.revenue ?? null,` и `employees: c.employees ?? known?.employees ?? null,` на `revenue,` и `employees,`.

В объект `patch` добавить:

```ts
        route_reason: route.reason,
        route_runner_up: route.runnerUp,
```

В `Qualified` добавить поля `revenue: number | null; employees: number | null; b2bQuoted: boolean;` и в `return { id, candidate: c, … }` дописать `revenue, employees, b2bQuoted: Boolean(site.b2bQuote || vacancy?.b2bQuote),`.

- [ ] **Step 4: Сомнения в finalize**

В `finalize` заменить хвост после `reach('qa_checked');` (от `if (totals.ready >= target) {` до конца функции) на:

```ts
      reach('qa_checked');
      const doubts = computeDoubts({
        email: email.email,
        emailType: email.emailType,
        score: q.score.total,
        writeThreshold: config.write_threshold,
        chain: q.route.chain,
        primary: q.route.primary,
        b2bQuoted: q.b2bQuoted,
        revenue: q.revenue,
        employees: q.employees,
        sourceName: q.candidate.companyName,
        brand: q.brand,
        sourceIsDomainOnly: q.candidate.companyName === q.domain,
      });
      const doubtPatch = { doubt_flags: doubts.flags, doubt_detail: doubts.detail.join('; ') || null };
      // Очень спорная не идёт в Instantly и не занимает место в лимите — ищем дальше.
      if (doubts.veryDoubtful) {
        doubtful.count += 1;
        await updateRow(q.id, { ...base, ...doubtPatch, row_status: 'doubtful', pipeline_stage: 'qa_checked', reason_code: null, reason_detail: null });
        return;
      }
      if (totals.ready >= target) {
        await updateRow(q.id, { ...base, ...doubtPatch, row_status: 'manual_review', pipeline_stage: 'qa_checked', reason_code: 'LIMIT_REACHED', reason_detail: 'лимит готовых компаний уже набран' });
        return;
      }
      totals.ready += 1;
      reach('ready');
      await updateRow(q.id, { ...base, ...doubtPatch, row_status: 'ready', pipeline_stage: 'ready', reason_code: null, reason_detail: null });
```

- [ ] **Step 5: Lint**

Run: `npx eslint src/lib/polzaRuOutreach/runner.ts`
Expected: без ошибок.

- [ ] **Step 6: Commit**

```bash
git add src/lib/polzaRuOutreach/runner.ts
git commit -m "feat(polza-ru-outreach): ползунки режут все источники, ФНС и новости, выбор оффера, очень спорные вне лимита"
```

---

### Task 11: Фразы-поводы для новых типов

**Files:**
- Modify: `app/src/lib/polzaRuOutreach/letters/chains.ts:60-72` (ветка `growth_event` в `openingSentence`)

- [ ] **Step 1: Ветка growth_event**

Внутри `case 'growth_event': {` после `if (!s) return null;` и перед `if (s.type === 'contract_won') {` вставить:

```ts
      if (s.source === 'news' && s.quote) return `Увидел новость: «${s.quote}».`;
      if (s.type === 'tender_won') {
        const subject = s.title && wordCount(s.title) <= 15 ? s.title : null;
        return `Увидел, что ${b} выиграла тендер${subject ? ` «${subject}»` : ''}.`;
      }
      // Цифры роста в письмо не несём: QA режет числа не из разрешённых источников.
      if (s.type === 'revenue_growth') return `Увидел по открытой отчётности, что ${b} заметно выросла за последний год.`;
      if (s.type === 'new_office' && s.source === 'gis') return `Увидел, что у ${b} несколько филиалов.`;
      if (s.type === 'new_office' && s.source === 'ymaps') return `Увидел, что у ${b} появилась новая точка: ${s.title}.`;
```

- [ ] **Step 2: Lint и commit**

Run: `npx eslint src/lib/polzaRuOutreach/letters/chains.ts`

```bash
git add src/lib/polzaRuOutreach/letters/chains.ts
git commit -m "feat(polza-ru-outreach): первые фразы писем для тендеров, роста выручки, новостей и филиалов"
```

---

### Task 12: API — результаты и выгрузка

**Files:**
- Modify: `app/src/app/api/tools/polza-ru-outreach/[jobId]/results/route.ts`
- Modify: `app/src/app/api/tools/polza-ru-outreach/[jobId]/export/route.ts`

- [ ] **Step 1: results — колонки и воронка**

В `LIST_COLUMNS` в конец строки перед `created_at` добавить `doubt_flags,doubt_detail,route_reason,route_runner_up,`:

```ts
  'letters,subject_b,case_id,offer_version,template_version,qa_status,qa_flags,row_status,pipeline_stage,reason_code,reason_detail,' +
  'doubt_flags,doubt_detail,route_reason,route_runner_up,created_at';
```

Строку `const reached = …` заменить на:

```ts
    // Очень спорная прошла проверку писем, но в «Готово» не входит.
    const reached =
      row.row_status === 'ready' ? STAGES.length - 1 : row.row_status === 'processing' || row.row_status === 'doubtful' ? idx : idx - 1;
```

- [ ] **Step 2: export — вид doubtful и колонки сомнений**

Импорт типов: `import { DOUBT_LABELS, REASON_LABELS, STAGE_LABELS, type DoubtCode, type Stage } from '@/lib/polzaRuOutreach/types';`

После `const list = …` добавить:

```ts
const doubts = (r: Row) =>
  Array.isArray(r.doubt_flags) ? (r.doubt_flags as string[]).map((f) => DOUBT_LABELS[f as DoubtCode] ?? f).join('; ') : '';
```

В `READY_COLUMNS` после `{ header: 'priority_score', … }` добавить:

```ts
  { header: 'doubts', value: doubts, width: 24 },
  { header: 'doubt_detail', value: field('doubt_detail'), width: 40 },
  { header: 'route_reason', value: field('route_reason'), width: 40 },
```

В `JOURNAL_COLUMNS` после `{ header: 'qa_flags', … }` добавить те же три колонки плюс `{ header: 'route_runner_up', value: field('route_runner_up') }`.

Выбор вида:

```ts
  const rawKind = req.nextUrl.searchParams.get('kind');
  const kind: 'ready' | 'journal' | 'doubtful' = rawKind === 'journal' ? 'journal' : rawKind === 'doubtful' ? 'doubtful' : 'ready';
```

Фильтр в цикле: после строки для `ready` добавить `if (kind === 'doubtful') q = q.eq('row_status', 'doubtful');`.
Блок кейсов: `if (kind === 'ready') {` → `if (kind !== 'journal') {`.
`const columns = kind === 'journal' ? JOURNAL_COLUMNS : READY_COLUMNS;`
Имя листа: `kind === 'ready' ? 'Готовые' : kind === 'doubtful' ? 'Очень спорные' : 'Журнал'`; то же слово в `filename*` (`'готовые' | 'очень спорные' | 'журнал'`).
Комментарий-шапку дополнить строкой ` * ?kind=doubtful — очень спорные: те же колонки, что у готовых; в Instantly не идут без решения человека.`

- [ ] **Step 3: Lint и commit**

Run: `npx eslint "src/app/api/tools/polza-ru-outreach/[jobId]/results/route.ts" "src/app/api/tools/polza-ru-outreach/[jobId]/export/route.ts"`

```bash
git add "src/app/api/tools/polza-ru-outreach/[jobId]"
git commit -m "feat(polza-ru-outreach): очень спорные в API и отдельной выгрузке, причина оффера в Excel"
```

---

### Task 13: Общий компонент шагов (EN → общий)

**Files:**
- Create: `app/src/components/parsers/OutreachStages.tsx`
- Modify: `app/src/components/parsers/PolzaOutreachStages.tsx`

- [ ] **Step 1: Вынести визуал**

Создать `OutreachStages.tsx`: перенести из `PolzaOutreachStages.tsx` без изменений `StageState`, `MARKER_CLASS`, `ROW_CLASS`, `Marker` и JSX карточки; параметризовать списком этапов:

```tsx
'use client';

import { AlertCircle, Check, Loader2 } from 'lucide-react';

/**
 * Конвейер аутрича как цепочка этапов (общий для английского и русского).
 * Смысл и история решения — в шапке PolzaOutreachStages.tsx.
 */

export type StageState = 'done' | 'active' | 'error' | 'stopped' | 'pending';

export interface StageView {
  label: string;
  hint: string;
  count: number;
}

// MARKER_CLASS и ROW_CLASS — перенести как есть из PolzaOutreachStages.tsx (вместе с комментарием про рамку).

/** Первый этап с нулём — текущий (или вставший). Правило из PolzaOutreachStages. */
export function stageStatesFromCounts(counts: number[], run: { running: boolean; failed: boolean } | null): StageState[] {
  let frontier = counts.findIndex((value) => value === 0);
  if (frontier === -1) frontier = counts.length;
  return counts.map((_, index) => {
    if (index < frontier) return 'done';
    if (index > frontier) return 'pending';
    if (run?.failed) return 'error';
    if (run?.running) return 'active';
    return run ? 'stopped' : 'pending';
  });
}

// Marker — перенести как есть.

export function OutreachStages({
  stages,
  run,
  error,
  onOpenStage,
}: {
  stages: StageView[];
  run: { running: boolean; failed: boolean } | null;
  error?: string | null;
  onOpenStage?: (index: number) => void;
}) {
  const counts = stages.map((s) => s.count);
  const states = stageStatesFromCounts(counts, run);
  // JSX — из PolzaOutreachStages без изменений, с заменой STAGES.map → stages.map
  // и stage.key → index в key у <li>.
}
```

JSX-разметку (`<div className="rounded-xl …">` … `</ol></div>`) перенести целиком из `PolzaOutreachStages.tsx:123-185`, заменив `STAGES.map((stage, index)` на `stages.map((stage, index)` и `<li key={stage.key}>` на `<li key={index}>`.

- [ ] **Step 2: Английская обёртка**

В `PolzaOutreachStages.tsx` оставить шапку-комментарий, `STAGES`, `POLZA_STAGE_LABELS`, `stageStates` (переписать через общий) и компонент-обёртку; удалить перенесённые `MARKER_CLASS`, `ROW_CLASS`, `Marker`, JSX:

```tsx
import { OutreachStages, stageStatesFromCounts, type StageState } from './OutreachStages';

export function stageStates(funnel: PolzaOutreachFunnel | null | undefined, run: { running: boolean; failed: boolean } | null): StageState[] {
  return stageStatesFromCounts(STAGES.map((stage) => (funnel ? Number(funnel[stage.key] ?? 0) : 0)), run);
}

export function PolzaOutreachStages({ funnel, run, error, onOpenStage }: { /* те же пропсы, что сейчас */ }) {
  return (
    <OutreachStages
      stages={STAGES.map((s) => ({ label: s.label, hint: s.hint, count: funnel ? Number(funnel[s.key] ?? 0) : 0 }))}
      run={run}
      error={error}
      onOpenStage={onOpenStage}
    />
  );
}
```

Импорт `lucide-react` из обёртки убрать, если больше не используется.

- [ ] **Step 3: Lint и commit**

Run: `npx eslint src/components/parsers/OutreachStages.tsx src/components/parsers/PolzaOutreachStages.tsx`

```bash
git add src/components/parsers/OutreachStages.tsx src/components/parsers/PolzaOutreachStages.tsx
git commit -m "refactor(outreach): шаги конвейера — общий компонент для английского и русского аутрича"
```

---

### Task 14: Русские шаги и окно этапа

**Files:**
- Create: `app/src/components/polzaRuOutreach/Stages.tsx`

- [ ] **Step 1: Компонент**

```tsx
'use client';

import { useEffect, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { OutreachStages } from '@/components/parsers/OutreachStages';
import { CHAIN_LABELS, REASON_LABELS, STAGES, type ChainType, type Stage } from '@/lib/polzaRuOutreach/types';
import { API, api, STATUS_LABELS, type RuRow } from './shared';

/**
 * Шаги «Нашего автоаутрича» — как у английского: где работа сейчас, сколько
 * прошло и отсеялось, и по клику — кто именно и почему.
 */

export const RU_STAGE_VIEW: Array<{ keys: Stage[]; label: string; hint: string }> = [
  { keys: ['candidates_loaded'], label: 'Кандидаты', hint: 'Компании из выбранных источников: одна компания — одна карточка со всеми поводами' },
  { keys: ['amo_checked'], label: 'Проверка AMO', hint: 'Открытые сделки, клиенты и свежие отказы не пишем; вакансии hh проверены вживую' },
  { keys: ['company_resolved'], label: 'Компания и сайт', hint: 'Нашли официальный сайт компании' },
  { keys: ['deduplicated'], label: 'Без повторов', hint: 'Нет повторов в запуске и в прошлых выгрузках' },
  { keys: ['enriched'], label: 'Сайт и поводы', hint: 'Разбор сайта: B2B, исключения, события; новости и отчётность ФНС' },
  { keys: ['scored'], label: 'Оценка', hint: 'Похожесть, размер, выбор оффера и оценка 0–100 не ниже порога' },
  { keys: ['recipient_resolved'], label: 'Почта', hint: 'Корпоративная почта на сайте, не в стоп-листе' },
  { keys: ['sequence_assembled', 'qa_checked'], label: 'Письма и проверка', hint: 'Цепочка собрана и прошла автоматическую проверку' },
  { keys: ['ready'], label: 'Готово', hint: 'Идут в Excel для Instantly; очень спорные — в отдельной вкладке' },
];

const MODAL_PAGE = 500;
const MODAL_MAX_ROWS = 5000;

function passedDetail(row: RuRow): string {
  return [
    row.normalized_domain,
    row.chain_type ? CHAIN_LABELS[row.chain_type as ChainType] : null,
    row.priority_score != null ? `оценка ${row.priority_score}` : null,
    row.recipient_email,
  ].filter(Boolean).join(' · ');
}

function StageModal({ jobId, viewIndex, onClose }: { jobId: string; viewIndex: number; onClose: () => void }) {
  const view = RU_STAGE_VIEW[viewIndex];
  const [rows, setRows] = useState<RuRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const all: RuRow[] = [];
      for (let offset = 0; offset < MODAL_MAX_ROWS; offset += MODAL_PAGE) {
        const page = await api<{ items: RuRow[]; count: number }>(`${API}/${jobId}/results?limit=${MODAL_PAGE}&offset=${offset}`);
        all.push(...page.items);
        if (all.length >= page.count || page.items.length < MODAL_PAGE) break;
      }
      if (!cancelled) setRows(all);
    })().catch((e) => !cancelled && setError(e instanceof Error ? e.message : 'Ошибка загрузки'));
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  const lastIdx = Math.max(...view.keys.map((k) => STAGES.indexOf(k)));
  const dropped = (rows ?? []).filter((r) => view.keys.includes(r.pipeline_stage as Stage) && r.row_status !== 'ready' && r.row_status !== 'processing');
  const passed = (rows ?? []).filter((r) => r.row_status === 'ready' || STAGES.indexOf(r.pipeline_stage as Stage) > lastIdx);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={onClose}>
      <div className="max-h-[85vh] w-full max-w-3xl overflow-y-auto rounded-2xl bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4">
          <h3 className="text-lg font-semibold text-gray-900">{view.label}</h3>
          <button type="button" onClick={onClose} className="rounded p-1 text-gray-400 hover:text-gray-700" aria-label="Закрыть">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="space-y-5 px-6 py-4 text-sm">
          {error && <div className="text-red-600">{error}</div>}
          {!rows && !error && <Loader2 className="h-5 w-5 animate-spin text-gray-400" />}
          {rows && (
            <>
              <section>
                <div className="mb-2 font-medium text-gray-900">Не прошли здесь · {dropped.length}</div>
                {dropped.length === 0 ? (
                  <div className="text-gray-500">Никто.</div>
                ) : (
                  <ul className="divide-y divide-gray-100">
                    {dropped.slice(0, 300).map((r) => (
                      <li key={r.id} className="py-1.5">
                        <span className="text-gray-900">{r.company_brand ?? r.company_name}</span>
                        <span className="ml-2 text-gray-500">
                          {r.row_status === 'doubtful'
                            ? `очень спорная: ${r.doubt_detail ?? ''}`
                            : `${r.reason_code ? REASON_LABELS[r.reason_code] ?? r.reason_code : STATUS_LABELS[r.row_status]}${r.reason_detail ? ` — ${r.reason_detail}` : ''}`}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <section>
                <div className="mb-2 font-medium text-gray-900">Прошли дальше · {passed.length}</div>
                <ul className="divide-y divide-gray-100">
                  {passed.slice(0, 300).map((r) => (
                    <li key={r.id} className="py-1.5">
                      <span className="text-gray-900">{r.company_brand ?? r.company_name}</span>
                      <span className="ml-2 text-gray-500">{passedDetail(r)}</span>
                    </li>
                  ))}
                </ul>
                {passed.length > 300 && <div className="mt-1 text-xs text-gray-500">Показаны первые 300 — полный список в Excel-журнале.</div>}
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function RuStages({
  jobId,
  funnel,
  run,
  error,
}: {
  jobId: string | null;
  funnel: Record<Stage, number> | null;
  run: { running: boolean; failed: boolean } | null;
  error?: string | null;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const stages = RU_STAGE_VIEW.map((v) => ({ label: v.label, hint: v.hint, count: funnel ? funnel[v.keys[v.keys.length - 1]] ?? 0 : 0 }));
  return (
    <>
      <OutreachStages stages={stages} run={run} error={error} onOpenStage={jobId ? setOpen : undefined} />
      {open !== null && jobId && <StageModal jobId={jobId} viewIndex={open} onClose={() => setOpen(null)} />}
    </>
  );
}
```

- [ ] **Step 2: shared.ts — типы строки и подписи**

В `RuJob.progress_detail` добавить:

```ts
    source_errors?: Record<string, string>;
    doubtful?: number;
```

В `RuRow`: `row_status` → `'processing' | 'ready' | 'rejected' | 'manual_review' | 'failed' | 'doubtful';` и поля:

```ts
  doubt_flags: string[];
  doubt_detail: string | null;
  route_reason: string | null;
  route_runner_up: string | null;
```

В `STATUS_LABELS` добавить `doubtful: 'очень спорная',`. В `SIGNAL_LABELS` добавить:

```ts
  sales_team: 'отдел продаж (2ГИС)',
  revenue_growth: 'рост выручки (ФНС)',
  tender_won: 'выигранный тендер',
  investment: 'инвестиции',
  sales_hiring_broad: 'вакансия продаж (не SDR)',
```

- [ ] **Step 3: Lint и commit**

Run: `npx eslint src/components/polzaRuOutreach/Stages.tsx src/components/polzaRuOutreach/shared.ts`

```bash
git add src/components/polzaRuOutreach/Stages.tsx src/components/polzaRuOutreach/shared.ts
git commit -m "feat(polza-ru-outreach): шаги работы и окно «кто прошёл и почему»"
```

---

### Task 15: Экран — раскладка, вкладки, метки сомнений

**Files:**
- Modify: `app/src/components/polzaRuOutreach/PolzaRuOutreachView.tsx`
- Modify: `app/src/components/polzaRuOutreach/Results.tsx`

- [ ] **Step 1: Results.tsx — причины вместо воронки, метки**

Функцию `Funnel` заменить на `Reasons` — только правая карточка «Почему отсеялись» (тот же JSX без левой «Воронки» и без обёртки-сетки):

```tsx
export function Reasons({ reasons, onReason }: { reasons: Record<string, number> | null; onReason: (code: string) => void }) {
  const sortedReasons = Object.entries(reasons ?? {}).sort((a, b) => b[1] - a[1]);
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      {/* заголовок «Почему отсеялись» и список кнопок — из прежнего Funnel без изменений */}
    </div>
  );
}
```

Из импортов убрать `STAGES`, `STAGE_LABELS`, `type Stage`, если больше не нужны; добавить `DOUBT_LABELS, type DoubtCode`.
`STATUS_TONE` дополнить `doubtful: 'bg-orange-50 text-orange-700',`.

В ячейке «Статус» таблицы после `<span …>{STATUS_LABELS[row.row_status]}</span>` добавить:

```tsx
                    {row.doubt_flags?.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {row.doubt_flags.map((f) => (
                          <span key={f} className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-800">
                            {DOUBT_LABELS[f as DoubtCode] ?? f}
                          </span>
                        ))}
                      </div>
                    )}
```

В `Details` после блока скоринга добавить:

```tsx
        {row.route_reason && (
          <div className="text-gray-800">
            Почему этот оффер: <span className="text-gray-600">{row.route_reason}</span>
            {row.route_runner_up ? <span className="text-gray-500"> · второй вариант: {row.route_runner_up}</span> : null}
          </div>
        )}
        {row.doubt_detail && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-900">
            <b>Сомнения:</b> {row.doubt_detail}
          </div>
        )}
```

- [ ] **Step 2: View — фильтры**

```ts
type Filter = 'ready' | 'doubtful' | 'manual_review' | 'rejected' | 'all';

const FILTERS: Array<[Filter, string]> = [
  ['ready', 'Готовые'],
  ['doubtful', 'Очень спорные'],
  ['manual_review', 'Ручная проверка'],
  ['rejected', 'Отсеянные'],
  ['all', 'Все'],
];
```

`exportFile` принимает `'ready' | 'journal' | 'doubtful'`. После кнопки «Excel: готовые» добавить кнопку «Excel: очень спорные» (стиль как у «Excel: журнал», `onClick={() => void exportFile('doubtful')}`, спиннер при `exporting === 'doubtful'`).

- [ ] **Step 3: View — раскладка как у английского**

Импорты: `import { Reasons, ResultsTable } from './Results';` и `import { RuStages } from './Stages';`.

Внутри ветки `tab === 'launch'` после `<LaunchForm … />` заменить остальную разметку на сетку:

```tsx
          <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[380px_minmax(0,1fr)]">
            {/* ЛЕВАЯ КОЛОНКА: карточка «Запуски» — существующий JSX без изменений, но max-h-64 → max-h-[70vh] */}
            <div className="min-w-0 space-y-4">
              {!active ? (
                <div className="rounded-xl border border-gray-200 bg-white p-6 text-sm text-gray-500">Выберите запуск слева или запустите новый.</div>
              ) : (
                <>
                  {/* строка статуса и кнопки — существующий JSX */}
                  {detail?.source_errors && Object.keys(detail.source_errors).length > 0 && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                      Источники с ошибкой (запуск шёл без них):{' '}
                      {Object.entries(detail.source_errors).map(([code, msg]) => `${SOURCE_LABELS[code as SourceCode] ?? code}: ${msg}`).join(' · ')}
                    </div>
                  )}
                  {/* плашки цепочек и SDR-абзац — существующий JSX */}
                  <RuStages
                    jobId={active.id}
                    funnel={results?.funnel ?? null}
                    run={{ running, failed: active.status === 'failed' }}
                    error={active.error_message}
                  />
                  <Reasons
                    reasons={results?.reason_counts ?? null}
                    onReason={(code) => {
                      setReason(code);
                      setPage(1);
                    }}
                  />
                  {/* фильтры, ResultsTable, пагинация — существующий JSX */}
                </>
              )}
            </div>
          </div>
```

Добавить импорт `SOURCE_LABELS, type SourceCode` из `@/lib/polzaRuOutreach/types`. Удалить импорт `Funnel`.
В строке списка запусков `Запуск на {j.config?.limit}` не трогать; в строке статуса активного запуска после `в пуле …` добавить `{detail?.doubtful ? ` · очень спорных ${detail.doubtful}` : ''}`.

- [ ] **Step 4: Lint и commit**

Run: `npx eslint src/components/polzaRuOutreach/PolzaRuOutreachView.tsx src/components/polzaRuOutreach/Results.tsx`

```bash
git add src/components/polzaRuOutreach/PolzaRuOutreachView.tsx src/components/polzaRuOutreach/Results.tsx
git commit -m "feat(polza-ru-outreach): экран как у английского — запуски слева, шаги и результаты справа, вкладка очень спорных"
```

---

### Task 16: Форма — ползунки, новые источники, лимит

**Files:**
- Modify: `app/src/components/polzaRuOutreach/LaunchForm.tsx`

- [ ] **Step 1: Состояние и отправка**

Импорты из types дополнить `DEFAULT_MIN_TA_SCORE, DEFAULT_WRITE_THRESHOLD, MAX_FRESHNESS_DAYS`.
`const [write, setWrite] = useState(70);` → `useState(DEFAULT_WRITE_THRESHOLD)`; добавить `const [minTa, setMinTa] = useState(DEFAULT_MIN_TA_SCORE);`.
В `submit` после `write_threshold: write,` добавить `min_ta_score: minTa,`.

- [ ] **Step 2: Компонент ползунка**

Над `export function LaunchForm` добавить:

```tsx
function Slider({
  title,
  hint,
  value,
  min,
  max,
  step = 1,
  suffix = '',
  onChange,
}: {
  title: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-sm font-medium text-gray-700">{title}</span>
        <span className="text-sm font-semibold tabular-nums text-violet-700">
          {value}
          {suffix}
        </span>
      </div>
      <input type="range" className="w-full accent-violet-600" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <p className="mt-1 text-xs text-gray-500">{hint}</p>
    </div>
  );
}
```

- [ ] **Step 3: Разметка**

Удалить поле «Свежесть повода, дней» из сетки из 4 полей и блок «Пишем от скоринга» (`<div className="mt-5 max-w-xs">…</div>`); вместо них после сетки вставить:

```tsx
      <div className="mt-5 grid grid-cols-1 gap-5 sm:grid-cols-3">
        <Slider title="Пишем от оценки" hint="Оценка компании 0–100. Ниже — отсев." value={write} min={0} max={100} onChange={setWrite} />
        <Slider
          title="Похожесть на клиента от"
          hint="Балл 0–10 по сайту. Ниже — отсев из любого источника; «Только профиль» — не ниже 7."
          value={minTa}
          min={0}
          max={10}
          onChange={setMinTa}
        />
        <Slider title="Свежесть повода" hint="Повод старше — не повод." value={freshness} min={7} max={MAX_FRESHNESS_DAYS} suffix=" дн." onChange={setFreshness} />
      </div>
```

Блок «Общая база: размер компаний» вынести из-под `{sources.includes('directory') && (…)}` (показывать всегда) и переименовать заголовок в «Размер компаний (для всех источников)»; под сеткой полей добавить `<p className="mt-1 text-xs text-gray-500">Известный размер вне рамок — отсев. Неизвестный — компания проходит с пометкой «Сомнения в компании».</p>`.

Поле «Сколько готовых компаний»: подпись `Сколько готовых компаний` оставить, под инпутом добавить `<p className="mt-1 text-xs text-gray-500">Готовые уходят в Instantly. На 500 запуск идёт несколько часов и заметно дороже по ИИ.</p>`.

Вступительный абзац заменить на:

```tsx
      <p className="max-w-4xl text-sm text-gray-600">
        Система сравнивает все поводы компании и выбирает лучший оффер: {CHAIN_TYPES.map((c) => CHAIN_LABELS[c]).join(', ')}.
        «Возврат» — всегда первый, если с компанией уже говорили. Открытые сделки и клиенты из AMO пропускаются. Спорные компании
        помечаются, очень спорные уходят в отдельную вкладку и в Instantly не попадают.
      </p>
```

Подсказку под источниками дополнить: `Тендеры — из файлов «Библиотек». Новости и рост выручки проверяются у каждой компании и удлиняют запуск.`

- [ ] **Step 4: Lint и commit**

Run: `npx eslint src/components/polzaRuOutreach/LaunchForm.tsx`

```bash
git add src/components/polzaRuOutreach/LaunchForm.tsx
git commit -m "feat(polza-ru-outreach): ползунки порогов и размер для всех источников"
```

---

### Task 17: Общая проверка и push

- [ ] **Step 1: Типы**

Run: `npm run typecheck:strict`
Expected: без ошибок. Типичные поломки: другие вызовы `collectCandidates` (ожидают массив — теперь `{ pool }`), `Record<RowStatus, …>` без `doubtful`, `Record<SourceCode, …>` без новых кодов. Найти: `npx rg -n "collectCandidates|Record<RowStatus|Record<SourceCode" src`.

- [ ] **Step 2: Lint всего изменённого**

Run: `npx eslint src/lib/polzaRuOutreach src/components/polzaRuOutreach src/components/parsers/OutreachStages.tsx src/components/parsers/PolzaOutreachStages.tsx src/app/api/tools/polza-ru-outreach`
Expected: без ошибок.

- [ ] **Step 3: Существующий набор тестов**

Run: `npx jest --silent`
Expected: PASS (новых тестов нет).

- [ ] **Step 4: Сверка со спецификацией**

Пройти разделы 1–6 спецификации и отметить, где реализовано; расхождения — поправить или записать в отчёт пользователю.

- [ ] **Step 5: Push**

```bash
git push origin dmitriy_kuladmed_new
```

Отчёт пользователю: ветка, SHA, что проверено (типы, линт, jest), что не проверено вживую (LLM, ФНС и Google News с прод-сервера, RPC ЯКарт на объёме каталога), и что миграция `20260925_0001` применится автоматически при деплое.
