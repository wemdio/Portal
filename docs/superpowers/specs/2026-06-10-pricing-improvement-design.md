# Улучшение столбцов «Мин. цена» + «Модель продаж» + «Free trial» (/pricing)

Дата: 2026-06-10
Статус: дизайн согласован, переходим к плану
Часть backlog'а из 6 столбцов — кейс #2 (группа /pricing).

## Контекст и проблема

- **Мин. цена** (`pricing_min`): цены часто в картинках / подгружаются скриптами /
  нестандартная вёрстка → эвристика молчит → пусто.
- **Модель продаж** (`pricing_model`): regex-эвристика ставит `unknown` («—»), когда нет
  явных маркеров (цена/кнопка/тариф).
- **Free trial** (`free_trial`): tri-state, наименее битый, но LLM-подстраховка идёт через
  общий `llmExtractor` (обрезка 3000 символов).
- Общий LLM-fallback покрывает все три, но на обрезанном тексте и со строгим промптом.

## Цель

Поднять заполняемость трёх столбцов: где эвристика молчит — один ИИ-заход по **полной**
`/pricing` добирает модель, цену и free trial. Форматы ячеек не меняются.

## Зафиксированные решения

1. **Один LLM-заход на `/pricing`** закрывает три столбца (model + min + free_trial).
2. **Эвристика остаётся первой** (бесплатно); ИИ добирает только пустое.
3. **Модель** `gpt-4o-mini`.
4. **Форматы и типы не меняются**: `pricing_model: PricingModel`, `pricing_min: PriceValue`,
   `free_trial: boolean`. `formatExtraValue` и `types.ts` не трогаем.
5. **Убрать `pricing_model`, `pricing_min`, `free_trial` из общего `llmExtractFields`** —
   их закрывает спец-заход.
6. **Guard**: нет данных → поле остаётся пустым (DASH), не выдумывать.

## Компоненты

### 1. Новый extractor `pricingLlmExtractor.ts`
`llmExtractPricing(pricingHtml, mainHtml?): Promise<{ pricing_model: PricingModel | null; pricing_min: PriceValue | null; free_trial: boolean | null } | null>`.
- Полный текст /pricing (~12 000 симв), опц. main как контекст.
- `gpt-4o-mini`, requesty, ключ `OPENROUTER_SIGNALS_API_KEY || OPENROUTER_BRIEF_API_KEY`,
  модель из env `OPENROUTER_PRICING_MODEL` (дефолт `openai/gpt-4o-mini`),
  `temperature 0`, `response_format json_object`.
- Промпт: вернуть `{"pricing_model": "...|null", "pricing_min": {"value","currency"}|null, "free_trial": true|false|null}`.
  Правила переносятся из общего `llmExtractor` (self-serve/sales-led/enterprise/freemium;
  pricing_min — минимальная стартовая цена ПАКЕТА услуг, не per-unit «за лид/клик»;
  free_trial — любой бесплатный вход: trial/демо/консультация/аудит).
- Нормализация: `pricing_model` ∈ enum или null; `pricing_min` `{value>0..1e8, currency∈RUB/USD/EUR}`
  или null; `free_trial` boolean или null.
- Возврат: `null`, если все три поля null (нечего добирать). Иначе объект.
- Guard: пустой текст → `null` без вызова. Никогда не throw. `clearTimeout` в `finally`.

### 2. Интеграция в `websiteSignalProcessor.ts`
Текущие pricing-блоки (`extractPricingModel`, `extractPricingDetails` → min + free_trial)
оставляем; добавляем после них общий LLM-добор по /pricing:
- собрать, чего не хватает: `model === 'unknown'`/пусто, `!pricing_min`, `free_trial === undefined`;
- если хоть что-то не хватает и есть смысл — `const llm = await llmExtractPricing(pricingHtml ?? main.html, main.html);`
- добрать недостающее: `pricing_model` если был unknown/пусто и `llm.pricing_model` не null;
  `pricing_min` если не было и `llm.pricing_min` не null; `free_trial` если был undefined и
  `llm.free_trial` не null (true ИЛИ false — как сейчас, чтобы «Нет» попадал в ячейку).
- Убрать `pricing_model` / `pricing_min` / `free_trial` из `LlmField`, `llmNeeded`, применения
  `llmResult.*`. `llmExtractor.ts` не трогаем (generic).

> Реализация добора может переиспользовать существующую тройку условий из общего fallback —
> просто перенаправить их на `llmExtractPricing` вместо `llmExtractFields`.

### 3. Форматирование / типы
Без изменений (`formatExtraValue` уже рендерит pricing_model рус-ярлыками, pricing_min как
«value currency», free_trial как Да/Нет/DASH; типы прежние).

## Поток данных
URL → /pricing (+main) → эвристика (model/min/free_trial). Чего-то нет → `llmExtractPricing`
добирает. → `out.*` → `result_text` → `formatExtraValue` → ячейки (или DASH).

## Обработка ошибок
LLM best-effort: нет ключа / 429 / timeout / кривой JSON → `null` → пустые поля = DASH.
Строку/джобу не роняет.

## Тестирование
- Юнит `llmExtractPricing` (мок `global.fetch`): нет ключа → null без вызова; мало текста →
  null без вызова; полный ответ → `{pricing_model, pricing_min, free_trial}`; частичный
  (только free_trial) → остальные null; невалидные значения отфильтрованы (model не из enum →
  null; pricing_min с value 0/без валюты → null); 429/кривой/throw → null; все null → null.
- `websiteSignalProcessor.test.ts`: замокать `pricingLlmExtractor`; кейс «эвристика unknown/нет
  цены → добор из LLM»; существующие pricing-кейсы (heuristic нашла) остаются зелёными (LLM не
  перетирает найденное).

## Вне scope (YAGNI)
- Интеграции — отдельный кейс backlog'а.
- «Отрасли», «Клиенты», careers — уже сделаны/не трогаем.
- Не меняем форматы ячеек и эвристику цен/job-posting guard.
- Без новой колонки БД.

## Открытые вопросы
Нет.
