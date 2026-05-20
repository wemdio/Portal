/**
 * Парсер JSON-ответа от reviews enricher'а.
 *
 * Заполняет social_proof.ratings и social_proof.recommendations.
 * Жёсткий фильтр отписок: для ratings — без цифр считаем мусором,
 * для recommendations — без имени/должности (двоеточие в формате) считаем
 * общими словами.
 */

import type { ClientBriefFields } from '../../../types';

export interface ReviewsEnricherPatch {
  ratings_comment?: string;
  recommendations_comment?: string;
}

const RATINGS_STUB_PATTERNS: RegExp[] = [
  /^положительные\s+отзыв/i,
  /^много\s+(положительных|хороших)\s+отзыв/i,
  /^высокие\s+оценки/i,
  /^хорошие\s+отзыв/i,
  /отзывы\s+есть\s+(на\s+сайте|в\s+разделе)/i,
];

const RECS_STUB_PATTERNS: RegExp[] = [
  /^много\s+положительных/i,
  /^клиенты\s+довольны/i,
  /^благодарность/i, // одиночное слово без цитаты
  /отзыв\s+оставил/i,
];

/** Рейтинг должен содержать хотя бы одно число с дробью/процентом/из. */
function ratingsHaveNumbers(text: string): boolean {
  return /\d[.,]\d|\d+\/\d+|\d+%/.test(text);
}

/** Рекомендация должна содержать двоеточие (отделяющее автора от цитаты) или кавычки. */
function recommendationsHaveQuotes(text: string): boolean {
  return /[«»"„""]/.test(text) || /:\s*[«"]/.test(text) || /:\s*[А-ЯA-Z]/.test(text);
}

function normalizeText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/^\s+|\s+$/g, '');
}

function isStubAnswer(text: string, stubPatterns: RegExp[]): boolean {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return true;
  return lines.some((line) => stubPatterns.some((re) => re.test(line)));
}

function tryParseJson(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    try {
      const parsed = JSON.parse(fenceMatch[1].trim()) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // continue
    }
  }

  const braceMatch = trimmed.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try {
      const parsed = JSON.parse(braceMatch[0]) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // give up
    }
  }
  return null;
}

export function parseReviewsResponse(raw: unknown): ReviewsEnricherPatch {
  const parsed = tryParseJson(raw);
  if (!parsed) return {};

  const out: ReviewsEnricherPatch = {};

  const ratings = normalizeText(parsed.ratings_comment);
  if (ratings && ratingsHaveNumbers(ratings) && !isStubAnswer(ratings, RATINGS_STUB_PATTERNS)) {
    out.ratings_comment = ratings;
  }

  const recs = normalizeText(parsed.recommendations_comment);
  if (
    recs &&
    recommendationsHaveQuotes(recs) &&
    !isStubAnswer(recs, RECS_STUB_PATTERNS)
  ) {
    out.recommendations_comment = recs;
  }

  return out;
}

/** Превращает patch в Partial<ClientBriefFields>, заполняя social_proof.ratings/recommendations. */
export function reviewsPatchToBriefPatch(patch: ReviewsEnricherPatch): Partial<ClientBriefFields> {
  const sp: Partial<{
    ratings: { has: boolean; comment: string };
    recommendations: { has: boolean; comment: string };
  }> = {};
  if (patch.ratings_comment) {
    sp.ratings = { has: true, comment: patch.ratings_comment };
  }
  if (patch.recommendations_comment) {
    sp.recommendations = { has: true, comment: patch.recommendations_comment };
  }
  if (Object.keys(sp).length === 0) return {};
  return {
    social_proof: sp as ClientBriefFields['social_proof'],
  };
}
