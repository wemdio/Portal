import { navItems, NAV_PATH_ALIASES } from '@/lib/navigation';

const SITE_LABEL = 'Portal';

/** Sections reachable from the shell but not as a single `navItems.href` prefix. */
const EXTRA_SECTION_PREFIXES: { prefix: string; title: string }[] = [
  { prefix: '/projects', title: 'Проекты' },
  { prefix: '/settings', title: 'Настройки' },
  { prefix: '/reglament-legacy', title: 'Регламент' },
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

function getClientPortalSectionTitle(pathname: string): string {
  if (pathname === '/client' || pathname.startsWith('/client/campaigns')) return 'Кампании';
  if (pathname.startsWith('/client/bases')) return 'Базы';
  if (pathname.startsWith('/client/reports')) return 'Отчёты';
  return SITE_LABEL;
}

/**
 * Human-readable section title for the browser tab (aligned with main nav labels).
 */
export function getPortalPageSectionTitle(pathname: string | null): string {
  if (!pathname) return SITE_LABEL;

  if (pathname.startsWith('/client')) {
    return getClientPortalSectionTitle(pathname);
  }
  if (pathname === '/login') return 'Вход';
  if (pathname === '/maintenance') return 'Обновление портала';
  if (pathname.startsWith('/review/')) return 'Просмотр базы';

  const norm = normalizePathnameForNav(pathname);

  let bestLen = -1;
  let bestTitle = SITE_LABEL;

  for (const item of navItems) {
    if (item.href === '/') {
      if (norm === '/') {
        if (bestLen < 1) {
          bestLen = 1;
          bestTitle = item.name;
        }
      }
      continue;
    }
    if (norm === item.href || norm.startsWith(`${item.href}/`)) {
      if (item.href.length > bestLen) {
        bestLen = item.href.length;
        bestTitle = item.name;
      }
    }
  }

  for (const { prefix, title } of EXTRA_SECTION_PREFIXES) {
    if (norm === prefix || norm.startsWith(`${prefix}/`)) {
      if (prefix.length > bestLen) {
        bestLen = prefix.length;
        bestTitle = title;
      }
    }
  }

  return bestTitle;
}
