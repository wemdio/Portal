'use client';

import { useEffect, useState, type ReactNode } from 'react';

/**
 * Плавное раскрытие блока под переключателем: высота и прозрачность меняются
 * за 300 мс. Высоту анимируем через grid-template-rows (0fr → 1fr) — так не
 * нужно знать высоту содержимого. При закрытии блок остаётся в разметке до
 * конца анимации и только потом размонтируется (вместе с его запросами).
 * Для prefers-reduced-motion анимация отключена.
 */
export function Reveal({ open, children }: { open: boolean; children: ReactNode }) {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(open);

  useEffect(() => {
    if (open) {
      setMounted(true);
      // Два кадра: сначала блок рисуется свёрнутым, потом раскрывается.
      let second = 0;
      const first = requestAnimationFrame(() => {
        second = requestAnimationFrame(() => setVisible(true));
      });
      return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
    }
    setVisible(false);
    const timer = setTimeout(() => setMounted(false), 320);
    return () => clearTimeout(timer);
  }, [open]);

  if (!mounted) return null;
  return (
    <div
      className={`!mt-0 grid transition-[grid-template-rows,opacity] duration-300 ease-out motion-reduce:transition-none ${
        visible ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
      }`}
    >
      {/* Верхний отступ (16 px) лежит во вложенном слое, а не как margin родителя
          и не как padding обрезающего слоя: вертикальный padding того, кто
          обрезает, не схлопывается до нуля, и блок закрывался бы в два
          прохода (сначала до 24 px, потом скачком). Боковой запас px-1/-mx-1
          оставляет место кольцу фокуса и не сдвигает вёрстку. */}
      <div className="-mx-1 min-h-0 overflow-hidden px-1">
        <div className="pb-1 pt-4">{children}</div>
      </div>
    </div>
  );
}
