# HANDOFF: автоаутрич outreachos — полный контекст (2026-08-13)

Перенос сессии Kimi Work (десктоп, 10–13.08.2026) в новый чат/IDE.
Преемник: прочти этот файл целиком — это состояние «на сейчас» плюс все
активные нити работ. Правила работы — в корневом AGENTS.md репо (обязательно).

Исходная цепочка: Claude Code «Email outreach automation pipeline» →
Kimi Code CLI `session_66688d09-3adb-4e62-ad5a-b2e43ac2d415` («автоаутрич
outreachos», wd=C:\Users\wemd1\Desktop\Portal) → Kimi Work сессия (этот файл).

## 1. Состояние прод-системы (факты, проверено ≤13.08)

- **Прогон outreachos**: cron на хосте `15 5 * * *` (05:15 МСК) →
  `docker exec portal-worker-hh node /app/workers/outreachosCron.js`,
  лог `/var/log/portal/outreachos-cron.log`. Результаты — таблица
  `outreachos_pipeline_runs` (основная БД, 139.60.162.12:35434, db postgres).
- **Кампании Instantly** (воркспейс `default`, есть ещё `account-2`):
  A `0065c47f-eeab-4f67-b83e-eef56c20cacd` «OutreachOS Автоаутрич 1»,
  B `05ade906-bd1b-4d30-8a18-3c361096534c` «OutreachOS Автоаутрич 2».
  Сплит 50/50 детерминированный по домену компании.
- **Steady state HH+SJ**: ~140–160 залитых/день; сужение воронки — seen-окно
  45д (`outreachos_seen_employers`), срезает ~92% кандидатов. SuperJob даёт
  +~4% к парсу (дедуп с HH по домену).
- **2GIS top-up — В БОЮ (live)**: конфиг `outreachos_pipeline_config`:
  `gis_topup_enabled=true`, `gis_topup_measure_only=false` (live с 12.08),
  `target_appended=200`, `daily_cap=500`, рубрикатор v1 — 8 групп
  (сид: `docs/design/2026-08-11-outreachos-gis-topup-seed.sql`).
  Первый замер 12.08: дефицит 49 → pull 142 (кросс-дедуп −14) → 136 →
  конструктор 38 (yield 28%) → LLM шум 17% → kept 32.
  Калибровка констант в коде (yield 0.28, overshoot 1.4) — коммит
  `dad7ac622`, действует после деплоя.
- **Фикс сирот-ответов** (инцидент 11.08, it@208-008.ru): в бою.
  `instantly_lead_qualifications.reply_out_of_campaign/eaccount` (миграция
  `supabase/instantly-migrations/20260812_0001`, применена). DM: «Ответ вне
  треда кампании» + «Ящик:». Кабинет /client/replies: блок «Ответы вне
  кампании» (30 дней, ящик — только свой). Историческая сирота 208-008.ru
  дозаполнена вручную (reply_out_of_campaign=true, eaccount=team@outreach-contact.ru).
- **Seen-окно 45д — график освобождения** (22 049 компаний под окном на 12.08):
  первая волна **19.08 (+1500)**, пик **23.08 (+3260)**, масса 19.08–01.09,
  хвост до ~26.09. Это повторные касания (писали 45+ дней назад), не новые.
  У GIS-пайплайна (edu/remont) seen — «навсегда», освобождения нет.

## 2. Коммиты этой сессии (все в ветке Sergey, запушены)

| SHA | Что |
|---|---|
| `3d7656fa3` | дизайн-док top-up `docs/design/2026-08-11-outreachos-2gis-topup.md` |
| `d7934bff3` | feat: 2GIS top-up (8t.1–8t.5, кросс-дедупы, миграция 20260811_0001) |
| `1062b3ac5` | fix: сироты — честная пометка + блок в кабинете (+миграция instantly) |
| `ee311fd0e` | fix: гейт записи колонок сирот на окно «код без миграции» (проба+fallback) |
| `06b296d76` | сид рубрикатора top-up v1 |
| `dad7ac622` | калибровка yield/overshoot по замеру 12.08 |

## 3. Прод-мутации этой сессии (уже применены, не требуют действий)

