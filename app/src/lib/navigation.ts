export type NavItem = {
  name: string;
  href: string;
  adminOnly?: boolean;
};

export const navItems: NavItem[] = [
  { name: 'Проекты', href: '/' },
  { name: 'Аналитика проектов', href: '/analytics/projects' },
  { name: 'Задачи', href: '/tasks' },
  { name: 'Команда', href: '/team' },
  { name: 'Финансы', href: '/finance' },
  { name: 'Инструменты', href: '/tools' },
  { name: 'Оплаты', href: '/payments' },
  { name: 'Регламент', href: '/reglament' },
  { name: 'Админ', href: '/admin', adminOnly: true },
  { name: 'Настройки', href: '/settings' },
];
