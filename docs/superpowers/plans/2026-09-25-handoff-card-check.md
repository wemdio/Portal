# Проверка карточки AMO при передаче проекта — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Бот в ветке «Передача проектов» проверяет карточку AMO по ссылке из сообщения и отвечает только при проблемах.

**Architecture:** Чистая логика в `app/src/lib/handoffCheck/` (разбор, проверки, тексты), ввод-вывод там же отдельными модулями (AMO API, таблица, Telegram), воркер `app/worker/handoffCheckBot.ts` с long polling и ежедневной перепроверкой. Спека: `docs/superpowers/specs/2026-09-25-handoff-card-check-design.md` — читать целиком перед любой задачей.

**Tech Stack:** TypeScript, Supabase (Postgres), Telegram Bot API (fetch), AMO REST API v4, esbuild-воркеры, docker compose.

**Правила репозитория:** новых `*.test.ts` не заводим; dev-сервер не поднимаем; коммит в `dmitriy_kuladmed_new`, без push; не трогать и не стейджить чужие файлы (`services/health-check/main.py`, `.superpowers/`). Команды — из `/g/PycharmProjects/Portal/app`.

---

### Task 1: Миграция

**Files:** Create `supabase/migrations/20260925_0002_handoff_card_checks.sql`

- [ ] Таблица:

```sql
-- Проверка карточки AMO при передаче проекта (спека 2026-09-25-handoff-card-check-design.md).
create table if not exists public.handoff_card_checks (
  id uuid primary key default gen_random_uuid(),
  chat_id bigint not null,
  message_id bigint not null,
  thread_id bigint,
  amo_id bigint,
  message_text text,
  author text,
  stated_amount numeric(14,2),
  stated_source text,
  status text not null check (status in ('ok', 'problems', 'no_link', 'resolved', 'expired')),
  problems jsonb not null default '[]'::jsonb,
  reply_message_id bigint,
  first_checked_at timestamptz not null default now(),
  last_checked_at timestamptz not null default now(),
  reminded_at timestamptz,
  resolved_at timestamptz,
  unique (chat_id, message_id)
);
create index if not exists idx_handoff_card_checks_open
  on public.handoff_card_checks(status, first_checked_at) where status in ('problems', 'no_link');
alter table public.handoff_card_checks enable row level security;
grant all on public.handoff_card_checks to service_role;

-- Другие сделки воронки с тем же ИНН: при дубле платёж станет «спорным» и
-- не отнесётся ни к одной сделке (та же нормализация, что в first_sales_payments).
create or replace function public.handoff_inn_duplicates(p_pipeline_id bigint, p_inn text, p_exclude_amo_id bigint)
returns table (amo_id bigint, name text)
language sql
stable
set statement_timeout = '15s'
as $$
  select l.amo_id, l.name
  from public.amo_leads l
  where l.pipeline_id = p_pipeline_id
    and l.amo_id <> p_exclude_amo_id
    and public.norm_inn(public.amo_custom_field_value(l.raw, 'ИНН')) = p_inn
  limit 10;
$$;
revoke all on function public.handoff_inn_duplicates(bigint, text, bigint) from public;
grant execute on function public.handoff_inn_duplicates(bigint, text, bigint) to service_role;
```

- [ ] Проверить, что `public.norm_inn(text)` и `public.amo_custom_field_value(jsonb, text)` существуют с такими сигнатурами (`grep -rn "function public.norm_inn\|function public.amo_custom_field_value" supabase/migrations`); поправить вызов под фактическую сигнатуру. `amo_leads.pipeline_id`/`amo_id` — тип проверить в `20260706_0003_create_external_sync_tables.sql`.
- [ ] `npx jest tests/migrations --silent` → PASS. Commit `feat(handoff-check): таблица проверок и поиск дублей ИНН`.

---

### Task 2: Разбор сообщения

**Files:** Create `app/src/lib/handoffCheck/parseHandoff.ts`

- [ ] Реализовать:

