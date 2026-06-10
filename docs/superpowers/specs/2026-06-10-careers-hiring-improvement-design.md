# Улучшение столбцов «Открытых вакансий» + «Кого нанимают» (/careers)

Дата: 2026-06-10
Статус: дизайн согласован, переходим к плану
Часть backlog'а из 6 столбцов (см. чат) — это кейс #1 (группа /careers).

## Контекст и проблема

- **«Открытых вакансий»** (`vacancies_count`) часто `0`/пусто, хотя страница вакансий
  есть. Реальный пример (фидбек Ксении 09.06): `moslift.ru/jobs/` — список вакансий
  есть, в таблице не отображается.
- Корень: `extractHiring` ([hiringExtractor.ts](../../app/src/lib/enrich/extractors/hiringExtractor.ts))
  требует структурных vacancy-карточек (`.vacancy`, `.job-card` …) или текста
  «N вакансий». Нестандартная вёрстка → `0`. **У `vacancies_count` нет LLM-подстраховки
  вообще** (его нет в `llmExtractFields`).
- **«Кого нанимают»** (`hiring_roles`) завязан на те же карточки; LLM-подстраховка есть,
  но на обрезке 3000 символов (общий `llmExtractor`).

## Цель

`vacancies_count` не пустует при наличии вакансий: точное число, либо оценка «N+».
`hiring_roles` заполняется надёжнее. Оба закрываются **одним** заходом ИИ на `/careers`.

## Зафиксированные решения

1. **Формат `vacancies_count`**: точное число (`12`) ИЛИ оценка «N+» (`10+`) ИЛИ прочерк.
2. **Один LLM-заход на `/careers` закрывает оба столбца** (vacancies + professions).
3. **Модель** `gpt-4o-mini`.
4. **Эвристика остаётся** (карточки/текст/внешние агрегаторы hh.ru — бесплатно); ИИ
   добирает только то, что эвристика не нашла.
5. **Убрать `hiring_roles` из общего `llmExtractFields`** (теперь спец-заход /careers).
   `vacancies_count` там и не было.
6. **Guard**: нет вакансий → прочерк (не `0`), не выдумывать.

## Компоненты

### 1. Новый extractor `careersLlmExtractor.ts`
`llmExtractHiring(careersHtml, mainHtml?): Promise<{ vacancies: number | string | null; professions: string[] } | null>`.
- Полный текст /careers (~12 000 симв), опц. main как контекст.
- `gpt-4o-mini`, requesty, ключ `OPENROUTER_SIGNALS_API_KEY || OPENROUTER_BRIEF_API_KEY`,
  модель из env `OPENROUTER_CAREERS_MODEL` (дефолт `openai/gpt-4o-mini`),
  `temperature 0`, `response_format json_object`.
- Промпт: посчитать открытые вакансии + извлечь профессии. Ответ
  `{"vacancies_count": N, "approximate": bool, "professions": [".."]}`:
  точно посчитал/число на странице → `approximate:false`; вакансии есть, точно нельзя →
  `approximate:true`, N — нижняя оценка; нет вакансий → `vacancies_count:0`.
  professions — до 5 конкретных профессий (как сейчас: «Лифтёры», «Монтажники»…),
  `[]` если нет.
- Возврат: `vacancies` exact → number; approximate → `«N+»`; `<=0`/нет → null.
  `professions` → нормализованный список (trim, длина 3..60, до 5) или `[]`.
- Guard: пустой текст → `null` без вызова. Никогда не throw. `clearTimeout` в `finally`.

### 2. Тип данных
`ExtractedData.vacancies_count?: number` → `number | string`. (`hiring_roles` уже
`string[] | LegacyHiringRoles` — не меняем.)

### 3. Рендер `formatExtraValue('vacancies_count', value)`
Выделить из общей с `team_size` ветки: `number > 0` → String; строка непустая → строка;
`0`/пусто → DASH. (`team_size` остаётся number-only.)

### 4. Интеграция в `websiteSignalProcessor.ts`
Текущий hiring-блок (extractHiring + external-fallback) сохраняем, добавляем LLM-добор:
- `hiring = extractHiring(careersHtml ?? '')`; fallback на main; затем существующий
  external-aggregator fallback (hh.ru/employer) — **не трогаем**.
- `let vacancies: number | string = hiring.vacancies_count; let professions = hiring.professions;`
- если `(vacancies === 0 || professions.length === 0)` и не aborted →
  `const llm = await llmExtractHiring(careersHtml ?? main.html, main.html);`
  если `llm`: добрать недостающее (`vacancies` если было 0 и `llm.vacancies!==null`;
  `professions` если было пусто и `llm.professions.length>0`).
- `if (vacancies_count) out.vacancies_count = vacancies; if (hiring_roles) out.hiring_roles = professions;`
- Убрать `hiring_roles` из `LlmField` / `llmNeeded` / применения `llmResult.hiring_roles`.
  `llmExtractor.ts` не трогаем (generic).

## Поток данных
URL → /careers (+main, +external) → эвристика. Полно → как есть. Чего-то нет →
`llmExtractHiring` добирает. → `out.vacancies_count` (число/«N+»), `out.hiring_roles` →
`result_text` → `formatExtraValue` → ячейки (или DASH).

## Обработка ошибок
LLM best-effort: нет ключа / 429 / timeout / кривой JSON → `null` → если и эвристика
пустая, ячейка = DASH. Строку/джобу не роняет.

## Тестирование
- Юнит `llmExtractHiring` (мок `global.fetch`): нет ключа → null без вызова; мало текста →
  null без вызова; exact → `{vacancies:number, professions}`; approximate → `«N+»`;
  vacancies 0 → `vacancies:null`; 429/кривой/throw → null; professions нормализация.
- Юнит `formatExtraValue('vacancies_count', …)`: `12`→`"12"`, `"10+"`→`"10+"`, `0`/`''`→DASH.
- `websiteSignalProcessor.test.ts`: замокать `careersLlmExtractor`; кейс «эвристика 0 →
  vacancies из LLM = «N+», professions из LLM»; существующие vacancy-карточные кейсы
  (heuristic>0) остаются зелёными (LLM не вызывается).

## Вне scope (YAGNI)
- Pricing-столбцы, integrations, «Отрасли», «Клиенты» — отдельные кейсы backlog'а.
- Не трогаем external-aggregator fallback и эвристику extractProfession.
- Без новой колонки БД.

## Открытые вопросы
Нет.
