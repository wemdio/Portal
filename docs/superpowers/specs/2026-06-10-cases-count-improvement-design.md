# Улучшение столбца «Кол-во кейсов» (cases_count)

Дата: 2026-06-10
Статус: дизайн согласован, переходим к плану

## Контекст и проблема

В сигнале «Сигналы с сайтов» столбец «Кол-во кейсов» (`cases_count`) часто пуст/`0`,
хотя в той же строке «Отрасли в кейсах» (`case_industries`) заполнены — значит кейсы
на сайте есть. Нестыковка в выгрузке.

Корень — асимметрия извлечения:
- `case_industries` берёт **весь текст** страницы /cases и считает упоминания отраслевых
  слов (низкий порог, широкое срабатывание).
- `cases_count` ([casesCountExtractor.ts](../../app/src/lib/enrich/extractors/casesCountExtractor.ts))
  требует **структурных карточек** (`.case-card`, `.portfolio-item` …) или явного
  «N проектов» в тексте. Нестандартная вёрстка → `0`.
- LLM-подстраховка не спасает: общий [llmExtractor.ts](../../app/src/lib/enrich/extractors/llmExtractor.ts)
  режет текст до 3000 симв/страница (страница кейсов длиннее), а промпт требует точного
  счёта → `null`. Отрасли же он находит по обрывку легко.

Итог: count проваливается на обоих уровнях, когда кейсы свёрстаны нестандартно.

## Цель

«Кол-во кейсов» не должно быть пустым/`0`, когда кейсы на сайте реально есть. Когда
точное число посчитать нельзя — показывать оценку «N+».

## Зафиксированные решения

1. **Формат ячейки**: точное число (`23`) ИЛИ оценка-минимум (`20+`) ИЛИ прочерк (кейсов нет).
2. **Подход A**: эвристика остаётся для точного счёта (бесплатно); если она дала `0`, но
   страница кейсов есть — специализированный LLM-экстрактор по **полному** тексту /cases.
3. **Модель** `gpt-4o-mini` (как у client_segment).
4. **`case_industries` не трогаем** (заказчик: «норм»).
5. **Guard**: нет текста/кейсов → прочерк (не `0`), модель не выдумывает.

## Компоненты

### 1. Новый extractor `casesCountLlmExtractor.ts`
Экспорт `llmCountCases(casesHtml, mainHtml?): Promise<number | string | null>`.
- Собирает видимый текст /cases (большое окно ~12 000 симв), опц. main как контекст.
- `gpt-4o-mini`, requesty-роутер, ключ `OPENROUTER_SIGNALS_API_KEY || OPENROUTER_BRIEF_API_KEY`,
  модель из env `OPENROUTER_CASES_COUNT_MODEL` (дефолт `openai/gpt-4o-mini`),
  `temperature 0`, `response_format json_object`.
- Промпт: посчитать кейсы/проекты в портфолио. Ответ `{"count": N, "approximate": bool}`:
  точно посчитал → `approximate:false`; кейсы есть, но точно нельзя → `approximate:true`,
  N — обоснованная нижняя оценка; кейсов нет → `count:0`.
- Возврат: exact → `number`; approximate → строка `` `${N}+` ``; `count<=0`/нет/ошибка → `null`.
- Guard: пустой текст → `null` без вызова. Никогда не throw (нет ключа / 429 / timeout /
  кривой JSON → `null`). `clearTimeout` в `finally`.

### 2. Тип данных
`ExtractedData.cases_count?: number | string` (было `number`). Старые `result_text` с
числом совместимы.

### 3. Рендер `formatExtraValue('cases_count', value)`
- `number > 0` → `String(n)` (как раньше).
- `string` непустая (напр. `"20+"`) → строка.
- `0` / `undefined` / `null` / пустая строка → DASH.

### 4. Интеграция в `websiteSignalProcessor.ts`
Текущий блок `cases_count` заменяется на:
- `heuristic = extractCasesCount(casesHtml ?? '')`; если `0` и нет casesHtml → `extractCasesCount(main.html)`.
- если `heuristic > 0` → `out.cases_count = heuristic` (точное, без LLM).
- иначе → `const llm = await llmCountCases(casesHtml ?? main.html, main.html); if (llm !== null) out.cases_count = llm;`
- Убрать `cases_count` из общего LLM-fallback (`LlmField`, `llmNeeded.add('cases_count')`,
  применение `llmResult.cases_count`) — теперь спец-экстрактор. `llmExtractor.ts` не трогаем
  (generic, поле остаётся, просто не запрашивается).

## Поток данных
URL → /cases (+main) → эвристика. Точно → число. Иначе → `llmCountCases` → число или «N+».
→ `out.cases_count` → `result_text` (JSON) → `formatExtraValue` → ячейка (или DASH).

## Обработка ошибок
LLM best-effort: нет ключа / 429 / timeout / кривой JSON → `null` → если и эвристика `0`,
ячейка = DASH. Строку/джобу не роняет.

## Тестирование
- Юнит `llmCountCases` (мок `global.fetch`): нет ключа → `null` без вызова; пустой текст →
  `null` без вызова; exact → `number`; approximate → `"N+"`; `count:0` → `null`;
  429 / кривой JSON / throw → `null`.
- Юнит `formatExtraValue('cases_count', …)`: `23`→`"23"`, `"20+"`→`"20+"`, `0`/`''`/undefined→DASH.
- `websiteSignalProcessor.test.ts`: замокать `casesCountLlmExtractor`; кейс «эвристика 0 →
  используется LLM-оценка»; существующие кейсы с реальными `.case-card` (heuristic>0) остаются
  зелёными (LLM не вызывается).

## Вне scope (YAGNI)
- Не переписываем `case_industries`.
- Не меняем приоритет domCount vs textClaim в эвристике (занижение точного счёта — отдельная,
  более редкая неточность).
- Не объединяем с client_segment-вызовом (изоляция; gpt-4o-mini дёшев).
- Без новой колонки БД.

## Открытые вопросы
Нет.
