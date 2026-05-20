'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useUser } from '@/lib/UserProvider';
import {
  LOCALES,
  LOCALE_DESCRIPTORS,
  commonDictionary,
  dict,
  type Locale,
} from '@/lib/i18n';

type LanguageToggleProps = {
  compact?: boolean;
  className?: string;
};

/**
 * Language switcher dropdown. Replaces the previous RU/EN two-button toggle so
 * the portal can offer the full set of supported locales (ru, en, de, fr, es, it)
 * without horizontal sprawl. The trigger shows just the flag + 2-letter code
 * to stay compact in the top nav; the panel lists the native names for clarity
 * since not every user reads English.
 *
 * Behavior:
 *   - Click outside or press Escape closes the panel.
 *   - Selecting the active locale just closes the panel (no API call).
 *   - The actual locale change goes through useUser().setLocale, which
 *     persists to /api/user/locale and updates the cookie. Translation
 *     fetching is handled separately by GlobalTextTranslator on the locale
 *     prop change.
 */
export function LanguageToggle({ compact = false, className = '' }: LanguageToggleProps) {
  const { locale, setLocale, localeSaving } = useUser();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const title = useMemo(() => dict(commonDictionary.language, locale), [locale]);
  const current = LOCALE_DESCRIPTORS[locale];

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (rootRef.current.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const triggerClass = compact
    ? 'inline-flex h-8 items-center gap-1 rounded-full border border-zinc-200 bg-white px-2 text-[11px] font-semibold text-zinc-700 hover:bg-zinc-50'
    : 'inline-flex h-8 items-center gap-1.5 rounded-full border border-zinc-200 bg-white px-2.5 text-xs font-semibold text-zinc-700 hover:bg-zinc-50';

  const handleSelect = (next: Locale) => {
    setOpen(false);
    if (next === locale) return;
    void setLocale(next);
  };

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={localeSaving}
        className={triggerClass}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={title}
      >
        <span aria-hidden>{current.flag}</span>
        <span>{current.code}</span>
        <ChevronDown className="h-3.5 w-3.5 text-zinc-400" />
      </button>

      {open && (
        <div
          data-i18n-skip
          role="listbox"
          aria-label={title}
          className="absolute right-0 top-full z-50 mt-1 w-44 overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-lg"
        >
          {LOCALES.map((code) => {
            const desc = LOCALE_DESCRIPTORS[code];
            const isActive = code === locale;
            return (
              <button
                key={code}
                type="button"
                role="option"
                aria-selected={isActive}
                onClick={() => handleSelect(code)}
                disabled={localeSaving}
                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors ${
                  isActive ? 'bg-zinc-900 text-white' : 'text-zinc-700 hover:bg-zinc-50'
                }`}
              >
                <span aria-hidden className="text-base leading-none">{desc.flag}</span>
                <span className={`font-semibold ${isActive ? 'text-white' : 'text-zinc-700'}`}>
                  {desc.code}
                </span>
                <span className={`ml-auto text-[11px] ${isActive ? 'text-white/80' : 'text-zinc-500'}`}>
                  {desc.nativeName}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