```ts
/**
 * Разбор сообщения из ветки «Передача проектов». Пример — в спеке. Сообщение
 * пишут руками по шаблону, поэтому разбор терпим к пробелам, регистру и «к»/«k».
 */
export interface ParsedHandoff {
  isHandoff: boolean;
  amoId: number | null;
  amoUrl: string | null;
  /** Рубли из «Стоимость: …»; null — не нашли или не разобрали. */
  statedAmount: number | null;
  /** Текст из «Откуда лид: …». */
  statedSource: string | null;
}

const MARKERS = [/(^|\n)\s*продажа\s*($|\n)/i, /стоимость\s*:/i, /кто\s+завел\s*:/i, /откуда\s+лид\s*:/i, /ссылка\s+на\s+амо/i];
const AMO_LINK = /https?:\/\/[a-z0-9-]+\.amocrm\.(?:ru|com)\/leads\/detail\/(\d+)/i;

export function parseAmount(raw: string): number | null { /* «259k», «259 к», «179 000», «1,2 млн», «250 тыс», «259000 руб» → рубли; иначе null */ }
export function parseHandoff(text: string): ParsedHandoff { /* isHandoff = ≥2 маркера; amo по AMO_LINK; stated* — из строк «Стоимость:» и «Откуда лид:» (до конца строки) */ }
```

`parseAmount`: первое число строки (запятая = десятичный разделитель, пробелы внутри числа убрать); множитель по суффиксу сразу после числа: `k|к|тыс` ×1000, `млн|m|м` ×1 000 000; без суффикса — как есть. Число ≤ 0 → null.

- [ ] Проверить руками на двух примерах из спеки одноразовым `npx tsx -e` из scratchpad (не коммитить): `259k` → 259000, ссылка → 34873741, «Откуда лид: coldy» → `coldy`. Eslint. Commit `feat(handoff-check): разбор сообщения о передаче проекта`.

---

### Task 3: Проверки карточки и тексты

**Files:** Create `app/src/lib/handoffCheck/checkCard.ts`, `app/src/lib/handoffCheck/formatReply.ts`

- [ ] `checkCard.ts` — чистая функция без I/O:

```ts
export interface CardData {
  found: boolean;
  pipelineId: number | null;
  statusId: number | null;
  statusName: string | null;   // из amo_statuses, для текста
  pipelineName: string | null;
  price: number | null;        // бюджет AMO
  responsibleUserId: number | null;
  inn: string | null;          // сырое значение поля «ИНН»
  source: string | null;       // значение поля «Источник»
  innDuplicates: Array<{ amoId: number; name: string | null }>;
}
export type ProblemCode = 'NOT_FOUND' | 'WRONG_PIPELINE' | 'NOT_WON' | 'NO_INN' | 'BAD_INN' | 'INN_DUPLICATE'
  | 'NO_SOURCE' | 'SOURCE_MISMATCH' | 'NO_BUDGET' | 'BUDGET_MISMATCH' | 'NO_RESPONSIBLE';
export interface Problem { code: ProblemCode; text: string }
export function checkCard(card: CardData, stated: { amount: number | null; source: string | null }, firstSalesPipelineId: number): Problem[]
```

Правила — спека §5. ИНН нормализовать `normalizeInn` из `@/lib/firstSales/money` (не дублировать). Бюджет: `price` null/0 → `NO_BUDGET`; иначе при `stated.amount` и `|price − amount| / amount > 0.01` → `BUDGET_MISMATCH` с обеими суммами. Источник: пусто → `NO_SOURCE`; иначе `canonicalSource(stated.source)` (словарь ниже) и если он не null и ≠ нормализованному `card.source` → `SOURCE_MISMATCH`.

Словарь синонимов (ключ — значение «Источник» из AMO, сравнение по нормализованной строке: нижний регистр, ё→е, без пробелов/дефисов/пунктуации; синоним совпадает, если нормализованный «Откуда лид» содержит его):
- `Сайт`: сайт, заявкассайта, форма
- `Лидскан`: лидскан, leadscan
- `Партнер`: партнер, партнёр
- `Email Outreach`: emailoutreach, email, имейл, почта
- `Telegram Outreach`: telegramoutreach, tgoutreach, тгаутрич
- `Аутрич`: аутрич, outreach (после двух выше — порядок проверки важен)
- `Сарафан`: сарафан, рекомендац
- `Конференция`: конференц, выставк
- `SEO`: seo, сео
- `Meta Ads`: meta, facebook, инстаграмреклам
- `Яндекс Директ`: директ, direct
Неизвестное → null (не проверяем).

