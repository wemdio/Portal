'use client';

import { useCallback, useEffect, useMemo, useState, type ComponentType } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import {
  Database,
  Sparkles,
  Mail,
  MailPlus,
  Search,
  PhoneCall,
  AudioLines,
  FileText,
  FileSpreadsheet,
  ClipboardCheck,
  Send,
  Settings,
  Waves,
  Video,
  MessageSquareMore,
  Briefcase,
  Building2,
  Users,
  Bot,
  BookOpen,
  ShieldAlert,
  Blocks,
  PartyPopper,
  LayoutGrid,
  List,
} from 'lucide-react';
import { authFetch } from '@/lib/authFetch';
import { ALL_TOOL_IDS, TOOLS_CONFIG, TOOL_GROUPS, type ToolId } from '@/lib/toolsRegistry';
import { sortToolIdsByTitle } from '@/lib/toolsSort';
import { type ToolStatus } from '@/lib/toolStatus';
import { isAdmin } from '@/lib/roles';
import { RdpToolCard } from './RdpToolCard';
import { ToolVisibilityModal } from './ToolVisibilityModal';
import { usePortalBlockingLoad } from '@/components/PortalLoadingProvider';
import { useUser } from '@/lib/UserProvider';
import type { Locale } from '@/lib/i18n';

type ToolsLayoutMode = 'grouped' | 'list';
const LAYOUT_MODE_STORAGE_KEY = 'tools-layout-mode';

/**
 * Маппинг глобального статуса инструмента (из шестерёнки) в плашку.
 * Возвращает null если статус не требует плашки или его нужно скрыть.
 */
function badgeForStatus(
  status: ToolStatus | undefined,
  locale: Locale,
): { text: string; variant: 'emerald' | 'amber' } | null {
  switch (status) {
    case 'new':
      return { text: locale === 'en' ? 'New' : 'Новое', variant: 'emerald' };
    case 'beta':
      return { text: 'BETA', variant: 'amber' };
    case 'in_development':
      return { text: locale === 'en' ? 'In development' : 'В разработке', variant: 'amber' };
    default:
      return null;
  }
}

/** Логотип Telegram (lucide не содержит брендовых иконок). */
function TelegramIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z" />
    </svg>
  );
}

const TOOL_ICONS: Record<ToolId, ComponentType<{ className?: string }>> = {
  'done-for-you': Sparkles,
  'base-constructor': Blocks,
  'ai-caller': PhoneCall,
  'ai-caller-v2': AudioLines,
  databases: Database,
  'database-review': ClipboardCheck,
  parsers: Search,
  'email-sequence': Mail,
  'email-sequence-v2': MailPlus,
  'auto-report': FileText,
  'polza-reports': FileSpreadsheet,
  'audio-transcribe': Waves,
  'tg-transcribe': Video,
  'cis-lead-finder': Building2,
  'li-outreach': Users,
  'li-outreach-v2': Bot,
  rdp: FileText,
  instantly: Send,
  'tg-outreach': MessageSquareMore,
  'habr-career': Briefcase,
  'tg-parser': Users,
  'sales-copilot': Bot,
  'knowledge-base': BookOpen,
  'bugor-outreach': Sparkles,
  'nash-outreach': Building2,
  'event-outreach': PartyPopper,
  'reputation-finder': ShieldAlert,
  'our-bases': Database,
  'sales-chat-analyzer': TelegramIcon,
};

