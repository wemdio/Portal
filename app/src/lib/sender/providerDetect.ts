import 'server-only';

import { promises as dns } from 'dns';

/**
 * Кто провайдер загружаемого ящика — определяем сами.
 *
 * Раньше провайдера выбирали руками в списке над кнопкой загрузки, хотя
 * выбор влиял ровно на одно: чем заполнить поля, которых нет в файле (SMTP-хост,
 * порт, режим TLS, IMAP-хост). Человек при этом знал не больше, чем сам файл:
 * выгрузка либо везёт хосты в колонках, либо узнаётся по шапке, либо провайдер
 * читается из DNS домена. Поэтому список убран, а распознавание идёт лесенкой
 * (см. detectFromFile ниже и вызов в mailboxImport).
 *
 * Отдельного значения «zapmail» больше нет: ZapMail продаёт ящики на Google или
 * на Outlook, и настройки у них ровно те же. Старые строки в БД со значением
 * zapmail остаются как есть — оно просто перестало записываться.
 */

export type SenderProvider = 'maildoso' | 'google' | 'outlook' | 'custom';
export type TlsMode = 'implicit_tls' | 'starttls';

export interface ProviderPreset {
  /** Нет хоста — значит, он обязан прийти из файла. */
  smtpHost?: string;
  smtpPort: number;
  smtpTlsMode: TlsMode;
  imapHost?: string;
  imapPort: number;
}

/** Порты и режим TLS по умолчанию. IMAP-хост Maildoso индивидуален для каждого ящика. */
export const PRESETS: Record<SenderProvider, ProviderPreset> = {
  maildoso: { smtpHost: 'smtp.maildoso.com', smtpPort: 587, smtpTlsMode: 'starttls', imapPort: 993 },
  google: { smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpTlsMode: 'implicit_tls', imapHost: 'imap.gmail.com', imapPort: 993 },
  outlook: { smtpHost: 'smtp.office365.com', smtpPort: 587, smtpTlsMode: 'starttls', imapHost: 'outlook.office365.com', imapPort: 993 },
  custom: { smtpPort: 587, smtpTlsMode: 'starttls', imapPort: 993 },
};

/**
 * Ничего не поняли — грузим как Maildoso. Это значение и стояло в списке по
 * умолчанию, то есть поведение файлов, которые загружались раньше, не меняется.
 */
export const FALLBACK_PROVIDER: SenderProvider = 'maildoso';

const HOST_SIGNATURES: [RegExp, SenderProvider][] = [
  [/maildoso/i, 'maildoso'],
  [/gmail|google/i, 'google'],
  [/outlook|office365|microsoft|hotmail|live\.com/i, 'outlook'],
];

/** Хост (SMTP, IMAP или MX) → провайдер. Неизвестный хост — null, а не «custom». */
export function providerFromHost(host: string): SenderProvider | null {
  const value = host.trim();
  if (!value) return null;
  for (const [pattern, provider] of HOST_SIGNATURES) {
    if (pattern.test(value)) return provider;
  }
  return null;
}

/** Публичные почтовые домены: у них MX спрашивать незачем. */
const CONSUMER_DOMAINS: Record<string, SenderProvider> = {
  'gmail.com': 'google',
  'googlemail.com': 'google',
  'outlook.com': 'outlook',
  'hotmail.com': 'outlook',
  'live.com': 'outlook',
};

export function providerFromEmailDomain(domain: string): SenderProvider | null {
  return CONSUMER_DOMAINS[domain.toLowerCase()] ?? null;
}

/**
 * Колонки, которые встречаются только в выгрузке пользователей Google Workspace:
 * «Org Unit Path [Required]», «Password Hash Function [UPLOAD ONLY]», «Last Sign
 * In [READ ONLY]». Хостов в такой выгрузке нет вовсе, поэтому шапка — там
 * единственная зацепка до DNS.
 */
const GOOGLE_EXPORT_MARKERS = [
  'orgunitpath',
  'passwordhashfunction',
  'lastsignin',
  'newprimaryemail',
  '2svenrolled',
  '2svenforced',
];

export function providerFromHeaders(normalizedHeaders: string[]): SenderProvider | null {
  const set = new Set(normalizedHeaders);
  // Org Unit Path не встречается больше нигде — одного такого заголовка хватает.
  if (set.has('orgunitpath')) return 'google';
  const hits = GOOGLE_EXPORT_MARKERS.filter((marker) => set.has(marker)).length;
  return hits >= 2 ? 'google' : null;
}

/** Домен не отвечает за пару секунд — не повод держать загрузку файла. */
const DNS_TIMEOUT_MS = 2_500;
const DNS_CONCURRENCY = 8;
/**
 * Потолок на число доменов в одном файле: выгрузка на 20 тысяч строк не должна
 * превращаться в тысячи DNS-запросов. Доменов у аутрич-ящиков единицы, так что
 * в потолок упирается только мусорный файл — его строки уедут на значение по
 * умолчанию, как и раньше.
 */
const MAX_DOMAIN_LOOKUPS = 200;
/** MX меняется редко, но процесс живёт неделями — значение не должно киснуть. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const cache = new Map<string, { provider: SenderProvider | null; at: number }>();

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('dns timeout')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Куда домен принимает почту. Это только DNS-запрос: никуда не подключаемся,
 * проверка адреса перед реальным подключением живёт в byoMailbox/netGuard.
 */
export async function lookupProviderByMx(domain: string): Promise<SenderProvider | null> {
  const key = domain.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.provider;

  let provider: SenderProvider | null = null;
  try {
    const records = await withTimeout(dns.resolveMx(key), DNS_TIMEOUT_MS);
    // Приоритет: основной MX первым, у него и спрашиваем провайдера.
    for (const record of [...records].sort((a, b) => a.priority - b.priority)) {
      provider = providerFromHost(record.exchange);
      if (provider) break;
    }
  } catch {
    provider = null;
  }

  cache.set(key, { provider, at: Date.now() });
  return provider;
}

export type DomainLookup = (domain: string) => Promise<SenderProvider | null>;

/** Домены → провайдеры, пачками: у файла на 200 ящиков доменов обычно единицы. */
export async function lookupProviders(
  domains: string[],
  lookup: DomainLookup = lookupProviderByMx,
): Promise<Map<string, SenderProvider>> {
  const out = new Map<string, SenderProvider>();
  const list = domains.slice(0, MAX_DOMAIN_LOOKUPS);
  for (let i = 0; i < list.length; i += DNS_CONCURRENCY) {
    const chunk = list.slice(i, i + DNS_CONCURRENCY);
    const found = await Promise.all(chunk.map((domain) => lookup(domain).catch(() => null)));
    chunk.forEach((domain, index) => {
      const provider = found[index];
      if (provider) out.set(domain, provider);
    });
  }
  return out;
}
