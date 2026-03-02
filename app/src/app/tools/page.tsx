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
  type LucideIcon,
} from 'lucide-react';
import { supabase } from '@/lib/supabaseClient';
import { ALL_TOOL_IDS, TOOLS_CONFIG, type ToolId } from '@/lib/toolsRegistry';
import { RdpToolCard } from './RdpToolCard';

const TOOL_ICONS: Record<ToolId, LucideIcon> = {
  'done-for-you': Sparkles,
  'ai-caller': PhoneCall,
  'ai-caller-v2': AudioLines,
  databases: Database,
  'database-review': ClipboardCheck,
  parsers: Search,
  'email-sequence': Mail,
  'auto-report': FileText,
  rdp: FileText,
};

function ToolLinkCard({ toolId }: { toolId: ToolId }) {
  const config = TOOLS_CONFIG[toolId];
  const Icon = TOOL_ICONS[toolId];
  const isEmerald = config.accentColor === 'emerald';
  const borderClass = config.badge
    ? isEmerald
      ? 'border-2 border-emerald-200 bg-gradient-to-br from-emerald-50 to-white hover:border-emerald-300'
      : 'border-2 border-blue-200 bg-gradient-to-br from-blue-50 to-white hover:border-blue-300'
    : 'border border-gray-200 bg-white';
  const badgeClass = config.badgeVariant === 'emerald'
    ? 'bg-emerald-100 text-emerald-700'
    : 'bg-amber-100 text-amber-700';
  const linkClass = isEmerald ? 'text-emerald-600 group-hover:text-emerald-700' : 'text-blue-600 group-hover:text-blue-700';
  const iconClass = isEmerald
    ? 'text-emerald-500 group-hover:text-emerald-600'
    : 'text-gray-400 group-hover:text-blue-600';

  return (
    <Link
      href={config.href as Route}
      className={`group rounded-2xl p-10 transition hover:shadow-md min-w-0 flex flex-col h-full ${borderClass}`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className={toolId === 'auto-report' ? 'min-w-0' : undefined}>
          <div className="flex items-center gap-2">
            <p className="text-base font-semibold text-gray-900">{config.title}</p>
            {config.badge && (
              <span
                className={`px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded ${badgeClass}`}
              >
                {config.badge}
              </span>
            )}
          </div>
          <p className="text-sm text-gray-500">{config.description}</p>
        </div>
        <Icon className={`h-8 w-8 shrink-0 transition-colors ${iconClass}`} />
      </div>
      <div className={`mt-4 text-sm font-medium ${linkClass}`}>Открыть →</div>
    </Link>
  );
}

export default function ToolsPage() {
  const [toolIds, setToolIds] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(true);

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

  const visibleIds = toolIds ?? [];
  const orderedVisible = ALL_TOOL_IDS.filter((id) => visibleIds.includes(id));

  return (
    <div className="space-y-6 text-left max-w-full">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Инструменты</h1>
        <p className="text-sm text-gray-500">
          Набор утилит для работы с данными и процессами.
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
      ) : orderedVisible.length === 0 ? (
        <div className="rounded-2xl border border-gray-200 bg-gray-50 p-10 text-center">
          <p className="text-gray-600">Доступных инструментов пока нет.</p>
          <p className="text-sm text-gray-500 mt-1">
            Пожалуйста, обратитесь к администратору.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 items-stretch">
          {orderedVisible.map((toolId) =>
            toolId === 'rdp' ? (
              <div key="rdp" className="min-w-0 flex flex-col h-full">
                <RdpToolCard />
              </div>
            ) : (
              <ToolLinkCard key={toolId} toolId={toolId} />
            )
          )}
        </div>
      )}
    </div>
  );
}
