'use client';

import type { Route } from 'next';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useCallback, useState } from 'react';

import ExpensesView from '@/components/expenses/ExpensesView';
import IncomesView from '@/components/expenses/IncomesView';
import { getDefaultPeriod, type PeriodValue } from '@/components/expenses/PeriodBar';

/**
 * Раздел «Деньги»: расходы и доходы под одним переключателем.
 *
 * Режим живёт в адресе (`?tab=`), период — в стейте, и граница проведена
 * осознанно.
 *
 * Режим — не фильтр, а ответ на вопрос «на что мы вообще смотрим»: ссылка на
 * доходы обязана открываться доходами, перезагрузка не должна возвращать на
 * расходы, а «назад» — возвращать на предыдущую вкладку. Это даёт только
 * адрес, поэтому переключение идёт через `push`: это навигация.
 *
 * Период в адрес не вынесен намеренно. Поля `<input type="date">` управляемые,
 * и если их значение приходит из query-строки, то каждое изменение — это
 * навигация с запросом RSC-пейлоада; пока она не завершилась, React
 * перерисовывает поле старым значением, и набранная дата на глазах
 * отскакивает назад. Ради shareable-ссылки на конкретный месяц ломать ввод дат
 * не стоит. Требование «не терять период при переключении вкладок» держится
 * не адресом, а тем, что период поднят сюда: `MoneyView` остаётся
 * смонтированным, вкладки под ним сменяются.
 *
 * Фильтры, которых у сторон нет друг у друга (категория, источник), остаются
 * локальным стейтом своих вкладок: переносить категорию расхода на доходную
 * сторону нечем и незачем.
 */

type Mode = 'expenses' | 'incomes';

const MODES: Array<{ id: Mode; label: string }> = [
  { id: 'expenses', label: 'Расходы' },
  { id: 'incomes', label: 'Доходы' },
];

export default function MoneyView() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Незнакомое значение — расходы: вкладка по умолчанию, а не пустой экран.
  const mode: Mode = searchParams.get('tab') === 'incomes' ? 'incomes' : 'expenses';

  const [period, setPeriod] = useState<PeriodValue>(() => getDefaultPeriod());

  const hrefFor = useCallback(
    (next: Mode): Route => {
      const params = new URLSearchParams(searchParams.toString());
      // Дефолтный режим в адресе не пишем — ссылка на расходы остаётся `/expenses`.
      if (next === 'expenses') params.delete('tab');
      else params.set('tab', next);

      const qs = params.toString();
      // `as Route` — типизированные маршруты не выводят адрес, собранный из
      // `pathname` и query-строки; сам путь при этом не меняется.
      return (qs ? `${pathname}?${qs}` : pathname) as Route;
    },
    [pathname, searchParams],
  );

  return (
    <div className="space-y-4">
      {/* Переключатель стоит выше фильтров и отделён линией: он не сужает
          выборку, как они, а меняет то, на что вообще смотрим.

          Ссылки, а не кнопки: режим — это адрес, значит вкладку можно открыть
          в новом окне и скопировать ссылкой, а не только кликнуть. */}
      <div className="border-b border-zinc-200 pb-3">
        <div
          role="tablist"
          aria-label="Расходы или доходы"
          className="inline-flex items-center gap-1 rounded-full border border-zinc-200 bg-zinc-50 p-1"
        >
          {MODES.map((item) => {
            const active = mode === item.id;
            return (
              <Link
                key={item.id}
                href={hrefFor(item.id)}
                scroll={false}
                role="tab"
                id={`money-tab-${item.id}`}
                aria-selected={active}
                aria-controls="money-tabpanel"
                className={`rounded-full px-4 py-1.5 text-sm font-semibold transition ${
                  active ? 'bg-zinc-900 text-white' : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800'
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </div>
      </div>

      <div id="money-tabpanel" role="tabpanel" aria-labelledby={`money-tab-${mode}`}>
        {mode === 'incomes' ? (
          <IncomesView period={period} onPeriodChange={setPeriod} />
        ) : (
          <ExpensesView period={period} onPeriodChange={setPeriod} />
        )}
      </div>
    </div>
  );
}
