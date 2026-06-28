/**
 * Модель для AI-шагов инструмента «Гипотезы (сайт или запрос)» (sales).
 *
 * Пинится в обход политики `policy/gemini-flash`: этот алиас в Requesty стал
 * роутиться на `deepseek-v4-flash` (reasoning-модель, отвечает по-китайски и
 * считает русский ввод «нечитаемым», при малом max_tokens — пустой content).
 * Opus 4.8 даёт заметно более релевантные, ICP-привязанные гипотезы (проверено
 * на реальных брифах). Переопределяется env `SALES_HYPOTHESES_MODEL`.
 *
 * Серверный модуль (process.env) — импортируется только из роутов инструмента.
 */
export const SALES_HYPOTHESES_MODEL =
  process.env.SALES_HYPOTHESES_MODEL ?? 'anthropic/claude-opus-4-8';
