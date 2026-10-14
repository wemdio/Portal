# Автодобор базы автоаутричей — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** база автоаутрича RU/EN сама добирается на неделю вперёд, когда её остаётся меньше чем на 3 рабочих дня, а «Рассылка» шлёт цепочки полностью (два лимита ящика, напоминания раньше новых).

**Architecture:** спека `docs/superpowers/specs/2026-10-06-outreach-autofill-design.md`. Лимиты и приоритет — в планировщике «Рассылки» (`lib/sender/planner.ts`, sender-хосты). Автодобор — модуль `lib/outreachAutofill/` и таймер в воркере `app/worker/polzaOutreach.ts` (139); переиспользует создание запуска, `uploadJobToSender` / `startJobCampaign`. Экран — вкладка «Автодобор» в общем `OutreachTabs`, форма — панели запуска в режиме `autofill`.

**Tech Stack:** Next.js 15 / TypeScript, Supabase (PostgREST + SQL-миграции), воркеры на esbuild.

**Проверка:** новых тестовых файлов не заводим (CLAUDE.md). Тяжёлые проверки локально не гоняем (память `no-heavy-local-checks`) — typecheck и связанные тесты гоняет CI ветки; `grants.test.ts` читает миграции и выберется сам.

---

### Task 1: Миграция

**Files:** Create `supabase/migrations/20261006_0030_outreach_autofill.sql`

- [ ] Лимиты ящиков:
```sql
alter table public.sender_mailboxes alter column daily_total_limit set default 20;
update public.sender_mailboxes set daily_total_limit = daily_campaign_limit * 4;
comment on column public.sender_mailboxes.daily_campaign_limit is 'Новых в день: первые письма (шаг 1) с ящика за сутки UTC';
comment on column public.sender_mailboxes.daily_total_limit is 'Всего в день: все письма цепочек с ящика за сутки UTC';
```
- [ ] Таблица `public.outreach_autofill` (поля — спека §2), строки `ru`/`en`, `enable row level security` без политик, `grant all ... to service_role`.
- [ ] RPC `public.outreach_autofill_folder_state(p_folder_key text) returns jsonb` (`security definer`, `set search_path = public`): `per_day` = сумма `daily_campaign_limit` ящиков из `mailbox_ids` папки со `status='verified' and enabled`; `remaining` = `count(distinct coalesce(r.group_key, r.id::text))` по `sender_recipients r join sender_campaigns c` где `c.folder_id = папка`, `c.status in ('running','paused')`, `r.status='active'`, `r.last_step_sent = 0`; плюс `folder_id`, `send_weekdays`, `timezone`. `revoke ... from public; grant execute ... to service_role`.

### Task 2: Планировщик — два лимита, напоминания первыми

**Files:** Modify `app/src/lib/sender/planner.ts`, `app/src/lib/sender/types.ts` (комментарии полей)

- [ ] `remainingQuota` → `{ total, fresh }`: те же два запроса плюс два с `.eq('step_no', 1)`; `total = daily_total_limit − sent − pending`, `fresh = min(total, daily_campaign_limit − sent1 − pending1)`. Сбой — `{0,0}`.
- [ ] `MailboxSlot.remaining` → `remaining` (всего) + `remainingNew`. `pickSlot(slots, recipient, isFirst)`: для шага 1 свободен слот с `remaining > 0 && remainingNew > 0`. Ящик соседа — то же условие. После вставки: `remaining -= 1`, для шага 1 ещё `remainingNew -= 1`.
- [ ] `planCampaign(campaign, log, phase: 'followups' | 'first')`: выборка получателей с `.gt('last_step_sent', 0)` или `.eq('last_step_sent', 0)`.
- [ ] `planSenderMessages`: цикл по кампаниям дважды — сначала `followups`, потом `first`.

### Task 3: Экран ящиков

**Files:** Modify `app/src/app/api/tools/sender/mailboxes/[id]/route.ts`, `app/src/components/sender/api.ts`, `app/src/components/sender/MailboxesTab.tsx`