- [ ] `formatReply.ts`: 
  - `problemsReply(problems, amoUrl)`: «⚠️ Сделка не попадёт в первичку / деньги не посчитаются:\n• …\n• …\n\nСделка: <url>»;
  - `noLinkReply()`: «⚠️ В сообщении нет ссылки на сделку AMO — добавьте «Ссылка на амо: …», иначе проверить карточку нельзя.»;
  - `reminderReply(problems, amoUrl)`: «⏰ Напоминание: карточка всё ещё не заполнена:\n• …»;
  - `resolvedReply()`: «✅ Карточка дозаполнена».
  Без parse_mode (обычный текст) — не нужно экранирование. Суммы — `toLocaleString('ru-RU')` + « ₽».
- [ ] Прогнать `checkCard` одноразово на двух реальных сделках из спеки с данными из read-only БД (34873741 — должно быть 0 проблем при stated source «coldy»; 35353409 — NOT_WON, NO_INN, NO_BUDGET/ BUDGET_MISMATCH). Eslint. Commit `feat(handoff-check): проверки карточки и тексты ответов`.

---

### Task 4: Ввод-вывод — AMO, таблица, Telegram

**Files:** Create `app/src/lib/handoffCheck/amoApi.ts`, `app/src/lib/handoffCheck/store.ts`; Modify `app/src/lib/tgBot/telegramClient.ts`

- [ ] `amoApi.ts`: `fetchCard(db, amoId): Promise<CardData>` —
  `GET ${AMO_BASE_URL}/api/v4/leads/${amoId}` c `Authorization: Bearer ${AMO_ACCESS_TOKEN}`, таймаут 15 с. 204/404 → `found:false`. Поля: `pipeline_id`, `status_id`, `price`, `responsible_user_id`, `custom_fields_values[]` (`field_name` «ИНН», «Источник», `values[0].value`). Имена этапа/воронки — из `amo_statuses` по (`pipeline_id`,`status_id`). Дубли ИНН — `db.rpc('handoff_inn_duplicates', …)` только при валидном ИНН. Посмотреть, как Python-синк строит URL и заголовки (`services/portal-external-sync/sources/amo.py`) и повторить; `AMO_BASE_URL` может быть с/без `/` на конце.
- [ ] `store.ts`: `getCheck(db, chatId, messageId)`, `upsertCheck(db, row)`, `listOpen(db)` (status in problems/no_link), типы строк таблицы.
- [ ] `telegramClient.ts` (обратно совместимо — старые вызовы не менять):
  - тип `TelegramUpdate` дополнить `edited_message`, `message.message_thread_id`, `message.chat.id`, `message.caption`, `message.date`;
  - `getUpdates(token, offset, allowedUpdates = ['message'])`;
  - `sendMessage` — необязательные `messageThreadId`, `replyToMessageId` (через `reply_parameters: { message_id, allow_sending_without_reply: true }`), `disableWebPagePreview`; возвращать `{ message_id }` (тип `Promise<{ message_id: number }>`; существующие вызовы результат игнорируют);
  - `getWebhookInfo(token): Promise<{ url: string }>`.
- [ ] `npx tsc --noEmit -p tsconfig.typecheck.core.json`, eslint. Commit `feat(handoff-check): чтение сделки из AMO, хранилище проверок, ответы в ветку`.

---

### Task 5: Воркер

**Files:** Create `app/worker/handoffCheckBot.ts`

