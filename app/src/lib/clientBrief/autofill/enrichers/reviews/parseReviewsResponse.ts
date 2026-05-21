/**
 * Парсер JSON-ответа от reviews enricher'а.
 *
 * Заполняет social_proof.ratings и social_proof.recommendations.
 * Жёсткий фильтр отписок: для ratings — без цифр считаем мусором,
 * для recommendations — без имени/должности (двоеточие в формате) считаем
 * общими словами.
 */

import type { ClientBriefFields } from '../../../types';
import { detectStub } from '../../stubFilters';

export interface ReviewsEnricherPatch {
  ratings_comment?: string;
  recommendations_comment?: string;
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
  if (ratings && !detectStub(ratings, 'ratings').isStub) {
    out.ratings_comment = ratings;
  }

  const recs = normalizeText(parsed.recommendations_comment);
  if (recs && !detectStub(recs, 'recommendations').isStub) {
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
