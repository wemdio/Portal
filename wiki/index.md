# Index

Live table of contents. AI updates this every time a new page is created or a page's purpose changes meaningfully.

## Foundations

- [README.md](./README.md) — что это и зачем
- [CLAUDE.md](./CLAUDE.md) — инструкции AI-агенту, читается первым в каждой сессии
- [log.md](./log.md) — хронология открытий
- [playbook.md](./playbook.md) — дистиллированные best practices outreach

## Concepts (стабильные знания о датасете)

- [concepts/dataset-schema.md](./concepts/dataset-schema.md) — структура БД, как джойнить, lookups, views
- [concepts/key-metrics.md](./concepts/key-metrics.md) — open rate, reply rate, warmup score, что они значат и как считать
- [concepts/eval-loop.md](./concepts/eval-loop.md) — YC-style observability + weekly review ритуал, как datset/wiki улучшается во времени

## Eval

- [eval/TEMPLATE-weekly-review.md](./eval/TEMPLATE-weekly-review.md) — шаблон еженедельного ревью query_log

## Subjects (что работает в темах)

- [subjects/winning-patterns.md](./subjects/winning-patterns.md) — выигрышные/мёртвые паттерны тем + анти-паттерн «тема × неверный ICP»

## Analyses

_Per-question deep-dives. Format: `YYYY-MM-DD-<topic>.md`._

- [analyses/2026-08-17-campaign-cleanup-dataset-safety.md](./analyses/2026-08-17-campaign-cleanup-dataset-safety.md) — чистка кампании (удаление контактов/перенос в листы) для датасета безопасна: синк только UPSERT-ит, 26 885 переходов снапшотов без единого падения счётчиков, покрытие свежих писем 100%; риск только в поздних ответах удалённых лидов (папка Others, 30 дней)
- [analyses/2026-08-11-roistat-mailbox-underutilization.md](./analyses/2026-08-11-roistat-mailbox-underutilization.md) — почему пул Roistat грузится на ~54%: удалённый ящик навсегда замораживает лида в середине цепочки (665 из 8858), тег «Roistat» показывает 84 ящика при 60 живых
- [analyses/2026-06-11-dataset-objectivity-audit.md](./analyses/2026-06-11-dataset-objectivity-audit.md) — аудит перед фичей campaign-insights: sent-горизонт ~90 дней, зомби-кампании, дубли автоответов 20%, метки исходов 30–38%, гейты честной фичи, приоритетные фиксы
- [analyses/2026-06-05-instantly-top-research-questions.md](./analyses/2026-06-05-instantly-top-research-questions.md) — pass по research brief: copy features, length, CTA, follow-ups, v2 data gaps

## Campaigns

_Per-campaign разборы. Только для значимых (с большим объёмом или интересными паттернами)._

(empty)

## Clients

_Сводки по группам кампаний одного клиента._

(empty)

## Verticals

_Наблюдения по отраслям/нишам._

(empty)

## Subjects

_Паттерны subject-line. Что работает, что нет, в каких контекстах._

(empty)

## Mailboxes

_Здоровье и продуктивность mailbox-аккаунтов._

(empty)
