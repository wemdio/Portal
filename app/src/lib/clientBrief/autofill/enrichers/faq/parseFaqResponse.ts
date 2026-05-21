/**
 * Парсер JSON-ответа от FAQ enricher'а.
 *
 * Заполняет два текстовых поля: common_questions и client_problems.
 * Это НЕ social_proof — поэтому возвращаем напрямую в Partial<ClientBriefFields>.
 */

import type { ClientBriefFields } from '../../../types';
import { detectStub } from '../../stubFilters';

export interface FaqEnricherPatch {
  common_questions?: string;
  client_problems?: string;
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

export function parseFaqResponse(raw: unknown): FaqEnricherPatch {
  const parsed = tryParseJson(raw);
  if (!parsed) return {};

  const out: FaqEnricherPatch = {};

  const questions = normalizeText(parsed.common_questions);
  if (questions && !detectStub(questions, 'common_questions').isStub) {
    out.common_questions = questions;
  }

  const problems = normalizeText(parsed.client_problems);
  if (problems && !detectStub(problems, 'client_problems').isStub) {
    out.client_problems = problems;
  }

  return out;
}

export function faqPatchToBriefPatch(patch: FaqEnricherPatch): Partial<ClientBriefFields> {
  const briefPatch: Partial<ClientBriefFields> = {};
  if (patch.common_questions) briefPatch.common_questions = patch.common_questions;
  if (patch.client_problems) briefPatch.client_problems = patch.client_problems;
  return briefPatch;
}
