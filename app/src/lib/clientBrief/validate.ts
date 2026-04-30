import { CLIENT_BRIEF_MAX_TOTAL_CHARS, SOCIAL_PROOF_KEYS } from './constants';
import type { ClientBriefFields } from './types';

export type ValidateBriefResult = { ok: true } | { ok: false; error: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Голый домен (redev.ru, foo.bar.baz) или http(s)://...
const WEBSITE_RE = /^(https?:\/\/[^\s]+|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(\/[^\s]*)?)$/i;

function totalCharCount(fields: ClientBriefFields): number {
  let total = 0;
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'social_proof' || key === 'price_tier') continue;
    if (typeof value === 'string') total += value.length;
  }
  for (const key of SOCIAL_PROOF_KEYS) {
    total += fields.social_proof[key].comment.length;
  }
  return total;
}

/**
 * Валидирует пользовательский ввод. Пустой бриф валиден (черновик OK).
 * Нормализуй ПЕРЕД вызовом этой функции.
 */
export function validateBriefInput(fields: ClientBriefFields): ValidateBriefResult {
  if (fields.lead_recipient_email && !EMAIL_RE.test(fields.lead_recipient_email)) {
    return { ok: false, error: 'Email получателя лидов невалидный.' };
  }

  if (fields.company_website && !WEBSITE_RE.test(fields.company_website)) {
    return { ok: false, error: 'Сайт должен быть валидным URL или доменом (например, redev.ru).' };
  }

  const total = totalCharCount(fields);
  if (total > CLIENT_BRIEF_MAX_TOTAL_CHARS) {
    return {
      ok: false,
      error: `Размер брифа слишком большой (${total.toLocaleString('ru-RU')} символов). Лимит ${CLIENT_BRIEF_MAX_TOTAL_CHARS.toLocaleString('ru-RU')}.`,
    };
  }

  return { ok: true };
}
