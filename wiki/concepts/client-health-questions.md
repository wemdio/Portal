# Client Health — the 7 questions the agent investigates

When the user says *"разбери клиента X"* / *"how is client X doing?"*, the AI agent
(currently: Claude in chat — see [eval-loop.md](./eval-loop.md)) works through these
7 fixed questions, answers with judgment (not just numbers), and logs the session to
`query_log`.

These are **not** SQL formulas run by a cron — that approach (a deterministic
calculator) was tried and dropped. The agent reasons over the data, digs into *why*,
and is honest when it can't answer (logs `status='partial'`). The fixed set exists so
that week-over-week the same questions are comparable.

---

## Step 0 — resolve the client's campaigns (LIVE, not stored)

The dataset (`instantly_dataset`) knows campaigns + emails but NOT which campaign
belongs to which Portal client. That map lives in the operational DBs and is queried
**live** each session (no mirrored copy → never stale):

```js
// projects (client names + status) — main-postgres, port 35434
//   host 144.31.54.166, user supabase_admin, db postgres
//   SELECT id, client, name, status FROM projects WHERE status IN ('В работе','Тестирование');
// campaign map — instantly DB, port 35432 (same server as the dataset)
//   SELECT campaign_id FROM project_instantly_campaigns WHERE project_id = $1;
// real qualified leads — instantly DB
//   SELECT status, created_at FROM instantly_lead_qualifications WHERE campaign_id = ANY($cids);
```
Creds: `INSTANTLY_DATASET_DB_URL` in `.env` (swap db name `instantly_dataset`→`instantly`
for the operational DB); main-postgres creds in `.env.servers`.

"Active client" = status **В работе** or **Тестирование**.

---

## The 7 questions

| # | Вопрос | Источник данных | Что значит «плохо» |
|---|---|---|---|
| 1 | **Объём отправки** 7д vs прошлые 7д | `raw_emails` ue_type=1, окно по `timestamp_email` | 0 за 7д при >0 раньше = кампании встали |
| 2 | **Open rate** 7д vs baseline | overview-snapshot diff (`open_count_unique`/`sent`) | <20% слабо, <10% критично (или резкое падение) |
| 3 | **Reply rate** 7д vs baseline | `raw_emails` ue_type=2 / ue_type=1 | <0.5% слабо |
| 4 | **Квалифицированные лиды** 7д vs прошлые 7д | `instantly_lead_qualifications` status='lead' (live) | 0 при >0 раньше = результат пропал |
| 5 | **Здоровье mailbox-ов** | `v_campaign_mailboxes` JOIN `raw_accounts` (status/warmup < 0) | >30% деградировавших = критично |
| 6 | **Bounce + unsub** 7д vs baseline | overview-snapshot diff (`bounced_count`,`unsubscribed_count`) | bounce >3% слабо, >5% критично |
| 7 | **Лучшая/худшая тема** | `v_subject_performance` фильтр по кампаниям клиента, sent>=50 | мёртвые темы (0% reply) → убрать |

The agent doesn't just report the number — it cross-checks. E.g. low reply (Q3) +
healthy mailboxes (Q5) + uniformly low across all subjects (Q7) ⇒ the client's *base*
is the problem, not our delivery. That kind of synthesis is the point.

---

## After answering — log it

Per [eval-loop.md](./eval-loop.md), INSERT into `query_log`: the question, the answer,
SQL fired, wiki pages read, honest `status` + `ai_self_assessment` + `improvement_proposed`.
Weekly we review where answers were weak and improve the dataset/wiki/views.

> First iteration (2026-05-29, query_log id=2, client ДПО ПРОФ) surfaced two real
> data gaps — `v_subject_performance` was returning NULL subjects for everyone, and
> mailbox health couldn't resolve tag-based senders. Both fixed same session
> (migration 005). That's the loop working.
