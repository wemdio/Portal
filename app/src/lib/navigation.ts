import type { UserRole } from '@/types';
import { canAccessBillingCalendar, isAdmin, isLead, isTechnician } from '@/lib/roles';
import { NAV_TABS_CONFIG, type NavTabId } from '@/lib/toolsRegistry';

export type NavItem = {
  id: string;
  name: string;
  nameEn: string;
  href: string;
  adminOnly?: boolean;
  billingCalendarOnly?: boolean;
  /** Visible only to admins and technicians (uses lib/roles.ts isTechnician). */
  technicianOrAdmin?: boolean;
  /** Visible only to management — lead / director / admin (uses lib/roles.ts isLead). */
  leadOnly?: boolean;
  /** If set, this item is hidden when the user has it disabled in user_tool_visibility */
  navTabId?: string;
  requiresTool?: string;
  badgeId?: string;
};

/**
 * Группа пунктов меню. Своего адреса у группы нет — она только раскрывается
 * списком детей, поэтому и правил доступа на самой группе тоже нет: группа
 * видна ровно тогда, когда виден хотя бы один её ребёнок (см. isNavEntryVisible).
 */
export type NavGroup = {
  id: string;
  name: string;
  nameEn: string;
  children: NavItem[];
};

/** Элемент верхнего уровня меню: либо обычная ссылка, либо группа. */
export type NavEntry = NavItem | NavGroup;

export function isNavGroup(entry: NavEntry): entry is NavGroup {
  return 'children' in entry;
}

/** Paths that belong to a nav section but use a different URL prefix (sync with TopNav / Sidebar). */
export const NAV_PATH_ALIASES: Record<string, string[]> = {
  '/tools': ['/parsers'],
};

/**
 * Дерево меню — источник правды для TopNav и Sidebar.
 *
 * Дашборды («Первичка» и «Расходы и доходы») сведены в одну группу: оба пункта
 * — это дашборды, а в шапке они занимали два места из полутора десятков.
 * Правила доступа при этом остались на самих пунктах и не изменились:
 * «Первичка» — точечная выдача через user_tool_visibility, «Расходы и доходы» —
 * только админ.
 */
export const navTree: NavEntry[] = [
  { id: 'projects', name: 'Проекты', nameEn: 'Projects', href: '/' },
  { id: 'projects-analytics', name: 'Аналитика проектов', nameEn: 'Project analytics', href: '/analytics/projects' },
  { id: 'mailbox-load', name: 'Нагрузка почт', nameEn: 'Mailbox load', href: '/analytics/mailbox-load', leadOnly: true },
  {
    id: 'dashboards',
    name: 'Дашборды',
    nameEn: 'Dashboards',
    children: [
      { id: 'first-sales', name: 'Первичка', nameEn: 'First sales', href: '/analytics/first-sales', navTabId: 'nav-first-sales' },
      { id: 'expenses', name: 'Расходы и доходы', nameEn: 'Income & expenses', href: '/expenses', adminOnly: true },
    ],
  },
  { id: 'tasks', name: 'Задачи', nameEn: 'Tasks', href: '/tasks' },
  { id: 'board', name: 'Доска', nameEn: 'Board', href: '/board', navTabId: 'nav-tasks-board' },
  { id: 'team', name: 'Команда', nameEn: 'Team', href: '/team' },
  { id: 'finance', name: 'Финансы', nameEn: 'Finance', href: '/finance' },
  { id: 'instantly', name: 'Instantly', nameEn: 'Instantly', href: '/instantly', requiresTool: 'instantly' },
  { id: 'tools', name: 'Инструменты', nameEn: 'Tools', href: '/tools' },
  { id: 'payments', name: 'Оплаты', nameEn: 'Payments', href: '/payments' },
  { id: 'billing-calendar', name: 'Календарь почт', nameEn: 'Mailbox calendar', href: '/billing-calendar', billingCalendarOnly: true },
  { id: 'regulation', name: 'Регламент', nameEn: 'Regulation', href: '/reglament' },
  { id: 'admin', name: 'Админ', nameEn: 'Admin', href: '/admin', adminOnly: true },
  {
    id: 'invoices',
    name: 'Счета',
    nameEn: 'Invoices',
    href: '/invoices',
    technicianOrAdmin: true,
  },
  {
    id: 'support',
    name: 'Чаты клиентов',
    nameEn: 'Client support',
    href: '/support',
    technicianOrAdmin: true,
  },
  { id: 'profile', name: 'Профиль', nameEn: 'Profile', href: '/profile' },
];

