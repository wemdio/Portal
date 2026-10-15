'use client';

import { useEffect, useMemo, useState } from 'react';

import { Tile } from '@/components/expenses/KpiTile';
import { expensesFetch, formatRub, formatShare } from '@/lib/expenses/client';
import type { ExpensesSummary } from '@/lib/expenses/types';
import {
  computeForecast,
  DEFAULT_INPUTS,
  marginLevers,
  type ForecastInputs,
} from '@/lib/finForecast/model';
import { logError } from '@/lib/loggerClient';

/**
 * «Прогноз» — динамический финплан: CEO крутит переменные и сразу видит
 * оборот, траты и маржу месяца.
 *
 * Сервера здесь нет: расчёт в `lib/finForecast/model.ts`, введённое хранится в
 * браузере. Это черновик «а что если», а не утверждённый план — делить его с
 * другими и хранить историю незачем. Единственный запрос — факт прочих
 * расходов прошлого месяца, и то по кнопке.
 */

const STORAGE_KEY = 'portal:fin-forecast:v1';

/** Статьи, которые прогноз считает сам: подставлять их из факта — значит учесть дважды. */
const MODELLED_CATEGORIES = new Set(['payroll', 'taxes', 'transfer']);

type Field = { key: keyof ForecastInputs; label: string; suffix?: string };

const VARIABLE_GROUPS: Array<{ title: string; fields: Field[] }> = [
  {
    title: 'Первичка',
    fields: [
      { key: 'newProjects', label: 'Проектов' },
      { key: 'newCheck', label: 'Средний чек', suffix: '₽' },
    ],
  },
  {
    title: 'Продления',
    fields: [
      { key: 'renewals', label: 'Продлений' },
      { key: 'renewalCheck', label: 'Средний чек', suffix: '₽' },
    ],
  },
  {
    title: 'Команда',
    fields: [
      { key: 'specialists', label: 'Специалистов' },
      { key: 'leads', label: 'Лидов' },
      { key: 'sellers', label: 'МОП' },
    ],
  },
];

const RATE_GROUPS: Array<{ title: string; fields: Field[] }> = [
  {
    title: 'Специалист',
    fields: [
      { key: 'specialistPerProject', label: 'За проект', suffix: '₽' },
      { key: 'specialistRenewalPct', label: 'С продлений', suffix: '%' },
      { key: 'specialistNorm', label: 'Норма проектов' },
    ],
  },
  {
    title: 'Лид',
    fields: [{ key: 'leadSalary', label: 'Оклад', suffix: '₽' }],
  },
  {
    title: 'МОП',
    fields: [
      { key: 'sellerSalary', label: 'Оклад', suffix: '₽' },
      { key: 'sellerPlan', label: 'Личный план', suffix: '₽' },
      { key: 'sellerNewPct', label: 'С первички', suffix: '%' },
      { key: 'sellerRenewalSharePct', label: 'Продлений закрывает', suffix: '%' },
      { key: 'sellerRenewalPct', label: 'С продления', suffix: '%' },
    ],
  },
  {
    title: 'РОП',
    fields: [
      { key: 'ropSalary', label: 'Оклад', suffix: '₽' },
      { key: 'departmentPlan', label: 'План отдела', suffix: '₽' },
    ],
  },
  {
    title: 'CEO',
    fields: [
      { key: 'ceoSalary', label: 'Оклад', suffix: '₽' },
      { key: 'ceoProfitPct', label: 'Доля прибыли', suffix: '%' },
      { key: 'ceoProfitPctHigh', label: 'Доля от порога', suffix: '%' },
      { key: 'ceoHighTurnover', label: 'Порог оборота', suffix: '₽' },
    ],
  },
  {
    title: 'Прочее',
    fields: [
      { key: 'otherPayroll', label: 'Прочий ФОТ', suffix: '₽' },
      { key: 'otherCosts', label: 'Прочие расходы', suffix: '₽' },
      { key: 'taxPct', label: 'Налоги', suffix: '%' },
      { key: 'targetMarginPct', label: 'Цель по марже', suffix: '%' },
      { key: 'targetRenewalSharePct', label: 'Цель доли продлений', suffix: '%' },
    ],
  },
];

