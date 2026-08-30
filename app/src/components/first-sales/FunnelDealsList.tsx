'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { authFetch } from '@/lib/authFetch';
import { logError } from '@/lib/loggerClient';
import type { FiltersState } from '@/components/first-sales/FiltersBar';
import { FUNNEL_STAGE_COLOR_VAR, type FunnelStageId } from '@/lib/firstSales/funnelDeals';
import type { InPeriod } from '@/components/first-sales/DealDrillDown';
import DealModal from '@/components/first-sales/DealModal';

/**
 * Список сделок рядом с воронкой: кто именно стоит за каждой её ступенью.
 *
 * Сделка показана ровно один раз — в самой глубокой ступени, которой достигла
 * (правило и его обоснование — в lib/firstSales/funnelDeals.ts). Сумма по
 * группам поэтому НЕ равна числу лидов периода, и заголовок группы называет
 * размер именно этой группы; цифра со ступени воронки — в подсказке, чтобы
 * одно не выдавалось за другое.
 */

type DealRow = {
  amo_id: number;
  name: string | null;
  company_name: string | null;
  responsible_name: string | null;
  created_at: string | null;
  history_complete: boolean;
  in_period: InPeriod;
  amo_url: string | null;
};

type StageGroup = { stage: FunnelStageId; label: string; deals: DealRow[] };
type GroupsResponse = { groups: StageGroup[] };

/**
 * Сколько строк дорисовывается за один шаг прокрутки.
 *
 * Ограничения на данные нет: сервер отдаёт все сделки группы. Ограничен только
 * DOM — годовой период это тысячи строк, и вывалить их разом значит подвесить
 * вкладку на пару секунд. Порция и запас (`SCROLL_TAIL_PX`) подобраны так,
 * чтобы следующая порция успевала появиться до того, как пользователь доедет
 * до конца списка.
 */
const CHUNK = 60;
const SCROLL_TAIL_PX = 400;

/**
 * Высота области прокрутки.
 *
 * Фиксированная, а не «по содержимому»: без потолка блок растягивался на всю
 * длину списка — за месяц это несколько экранов, и всё, что ниже воронки
 * (график по времени, таблицы), уезжало за горизонт. Подобрана под высоту
 * графика воронки слева (320 px у EChart), чтобы оба блока кончались на одной
 * линии.
 */
const LIST_HEIGHT_PX = 320;

const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('ru-RU') : '—');
const fmtMoney = (n: number) => `${Math.round(n).toLocaleString('ru-RU')} ₽`;

function periodBadges(p: InPeriod): string[] {
  const out: string[] = [];
  if (p.qualified) out.push('квал');
  if (p.meetings > 0) out.push(p.meetings > 1 ? `встречи · ${p.meetings}` : 'встреча');
  if (p.contract) out.push('договор');
  if (p.money > 0) out.push(fmtMoney(p.money));
  return out;
}

/** Плоский список «заголовок группы / строка сделки» — так порционная
 *  отрисовка работает поверх всех групп сразу, а не отдельно в каждой. */
type Item =
  | { kind: 'header'; stage: FunnelStageId; label: string; count: number }
  // `stage` продублирован в строке сделки намеренно: цветная полоска слева
  // рисуется у каждой строки, а не только у заголовка группы.
  | { kind: 'deal'; stage: FunnelStageId; deal: DealRow };

function flatten(groups: StageGroup[]): Item[] {
  const items: Item[] = [];
  for (const group of groups) {
    items.push({ kind: 'header', stage: group.stage, label: group.label, count: group.deals.length });
    for (const deal of group.deals) items.push({ kind: 'deal', stage: group.stage, deal });
  }
  return items;
}

