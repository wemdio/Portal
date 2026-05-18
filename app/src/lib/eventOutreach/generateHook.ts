/**
 * LLM step: generates a personalized email hook + subject line for a company,
 * grounded in the agency profile and the signals detected for that company.
 * Only HOT/WARM leads are sent here — COLD companies have no real signal to
 * personalize around, so generating a hook for them is wasted spend.
 */

import type { AgencyConfig, EventSignal, EventTier } from './types';

const LLM_URL = 'https://router.requesty.ai/v1/chat/completions';
const MODEL = 'anthropic/claude-sonnet-4';
const CONCURRENCY = 6;

function getApiKey(): string {
  return (
    process.env.OPENROUTER_BUGOR_API_KEY ??
    process.env.OPENROUTER_BRIEF_API_KEY ??
    ''
  ).trim();
}

const SIGNAL_LABELS: Record<EventSignal, string> = {
  anniversary: 'круглая дата компании',
  seeking_event_manager: 'ищут ивент-менеджера на HH.ru',
  large_company: 'крупная компания (500+ сотрудников)',
  mid_company: 'средняя компания (100+ сотрудников)',
};

export interface HookInput {
  id: string;
  company_name: string;
  industry: string;
  activity_type: string | null;
  employees_count: number | null;
  region_code: string | null;
  company_age: number | null;
  anniversary_year: number | null;
  hh_vacancies_count: number;
  detected_signals: EventSignal[];
  tier: EventTier;
}

export interface HookResult {
  id: string;
  hook: string | null;
  subject_line: string | null;
}

function buildSystemPrompt(agency: AgencyConfig): string {
  const services = agency.agency_services.length
    ? agency.agency_services.map((s) => `- ${s}`).join('\n')
    : '- (услуги не указаны)';

  const examples = agency.hook_examples.length
    ? agency.hook_examples
        .map((ex) => `Сигнал: ${ex.signal}\nHook: ${ex.hook}`)
        .join('\n\n')
    : '(примеры не заданы)';

  const painPoints = Object.entries(agency.industry_pain_points)
    .map(([industry, pain]) => `- ${industry}: ${pain}`)
    .join('\n');

  return `Ты — копирайтер ивент-агентства, пишешь персонализированные первые абзацы (hook) для холодных B2B email-писем.

АГЕНТСТВО: ${agency.agency_name || '(название не указано)'}

УСЛУГИ:
${services}

TONE OF VOICE: ${agency.agency_tone || 'Разговорный, но профессиональный.'}

ПРИМЕРЫ HOOK-ОВ (ориентир по стилю):
${examples}

ОТРАСЛЕВЫЕ БОЛИ (использовать, когда нет конкретного сигнала):
${painPoints || '(не заданы)'}

ПРАВИЛА:
1. Начинай с наблюдения/факта про КОМПАНИЮ, а не про агентство.
2. Если есть конкретный сигнал (юбилей, вакансия ивент-менеджера) — строй hook вокруг него.
3. Если сигналов нет — используй отраслевую боль.
4. Не выдумывай факты, которых нет во входных данных.
5. Не здоровайся и не представляй агентство — это другие части письма.
6. Hook: 2-3 предложения, до 50 слов. Subject: до 7 слов.
7. Соблюдай tone of voice и стиль примеров.

ФОРМАТ ОТВЕТА — только JSON, без markdown:
{ "hook": "...", "subject_line": "..." }`;
}

function buildUserPrompt(lead: HookInput): string {
  const signalText = lead.detected_signals.length
    ? lead.detected_signals.map((s) => SIGNAL_LABELS[s]).join('; ')
    : 'нет сильных сигналов';

  const lines = [
    `Компания: ${lead.company_name}`,
    `Отрасль: ${lead.industry}`,
    lead.activity_type ? `Вид деятельности: ${lead.activity_type}` : null,
    lead.employees_count ? `Сотрудников: ${lead.employees_count}` : null,
    lead.company_age !== null ? `Возраст компании: ${lead.company_age} лет` : null,
    lead.anniversary_year ? `Круглая дата в ${lead.anniversary_year} году` : null,
    lead.hh_vacancies_count > 0
      ? `Открытых ивент-вакансий на HH: ${lead.hh_vacancies_count}`
      : null,
    `Сигналы: ${signalText}`,
  ].filter(Boolean);

  return `Сгенерируй hook и subject_line для этой компании:\n\n${lines.join('\n')}`;
}

interface LLMResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

async function generateOne(lead: HookInput, systemPrompt: string): Promise<HookResult> {
  const apiKey = getApiKey();
  if (!apiKey) return { id: lead.id, hook: null, subject_line: null };

  try {
    const res = await fetch(LLM_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          {
            role: 'system',
            content: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
          },
          { role: 'user', content: buildUserPrompt(lead) },
        ],
        max_tokens: 512,
        temperature: 0.7,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      console.error(`[event-outreach] LLM error ${res.status} for ${lead.company_name}`);
      return { id: lead.id, hook: null, subject_line: null };
    }

    const data = (await res.json()) as LLMResponse;
    const raw = data.choices?.[0]?.message?.content?.trim() ?? '{}';
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(cleaned) as { hook?: unknown; subject_line?: unknown };

    return {
      id: lead.id,
      hook: typeof parsed.hook === 'string' ? parsed.hook.trim() : null,
      subject_line: typeof parsed.subject_line === 'string' ? parsed.subject_line.trim() : null,
    };
  } catch (err) {
    console.error(
      `[event-outreach] hook generation failed for ${lead.company_name}:`,
      err instanceof Error ? err.message : err,
    );
    return { id: lead.id, hook: null, subject_line: null };
  }
}

/** Generates hooks for a batch of leads with bounded concurrency. */
export async function generateHooks(
  leads: HookInput[],
  agency: AgencyConfig,
): Promise<HookResult[]> {
  const systemPrompt = buildSystemPrompt(agency);
  const results: HookResult[] = [];

  for (let i = 0; i < leads.length; i += CONCURRENCY) {
    const batch = leads.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(batch.map((l) => generateOne(l, systemPrompt)));
    for (let j = 0; j < settled.length; j++) {
      const r = settled[j];
      results.push(
        r.status === 'fulfilled'
          ? r.value
          : { id: batch[j].id, hook: null, subject_line: null },
      );
    }
  }

  return results;
}
