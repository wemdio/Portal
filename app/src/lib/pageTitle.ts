import { navItems, NAV_PATH_ALIASES } from '@/lib/navigation';
import { commonDictionary, dict, type Locale } from '@/lib/i18n';

const SITE_LABEL = 'outreachOS';

/** Sections reachable from the shell but not as a single `navItems.href` prefix. */
const EXTRA_SECTION_PREFIXES: { prefix: string; titleRu: string; titleEn: string }[] = [
  { prefix: '/projects', titleRu: 'Проекты', titleEn: 'Projects' },
  { prefix: '/settings', titleRu: 'Настройки', titleEn: 'Settings' },
  { prefix: '/reglament-legacy', titleRu: 'Регламент', titleEn: 'Regulation' },
];

function normalizePathnameForNav(pathname: string): string {
  for (const [canonical, aliases] of Object.entries(NAV_PATH_ALIASES)) {
    for (const alias of aliases) {
      if (pathname === alias || pathname.startsWith(`${alias}/`)) {
        return canonical + pathname.slice(alias.length);
      }
    }
  }
  return pathname;
}

const CLIENT_SECTION_TITLES: ReadonlyArray<{
  prefix: string;
  ru: string;
  en: string;
  es: string;
}> = [
  { prefix: '/client/auto-pipeline/setup', ru: 'Настройка цепочек', en: 'Sequence setup', es: 'Configurar secuencias' },
  { prefix: '/client/base-constructor', ru: 'Конструктор баз', en: 'List builder', es: 'Constructor de listas' },
  { prefix: '/client/companies-search', ru: 'Поиск компаний', en: 'Company search', es: 'Búsqueda de empresas' },
  { prefix: '/client/manual-scoring', ru: 'Ручная обработка', en: 'Manual scoring', es: 'Scoring manual' },
  { prefix: '/client/dashboard', ru: 'Дашборд', en: 'Dashboard', es: 'Panel' },
  { prefix: '/client/campaigns', ru: 'Кампании', en: 'Campaigns', es: 'Campañas' },
  { prefix: '/client/projects', ru: 'Проекты', en: 'Projects', es: 'Proyectos' },
  { prefix: '/client/replies', ru: 'Ответы', en: 'Replies', es: 'Respuestas' },
  { prefix: '/client/blocklist', ru: 'Чёрный список', en: 'Blocklist', es: 'Lista de bloqueo' },
  { prefix: '/client/reports', ru: 'Воронка базы', en: 'List funnel', es: 'Embudo de listas' },
  { prefix: '/client/tariff', ru: 'Тариф', en: 'Plan', es: 'Plan' },
  { prefix: '/client/mailboxes', ru: 'Мои почты', en: 'My mailboxes', es: 'Mis buzones' },
  { prefix: '/client/settings', ru: 'Настройки', en: 'Settings', es: 'Configuración' },
  { prefix: '/client/support', ru: 'Поддержка', en: 'Support', es: 'Soporte' },
  { prefix: '/client/sequences', ru: 'Цепочки писем', en: 'Email sequences', es: 'Secuencias de email' },
  { prefix: '/client/launch', ru: 'Создать кампанию', en: 'Create campaign', es: 'Crear campaña' },
  { prefix: '/client/brief', ru: 'Бриф', en: 'Brief', es: 'Brief' },
  { prefix: '/client/bases', ru: 'Базы', en: 'Contact lists', es: 'Listas de contactos' },
  { prefix: '/client/leads', ru: 'Лиды', en: 'Leads', es: 'Leads' },
  { prefix: '/client/build', ru: 'Сбор базы', en: 'Build a list', es: 'Crear una lista' },
  { prefix: '/client/parsers', ru: 'Парсеры', en: 'Parsers', es: 'Extractores' },
  { prefix: '/client/offer', ru: 'Договор оферты', en: 'Terms of service', es: 'Términos del servicio' },
  { prefix: '/client/eng', ru: 'Outreach', en: 'Outreach', es: 'Outreach' },
];

function getClientPortalSectionTitle(pathname: string, locale: Locale): string {
  if (pathname === '/client') {
    return locale === 'en' ? 'Campaigns' : locale === 'es' ? 'Campañas' : 'Кампании';
  }
  const section = CLIENT_SECTION_TITLES.find(
    ({ prefix }) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
  if (!section) return SITE_LABEL;
  return locale === 'en' ? section.en : locale === 'es' ? section.es : section.ru;
}

/**
 * Human-readable section title for the browser tab (aligned with main nav labels).
 */
export function getPortalPageSectionTitle(pathname: string | null, locale: Locale = 'ru'): string {
  if (!pathname) return SITE_LABEL;

  if (pathname.startsWith('/client')) {
    return getClientPortalSectionTitle(pathname, locale);
  }
  if (pathname === '/login') return dict(commonDictionary.login, locale);
  if (pathname === '/maintenance') return dict(commonDictionary.maintenance, locale);
  if (pathname.startsWith('/review/')) return dict(commonDictionary.reviewBase, locale);

  const norm = normalizePathnameForNav(pathname);

  let bestLen = -1;
  let bestTitle = SITE_LABEL;

  for (const item of navItems) {
    if (item.href === '/') {
      if (norm === '/') {
        if (bestLen < 1) {
          bestLen = 1;
          bestTitle = locale === 'en' ? item.nameEn : item.name;
        }
      }
      continue;
    }
    if (norm === item.href || norm.startsWith(`${item.href}/`)) {
      if (item.href.length > bestLen) {
        bestLen = item.href.length;
        bestTitle = locale === 'en' ? item.nameEn : item.name;
      }
    }
  }

  for (const { prefix, titleRu, titleEn } of EXTRA_SECTION_PREFIXES) {
    if (norm === prefix || norm.startsWith(`${prefix}/`)) {
      if (prefix.length > bestLen) {
        bestLen = prefix.length;
        bestTitle = locale === 'en' ? titleEn : titleRu;
      }
    }
  }

  return bestTitle;
}
