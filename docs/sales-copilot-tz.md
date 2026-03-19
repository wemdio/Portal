# Sales Copilot — Техническое задание

## 1. Контекст

ОП (отдел продаж) ведёт переписку с клиентами через Telegram-аккаунты, которые управляются через модуль TG Outreach. Сейчас менеджеры сами придумывают что писать. Sales Copilot — AI-слой поверх этих переписок, который генерирует черновики ответов и предлагает реанимировать холодные диалоги.

### Ограничения из обсуждения

- Черновики в TG (drafts) допустимы только для **реактивного** сценария (ответ на входящее), т.к. чат уже наверху списка
- **Проактивный** сценарий (реанимация) — только через портал, чтобы не засорять список чатов в TG
- Copilot **не должен** помечать сообщения как прочитанные (использовать `getHistory` без `readHistory`)

---

## 2. Сценарии использования

### 2.1 Реактивный — ответ на входящее сообщение

**Триггер:** клиент написал новое сообщение в чат с аккаунтом ОП.

**Флоу:**
1. Worker мониторит входящие сообщения через TG API (`getDialogs` → проверка `unreadCount`)
2. При новом сообщении — забирает историю диалога (`getMessages`, **без** `readHistory`)
3. Отправляет контекст в LLM → получает черновик ответа
4. Сохраняет черновик в БД (`sales_copilot_drafts`)
5. Опционально: устанавливает draft в TG через API (`saveDraft`)
6. Менеджер видит черновик в портале (и/или в TG как draft)
7. Менеджер правит → отправляет (через портал или вручную из TG)

### 2.2 Проактивный — реанимация холодных диалогов

**Триггер:** диалог молчит дольше настроенного порога (напр. 7 дней).

**Флоу:**
1. Worker периодически сканирует диалоги с `last_message_at` старше порога
2. Отправляет историю + контекст в LLM с промптом для реанимации
3. Сохраняет черновик в БД
4. Менеджер заходит в портал → раздел "Холодные диалоги" → видит очередь черновиков
5. Менеджер ревьюит → правит → отправляет из портала
6. (Черновик в TG **не ставится** — чтобы не засорять список)

---

## 3. Архитектура

### 3.1 Подключение аккаунта менеджера

Менеджер подключает **свой рабочий** Telegram-аккаунт напрямую из страницы Sales Copilot:

1. Вводит номер телефона → получает код в Telegram
2. Вводит код → авторизация через GramJS (`sendCode` + `signIn`)
3. Если включена 2FA — дополнительно вводит облачный пароль
4. Session string сохраняется inline в `sales_copilot_configs.session_data`

Зависимость от `tg_pool_accounts` убрана — `account_id` nullable, для обратной совместимости.

**Общая инфраструктура:**
- GramJS (`telegram` package) для MTProto
- OpenRouter для LLM
- Supabase для хранения

**Новые сущности:**
- Таблица `sales_copilot_configs` — настройки + inline session менеджера
- Таблица `sales_copilot_drafts` — сгенерированные черновики
- Worker `salesCopilotWorker.ts` — фоновый процесс мониторинга
- Новая страница в портале — UI для менеджера
- API `/api/sales-copilot/auth/send-code` и `/api/sales-copilot/auth/verify-code` — авторизация

### 3.2 Схема работы