- [ ] PATCH принимает `dailyTotalLimit` (1–500) → `daily_total_limit`.
- [ ] Тип ящика на клиенте получает `daily_total_limit`.
- [ ] Столбец «Лимит/день» → «Новых / всего в день»: два поля в ячейке, второе шлёт `dailyTotalLimit`.

### Task 4: Модуль автодобора

**Files:** Create `app/src/lib/outreachAutofill/{plan,settings,notify,check}.ts`; Modify `app/src/lib/telegram/workerAlert.ts`

- [ ] `workerAlert.ts`: `export async function sendWorkerNotice(text: string)` — тот же `loadCreds`, HTML, без 🚨/`<code>`; общий `sendToChats(creds, text)`.
- [ ] `plan.ts` (чистые функции):
  - `planAutofill({ perDay, remaining })` → `{ daysLeft, needed: perDay > 0 && remaining < perDay * 3, target: min(1000, perDay * 5) }`;
  - `addWorkdays(from: Date, days: number, weekdays: number[], timezone: string): Date` — по `zonedParts` из `lib/sender/sendWindow.ts`;
  - `latestSlot(now)` — последнее 09:00 или 21:00 МСК (UTC+3) не позже `now`; `mskDay(now)` → `YYYY-MM-DD`.
- [ ] `settings.ts`: `AutofillLang = 'ru' | 'en'`, `AutofillRow`, `loadAutofill(lang)`, `sanitizeAutofillConfig(lang, raw)` (санитайзер языка, `limit` и `include_previously_exported` вырезаны), `buildJobConfig(lang, config, target)` (санитайзер + `limit`, `include_previously_exported: false`, `autofill: true`), `PARSER_TYPE[lang]`, `FOLDER_KEY[lang]`.
- [ ] `notify.ts`: `notifyAutofill(lang, text, { tag })` → `sendWorkerNotice('<b>Автодобор RU</b>: … @kuladmedDm')`.
- [ ] `check.ts`: `runAutofillTick(now, log)` — для `ru`, `en`: `handleFinishedJob` (каждый тик) и `checkBase` (если `last_check_at < latestSlot(now)`), всё в try/catch на язык. Логика — спека §3.

### Task 5: Таймер в воркере

**Files:** Modify `app/worker/polzaOutreach.ts`

- [ ] `setInterval(() => void tick(), 60_000)` + первый тик после recovery; флаг `ticking` против наложения; `clearInterval` при остановке.

### Task 6: API настроек

**Files:** Create `app/src/app/api/tools/outreach-autofill/[lang]/route.ts`

- [ ] `GET` (requireAdmin): строка + ключ ИИ задан ли + последний автосбор (id, status, created_at).
- [ ] `PUT { enabled?, config? }` (requireAdmin): санитизация, при `enabled: true` — `owner_id = user.id`; `logAudit`.

### Task 7: Экран

**Files:** Create `app/src/components/outreach/AutofillTab.tsx`, `app/src/components/polzaRuOutreach/RuAutofillTab.tsx`, `app/src/components/parsers/EnAutofillTab.tsx`; Modify `LaunchPanel.tsx`, `PolzaOutreachLaunchPanel.tsx`, `ruAdapter.tsx` (экспорт `RuLaunchPanel`), обе `page.tsx`, бейдж в списке запусков

- [ ] Панели: проп `mode?: 'run' | 'autofill'` — заголовок, кнопка «Сохранить», скрыть «сколько компаний» и «брать уже выгруженные».
- [ ] `AutofillTab({ lang, renderSettings })`: выключатель, строка состояния, кнопка «Настройки сбора».
- [ ] Вкладка `{ id: 'autofill', label: 'Автодобор' }` в `extraTabs` обеих страниц.
- [ ] Бейдж «Автодобор» у запуска с `config.autofill`.

### Task 8: Выпуск

- [ ] `git status` — свои файлы отдельно от чужих незакоммиченных (tg-outreach CRM).
- [ ] Коммит, push `dmitriy_kuladmed_new`, CI.
- [ ] Память: запись о двух лимитах и автодоборе.
