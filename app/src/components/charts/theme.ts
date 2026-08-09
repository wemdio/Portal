'use client';

import { useLayoutEffect, useState, useSyncExternalStore, type RefObject } from 'react';

/**
 * Оформление графиков портала: одно место, из которого все дашборды берут
 * цвета, шрифт и параметры осей.
 *
 * Палитра рядов НЕ продублирована здесь константами — она читается прямо из
 * CSS-переменных `--chart-series-N`, объявленных в `globals.css`. Так значения
 * остаются в одном месте, а тёмная тема продолжает работать через
 * `html[data-portal-theme='dark']`, ничего не зная про TypeScript. Дублирование
 * тут стоило бы дорого: набор проверен валидатором на различимость (в том числе
 * при дейтеранопии), и разъехавшаяся копия молча обнулила бы эту проверку.
 */

/** Сколько слотов палитры объявлено в globals.css. */
const SERIES_SLOTS = 6;

/**
 * Сетка, оси и подсветка наведения заданы нейтральным серым с прозрачностью,
 * а не переменной темы: полупрозрачный серый одинаково спокойно ложится и на
 * белую карточку, и на тёмную поверхность, и не требует второго набора
 * значений. Приём взят из прежнего графика расходов, где он себя оправдал.
 */
export const GRID_LINE = 'rgba(127, 127, 133, 0.22)';
export const AXIS_LINE = 'rgba(127, 127, 133, 0.35)';
export const AXIS_TEXT = 'rgba(127, 127, 133, 0.95)';
export const HOVER_BAND = 'rgba(127, 127, 133, 0.1)';

export const CHART_FONT =
  'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';

/**
 * Кегли внутри графика намеренно крупнее, чем у мелкого текста портала (11px).
 *
 * Подпись на карточке читают вплотную и по одной, а подписи осей — боковым
 * зрением, по всей ширине экрана и не глядя прямо. На широком мониторе
 * одиннадцатый кегль на холсте превращается в нечитаемую сыпь, хотя в вёрстке
 * рядом смотрится нормально.
 */
export const AXIS_FONT_SIZE = 12;
export const LEGEND_FONT_SIZE = 12;
export const TOOLTIP_FONT_SIZE = 13;

export interface ChartTheme {
  dark: boolean;
  /** Слоты палитры по порядку; назначаются ряду по индексу, без зацикливания. */
  series: string[];
  /** Цвет неразмеченного — это отказ от палитры, а не её седьмой слот. */
  muted: string;
  /** Фактический фон карточки под графиком: фон тултипа и зазоры в стеке. */
  surface: string;
  /** Основной цвет текста, унаследованный от карточки. */
  ink: string;
  /**
   * Развернуть `var(--что-то)` в действующее значение.
   *
   * Привязана к элементу, от которого тема прочитана, поэтому вызывающему не
   * нужно держать ref и тянуться к DOM во время рендера.
   */
  resolveColor: (value: string) => string;
}

function readVar(styles: CSSStyleDeclaration, name: string): string {
  return styles.getPropertyValue(name).trim();
}

/**
 * Фон карточки под графиком: сначала объявленная переменная, потом замер.
 *
 * Обычные карточки портала покрашены утилитами Tailwind (`bg-white`), а тёмная
 * тема переопределяет их отдельным правилом в `globals.css`. Переменной, из
 * которой можно было бы прочитать «текущую поверхность», для них не существует,
 * и захардкоженный белый оставил бы тултип светлым пятном в тёмной теме —
 * поэтому фон замеряется у ближайшего непрозрачного предка.
 *
 * Стеклянные дашборды ломают этот замер: фон их карточек полупрозрачный, а
 * проверка ниже отсеивает только полностью прозрачное и примет
 * `rgba(255, 255, 255, 0.55)` за валидную поверхность — тултип начнёт
 * просвечивать насквозь. Такие поверхности объявляют `--chart-surface` с
 * плотным цветом, и он имеет приоритет над замером.
 */
export function resolveSurface(from: HTMLElement): string {
  const declared = getComputedStyle(from).getPropertyValue('--chart-surface').trim();
  if (declared) return declared;

  let node: HTMLElement | null = from;
  while (node) {
    const bg = getComputedStyle(node).backgroundColor;
    if (bg && bg !== 'transparent' && !bg.startsWith('rgba(0, 0, 0, 0')) return bg;
    node = node.parentElement;
  }
  return '#ffffff';
}