```
┌─────────────────────────────────────────────────────┐
│                  Sales Copilot Worker                │
│                                                     │
│  ┌─────────────┐    ┌─────────────┐                 │
│  │  Монитор    │    │  Сканер     │                 │
│  │  входящих   │    │  холодных   │                 │
│  │  (reactive) │    │  (proactive)│                 │
│  └──────┬──────┘    └──────┬──────┘                 │
│         │                  │                        │
│         ▼                  ▼                        │
│  ┌─────────────────────────────────┐                │
│  │         LLM (OpenRouter)        │                │
│  │    генерация черновика ответа   │                │
│  └──────────────┬──────────────────┘                │
│                 │                                   │
│         ┌───────┴───────┐                           │
│         ▼               ▼                           │
│  ┌────────────┐  ┌─────────────┐                    │
│  │ Сохранить  │  │ Поставить   │                    │
│  │ в БД       │  │ draft в TG  │                    │
│  │ (всегда)   │  │ (reactive)  │                    │
│  └────────────┘  └─────────────┘                    │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│                  Портал (UI)                        │
│                                                     │
│  ┌─────────────────────┐  ┌──────────────────────┐  │
│  │  Входящие черновики  │  │  Холодные диалоги    │  │
│  │  (реактивные)       │  │  (проактивные)       │  │
│  │                     │  │                      │  │
│  │  [Чат] [Черновик]   │  │  [Чат] [Черновик]    │  │
│  │  [Правка] [Отпр.]  │  │  [Правка] [Отпр.]   │  │
│  └─────────────────────┘  └──────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

---

## 4. Схема базы данных

### 4.1 `sales_copilot_configs`

Настройки copilot + inline session менеджера.

```sql
create table if not exists public.sales_copilot_configs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  account_id uuid,  -- nullable, для обратной совместимости с пулом

  -- Inline session (менеджер подключает свой TG-аккаунт)
  session_data jsonb,               -- { session_string: "..." }
  phone text not null default '',
  tg_first_name text not null default '',
  tg_username text not null default '',

  -- Общие настройки
  is_enabled boolean not null default false,
  llm_model text not null default 'openai/gpt-4o-mini',

  -- Реактивный сценарий
  reactive_enabled boolean not null default true,
  reactive_system_prompt text not null default '',
  reactive_set_tg_draft boolean not null default false,
  reactive_history_limit integer not null default 30,

  -- Проактивный сценарий (реанимация)
  proactive_enabled boolean not null default false,
  proactive_system_prompt text not null default '',
  proactive_silence_days integer not null default 7,
  proactive_max_drafts_per_scan integer not null default 10,

  -- Расписание
  scan_interval_seconds integer not null default 300,
  sleep_periods text[] not null default array['00:00-08:00'],
  timezone_offset integer not null default 3,

  -- Фильтры
  ignore_bots boolean not null default true,
  ignore_no_username boolean not null default true,
  excluded_chat_ids bigint[] not null default '{}',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

### 4.2 `sales_copilot_drafts`

Сгенерированные черновики.

```sql
create table if not exists public.sales_copilot_drafts (
  id uuid primary key default gen_random_uuid(),
  config_id uuid not null references public.sales_copilot_configs(id) on delete cascade,
  account_id uuid,  -- nullable, не используется в новом флоу

  -- Кому
  tg_user_id bigint not null,
  tg_username text,
  tg_display_name text,

  -- Черновик
  draft_text text not null,
  draft_type text not null check (draft_type in ('reactive', 'proactive')),
  status text not null default 'pending'
    check (status in ('pending', 'sent', 'edited_and_sent', 'dismissed', 'expired')),

  -- Контекст для отладки
  chat_history jsonb not null default '[]'::jsonb,
  last_incoming_text text,
  silence_days integer,

  -- Метаданные
  llm_model text,
  llm_tokens_used integer,
  tg_draft_set boolean not null default false,

  -- Действие менеджера
  edited_text text,
  acted_at timestamptz,

  created_at timestamptz not null default now(),
  expires_at timestamptz
);

create index sales_copilot_drafts_config_status_idx
  on public.sales_copilot_drafts (config_id, status)
  where status = 'pending';

create index sales_copilot_drafts_account_user_idx
  on public.sales_copilot_drafts (account_id, tg_user_id);
```

### 4.3 `sales_copilot_jobs`

Управление worker'ом (по аналогии с `tg_outreach_jobs`).

```sql
create table if not exists public.sales_copilot_jobs (
  id uuid primary key default gen_random_uuid(),
  config_id uuid not null references public.sales_copilot_configs(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  action text not null check (action in ('start', 'stop')),
  status text not null default 'pending'
    check (status in ('pending', 'running', 'completed', 'failed')),
  error_message text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
```

### 4.4 `sales_copilot_logs`

Логи работы copilot.

```sql
create table if not exists public.sales_copilot_logs (
  id bigint generated always as identity primary key,
  config_id uuid not null references public.sales_copilot_configs(id) on delete cascade,
  level text not null default 'info'
    check (level in ('info', 'warning', 'error')),
  message text not null,
  created_at timestamptz not null default now()
);
```

### 4.5 RLS-политики

Все таблицы — стандартная схема RLS через `user_id` (напрямую или через `sales_copilot_configs.user_id`). По аналогии с существующими таблицами `tg_outreach_*`.

---

## 5. Worker: `salesCopilotWorker.ts`

### 5.1 Основной цикл

