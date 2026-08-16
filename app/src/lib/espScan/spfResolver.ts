/**
 * DNS-резолв SPF-записи домена. Чистый node:dns — работает и на сервере,
 * и локально с ПК (для CLI app/scripts/espScan.ts).
 *
 * Резолвер пиннут на публичные серверы (паттерн emailValidation/validator.ts):
 * системный резолвер Windows/провайдера может кэшировать NXDOMAIN агрессивно
 * или резолвить медленно; публичные дают предсказуемую скорость.
 */

import dns from 'node:dns';

export interface SpfLookupResult {
  /** Сырая v=spf1 запись (без trim-модификаций кроме краёв). null — SPF нет. */
  spf: string | null;
  /**
   * ok           — SPF получен.
   * no_spf       — домен резолвится, но TXT/v=spf1 нет (постоянный негатив).
   * no_domain    — домен не существует (ENOTFOUND — постоянный негатив).
   * transient    — таймаут/SERVFAIL/EAI_AGAIN — стоит повторить позже.
   */
  status: 'ok' | 'no_spf' | 'no_domain' | 'transient';
  /** Код/сообщение ошибки для логов. */
  error?: string;
}

const spfResolver = new dns.promises.Resolver({ timeout: 4_000, tries: 2 });
spfResolver.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);

/** Коды, которые считаем постоянным негативом (домен/запись отсутствуют). */
const PERMANENT_NEGATIVE_CODES = new Set(['ENOTFOUND', 'ENODATA']);

export async function lookupSpf(domain: string): Promise<SpfLookupResult> {
  let chunks: string[][];
  try {
    chunks = await spfResolver.resolveTxt(domain);
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'UNKNOWN';
    if (PERMANENT_NEGATIVE_CODES.has(code)) {
      return code === 'ENOTFOUND'
        ? { spf: null, status: 'no_domain', error: code }
        : { spf: null, status: 'no_spf', error: code };
    }
    return { spf: null, status: 'transient', error: code };
  }

  // TXT-запись может прийти разбитой на чанки (строки ≤255 байт) — склеиваем.
  const records = chunks.map((chunksOfRecord) => chunksOfRecord.join(''));
  const spf = records.find((r) => r.trim().toLowerCase().startsWith('v=spf1'));
  if (!spf) return { spf: null, status: 'no_spf' };
  return { spf: spf.trim(), status: 'ok' };
}

/**
 * Нормализация домена: lowercase, без схемы, без пути, без www. Является
 * ключом дедупликации (один домен — один резолв на прогон).
 * Копия normalizeDomain из jobs/mailganerScoreCache.ts (там server-only).
 */
export function normalizeDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  let trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;
  const schemeMatch = trimmed.match(/^[a-z][a-z0-9+.-]*:\/\//);
  if (schemeMatch) trimmed = trimmed.slice(schemeMatch[0].length);
  const slashIdx = trimmed.indexOf('/');
  if (slashIdx !== -1) trimmed = trimmed.slice(0, slashIdx);
  const queryIdx = trimmed.indexOf('?');
  if (queryIdx !== -1) trimmed = trimmed.slice(0, queryIdx);
  const hashIdx = trimmed.indexOf('#');
  if (hashIdx !== -1) trimmed = trimmed.slice(0, hashIdx);
  if (trimmed.startsWith('www.')) trimmed = trimmed.slice(4);
  if (trimmed.length < 3 || !trimmed.includes('.') || trimmed.endsWith('.')) return null;
  if (!/^[a-z0-9.-]+$/.test(trimmed)) return null;
  return trimmed;
}
