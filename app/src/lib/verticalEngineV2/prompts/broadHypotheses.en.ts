/**
 * EN-вариант промпта отдельной генерации широких гипотез (рынок us). Зеркалит
 * prompts/broadHypotheses.ts; правила — те же константы EN-промпта гипотез.
 */

import type { LLMMessage } from '../llm';
import {
  BROAD_HYPOTHESES_RULES_EN,
  BROAD_HYPOTHESIS_JSON_ITEM_EN,
  FIT_ECONOMICS_CORE_EN,
  HYPOTHESIS_FIELD_RULES_EN,
  buildHypothesesClientContextEn,
} from './hypotheses.en';
import type { BroadHypothesesPromptInput } from './broadHypotheses';

const SYSTEM = `You are the head of research at Polza, a performance outbound agency — a partner-level strategist. The client's project has already been researched: it has a main list of hypotheses — markets and segments that need the client's product — and bases are already being collected for them. Right now you produce ONLY the separate block of sector-level broad hypotheses. Search and evidence are not used at this step.

${FIT_ECONOMICS_CORE_EN}

FIELD RULES (the same as for the main list):
${HYPOTHESIS_FIELD_RULES_EN}
- No "facts" and no URLs: at this step you cite NO sources at all.
- Respond strictly in English, JSON ONLY.

${BROAD_HYPOTHESES_RULES_EN}
- The main list and the broad hypotheses already added are listed in the message below. Do not repeat their titles and do not propose a sector that is already among the broad ones under another name.
- How many broad hypotheses are needed now is stated in the task: that number overrides "3–5" from the block rules.`;

function listOrEmpty(lines: string[]): string {
  return lines.length ? lines.join('\n') : '(empty)';
}

export function buildBroadHypothesesMessagesEn(input: BroadHypothesesPromptInput): LLMMessage[] {
  const user = `${buildHypothesesClientContextEn(input)}

MAIN LIST — ALREADY IN THE PROJECT (vertical: its hypotheses):
${listOrEmpty(input.verticals.map((v) => `- ${v.name}${v.hypotheses.length ? `: ${v.hypotheses.join('; ')}` : ''}`))}

BROAD — ALREADY IN THE PROJECT:
${listOrEmpty(input.existingBroad.map((title) => `- ${title}`))}

TASK: produce up to ${input.count} NEW sector-level broad hypotheses following the system prompt rules. Narrow hypotheses are not needed. If there are fewer fitting new sectors, return fewer; if there are none, return an empty array.

FORMAT — JSON ONLY:
{
  "broad_hypotheses": [
${BROAD_HYPOTHESIS_JSON_ITEM_EN}
  ]
}

LENGTH DISCIPLINE (critical): the per-field limits above are hard — write densely and to the point. The answer must be one fully closed valid JSON.

Check yourself before answering: no more than ${input.count} broad hypotheses, each a whole sector without selection conditions? No title repeats the main list or the broad hypotheses already added? No sector duplicates an already added broad one under another name? Does every fit_rationale contain decision-maker → goal → pain → offer → why the economics work? Not a single URL?`;

  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: user },
  ];
}