```
1. Запрос pending jobs из sales_copilot_jobs
2. Для каждого config с is_enabled=true:
   a. Подключить GramJS-клиент (из tg_pool_accounts)
   b. Реактивный сканер:
      - getDialogs(limit: 30)
      - Для каждого диалога с unreadCount > 0:
        - getMessages (БЕЗ readHistory!)
        - Проверить: нет ли уже pending-черновика для этого чата
        - Отправить историю в LLM → получить черновик
        - Сохранить в sales_copilot_drafts (type='reactive')
        - Если reactive_set_tg_draft=true → saveDraft в TG
   c. Проактивный сканер:
      - Найти диалоги где последнее сообщение > proactive_silence_days назад
      - Для каждого (лимит proactive_max_drafts_per_scan):
        - Проверить: нет ли уже pending-черновика
        - Отправить историю + промпт реанимации в LLM
        - Сохранить в sales_copilot_drafts (type='proactive')
   d. Пауза scan_interval_seconds
3. Повторить
```

### 5.2 Критичные моменты

- **Не вызывать `readHistory`** — сообщения должны остаться непрочитанными для менеджера
- **Дедупликация** — не генерировать новый черновик если pending-черновик для этого чата уже есть
- **Expired** — помечать старые pending-черновики как expired (напр. через 24ч для reactive, 72ч для proactive)
- **Rate limits** — соблюдать задержки между запросами к TG API (аналогично `campaignLoop.ts`)
- **FloodWait** — обрабатывать `FloodWaitError` с cooldown (аналогично существующей логике)

### 5.3 TG Draft API

Установка черновика в Telegram (для реактивного сценария):

```typescript
// GramJS: установить draft в чат
await client.invoke(new Api.messages.SaveDraft({
  peer: entity,
  message: draftText,
}));
```

Удаление черновика (после отправки или dismiss):

```typescript
await client.invoke(new Api.messages.SaveDraft({
  peer: entity,
  message: '',
}));
```

---

## 6. API-маршруты

Базовый путь: `/api/sales-copilot/`

### 6.0 Auth (подключение аккаунта менеджера)

| Метод | Путь | Описание |
|-------|------|----------|
| POST | `/auth/send-code` | Отправить код авторизации на номер телефона |
| POST | `/auth/verify-code` | Подтвердить код, сохранить session, создать/обновить конфиг |

**send-code:** принимает `{ phone }`, создаёт GramJS клиент, вызывает `sendCode()`, сохраняет `phoneCodeHash` в in-memory Map.

**verify-code:** принимает `{ phone, code, password? }`, вызывает `signIn()`, сохраняет `session_data` в конфиг. При `SESSION_PASSWORD_NEEDED` возвращает `{ needs_password: true }`, фронт показывает поле пароля.

### 6.1 Configs

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/configs` | Список конфигов текущего пользователя |
| POST | `/configs` | Создать конфиг (обычно не вызывается вручную — создаётся через verify-code) |
| GET | `/configs/[id]` | Получить конфиг |
| PATCH | `/configs/[id]` | Обновить конфиг |
| DELETE | `/configs/[id]` | Удалить конфиг |

### 6.2 Drafts

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/configs/[id]/drafts` | Список черновиков (фильтр по type, status) |
| GET | `/configs/[id]/drafts/stats` | Статистика: pending, sent, dismissed по типам |
| POST | `/configs/[id]/drafts/[draftId]/send` | Отправить черновик (или отредактированную версию) |
| POST | `/configs/[id]/drafts/[draftId]/dismiss` | Отклонить черновик |
| POST | `/configs/[id]/drafts/[draftId]/regenerate` | Перегенерировать черновик |

### 6.3 Jobs

| Метод | Путь | Описание |
|-------|------|----------|
| POST | `/configs/[id]/start` | Запустить copilot для конфига |
| POST | `/configs/[id]/stop` | Остановить copilot |
| GET | `/configs/[id]/status` | Текущий статус (running/stopped) |

