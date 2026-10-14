'use client';

import type { ReactNode } from 'react';

/**
 * Рабочая область обеих вкладок «Нашего автоаутрича»: узкая колонка слева
 * (список запусков или разделы библиотек) и основная область справа.
 *
 * Левая колонка липнет при прокрутке, поэтому переключаться между запусками
 * можно, не возвращаясь наверх. Уже 1024 px раскладка схлопывается в одну
 * колонку: слева становится горизонтальной лентой над содержимым.
 */
export function WorkArea({ aside, children }: { aside: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:gap-5">
      <aside className="lg:sticky lg:top-4 lg:w-[280px] lg:shrink-0">{aside}</aside>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
