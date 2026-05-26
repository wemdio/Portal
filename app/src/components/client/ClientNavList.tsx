'use client';

import Link from 'next/link';
import type { Route } from 'next';
import {
  CLIENT_NAV_AUTO_PIPELINE_SETUP,
  CLIENT_NAV_DASHBOARD,
  CLIENT_NAV_GROUPS,
  CLIENT_NAV_SUPPORT,
  filterClientNavGroupsForMode,
  type ClientNavItem,
  type ClientNavMode,
} from '@/lib/clientNav';
import type { Locale } from '@/lib/i18n';

export interface ClientNavListProps {
  activeId: string | null;
  locale: Locale;
  /**
   * Portal mode. 'auto' hides everything except Dashboard/Replies/Leads/Reports/Support.
   * Defaults to 'manual' when the parent doesn't know yet (initial render before
   * /api/user/me responds).
   */
  mode?: ClientNavMode;
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

export function ClientNavList({ activeId, locale, mode = 'manual', onItemClick }: ClientNavListProps) {
  const groups = filterClientNavGroupsForMode(CLIENT_NAV_GROUPS, mode);
  return (
    <nav aria-label={locale === 'en' ? 'Main navigation' : 'Главное меню'} className="flex flex-col gap-1.5">
      {/* «Главная» eyebrow — gives Dashboard a section anchor so it isn't an
          orphan above the numbered sections (Старт / Мониторинг / Архив).
          Intentionally unnumbered: home ≠ step in the editorial-numbering
          vocabulary; numbers belong to the linear workflow stages. */}
      <h2 className="ds-eyebrow px-3 mb-2">
        {locale === 'en' ? 'Home' : 'Главная'}
      </h2>
      <NavItemRow
        item={CLIENT_NAV_DASHBOARD}
        active={activeId === CLIENT_NAV_DASHBOARD.id}
        locale={locale}
        onItemClick={onItemClick}
      />

      {/* Auto-mode-only: настройка цепочек под скоры endpoint'а. В manual
          этого пункта не существует — manual-клиент пишет цепочки прямо
          в /client/launch при запуске кампании. */}
      {mode === 'auto' && (
        <NavItemRow
          item={CLIENT_NAV_AUTO_PIPELINE_SETUP}
          active={activeId === CLIENT_NAV_AUTO_PIPELINE_SETUP.id}
          locale={locale}
          onItemClick={onItemClick}
        />
      )}

      {groups.map((group, idx) => {
        const groupLabel = locale === 'en' ? group.labelEn : group.label;
        const groupNumber = String(idx + 1).padStart(2, '0');
        return (
          /* Tighter vertical rhythm: mt-4 between groups (was mt-5); first group
             keeps mt-5 (was mt-6) so Dashboard breathes against the workflow
             sections. Trims ~12px of dead space from a long sidebar. */
          <div key={group.id} className="mt-4 first-of-type:mt-5">
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

      <div className="mt-5 pt-4 border-t" style={{ borderColor: 'var(--cp-divider)' }}>
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
