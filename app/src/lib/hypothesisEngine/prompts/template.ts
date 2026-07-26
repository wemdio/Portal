/**
 * Промпты стадии template — финальный шаблон по архитектуре 85/15:
 *  - buildTemplatePlanMessages: план (fixed_block ~85% + personalization_plan
 *    + letters[].segment_variants ~15%) — structured output через HeTemplatePlanSchema;
 *  - buildTemplateLettersMessages: генерация финальных писем по плану —
 *    свободный текст с маркерами ---LETTER N--- и ---SEGMENT: <when>---
 *    (парсинг letterParser + extractSegmentVariants в stages/template).
 *
 * 15% — это УСЛОВНЫЕ СЕГМЕНТНЫЕ ВАРИАНТЫ под КОНКРЕТНУЮ загруженную базу
 * (углы/примеры/специфика сегментов из base_analyze), НЕ per-lead
 * персонализация: per-lead остаётся downstream-шагу stepPersonalize. Здесь
 * per-lead присутствует только как операторы {{var}}, замапленные на колонки
 * базы. Варианты хранятся ОТДЕЛЬНО от основного текста: основной текст письма
 * — дефолт для всей базы, вариант идёт только лидам сегмента.
 */

import type { LLMMessage } from '../llm';
import type { HeBaseAnalysisOutput, HeTemplatePlanOutput } from '../schemas';
import type { HeChainLanguage, HeChainLetter } from '../types';
import { CHAIN_REGULATIONS } from './chain';

/* ─────────────────────── Шаг 1: план 85/15 ─────────────────────── */

const PLAN_SYSTEM = `Ты — creative director агентства Polza. Собираешь план финального шаблона цепочки по архитектуре 85/15:

- ~85% — FIXED BLOCK: фиксированный смысловой костяк цепочки под гипотезу/вертикаль. Одинаков для всех лидов: боли сегмента, оффер клиента, доказательства, структура писем. Пиши его как готовое ТЗ копирайтеру: по каждому письму — цель, ключевая мысль, аргументы, какое доказательство использовать.
- ~15% — SEGMENT VARIANTS: условные варианты писем под сегменты КОНКРЕТНОЙ загруженной базы (letters[].segment_variants). Углы, примеры, формулировки из анализа базы: доминирующие гео/индустрии/роли, замеченные сегменты. Это НЕ per-lead персонализация — это адаптация под то, что реально видно в строках базы.
- personalization_plan — операторы {{var}} ТОЛЬКО под реальные колонки базы (список ниже). Обычно это имя/компания/сайт/должность. Не более 1–2 операторов на письмо (см. регламент). Для каждого: var (имя оператора без скобок, camelCase), column (точное имя колонки из списка), fallback (что подставить, если ячейка пустая — опционально).

${CHAIN_REGULATIONS}

Правила:
- Регламент выше НЕПРЕОДОЛИМ. fixed_block обязан специфицировать КАЖДОЕ письмо строго в его рамках: тело < 50 слов, первое письмо ≤ 45 слов. Запрещено прописывать в fixed_block иные лимиты длины или ослаблять любой пункт регламента — при конфликте регламент важнее.
- fixed_block опирается на готовую цепочку вертикали (ниже) — сохраняй её сильные ходы, усиливай слабые.
- Сегментные варианты НЕ входят в основной текст письма: основной текст пишется для всей базы (дефолт), вариант — отдельный текст только для лидов сегмента. Не склеивай два сегмента в одном тексте.
- Для каждого варианта: when — человекочитаемое условие сегмента, обязательно отсылающее к сегменту, названному в анализе базы (notable_segments или значения распределений, напр. «компании вне Москвы/СПб»); text — что именно написать в этом письме для сегмента.
- Не выдумывай колонки: operator.column строго из списка колонок базы.
- fallback оператора — всегда в ИМЕНИТЕЛЬНОМ падеже («ваша компания», а не «вашей компании»): подстановка может оказаться в любой позиции предложения, склонение по месту невозможно.
- В теме письма используй только операторы, у которых есть реальная колонка базы: fallback в теме невозможен.
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
  "letters": [
    { "letter_index": number, "segment_variants": [ { "when": string, "text": string } ] }
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
- Текст fixed_block — обязательный костяк: следуй его структуре и аргументам. Если fixed_block вдруг противоречит регламенту (например, разрешает тело длиннее 50 слов) — регламент важнее: тело < 50 слов, первое письмо ≤ 45 слов.
- Сегментные варианты (15%) НЕ вплетай в основной текст: основной текст письма — дефолт для всей базы и не содержит сегментной конкретики. Для каждого варианта из плана напиши ОТДЕЛЬНЫЙ блок «---SEGMENT: <when>---» сразу после соответствующего письма — полный вариант тела этого письма для сегмента (тема общая, тоже < 50 слов).
- Операторы персонализации вставляй строго в формате {{var}} — ровно те имена, что даны в плане. Не более 1–2 разных на письмо.
- Fallback операторов — в именительном падеже («ваша компания»): подстановка может оказаться в любой позиции предложения. В тему ставь только операторы с реальной колонкой базы — fallback в теме невозможен.
- Хотя бы одно письмо цепочки обязано содержать один конкретный доказательный элемент из предоставленных материалов (fixed_block / исходная цепочка): названный клиент ИЛИ конкретный числовой факт — только если он реально есть в материалах. Выдумывать имена клиентов и цифры запрещено (см. регламент); если подходящего кейса нет — пиши безымянно.
- Письма должны читаться как настоящая 1:1-переписка с представителем сегмента базы.`;

