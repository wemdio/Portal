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

export interface CasesEnricherPatch {
  cases_comment?: string;
  impressive_results?: string;
  existing_clients?: string;
}

/** Подстроки, по которым опознаём "отписки" — это не текстовое содержимое. */
const STUB_PATTERNS: RegExp[] = [
  /^есть\s+(раздел|кейс|портфолио)/i,
  /^имеются\s+кейс/i,
  /кейсы\s+есть\s+(на\s+сайте|в\s+портфолио|в\s+разделе)/i,
  /^\d+\+?\s*(кейс|проект)/i, // "85+ проектов" без описаний
  /см\.\s*(сайт|раздел)/i,
  /подробнее\s+(на\s+сайте|в\s+разделе)/i,
  /смотрите?\s+(на\s+сайте|в\s+портфолио)/i,
];

/** Кейс должен либо содержать тире (формат «клиент — задача — результат»), либо быть длинным (>80 симв). */
function looksLikeRealContent(text: string): boolean {
  if (text.length >= 80) return true;
  // dash может быть em/en/обычный
  return /[—–-]/.test(text);
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

function isStubAnswer(text: string): boolean {
  // Если общий текст короткий и матчится один из паттернов отписки — drop.
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return true;
  // Любая строка — реально-выглядящий кейс? Тогда не отписка.
  if (lines.some(looksLikeRealContent)) return false;
  // Все строки коротки и без тире — почти наверняка отписка. Ужесточим:
  // если хотя бы одна строка матчит STUB_PATTERNS — точно отписка.
  return lines.some((line) => STUB_PATTERNS.some((re) => re.test(line)));
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
  if (casesComment && !isStubAnswer(casesComment)) {
    out.cases_comment = casesComment;
  }

  const impressive = normalizeText(parsed.impressive_results);
  if (impressive && !isStubAnswer(impressive)) {
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
