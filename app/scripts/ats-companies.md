# ATS-парсер компаний (EU/US лиды)

Англоязычный аналог HH-парсера (`hh-fleet-*.mjs`). Источник лидов — открытые вакансии:
открытая роль = сигнал к покупке, нанимающая компания = лид. В отличие от Adzuna,
ATS-боарды первичны (это карьерные страницы самих компаний), поэтому мы сразу
получаем careers-URL и после обогащения — **реальный домен** (как `site_url` у HH),
который кормит email-пайплайн.

- **Покрытие:** Greenhouse, Lever, Ashby.
- **Список компаний:** берётся вживую из open-source датасета
  [`kalil0321/ats-scrapers`](https://github.com/kalil0321/ats-scrapers) (MIT, ~86k компаний).
- **Файлы:** логика — `src/lib/jobs/atsCompanyParser.js`, CLI — `scripts/ats-companies.mjs`.

## Запуск

```bash
# из папки app/
npm run parse:ats -- --companies-limit=150
```

Или напрямую: `node scripts/ats-companies.mjs --companies-limit=150`.

### Флаги

| Флаг | По умолчанию | Описание |
|---|---|---|
| `--ats=` | `greenhouse,lever,ashby` | какие ATS обходить |
| `--companies-limit=N` | `200` | сколько компаний на каждый ATS; `0` = ВСЕ (тяжело, тысячи запросов) |
| `--shuffle` | off | перемешать список (иначе берётся начало по алфавиту) |
| `--match="<regex>"` | таксономия marketing/B2B-sales | свой фильтр по названию вакансии (ретаргет) |
| `--enrich` / `--enrich=false` | on | обогащать домен через Clearbit |
| `--enrich-limit=N` | `600` | максимум запросов к Clearbit |
| `--delay-ms=N` | `150` | пауза между запросами к ATS |
| `--out=path` | `out/ats-companies-<дата>.csv` | путь для CSV |
| `--tokens-base=URL` | raw GitHub датасета | где брать списки токенов |

### Примеры

```bash
# Полный прогон только по Greenhouse → большой CSV для кампании
npm run parse:ats -- --ats=greenhouse --companies-limit=0

# Ретаргет под флот/логистику (как RU-кампания «автопарк»)
npm run parse:ats -- --match="fleet|logistics|driver|supply chain" --shuffle

# Быстрый тест без обогащения доменов
npm run parse:ats -- --companies-limit=40 --shuffle --enrich=false
```

## Выходной CSV

Колонки: `company, domain, ats, slug, country, cities, roles_found, job_count,
job_titles, job_urls, careers_url, latest_posted_at`.

`domain` — то, что отдаём дальше в email-пайплайн (EU/US-аналог шага DaData).

## Обогащение домена (два этапа)

1. **Бесплатно, без сети:** если URL вакансии на собственном домене компании
   (а не на домене ATS), он и есть домен (напр. `augury.com`).
2. **Clearbit autocomplete** для остальных. Их CloudFront-WAF режет node/undici
   по TLS-fingerprint, поэтому запрос идёт через `curl` (есть и локально, и на
   Linux-проде). Без ключа, бесплатно. Делается 1 ретрай при пустом ответе.

## Заметки

- **Зависимость:** для Clearbit-обогащения нужен `curl` в PATH. Без него запускайте
  с `--enrich=false` — `domain` тогда заполнится только из careers-URL (этап 1).
- **Вежливость:** у каждого запроса таймаут 15с; между запросами пауза `--delay-ms`.
  При `--companies-limit=0` это тысячи обращений — гоняйте в нерабочее время.
- **Часть `domain` пустая** — нормально: не у всех компаний домен резолвится
  с первого раза. Поднимается ретраями/повторным прогоном или внешним enrichment.
- Расширение на другие ATS (Workday, SmartRecruiters, BambooHR…) — добавить
  нормализатор + endpoint в `atsCompanyParser.js`; списки токенов в датасете уже есть.
```
