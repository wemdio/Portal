/**
 * Client portal navigation IA.
 *
 * Designed during Phase 0 of the May 2026 UX redesign. Three pedagogical
 * groups guide a complete novice through the outreach workflow:
 *
 *   🚀 Старт       — what you do once or before each campaign
 *   📊 Мониторинг  — what you check while a campaign runs
 *   📁 Архив       — read-only background data populated by the team
 *
 * URLs are intentionally preserved from the legacy top-nav layout so client
 * bookmarks keep working. Labels and grouping change; hrefs do not.
 *
 * The Dashboard hub (/client/dashboard) is added in Phase 3 as a separate
 * top-level item OUTSIDE the groups (it's the welcome surface, not a step).
 *
 * The single source of truth for the IA contract — see clientNav.test.ts.
 */

export type ClientNavGroupId = 'start' | 'monitoring' | 'archive';

export interface ClientNavItem {
  /** Stable id for tests, telemetry, active-link logic. Never reused. */
  id: string;
  label: string;
  labelEn: string;
  href: string;
  /**
   * If true, the sidebar renders this item with accent styling (Send-icon pill)
   * to surface it as the workflow's primary call-to-action. Exactly one item
   * across the IA may carry this flag.
   */
  primaryCta?: boolean;
  /**
   * Optional tooltip / a11y description shown on hover. Used for items that
   * are conceptually overloaded (e.g. «Цепочки писем» = AI letter generator,
   * not the campaign sequence inside Создать кампанию).
   */
  description?: string;
  descriptionEn?: string;
}

export interface ClientNavGroup {
  id: ClientNavGroupId;
  label: string;
  labelEn: string;
  items: readonly ClientNavItem[];
}

/**
 * Top-level dashboard hub, kept outside any group because it isn't a step in
 * the workflow — it's the welcome surface that summarises everything.
 */
export const CLIENT_NAV_DASHBOARD: ClientNavItem = {
  id: 'dashboard',
  label: 'Дашборд',
  labelEn: 'Dashboard',
  href: '/client/dashboard',
};

/**
 * Always-available "talk to us" surface, rendered separately at the bottom
 * of the sidebar (below the workflow groups). It replaces the legacy
 * mailto:hello@polza.com fallback that lived inside the empty states of
 * /client/projects and /client/launch — the chat now lives in-portal.
 */
export const CLIENT_NAV_SUPPORT: ClientNavItem = {
  id: 'support',
  label: 'Поддержка',
  labelEn: 'Support',
  href: '/client/support',
  description: 'Чат с менеджером — отвечаем в рабочее время',
  descriptionEn: 'Chat with your manager — we reply during business hours',
};

const startGroup: ClientNavGroup = {
  id: 'start',
  label: 'Старт',
  labelEn: 'Start here',
  items: [
    {
      id: 'brief',
      label: 'Бриф',
      labelEn: 'Brief',
      href: '/client/brief',
      description: 'Опишите ЦА и продукт — наш AI использует это во всех инструментах',
      descriptionEn: 'Describe ICP and product — our AI uses this across tools',
    },
    {
      id: 'build',
      label: 'Базы',
      labelEn: 'Databases',
      href: '/client/build',
      description: 'Соберите контакты из источников и подготовьте к рассылке',
      descriptionEn: 'Collect contacts from sources and prepare for outreach',
    },
    {
      id: 'parsers',
      label: 'Инструменты парсинга',
      labelEn: 'Parsing tools',
      href: '/client/parsers',
      description: 'Парсеры HH, Google, Яндекс.Карт и генерация цепочек',
      descriptionEn: 'HH, Google, Yandex Maps parsers and chain generation',
    },
    {
      id: 'launch',
      label: 'Создать кампанию',
      labelEn: 'Create campaign',
      href: '/client/launch',
      primaryCta: true,
      description: 'Загрузить базу, написать цепочку и запустить',
      descriptionEn: 'Upload, sequence, and launch',
    },
  ],
};