/**
 * Плоский список конечных пунктов (группы раскрыты).
 *
 * Нужен там, где вложенность не важна и нужен именно адрес: заголовок вкладки
 * браузера (lib/pageTitle) и горизонтальная лента чипов в Telegram-шапке.
 */
export const navItems: NavItem[] = navTree.flatMap((entry) => (isNavGroup(entry) ? entry.children : [entry]));

/** Всё, от чего зависит видимость пункта меню. */
export type NavVisibilityContext = {
  userRole: UserRole | null;
  /** user_tool_visibility, ключ — navTabId. Отсутствие ключа = «не выключено». */
  navTabVisibility: Record<string, boolean>;
  /** null — список инструментов ещё не загружен, по requiresTool не фильтруем. */
  visibleTools: string[] | null;
};

/**
 * Доступен ли пункт меню этому пользователю.
 *
 * Единственное место, где живут правила видимости: TopNav и Sidebar раньше
 * держали по своей копии этого фильтра, и они успели разойтись.
 */
export function isNavTabVisible(item: NavItem, ctx: NavVisibilityContext): boolean {
  const { userRole, navTabVisibility, visibleTools } = ctx;
  if (item.adminOnly && !isAdmin(userRole)) return false;
  if (item.technicianOrAdmin && !isTechnician(userRole)) return false;
  if (item.leadOnly && !isLead(userRole)) return false;
  if (item.billingCalendarOnly && !canAccessBillingCalendar(userRole)) return false;
  if (
    item.navTabId
    && navTabVisibility[item.navTabId] === false
    && !(NAV_TABS_CONFIG[item.navTabId as NavTabId]?.adminAlwaysOn && isAdmin(userRole))
  ) return false;
  if (item.requiresTool && visibleTools !== null && !visibleTools.includes(item.requiresTool)) return false;
  return true;
}

/** Дети группы, доступные пользователю. В меню показываем только их. */
export function visibleNavChildren(group: NavGroup, ctx: NavVisibilityContext): NavItem[] {
  return group.children.filter((child) => isNavTabVisible(child, ctx));
}

/**
 * Доступен ли элемент верхнего уровня.
 *
 * Группа — только если доступен хотя бы один ребёнок: менеджер без выданной
 * «Первички» не должен видеть пустой пункт «Дашборды».
 */
export function isNavEntryVisible(entry: NavEntry, ctx: NavVisibilityContext): boolean {
  return isNavGroup(entry) ? visibleNavChildren(entry, ctx).length > 0 : isNavTabVisible(entry, ctx);
}

/**
 * Меню для конкретного пользователя: недоступные пункты убраны, у групп
 * оставлены только доступные дети (группа без детей выпадает целиком).
 */
export function visibleNavEntries(ctx: NavVisibilityContext, entries: NavEntry[] = navTree): NavEntry[] {
  const result: NavEntry[] = [];
  for (const entry of entries) {
    if (isNavGroup(entry)) {
      const children = visibleNavChildren(entry, ctx);
      if (children.length > 0) result.push({ ...entry, children });
      continue;
    }
    if (isNavTabVisible(entry, ctx)) result.push(entry);
  }
  return result;
}

/** Открыт ли сейчас раздел этого пункта (учитывая вложенные пути и алиасы). */
export function isNavItemActive(item: NavItem, pathname: string): boolean {
  if (item.href === '/') return pathname === '/';
  if (pathname === item.href || pathname.startsWith(`${item.href}/`)) return true;
  const aliases = NAV_PATH_ALIASES[item.href] ?? [];
  return aliases.some((alias) => pathname === alias || pathname.startsWith(`${alias}/`));
}

/**
 * Активность элемента верхнего уровня. У группы своего адреса нет, поэтому
 * она подсвечивается, когда открыт любой из её (видимых) детей.
 */
export function isNavEntryActive(entry: NavEntry, pathname: string): boolean {
  return isNavGroup(entry)
    ? entry.children.some((child) => isNavItemActive(child, pathname))
    : isNavItemActive(entry, pathname);
}
