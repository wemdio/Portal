/**
 * Парсер JSON-ответа от press enricher'а.
 *
 * Заполняет три социальных доказательства: press, awards, media.
 * Каждое требует «конкретики» — года/даты/имени СМИ/названия награды.
 */

import type { ClientBriefFields } from '../../../types';
import { detectStub } from '../../stubFilters';

export interface PressEnricherPatch {
  press_comment?: string;
  awards_comment?: string;
  media_comment?: string;
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

export function parsePressResponse(raw: unknown): PressEnricherPatch {
  const parsed = tryParseJson(raw);
  if (!parsed) return {};

  const out: PressEnricherPatch = {};

  const press = normalizeText(parsed.press_comment);
  if (press && !detectStub(press, 'press').isStub) {
    out.press_comment = press;
  }

  const awards = normalizeText(parsed.awards_comment);
  if (awards && !detectStub(awards, 'awards').isStub) {
    out.awards_comment = awards;
  }

  const media = normalizeText(parsed.media_comment);
  if (media && !detectStub(media, 'media').isStub) {
    out.media_comment = media;
  }

  return out;
}

export function pressPatchToBriefPatch(patch: PressEnricherPatch): Partial<ClientBriefFields> {
  const sp: Partial<{
    press: { has: boolean; comment: string };
    awards: { has: boolean; comment: string };
    media: { has: boolean; comment: string };
  }> = {};
  if (patch.press_comment) sp.press = { has: true, comment: patch.press_comment };
  if (patch.awards_comment) sp.awards = { has: true, comment: patch.awards_comment };
  if (patch.media_comment) sp.media = { has: true, comment: patch.media_comment };
  if (Object.keys(sp).length === 0) return {};
  return { social_proof: sp as ClientBriefFields['social_proof'] };
}
