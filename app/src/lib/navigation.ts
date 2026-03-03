export type NavItem = {
  name: string;
  href: string;
  adminOnly?: boolean;
  billingCalendarOnly?: boolean;
  /** Only visible if user has this tool enabled */
  requiresTool?: string;
  /** ID for badge rendering */
  badgeId?: string;
};

export const navItems: NavItem[] = [
  { name: 'Проекты', href: '/' },
  { name: 'Аналитика проектов', href: '/analytics/projects' },
  { name: 'Задачи', href: '/tasks' },
  { name: 'Команда', href: '/team' },
  { name: 'Финансы', href: '/finance' },
  { name: 'Instantly', href: '/instantly', requiresTool: 'instantly' },
  { name: 'Инструменты', href: '/tools' },
  { name: 'Проверка баз', href: '/tools/databases/review', requiresTool: 'database-review', badgeId: 'review-count' },
  { name: 'Оплаты', href: '/payments' },
  { name: 'Календарь почт', href: '/billing-calendar', billingCalendarOnly: true },
  { name: 'Регламент', href: '/reglament' },
  { name: 'Админ', href: '/admin', adminOnly: true },
  { name: 'Профиль', href: '/profile' },
];
