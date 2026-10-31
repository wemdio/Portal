# 2026-07-02 — Feasibility: доменная история как сигнал для email-валидатора

> Исторический срез на 02.07.2026, а не описание текущей схемы или покрытия. Позднее появился webhook отказов; см. [определения метрик](../concepts/key-metrics.md). Результаты и предложения ниже требуют повторной проверки перед применением.

**Вопрос:** хватает ли в `instantly_dataset` данных, чтобы валидатор при вердикте «catch-all» дополнительно смотрел нашу историю отправок по домену («слали 40 раз, 0 баунсов» → deliverable; «12/12 в баунс» → dead)?

## Объём (2026-07-02)

- `raw_emails` ue_type=1 (sent): **2 541 690** строк, непрерывно 2026-03 → 02.07.2026 (+ хвосты дек/фев), растёт еженощно. Ответов (ue2) 79K с 2025-08.
- Покрытие проверено на живой базе (АДК СБИС, 830 корп. catch-all доменов): **689 (83%) доменов уже есть в истории, 622 (75%) с ≥3 отправками, 358 (43%) с ≥10; всего на них слали 16 544 письма.** Студия крутится в одном РФ-B2B универсуме — пересечение баз высокое.

```sql
SELECT count(*) FILTER (WHERE cnt>=3) FROM (
  SELECT lower(split_part(to_email,'@',2)) d, count(*) cnt
  FROM raw_emails WHERE ue_type=1 AND lower(split_part(to_email,'@',2)) IN (...) GROUP BY 1) t
```

## Пробел на дату исследования: исходов (баунсов) per-domain в датасете нет

1. `raw_emails` не содержит bounce-событий вовсе — `lookup_ue_types` = {1 sent, 2 lead_reply, 3 our_reply, 4 unknown}.
2. `raw_leads.raw_payload->>'status'` мог бы дать per-lead bounce (в Instantly status=-1), но **синк лидов неполный**: кампания с `bounced_count=6224` (снапшот) имеет только 27 лидов со status=-1. Проверка:
```sql
WITH snap AS (SELECT DISTINCT ON (campaign_id) campaign_id, bounced_count
  FROM raw_campaign_analytics_overview_snap ORDER BY campaign_id, snapshot_id DESC)
SELECT s.campaign_id, s.bounced_count,
  count(*) FILTER (WHERE l.raw_payload->>'status'='-1') st_m1
FROM snap s JOIN raw_leads l USING (campaign_id) WHERE s.bounced_count>0 GROUP BY 1,2
```
3. Надёжно есть только **агрегат** `bounced_count` per campaign (снапшоты).

## Вывод

На дату исследования сигнал «сколько слали на домен» был доступен для 83% доменов выбранной базы. На тот момент для сигнала «что вышло» предлагалось дособрать:
- **разовый бэкфилл** статусов лидов через Instantly API `leads/list` по ~822 кампаниям с отправками (статусы содержат bounced, как в CSV-экспортах);
- **починить ночной leads-sync** (тянуть статусы полно) и/или подписать bounce-вебхук;
- после этого — view `v_domain_outcomes` (domain → sent, bounced, last_seen) для валидатора (lookup, не замедляет пробу).

Связанный контекст: разборы баунсов Coldy/АДК и Instantly/Knipex (memory `coldy-bounce-validator-analysis`) — 83% баунсов приходится на catch-all сегмент, который RCPT-пробой непроверяем; доменная история — главный кандидат на градацию этого сегмента.
