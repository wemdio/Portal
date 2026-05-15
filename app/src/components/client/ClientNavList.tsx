'use client';

/**
 * Renders the client portal navigation tree (Dashboard + 3 grouped sections).
 *
 * Shared between desktop Sidebar and mobile Drawer to keep label/order/styling
 * consistent. The CTA item (Создать кампанию) is rendered as a filled pill
 * with the Send icon so a novice never has to look for "where to launch".
 *
 * The component is intentionally dumb: it doesn't know about open/close state,
 * which keeps the mobile drawer logic out of here. Parent passes onItemClick
 * to do whatever post-navigation cleanup is needed (e.g. closing the drawer).
 */

import Link from 'next/link';
import type { Route } from 'next';
import {
  LayoutDashboard,
  FileText,
  Database,
  Wrench,
  Rocket,
  BarChart3,
  Users,
  FileBarChart2,
  Zap,
  Archive,
  FolderKanban,
  HeadphonesIcon,
} from 'lucide-react';
import {
  CLIENT_NAV_DASHBOARD,
  CLIENT_NAV_GROUPS,
  CLIENT_NAV_SUPPORT,
  type ClientNavItem,
} from '@/lib/clientNav';
import type { Locale } from '@/lib/i18n';

const NAV_ICONS: Record<string, { icon: React.ElementType; color: string; bg: string }> = {
  dashboard:  { icon: LayoutDashboard, color: '#6366F1', bg: 'rgba(99,102,241,0.12)' },
  brief:      { icon: FileText,        color: '#F59E0B', bg: 'rgba(245,158,11,0.12)' },
  build:      { icon: Database,        color: '#3B82F6', bg: 'rgba(59,130,246,0.12)' },
  parsers:    { icon: Wrench,          color: '#8B5CF6', bg: 'rgba(139,92,246,0.12)' },
  launch:     { icon: Rocket,          color: '#10B981', bg: 'rgba(16,185,129,0.12)' },
  campaigns:  { icon: BarChart3,       color: '#4A6FA5', bg: 'rgba(74,111,165,0.12)' },
  replies:    { icon: Users,           color: '#10B981', bg: 'rgba(16,185,129,0.12)' },
  reports:    { icon: FileBarChart2,   color: '#8B5CF6', bg: 'rgba(139,92,246,0.12)' },
  tariff:     { icon: Zap,             color: '#F59E0B', bg: 'rgba(245,158,11,0.12)' },
  bases:      { icon: Archive,         color: '#6B7280', bg: 'rgba(107,114,128,0.12)' },
  projects:   { icon: FolderKanban,    color: '#6B7280', bg: 'rgba(107,114,128,0.12)' },
  support:    { icon: HeadphonesIcon,  color: '#4A6FA5', bg: 'rgba(74,111,165,0.12)' },
};

export interface ClientNavListProps {
  /** Stable id of the currently active item, or null. See resolveActiveNavId. */
  activeId: string | null;
  locale: Locale;
  onItemClick?: () => void;
}

function pickLabel(item: ClientNavItem, locale: Locale): string {
  return locale === 'en' ? item.labelEn : item.label;
}

function pickDescription(item: ClientNavItem, locale: Locale): string | undefined {
  return locale === 'en' ? item.descriptionEn : item.description;
}

function NavItemRow({
  item,
  active,
  locale,
  onItemClick,
}: {
  item: ClientNavItem;
  active: boolean;
  locale: Locale;
  onItemClick?: () => void;
}) {
  const label = pickLabel(item, locale);
  const description = pickDescription(item, locale);
  const meta = NAV_ICONS[item.id];

  return (
    <Link
      href={item.href as Route}
      onClick={onItemClick}
      title={description}
      className={`neu-pill flex items-center gap-2.5 px-3.5 py-2 text-sm font-semibold whitespace-nowrap ${active ? 'active' : ''}`}
      style={!active ? { color: 'var(--cp-text-m)' } : undefined}
      aria-current={active ? 'page' : undefined}
    >
      {meta && (
        <span
          className="inline-flex items-center justify-center w-7 h-7 rounded-lg shrink-0"
          style={{ background: meta.bg, color: meta.color }}
        >
          <meta.icon className="h-4 w-4" />
        </span>
      )}
      <span className="truncate">{label}</span>
    </Link>
  );
}

export function ClientNavList({ activeId, locale, onItemClick }: ClientNavListProps) {
  return (
    <nav aria-label={locale === 'en' ? 'Main navigation' : 'Главное меню'} className="flex flex-col gap-1.5">
      <NavItemRow
        item={CLIENT_NAV_DASHBOARD}
        active={activeId === CLIENT_NAV_DASHBOARD.id}
        locale={locale}
        onItemClick={onItemClick}
      />

      {CLIENT_NAV_GROUPS.map((group) => (
        <div key={group.id} className="mt-3 first-of-type:mt-4">
          <h2
            className="px-3 mb-1.5 text-[10px] font-bold uppercase tracking-[0.12em]"
            style={{ color: 'var(--cp-text-l)' }}
          >
            {locale === 'en' ? group.labelEn : group.label}
          </h2>
          <div className="flex flex-col gap-1">
            {group.items.map((item) => (
              <NavItemRow
                key={item.id}
                item={item}
                active={activeId === item.id}
                locale={locale}
                onItemClick={onItemClick}
              />
            ))}
          </div>
        </div>
      ))}

      <div className="mt-4 pt-3 border-t" style={{ borderColor: 'var(--cp-divider, rgba(0,0,0,0.06))' }}>
        <NavItemRow
          item={CLIENT_NAV_SUPPORT}
          active={activeId === CLIENT_NAV_SUPPORT.id}
          locale={locale}
          onItemClick={onItemClick}
        />
      </div>
    </nav>
  );
}
