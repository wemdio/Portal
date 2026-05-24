/**
 * Top-up из «базы баз» (companies_directory) для auto-pipeline.
 *
 * HH парсинг даёт ограниченную выборку (даже по 30 индустриям ~5-10k уникальных
 * компаний/день). Чтобы стабильно держать 670 ready/день для 20k/мес, добираем
 * недостающее из нашего ФНС-датасета (2.2М компаний) с фильтром revenue ≥40M.
 *
 * Контракт:
 *   - Принимаем: сколько ещё нужно (neededCount), seen-домены (уже видели), фильтры
 *   - Возвращаем: массив employer'ов в формате HhEmployer (тот же, что HH-парсер),
 *     чтобы дальше оркестратор обрабатывал их одинаково — scrape + Mailganer +
 *     SMTP, без отдельных веток.
 *   - Pre-existing email из BoB ИГНОРИРУЕМ — клиент решил всегда скрейпить сайт
 *     (BoB-email может быть устаревшим из ФНС, scrape — свежий).
 *
 * Dedup:
 *   - По домену (LOWER, без www.). Это естественный ключ — компания может
 *     обновить юр-лицо/ИНН но домен обычно один. И HH employer.id никак не
 *     связан с BoB.id, поэтому полагаемся на domain.
 *
 * Pagination:
 *   - Берём по 200 строк за RPC-вызов. После каждого батча применяем dedup и
 *     exclude-patterns; если набрали — выходим. Hard cap MAX_SCANNED предохраняет
 *     от бесконечного скана, если все компании уже виденные.
 */

import { searchRows } from '@/lib/companiesSearch/rpcSearch';
import type { HhEmployer } from './hhAutoParser';

/** Поля, которые мы реально используем из BoB row. Остальные jsonb-ключи игнорируем. */
interface BobRow {
  id?: number;
  inn?: string;
  name?: string;
  website?: string | null;
  revenue?: number | null;
  address?: string | null;
  okved_name?: string | null;
  activity_type?: string | null;
  employees_count?: number | null;
}