function ToolLinkCard({
  toolId,
  locale,
  effectiveStatus,
}: {
  toolId: ToolId;
  locale: Locale;
  effectiveStatus?: ToolStatus;
}) {
  const config = TOOLS_CONFIG[toolId];
  const Icon = TOOL_ICONS[toolId];
  const title = locale === 'en' ? (config.title_en ?? config.title) : config.title;
  const description = locale === 'en' ? (config.description_en ?? config.description) : config.description;

  // Глобальный статус из шестерёнки имеет приоритет над хардкодом в реестре.
  // Если статус есть и он не 'active' — рисуем плашку под него; иначе берём
  // хардкод-плашку (например, у reputation-finder зашит 'BETA' в реестре).
  const dynamicBadge = badgeForStatus(effectiveStatus, locale);
  const badgeText = dynamicBadge?.text
    ?? (locale === 'en' ? (config.badge_en ?? config.badge) : config.badge);
  const badgeVariant: 'emerald' | 'amber' | undefined =
    dynamicBadge?.variant ?? config.badgeVariant;

  // «В разработке» через шестерёнку или ручной `disabled: true` в реестре —
  // одно и то же визуально (серая некликабельная карточка).
  const isDisabled = effectiveStatus === 'in_development' || Boolean(config.disabled);

  if (isDisabled) {
    const badgeClass = badgeVariant === 'emerald'
      ? 'bg-emerald-100 text-emerald-700'
      : 'bg-amber-100 text-amber-700';
    return (
      <div className="rounded-2xl p-10 min-w-0 flex flex-col h-full border border-gray-200 bg-gray-50 opacity-60 cursor-not-allowed select-none">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <p className="text-base font-semibold text-gray-400">{title}</p>
              {badgeText && (
                <span
                  className={`px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded ${badgeClass}`}
                >
                  {badgeText}
                </span>
              )}
            </div>
            <p className="text-sm text-gray-400">{description}</p>
          </div>
          <Icon className="h-8 w-8 shrink-0 text-gray-300" />
        </div>
        <div className="mt-4 text-sm font-medium text-gray-400">{locale === 'en' ? 'Unavailable' : 'Недоступно'}</div>
      </div>
    );
  }

  const hasBadge = Boolean(badgeText);
  const borderClass = hasBadge
    ? 'border border-gray-200 bg-gray-50 hover:border-blue-300 hover:bg-blue-50/60'
    : 'border border-gray-200 bg-white';
  const badgeClass = badgeVariant === 'emerald'
    ? 'bg-emerald-100 text-emerald-700'
    : 'bg-amber-100 text-amber-700';
  const linkClass = 'text-blue-600 group-hover:text-blue-700';
  const iconClass = 'text-gray-400 group-hover:text-blue-600';

  return (
    <Link
      href={config.href as Route}
      prefetch={false}
      className={`group rounded-2xl p-10 transition hover:shadow-md min-w-0 flex flex-col h-full ${borderClass}`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className={toolId === 'auto-report' ? 'min-w-0' : undefined}>
          <div className="flex items-center gap-2">
            <p className="text-base font-semibold text-gray-900">{title}</p>
            {badgeText && (
              <span
                className={`px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded ${badgeClass}`}
              >
                {badgeText}
              </span>
            )}
          </div>
          <p className="text-sm text-gray-500">{description}</p>
        </div>
        <Icon className={`h-8 w-8 shrink-0 transition-colors ${iconClass}`} />
      </div>
      <div className={`mt-4 text-sm font-medium ${linkClass}`}>{locale === 'en' ? 'Open →' : 'Открыть →'}</div>
    </Link>
  );
}

export default function ToolsPage() {
  const { locale, userRole } = useUser();
  const [toolIds, setToolIds] = useState<string[] | null>(null);
  const [statuses, setStatuses] = useState<Record<string, ToolStatus>>({});
  const [loading, setLoading] = useState(true);
  const [visibilityModalOpen, setVisibilityModalOpen] = useState(false);

  // Per-user раскладка списка инструментов. localStorage достаточно —
  // настройка чисто UI, не критична для миграции между устройствами.
  const [layoutMode, setLayoutMode] = useState<ToolsLayoutMode>('grouped');
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = window.localStorage.getItem(LAYOUT_MODE_STORAGE_KEY);
    if (stored === 'grouped' || stored === 'list') setLayoutMode(stored);
  }, []);
  const changeLayoutMode = useCallback((mode: ToolsLayoutMode) => {
    setLayoutMode(mode);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(LAYOUT_MODE_STORAGE_KEY, mode);
    }
  }, []);

  usePortalBlockingLoad(loading);

  const reloadVisibleTools = useCallback(async () => {
    try {
      const res = await authFetch('/api/user/tools');
      if (!res.ok) return;
      const data = (await res.json()) as { toolIds?: string[]; statuses?: Record<string, ToolStatus> };
      setToolIds(Array.isArray(data.toolIds) ? data.toolIds : [...ALL_TOOL_IDS]);
      setStatuses(data.statuses ?? {});
    } catch {
      setToolIds([...ALL_TOOL_IDS]);
      setStatuses({});
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await authFetch('/api/user/tools');
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { toolIds?: string[]; statuses?: Record<string, ToolStatus> };
        if (!cancelled) {
          setToolIds(Array.isArray(data.toolIds) ? data.toolIds : [...ALL_TOOL_IDS]);
          setStatuses(data.statuses ?? {});
        }
      } catch {
        if (!cancelled) {
          setToolIds([...ALL_TOOL_IDS]);
          setStatuses({});
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const visibleSet = new Set(toolIds ?? []);

  const visibleGroups = TOOL_GROUPS
    .map((g) => ({ ...g, toolIds: g.toolIds.filter((id) => visibleSet.has(id)) }))
    .filter((g) => g.toolIds.length > 0);

  // Плоский алфавитный список (для режима «Списком»). Сортируем общим
  // хелпером — кириллица первой (А-Я), потом латиница (A-Z).
  const flatSortedToolIds = useMemo(
    () => sortToolIdsByTitle(ALL_TOOL_IDS.filter((id) => visibleSet.has(id)), locale),
    // visibleSet — новый объект на каждый render; считаем по toolIds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [toolIds, locale],
  );

  const adminViewer = isAdmin(userRole);

  /** Карточка одного тула (RDP — особый, у него своя card-компонента). */
  const renderToolCard = (toolId: string) =>
    toolId === 'rdp' ? (
      <div key="rdp" className="min-w-0 flex flex-col h-full">
        <RdpToolCard />
      </div>
    ) : (
      <ToolLinkCard
        key={toolId}
        toolId={toolId as ToolId}
        locale={locale}
        effectiveStatus={statuses[toolId]}
      />
    );

  return (
    <div className="space-y-6 text-left max-w-full">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{locale === 'en' ? 'Tools' : 'Инструменты'}</h1>
          <p className="text-sm text-gray-500">
            {locale === 'en'
              ? 'A set of utilities for data and process workflows.'
              : 'Набор утилит для работы с данными и процессами.'}
          </p>
        </div>
        <div className="mt-1 flex items-center gap-2 shrink-0">
          {/* Per-user раскладка: «По блокам» (как было раньше — группы Аутрич/
              Базы/Парсеры/Утилиты/AI) или «Списком» (плоский алфавитный список,
              кириллица первой). Хранится в localStorage. */}
          <div
            role="group"
            aria-label={locale === 'en' ? 'Layout mode' : 'Раскладка'}
            className="inline-flex h-9 items-center rounded-lg border border-gray-200 bg-white p-0.5"
          >
            <button
              type="button"
              onClick={() => changeLayoutMode('grouped')}
              title={locale === 'en' ? 'Group by category' : 'По блокам (по категориям)'}
              aria-pressed={layoutMode === 'grouped'}
              className={`inline-flex h-full items-center gap-1 rounded-md px-2.5 text-xs font-medium transition-colors ${
                layoutMode === 'grouped'
                  ? 'bg-gray-100 text-gray-900'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              <LayoutGrid className="h-3.5 w-3.5" aria-hidden />
              <span>{locale === 'en' ? 'Groups' : 'По блокам'}</span>
            </button>
            <button
              type="button"
              onClick={() => changeLayoutMode('list')}
              title={locale === 'en'
                ? 'Flat alphabetical list (Cyrillic first, then Latin)'
                : 'Списком, по алфавиту (сначала русские, затем английские)'}
              aria-pressed={layoutMode === 'list'}
              className={`inline-flex h-full items-center gap-1 rounded-md px-2.5 text-xs font-medium transition-colors ${
                layoutMode === 'list'
                  ? 'bg-gray-100 text-gray-900'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              <List className="h-3.5 w-3.5" aria-hidden />
              <span>{locale === 'en' ? 'List' : 'Списком'}</span>
            </button>
          </div>
          {adminViewer ? (
            <button
              type="button"
              onClick={() => setVisibilityModalOpen(true)}
              title={locale === 'en'
                ? 'Tool visibility (global, all users)'
                : 'Видимость инструментов (глобально, для всех)'}
              aria-label={locale === 'en'
                ? 'Tool visibility settings'
                : 'Настройки видимости инструментов'}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-500 hover:bg-gray-50 hover:text-gray-700"
            >
              <Settings className="h-4 w-4" aria-hidden />
            </button>
          ) : null}
        </div>
      </div>

      {adminViewer ? (
        <ToolVisibilityModal
          open={visibilityModalOpen}
          locale={locale}
          onClose={() => setVisibilityModalOpen(false)}
          onChanged={() => void reloadVisibleTools()}
        />
      ) : null}

      {loading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 items-stretch">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="rounded-2xl border border-gray-200 bg-gray-50 p-6 animate-pulse min-h-[140px]"
              aria-hidden
            >
              <div className="h-5 w-40 bg-gray-200 rounded mb-2" />
              <div className="h-4 w-24 bg-gray-200 rounded mb-4" />
              <div className="h-4 w-20 bg-gray-200 rounded" />
            </div>
          ))}
        </div>
      ) : visibleGroups.length === 0 ? (
        <div className="rounded-2xl border border-gray-200 bg-gray-50 p-10 text-center">
          <p className="text-gray-600">{locale === 'en' ? 'No tools are available yet.' : 'Доступных инструментов пока нет.'}</p>
          <p className="text-sm text-gray-500 mt-1">
            {locale === 'en' ? 'Please contact your administrator.' : 'Пожалуйста, обратитесь к администратору.'}
          </p>
        </div>
      ) : layoutMode === 'list' ? (
        // Плоский алфавитный список. Все видимые тулы одним грид'ом, без
        // делителей-секций. Сортировка: cyrillic → latin, А-Я / A-Z.
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 items-stretch">
          {flatSortedToolIds.map((toolId) => renderToolCard(toolId))}
        </div>
      ) : (
        <div className="space-y-6">
          {visibleGroups.map((group) => (
            <section key={group.label}>
              <div className="flex items-center gap-3 mb-4">
                <div className="h-px flex-1 bg-gray-200" />
                <h2 className="text-xs font-semibold uppercase tracking-widest text-gray-400 shrink-0">{locale === 'en' ? (group.label_en ?? group.label) : group.label}</h2>
                <div className="h-px flex-1 bg-gray-200" />
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 items-stretch">
                {group.toolIds.map((toolId) => renderToolCard(toolId))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
