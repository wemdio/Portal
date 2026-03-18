/**
 * TASK 1.1 — Интеграция с ФНС / ЕГРЮЛ.
 * Получение данных компании по ИНН: название, ОГРН, гендиректор.
 * Использует DaData (данные ЕГРЮЛ); при необходимости можно заменить на прямой парсинг nalog.ru.
 */

import { findByInn, hasDadataKey, type DadataSuggestion } from '@/lib/enrich/dadataClient';

export interface FnsCompanyResult {
  name: string;
  ogrn: string | null;
  ceo: string | null;
  inn: string;
  source: 'dadata';
}

export type FnsCompanyErrorCode = 'not_found' | 'multiple' | 'api_error' | 'no_key';

export class FnsCompanyError extends Error {
  constructor(
    message: string,
    public readonly code: FnsCompanyErrorCode,
    public readonly inn?: string,
  ) {
    super(message);
    this.name = 'FnsCompanyError';
  }
}

/**
 * Получить данные компании по ИНН.
 * Output: название, ОГРН, гендиректор (ФИО из management).
 * Ошибки: не найдено → null; несколько записей (DaData возвращает одну) → не применимо; API/сеть → FnsCompanyError.
 */
export async function getCompanyByInn(inn: string): Promise<FnsCompanyResult | null> {
  const normalized = inn.replace(/\D/g, '');
  if (normalized.length !== 10 && normalized.length !== 12) {
    throw new FnsCompanyError(`Invalid INN length: ${normalized.length}`, 'api_error', inn);
  }

  if (!hasDadataKey()) {
    throw new FnsCompanyError('FNS/DaData API key not configured', 'no_key', inn);
  }

  let suggestion: DadataSuggestion | null;
  try {
    suggestion = await findByInn(normalized);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new FnsCompanyError(`API error: ${msg}`, 'api_error', inn);
  }

  if (!suggestion?.data) return null;

  const data = suggestion.data;
  const name =
    (data.name?.full_with_opf && String(data.name.full_with_opf).trim()) ||
    (suggestion.value && String(suggestion.value).trim()) ||
    '';
  if (!name) return null;

  const ogrn = data.ogrn ? String(data.ogrn).trim() || null : null;
  const ceo =
    (data.management?.name && String(data.management.name).trim()) || null;

  return {
    name,
    ogrn,
    ceo,
    inn: data.inn ? String(data.inn) : normalized,
    source: 'dadata',
  };
}

/**
 * Безопасный вызов: при любой ошибке возвращает null.
 */
export async function getCompanyByInnSafe(inn: string): Promise<FnsCompanyResult | null> {
  try {
    return await getCompanyByInn(inn);
  } catch {
    return null;
  }
}
