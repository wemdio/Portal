/**
 * Парсер JSON-ответа от cases enricher'а.
 *
 * Та же философия что в mapAutofillToBriefPatch: AI — недоверенный источник.
 * Нормализуем строки, drop'аем пустые, drop'аем мусор, никогда не бросаем.
 *
 * Дополнительно: ловим типовые «отписки» вроде "Есть раздел кейсов на сайте"
 * и считаем их за пустое значение. Идея в том, что лучше отдать главному
 * флоу шанс заполнить поле из главной (где раньше и было такое), чем дать
 * enricher'у перетереть результат бесполезным мета-описанием.
 */

import type { ClientBriefFields } from '../../../types';
import { detectStub } from '../../stubFilters';

export interface CasesEnricherPatch {
  cases_comment?: string;
  impressive_results?: string;
  existing_clients?: string;
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

/**
 * Превращает сырой ответ модели в безопасный patch на поля брифа.
 * Возвращает только те поля, которые AI реально заполнил содержательно.
 */
export function parseCasesResponse(raw: unknown): CasesEnricherPatch {
  const parsed = tryParseJson(raw);
  if (!parsed) return {};

  const out: CasesEnricherPatch = {};

  const casesComment = normalizeText(parsed.cases_comment);
  if (casesComment && !detectStub(casesComment, 'cases').isStub) {
    out.cases_comment = casesComment;
  }

  const impressive = normalizeText(parsed.impressive_results);
  // impressive_results тоже фильтруем по cases-правилам — длинный текст
  // с тире/цифрами; короткий "Раздел X" — отписка.
  if (impressive && !detectStub(impressive, 'cases').isStub) {
    out.impressive_results = impressive;
  }

  const clients = normalizeText(parsed.existing_clients);
  if (clients) {
    // Для existing_clients отписки маловероятны (это просто список имён).
    out.existing_clients = clients;
  }

  return out;
}

/** Применяет patch к ClientBriefFields-shaped объекту. Создаёт минимальный Partial. */
export function casesPatchToBriefPatch(patch: CasesEnricherPatch): Partial<ClientBriefFields> {
  const briefPatch: Partial<ClientBriefFields> = {};
  if (patch.impressive_results) briefPatch.impressive_results = patch.impressive_results;
  if (patch.existing_clients) briefPatch.existing_clients = patch.existing_clients;
  if (patch.cases_comment) {
    briefPatch.social_proof = {
      // mergePatchEmptyOnly смотрит только на присутствующие ключи — остальные
      // не тронутся. Поэтому отдаём только cases-ключ.
      cases: { has: true, comment: patch.cases_comment },
    } as ClientBriefFields['social_proof'];
  }
  return briefPatch;
}
