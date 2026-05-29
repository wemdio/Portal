# Client Health Questions — DRAFT v1 (для обсуждения)

Цель: каждый день для каждого **активного клиента** задавать один и тот же фиксированный набор вопросов к датасету, накапливать структурированные ответы, и из этого корпуса вырастить продукт «AI-аналитик портфеля клиентов» (proactive insights, health-score, attention-required алерты).

> ⚠️ Это ДРАФТ. Набор вопросов = что наш будущий продукт считает «здоровьем клиента». Поменяешь вопрос через 2 месяца — потеряешь сравнимость time-series. Поэтому фиксируем осознанно СЕЙЧАС.

---

## Prerequisite: привязка клиент ↔ кампания

В датасете её нет. Нужно синкать 2 таблицы (daily, вместе с обычным sync):

| Новая таблица в `instantly_dataset` | Источник | Что даёт |
|---|---|---|
| `client_projects` | `main-postgres.projects` (active: archived=false) | project_id → client, name, specialist_user_id, status |
| `project_campaigns` | `instantly.project_instantly_campaigns` + `project_period_instantly_campaigns` | project_id → campaign_id |

Поверх — view:

```sql
CREATE VIEW v_client_campaigns AS
SELECT p.client, p.project_id, p.project_name, p.specialist_user_id, pc.campaign_id
FROM client_projects p
JOIN project_campaigns pc ON pc.project_id = p.project_id
WHERE p.archived = false AND p.status = 'active';   -- точное условие "активный" уточнить
```

«Активный клиент» = ? (надо определить: `projects.status='active'`? есть отправки за 7 дней? есть launch?). **Открытый вопрос #1.**

---

## Формат ответа (для всех вопросов одинаковый)

Каждый запуск пишет строку в `client_health_snapshots`:

```
snapshot_date   DATE
client          TEXT
question_id     TEXT          -- 'sending_volume', 'open_rate', ...
structured      JSONB         -- числа для графиков и аномалий
narrative       TEXT          -- 1-2 предложения от LLM, человекочитаемо
anomaly         BOOLEAN       -- вышло за baseline?
anomaly_note    TEXT          -- что именно аномально
```

Числа считаются **детерминированным SQL** (стабильны во времени). LLM только пишет narrative + ставит anomaly-флаг. Так time-series чистый, а комментарии гибкие.

---

## 7 вопросов

### Q1. `sending_volume` — мы вообще отправляем?
**Зачем:** ловит сломанные/запаузенные кампании, проблемы с mailbox'ами. Самый базовый pulse.
```sql
SELECT
  count(*) FILTER (WHERE e.ue_type=1 AND e.timestamp_email > now() - interval '7 days')  AS sent_7d,
  count(*) FILTER (WHERE e.ue_type=1 AND e.timestamp_email > now() - interval '14 days'
                                     AND e.timestamp_email <= now() - interval '7 days') AS sent_prev_7d
FROM v_client_campaigns cc
JOIN raw_emails e ON e.campaign_id = cc.campaign_id
WHERE cc.client = $client;
```
**structured:** `{sent_7d, sent_prev_7d, delta_pct}`. **anomaly:** падение >50% или sent_7d=0 при sent_prev_7d>0.

### Q2. `open_rate` — деливерабилити/темы работают?
**Зачем:** падение open rate = проблема с доставляемостью (домены в спаме) или темы перестали цеплять.
```sql
-- 7d vs trailing 4-week baseline, из daily snapshot (последний snapshot на каждый день)
-- opened_unique / sent по кампаниям клиента
```
**structured:** `{open_rate_7d, open_rate_baseline_28d, delta_pp}`. **anomaly:** падение >10 п.п. от baseline.

### Q3. `reply_rate` — сообщения резонируют?
**Зачем:** главный leading-индикатор качества таргетинга + копирайта.
```sql
-- unique_replies / sent, 7d vs 28d baseline
```
**structured:** `{reply_rate_7d, reply_rate_baseline_28d, delta_pp, replies_7d}`. **anomaly:** падение >0.5 п.п. или рост (хороший сигнал — тоже флагуем!).

### Q4. `qualified_leads` — деньги
**Зачем:** конечная ценность. Сколько реальных лидов за неделю.
**Решение нужно:** использовать `raw_leads.interest_status=1` (Instantly AI) ИЛИ синкать `instantly_lead_qualifications.status='lead'` (наш qualifier)? Второе — то что реально триггерит CSM. **Открытый вопрос #2.**
```sql
-- count лидов со статусом lead за 7d vs prev 7d
```
**structured:** `{leads_7d, leads_prev_7d, delta}`. **anomaly:** 0 лидов за 7д при том что отправки идут.

### Q5. `mailbox_health` — инфраструктурный риск
**Зачем:** если mailbox'ы клиента горят (warmup banned, bounce) — скоро всё встанет. Раннее предупреждение.
```sql
SELECT count(*) FILTER (WHERE a.status < 0)        AS accounts_error,
       count(*) FILTER (WHERE a.warmup_status < 0) AS warmup_problem,
       count(*)                                     AS total_mailboxes
FROM (SELECT DISTINCT e.eaccount FROM v_client_campaigns cc
      JOIN raw_emails e ON e.campaign_id=cc.campaign_id WHERE cc.client=$client) m
JOIN raw_accounts a ON a.email = m.eaccount;
```
**structured:** `{total_mailboxes, accounts_error, warmup_problem}`. **anomaly:** любой mailbox в error/banned.

### Q6. `subject_performance` — что работает, что нет
**Зачем:** actionable. Лучшая и худшая тема недели → можно сразу применить.
```sql
-- из v_subject_performance, фильтр по кампаниям клиента, ORDER BY reply_rate
-- top-1 и bottom-1 subject с sent >= порог
```
**structured:** `{best_subject, best_reply_rate, worst_subject, worst_reply_rate}`. **anomaly:** нет (это всегда полезный инсайт).

### Q7. `negative_signals` — ранние тревоги
**Зачем:** bounce/unsubscribe/not_interested растут → выгорание базы или проблема с доменом.
```sql
-- bounce_rate, unsub_rate (из daily snapshot), not_interested_rate (raw_leads interest_status=-1)
-- 7d vs 28d baseline
```
**structured:** `{bounce_rate_7d, unsub_rate_7d, not_interested_rate_7d, vs baseline}`. **anomaly:** bounce >3% или любой резкий рост.

---

## Открытые вопросы (решить до постройки)

1. **Что = «активный клиент»?** projects.status='active' + archived=false? Или ещё «есть отправки за 7д»?
2. **Какой «лид» в Q4?** Instantly interest_status или наш qualifier (instantly_lead_qualifications)?
3. **Baseline window** — 28 дней ок? Для новых клиентов (<28д данных) — как считать?
4. **Пороги аномалий** — мои дефолты выше разумны? Подкрутим после первых 2 недель.
5. **LLM для narrative** — какой ключ/модель? OpenRouter (как qualifier) или дешёвую gemini-flash?
6. **Стоит ли добавить Q8 sequence_completion** (доходят ли лиды до конца цепочки)? Или 7 достаточно для v1?

---

## Что НЕ в этом наборе (намеренно)

- Сравнение между клиентами («клиент X хуже среднего по нише») — это уже АГРЕГАТНЫЙ анализ поверх накопленных snapshot'ов, отдельная фича. Сначала накопим per-client time-series.
- Прогнозы — рано. Сначала описательная аналитика.
