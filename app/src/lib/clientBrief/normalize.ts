import {
  ALLOWED_PRICE_TIERS,
  EMPTY_BRIEF_FIELDS,
  SOCIAL_PROOF_KEYS,
} from './constants';
import type {
  ClientBriefFields,
  ClientBriefPriceTier,
  ClientBriefSocialProof,
  ClientBriefSocialProofKey,
} from './types';

function normalizeText(value: unknown): string {
  if (typeof value !== 'string') return '';
  // \r\n -> \n, обрезаем края всего текста и трейлинг-пробелы каждой строки.
  // Внутренние ведущие пробелы НЕ трогаем — это намеренный отступ списка/блока.
  return value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/^\s+|\s+$/g, '');
}

function coerceComment(value: unknown): string {
  if (typeof value === 'string') return normalizeText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function coerceHas(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true' || value === 'yes' || value === '1';
  if (typeof value === 'number') return value !== 0;
  return false;
}

function normalizeSocialProofItem(value: unknown): ClientBriefSocialProof {
  if (!value || typeof value !== 'object') return { has: false, comment: '' };
  const item = value as Partial<ClientBriefSocialProof>;
  return {
    has: coerceHas(item.has),
    comment: coerceComment(item.comment),
  };
}

function normalizePriceTier(value: unknown): ClientBriefPriceTier | null {
  if (typeof value !== 'string') return null;
  return (ALLOWED_PRICE_TIERS as readonly string[]).includes(value)
    ? (value as ClientBriefPriceTier)
    : null;
}

const TEXT_FIELDS: Array<keyof ClientBriefFields> = [
  'company_website',
  'company_description',
  'company_contacts',
  'deal_cycle',
  'avg_check',
  'product_description',
  'advantages',
  'usp',
  'competitors_problems',
  'impressive_numbers',
  'special_offer',
  'target_audience',
  'client_problems',
  'common_questions',
  'persona_name',
  'persona_position',
  'lead_recipient_name',
  'lead_recipient_email',
  'lead_recipient_position',
  'lead_magnets',
  'guarantees',
  'existing_clients',
  'impressive_results',
  'additional_notes',
];

/**
 * Приводит произвольный (частичный, грязный) объект к чистому ClientBriefFields.
 * Идемпотентна. Никаких исключений — возвращает максимально валидную форму.
 */
export function normalizeBriefFields(input: Partial<ClientBriefFields> | null | undefined): ClientBriefFields {
  const safe = (input ?? {}) as Record<string, unknown>;

  const result: ClientBriefFields = { ...EMPTY_BRIEF_FIELDS };

  for (const field of TEXT_FIELDS) {
    (result[field] as string) = normalizeText(safe[field]);
  }

  result.price_tier = normalizePriceTier(safe.price_tier);

  const socialProofRaw = (safe.social_proof ?? {}) as Record<string, unknown>;
  const socialProof = { ...EMPTY_BRIEF_FIELDS.social_proof };
  for (const key of SOCIAL_PROOF_KEYS as readonly ClientBriefSocialProofKey[]) {
    socialProof[key] = normalizeSocialProofItem(socialProofRaw[key]);
  }
  result.social_proof = socialProof;

  return result;
}
