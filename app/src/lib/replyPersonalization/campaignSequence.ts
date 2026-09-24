// Письма цепочки кампании — то, что мы уже отправили или отправим адресату.
//
// Без них ИИ знал о предложении только бриф проекта и собирал ответ «с нуля»:
// другими словами, чем в цепочке, и с другой подписью. Специалист же отвечает
// от цепочки: на отказ — коротко пересказывает суть второго письма, новому
// контакту — шлёт второе письмо с небольшими правками. Поэтому цепочка идёт в
// промпт как источник предложения, аргументов и подписи.
//
// Запрос GET /campaigns/:id — не /emails, общий бюджет писем он не трогает.
// Цепочка меняется редко, поэтому держим её в памяти полчаса.

import { getCampaign } from '@/lib/instantly/client';
import type { SequenceStep } from '@/lib/instantly/types';

export interface CampaignStepText {
  step: number;
  subject: string;
  body: string;
}

const CACHE_TTL_MS = 30 * 60 * 1000;
/** Письмо цепочки длиннее не бывает; обрезаем мусорные вставки, не текст. */
const MAX_BODY_LENGTH = 4000;

const CACHE = new Map<string, { steps: CampaignStepText[]; expiresAt: number }>();

export function htmlToText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|li|h[1-6])\s*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Первый вариант шага, в котором есть текст (A/B-варианты — одна мысль разными словами). */
function stepText(step: SequenceStep): { subject: string; body: string } {
  const candidates = [...(step.variants ?? []), { subject: step.subject, body: step.body }];
  const found = candidates.find((v) => (v.body ?? '').trim()) ?? { subject: '', body: '' };
  return {
    subject: (found.subject ?? '').trim(),
    body: htmlToText(found.body ?? '').slice(0, MAX_BODY_LENGTH),
  };
}

/**
 * Письма основной цепочки кампании по порядку. Пустой список — цепочку
 * получить не удалось: генерация идёт как раньше, по брифу и переписке.
 */
export async function fetchCampaignSteps(campaignId: string, accountId: string): Promise<CampaignStepText[]> {
  const key = `${accountId}:${campaignId}`;
  const cached = CACHE.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.steps;

  try {
    const campaign = await getCampaign(campaignId, {
      accountId,
      timeoutMs: 15_000,
      requestPriority: 'interactive',
      consumer: 'personalization_sequence',
    });
    const steps = (campaign.sequences?.[0]?.steps ?? [])
      .map((step, index) => ({ step: index + 1, ...stepText(step) }))
      .filter((s) => s.body);
    CACHE.set(key, { steps, expiresAt: Date.now() + CACHE_TTL_MS });
    return steps;
  } catch {
    return [];
  }
}
