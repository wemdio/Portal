'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import {
  Database,
  Sparkles,
  Mail,
  Search,
  PhoneCall,
  AudioLines,
  FileText,
  ClipboardCheck,
  Send,
  Waves,
  Video,
  MessageSquareMore,
  Briefcase,
  Building2,
  Users,
  Bot,
  BookOpen,
  ShieldAlert,
  type LucideIcon,
} from 'lucide-react';
import { supabase } from '@/lib/supabaseClient';
import { ALL_TOOL_IDS, TOOLS_CONFIG, TOOL_GROUPS, type ToolId } from '@/lib/toolsRegistry';
import { RdpToolCard } from './RdpToolCard';
import { usePortalBlockingLoad } from '@/components/PortalLoadingProvider';
import { useUser } from '@/lib/UserProvider';

const TOOL_ICONS: Record<ToolId, LucideIcon> = {
  'done-for-you': Sparkles,
  'ai-caller': PhoneCall,
  'ai-caller-v2': AudioLines,
  databases: Database,
  'database-review': ClipboardCheck,
  parsers: Search,
  'email-sequence': Mail,
  'auto-report': FileText,
  'audio-transcribe': Waves,
  'tg-transcribe': Video,
  'cis-lead-finder': Building2,
  'li-outreach': Users,
  rdp: FileText,
  instantly: Send,
  'tg-outreach': MessageSquareMore,
  'habr-career': Briefcase,
  'tg-parser': Users,
  'sales-copilot': Bot,
  'knowledge-base': BookOpen,
  'bugor-outreach': Sparkles,
  'nash-outreach': Building2,
  'reputation-finder': ShieldAlert,
};

function ToolLinkCard({ toolId, locale }: { toolId: ToolId; locale: 'ru' | 'en' }) {
  const config = TOOLS_CONFIG[toolId];
  const Icon = TOOL_ICONS[toolId];
  const hasBadge = Boolean(config.badge);
  const title = locale === 'en' ? (config.title_en ?? config.title) : config.title;
  const description = locale === 'en' ? (config.description_en ?? config.description) : config.description;
  const badge = locale === 'en' ? (config.badge_en ?? config.badge) : config.badge;

  if (config.disabled) {
    const badgeClass = config.badgeVariant === 'emerald'
      ? 'bg-emerald-100 text-emerald-700'
      : 'bg-amber-100 text-amber-700';
    return (
      <div className="rounded-2xl p-10 min-w-0 flex flex-col h-full border border-gray-200 bg-gray-50 opacity-60 cursor-not-allowed select-none">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <p className="text-base font-semibold text-gray-400">{title}</p>
              {config.badge && (
                <span
                  className={`px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded ${badgeClass}`}
                >
                  {badge}
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

  const borderClass = hasBadge
    ? 'border border-gray-200 bg-gray-50 hover:border-blue-300 hover:bg-blue-50/60'
    : 'border border-gray-200 bg-white';
  const badgeClass = config.badgeVariant === 'emerald'
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
            {config.badge && (
              <span
                className={`px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded ${badgeClass}`}
              >
                {badge}
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
  const { locale } = useUser();
  const [toolIds, setToolIds] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(true);

  usePortalBlockingLoad(loading);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const token = session?.access_token ?? null;
        if (!token) {
          if (!cancelled) setToolIds([]);
          return;
        }
        const res = await fetch('/api/user/tools', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { toolIds?: string[] };
        if (!cancelled) setToolIds(Array.isArray(data.toolIds) ? data.toolIds : [...ALL_TOOL_IDS]);
      } catch {
        if (!cancelled) setToolIds([...ALL_TOOL_IDS]);
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

  return (
    <div className="space-y-6 text-left max-w-full">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">{locale === 'en' ? 'Tools' : 'Инструменты'}</h1>
        <p className="text-sm text-gray-500">
          {locale === 'en'
            ? 'A set of utilities for data and process workflows.'
            : 'Набор утилит для работы с данными и процессами.'}
        </p>
      </div>

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
                {group.toolIds.map((toolId) =>
                  toolId === 'rdp' ? (
                    <div key="rdp" className="min-w-0 flex flex-col h-full">
                      <RdpToolCard />
                    </div>
                  ) : (
                    <ToolLinkCard key={toolId} toolId={toolId} locale={locale} />
                  )
                )}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
