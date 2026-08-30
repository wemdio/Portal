'use client';

import { useEffect, useRef } from 'react';
import type { EChartsCoreOption } from 'echarts/core';

import { echarts } from '@/components/charts/echartsSetup';

/**
 * Тонкая обёртка над echarts: жизненный цикл инстанса, подгонка под ширину и
 * уборка за собой. Ничего про конкретный график не знает — конфигурацию целиком
 * собирает вызывающий.
 *
 * Обёртки `echarts-for-react` намеренно нет: она тянет за собой полную сборку
 * библиотеки мимо нашего списка модулей в `echartsSetup`, ради тех же тридцати
 * строк, что лежат ниже.
 */
export default function EChart({
  option,
  height,
  className,
  ariaLabel,
  onSelectIndex,
  onSelectItemName,
}: {
  option: EChartsCoreOption;
  height: number;
  className?: string;
  /** Описание для скринридера: холст canvas сам по себе нечитаем. */
  ariaLabel: string;
  /**
   * Клик по вертикальной полосе категории: отдаёт индекс корзины по оси X.
   *
   * Именно полосы, а не самого столбца. Событие `click` серии срабатывает
   * только по закрашенным пикселям, а столбец в дневной раскладке бывает
   * шириной в несколько точек — попасть в него мышью тяжело, а в пустой день
   * невозможно вовсе.
   */
  onSelectIndex?: (index: number) => void;
  /**
   * Клик по элементу серии — отдаёт его `name`.
   *
   * Отдельно от `onSelectIndex`: тот ловит клик по вертикальной полосе
   * категории и работает только там, где есть grid с осями. У воронки grid'а
   * нет вовсе, зато сами ступени крупные и попасть в них мышью легко, так что
   * здесь достаточно обычного события серии.
   */
  onSelectItemName?: (name: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ReturnType<typeof echarts.init> | null>(null);
  // Обработчик вешается один раз на весь срок жизни инстанса, поэтому свежий
  // колбэк держим в ref: иначе замыкание запомнило бы состояние первого рендера.
  const selectRef = useRef(onSelectIndex);
  useEffect(() => {
    selectRef.current = onSelectIndex;
  }, [onSelectIndex]);
  const selectNameRef = useRef(onSelectItemName);
  useEffect(() => {
    selectNameRef.current = onSelectItemName;
  }, [onSelectItemName]);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;

    const chart = echarts.init(el, undefined, { renderer: 'canvas' });
    chartRef.current = chart;

    // Ширина карточки меняется от боковой панели и от разворота таблиц, а не
    // только от размера окна, поэтому следим за самим контейнером.
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(el);

    const zr = chart.getZr();
    const onClick = (event: { offsetX: number; offsetY: number }) => {
      const notify = selectRef.current;
      if (!notify) return;
      const point: [number, number] = [event.offsetX, event.offsetY];
      if (!chart.containPixel('grid', point)) return;
      const index = chart.convertFromPixel({ xAxisIndex: 0 }, point[0]);
      if (typeof index === 'number' && Number.isFinite(index)) notify(Math.round(index));
    };
    zr.on('click', onClick);

    const onItemClick = (params: unknown) => {
      const notify = selectNameRef.current;
      if (!notify) return;
      const name = (params as { name?: unknown }).name;
      if (typeof name === 'string' && name !== '') notify(name);
    };
    chart.on('click', onItemClick);

    return () => {
      chart.off('click', onItemClick);
      zr.off('click', onClick);
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    // `notMerge` обязателен: при смене фильтра рядов может стать меньше, а при
    // слиянии echarts оставил бы прежние на холсте.
    chartRef.current?.setOption(option, { notMerge: true });
  }, [option]);

  return <div ref={hostRef} style={{ height }} className={className} role="img" aria-label={ariaLabel} />;
}
