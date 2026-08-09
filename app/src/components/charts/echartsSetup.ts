import * as echarts from 'echarts/core';
import { BarChart, FunnelChart, LineChart, PieChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { LabelLayout } from 'echarts/features';
import { CanvasRenderer } from 'echarts/renderers';

/**
 * Единая точка регистрации модулей echarts.
 *
 * Импорт по частям, а не `import * as echarts from 'echarts'`: полная сборка
 * тянет около мегабайта и уезжает в бандл каждой страницы, где есть график.
 * Здесь подключено ровно то, что рисуют дашборды — столбцы, линии, воронка.
 * Новый тип графика надо сначала добавить в этот список, иначе echarts
 * промолчит и оставит пустой холст.
 */
echarts.use([
  BarChart,
  LineChart,
  FunnelChart,
  PieChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  LabelLayout,
  CanvasRenderer,
]);

export { echarts };
