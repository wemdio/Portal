# Weekly Eval Review — YYYY-WW

_Дата: YYYY-MM-DD. Ревьюер: <human-name> + AI._

## 1. Cтатистика недели

```sql
SELECT status, count(*)::int AS n,
       count(*) FILTER (WHERE user_feedback = -1)::int AS thumbs_down,
       count(*) FILTER (WHERE user_feedback = 1)::int AS thumbs_up,
       round(avg(duration_ms)::numeric, 0) AS avg_ms
FROM query_log
WHERE ts > now() - interval '7 days'
GROUP BY status ORDER BY n DESC;
```

_(заполняется во время ревью)_

| status | n | 👍 | 👎 | avg ms |
|---|---|---|---|---|
| | | | | |

## 2. Что улучшили на этой неделе

| query_log.id | Что было | Что починили | Артефакт |
|---|---|---|---|
| _42_ | _AI не находил лидов с конкретного домена — full scan_ | _Добавил GIN-индекс на raw_leads.email_ | _migration 004, commit abc123_ |

## 3. Повторяющиеся вопросы (промотируем в wiki)

```sql
SELECT * FROM v_query_log_repeats LIMIT 10;
```

| Вопрос | Сколько раз | Куда промотировали |
|---|---|---|
| _«какие subject работают лучше всего?»_ | _4_ | _wiki/subjects/winning-patterns.md_ |

## 4. Что было сложно / непонятно

Свободный текст. Места где наш собственный pipeline неуклюжий.

## 5. Что отложили

Идеи для следующих недель.

## 6. Метрики loop'a

- Доля `status='failed'` на этой неделе vs прошлой
- Доля `succeeded` после применённых фиксов (предыдущая неделя → эта)
- Средний `ai_self_assessment`

---

_Когда заполнено — отметить review'нутые строки:_

```sql
UPDATE query_log
SET reviewed_at = now(),
    reviewer = '<your name>',
    improvement_applied = COALESCE(improvement_applied, 'no change needed')
WHERE id IN (...) AND reviewed_at IS NULL;
```