const monitoringGroup: ClientNavGroup = {
  id: 'monitoring',
  label: 'Мониторинг',
  labelEn: 'Monitoring',
  items: [
    {
      id: 'campaigns',
      label: 'Кампании',
      labelEn: 'Campaigns',
      href: '/client',
      description: 'Запущенные кампании и их метрики',
      descriptionEn: 'Running campaigns and their metrics',
    },
    {
      id: 'replies',
      label: 'Ответы',
      labelEn: 'Replies',
      href: '/client/replies',
      description: 'Ответы получателей по кампаниям',
      descriptionEn: 'Recipient replies across campaigns',
    },
    {
      id: 'leads',
      label: 'Лиды',
      labelEn: 'Leads',
      href: '/client/leads',
      description: 'Диалоги, помеченные клиентом как лиды',
      descriptionEn: 'Conversations marked as leads',
    },
    {
      id: 'reports',
      label: 'Отчёты',
      labelEn: 'Reports',
      href: '/client/reports',
      description: 'Сводный отчёт по выбранным кампаниям',
      descriptionEn: 'Aggregated report across selected campaigns',
    },
    {
      id: 'tariff',
      label: 'Тариф',
      labelEn: 'Plan',
      href: '/client/tariff',
      description: 'Текущий тариф и остатки по лимитам',
      descriptionEn: 'Current plan and remaining limits',
    },
  ],
};

const archiveGroup: ClientNavGroup = {
  id: 'archive',
  label: 'Архив',
  labelEn: 'Archive',
  items: [
    {
      id: 'bases',
      label: 'Базы в кампаниях',
      labelEn: 'Campaign databases',
      href: '/client/bases',
      description: 'Контакты внутри запущенных кампаний (read-only)',
      descriptionEn: 'Contacts inside running campaigns (read-only)',
    },
    {
      id: 'projects',
      label: 'Проекты',
      labelEn: 'Projects',
      href: '/client/projects',
      description: 'Статусы и задачи проектов от агентства',
      descriptionEn: 'Project status and tasks from the agency team',
    },
  ],
};

export const CLIENT_NAV_GROUPS: readonly ClientNavGroup[] = [
  startGroup,
  monitoringGroup,
  archiveGroup,
];

/**
 * Client portal can run in two modes:
 *   - 'manual' (default): клиент сам собирает базы, пишет цепочки, запускает.
 *     Видит весь набор групп Старт / Мониторинг / Архив.
 *   - 'auto':  HH-парсинг → endpoint клиента → Instantly идут автоматически
 *     по cron'у (см. /api/cron/auto-hh-pipeline). Клиенту в портале остаются
 *     только «смотрелки» — ответы, лиды, отчёты, дашборд со сводкой.
 *
 * Решение «какой режим у клиента» принимается по profiles.auto_pipeline_enabled
 * и проверке client_auto_pipeline_configs.enabled. Loader сидит в
 * /client/layout.tsx и пробрасывает mode вниз через пропс.
 */
export type ClientNavMode = 'manual' | 'auto';

/**
 * Id'шники nav-айтемов, которые остаются видимыми в auto-режиме. Всё, чего
 * нет в этом списке, скрывается из сайдбара авто-клиента. Группы целиком
 * становятся скрытыми, если в них не осталось видимых элементов (см.
 * filterClientNavForMode).
 *
 * Solely-в-портале (вне групп) — Dashboard и Support — всегда видны, их
 * отфильтровывать незачем.
 */
const AUTO_MODE_VISIBLE_ITEM_IDS: ReadonlySet<string> = new Set([
  'replies',
  'leads',
  'reports',
]);

/**
 * Auto-mode-only nav item. Не входит ни в один из CLIENT_NAV_GROUPS — это
 * top-level элемент (как Dashboard и Support), но видим только клиенту в
 * auto-режиме. ClientNavList рендерит его сразу после Dashboard'а, когда
 * mode === 'auto'.
 *
 * Сделано отдельной константой (а не флагом внутри monitoringGroup), чтобы
 * не ломать существующий contract-тест monitoring-группы и сохранить
 * чистоту manual-режима — в нём этот пункт просто не существует.
 */