function loadInputs(): ForecastInputs {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    // Поверх умолчаний: новое поле в модели не должно приходить пустым из
    // старого сохранения.
    if (raw) return { ...DEFAULT_INPUTS, ...(JSON.parse(raw) as Partial<ForecastInputs>) };
  } catch {
    // Повреждённое сохранение — просто начинаем с умолчаний.
  }
  return DEFAULT_INPUTS;
}

/** Границы прошлого полного месяца по Москве, YYYY-MM-DD. */
function previousMonth(): { from: string; to: string; label: string } {
  const now = new Date(Date.now() + 3 * 60 * 60 * 1000);
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const label = start.toLocaleDateString('ru-RU', { month: 'long', timeZone: 'UTC' });
  return { from: iso(start), to: iso(end), label };
}

function NumberField({
  field,
  value,
  onChange,
}: {
  field: Field;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block">
      <span className="text-[11px] text-zinc-500">{field.label}</span>
      <div className="mt-0.5 flex items-center gap-1">
        <input
          type="number"
          min={0}
          inputMode="decimal"
          value={Number.isFinite(value) ? value : ''}
          onChange={(e) => onChange(e.target.value === '' ? 0 : Number(e.target.value))}
          className="w-full rounded-md border border-zinc-200 bg-white px-2 py-1 text-sm tabular-nums text-zinc-900 focus:border-zinc-400 focus:outline-none"
        />
        {field.suffix ? <span className="text-xs text-zinc-400">{field.suffix}</span> : null}
      </div>
    </label>
  );
}

