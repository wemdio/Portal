'use client';

import { useEffect, useState } from 'react';

/**
 * Нижняя граница шапки портала в окне — верх боковой колонки значков.
 *
 * Раньше мерили один раз при монтировании и на scroll окна. Но прокручивается
 * не окно, а область контента, а шапка после монтирования ещё меняет высоту
 * (шрифты, вкладки меню): колонка зависала с зазором под шапкой. Теперь
 * следим за размером самой шапки.
 */
export function useHeaderBottom(fallback = 45): number {
  const [bottom, setBottom] = useState(fallback);
  useEffect(() => {
    // Шапка десктопа — та, что видна: у мобильной display:none и высота 0.
    const find = () =>
      Array.from(document.querySelectorAll('header')).find((h) => h.getBoundingClientRect().height > 0) ?? null;
    const measure = () => {
      const header = find();
      setBottom(header ? Math.max(0, Math.round(header.getBoundingClientRect().bottom)) : fallback);
    };
    measure();
    const header = find();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    if (header) observer?.observe(header);
    window.addEventListener('resize', measure);
    window.addEventListener('load', measure);
    // Шрифты и первая отрисовка меню заканчиваются уже после монтирования.
    const timers = [100, 500, 1500].map((ms) => window.setTimeout(measure, ms));
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('load', measure);
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, [fallback]);
  return bottom;
}
