import { CLIENT_TRANSLATION_CATALOGS } from '@/lib/clientTranslations.generated';

export const CLIENT_LOCALES = ['ru', 'en', 'es'] as const;
export type ClientLocale = (typeof CLIENT_LOCALES)[number];

export const DEFAULT_CLIENT_LOCALE: ClientLocale = 'ru';
export const CLIENT_LOCALE_STORAGE_KEY = 'outreachos:client-locale';
export const CLIENT_LOCALE_COOKIE = 'outreachos-client-locale';

const CLIENT_LOCALE_SET = new Set<string>(CLIENT_LOCALES);
const INTL_LOCALE: Record<ClientLocale, string> = {
  ru: 'ru-RU',
  en: 'en-US',
  es: 'es-ES',
};

type TargetClientLocale = Exclude<ClientLocale, 'ru'>;
type TranslationCatalog = Readonly<Record<string, string>>;

interface TemplateRule {
  regex: RegExp;
  target: string;
}

export function normalizeClientLocale(value: unknown): ClientLocale {
  if (typeof value !== 'string') return DEFAULT_CLIENT_LOCALE;
  const normalized = value.trim().toLowerCase().split('-')[0];
  return CLIENT_LOCALE_SET.has(normalized)
    ? (normalized as ClientLocale)
    : DEFAULT_CLIENT_LOCALE;
}

export function toClientIntlLocale(locale: ClientLocale): string {
  return INTL_LOCALE[locale];
}

export function readStoredClientLocale(storage: Pick<Storage, 'getItem'>): ClientLocale {
  return normalizeClientLocale(storage.getItem(CLIENT_LOCALE_STORAGE_KEY));
}

export function writeStoredClientLocale(
  storage: Pick<Storage, 'setItem'>,
  locale: ClientLocale,
): void {
  storage.setItem(CLIENT_LOCALE_STORAGE_KEY, locale);
}

export function readClientLocaleCookie(cookieHeader: string): ClientLocale | null {
  for (const part of cookieHeader.split(';')) {
    const [name, ...valueParts] = part.trim().split('=');
    if (name !== CLIENT_LOCALE_COOKIE) continue;
    const raw = decodeURIComponent(valueParts.join('='));
    const locale = normalizeClientLocale(raw);
    return CLIENT_LOCALE_SET.has(raw.toLowerCase().split('-')[0]) ? locale : null;
  }
  return null;
}

export function writeClientLocaleCookie(locale: ClientLocale): void {
  if (typeof document === 'undefined') return;
  const sharedDomain = window.location.hostname.endsWith('outreachos.pro')
    ? '; Domain=.outreachos.pro'
    : '';
  document.cookie = `${CLIENT_LOCALE_COOKIE}=${locale}; Path=/; Max-Age=31536000; SameSite=Lax${sharedDomain}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compileTemplateRule(source: string, target: string): TemplateRule | null {
  const token = /\{(\d+)\}/g;
  let cursor = 0;
  let pattern = '^';
  let found = false;

  for (const match of source.matchAll(token)) {
    found = true;
    pattern += escapeRegExp(source.slice(cursor, match.index));
    pattern += '(.+?)';
    cursor = (match.index ?? 0) + match[0].length;
  }
  if (!found) return null;
  pattern += `${escapeRegExp(source.slice(cursor))}$`;
  return { regex: new RegExp(pattern), target };
}

function buildTemplateRules(catalog: TranslationCatalog): TemplateRule[] {
  const rules: TemplateRule[] = [];
  for (const [source, target] of Object.entries(catalog)) {
    const rule = compileTemplateRule(source, target);
    if (rule) rules.push(rule);
  }
  return rules.sort((left, right) => right.regex.source.length - left.regex.source.length);
}

const CATALOGS: Record<TargetClientLocale, TranslationCatalog> = {
  en: CLIENT_TRANSLATION_CATALOGS.en,
  es: CLIENT_TRANSLATION_CATALOGS.es,
};
const TEMPLATE_RULES: Record<TargetClientLocale, TemplateRule[]> = {
  en: buildTemplateRules(CATALOGS.en),
  es: buildTemplateRules(CATALOGS.es),
};

function applyTemplate(target: string, captures: string[]): string {
  return target.replace(/\{(\d+)\}/g, (placeholder, indexText: string) => {
    const capture = captures[Number(indexText)];
    return capture === undefined ? placeholder : capture;
  });
}

/**
 * Returns a bundled replacement for developer-authored client UI copy.
 * Unknown strings return null so campaign names, messages and other client
 * content are never sent to a translator or partially rewritten.
 */
export function getClientTranslation(source: string, locale: ClientLocale): string | null {
  if (locale === 'ru' || !source) return null;

  const leading = source.match(/^\s*/)?.[0] ?? '';
  const trailing = source.match(/\s*$/)?.[0] ?? '';
  const core = source.slice(leading.length, source.length - trailing.length);
  const normalized = core.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;

  const exact = CATALOGS[locale][normalized];
  if (exact !== undefined) return `${leading}${exact}${trailing}`;

  for (const rule of TEMPLATE_RULES[locale]) {
    const match = normalized.match(rule.regex);
    if (!match) continue;
    return `${leading}${applyTemplate(rule.target, match.slice(1))}${trailing}`;
  }
  return null;
}