export default function ForecastView() {
  const [inputs, setInputs] = useState<ForecastInputs>(DEFAULT_INPUTS);
  const [loaded, setLoaded] = useState(false);
  const [factLoading, setFactLoading] = useState(false);
  const [factError, setFactError] = useState<string | null>(null);

  // localStorage читаем после монтирования: на сервере его нет, и разметка
  // первого рендера должна совпасть.
  useEffect(() => {
    setInputs(loadInputs());
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(inputs));
    } catch {
      // Приватное окно — прогноз работает, просто не запомнится.
    }
  }, [inputs, loaded]);

  const set = (key: keyof ForecastInputs) => (value: number) =>
    setInputs((prev) => ({ ...prev, [key]: value }));

  const result = useMemo(() => computeForecast(inputs), [inputs]);
  const belowTarget = result.margin !== null && result.margin < inputs.targetMarginPct / 100;
  const levers = useMemo(() => (belowTarget ? marginLevers(inputs) : null), [belowTarget, inputs]);
  const prevMonth = useMemo(() => previousMonth(), []);

  const fillOtherCostsFromFact = async () => {
    setFactLoading(true);
    setFactError(null);
    try {
      const query = new URLSearchParams({ from: prevMonth.from, to: prevMonth.to, groupBy: 'month' });
      const summary = await expensesFetch<ExpensesSummary>(`/summary?${query.toString()}`);
      let total = 0;
      for (const point of summary.series) {
        for (const [category, amount] of Object.entries(point.byCategory)) {
          if (!MODELLED_CATEGORIES.has(category)) total += amount;
        }
      }
      setInputs((prev) => ({ ...prev, otherCosts: Math.round(total) }));
    } catch (e) {
      logError('money.forecast.fact_failed', e);
      setFactError(e instanceof Error ? e.message : 'Не удалось загрузить расходы');
    } finally {
      setFactLoading(false);
    }
  };

  const understaffed = inputs.specialists < result.specialistsNeeded;
  const lowRenewalShare =
    result.renewalShare !== null && result.renewalShare < inputs.targetRenewalSharePct / 100;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-zinc-900">Прогноз</h1>
          <p className="text-xs text-zinc-500">Месяц по введённым цифрам и ставкам мотивации.</p>
        </div>
        <button
          type="button"
          onClick={() => setInputs(DEFAULT_INPUTS)}
          className="rounded-full border border-zinc-200 px-3 py-1 text-xs text-zinc-500 hover:bg-zinc-100"
        >
          Сбросить
        </button>
      </div>

      <div className="glass-panel grid gap-4 px-4 py-3 md:grid-cols-[1fr_1fr_1.5fr]">
        {VARIABLE_GROUPS.map((group) => (
          <div key={group.title}>
            <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-zinc-400">
              {group.title}
            </p>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-[repeat(auto-fit,minmax(90px,1fr))]">
              {group.fields.map((field) => (
                <NumberField key={field.key} field={field} value={inputs[field.key]} onChange={set(field.key)} />
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile
          label="Оборот"
          value={`${formatRub(result.revenue)} ₽`}
          sub={`Первичка ${formatRub(result.revenueNew)} · продления ${formatRub(result.revenueRenewal)}`}
        />
        <Tile label="Траты" value={`${formatRub(result.totalCosts)} ₽`} sub="Все статьи ниже" />
        <Tile
          label={result.profit < 0 ? 'Убыток' : 'Прибыль'}
          value={`${formatRub(result.profit)} ₽`}
          tone={result.profit < 0 ? 'warning' : 'normal'}
          sub="Оборот минус траты"
        />
        <Tile
          label="Маржа"
          value={result.margin === null ? '—' : formatShare(result.margin)}
          tone={belowTarget ? 'warning' : 'normal'}
          sub={`Цель ${inputs.targetMarginPct}%`}
        />
      </div>

      {belowTarget && levers ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          До {inputs.targetMarginPct}% маржи:{' '}
          {levers.projectsNeeded !== null
            ? `${levers.projectsNeeded} проектов первички по текущему чеку`
            : 'проектами не добрать'}
          {' или '}
          {levers.checkNeeded !== null
            ? `чек первички ${formatRub(levers.checkNeeded)} ₽ при ${inputs.newProjects} проектах`
            : 'чеком не добрать'}
          .
        </div>
      ) : null}

      {understaffed || lowRenewalShare ? (
        <div className="space-y-1 text-[11px] text-amber-700">
          {understaffed ? (
            <p>
              {result.activeProjects} проектов — нужно {result.specialistsNeeded} специалистов по норме{' '}
              {inputs.specialistNorm}, сейчас {inputs.specialists}.
            </p>
          ) : null}
          {lowRenewalShare && result.renewalShare !== null ? (
            <p>
              Продления — {formatShare(result.renewalShare)} оборота, цель {inputs.targetRenewalSharePct}%.
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="glass-panel overflow-x-auto px-4 py-3">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wider text-zinc-400">
              <th className="pb-2 font-medium">Статья</th>
              <th className="pb-2 text-right font-medium">Сумма, ₽</th>
              <th className="pb-2 text-right font-medium">Доля оборота</th>
              <th className="hidden pb-2 pl-4 font-medium md:table-cell">Как считается</th>
            </tr>
          </thead>
          <tbody>
            {result.costs.map((line) => (
              <tr key={line.key} className="border-t border-zinc-100">
                <td className="py-1.5 text-zinc-800">{line.label}</td>
                <td className="py-1.5 text-right tabular-nums text-zinc-900">{formatRub(line.amount)}</td>
                <td className="py-1.5 text-right tabular-nums text-zinc-500">
                  {result.revenue > 0 ? formatShare(line.amount / result.revenue) : '—'}
                </td>
                <td className="hidden py-1.5 pl-4 text-xs text-zinc-400 md:table-cell">{line.hint}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <details className="glass-panel px-4 py-3">
        <summary className="cursor-pointer text-sm font-semibold text-zinc-700">Ставки и постоянные расходы</summary>
        <div className="mt-3 space-y-4">
          {RATE_GROUPS.map((group) => (
            <div key={group.title}>
              <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-zinc-400">{group.title}</p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                {group.fields.map((field) => (
                  <NumberField key={field.key} field={field} value={inputs[field.key]} onChange={set(field.key)} />
                ))}
              </div>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <button
              type="button"
              onClick={() => void fillOtherCostsFromFact()}
              disabled={factLoading}
              className="rounded-full border border-zinc-200 px-3 py-1 text-zinc-600 hover:bg-zinc-100 disabled:opacity-50"
            >
              {factLoading ? 'Загружаю…' : `Прочие расходы — факт за ${prevMonth.label}`}
            </button>
            <span className="text-zinc-400">без ФОТ и налогов</span>
            {factError ? <span className="text-red-600">{factError}</span> : null}
          </div>
        </div>
      </details>
    </div>
  );
}
