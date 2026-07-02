# Outreach Playbook

Evidence-backed best practices. Each claim cites its source.

**This page is sparse on purpose.** It fills as analyses accumulate. Don't add claims without data. When evidence contradicts a claim, mark obsolete and link to the new finding.

---

## Subject lines — SETTLED: low-leverage, don't optimize for them

Subject wording barely moves the business outcome. Evidence (2026-05-29..30):
- Within-campaign A/B (same list): route-style vs pitch-style 3.53% vs 3.24%, **z=1.37, p=0.17 — n.s.**
- Cross-campaign "wins" (z=40 for «к кому обратиться» 5.35%) are a **segment confound**, not subject effect.
- **Reply rate >~1% is a vanity metric for leads**: leads-per-1k is flat across reply buckets (1-2%:0.089, 2-3%:0.082, 3%+:0.093). Lifting reply 2%→4% via wording ≈ 0 extra leads.
- Subject can only affect open+reply; it can NEVER affect lead conversion.

**Rule:** don't run subject A/B for reply. If you must compare, use `v_subject_ab_within_campaign` + a z-test; never pool across campaigns. Detail: [subjects/winning-patterns.md](./subjects/winning-patterns.md).

## Sequence design — KEEP follow-ups (steps 2-3 carry ~half the leads)

**Strongest validated finding (workflow 2026-05-30, survived full adversarial scrutiny, conf 78).**
Follow-up replies convert to a qualified lead ~**2× more often** than first-touch replies:
- First-touch 4.31% vs follow-up 10.31% (z=6.77, OR=2.55)
- **Within-campaign** (139 campaigns producing both): 4.59% vs 10.66% (z=6.35); paired sign-test p=0.0022; leave-one-out robust; 50 distinct campaigns.
- ~54% of qualified leads arrive after email 1; emails 2-3 alone carry ~47%.

**Rule:** do NOT cut sequences to 1-2 emails. Emails 2-3 are worth their send budget on the money metric. ~565 campaigns are ≤2 steps — candidates to extend. Source: query_log id=12.

## Mailbox health — NOT the binding constraint on leads

The cross-campaign "60× leads gradient by mailbox health" is a **confound of campaign age + qualifier coverage**, not causal (workflow 2026-05-30, refuted, conf 88). Among equally-healthy clients, leads still swing to zero; segment/ICP drives leads. Mailbox health still matters for deliverability hygiene, but it is NOT the lever for lead yield. Source: query_log id=11.

## Lead qualification

- **Reply quality does NOT separate lead-producers from dead projects.** Positive-interest reply share is statistically identical (lead-producers 46.5% vs never-qualified 47.6%, z=1.08, p=0.28) — dead projects' replies are genuine human interest, not junk. The discriminator is segment/ICP + campaign maturity, not reply quality. Source: query_log id=10.

## ⚠️ Methodology guardrails (hard-won)

- **Campaign AGE confounds leads/1k.** New campaigns haven't accrued leads yet → look "bad" and masquerade as a mailbox/list/segment effect. Control for age (or use only mature campaigns) before any leads-per-1k claim. Killed 3 plausible findings on 2026-05-30.
- **Use `new_leads_contacted_count`, not `contacted_count`**, for unique-leads denominators (contacted_count counts email events, ~2× inflated).
- **Verify operational claims against LIVE logs.** A workflow agent claimed the qualifier was crashing on a 412 spend-cap for ~25 campaigns; live logs showed 0 errors, healthy. Dataset analysis ≠ live system state.
- **Subject/tactic claims:** within-campaign + z-test, never cross-campaign pooling.

## Ниши и источники — где лежат лиды (cross-dataset, 2026-06-30)

Money-метрика = **lead-rate** (interested / labeled repliers), НЕ reply. Ниша/ICP — главный рычаг лидов (не доставка, не сабджект).

**Рейтинг ниш по медиане lead-rate** (`v_campaign_health`, sent_retained≥200; n кампаний в скобках): marketing_media_events 0.25 (60) · auto 0.23 (12) · logistics 0.21 (24) · **food_horeca 0.18 / reply 1.35%** (70) · **construction 0.18 / reply 1.05%** (97) · education_hr 0.18 (30) · agriculture 0.17 (5) · medical 0.15 / reply 0.68% (60) · retail 0.15 / reply 0.78% (83) · it 0.13 (61) · **manufacturing 0.11 / reply 0.90%** (123) · finance 0.10 (33) · beauty 0.08 (9).

