export type NavItem = {
  name: string;
  href: string;
  adminOnly?: boolean;
  billingCalendarOnly?: boolean;
  /** If set, this item is hidden when the user has it disabled in user_tool_visibility */
  navTabId?: string;
  requiresTool?: string;
  badgeId?: string;
};

export const navItems: NavItem[] = [
  { name: 'Проекты', href: '/' },
  { name: 'Аналитика проектов', href: '/analytics/projects' },
  { name: 'Задачи', href: '/tasks' },
  { name: 'Доска', href: '/board', navTabId: 'nav-tasks-board' },
  { name: 'Команда', href: '/team' },
  { name: 'Финансы', href: '/finance' },
  { name: 'Проверка баз', href: '/tools/databases/review', requiresTool: 'database-review', badgeId: 'review-count' },
  { name: 'Инструменты', href: '/tools' },
  { name: 'Оплаты', href: '/payments' },
  { name: 'Календарь почт', href: '/billing-calendar', billingCalendarOnly: true },
  { name: 'Регламент', href: '/reglament' },
  { name: 'Админ', href: '/admin', adminOnly: true },
  { name: 'Профиль', href: '/profile' },
];
