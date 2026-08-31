# Bench API

Внешний доступ к инструментам студии: парсерам, конструктору баз и поиску по
собранным базам. Предназначен для скриптов и автоматизаций, которые пишут
подрядчики.

Дизайн и решения — [`docs/superpowers/specs/2026-08-30-bench-api-design.md`](./superpowers/specs/2026-08-30-bench-api-design.md).

---

## 1. Ключ

Ключ выдаёт админ портала на экране **Админка → Ключи API**. Он выглядит так:

```
bench_live_a7f3K9mQ2xR8vN4pL6wZ1tY5
```

Ключ показывается **один раз** при выдаче. В базе хранится только его
отпечаток — восстановить ключ нельзя, потерянный заменяется новым.

Передавайте его в каждом запросе:

```
Authorization: Bearer bench_live_...
```

Допустим и заголовок `X-Api-Key: bench_live_...` — на случай если клиент уже
занял `Authorization` под своё.

**Отзыв действует немедленно.** Ключ проверяется в базе на каждом запросе, без
кэша: как только админ нажал «Отозвать», следующий же запрос получает `401`.

## 2. Что доступно

Спросите у самого API — он себя описывает:

```bash
curl -H "Authorization: Bearer $BENCH_KEY" \
  https://<хост-портала>/api/bench/v1/tools
```

Ответ перечисляет **только те инструменты, которые открыты вашему ключу**, и по
каждому даёт машинную схему параметров (JSON Schema), тип и признак поддержки
остановки:

```json
{
  "tools": [
    {
      "id": "yandexmaps",
      "kind": "job",
      "title": "Яндекс.Карты",
      "stop_supported": false,
      "stop_reason": "Яндекс.Карты не поддерживают остановку задачи — дождитесь завершения",
      "params": { "type": "object", "properties": { "search_urls": { … } } }
    }
  ]
}
```

Эта ручка — источник правды по параметрам. Она собирается из того же кода,
который проверяет ваши запросы, поэтому не может разойтись с реальным
поведением. Документация ниже её пересказывает, но при расхождении верьте
`/tools`.

## 3. Два типа инструментов

**Задачи** (`kind: "job"`) работают долго. Вы ставите задачу, периодически
спрашиваете статус, затем забираете результат.

**Поиск** (`kind: "search"`) отвечает сразу из уже собранных данных.

---

## 4. Задачи

### Поставить

```
POST /api/bench/v1/jobs
Content-Type: application/json

{ "tool": "yandexmaps", "params": { "search_urls": ["https://yandex.ru/maps/?text=кофейни"], "max_results": 500 } }
```

Ответ:

```json
{
  "id": "9f2c…",
  "tool": "yandexmaps",
  "status": "queued",
  "progress": { "done": 0, "total": null },
  "rows_found": 0,
  "error": null,
  "created_at": "2026-08-31T10:00:00.000Z",
  "finished_at": null
}
```

### Узнать статус

```
GET /api/bench/v1/jobs/{id}?tool=yandexmaps
```

Параметр `tool` обязателен: идентификаторы задач уникальны внутри своего
инструмента, а инструментов много.

Статусы — единые для всех инструментов:

| Статус | Значит |
|---|---|
| `queued` | стоит в очереди, ещё не начата |
| `running` | выполняется |
| `done` | завершена успешно |
| `failed` | упала; причина в поле `error` |
| `stopped` | остановлена |

`progress.total` равен `null`, пока объём работы неизвестен — это нормально в
начале, не считайте это нулём.

### Забрать результат

```
GET /api/bench/v1/jobs/{id}/results?tool=yandexmaps&limit=200&cursor=...
```

Результат отдаётся **страницами по курсору**:

```json
{ "rows": [ … ], "cursor": "abc123", "has_more": true }
```

Пока `has_more` истинно — подставляйте полученный `cursor` в следующий запрос.
`limit` по умолчанию 200, максимум 1000.

Смещения (`offset`) здесь нет намеренно: результаты дописываются в процессе
работы, и на смещении вы бы теряли и дублировали строки.

