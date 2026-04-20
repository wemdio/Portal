import { navItems, NAV_PATH_ALIASES } from '@/lib/navigation';
import { commonDictionary, dict, type Locale } from '@/lib/i18n';

const SITE_LABEL = 'Portal';

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

function getClientPortalSectionTitle(pathname: string, locale: Locale): string {
  if (pathname === '/client' || pathname.startsWith('/client/campaigns')) return locale === 'en' ? 'Campaigns' : 'Кампании';
  if (pathname.startsWith('/client/projects')) return locale === 'en' ? 'Projects' : 'Проекты';
  if (pathname.startsWith('/client/leads')) return locale === 'en' ? 'Leads' : 'Лиды';
  if (pathname.startsWith('/client/bases')) return locale === 'en' ? 'Databases' : 'Базы';
  if (pathname.startsWith('/client/reports')) return locale === 'en' ? 'Reports' : 'Отчёты';
  return SITE_LABEL;
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
