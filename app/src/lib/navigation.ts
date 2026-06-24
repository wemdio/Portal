export type NavItem = {
  id: string;
  name: string;
  nameEn: string;
  href: string;
  adminOnly?: boolean;
  billingCalendarOnly?: boolean;
  /** Visible only to admins and technicians (uses lib/roles.ts isTechnician). */
  technicianOrAdmin?: boolean;
  /** If set, this item is hidden when the user has it disabled in user_tool_visibility */
  navTabId?: string;
  requiresTool?: string;
  badgeId?: string;
};

/** Paths that belong to a nav section but use a different URL prefix (sync with TopNav / Sidebar). */
export const NAV_PATH_ALIASES: Record<string, string[]> = {
  '/tools': ['/parsers'],
};

export const navItems: NavItem[] = [
  { id: 'projects', name: 'Проекты', nameEn: 'Projects', href: '/' },
  { id: 'projects-analytics', name: 'Аналитика проектов', nameEn: 'Project analytics', href: '/analytics/projects' },
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
