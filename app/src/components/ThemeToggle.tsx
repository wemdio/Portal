'use client';

import { useCallback, useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';

/**
 * Переключатель тёмной/светлой темы основного портала (спецы).
 *
 * - Атрибут `data-portal-theme="dark"|"light"` ставится на <html> ранним
 *   скриптом в app/layout.tsx (см. earlyPortalThemeScript), чтобы избежать
 *   мигания светлой темой при перезагрузке.
 * - Этот компонент только UI-обёртка над тем же атрибутом: на клик —
 *   меняем значение data-portal-theme и записываем выбор в localStorage.
 * - Клиентский контур (/client/*) живёт под отдельной палитрой
 *   (.client-portal в globals.css), переключателем не управляется.
 */
export function ThemeToggle() {
  // На первом рендере (SSR) точного значения не знаем — отдаём 'light'
  // как безопасный дефолт, после mount синхронизируемся с html.dataset.
  const [theme, setTheme] = useState<'light' | 'dark'>('light');

  useEffect(() => {
    const current = document.documentElement.dataset.portalTheme;
    if (current === 'dark' || current === 'light') {
      setTheme(current);
    }
  }, []);

  const toggle = useCallback(() => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.dataset.portalTheme = next;
    try {
      window.localStorage.setItem('portal_theme', next);
    } catch {
      // Игнорируем — браузер мог отказать в localStorage (приватный режим).
    }
  }, [theme]);

  const isDark = theme === 'dark';

  return (
    <button
      type="button"
      onClick={toggle}
      title={isDark ? 'Светлая тема' : 'Тёмная тема'}
      aria-label={isDark ? 'Переключить на светлую тему' : 'Переключить на тёмную тему'}
      className="inline-flex h-8 w-8 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 transition-colors"
    >
      {isDark ? <Sun className="h-4 w-4" aria-hidden /> : <Moon className="h-4 w-4" aria-hidden />}
    </button>
  );
}