**Источники** (тег по имени кампании, sent≥200) — по тёплости (lead-rate) и reply:
- **2ГИС** — лучший тёплый объёмный: lead 0.22 / reply 1.49% (61 камп). Локальные карточки организаций.
- **HH** — reply 1.42% (25 камп); сигнал активного найма = бюджет/рост.
- **Руспрофайл** — reply 1.25% / lead 0.13 (122 камп); реестр по ОКВЭД/выручке.
- **СБИС** — reply 1.09% / lead 0.15 (151 камп); самый объёмный реестр.
- ЦИАН (lead 0.34, недвижимость) и Яндекс.Карты (reply 2.35%) — высокие, но малые выборки (среднее раздуто).
- Слабые: goodfirms (0.45%), export-base, wbcon (lead 0.03 — холодные).

**Правило выбора источника:** локальный/офлайн B2B (стройка, ритейл, HoReCa) → карты (2ГИС/Яндекс); производство → HH (найм); по ОКВЭД/выручке → реестры (СБИС/Руспрофайл). К доминирующему СБИС в стройке/ритейле добавляй 2ГИС/ЦИАН — там выше отклик. Подробно — [`источники.md`](../источники.md).

## Доставляемость — порог и риск пула

Bounce **>4% = тревога, >8% = критично** — это битая/неверифицированная база, не инфраструктура. Высокий bounce на **активной** кампании жжёт репутацию ОБЩЕГО пула ящиков (несколько кампаний делят одни и те же mailbox-ы) → паузить и верифицировать базу ДО заливки. Объём держать ≤~30 писем/ящик/день для холодных RU-доменов.

## Sequence depth — 4 шага, не больше

К шагу 3 исчерпывается ~**99.7% всех ОТВЕТОВ** (датасет), шаг 5 = 0. При этом follow-up'ы несут ~половину **ЛИДОВ** (см. выше) — поэтому держи **1 cold + 3 follow-up**, но шаг 5+ бессмыслен. Первый follow-up (шаг 1) — 2-й по силе после cold-письма.

## «Не дожатые горячие» — считать правильно (НЕ по тексту)

`raw_emails.ue_type`: **1**=наше исходящее (шаг кампании), **2**=ответ лида, **3**=НАШ РУЧНОЙ ответ из инбокса (`our_reply`). Чтобы понять «ответили лиду или нет», смотреть наличие `ue_type=3` ПОСЛЕ его последнего `ue_type=2` — НЕ судить по тексту входящего и НЕ по `positive`-флагу (он завышает: referral = в основном вахтёрское «шлите на info@», плюс автоквитанции).

**Готовый источник — вьюха `v_dropped_hot_leads`**: она уже вычитает наши ответы (`our_reply < last_reply_at`) и оставляет только лидов, у кого мяч на нашей стороне. Используй её для «кого не дожали», а не собственную эвристику по тексту. Остаточная неточность: вьюха доверяет `llm_label='interested'`, поэтому в шортлист иногда попадают автоответы/процедурные отписки — финальный список проверяй глазами по `raw_emails.body_text`.

## Methodology — benchmark denominator

`v_campaign_health.reply_rate` / `lead_rate_labeled` считаются от `sent_retained` → reply systematically ~+40% выше, чем от сырого snapshot-sent. **Сравнивая кампанию с медианой ниши — бери обе цифры из ОДНОЙ вьюхи**, иначе вердикт «выше/ниже» переворачивается. Детали — [key-metrics.md](./key-metrics.md).

## Operational

- Данные = **ночной зеркальный синк раз в сутки** (~03:00 МСК). Не real-time; «сегодня за последний час» датасет не покажет — только до прошлой ночи.
- Тяжёлые запросы (полный скан `raw_emails`, `v_campaign_health` с `IN` из 3+ id) могут таймаутить — фильтруй по `campaign_id`, гоняй по одному id или через `CREATE TEMP TABLE … AS SELECT * FROM v_campaign_health` + `SET statement_timeout`.
