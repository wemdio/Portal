'use client';

import { useHeaderBottom } from '@/components/useHeaderBottom';
import type { LucideIcon } from 'lucide-react';

export interface RailItem {
  id: string;
  label: string;
  icon: LucideIcon;
}

/**
 * Разделы открытой кампании: колонка значков у левого края окна, как в
 * «Рассылке»; на узких экранах — горизонтальная строка. Горизонтальные вкладки
 * съедали полосу экрана над каждой вкладкой. Подпись — во всплывающей подсказке
 * и рядом со значком при наведении.
 */
export function CampaignRail({ items, active, onSelect }: {
  items: ReadonlyArray<RailItem>;
  active: string;
  onSelect: (id: string) => void;
}) {
  // Верх колонки — сразу под шапкой портала; высоту шапки берём со страницы.
  const railTop = useHeaderBottom();

  // z-[35]: выше карточек страницы с relative z-30 (иначе они закрывали
  // подсказку), но ниже шапки портала (z-40) с её меню и окон (z-50).
  return (
    <>
      <nav
        aria-label="Разделы кампании"
        style={{ top: railTop, height: `calc(100vh - ${railTop}px)` }}
        className="fixed left-0 z-[35] hidden w-14 flex-col items-center justify-center gap-1 border-r border-gray-200 bg-white py-3 lg:flex"
      >
        {items.map((item) => {
          const Icon = item.icon;
          const isActive = active === item.id;
          return (
            <button
              key={item.id}
              type="button"
              title={item.label}
              aria-label={item.label}
              aria-current={isActive ? 'page' : undefined}
              onClick={() => onSelect(item.id)}
              className={`group relative flex h-10 w-10 items-center justify-center rounded-lg outline-none transition-colors cursor-pointer ${
                isActive ? 'bg-indigo-600/10 text-indigo-600' : 'text-gray-500 hover:bg-gray-100 hover:text-gray-800'
              }`}
            >
              <Icon className="h-[18px] w-[18px]" />
              <span className="pointer-events-none absolute left-12 whitespace-nowrap rounded-md bg-gray-900 px-2 py-1 text-[11px] font-medium text-white opacity-0 shadow transition-opacity group-hover:opacity-100">
                {item.label}
              </span>
            </button>
          );
        })}
      </nav>

      <div className="flex gap-1 overflow-x-auto border-b border-gray-200 lg:hidden">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onSelect(item.id)}
            className={`-mb-px shrink-0 border-b-2 px-3 py-2 text-xs font-medium outline-none cursor-pointer ${
              active === item.id ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-gray-500'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>
    </>
  );
}
