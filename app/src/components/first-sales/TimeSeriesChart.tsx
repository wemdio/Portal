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
import type { SeriesBucket } from '@/lib/firstSales/metrics';
import type { GroupBy } from '@/lib/firstSales/buckets';

const LABELS: Record<'leads' | 'qualified' | 'meetings' | 'contracts', string> = {
  leads: 'Лиды',
  // Не просто «Квал»: qualified кладётся в корзину по дате ПРИХОДА лида
  // (когортно — «из пришедших в этот день скольких квалифицировали»), а
  // meetings/contracts ниже — по дате самого этапа. Без пояснения в легенде
  // все четыре числа читаются как «что случилось в этот день», и это неверно
  // для этого столбца.
  qualified: 'Квал (из пришедших)',
  meetings: 'Встречи',
  contracts: 'Договоры',
};

const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

// Ключ корзины всегда YYYY-MM-DD (начало корзины в МСК, см. bucketKey в
// buckets.ts). Разбираем строку вручную, а не через `new Date(key)` — Date +
// toLocaleDateString подставили бы часовой пояс браузера и могли бы съехать
// на день в отрицательных смещениях от UTC.
function formatKey(key: string, groupBy: GroupBy): string {
  const [y, m, d] = key.split('-');
  if (!y || !m || !d) return key;
  if (groupBy === 'month') return `${MONTHS_SHORT[Number(m) - 1] ?? m} ${y}`;
  return `${d}.${m}`;
}

export default function TimeSeriesChart({ series, groupBy }: { series: SeriesBucket[]; groupBy: GroupBy }) {
  const data = series.map((b) => ({ ...b, label: formatKey(b.key, groupBy) }));

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-3">
      <div style={{ height: 288 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f4f4f5" vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#a1a1aa' }} axisLine={{ stroke: '#e4e4e7' }} tickLine={false} />
            <YAxis tick={{ fontSize: 11, fill: '#a1a1aa' }} axisLine={false} tickLine={false} allowDecimals={false} width={32} />
            <Tooltip
              contentStyle={{ fontSize: 12, borderRadius: 8, borderColor: '#e4e4e7' }}
              labelFormatter={(_, payload) => payload?.[0]?.payload?.key ?? ''}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar dataKey="leads" name={LABELS.leads} fill="#d4d4d8" radius={[3, 3, 0, 0]} barSize={18} />
            <Line
              type="monotone"
              dataKey="qualified"
              name={LABELS.qualified}
              stroke="#8b5cf6"
              strokeWidth={2}
              dot={false}
            />
            <Line
              type="monotone"
              dataKey="meetings"
              name={LABELS.meetings}
              stroke="#3b82f6"
              strokeWidth={2}
              dot={false}
            />
            <Line
              type="monotone"
              dataKey="contracts"
              name={LABELS.contracts}
              stroke="#059669"
              strokeWidth={2}
              dot={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <p className="mt-2 text-[11px] text-zinc-400">
        «Квал (из пришедших)» — когорта: из лидов, пришедших в эту корзину, сколько в итоге дошли до квалификации
        (независимо от даты самого перехода). «Встречи» и «Договоры» — по дате самого события, а не даты прихода лида.
        Две разные логики соседствуют на одном графике намеренно, но читать их как «что случилось в этот день» для всех
        четырёх рядов сразу — ошибка.
      </p>
      <p className="mt-1 text-[11px] text-amber-700">
        Встречи считаются по датам записей разговоров в чате встреч, а не по этапу AMO «Встреча проведена» — этот этап
        был засорён и показывал 200+ встреч в месяц против 64 реальных. Подписи к записям стали регулярными с
        01.05.2026 — за более ранние периоды линия встреч пустая: это отказ считать недостоверное, а не отсутствие встреч.
      </p>
      <p className="mt-1 text-[11px] text-amber-700">
        Договоры считаются с 30.07.2026 — с этой даты этап «Согласование договора» в AMO ставится только при реальном
        согласовании и правках. Раньше туда попадали и сделки, которым договор просто отправили, поэтому за прошлые
        периоды линия договоров пустая: это отказ считать недостоверное, а не отсутствие договоров.
      </p>
    </div>
  );
}
