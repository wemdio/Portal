/**
 * Промпт стадии evidence, проход (b): верификация одного кандидата по
 * РЕАЛЬНО найденным источникам. Ключевая защита от галлюцинаций: цитировать
 * можно только URL из переданных блоков; quote — дословный фрагмент.
 */

import type { LLMMessage } from '../llm';
import type { HeHypothesisCandidate, HeSiteProfileOutput } from '../schemas';

const SYSTEM = `Ты — lead-аналитик доказательного ресёрча агентства Polza. Тебе дана гипотеза рынка (кандидат из «генетической памяти», ещё НЕ подтверждённая) и материалы, РЕАЛЬНО найденные поиском по её запросам. Твоя работа — верифицировать гипотезу фактами: подтвердить, слить с дубликатом или честно отбросить.

ЖЕЛЕЗНЫЕ ПРАВИЛА ДОКАЗАТЕЛЬСТВ (нарушение = брак, ответ уйдёт в переделку):
1. source_url — ТОЛЬКО URL из блоков «ТЕКСТЫ ИСТОЧНИКОВ» и «РЕЗУЛЬТАТЫ ПОИСКА» ниже. Любой другой URL — галлюцинация и запрещён, даже если ты «знаешь» такой сайт.
2. quote — ДОСЛОВНЫЙ фрагмент текста найденного источника (допустимо сокращение многоточием), до 400 символов. Перефразировать запрещено.
3. claim — что именно доказывает цитата: объём рынка, наличие спроса, кейс, регуляторный факт, вакансия-индикатор. Одна фраза.
4. Если материалы слабые или не по теме — честно понизь potential_pct или вынеси "drop". Лучше drop, чем натянутое доказательство.
5. verdict:
   - "keep"   — есть 1–3 твёрдых доказательства ИЛИ гипотеза остаётся правдоподобной (тогда % режь);
   - "merge"  — по материалам видно, что это частный случай/синоним другой гипотезы из списка ниже — укажи её title в merge_with_title;
   - "drop"   — доказательств нет и правдоподобия нет.
6. potential_pct — перекалиброванный ПО ФАКТАМ процент потенциала (0–100): твёрдо подтверждённые гипотезы поднимай, голословные — режь.
7. evidence — 0–4 лучших доказательства. Для "drop" возвращай пустой массив. Для "merge" — доказательства, которые перейдут к целевой гипотезе.

Отвечай строго на русском, ТОЛЬКО JSON.`;

export interface EvidencePromptInput {
  candidate: HeHypothesisCandidate;
  profile: HeSiteProfileOutput;
  /** Точные title всех кандидатов — для merge_with_title. */
  allCandidateTitles: string[];
  /** Скачанные тексты найденных страниц (уже обрезанные). */
  sources: Array<{ url: string; text: string }>;
  /** Сырая выдача поиска (title/link/snippet). */
  searchResults: Array<{ title: string; link: string; snippet?: string }>;
}

export function buildEvidenceMessages(input: EvidencePromptInput): LLMMessage[] {
  const sourcesBlock = input.sources.length
    ? input.sources.map((s) => `--- Источник: ${s.url} ---\n${s.text}`).join('\n\n')
    : '(тексты источников скачать не удалось — опирайся только на сниппеты)';

  const searchBlock = input.searchResults.length
    ? input.searchResults.map((r) => `- ${r.title} — ${r.link}${r.snippet ? `\n  ${r.snippet}` : ''}`).join('\n')
    : '(поиск ничего не вернул — вероятный verdict: drop или сильное понижение %)';

  const user = `КЛИЕНТ (контекст продукта):
${input.profile.company_name}: ${input.profile.product_summary}

ГИПОТЕЗА-КАНДИДАТ НА ВЕРИФИКАЦИЮ:
${JSON.stringify(input.candidate, null, 2)}

ДРУГИЕ КАНДИДАТЫ (для verdict=merge — merge_with_title строго из этого списка):
${input.allCandidateTitles.filter((t) => t !== input.candidate.title).map((t) => `- ${t}`).join('\n') || '(нет)'}

ТЕКСТЫ ИСТОЧНИКОВ (скачаны поиском — цитировать только их и сниппеты):
${sourcesBlock}

РЕЗУЛЬТАТЫ ПОИСКА (title/link/snippet — тоже легальные источники цитат по snippet):
${searchBlock}

Верни ТОЛЬКО JSON:
{
  "verdict": "keep"|"merge"|"drop",
  "merge_with_title": string | null,
  "reason": string,
  "evidence": [ { "claim": string, "source_url": string, "quote": string } ],
  "potential_pct": number
}`;

  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: user },
  ];
}
