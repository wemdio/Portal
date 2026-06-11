# Улучшение столбца «Интеграции» (/integrations)

Дата: 2026-06-10
Статус: дизайн согласован, переходим к плану
Часть backlog'а из 6 столбцов — кейс #3 (последний, /integrations).

## Контекст и проблема

`integrations` уже имеет сильную базу: `integrationsFromSignals` (детект подключённых
скриптов/виджетов — CRM, чаты, звонки, платежи, e-mail, маркетплейсы, ERP) +
`extractIntegrations` (scrape логотипов/текста секций «Интеграции/Партнёры»). Слабость —
сервисы без script-следов, упомянутые только в тексте/нестандартно: эвристика их пропускает,
а подстраховка идёт через общий `llmExtractor` (обрезка 3000 символов).

## Цель

Когда итоговый список пуст — один ИИ-заход по **полной** `/integrations` добирает названия
сервисов. База (signatures + scrape) и формат ячейки не меняются.

## Зафиксированные решения

1. **Эвристика (signatures + scrape) остаётся первой и без изменений.**
2. **LLM-добор только когда итоговый список пуст** (нет следов и секцию не распознали).
3. **Модель** `gpt-4o-mini`, полный текст /integrations.
4. **Убрать `integrations` из общего `llmExtractFields`** — закрывает спец-заход.
5. **Формат/тип не меняются** (`string[]`, рендер через запятую, cap 20).
6. **Guard**: нет данных → `[]` (DASH), не выдумывать.

## Компоненты

### 1. Новый extractor `integrationsLlmExtractor.ts`
`llmExtractIntegrations(integrationsHtml, mainHtml?): Promise<string[]>`.
- Полный текст /integrations (~12 000 симв), опц. main.
- `gpt-4o-mini`, requesty, ключ `OPENROUTER_SIGNALS_API_KEY || OPENROUTER_BRIEF_API_KEY`,
  модель из env `OPENROUTER_INTEGRATIONS_MODEL` (дефолт `openai/gpt-4o-mini`),
  `temperature 0`, `response_format json_object`.
- Промпт (правила из общего `llmExtractor`): названия сторонних сервисов/систем, с которыми
  есть интеграция (CRM, телефония, аналитика, платёжные системы, маркетплейсы, мессенджеры,
  ERP). Только явно заявленные. НЕ услуги самой компании, пункты меню, кнопки, заголовки блога.
  Ответ `{"integrations": ["..."]}`.
- Нормализация: строки, trim, длина 2..40, dedup (case-insensitive), cap 20.
- Возврат: список (возможно пустой). Guard: пустой текст → `[]` без вызова. Никогда не throw
  (нет ключа / 429 / timeout / кривой JSON → `[]`). `clearTimeout` в `finally`.

### 2. Интеграция в `websiteSignalProcessor.ts`
Текущий блок (`integrationsFromSignals` + `extractIntegrations` + merge, cap 20) сохраняем;
добавляем добор:
- посчитать `merged` как сейчас;
- если `merged.length === 0` и не aborted → `const llm = await llmExtractIntegrations(subpageHtml.integrations ?? main.html, main.html);`
  если `llm.length > 0` → `merged = llm.slice(0, 20)`.
- `out.integrations = merged`.
- Убрать `integrations` из `LlmField`, `llmNeeded`, применения `llmResult.integrations`.
  `llmExtractor.ts` не трогаем (generic, остаётся для founded_year/team_size/case_industries).

### 3. Форматирование / типы
Без изменений (`formatExtraValue` уже рендерит `integrations` как список через запятую; тип
`string[]`).

## Поток данных
URL → /integrations (+main) + signatures → merge. Пусто → `llmExtractIntegrations` добирает.
→ `out.integrations` → `result_text` → `formatExtraValue` → ячейка (или DASH).

## Обработка ошибок
LLM best-effort: нет ключа / 429 / timeout / кривой JSON → `[]` → если merge пуст, ячейка = DASH.
Строку/джобу не роняет.

## Тестирование
- Юнит `llmExtractIntegrations` (мок `global.fetch`): нет ключа → `[]` без вызова; мало текста →
  `[]` без вызова; валидный ответ → нормализованный список; junk/длинные отфильтрованы, dedup;
  429/кривой/throw → `[]`.
- `websiteSignalProcessor.test.ts`: замокать `integrationsLlmExtractor`; кейс «нет следов и
  scrape пуст → integrations из LLM»; существующие integrations-кейсы (signatures есть) остаются
  зелёными (merge непуст → LLM не вызывается).

## Вне scope (YAGNI)
- Остальные 5 столбцов уже сделаны.
- Не трогаем `integrationsFromSignals`, `extractIntegrations`, signatures, формат ячейки.
- Не добираем LLM-ом, когда signatures уже что-то нашли (доверяем надёжной базе).
- Без новой колонки БД.

## Открытые вопросы
Нет.
