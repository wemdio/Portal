# Social Latest News — replace 4 event signals with 1 LLM-picked post

**Status:** approved 2026-06-17

## Why

Текущий блок event-сигналов («Открытие», «Ребрендинг», «Ремонт», «География» + их выжимки = 8 колонок) на практике даёт мало пользы для outreach. Большинство компаний возвращают `Нет / Нет / Нет / —`, оператор тратит время на скролл пустых колонок.

Заменяем на одну колонку «Последняя новость из соц сетей»: LLM получает 5–10 свежих постов из TG/VK/OK/Dzen и выбирает один — самую интересную новость о компании. Эту строку оператор может прочитать и сразу использовать как hook для письма.

## Remove

- 8 ExtractorKey из `app/src/lib/enrich/extractors/types.ts`:
  - `event_opening`, `event_opening_summary`
  - `event_redesign`, `event_redesign_summary`
  - `event_renovation`, `event_renovation_summary`
  - `event_geo`, `event_geo_summary`
- Файл `app/src/lib/enrich/extractors/eventDetector.ts` — целиком.
- Группа `events` («События в соцсетях») из `EXTRACTOR_GROUPS`.
- Cascade rules для всех 8 ключей в `CASCADE_RULES`.
- Поля event-* из `ExtractedData`.
- Метки event-* из `EXTRACTOR_LABELS`.
- Тесты `eventDetector` в `app/tests/lib/signalDetector.test.ts`.
- Упоминание «События в соцсетях» в `app/src/lib/projectBriefHypotheses/sources.ts` (если есть).

## Add

**Новый ExtractorKey: `social_latest_news`.**

- Метка: «Последняя новость из соц сетей»
- Позиция в `ALL_EXTRACTOR_KEYS`: **сразу после `social_media`** → в Excel идёт последней колонкой после «Соцсети».
- Подстраницы: `['about']` (как у `social_media` — нужно чтобы парсер нашёл ссылки на TG/VK/OK).
- Cascade: `social_latest_news → ['social_media']` (без соцсетей постов не достать).
- Группа в UI: `company` («Компания и интеграции»), последний пункт в списке.
- Включён в preset `all` автоматически через спред `[...ALL_EXTRACTOR_KEYS]`.
- В preset `audit` — НЕ добавляем (preset фиксирован, обновим если попросят отдельно).

**Новое поле `ExtractedData.social_latest_news?: string;`.**

Формат значения — готовая строка вида:

```
2026-06-12 [https://t.me/foo] — Открыли новый филиал в Казани, второй за этот год. Уже зарезервировано 80% столов.
```

Длина текста поста ограничена 300 символами + многоточие при обрезке. Если LLM не смог выбрать пост / нет валидных постов / `social_media` пуст — поле остаётся `undefined`, `formatExtraValue` рендерит DASH.

**Новый файл `app/src/lib/enrich/extractors/socialLatestNewsDetector.ts`.**

Структура копирует `eventDetector.ts` (та же httpFetch обвязка к Requesty, тот же набор охранников: hasEnoughContent, JSON-extract из markdown fence, retry-free, timeout 30s, log-not-throw).

Вход:

```ts
export interface PickLatestNewsInput {
  socialPosts: SocialPost[]; // от socialPostsExtractor
}
```

Выход:

```ts
export interface LatestNewsResult {
  social_latest_news?: string; // готовая строка для ячейки
}
```

LLM-промпт (system):

> Ты — аналитик новостей компаний для B2B-аутрича. Тебе даются последние посты из соцсетей компании (TG/VK/OK/Dzen) с их датами. Выбери ОДИН пост — самую интересную новость О КОМПАНИИ: что с ней произошло, что нового она запустила/открыла/изменила/сделала.
>
> Не выбирай:
> — репосты чужих новостей и общих лент;
> — поздравления с праздниками без новости о компании;
> — общие советы / лайфхаки / «полезные статьи»;
> — рекламу третьих лиц;
> — opinion posts без события.
>
> Если ни в одном посте нет конкретной новости — возьми самый свежий пост с фактическим содержанием (что-то, что компания РЕАЛЬНО сделала или показала).
>
> Верни строго JSON: `{"index": N, "reason": "1 предложение почему этот"}`. `index` — 0-based индекс в списке. Если ни один пост не подходит вообще — `{"index": -1, "reason": "..."}`.

LLM-промпт (user):

```
[ПОСТЫ]
0. [telegram | 2026-06-15] Текст поста...
1. [vk | 2026-06-12] Текст поста...
2. ...
```

После получения `{index, reason}`:
- Если `index < 0` или вне границ → return `{}`.
- Берём `posts[index]`, формируем строку: `${date ?? '—'} [${url}] — ${text.slice(0, 300)}${text.length > 300 ? '…' : ''}`.

**`formatExtraValue.ts`:**
- Добавить ветку для `social_latest_news`: вернуть строку как есть (string или DASH).

**Pipeline-точка вызова:**
- Найти где сейчас вызывается `detectEventSignals` (вероятно `websiteEnrichmentWorker.ts` или соседний `enrich/processor`).
- Заменить на `pickLatestNews` с тем же `socialPosts` массивом. blogText/aboutText больше не нужны.

## Не трогаем

- `blog_last_post` (колонка «Последний пост») — отдельная сущность про блог сайта. Если потом захочется объединить — отдельная задача.
- `social_media` (колонка «Соцсети») — как есть.
- `socialPostsExtractor.ts` — переиспользуем без изменений.
- Схема `result_text` в БД — поля event-* в старых записях останутся, просто перестанут рендериться.

## Тесты

`app/tests/lib/signalDetector.test.ts`:
- Удалить блоки про event-сигналы.
- Smoke test: моки `socialPosts = [{date: '2026-06-15', text: 'Открыли в Казани', network: 'telegram', url: 't.me/x'}, {date: '2026-06-10', text: 'С праздником!', network: 'telegram', url: 't.me/x'}]` + мок Requesty возвращает `{index: 0}` → ожидаем `social_latest_news` начинается с `2026-06-15`.
- Smoke test: пустой `socialPosts` → `{}`.

## Совместимость и риски

- Старые записи с заполненными event_* полями просто не отрендерятся. Файлы Excel, выгруженные ДО редизайна, не сломаются (это статика).
- Стоимость LLM на компанию слегка снижается: меньший max_tokens (≤200 вместо 500), меньший system prompt.
- Recall новой колонки = recall соцсетей. На наших тестах ~17% компаний имеют socials → 17% получат «Последнюю новость». Остальные — DASH. Это OK, потому что blog_last_post покрывает оставшихся.