/** Чистим название от escaped quotes и обрезаем пробелы. */
export function cleanBobName(name: string): string {
  return name.replace(/\\"/g, '"').replace(/\s+/g, ' ').trim();
}

/**
 * Поле website может быть multi-value: "site1.ru, site2.com, site3.io". Берём
 * первый непустой. Также убираем протокол если есть, потом обратно добавляем
 * https:// — единый формат для deriveDomain дальше.
 */
export function extractFirstWebsite(website: string | null | undefined): string | null {
  if (!website || typeof website !== 'string') return null;
  const first = website.split(',')[0].trim();
  if (!first) return null;
  // Может быть с протоколом или без — нормализуем
  const cleaned = first.replace(/^https?:\/\//i, '').replace(/\/$/, '').trim();
  return cleaned ? `https://${cleaned}` : null;
}

/** Извлекаем город из address вроде "123056, г. Москва, Грузинский пер., д. 3А". */
export function extractCityFromAddress(address: string | null | undefined): string | null {
  if (!address) return null;
  // Шаблон "г. <City>" — обязательна точка после «г», чтобы не цеплять
  // случайные слова типа "города". Город начинается с заглавной буквы.
  const match = address.match(/(?:^|[,\s])г\.\s*([А-ЯЁA-Z][А-Яа-яЁёA-Za-z\-]+)/);
  return match?.[1]?.trim() ?? null;
}

/** Domain из siteUrl для dedup-Set. Возвращает null если URL не парсится. */
function siteUrlToDomain(siteUrl: string | null): string | null {
  if (!siteUrl) return null;
  try {
    const u = new URL(siteUrl.startsWith('http') ? siteUrl : `https://${siteUrl}`);
    return u.hostname.replace(/^www\./, '').toLowerCase() || null;
  } catch {
    return null;
  }
}

export interface FetchTopUpInput {
  /** Сколько ещё компаний нужно (после HH parsing). */
  neededCount: number;
  /** Минимальный оборот (в рублях). 40M default. */
  revenueFrom: number;
  /** Уже виденные домены — обоих источников (HH-результаты в memory + БД seen_employers). */
  seenDomains: Set<string>;
  /** Regex-паттерны имени для exclude (федеральные бренды и пр.). */
  excludePatterns: RegExp[];
  /** Optional logger. */
  log?: (msg: string) => void;
  /**
   * Сколько строк брать за один RPC-вызов. Default 200. RPC возвращает jsonb,
   * слишком большие батчи перегружают сериализацию.
   */
  batchSize?: number;
  /**
   * Hard cap на количество просканированных строк. Защита от бесконечного
   * скана если все компании уже в seenDomains. Default neededCount × 10.
   */
  maxScanned?: number;
  /**
   * Override для searchRows — используется в тестах чтобы не дёргать настоящий RPC.
   */
  searchRowsImpl?: typeof searchRows;
}

export interface FetchTopUpResult {
  employers: HhEmployer[];
  scanned: number;
  /** Сколько было отсеяно потому что domain уже в seenDomains. */
  dedupSkipped: number;
  /** Сколько отсеяно по excludePatterns. */
  excludeSkipped: number;
  /** Сколько без сайта. */
  noSiteSkipped: number;
}

/**
 * Возвращает до `neededCount` компаний из BoB, прошедших фильтры.
 * Если scanned ≥ maxScanned до набора needed — возвращаем что есть с warn-логом.
 */
export async function fetchTopUpFromBaseOfBases(
  input: FetchTopUpInput,
): Promise<FetchTopUpResult> {
  const log = input.log ?? (() => undefined);
  const batchSize = input.batchSize ?? 200;
  const maxScanned = input.maxScanned ?? input.neededCount * 10;
  const search = input.searchRowsImpl ?? searchRows;

  const employers: HhEmployer[] = [];
  let offset = 0;
  let scanned = 0;
  let dedupSkipped = 0;
  let excludeSkipped = 0;
  let noSiteSkipped = 0;

  if (input.neededCount <= 0) {
    return { employers, scanned, dedupSkipped, excludeSkipped, noSiteSkipped };
  }

  log(
    `BoB: fetching top-up — needed=${input.neededCount}, revenueFrom=${input.revenueFrom}, batch=${batchSize}, maxScan=${maxScanned}`,
  );

  while (employers.length < input.neededCount && scanned < maxScanned) {
    const { rows, error } = await search(
      {
        revenueFrom: input.revenueFrom,
        hasWebsite: true,
        includeIp: false,
      },
      batchSize,
      offset,
    );

    if (error) {
      log(`BoB: batch error at offset=${offset}: ${error}`);
      break;
    }
    if (!rows || rows.length === 0) {
      log(`BoB: exhausted at offset=${offset}, scanned=${scanned}`);
      break;
    }

    scanned += rows.length;

    for (const raw of rows as BobRow[]) {
      if (employers.length >= input.neededCount) break;

      const siteUrl = extractFirstWebsite(raw.website);
      if (!siteUrl) {
        noSiteSkipped++;
        continue;
      }
      const domain = siteUrlToDomain(siteUrl);
      if (!domain) {
        noSiteSkipped++;
        continue;
      }
      if (input.seenDomains.has(domain)) {
        dedupSkipped++;
        continue;
      }

      const name = cleanBobName(raw.name ?? '');
      if (!name) continue;
      if (input.excludePatterns.some((p) => p.test(name))) {
        excludeSkipped++;
        continue;
      }

      // Записываем в seen прямо здесь — следующие батчи не вернут дубль
      // даже без участия orchestrator-уровня дедупа.
      input.seenDomains.add(domain);

      employers.push({
        id: `bob:${raw.inn || raw.id || domain}`,
        name,
        siteUrl,
        hhUrl: null,
        area: extractCityFromAddress(raw.address),
        industries: [raw.activity_type, raw.okved_name].filter(
          (s): s is string => typeof s === 'string' && s.length > 0,
        ),
        employeeCount: typeof raw.employees_count === 'number' ? raw.employees_count : null,
      });
    }

    offset += batchSize;
  }

  log(
    `BoB: produced ${employers.length}/${input.neededCount} — scanned=${scanned} dedupSkipped=${dedupSkipped} excludeSkipped=${excludeSkipped} noSiteSkipped=${noSiteSkipped}`,
  );

  return {
    employers,
    scanned,
    dedupSkipped,
    excludeSkipped,
    noSiteSkipped,
  };
}
