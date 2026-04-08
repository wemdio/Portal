'use client';

import { useMemo } from 'react';
import { useUser } from '@/lib/UserProvider';
import { dict } from '@/lib/i18n';
import { commonDictionary } from '@/lib/i18n';

type LanguageToggleProps = {
  compact?: boolean;
  className?: string;
};

export function LanguageToggle({ compact = false, className = '' }: LanguageToggleProps) {
  const { locale, setLocale, localeSaving } = useUser();
  const title = useMemo(() => dict(commonDictionary.language, locale), [locale]);

  const baseClass = compact
    ? 'inline-flex h-8 items-center rounded-full border border-zinc-200 bg-white p-0.5 text-[11px]'
    : 'inline-flex h-8 items-center rounded-full border border-zinc-200 bg-white p-0.5 text-xs';

  return (
    <div className={`${baseClass} ${className}`} role="group" aria-label={title} title={title}>
      <button
        type="button"
        onClick={() => void setLocale('ru')}
        disabled={localeSaving}
        className={`rounded-full px-2.5 py-1 font-semibold transition ${
          locale === 'ru' ? 'bg-zinc-900 text-white' : 'text-zinc-500 hover:text-zinc-700'
        }`}
      >
        RU
      </button>
      <button
        type="button"
        onClick={() => void setLocale('en')}
        disabled={localeSaving}
        className={`rounded-full px-2.5 py-1 font-semibold transition ${
          locale === 'en' ? 'bg-zinc-900 text-white' : 'text-zinc-500 hover:text-zinc-700'
        }`}
      >
        EN
      </button>
    </div>
  );
}