**У обогащения по ИНН результат — файл**, поэтому ответ другой:

```json
{ "kind": "file", "url": "https://…", "expires_in_seconds": 900 }
```

Ссылка живёт 15 минут. Пока задача не завершена, ручка отвечает `409`.

### Остановить

```
POST /api/bench/v1/jobs/{id}/stop?tool=googlemaps
```

**Работает не у всех инструментов.** Смотрите `stop_supported` в `/tools`: у
не поддерживающих ручка вернёт `409` с человеческой причиной. Это не
ограничение доступа — у этих парсеров остановки нет и внутри портала.

### Список своих задач

```
GET /api/bench/v1/jobs?tool=yandexmaps&status=done
```

`tool` обязателен, `status` необязателен. Отдаётся до 100 последних задач.

---

## 5. Поиск

```
POST /api/bench/v1/search
Content-Type: application/json

{ "source": "company-base", "filters": { "country": ["russia"] }, "limit": 200, "cursor": null }
```

Ответ той же формы, что у результатов задачи: `{ rows, cursor, has_more }`.

---

## 6. Каталог инструментов

### Задачи

| `tool` | Что делает | Остановка |
|---|---|---|
| `base-constructor` | обогащает загруженную базу выбранными шагами | да |
| `yandexmaps` | организации из выдачи Яндекс.Карт | нет |
| `googlemaps` | организации из Google Maps | да |
| `googlenews` | новости из Google News | да |
| `hh` | вакансии и работодатели с HH | нет |
| `hh-archive` | то же по архиву за период | да |
| `ats` | компании по ATS-системам найма | нет |
| `eng-hiring` | англоязычный найм | нет |
| `search` | сбор по поисковой выдаче | нет |
| `yandex-direct` | рекламодатели из Яндекс.Директа | да |
| `inn-enrich` | обогащение компаний по ИНН | нет |

### Поиск

| `source` | Что это |
|---|---|
| `company-base` | наша база компаний |
| `2gis` | справочник 2GIS |
| `our-bases` | наша база баз (каталог компаний) |

Точные параметры каждого — в `GET /tools`. Ниже только неочевидное.

**`base-constructor`** принимает базу массивом строк, где первая строка —
заголовки: `data: [["company","site"],["Альфа","alpha.ru"]]`. Шаги задаются
списком `selected_steps`. Два шага требуют настройки в `step_config`: `ta_scoring`
нужен непустой `brief`, `personalization` — непустой `prompt`. Без них запрос
отвергается: пустой бриф молча отбросил бы все строки ниже порога.

**`inn-enrich`** принимает список ИНН прямо в запросе: `{ "inns": ["7700000001"] }`.
Загружать файл не нужно.

**`googlemaps` / `googlenews`** не принимают задержки между запросами — они
фиксированы. Слишком быстрый темп ведёт к капче и бану наших прокси, а
последствия несёт вся студия.

**`yandex-direct`** работает в двух режимах. При `keyword_mode: "manual"` нужен
непустой `keywords`; при `"ai"` — непустое описание `audience`, ключи
сгенерирует система.

---

## 7. Ошибки

Единая форма у всех ручек:

```json
{ "error": { "code": "invalid_params", "message": "Параметры не прошли проверку", "details": [ … ] } }
```

| `code` | HTTP | Когда |
|---|---|---|
| `unauthorized` | 401 | ключа нет, ключ неверный или отозван |
| `tool_not_allowed` | 403 | инструмент не открыт вашему ключу |
| `invalid_params` | 400 | параметры не прошли проверку; что именно — в `details` |
| `rate_limited` | 429 | слишком часто; см. заголовок `Retry-After` |
| `quota_exceeded` | 429 | исчерпана суточная норма; в `details` — когда обнулится |
| `not_found` | 404 | задачи или инструмента нет |
| `conflict` | 409 | действие несовместимо с состоянием |
| `server_error` | 500 | сбой на нашей стороне |

**`not_found` на чужую задачу — это не ошибка документации.** Задачи чужих
ключей для вас не существуют: API не различает «нет такой» и «есть, но не
ваша».

