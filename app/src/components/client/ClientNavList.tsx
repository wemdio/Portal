'use client';

import Link from 'next/link';
import type { Route } from 'next';
import {
  CLIENT_NAV_DASHBOARD,
  CLIENT_NAV_GROUPS,
  CLIENT_NAV_SUPPORT,
  type ClientNavItem,
} from '@/lib/clientNav';
import type { Locale } from '@/lib/i18n';

export interface ClientNavListProps {
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

  return (
    <Link
      href={item.href as Route}
      onClick={onItemClick}
      title={description}
      className={`ds-nav-item flex items-center px-3 py-2 text-sm whitespace-nowrap ${active ? 'active' : ''}`}
      aria-current={active ? 'page' : undefined}
    >
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

      {CLIENT_NAV_GROUPS.map((group, idx) => {
        const groupLabel = locale === 'en' ? group.labelEn : group.label;
        const groupNumber = String(idx + 1).padStart(2, '0');
        return (
          <div key={group.id} className="mt-5 first-of-type:mt-6">
            <h2 className="ds-eyebrow px-3 mb-2">
              {groupNumber}
              <span aria-hidden> → </span>
              {groupLabel}
            </h2>
            <div className="flex flex-col gap-0.5">
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
        );
      })}

      <div className="mt-6 pt-4 border-t" style={{ borderColor: 'var(--cp-divider)' }}>
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
