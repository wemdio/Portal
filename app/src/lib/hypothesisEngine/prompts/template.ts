/**
 * Промпты стадии template — финальный шаблон по архитектуре 85/15:
 *  - buildTemplatePlanMessages: план (fixed_block ~85% + personalization_plan
 *    + segment_additions ~15%) — structured output через HeTemplatePlanSchema;
 *  - buildTemplateLettersMessages: генерация финальных писем по плану —
 *    свободный текст с маркерами ---LETTER N--- (парсинг letterParser).
 *
 * 15% — это дописка под КОНКРЕТНУЮ загруженную базу (углы/примеры/специфика
 * сегментов из base_analyze), НЕ per-lead персонализация: per-lead остаётся
 * downstream-шагу stepPersonalize. Здесь per-lead присутствует только как
 * операторы {{var}}, замапленные на колонки базы.
 */

import type { LLMMessage } from '../llm';
import type { HeBaseAnalysisOutput, HeTemplatePlanOutput } from '../schemas';
import type { HeChainLanguage, HeChainLetter } from '../types';
import { CHAIN_REGULATIONS } from './chain';

/* ─────────────────────── Шаг 1: план 85/15 ─────────────────────── */

const PLAN_SYSTEM = `Ты — creative director агентства Polza. Собираешь план финального шаблона цепочки по архитектуре 85/15:

- ~85% — FIXED BLOCK: фиксированный смысловой костяк цепочки под гипотезу/вертикаль. Одинаков для всех лидов: боли сегмента, оффер клиента, доказательства, структура писем. Пиши его как готовое ТЗ копирайтеру: по каждому письму — цель, ключевая мысль, аргументы, какое доказательство использовать.
- ~15% — SEGMENT ADDITIONS: дописка под КОНКРЕТНУЮ загруженную базу. Углы, примеры, формулировки из анализа базы: доминирующие гео/индустрии/роли, замеченные сегменты. Это НЕ per-lead персонализация — это адаптация под то, что реально видно в строках базы.
- personalization_plan — операторы {{var}} ТОЛЬКО под реальные колонки базы (список ниже). Обычно это имя/компания/сайт/должность. Не более 1–2 операторов на письмо (см. регламент). Для каждого: var (имя оператора без скобок, camelCase), column (точное имя колонки из списка), fallback (что подставить, если ячейка пустая — опционально).

Правила:
- fixed_block опирается на готовую цепочку вертикали (ниже) — сохраняй её сильные ходы, усиливай слабые.
- additions привязаны к конкретным письмам (letter_index) и объяснены (why).
- Не выдумывай колонки: operator.column строго из списка колонок базы.
- Отвечай строго на русском, ТОЛЬКО JSON.`;

export interface TemplatePlanPromptInput {
  verticalName: string;
  verticalSummary: string;
  /** Исходная цепочка вертикали (уже с wait_days). */
  chainLetters: HeChainLetter[];
  baseAnalysis: HeBaseAnalysisOutput;
  columns: string[];
}

function renderChainLetters(letters: HeChainLetter[]): string {
  return letters
    .map((l, i) => `--- Письмо ${i + 1} ---\nТема: ${l.subject ?? ''}\n${l.body}`)
    .join('\n\n');
}

export function buildTemplatePlanMessages(input: TemplatePlanPromptInput): LLMMessage[] {
  const user = `ВЕРТИКАЛЬ: ${input.verticalName}
${input.verticalSummary}

ИСХОДНАЯ ЦЕПОЧКА ВЕРТИКАЛИ (базовый костяк):
${renderChainLetters(input.chainLetters)}

АНАЛИЗ ЗАГРУЖЕННОЙ БАЗЫ:
${JSON.stringify(input.baseAnalysis, null, 2)}

КОЛОНКИ БАЗЫ (только их можно использовать в operators):
${input.columns.map((c) => `- ${c}`).join('\n')}

Собери план шаблона. Верни ТОЛЬКО JSON:
{
  "fixed_block": string,
  "personalization_plan": [
    { "letter_index": number, "operators": [ { "var": string, "column": string, "fallback": string? } ] }
  ],
  "segment_additions": [
    { "letter_index": number, "addition": string, "why": string }
  ]
}`;

  return [
    { role: 'system', content: PLAN_SYSTEM },
    { role: 'user', content: user },
  ];
}

/* ─────────────────────── Шаг 2: финальные письма ─────────────────────── */

