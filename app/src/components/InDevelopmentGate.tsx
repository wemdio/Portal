'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { authFetch } from '@/lib/authFetch';
import { isAdmin } from '@/lib/roles';
import { TOOLS_CONFIG, type ToolId } from '@/lib/toolsRegistry';
import type { ToolStatus } from '@/lib/toolStatus';
import { useUser } from '@/lib/UserProvider';

/**
 * Гейт страниц инструментов «В разработке» (config.disabled в реестре или
 * глобальный статус in_development): админ заходит и смотрит, что строится;
 * все остальные получают заглушку — в том числе при прямом заходе по URL,
 * потому что карточка на /tools для них серая и некликабельна.
 *
 * Контент не рендерится, пока не известны роль и глобальный статус: иначе
 * не-админ увидел бы страницу на мгновение до появления заглушки.
 */
export function InDevelopmentGate({ toolId, children }: { toolId: ToolId; children: ReactNode }) {
  const { userRole, locale } = useUser();
  // undefined — статус ещё грузим; null — глобального override-а нет, решает реестр.
  const [override, setOverride] = useState<ToolStatus | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    authFetch('/api/user/tools')
      .then(async (res) => {
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { statuses?: Record<string, ToolStatus> };
        setOverride(data.statuses?.[toolId] ?? null);
      })
      .catch(() => {
        if (!cancelled) setOverride(null);
      });
    return () => {
      cancelled = true;
    };
  }, [toolId]);

  if (userRole === null || override === undefined) return null;

  const inDevelopment = override !== null
    ? override === 'in_development'
    : Boolean(TOOLS_CONFIG[toolId]?.disabled);

  if (inDevelopment && !isAdmin(userRole)) {
    const config = TOOLS_CONFIG[toolId];
    const title = locale === 'en' ? (config.title_en ?? config.title) : config.title;
    return (
      <div className="flex h-[60vh] flex-col items-center justify-center gap-3 px-6 text-center">
        <span className="rounded bg-amber-100 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider text-amber-700">
          {locale === 'en' ? 'In development' : 'В разработке'}
        </span>
        <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
        <p className="max-w-md text-sm text-gray-500">
          {locale === 'en'
            ? 'This tool is still being built. It will open for everyone once it is ready.'
            : 'Инструмент ещё делается — как будет готов, откроется для всех.'}
        </p>
        <a href="/tools" className="mt-2 text-sm font-medium text-blue-600 hover:text-blue-700">
          {locale === 'en' ? '← All tools' : '← Все инструменты'}
        </a>
      </div>
    );
  }

  return <>{children}</>;
}
