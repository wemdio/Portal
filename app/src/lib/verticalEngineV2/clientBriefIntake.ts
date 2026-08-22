/**
 * Бриф клиента как второй вход движка (рядом с сайтом).
 *
 * Клиенты присылают заполненный шаблон агентства (PDF/DOCX/TXT) — те же поля,
 * что описаны в lib/clientBrief (ClientBriefFields). Текст файла достаёт общий
 * extractTextFromBriefFile, раскладывает по полям один LLM-вызов на моделях v2,
 * а нормализацию и белый список полей делает общий normalizeBriefFields.
 *
 * Две особенности живых брифов, из-за которых нельзя просто «сохранить, что
 * ответила модель»:
 *  - строки заполняются не все, а вместо пустоты часто ставят заглушку («-»,
 *    «в разработке», «под NDA»). Такое значение — отсутствие данных: оно
 *    вычищается в '' и попадает в missing, иначе research строит гипотезы на
 *    «в разработке»;
 *  - в конце шаблона идёт инструкция про social proof с примерами ссылок
 *    (youtu.be, kommersant.ru). Это текст формы, а не ответы клиента, поэтому
 *    хвост режется ДО LLM-вызова.
 *
 * Сайт проекта остаётся авторитетным адресом: строка «ссылка на сайт» из брифа
 * живёт только внутри fields.company_website (у реальных клиентов там бывает
 * проза вида «в разработке»).
 */

import { z } from 'zod';

import {
  EMPTY_BRIEF_FIELDS,
  SOCIAL_PROOF_KEYS,
  compileBriefText,
  normalizeBriefFields,
} from '@/lib/clientBrief';
import type { ClientBriefFields, ClientBriefSocialProofKey } from '@/lib/clientBrief';

import { callLLMWithSchema, getVeModel } from './llm';

/** Бриф клиента внутри ve_projects.brief.client_brief. */
export interface VeClientBrief {
  fields: ClientBriefFields;
  /** Поля, которых у клиента нет: пустые строки и заглушки. */
  missing: VeClientBriefField[];
  file_name: string | null;
  uploaded_at: string;
}

export type VeClientBriefField = Exclude<keyof ClientBriefFields, 'social_proof'>;

/** Максимум текста брифа, уходящего в LLM: длинные брифы — 20–25k символов. */
export const BRIEF_TEXT_MAX_CHARS = 40_000;

/** Максимум скомпилированного брифа в промптах research'а. */
export const BRIEF_PROMPT_MAX_CHARS = 12_000;

const TEXT_FIELDS = Object.keys(EMPTY_BRIEF_FIELDS).filter(
  (key): key is VeClientBriefField => key !== 'social_proof',
);

/**
 * Маркеры хвоста шаблона: инструкция про social proof и подписи к примерам.
 * Режем от первого совпадения до конца — дальше в шаблоне только примеры.
 */
const TEMPLATE_TAIL_MARKERS = [
  'Инструкция по заполнению социальных доказательств',
  'Этот небольшой пример показывает, как social proof',
];

/**
 * Заглушки вместо ответа. Сравниваем ЦЕЛОЕ значение (после нормализации), чтобы
 * «нет ограничений по объёму» осталось ответом, а «нет» — нет.
 */
const PLACEHOLDER_VALUES = new Set([
  '-',
  '--',
  '—',
  '–',
  'нет',
  'не знаю',
  'n/a',
  'na',
  'none',
  'tbd',
  'нерелевантно',
  'не релевантно',
]);

/** Заглушки-предисловия: «в разработке», «под NDA» (в брифах пишут и «NBA»). */
const PLACEHOLDER_PREFIXES = [/^в\s+разработке/i, /^под\s+n[db]a/i, /^пока\s+нет/i];

const PLACEHOLDER_PREFIX_MAX_CHARS = 40;

export function isPlaceholderAnswer(value: unknown): boolean {
  if (typeof value !== 'string') return true;
  const trimmed = value.trim();
  if (!trimmed) return true;

  const normalized = trimmed.toLowerCase().replace(/[.!]+$/, '').trim();
  if (PLACEHOLDER_VALUES.has(normalized)) return true;

  return (
    normalized.length <= PLACEHOLDER_PREFIX_MAX_CHARS &&
    PLACEHOLDER_PREFIXES.some((re) => re.test(normalized))
  );
}