### 6.4 Logs

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/configs/[id]/logs` | Логи copilot (пагинация, фильтр по level) |

---

## 7. Frontend: страница `/tools/sales-copilot`

### 7.1 Структура

Отдельная страница в портале, зарегистрированная в `toolsRegistry.ts`.

**Табы верхнего уровня:**
1. **Черновики** — основной рабочий экран менеджера
2. **Настройки** — конфигурация copilot
3. **Логи** — журнал работы

### 7.2 Таб "Черновики"

Два подраздела:

**Входящие (reactive):**
- Список pending-черновиков, отсортированных по дате
- Каждая карточка: аватар, имя чата, последнее сообщение клиента, черновик ответа
- Действия: Отправить / Править и отправить / Пропустить / Перегенерировать
- Бейдж с количеством pending

**Холодные диалоги (proactive):**
- Список диалогов, молчащих дольше порога
- Каждая карточка: имя, дней молчания, краткий контекст, черновик реанимации
- Действия: те же

### 7.3 Начальный экран (EmptyState)

Если нет конфигов — показывается форма подключения аккаунта:
1. Шаг "phone": ввод номера телефона → "Отправить код"
2. Шаг "code": ввод кода из Telegram → "Подключить"
3. Шаг "password" (при 2FA): ввод облачного пароля → "Подтвердить"

### 7.4 Таб "Настройки"

- Информация о подключённом аккаунте (имя, username, телефон)
- Вкл/выкл copilot
- Модель LLM
- Реактивный сценарий:
  - System prompt (с placeholder'ами)
  - Ставить draft в TG: да/нет
  - Лимит истории
- Проактивный сценарий:
  - System prompt для реанимации
  - Порог молчания (дни)
  - Максимум черновиков за скан
- Расписание (интервал, sleep periods)
- Фильтры (игнор ботов, исключённые чаты)

### 7.4 Таб "Логи"

Аналогично логам кампаний в TG Outreach — таблица с level, message, created_at.

---

## 8. Промпты LLM

### 8.1 Реактивный (по умолчанию)

```
Ты — помощник менеджера по продажам. Тебе дана переписка менеджера с клиентом в Telegram.

Задача: написать черновик следующего ответа от имени менеджера.

Правила:
- Пиши естественно, как в мессенджере (без канцеляризмов)
- Коротко — 1-3 предложения
- Учитывай контекст всей переписки
- Если клиент задал вопрос — ответь на него
- Если клиент проявил интерес — двигай к следующему шагу (звонок/встреча)
- Если клиент негативит — вежливо попрощайся
- НЕ используй эмодзи если их нет в стиле менеджера
```

### 8.2 Проактивный (по умолчанию)

```
Ты — помощник менеджера по продажам. Тебе дана переписка менеджера с клиентом в Telegram. Диалог замолк {silence_days} дней назад.

Задача: написать сообщение для возобновления диалога.

Правила:
- Пиши естественно, как в мессенджере
- Коротко — 1-3 предложения
- Не начинай с "Привет, давно не общались" — это банально
- Привяжись к контексту прошлого разговора
- Дай повод ответить (вопрос, новость, предложение)
- Не будь навязчивым
```

---

## 9. Отправка сообщения из портала

Когда менеджер нажимает "Отправить" в UI:

1. API получает `draft_id` и опциональный `edited_text`
2. Подключает GramJS-клиент для аккаунта
3. Отправляет сообщение: `client.sendMessage(tgUserId, { message: text })`
4. Обновляет draft: `status = 'sent'` или `'edited_and_sent'`, `acted_at = now()`
5. Если был TG draft — удаляет его (`saveDraft` с пустым message)
6. Возвращает результат

---

## 10. Фазы реализации

### Фаза 1: MVP (1-2 недели)
- [x] Миграция БД: таблицы + RLS
- [x] Миграция: inline session (phone, session_data, tg_first_name, tg_username)
- [x] API: configs CRUD, drafts list/send/dismiss
- [x] API: auth/send-code + auth/verify-code (авторизация менеджера по номеру)
- [x] Worker: реактивный сканер
- [x] Worker: проактивный сканер
- [x] UI: страница с черновиками + базовые настройки
- [x] UI: форма подключения аккаунта (номер → код → 2FA)
- [x] Регистрация в toolsRegistry + navigation

### Фаза 2: Улучшения (ongoing)
- [ ] Аналитика: конверсия черновиков (sent vs dismissed), время реакции
- [ ] Обучение на стиле менеджера (анализ прошлых сообщений)
- [ ] Уведомления (пуш/TG-бот) о новых черновиках
- [ ] Bulk-действия (отправить все, пропустить все)

---

## 11. Ограничения и риски

| Риск | Митигация |
|------|-----------|
| TG API rate limits / FloodWait | Задержки между запросами, cooldown при ошибках |
| LLM генерирует неадекватный ответ | Менеджер всегда ревьюит перед отправкой |
| Copilot помечает сообщения прочитанными | Использовать `getMessages` без `readHistory` |
| Много pending-черновиков копится | Auto-expire через 24ч (reactive) / 72ч (proactive) |
| Аккаунт заблокирован | Проверка статуса перед отправкой, graceful handling |
