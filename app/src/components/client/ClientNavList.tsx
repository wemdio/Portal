'use client';

import Link from 'next/link';
import type { Route } from 'next';
import {
  CLIENT_NAV_AUTO_PIPELINE_SETUP,
  CLIENT_NAV_MANUAL_SCORING,
  CLIENT_NAV_MAILBOXES,
  CLIENT_NAV_DASHBOARD,
  CLIENT_NAV_GROUPS,
  CLIENT_NAV_OFFER,
  CLIENT_NAV_SETTINGS,
  CLIENT_NAV_SUPPORT,
  filterClientNavGroupsForMode,
  type ClientNavItem,
  type ClientNavMode,
} from '@/lib/clientNav';
import { useClientPortalContext } from '@/lib/clientPortalContext';
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
  badge = 0,
}: {
  item: ClientNavItem;
  active: boolean;
  locale: Locale;
  onItemClick?: () => void;
  /**
   * Unread-count pill shown after the label (currently only «Поддержка»). 0
   * hides it entirely; >9 collapses to «9+» so it never widens the nav row.
   */
  badge?: number;
}) {
  const label = pickLabel(item, locale);
  const description = pickDescription(item, locale);

  return (
    <Link
      href={item.href as Route}
      // The client sidebar contains links to almost every portal route. Next's
      // production default prefetch eagerly requested an RSC payload for each
      // one, so a single page reload produced a burst of 30+ authenticated
      // requests (the list also exists in the mobile drawer). Navigation is
      // still client-side; only the unsolicited background prefetch is off.
      prefetch={false}
      onClick={onItemClick}
      title={description}
      className={`ds-nav-item flex items-center px-3 py-2 text-sm whitespace-nowrap ${active ? 'active' : ''}`}
      aria-current={active ? 'page' : undefined}
    >
      <span className="truncate">{label}</span>
      {badge > 0 && (
        <span
          className="ml-auto inline-flex min-w-[1.125rem] items-center justify-center rounded-full px-1.5 py-0.5 text-[10px] font-bold leading-none"
          style={{ background: 'var(--cp-red)', color: '#fff' }}
          aria-label={locale === 'en' ? `${badge} new messages` : `${badge} новых сообщений`}
        >
          {badge > 9 ? '9+' : badge}
        </span>
      )}
    </Link>
  );
}

export function ClientNavList({ activeId, locale, mode = 'manual', onItemClick }: ClientNavListProps) {
  const groups = filterClientNavGroupsForMode(CLIENT_NAV_GROUPS, mode);

  // Бейдж непрочитанных сообщений поддержки и флаг BYO-почт приходят из layout
  // через ClientPortalProvider: layout поллит /support/unread ОДНИМ таймером и
  // грузит /mailboxes/enabled один раз, вместо дублирования в каждом из двух
  // инстансов навигации (десктоп-сайдбар + мобильный drawer). Оптимистичное
  // обнуление счётчика при открытии «Поддержки» тоже живёт в layout.
  const { supportUnread, mailboxesEnabled } = useClientPortalContext();

  // Пока клиент находится на странице поддержки, бейдж не показываем вовсе:
  // он по определению читает тред (а новые ответы видны прямо в нём).
  const supportBadge = activeId === CLIENT_NAV_SUPPORT.id ? 0 : supportUnread;

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

      {/* BYO-почты (пилот): виден только пользователям из allowlist'а BYO_MAILBOX_PILOT_USER_IDS. */}
      {mailboxesEnabled && (
        <NavItemRow
          item={CLIENT_NAV_MAILBOXES}
          active={activeId === CLIENT_NAV_MAILBOXES.id}
          locale={locale}
          onItemClick={onItemClick}
        />
      )}

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

      {/* Auto-mode-only: ручная batch-обработка доменов через Mailganer.
          Клиент загружает CSV → получает 4 файла по bucket'ам score. */}
      {mode === 'auto' && (
        <NavItemRow
          item={CLIENT_NAV_MANUAL_SCORING}
          active={activeId === CLIENT_NAV_MANUAL_SCORING.id}
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

      {/* Bottom block: Поддержка + Договор оферты. flex-col gap matches the
          group-items wrapper above — without it the two NavItemRow <a>s
          render side-by-side because <a> is inline by default. */}
      <div
        className="mt-5 pt-4 border-t flex flex-col gap-0.5"
        style={{ borderColor: 'var(--cp-divider)' }}
      >
        <NavItemRow
          item={CLIENT_NAV_SUPPORT}
          active={activeId === CLIENT_NAV_SUPPORT.id}
          locale={locale}
          onItemClick={onItemClick}
          badge={supportBadge}
        />
        {/* Настройки аккаунта — смена пароля. Live между Support и Offer:
            Support = коммуникация, Settings = свой аккаунт, Offer = правовая. */}
        <NavItemRow
          item={CLIENT_NAV_SETTINGS}
          active={activeId === CLIENT_NAV_SETTINGS.id}
          locale={locale}
          onItemClick={onItemClick}
        />
        {/* Договор оферты — in-portal version at /client/offer (wrapped by
            the client layout's top bar + sidebar). The standalone /offer
            page is reserved for the /login footer flow. */}
        <NavItemRow
          item={CLIENT_NAV_OFFER}
          active={activeId === CLIENT_NAV_OFFER.id}
          locale={locale}
          onItemClick={onItemClick}
        />
      </div>
    </nav>
  );
}