/** Убирает хвост шаблона брифа (инструкция + примеры). Идемпотентна. */
export function stripBriefTemplateBoilerplate(text: string): string {
  let cut = text.length;
  for (const marker of TEMPLATE_TAIL_MARKERS) {
    const at = text.indexOf(marker);
    if (at >= 0 && at < cut) cut = at;
  }
  return cut === text.length ? text : text.slice(0, cut).trimEnd();
}

/**
 * Вычищает заглушки в '' и собирает список отсутствующего.
 * social_proof в missing не попадает: там «нет» — штатное состояние галочки.
 */
function applyGapRules(fields: ClientBriefFields): {
  fields: ClientBriefFields;
  missing: VeClientBriefField[];
} {
  const cleaned: ClientBriefFields = { ...fields, social_proof: { ...fields.social_proof } };
  const missing: VeClientBriefField[] = [];

  for (const field of TEXT_FIELDS) {
    if (field === 'price_tier') {
      if (!cleaned.price_tier) missing.push(field);
      continue;
    }
    const value = cleaned[field] as string;
    if (isPlaceholderAnswer(value)) {
      (cleaned[field] as string) = '';
      missing.push(field);
    }
  }

  for (const key of SOCIAL_PROOF_KEYS as readonly ClientBriefSocialProofKey[]) {
    const item = cleaned.social_proof[key];
    if (isPlaceholderAnswer(item.comment)) {
      cleaned.social_proof[key] = { has: item.has, comment: '' };
    }
  }

  return { fields: cleaned, missing };
}

/* ─────────────────────────── LLM-разбор ─────────────────────────── */

// Схему держим широкой намеренно: белый список полей — normalizeBriefFields,
// он же приводит типы. Узкая zod-схема здесь дала бы второй, расходящийся
// список полей стандарта.
const BriefExtractionSchema = z.object({
  fields: z.record(z.string(), z.unknown()).default({}),
});

const SYSTEM = `Ты — аналитик агентства performance-аутрича Polza. Тебе дают текст брифа, который клиент заполнил по шаблону агентства. Твоя задача — разложить ответы клиента по полям стандарта, ничего не придумывая.

Жёсткие правила:
- переноси ТОЛЬКО то, что реально написал клиент; никаких обобщений и домыслов;
- вопросы и подсказки самого шаблона («Опишите 5 преимуществ…», «Например: 5 лет опыта») — это НЕ ответы клиента, их не переносить;
- строку, которую клиент оставил пустой или закрыл заглушкой («-», «в разработке», «под NDA»), возвращай пустой строкой;
- ничего не переводи и не переписывай: сохраняй формулировки клиента, только убирай номера пунктов и мусор разметки;
- многострочные ответы (списки преимуществ, сегменты ЦА) сохраняй целиком с переносами строк.

Отвечай строго на русском.`;

function buildExtractionMessages(briefText: string) {
  const user = `ТЕКСТ БРИФА КЛИЕНТА:
"""
${briefText}
"""

Разложи ответы по полям и верни ТОЛЬКО JSON строго такого вида (без markdown-фенсов и пояснений):
{
  "fields": {
    "company_website": string,        // строка «ссылка на действующий сайт» как есть
    "company_description": string,    // краткое описание деятельности/компании/товара
    "company_contacts": string,       // телефон/e-mail/telegram/whatsapp
    "deal_cycle": string,             // цикл сделки от первого касания до оплаты
    "avg_check": string,              // средний чек / продуктовая линейка с ценами
    "product_description": string,    // подробное описание товара/услуги
    "price_tier": "economy"|"middle"|"business"|"premium"|null,  // где стоит «+»
    "advantages": string,             // 5 преимуществ компании/товара
    "usp": string,                    // уникальное торговое предложение
    "competitors_problems": string,   // 5 проблем в работе с конкурентами
    "impressive_numbers": string,     // внушительные цифры
    "special_offer": string,          // акция / специальное предложение
    "target_audience": string,        // описание целевой аудитории (должности, индустрии, ЛПР, гео)
    "client_problems": string,        // с какими проблемами приходят
    "common_questions": string,       // какие вопросы задают / возражения
    "persona_name": string,           // от чьего лица ведём диалог — имя
    "persona_position": string,       // от чьего лица ведём диалог — должность
    "lead_recipient_name": string,    // кому передаём лидов — имя
    "lead_recipient_email": string,   // кому передаём лидов — email
    "lead_recipient_position": string,// кому передаём лидов — должность
    "lead_magnets": string,           // лид-магниты
    "guarantees": string,             // гарантии клиенту
    "existing_clients": string,       // действующие клиенты
    "impressive_results": string,     // результаты, которые впечатлят лида
    "additional_notes": string,       // всё остальное существенное из брифа
    "social_proof": {                 // блок SOCIAL PROOF: «+» → has=true
      "ratings": { "has": boolean, "comment": string },
      "media": { "has": boolean, "comment": string },
      "photos": { "has": boolean, "comment": string },
      "recommendations": { "has": boolean, "comment": string },
      "cases": { "has": boolean, "comment": string },
      "awards": { "has": boolean, "comment": string },
      "press": { "has": boolean, "comment": string },
      "presentations": { "has": boolean, "comment": string }
    }
  }
}

Никакого текста вне JSON.`;

  return [
    { role: 'system' as const, content: SYSTEM },
    { role: 'user' as const, content: user },
  ];
}