const LETTERS_SYSTEM = `Ты — senior email outreach специалист агентства Polza. Пишешь финальный шаблон цепочки по утверждённому плану 85/15. Регламент ниже — жёсткие данные по миллионам отправлений, он важнее любых других соображений.

${CHAIN_REGULATIONS}

Дополнительные правила шаблона:
- Текст fixed_block — обязательный костяк: следуй его структуре и аргументам.
- Сегментные дописки (15%) вплетай естественно, а не отдельным абзацем «кстати».
- Операторы персонализации вставляй строго в формате {{var}} — ровно те имена, что даны в плане. Не более 1–2 разных на письмо.
- Письма должны читаться как настоящая 1:1-переписка с представителем сегмента базы.`;

const LETTERS_TASK: Record<HeChainLanguage, string> = {
  ru: `Напиши финальные письма цепочки строго по плану выше. Количество писем = количеству писем в исходной цепочке.

ФОРМАТ ВЫВОДА (ОБЯЗАТЕЛЕН — иначе ответ не пройдёт парсинг):
---LETTER 1---
Тема: <тема письма 1>

<тело письма 1>

---LETTER 2---
Тема: <тема письма 2>

<тело письма 2>

...и так далее до последнего письма. Никаких пояснений до/после блоков. Маркеры «---LETTER N---» и слово «Тема:» не меняй. Пиши на русском.`,
  en: `Write the final sequence emails strictly following the plan above. The number of emails must match the source chain.

OUTPUT FORMAT (MANDATORY — otherwise the response will fail parsing):
---LETTER 1---
Subject: <subject of email 1>

<body of email 1>

---LETTER 2---
Subject: <subject of email 2>

<body of email 2>

...and so on through the last email. No explanations before/after the blocks. Keep the "---LETTER N---" markers and the word "Subject:" exactly as shown. Write in English.`,
  pl: `Napisz finalne maile sekwencji ściśle według planu powyżej. Liczba maili musi odpowiadać łańcuchowi źródłowemu.

FORMAT ODPOWIEDZI (OBOWIĄZKOWY — inaczej odpowiedź nie przejdzie parsowania):
---LETTER 1---
Temat: <temat maila 1>

<treść maila 1>

---LETTER 2---
Temat: <temat maila 2>

<treść maila 2>

...i tak dalej do ostatniego maila. Żadnych wyjaśnień przed/po blokach. Znaczników "---LETTER N---" i słowa "Temat:" nie zmieniaj. Pisz po polsku.`,
};

export interface TemplateLettersPromptInput {
  language: HeChainLanguage;
  plan: HeTemplatePlanOutput;
  verticalName: string;
  chainLetters: HeChainLetter[];
  baseAnalysis: HeBaseAnalysisOutput;
}

/** Сообщения для генерации финальных писем по плану 85/15. */
export function buildTemplateLettersMessages(input: TemplateLettersPromptInput): LLMMessage[] {
  const lang: HeChainLanguage = input.language === 'en' || input.language === 'pl' ? input.language : 'ru';

  const additions = input.plan.segment_additions
    .map((a) => `- Письмо ${a.letter_index}: ${a.addition}${a.why ? ` (зачем: ${a.why})` : ''}`)
    .join('\n');
  const operators = input.plan.personalization_plan
    .map((p) => {
      const ops = p.operators
        .map((o) => `{{${o.var}}} ← колонка «${o.column}»${o.fallback ? `, fallback: «${o.fallback}»` : ''}`)
        .join(', ');
      return `- Письмо ${p.letter_index}: ${ops}`;
    })
    .join('\n');

  const materials = `ВЕРТИКАЛЬ: ${input.verticalName}

FIXED BLOCK (~85%, обязательный костяк):
"""
${input.plan.fixed_block}
"""

СЕГМЕНТНЫЕ ДОПИСКИ (~15%, под анализ базы):
${additions || '(нет)'}

ОПЕРАТОРЫ ПЕРСОНАЛИЗАЦИИ (вставлять как есть, формат {{var}}):
${operators || '(без операторов — пиши без подстановок)'}

ИСХОДНАЯ ЦЕПОЧКА (референс структуры и тона):
${renderChainLetters(input.chainLetters)}

КРАТКО О БАЗЕ (для интонации):
заметные сегменты: ${input.baseAnalysis.notable_segments.join('; ') || '—'}
рекомендованные углы: ${input.baseAnalysis.recommended_angles.join('; ') || '—'}`;

  return [
    { role: 'system', content: LETTERS_SYSTEM },
    { role: 'user', content: materials },
    { role: 'assistant', content: 'План и регламент в контексте. Пишу финальные письма строго по плану.' },
    { role: 'user', content: LETTERS_TASK[lang] },
  ];
}
