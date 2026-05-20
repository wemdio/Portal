/**
 * Парсер JSON-ответа от press enricher'а.
 *
 * Заполняет три социальных доказательства: press, awards, media.
 * Каждое требует «конкретики» — года/даты/имени СМИ/названия награды.
 */

import type { ClientBriefFields } from '../../../types';

export interface PressEnricherPatch {
  press_comment?: string;
  awards_comment?: string;
  media_comment?: string;
}

const PRESS_STUB_PATTERNS: RegExp[] = [
  /^упоминания\s+в\s+сми\s+есть/i,
  /^пишут\s+о\s+нас/i,
  /^есть\s+упоминания/i,
  /сми\s+о\s+нас\s+есть/i,
];

const AWARDS_STUB_PATTERNS: RegExp[] = [
  /^(множество|много)\s+наград/i,
  /^есть\s+награды/i,
  /^аккредитован/i,
  /награды\s+и\s+сертификаты\s+есть/i,
];

const MEDIA_STUB_PATTERNS: RegExp[] = [
  /^есть\s+видео/i,
  /^выступаем\s+на\s+конференц/i,
  /^наш\s+youtube/i,
  /видео\s+есть\s+на/i,
];

/** Любая дата/год: 2024, март 2024, 12.03.2024, январь 2025. */
function hasDateOrYear(text: string): boolean {
  return /\b(19|20)\d{2}\b/.test(text) || /(январ|феврал|март|апрел|май|июн|июл|август|сентябр|октябр|ноябр|декабр)/i.test(text);
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

export function parsePressResponse(raw: unknown): PressEnricherPatch {
  const parsed = tryParseJson(raw);
  if (!parsed) return {};

  const out: PressEnricherPatch = {};

  const press = normalizeText(parsed.press_comment);
  if (press && hasDateOrYear(press) && !isStubAnswer(press, PRESS_STUB_PATTERNS)) {
    out.press_comment = press;
  }

  const awards = normalizeText(parsed.awards_comment);
  // Для наград допустим и без года (некоторые сертификаты бессрочные), но
  // должна быть конкретика — хотя бы тире или двоеточие в формате.
  if (
    awards &&
    !isStubAnswer(awards, AWARDS_STUB_PATTERNS) &&
    (hasDateOrYear(awards) || /[—–:]/.test(awards))
  ) {
    out.awards_comment = awards;
  }

  const media = normalizeText(parsed.media_comment);
  if (media && !isStubAnswer(media, MEDIA_STUB_PATTERNS) && /[—–:(]/.test(media)) {
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
