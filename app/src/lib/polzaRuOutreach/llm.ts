/**
 * Один вызов LLM со строгим JSON-ответом. Модель только извлекает и
 * классифицирует; каждая цитата потом сверяется с источником кодом (evidence.ts).
 *
 * Дешёвая модель, температура 0, один ретрай при битом JSON. Ключ общий с
 * английским автоаутричем.
 */

import { callOpenRouterChat } from '@/lib/openrouter/client';

const API_KEY = process.env.OPENROUTER_PERSONALIZATION_API_KEY || process.env.OPENROUTER_BRIEF_API_KEY || '';
export const RU_OUTREACH_MODEL = process.env.POLZA_RU_OUTREACH_MODEL || process.env.POLZA_OUTREACH_MODEL || 'openai/gpt-4o-mini';
const MAX_ATTEMPTS = 2;

function parseJsonObject(content: string): Record<string, unknown> | null {
  const text = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const slice = text.startsWith('{') ? text : (text.match(/\{[\s\S]*\}/)?.[0] ?? '');
  if (!slice) return null;
  try {
    const parsed = JSON.parse(slice) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function callJson(system: string, user: string, title: string, maxTokens = 1200): Promise<Record<string, unknown>> {
  if (!API_KEY) throw new Error('OPENROUTER_PERSONALIZATION_API_KEY is not configured');
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const content = await callOpenRouterChat({
        apiKey: API_KEY,
        model: RU_OUTREACH_MODEL,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0,
        maxTokens,
        responseFormat: { type: 'json_object' },
        title: `Portal - Polza RU Outreach ${title}`,
      });
      const parsed = parseJsonObject(content);
      if (parsed) return parsed;
      lastError = new Error('LLM returned unparseable JSON');
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastError ?? new Error('LLM call failed');
}

export function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function asBool(value: unknown): boolean {
  return value === true || value === 'true';
}

export function asStringArray(value: unknown, max = 20): string[] {
  return Array.isArray(value) ? value.map(asString).filter(Boolean).slice(0, max) : [];
}