- [ ] По образцу `app/worker/leadsReportBot.ts` (`createWorkerLogger`, `requireSupabaseAdmin`, `setupGracefulShutdown`, `sleep`):
  - env: `HANDOFF_BOT_TOKEN`, `HANDOFF_CHAT_ID` (дефолт `-1001852890744`), `HANDOFF_THREAD_ID` (дефолт `3781`), `FIRST_SALES_PIPELINE_ID` (дефолт `7670334`), `AMO_BASE_URL`, `AMO_ACCESS_TOKEN`;
  - нет токена → лог warn и сон по часу в цикле (не падать);
  - старт: `getWebhookInfo`; `url` не пустой → `sendWorkerAlert` («у бота стоит webhook, чтение ветки не запущено») и сон по часу;
  - цикл `getUpdates(offset, ['message','edited_message'])`; 409 → алерт один раз, сон 5 мин; прочие ошибки → лог, сон 10 с;
  - обработка: только `chat.id === HANDOFF_CHAT_ID && message_thread_id === HANDOFF_THREAD_ID`; текст = `text ?? caption`; `parseHandoff`; не передача → игнор;
  - новое сообщение (строки нет): нет ссылки → ответ `noLinkReply`, строка `no_link`; есть → `fetchCard` + `checkCard`; пусто → строка `ok` без ответа; проблемы → ответ `problemsReply`, строка `problems` с `reply_message_id`;
  - `edited_message`: перепроверка; было `problems|no_link` и стало чисто → `resolvedReply`, статус `resolved`; проблемы изменились → новый `problemsReply`; было `ok` и появились проблемы → `problemsReply`;
  - сбой AMO (сеть, 5xx, 401 — не 404) → строка `status='problems'`, `problems=[{code:'AMO_UNAVAILABLE', text:'не удалось прочитать сделку из AMO'}]`, БЕЗ ответа в чат (`reply_message_id` null); ежедневная перепроверка обработает её как новую. `AMO_UNAVAILABLE` добавить в `ProblemCode`; в чат такие проблемы не отправляются никогда.
  - ежедневный проход в 10:00 МСК (проверять раз в минуту `new Date()` в `Europe/Moscow`, запоминать дату последнего прохода в памяти + колонка `last_checked_at`): для `listOpen`: старше 14 дней → `expired`; `no_link` — пропустить (ждём правку); иначе перепроверка: чисто → `resolvedReply` (только если `reply_message_id` был — иначе молча `ok`), статус `resolved`; всё ещё проблемы, ответа не было (AMO был недоступен) → `problemsReply`; ответ был, прошло ≥ 3 дня, `reminded_at` пуст → `reminderReply`, `reminded_at=now`.
  - все ответы — `sendMessage(..., { chatId, messageThreadId, replyToMessageId: message_id, disableWebPagePreview: true })`.
- [ ] Eslint, `npx tsc --noEmit -p tsconfig.typecheck.core.json`. Commit `feat(handoff-check): воркер проверки передачи проектов`.

---

### Task 6: Сборка и выкладка

**Files:** Modify `app/package.json` (`build:workers` и `build:workers:watch` — добавить `worker/handoffCheckBot.ts`), `docker-compose.prod.yml` (сервис `worker-handoff-check-bot` рядом с `worker-leads-report-bot`: образ `${DOCKER_USERNAME}/portal-worker:prod`, `command: ["node", "/app/workers/handoffCheckBot.js"]`, `env_file: .env`, environment: `NODE_ENV`, `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `HANDOFF_BOT_TOKEN=${HANDOFF_BOT_TOKEN:-}`, `AMO_BASE_URL=${AMO_BASE_URL:-}`, `AMO_ACCESS_TOKEN=${AMO_ACCESS_TOKEN:-}`, `TELEGRAM_HEALTH_BOT_TOKEN`, `TELEGRAM_HEALTH_CHAT_ID`; лимиты 256M / 0.25 cpu / pids 256; `restart: unless-stopped`; сеть `portal-network`; комментарий-шапка: что делает, спека, что нужно от человека — токен и приватность), `.semaphore/select-deploy-targets.sh` (`ALL_WORKER_SERVICES` + `worker-handoff-check-bot`), при необходимости `.semaphore/test-select-deploy-targets.sh` и другие места, где перечислены воркеры (grep `worker-leads-report-bot` по `.semaphore`, `deploy`, `app/tests` и повторить для нового сервиса).

- [ ] Прогнать `bash ../.semaphore/test-select-deploy-targets.sh` (если исполним под Git Bash) и `npx jest tests/architecture tests/lib --silent` → зафиксировать результат (ранее падавшие на Windows `baseConstructorDeployDrain`, `relevanceEvidenceIdentity`, `workerThreadpool` — не наши).
- [ ] `npm run build:workers` → собирается `dist/workers/handoffCheckBot.js`. Commit `ci(handoff-check): сборка и сервис воркера проверки передачи проектов`.

---

### Task 7: Итог

- [ ] `npm run typecheck:strict`, eslint по `src/lib/handoffCheck src/lib/tgBot worker/handoffCheckBot.ts`, `npx jest --silent`.
- [ ] Финальное ревью, push `dmitriy_kuladmed_new`, отчёт пользователю с инструкцией по выкладке (спека «Что нужно при выкладке»).