function readChartTheme(el: HTMLElement): ChartTheme {
  const styles = getComputedStyle(el);
  const series: string[] = [];
  for (let i = 1; i <= SERIES_SLOTS; i += 1) {
    const value = readVar(styles, `--chart-series-${i}`);
    if (value) series.push(value);
  }

  return {
    dark: document.documentElement.dataset.portalTheme === 'dark',
    series,
    muted: readVar(styles, '--chart-series-muted') || AXIS_TEXT,
    surface: resolveSurface(el),
    ink: styles.color || AXIS_TEXT,
    resolveColor: (value: string) => resolveCssColor(el, value),
  };
}

/**
 * Тема графика, вычисленная из живого DOM, с пересчётом при переключении темы.
 *
 * `useLayoutEffect`, а не `useEffect`: значение нужно до того, как браузер
 * покажет кадр, иначе в тёмной теме успевает моргнуть график, собранный на
 * светлых цветах. Пока элемента нет (первый рендер), возвращается `null` —
 * вызывающий просто не рисует график, и это честнее, чем подставить палитру
 * наугад.
 */
export function useChartTheme(ref: RefObject<HTMLElement | null>): ChartTheme | null {
  const [theme, setTheme] = useState<ChartTheme | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const sync = () => setTheme(readChartTheme(el));
    sync();

    // Переключатель темы меняет атрибут на <html>; CSS-переменные пересчитаются
    // сами, а вот echarts уже держит цвета скопированными в своей конфигурации
    // и о смене не узнает — поэтому следим за атрибутом и пересобираем.
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-portal-theme'],
    });
    return () => observer.disconnect();
  }, [ref]);

  return theme;
}

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function subscribeToMotionPreference(onChange: () => void): () => void {
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/**
 * Появление столбцов — украшение, и пользователь вправе от него отказаться.
 * `useSyncExternalStore`, а не эффект со `setState`: на сервере значение
 * неизвестно, и честнее отдать «анимация разрешена», чем моргнуть состоянием.
 */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeToMotionPreference,
    () => window.matchMedia(REDUCED_MOTION_QUERY).matches,
    () => false,
  );
}

/** Слот палитры по индексу ряда. Слоты не зацикливаются: см. globals.css. */
export function seriesColor(theme: ChartTheme, index: number): string {
  return theme.series[index] ?? theme.muted;
}

/**
 * `var(--chart-series-3)` → реальный цвет.
 *
 * Вызывающие отдают цвета рядов CSS-переменными — в разметке это работает само,
 * но echarts рисует в canvas и `var()` не понимает: незнакомую строку он молча
 * заменит на цвет по умолчанию. Разворачиваем переменную от элемента, чтобы
 * подхватилось действующее значение темы.
 */
export function resolveCssColor(el: HTMLElement | null, value: string): string {
  const match = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value.trim());
  if (!match || !el) return value;
  return getComputedStyle(el).getPropertyValue(match[1]).trim() || value;
}

/** `#rrggbb` с прозрачностью. Не-hex (например `rgb(...)`) отдаётся как есть. */
export function withAlpha(color: string, alpha: number): string {
  const match = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!match) return color;
  const n = Number.parseInt(match[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** Вертикальный градиент от полного цвета к приглушённому — заливка столбцов. */
export function verticalGradient(color: string, toAlpha = 0.4) {
  return {
    type: 'linear' as const,
    x: 0,
    y: 0,
    x2: 0,
    y2: 1,
    colorStops: [
      { offset: 0, color },
      { offset: 1, color: withAlpha(color, toAlpha) },
    ],
  };
}

/** Общая рамка тултипа: поверхность карточки, а не белый по умолчанию. */
export function tooltipSkin(theme: ChartTheme) {
  return {
    backgroundColor: theme.surface,
    borderColor: GRID_LINE,
    borderWidth: 1,
    padding: [10, 12] as [number, number],
    textStyle: { color: theme.ink, fontSize: TOOLTIP_FONT_SIZE, fontFamily: CHART_FONT },
    extraCssText: 'border-radius:12px;box-shadow:0 10px 30px -12px rgba(0,0,0,.35);',
  };
}