- Зомби-прогон 08.08 помечен `failed` (как 07.08).
- Сид рубрикатора + `gis_topup_enabled=true` + `measure_only=true` (11.08),
  затем `measure_only=false` — live (12.08).
- Бэкфилл сироты 208-008.ru (11.08).

## 4. Активные нити / что проверять дальше

1. **Live-прогоны top-up (с 13.08)**: смотреть `outreachos_pipeline_runs`
   (`gis_*` колонки + appended): сколько GIS-лидов реально залилось, seen в
   обоих журналах, отсутствие пересечений с edu/remont. Лог — строки
   `[gis-topup]` в `/var/log/portal/outreachos-cron.log`.
2. **19–20.08 — первая волна освобождения seen**: проверить рост
   `new_employers` и качество ре-контакта (отклик/баунсы кампаний A/B).
3. **LLM-шум GIS (~17%)** — следить 2–3 дня; если стабильно >20% —
   расширять excluded-списки рубрикатора (правится UPDATE'ом конфига).
4. **База баз (реестровая, companies_directory / СБИС v4)** — потенциальный
   следующий источник добора (обсуждали, отложено). Яндекс Карты (~1M орг.) —
   второй резерв.

## 5. Как работать с продом (паттерны этой сессии)

- **Read-only основная БД**: node из `Portal/app` (node_modules/pg); строка
  из `~/.codex/config.toml` (mcp_servers.portal-db), хост → 139.60.162.12,
  `?sslmode=disable`; роль readonly, только SELECT, statement_timeout 30с.
- **SSH на прод** (`139.60.162.12`): креды в `Portal/.env.servers`
  (PROD_SERVER_HOST/USER/PASSWORD), библиотека ssh2 из app/node_modules;
  паттерн — app/_ssh-*.mjs. psql: `docker exec main-postgres psql -U postgres
  -d postgres` (основная БД + 2gis_dataset), `docker exec instantly-postgres-prod
  psql -U instantly -d instantly` (операционная Instantly).
- **Instantly API**: ключи в env воркера `portal-worker-instantly-leads`
  (INSTANTLY_API_KEY + INSTANTLY_ACCOUNTS_JSON); `docker exec -i ... node -`
  со скриптом через stdin. Воркспейсы: default + account-2.
- **Мутации прода** — только с явного подтверждения владельца, с защитным
  WHERE и верификацией; временные скрипты после себя удалять.
- **Код**: ветка Sergey; коммит+пуш = граница (мёрж/деплой — владелец через
  Tasks); чужие незакоммиченные WIP не трогать (stash на время rebase-пуша,
  назад pop); миграции автоприменяются при деплое (scripts/db/ensureDatabase.js
  покрывает supabase/migrations и supabase/instantly-migrations).
- **Пре-существующие фейлы тестов ветки** (не наши, не чинить молча):
  renewalMarksNoteText, clientReportLargeScoreRollup, largeScoreRollupOperator,
  sessionUtils, fnsRevenueRoute.

## 6. Ключевые файлы

- `app/src/lib/outreachos/pipelineRunner.ts` — основной прогон (фазы 8t там же)
- `app/src/lib/outreachos/gisTopup.ts` — pull/дедупы/seen 2GIS top-up
- `app/src/lib/outreachos/seenEmployers.ts` — seen-журнал (HH upsert / GIS delete+insert)
- `app/src/lib/gisSignalOutreach/segments.ts` — обратный кросс-дедуп §4.2
- `app/src/lib/instantly/leadQualificationWorker.ts` — poll-контур, квалификация,
  `strayColumnsSupported` (гейт колонок сирот)
- `app/src/lib/instantly/othersWatchdog.ts` — контур Others (ловит сирот)
- `app/src/lib/clientReplyBot/bot.ts` — DM-уведомления (честные заголовки)
- `app/src/app/api/client/replies/route.ts` — кабинет ответов (+блок сирот)
- `docs/design/2026-08-11-outreachos-2gis-topup.md` — дизайн-док (§6 рубрикатор)
- `docs/design/2026-08-11-outreachos-gis-topup-seed.sql` — применённый сид
