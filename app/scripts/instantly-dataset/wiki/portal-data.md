# Портальные данные в датасете (управленческий контур)

В датасете есть ночное зеркало Портала: **проекты, периоды, КПИ-история, задачи, спецы,
мост проект↔кампания, квалифицированные лиды, передачи клиентам** — таблицы `portal_*`.
Свежесть: `SELECT * FROM portal_mirror_meta` (синк ~01:00 UTC). Это срез «на вчера», не real-time.

## Главный инструмент — `v_portal_project_health`
Одна строка на проект: план/факт (контакты и КПИ), темп/день, прогноз, квал.лиды, передачи,
открытые/просроченные задачи и **флаги проблемности** (те же формулы, что в UI Портала):
- `flag_deadline_failed` — дедлайн прошёл, план не выполнен;
- `flag_behind_pace` — при текущем темпе к дедлайну не успевает;
- `flag_zero_pace_near_deadline` — ≤14 дней до дедлайна, остаток есть, темпа нет.

**«Слабые проекты» на ходу:**
```sql
SELECT client, status, specialist, plan_contacts, fact_contacts, contacts_per_day,
       days_until_deadline, leads_30d, tasks_overdue,
       flag_deadline_failed, flag_behind_pace, flag_zero_pace_near_deadline
FROM v_portal_project_health
WHERE NOT is_completed
  AND (flag_deadline_failed OR flag_behind_pace OR flag_zero_pace_near_deadline)
ORDER BY days_until_deadline NULLS LAST;
```

## Таблицы и их гочи
| Таблица | Что | Гочи |
|---|---|---|
| `portal_projects` | карточки проектов | **все план/факт/даты — TEXT свободного формата** («10 встреч», «8000-16000», «-»); парсить ведущее число (вьюха уже делает). `client`=имя клиента текстом; `manager`(ПМ)=текст без FK; `specialist_user_id` бывает NULL у бот-проектов. Статусы матчить `ILIKE '%заверш%'` и т.п. |
| `portal_project_periods` | продления (Period N) | `projects.*` = зеркало АКТИВНОГО периода; закрытые = история. При активном периоде КПИ-историю фильтровать по `period_id` |
| `portal_contacts_history` | дневные снапшоты факта | ЕДИНСТВЕННЫЙ типизированный КПИ-источник (int). Темп = дельта за окно ≤90 последних точек (`v_portal_project_pace`) |
| `portal_tasks` | задачи | «просрочена» = `deadline < now() AND status<>'done'` (флага в БД нет); исполнитель = текст `specialist` |
| `portal_specialists` | люди (без контактов) | роли: manager/technician/admin/lead/marketer/sales; `role='client'` = аккаунты клиентов |
| `portal_project_campaigns` | **мост проект↔кампания** | denylist уже вычтен; ~92% квалификаций резолвятся в проект; редкие кампании ведут на 2 проекта |
| `portal_lead_qualifications` | ИИ-квалификация ответов | `status='lead'` = квалифицированный лид (money-метрика). Тексты ответов НЕ здесь — join к `raw_emails` по campaign_id+lead_email. `read_at` пуст = спец не прочитал (SLA!) |
| `portal_forwarded_leads` | передачи лидов клиентам | ⚠️ связь с проектом слабая: project_id в источнике пуст, мост покрывает ~5/63 — судить по `campaign_id`, скептически |

## Метрики кампаний по проекту (мост в деле)
```sql
-- reply/lead-rate кампаний конкретного проекта:
SELECT h.name, h.reply_rate, h.lead_rate_labeled, h.bounce_rate_lifetime
FROM portal_project_campaigns b
JOIN v_campaign_health h ON h.campaign_id = b.campaign_id
WHERE b.project_id = (SELECT id FROM portal_projects WHERE client ILIKE '%X%' LIMIT 1);
```
(v_campaign_health тяжёлая — по одному проекту за раз.)

## Ещё управленческие срезы
```sql
-- просроченные задачи по спецам:
SELECT specialist, count(*) FROM portal_tasks
WHERE status <> 'done' AND deadline < now() GROUP BY 1 ORDER BY 2 DESC;
-- квал.лиды, которые никто не прочитал >2 дней (SLA):
SELECT q.campaign_name, q.lead_email, q.created_at::date
FROM portal_lead_qualifications q
WHERE q.status='lead' AND q.read_at IS NULL AND q.created_at < now() - interval '2 days'
ORDER BY q.created_at;
-- нагрузка: активные проекты по спецам:
SELECT specialist, count(*) FROM portal_projects
WHERE status NOT ILIKE '%заверш%' AND status NOT ILIKE '%отмен%' GROUP BY 1 ORDER BY 2 DESC;
```

## Чего в зеркале СОЗНАТЕЛЬНО нет
Финансы (бюджеты/маржа/оплаты), брифы клиентов, handoff-ящики/легенды, ссылки на договоры,
контакты сотрудников (email/телефон/TG), полные тела переписки (они в `raw_emails`),
telegram-идентификаторы. Если чего-то из этого не хватает — вопрос владельцу, не искать обходом.
