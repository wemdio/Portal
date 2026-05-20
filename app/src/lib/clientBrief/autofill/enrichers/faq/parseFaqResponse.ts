/**
 * Парсер JSON-ответа от FAQ enricher'а.
 *
 * Заполняет два текстовых поля: common_questions и client_problems.
 * Это НЕ social_proof — поэтому возвращаем напрямую в Partial<ClientBriefFields>.
 */

import type { ClientBriefFields } from '../../../types';

export interface FaqEnricherPatch {
  common_questions?: string;
  client_problems?: string;
}

const QUESTIONS_STUB_PATTERNS: RegExp[] = [
  /^на\s+сайте\s+есть\s+faq/i,
  /^есть\s+faq/i,
  /^отвечаем\s+на/i,
  /faq\s+есть\s+на\s+сайте/i,
];

const PROBLEMS_STUB_PATTERNS: RegExp[] = [
  /^разные\s+проблемы/i,
  /^сложности\s+с\s+лидогенерац/i,
  /^общие\s+проблемы/i,
];

/** common_questions должны выглядеть как Q/A или с двоеточием/тире. */
function looksLikeQuestionsAnswers(text: string): boolean {
  // "В:" / "Q:" формат
  if (/\bВ:\s*\S/u.test(text) || /\bQ:\s*\S/u.test(text)) return true;
  // Или просто несколько строк с "?"
  const questionLines = text.split('\n').filter((line) => /\?/.test(line));
  return questionLines.length >= 2;
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

function isStubAnswer(text: string, patterns: RegExp[]): boolean {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return true;
  return lines.some((line) => patterns.some((re) => re.test(line)));
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
  if (
    questions &&
    looksLikeQuestionsAnswers(questions) &&
    !isStubAnswer(questions, QUESTIONS_STUB_PATTERNS)
  ) {
    out.common_questions = questions;
  }

  const problems = normalizeText(parsed.client_problems);
  // Проблемы — достаточно чтобы было хотя бы 2 строки и >40 символов
  // (короткая отписка не пройдёт).
  const problemLines = problems.split('\n').filter((l) => l.trim().length > 0);
  if (
    problems &&
    !isStubAnswer(problems, PROBLEMS_STUB_PATTERNS) &&
    (problemLines.length >= 2 || problems.length >= 40)
  ) {
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