const LETTERS_TASK: Record<HeChainLanguage, string> = {
  ru: `Напиши финальные письма цепочки строго по плану выше. Количество писем = количеству писем в исходной цепочке.

ФОРМАТ ВЫВОДА (ОБЯЗАТЕЛЕН — иначе ответ не пройдёт парсинг):
---LETTER 1---
Тема: <тема письма 1>

<тело письма 1>

---SEGMENT: <условие сегмента из плана, дословно, напр. «компании вне Москвы/СПб»>---

<полный вариант тела письма 1 для этого сегмента>

---LETTER 2---
Тема: <тема письма 2>

<тело письма 2>

...и так далее до последнего письма. Блок «---SEGMENT: ...---» добавляй ТОЛЬКО если для этого письма есть сегментный вариант в плане, сразу после соответствующего письма (вариантов может быть несколько — по блоку на каждый). Никаких пояснений до/после блоков. Маркеры «---LETTER N---», «---SEGMENT: ...---» и слово «Тема:» не меняй. Пиши на русском.`,
  en: `Write the final sequence emails strictly following the plan above. The number of emails must match the source chain.

OUTPUT FORMAT (MANDATORY — otherwise the response will fail parsing):
---LETTER 1---
Subject: <subject of email 1>

<body of email 1>

---SEGMENT: <segment condition from the plan, verbatim>---

<full body variant of email 1 for this segment>

---LETTER 2---
Subject: <subject of email 2>

<body of email 2>

...and so on through the last email. Add a "---SEGMENT: ...---" block ONLY if the plan has a segment variant for that email, right after the corresponding email (one block per variant). No explanations before/after the blocks. Keep the "---LETTER N---", "---SEGMENT: ...---" markers and the word "Subject:" exactly as shown. Write in English.`,
  pl: `Napisz finalne maile sekwencji ściśle według planu powyżej. Liczba maili musi odpowiadać łańcuchowi źródłowemu.

FORMAT ODPOWIEDZI (OBOWIĄZKOWY — inaczej odpowiedź nie przejdzie parsowania):
---LETTER 1---
Temat: <temat maila 1>

<treść maila 1>

---SEGMENT: <warunek segmentu z planu, dosłownie>---

<pełny wariant treści maila 1 dla tego segmentu>

---LETTER 2---
Temat: <temat maila 2>

<treść maila 2>

...i tak dalej do ostatniego maila. Blok „---SEGMENT: ...---” dodawaj TYLKO jeśli plan przewiduje wariant segmentowy dla tego maila, zaraz po odpowiednim mailu (jeden blok na wariant). Żadnych wyjaśnień przed/po blokach. Znaczników „---LETTER N---”, „---SEGMENT: ...---” i słowa "Temat:" nie zmieniaj. Pisz po polsku.`,
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

  const variants = (input.plan.letters ?? [])
    .flatMap((l) =>
      l.segment_variants.map((v) => `- Письмо ${l.letter_index}, сегмент «${v.when}»: ${v.text}`),
    )
    .join('\n');
  const legacyAdditions = input.plan.segment_additions
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

СЕГМЕНТНЫЕ ВАРИАНТЫ (~15%, условные — для каждого отдельный блок ---SEGMENT: <when>--- после письма; в основной текст НЕ включать):
${variants || '(нет)'}${legacyAdditions ? `\nДополнительные углы из плана (тоже только в сегментные варианты, не в основной текст):\n${legacyAdditions}` : ''}

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
