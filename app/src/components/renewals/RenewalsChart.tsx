'use client';

import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { RenewalSeriesBucket } from '@/lib/renewals/metrics';
import type { GroupBy } from '@/lib/firstSales/buckets';

const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

// Ключ корзины всегда YYYY-MM-DD (начало корзины в МСК, см. bucketKey в
// buckets.ts). Разбираем строку вручную, а не через `new Date(key)` — Date +
// toLocaleDateString подставили бы часовой пояс браузера и могли бы съехать
// на день в отрицательных смещениях от UTC. Тот же приём, что в
// first-sales/TimeSeriesChart.tsx.
function formatKey(key: string, groupBy: GroupBy): string {
  const [y, m, d] = key.split('-');
  if (!y || !m || !d) return key;
  if (groupBy === 'month') return `${MONTHS_SHORT[Number(m) - 1] ?? m} ${y}`;
  return `${d}.${m}`;
}

/**
 * Помесячный (или по дню/неделе — по выбору) график продлений. Вторичен по
 * отношению к таблице ниже него на странице: продлений всего 32 за всю
 * историю, и график из двух-трёх столбиков менее полезен, чем список, где
 * видно каждое продление (см. план дашборда). Оставлен для быстрого взгляда
 * на динамику, а не как основной инструмент анализа.
 */
export default function RenewalsChart({ series, groupBy }: { series: RenewalSeriesBucket[]; groupBy: GroupBy }) {
  const data = series.map((b) => ({ ...b, label: formatKey(b.key, groupBy) }));

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-3">
      <div style={{ height: 240 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f4f4f5" vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#a1a1aa' }} axisLine={{ stroke: '#e4e4e7' }} tickLine={false} />
            <YAxis
              yAxisId="count"
              tick={{ fontSize: 11, fill: '#a1a1aa' }}
              axisLine={false}
              tickLine={false}
              allowDecimals={false}
              width={28}
            />
            <YAxis
              yAxisId="revenue"
              orientation="right"
              tick={{ fontSize: 11, fill: '#a1a1aa' }}
              axisLine={false}
              tickLine={false}
              width={48}
              tickFormatter={(v: number) => v.toLocaleString('ru-RU')}
            />
            <Tooltip
              contentStyle={{ fontSize: 12, borderRadius: 8, borderColor: '#e4e4e7' }}
              labelFormatter={(_, payload) => payload?.[0]?.payload?.key ?? ''}
              formatter={(v: number, name: string) => [v.toLocaleString('ru-RU'), name]}
            />
            <Legend align="right" wrapperStyle={{ fontSize: 11, paddingRight: 8 }} />
            <Bar yAxisId="count" dataKey="count" name="Продлений" fill="#d4d4d8" radius={[3, 3, 0, 0]} barSize={18} />
            {/* linear, а не monotone: сглаженный сплайн между помесячными
                суммами рисует значения, которых не существует, и вдобавок
                выгибается выше фактического максимума. Продление — событие
                дискретное; ломаная честно говорит «вот точки, между ними мы
                ничего не знаем». Точки показываем — при 32 продлениях за всю
                историю месяцев с данными мало, и без них ломаная читается как
                непрерывный процесс. */}
            <Line
              yAxisId="revenue"
              type="linear"
              dataKey="revenue"
              name="Оборот, ₽"
              stroke="#059669"
              strokeWidth={2}
              dot={{ r: 2.5, fill: '#059669', strokeWidth: 0 }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
