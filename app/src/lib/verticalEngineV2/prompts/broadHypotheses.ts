/**
 * Промпт отдельной генерации широких гипотез для уже исследованного проекта
 * (стадия broad_hypotheses). Правила широких, полей и экономики фита — те же
 * константы, что в полном проходе (prompts/hypotheses.ts), контекст клиента —
 * тот же блок. Основной список модели показываем, чтобы она его не повторяла.
 */

import type { LLMMessage } from '../llm';
import {
  BROAD_HYPOTHESES_RULES,
  BROAD_HYPOTHESIS_JSON_ITEM,
  FIT_ECONOMICS_CORE,
  HYPOTHESIS_FIELD_RULES,
  buildHypothesesClientContext,
  type HypothesesClientContextInput,
} from './hypotheses';

export interface BroadHypothesesPromptInput extends HypothesesClientContextInput {
  /** Сколько новых широких нужно (свободные места до предела проекта). */
  count: number;
  /** Вертикали проекта с названиями их узких гипотез. */
  verticals: Array<{ name: string; hypotheses: string[] }>;
  /** Широкие, которые уже есть в проекте. */
  existingBroad: string[];
}

const SYSTEM = `Ты — глава ресёрча агентства performance-аутрича Polza, стратег уровня partner. Проект клиента уже исследован: у него есть основной список гипотез — рынков и сегментов, которым нужен продукт клиента, — и по ним уже собирают базы. Сейчас нужен ТОЛЬКО отдельный блок широких гипотез уровня сектора. Поиск и доказательства на этом шаге не используются.

${FIT_ECONOMICS_CORE}

ПРАВИЛА ПОЛЕЙ (те же, что у основного списка):
${HYPOTHESIS_FIELD_RULES}
- Никаких «фактов» и URL: на этом шаге ты НЕ цитируешь источники вообще.
- Отвечай строго на русском, ТОЛЬКО JSON.

${BROAD_HYPOTHESES_RULES}
- Основной список и уже добавленные широкие перечислены в сообщении ниже. Не повторяй их названия и не предлагай сектор, который уже есть среди широких, под другим именем.
- Сколько широких нужно сейчас, сказано в задаче: это число важнее «3–5» из правил блока.`;

function listOrEmpty(lines: string[]): string {
  return lines.length ? lines.join('\n') : '(пусто)';
}

export function buildBroadHypothesesMessages(input: BroadHypothesesPromptInput): LLMMessage[] {
  const user = `${buildHypothesesClientContext(input)}

ОСНОВНОЙ СПИСОК — УЖЕ ЕСТЬ В ПРОЕКТЕ (вертикаль: её гипотезы):
${listOrEmpty(input.verticals.map((v) => `- ${v.name}${v.hypotheses.length ? `: ${v.hypotheses.join('; ')}` : ''}`))}

ШИРОКИЕ — УЖЕ ЕСТЬ В ПРОЕКТЕ:
${listOrEmpty(input.existingBroad.map((title) => `- ${title}`))}

ЗАДАЧА: выдай до ${input.count} НОВЫХ широких гипотез уровня сектора по правилам из системного промпта. Узкие гипотезы не нужны. Если подходящих новых секторов меньше — верни меньше; если их нет — верни пустой массив.

ФОРМАТ — ТОЛЬКО JSON:
{
  "broad_hypotheses": [
${BROAD_HYPOTHESIS_JSON_ITEM}
  ]
}

ДИСЦИПЛИНА ДЛИНЫ (критично): лимиты по полям выше — жёсткие, пиши плотно и по делу. Ответ обязан быть одним полностью закрытым валидным JSON.

Проверь себя перед ответом: широких не больше ${input.count}, каждая — сектор целиком без условий отбора? Ни одно название не повторяет основной список и уже добавленные широкие? Ни один сектор не дублирует уже добавленную широкую под другим именем? У каждой fit_rationale содержит ЛПР → цель → боль → оффер → почему экономика сойдётся? Ни одного URL?`;

  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: user },
  ];
}
