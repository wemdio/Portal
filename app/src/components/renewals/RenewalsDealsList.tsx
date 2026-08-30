'use client';

import { useMemo, useRef, useState } from 'react';
import DealModal from '@/components/analytics/DealModal';
import type { RenewalsStageDeals } from '@/lib/renewals/funnel';

/**
 * Список сделок рядом с воронкой вторичных продаж — близнец такого же списка
 * на дашборде первички (first-sales/FunnelDealsList.tsx).
 *
 * Данные не грузит сам: воронка и список приходят одним ответом ручки
 * `renewals/funnel`, и второй запрос за тем же самым был бы лишним. Поэтому
 * группы приходят пропсом, а компонент отвечает только за показ.
 */

/** Высота области прокрутки — под график воронки слева (340 px у EChart),
 *  чтобы блоки кончались на одной линии и список не растягивал страницу. */
const LIST_HEIGHT_PX = 340;

/** Порция строк на шаг прокрутки. Данные не обрезаются, ограничен только DOM. */
const CHUNK = 60;
const SCROLL_TAIL_PX = 400;

const fmtMoney = (n: number) => `${Math.round(n).toLocaleString('ru-RU')} ₽`;

/** Цвет ступени — та же палитра и тот же перебор слотов, что у самой воронки
 *  (`seriesColor(theme, i % 6)` в RenewalsFunnel.tsx). */
function stageColorVar(index: number): string {
  return `var(--chart-series-${(index % 6) + 1})`;
}

type Item =
  | { kind: 'header'; key: string; name: string; count: number; colorVar: string }
  | { kind: 'deal'; deal: RenewalsStageDeals['deals'][number]; colorVar: string };

function flatten(groups: RenewalsStageDeals[]): Item[] {
  const items: Item[] = [];
  groups.forEach((group, index) => {
    const colorVar = stageColorVar(index);
    items.push({ kind: 'header', key: String(group.statusId), name: group.name, count: group.deals.length, colorVar });
    for (const deal of group.deals) items.push({ kind: 'deal', deal, colorVar });
  });
  return items;
}

export default function RenewalsDealsList({ groups }: { groups: RenewalsStageDeals[] }) {
  const [scrolled, setScrolled] = useState(CHUNK);
  const [openDeal, setOpenDeal] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const items = useMemo(() => flatten(groups), [groups]);
  const shown = items.slice(0, scrolled);
  // Сбрасывать `scrolled` при смене групп не нужно: воронка грузится один раз
  // при открытии страницы и периодом не фильтруется (см. renewals/funnel/route.ts),
  // так что другого набора групп у этого компонента за его жизнь не бывает.

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - SCROLL_TAIL_PX) {
      setScrolled((v) => (v >= items.length ? v : v + CHUNK));
    }
  };

  return (
    <div className="glass-tile flex flex-col p-3">
      <h3 className="mb-1 text-sm font-semibold text-zinc-900">Сделки в воронке</h3>
      {/* Без слова «период» в заголовке: список показывает ту же воронку, что
          слева, а она от периода не зависит. */}
      <p className="mb-2 text-[11px] text-zinc-400">
        Все сделки воронки, каждая — в той ступени, до которой дошла. Период не влияет. Клик открывает карточку.
      </p>

      {items.length === 0 ? (
        <div style={{ height: LIST_HEIGHT_PX }} className="px-3 py-10 text-center text-sm text-zinc-400">
          Сделок в воронке пока нет.
        </div>
      ) : (
        <div
          ref={scrollRef}
          onScroll={onScroll}
          style={{ height: LIST_HEIGHT_PX }}
          className="overflow-y-auto rounded-lg border border-zinc-200 bg-[var(--glass-rows)]"
        >
          {shown.map((item) =>
            item.kind === 'header' ? (
              <h4
                key={`h-${item.key}`}
                style={{ color: item.colorVar }}
                className="sticky top-0 z-10 border-b border-zinc-100 bg-[var(--glass-rows)] px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider backdrop-blur"
              >
                {item.name} — {item.count}
              </h4>
            ) : (
              <button
                key={item.deal.amoId}
                type="button"
                onClick={() => setOpenDeal(item.deal.amoId)}
                // Полоска слева тянется вдоль всей группы: заголовок sticky и
                // уезжает вверх, а на середине длинной группы ступень иначе не
                // опознать.
                style={{ borderLeftColor: item.colorVar }}
                className="block w-full border-b border-l-2 border-zinc-50 px-2.5 py-1.5 text-left last:border-b-0 hover:bg-zinc-50/60"
              >
                <div className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-xs text-zinc-800">
                    {item.deal.companyName || item.deal.name || `Сделка #${item.deal.amoId}`}
                  </span>
                  <span className="shrink-0 tabular-nums text-[10px] text-zinc-500">
                    {item.deal.amount != null ? fmtMoney(item.deal.amount) : '—'}
                  </span>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-1">
                  <span className="text-[10px] text-zinc-500">
                    {item.deal.responsibleName || 'не закреплён'}
                  </span>
                  {/* Исход — состояние на сейчас, а не пройденный этап: сделка
                      прошла свой путь и уехала в паузу или отвал. Ступень при
                      этом остаётся её ступенью, значок только предупреждает. */}
                  {item.deal.outcome ? (
                    <span
                      title="Сделка прошла эту ступень, но сейчас стоит вне пути"
                      className="rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700"
                    >
                      {item.deal.outcome}
                    </span>
                  ) : null}
                </div>
              </button>
            ),
          )}
          {scrolled < items.length && (
            <p className="px-2.5 py-2 text-center text-[11px] text-zinc-400">Прокрутите — покажем ещё…</p>
          )}
        </div>
      )}

      {openDeal !== null && (
        <DealModal
          amoId={openDeal}
          endpoint="/api/analytics/renewals/deal"
          onClose={() => setOpenDeal(null)}
        />
      )}
    </div>
  );
}