export interface ParseClientBriefResult {
  brief: VeClientBrief;
  tokensUsed: number;
  costUsd: number;
}

export async function parseClientBriefText(
  rawText: string,
  opts: { fileName?: string | null },
): Promise<ParseClientBriefResult> {
  const briefText = stripBriefTemplateBoilerplate(rawText).slice(0, BRIEF_TEXT_MAX_CHARS);

  const llm = await callLLMWithSchema(buildExtractionMessages(briefText), BriefExtractionSchema, {
    model: getVeModel('research'),
    maxTokens: 16384,
  });

  const normalized = normalizeBriefFields(llm.data.fields as Partial<ClientBriefFields>);
  const { fields, missing } = applyGapRules(normalized);

  return {
    brief: {
      fields,
      missing,
      file_name: opts.fileName?.trim() || null,
      uploaded_at: new Date().toISOString(),
    },
    tokensUsed: llm.tokensUsed,
    costUsd: llm.costUsd,
  };
}

/* ─────────────────────── Чтение / правка / промпты ─────────────────────── */

/** Бриф из ve_projects.brief; null — не загружен. */
export function readClientBrief(
  project: { brief?: Record<string, unknown> | null } | null | undefined,
): VeClientBrief | null {
  const raw = project?.brief?.client_brief;
  if (!raw || typeof raw !== 'object') return null;

  const stored = raw as Partial<VeClientBrief>;
  const normalized = normalizeBriefFields(stored.fields as Partial<ClientBriefFields>);
  const { fields, missing } = applyGapRules(normalized);
  return {
    fields,
    missing,
    file_name: typeof stored.file_name === 'string' ? stored.file_name : null,
    uploaded_at: typeof stored.uploaded_at === 'string' ? stored.uploaded_at : '',
  };
}

/** Ручная правка полей поверх разобранного: пробелы клиента не восстанавливаем. */
export function applyClientBriefEdit(
  current: VeClientBrief | null,
  patch: Partial<ClientBriefFields>,
): VeClientBrief {
  const merged = normalizeBriefFields({
    ...(current?.fields ?? EMPTY_BRIEF_FIELDS),
    ...patch,
    social_proof: {
      ...(current?.fields ?? EMPTY_BRIEF_FIELDS).social_proof,
      ...(patch.social_proof ?? {}),
    },
  });
  const { fields, missing } = applyGapRules(merged);

  return {
    fields,
    missing,
    file_name: current?.file_name ?? null,
    uploaded_at: current?.uploaded_at || new Date().toISOString(),
  };
}

/**
 * Бриф для промптов research'а: markdown общего compileBriefText + явный
 * перечень незаполненного, чтобы модель не выдумывала отсутствующее.
 */
export function compileClientBriefForPrompt(
  brief: VeClientBrief | null,
  maxChars: number = BRIEF_PROMPT_MAX_CHARS,
): string {
  if (!brief) return '';
  const compiled = compileBriefText(brief.fields);
  if (!compiled.trim()) return '';

  const body = compiled.length > maxChars ? `${compiled.slice(0, maxChars)}\n…(обрезано)` : compiled;
  const gaps = brief.missing.length
    ? `\n\nКлиент НЕ заполнил: ${brief.missing.join(', ')}. Не выдумывай эти данные.`
    : '';
  return `${body}${gaps}`;
}
