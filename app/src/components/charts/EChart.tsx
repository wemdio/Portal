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
}: {
  option: EChartsCoreOption;
  height: number;
  className?: string;
  /** Описание для скринридера: холст canvas сам по себе нечитаем. */
  ariaLabel: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ReturnType<typeof echarts.init> | null>(null);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;

    const chart = echarts.init(el, undefined, { renderer: 'canvas' });
    chartRef.current = chart;

    // Ширина карточки меняется от боковой панели и от разворота таблиц, а не
    // только от размера окна, поэтому следим за самим контейнером.
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(el);

    return () => {
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
