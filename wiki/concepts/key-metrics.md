# Key Metrics

Что означает каждая метрика, откуда берётся, и какие подводные камни.

---

## Email volume

| Метрика | Что значит | Откуда |
|---|---|---|
| `emails_sent_count` | Всего исходящих отправок | `raw_campaign_analytics_overview_snap` (aggregate) или `count(*) WHERE ue_type=1` (per-message) |
| `contacted_count` | Уникальных лидов которым хотя бы раз ушло письмо | `raw_campaign_analytics_overview_snap` |
| `new_leads_contacted_count` | Лидов с первым контактом в данной кампании | Снапшот |

**Подводный камень:** `emails_sent_count` ≠ `count(raw_emails WHERE ue_type=1)` точно. Снапшот это Instantly's точка зрения; raw_emails это то что мы реально стянули. Расхождение бывает из-за того что Instantly иногда удаляет очень старые письма из feed'a /emails, но они остаются в campaign analytics.

---

## Open metrics

| Метрика | Что значит | Тонкости |
|---|---|---|
| `open_count` | Всего открытий писем (один и тот же читатель может открыть несколько раз — всё посчитается) | Включает image-pixel-tracking и auto-prefetch (часто Gmail и корпоративные ESP делают preview-scan, оно засчитывается как open) |
| `open_count_unique` (или `unique_opened`) | Уникальные открытия по лидам | Более честная метрика. **Используй её для open rate, не raw `open_count`.** |
| **open rate** | `unique_opened / sent * 100` | Норма B2B cold outreach: 30-50%. >60% обычно артефакт image-prefetch. См. ниже. |

**Подводный камень:** в нашем датасете `v_subject_performance` показывает open_rate_pct >100% для некоторых строк. Это происходит когда `unique_opened > sent` (странное от Instantly, возможно есть лиды которые получили email через forwarding и открыли — система считает их в `unique_opened` но не в `sent` для данного шага). Применять с критикой. Если open >100%, фильтруй или интерпретируй с скепсисом.

---

## Reply metrics

| Метрика | Что значит |
|---|---|
| `reply_count` | Всего ответов на письма |
| `unique_replies` | Уникальных лидов которые ответили |
| `replies_automatic` | Ответы которые Instantly классифицировала как auto-reply (OOO, "вы написали в архив" и т.п.) |
| **reply rate** | `unique_replies / sent * 100` |

**Норма для холодного B2B:** 1-3% reply rate. >5% выдающийся. 10%+ обычно либо small-N (sent<50), либо ультра-targeted bespoke списки.

`v_subject_performance.reply_rate_pct` уже считает unique_replies / sent.

---

## Lead status

`raw_leads.interest_status` декодируется через `lookup_interest_status`:

| Value | Label | Что значит |
|---|---|---|
| `0` | unprocessed | Ещё не классифицирован (default) |
| `1` | interested | **Заинтересован** — целевой лид |
| `-1` | not_interested | Явный отказ |
| `-2` | reply_received | Ответил, но классификация отложена |
| `-3` | invalid_contact | Wrong person или unreachable |

**Реально важная** для downstream funnel — `interested`. Остальные = шум/негатив.

В **отдельной БД портала** (instantly-postgres-prod на VPS, БД `instantly`, таблица `instantly_lead_qualifications`) есть **наш собственный** AI-классификатор который выдаёт более гранулярный статус: `lead | objection | not_lead | needs_review | error`. Только **`status='lead'` триггерит TG-алерт специалисту**. Связь с этим датасетом: `lead_email + campaign_id`.

---

## Account / mailbox health

| Поле | Откуда | Что значит |
|---|---|---|
| `raw_accounts.status` | `lookup_account_status` | Может ли вообще mailbox отправлять. `1=active`, остальное — проблемы |
| `raw_accounts.warmup_status` | `lookup_warmup_status` | Состояние прогрева. `-1=banned`, `-3=permanent_suspension` — фатально |
| `raw_accounts.stat_warmup_score` | Instantly's расчёт | 0-100, выше = лучше доставляемость. <50 = тревога |
| `raw_warmup_analytics_snap.landed_inbox / landed_spam` | per (email, date) | Дневная картина куда падают warmup-emails. Доля spam — главный leading indicator deliverability краха |

**Эвристика:** если `landed_spam / (landed_inbox + landed_spam) > 0.1` несколько дней подряд, accounts начнут уходить в `warmup_status=-2`.

---

## Snapshot vs live

| | Snapshot tables (`*_snap`) | Live |
|---|---|---|
| Где | `raw_campaign_analytics_*_snap`, `raw_warmup_analytics_snap` | `raw_campaigns`, `raw_accounts` |
| Что | "Как было на момент snapshot_id" | "Как есть сейчас" |
| Когда обновляется | Каждый pull/sync создаёт новый snapshot row | UPSERT каждый sync (теряем историю) |
| Использовать для | Trend'ы во времени | Текущее состояние |

Если нужно сравнить «как было год назад vs сейчас» — нужны snapshot tables. Если просто «что есть сейчас» — raw_* достаточно.

`v_latest_snapshot` возвращает `MAX(started_at)` с `ok=true` — это «самые свежие» снапшот-данные.