export default function FunnelDealsList({
  filters,
  /** Ступень, по которой кликнули на воронке, — к ней прокручиваем список. */
  focusStage,
  /** Цифры со ступеней воронки: показываем в подсказке заголовка группы. */
  funnelCounts,
}: {
  filters: FiltersState;
  focusStage: FunnelStageId | null;
  funnelCounts: Partial<Record<FunnelStageId, number>>;
}) {
  const [groups, setGroups] = useState<StageGroup[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Сколько строк дорисовано прокруткой. Не итоговое число видимых строк —
   *  см. `visible` ниже: клик по ступени воронки может потребовать больше. */
  const [scrolled, setScrolled] = useState(CHUNK);
  const [openDeal, setOpenDeal] = useState<number | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const headerRefs = useRef(new Map<FunnelStageId, HTMLElement>());

  const sourcesKey = filters.sources.join(',');

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    const run = async () => {
      setLoading(true);
      try {
        const qs = new URLSearchParams({ from: filters.from, to: filters.to });
        for (const source of filters.sources) qs.append('source', source);

        const res = await authFetch(`/api/analytics/first-sales/funnel-deals?${qs.toString()}`, {
          signal: controller.signal,
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error || `HTTP ${res.status}`);
        }
        const json = (await res.json()) as GroupsResponse;
        if (!active) return;
        setError(null);
        setGroups(json.groups ?? []);
        // Порция считается заново на каждую смену фильтра: иначе после
        // прокрутки годового периода короткий месяц отрисовался бы разом.
        setScrolled(CHUNK);
      } catch (e) {
        if (!active) return;
        if (e instanceof DOMException && e.name === 'AbortError') return;
        logError('first-sales.funnel-deals.fetch_failed', e);
        setError(e instanceof Error ? e.message : 'Не удалось загрузить сделки');
      } finally {
        if (active) setLoading(false);
      }
    };

    void run();
    return () => {
      active = false;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- массив sources пересоздаётся на каждый рендер родителя; следим за его содержимым через sourcesKey, иначе запрос уходил бы бесконечно.
  }, [filters.from, filters.to, sourcesKey]);

  const items = useMemo(() => flatten(groups ?? []), [groups]);

  /**
   * Сколько строк реально показываем.
   *
   * Вычисляется, а не хранится состоянием: клик по ступени воронки должен
   * дорисовать список до её заголовка, и делать это через setState внутри
   * эффекта — каскадный ререндер, на который справедливо ругается линтер.
   * Здесь нужное число получается прямо из входных данных.
   */
  const focusIndex = focusStage === null
    ? -1
    : items.findIndex((item) => item.kind === 'header' && item.stage === focusStage);
  const visible = Math.max(scrolled, focusIndex >= 0 ? focusIndex + CHUNK : 0);
  const shown = items.slice(0, visible);

  // Прокрутка к выбранной ступени. Эффект только скроллит: заголовок к этому
  // моменту уже в DOM, потому что `visible` выше учёл его индекс.
  useEffect(() => {
    if (focusStage === null) return;
    headerRefs.current.get(focusStage)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [focusStage, visible]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - SCROLL_TAIL_PX) {
      setScrolled((v) => (v >= items.length ? v : v + CHUNK));
    }
  };

  return (
    <div className="glass-tile flex flex-col p-3">
      <h3 className="mb-1 text-sm font-semibold text-zinc-900">Сделки за период в воронке</h3>
      <p className="mb-2 text-[11px] text-zinc-400">
        Каждая сделка — в той ступени, до которой дошла. Клик открывает карточку.
      </p>

      {loading ? (
        <div style={{ height: LIST_HEIGHT_PX }} className="px-3 py-10 text-center text-sm text-zinc-400">
          Загрузка сделок…
        </div>
      ) : error ? (
        <div style={{ height: LIST_HEIGHT_PX }} className="px-3 py-10 text-center text-sm text-red-600">
          Ошибка загрузки: {error}
        </div>
      ) : items.length === 0 ? (
        <div style={{ height: LIST_HEIGHT_PX }} className="px-3 py-10 text-center text-sm text-zinc-400">
          Сделок за выбранный период нет.
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
                key={`h-${item.stage}`}
                ref={(el) => {
                  if (el) headerRefs.current.set(item.stage, el);
                  else headerRefs.current.delete(item.stage);
                }}
                title={
                  funnelCounts[item.stage] !== undefined
                    ? `На воронке ступень «${item.label}» — ${funnelCounts[item.stage]}: туда входят и сделки, `
                      + 'прошедшие дальше. Здесь только те, что дальше не пошли.'
                    : undefined
                }
                // Цвет ступени берётся из палитры графика: группа в списке и
                // ступень на воронке слева — одно и то же, и совпадающий цвет
                // связывает их без единого слова.
                style={{ color: FUNNEL_STAGE_COLOR_VAR[item.stage] }}
                className="sticky top-0 z-10 cursor-help border-b border-zinc-100 bg-[var(--glass-rows)] px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider backdrop-blur"
              >
                {item.label} — {item.count}
              </h4>
            ) : (
              <button
                key={item.deal.amo_id}
                type="button"
                onClick={() => setOpenDeal(item.deal.amo_id)}
                // Цветная полоска слева тянется вдоль всей группы: заголовок
                // уезжает вверх при прокрутке (он sticky), и без полоски на
                // середине длинной группы уже не видно, какая это ступень.
                style={{ borderLeftColor: FUNNEL_STAGE_COLOR_VAR[item.stage] }}
                className="block w-full border-b border-l-2 border-zinc-50 px-2.5 py-1.5 text-left last:border-b-0 hover:bg-zinc-50/60"
              >
                <div className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-xs text-zinc-800">
                    {item.deal.company_name || item.deal.name || `Сделка #${item.deal.amo_id}`}
                  </span>
                  <span className="shrink-0 tabular-nums text-[10px] text-zinc-400">
                    {fmtDate(item.deal.created_at)}
                  </span>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-1">
                  <span className="text-[10px] text-zinc-500">
                    {item.deal.responsible_name || 'не закреплён'}
                  </span>
                  {periodBadges(item.deal.in_period).map((badge) => (
                    <span
                      key={badge}
                      className="rounded-full border border-zinc-200 bg-white px-1.5 py-0.5 text-[10px] text-zinc-600"
                    >
                      {badge}
                    </span>
                  ))}
                </div>
              </button>
            ),
          )}
          {visible < items.length && (
            <p className="px-2.5 py-2 text-center text-[11px] text-zinc-400">Прокрутите — покажем ещё…</p>
          )}
        </div>
      )}

      {openDeal !== null && <DealModal amoId={openDeal} onClose={() => setOpenDeal(null)} />}
    </div>
  );
}