export const CLIENT_NAV_AUTO_PIPELINE_SETUP: ClientNavItem = {
  id: 'auto-pipeline-setup',
  label: 'Настройка цепочек',
  labelEn: 'Sequence setup',
  href: '/client/auto-pipeline/setup',
  description: 'Цепочки под каждый score, который возвращает endpoint',
  descriptionEn: 'Sequence per score returned by the endpoint',
};

/**
 * Ручная batch-обработка доменов — клиент загружает список, получает 4 CSV
 * по bucket'ам score. Видим только в auto-режиме, как и setup выше.
 */
export const CLIENT_NAV_MANUAL_SCORING: ClientNavItem = {
  id: 'manual-scoring',
  label: 'Ручная обработка',
  labelEn: 'Manual scoring',
  href: '/client/manual-scoring',
  description: 'Загрузить CSV с доменами, получить 4 файла по bucket\'ам score',
  descriptionEn: 'Upload domain CSV, get 4 files split by score buckets',
};

/**
 * Возвращает группы, отфильтрованные под текущий mode. В 'manual' — без
 * изменений; в 'auto' — оставляем только items из AUTO_MODE_VISIBLE_ITEM_IDS
 * и группы, в которых что-то осталось.
 */
export function filterClientNavGroupsForMode(
  groups: readonly ClientNavGroup[],
  mode: ClientNavMode,
): readonly ClientNavGroup[] {
  if (mode === 'manual') return groups;
  return groups
    .map((g) => ({
      ...g,
      items: g.items.filter((it) => AUTO_MODE_VISIBLE_ITEM_IDS.has(it.id)),
    }))
    .filter((g) => g.items.length > 0);
}

/**
 * Phase 4 consolidation: the «Базы» hub at /client/build shows three legacy
 * tools as cards (companies-search, parsers, base-constructor). When a user
 * is on any of those legacy URLs the sidebar should still highlight «Базы»
 * because that's the hub they came from.
 */
const BUILD_LEGACY_PREFIXES: readonly string[] = [
  '/client/build',
  '/client/companies-search',
  '/client/base-constructor',
];

/**
 * Active-link helper — handles legacy aliases and the special-case where
 * `/client` (Кампании) overlaps with `/client/campaigns/[id]` detail pages.
 *
 * Returns the id of the nav item that should be highlighted for a given
 * pathname, or null when the user is on a route that doesn't appear in the
 * sidebar (e.g. a deeply-nested admin redirect).
 */
export function resolveActiveNavId(pathname: string): string | null {
  if (pathname === '/client/dashboard' || pathname.startsWith('/client/dashboard/')) {
    return 'dashboard';
  }
  if (pathname === '/client/parsers' || pathname.startsWith('/client/parsers/')) {
    return 'parsers';
  }
  if (
    pathname === '/client/auto-pipeline/setup' ||
    pathname.startsWith('/client/auto-pipeline/setup/')
  ) {
    return 'auto-pipeline-setup';
  }
  if (
    pathname === '/client/manual-scoring' ||
    pathname.startsWith('/client/manual-scoring/')
  ) {
    return 'manual-scoring';
  }
  // Кампании — both the list (/client) and the detail page (/client/campaigns/:id).
  if (pathname === '/client' || pathname.startsWith('/client/campaigns')) {
    return 'campaigns';
  }
  if (pathname === CLIENT_NAV_SUPPORT.href || pathname.startsWith(`${CLIENT_NAV_SUPPORT.href}/`)) {
    return CLIENT_NAV_SUPPORT.id;
  }
  // «Базы» hub absorbs the legacy URLs (companies-search, parsers, base-constructor).
  for (const prefix of BUILD_LEGACY_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      return 'build';
    }
  }
  // Walk groups in declaration order, picking the longest prefix match.
  let bestId: string | null = null;
  let bestLen = 0;
  for (const g of CLIENT_NAV_GROUPS) {
    for (const item of g.items) {
      // Strip query string from item href before matching against pathname.
      const itemPath = item.href.split('?')[0];
      if (itemPath === '/client') continue; // already handled above
      if (pathname === itemPath || pathname.startsWith(`${itemPath}/`)) {
        if (itemPath.length > bestLen) {
          bestId = item.id;
          bestLen = itemPath.length;
        }
      }
    }
  }
  return bestId;
}