---

## 8. Лимиты

У каждого ключа четыре потолка, их значения задаёт админ при выдаче:

| Лимит | Зачем |
|---|---|
| запросов в минуту | чтобы цикл в скрипте не забил приложение |
| новых задач в сутки | парсинг стоит денег и прокси |
| строк результата в сутки | общий на выгрузку задач и поиск |
| задач одновременно | очередь обработки общая со всей студией |

При превышении приходит `429`. Не ретрайте вслепую — читайте `Retry-After` и
`details.resets_at`.

Суточные нормы обнуляются в полночь по Москве.

---

## 9. Примеры

### curl: поставить и дождаться

```bash
KEY="bench_live_..."
HOST="https://<хост-портала>"

JOB=$(curl -s -X POST "$HOST/api/bench/v1/jobs" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"tool":"yandexmaps","params":{"search_urls":["https://yandex.ru/maps/?text=кофейни"],"max_results":200}}')

ID=$(echo "$JOB" | jq -r .id)

curl -s "$HOST/api/bench/v1/jobs/$ID?tool=yandexmaps" -H "Authorization: Bearer $KEY" | jq .
```

### Python: полный цикл с постраничной выгрузкой

```python
import time
import requests

HOST = "https://<хост-портала>"
KEY = "bench_live_..."
S = requests.Session()
S.headers["Authorization"] = f"Bearer {KEY}"


def create(tool: str, params: dict) -> str:
    r = S.post(f"{HOST}/api/bench/v1/jobs", json={"tool": tool, "params": params})
    r.raise_for_status()
    return r.json()["id"]


def wait(tool: str, job_id: str, poll_seconds: int = 15) -> dict:
    """Опрашивать статус редко: чаще — только зря тратить лимит запросов."""
    while True:
        r = S.get(f"{HOST}/api/bench/v1/jobs/{job_id}", params={"tool": tool})
        r.raise_for_status()
        job = r.json()
        if job["status"] in ("done", "failed", "stopped"):
            return job
        time.sleep(poll_seconds)


def fetch_all(tool: str, job_id: str):
    """Идти курсором, а не смещением — иначе строки теряются и дублируются."""
    cursor = None
    while True:
        params = {"tool": tool, "limit": 500}
        if cursor:
            params["cursor"] = cursor
        r = S.get(f"{HOST}/api/bench/v1/jobs/{job_id}/results", params=params)
        r.raise_for_status()
        page = r.json()
        yield from page["rows"]
        if not page["has_more"]:
            return
        cursor = page["cursor"]


tool = "yandexmaps"
job_id = create(tool, {"search_urls": ["https://yandex.ru/maps/?text=кофейни"], "max_results": 200})

job = wait(tool, job_id)
if job["status"] != "done":
    raise SystemExit(f"Задача завершилась как {job['status']}: {job['error']}")

rows = list(fetch_all(tool, job_id))
print(f"Получено строк: {len(rows)}")
```

### Python: поиск по базе компаний

```python
r = S.post(
    f"{HOST}/api/bench/v1/search",
    json={"source": "company-base", "filters": {"country": ["russia"]}, "limit": 200},
)
r.raise_for_status()
print(r.json()["rows"][:3])
```

---

## 10. Что стоит знать заранее

**Опрашивайте статус редко.** Раз в 10–30 секунд достаточно: парсинг идёт
минутами и часами, а каждый запрос тратит минутный лимит.

**Ретраи — только с паузой.** На `429` дождитесь `Retry-After`. На `500`
повторите через несколько секунд, но не в цикле без ограничения.

**Удаления в API нет.** Такого действия не существует — ни задач, ни данных
удалить нельзя.

**Вы видите только свои задачи.** Задачи, поставленные другими ключами и
сотрудниками студии, для вас не существуют.

**Ключ — секрет.** Не кладите его в репозиторий и не передавайте третьим лицам.
Если он утёк, скажите нам: отзыв занимает несколько секунд и действует сразу.
