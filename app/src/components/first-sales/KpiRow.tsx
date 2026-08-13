'use client';

import type { FirstSalesTotals } from '@/lib/firstSales/metrics';

const STALE_SYNC_MS = 36 * 60 * 60 * 1000;

const fmt = (n: number) => n.toLocaleString('ru-RU');
const fmtDays = (n: number) => n.toLocaleString('ru-RU', { maximumFractionDigits: 1 });
/** Копейки в плитке не нужны — округляем до рубля. */
const fmtMoney = (n: number) => `${Math.round(n).toLocaleString('ru-RU')} ₽`;

/** Вынесено из компонента: `Date.now()` внутри тела компонента — импьюрный
 *  вызов, react-compiler-плагин линтера ругается на него в теле рендера.
 *  Обычная функция-хелпер вне компонента снимает предупреждение и не хуже
 *  читается. */
function isSyncStale(syncedDate: Date | null): boolean {
  if (!syncedDate || !Number.isFinite(syncedDate.getTime())) return true;
  return Date.now() - syncedDate.getTime() > STALE_SYNC_MS;
}

/** Абсолютная и (если есть с чем сравнивать) процентная дельта к прошлому
 *  периоду. Прошлый период пустой → делить на ноль бессмысленно, показываем
 *  только абсолютную разницу — как и просили в задаче. */
function Delta({
  current,
  previous,
  format = fmt,
}: {
  current: number;
  previous: number;
  /** Деньги показываются рублями, остальное — штуками. */
  format?: (n: number) => string;
}) {
  const diff = current - previous;
  const color = diff > 0 ? 'text-emerald-600' : diff < 0 ? 'text-red-600' : 'text-zinc-400';
  const sign = diff > 0 ? '+' : '';
  const pct = previous > 0 ? Math.round((diff / previous) * 100) : null;
  const pctSign = pct !== null && pct > 0 ? '+' : '';
  return (
    <span className={`text-[11px] font-medium tabular-nums ${color}`}>
      {sign}{format(diff)}{pct !== null ? ` (${pctSign}${pct}%)` : ''}
    </span>
  );
}

function Tile({
  label,
  value,
  sub,
  delta,
  amber,
}: {
  label: string;
  value: string;
  sub?: string;
  delta?: React.ReactNode;
  amber?: boolean;
}) {
  return (
    // h-full — чтобы плашка занимала всю высоту ячейки сетки. Без него та,
    // что обёрнута в кнопку («Без источника»), села бы по высоте своего
    // содержимого: у неё нет ни подписи, ни дельты, и она оказалась бы ниже
    // соседей. Сетка растягивает саму кнопку, но не вложенный в неё div.
    <div className={`glass-tile h-full px-4 py-3 ${amber ? 'glass-tint-amber' : ''}`}>
      <p className={`text-[10px] font-medium uppercase tracking-wider ${amber ? 'text-amber-600' : 'text-zinc-400'}`}>
        {label}
      </p>
      <p className={`mt-1 text-xl font-semibold tabular-nums ${amber ? 'text-amber-800' : 'text-zinc-900'}`}>
        {value}
      </p>
      <div className="mt-0.5 flex items-center gap-1.5">
        {sub && <span className={`text-[11px] ${amber ? 'text-amber-700' : 'text-zinc-400'}`}>{sub}</span>}
        {delta}
      </div>
    </div>
  );
}

export default function KpiRow({
  totals,
  previousTotals,
  syncedAt,
  onNoSourceClick,
}: {
  totals: FirstSalesTotals;
  previousTotals: FirstSalesTotals;
  syncedAt: string | null;
  /** Клик по плашке «Без источника» — поставить фильтр на неё. */
  onNoSourceClick: () => void;
}) {
  const syncedDate = syncedAt ? new Date(syncedAt) : null;
  const syncedValid = !!syncedDate && Number.isFinite(syncedDate.getTime());
  const syncStale = isSyncStale(syncedDate);

  // Деньги — единственная цифра дашборда, чья неполнота структурная: связка с
  // банком идёт через ИНН, а ИНН заполнен у меньшинства сделок. Пока покрытие
  // не полное, плитка жёлтая и подписана долей — читать её как «столько мы
  // заработали» нельзя, только как «столько смогли связать».
  const money = totals.money;
  const coverageKnown = totals.contractsReliable && totals.contracts > 0;
  const moneyPartial = !coverageKnown || money.contractsWithInn < totals.contracts;
  const moneySub = [
    `платежей: ${fmt(money.payments)}`,
    coverageKnown ? `ИНН у ${fmt(money.contractsWithInn)} из ${fmt(totals.contracts)} договоров` : null,
    money.pendingPayments > 0 ? `ждут разбора: ${fmtMoney(money.pending)}` : null,
    money.ambiguousPayments > 0 ? `спорных: ${fmtMoney(money.ambiguous)}` : null,
  ].filter(Boolean).join(' · ');

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      <Tile
        label="Лиды"
        value={fmt(totals.leads)}
        sub={`магниты: ${fmt(totals.leadMagnets)}`}
        delta={<Delta current={totals.leads} previous={previousTotals.leads} />}
      />
      <Tile
        label="Квал"
        value={fmt(totals.qualified)}
        delta={<Delta current={totals.qualified} previous={previousTotals.qualified} />}
      />
      {/* Прочерк, а не ноль, пока окно целиком раньше даты, с которой подписи
          к записям в чате встреч стали регулярными: ноль читался бы как
          «встреч не было», хотя на деле автоматчер не может привязать
          неподписанную запись. Тот же приём, что у «Договоры» ниже. */}
      <Tile
        label="Встречи"
        value={totals.meetingsReliable ? fmt(totals.meetings) : '—'}
        sub={
          totals.meetingsReliable
            ? undefined
            : `считаются с ${new Date(totals.meetingsSince).toLocaleDateString('ru-RU')}`
        }
        delta={
          totals.meetingsReliable
            ? <Delta current={totals.meetings} previous={previousTotals.meetings} />
            : undefined
        }
      />
      {/* Прочерк, а не ноль, пока окно целиком раньше даты правила: ноль
          читался бы как «договоров не было», хотя на деле мы отказались
          считать грязные данные. Дельту в этом случае тоже не показываем —
          сравнивать не с чем. */}
      <Tile
        label="Договоры"
        value={totals.contractsReliable ? fmt(totals.contracts) : '—'}
        sub={
          totals.contractsReliable
            ? undefined
            : `считаются с ${new Date(totals.contractsSince).toLocaleDateString('ru-RU')}`
        }
        delta={
          totals.contractsReliable
            ? <Delta current={totals.contracts} previous={previousTotals.contracts} />
            : undefined
        }
      />
      <Tile
        label="Деньги"
        value={fmtMoney(money.received)}
        sub={moneySub}
        delta={
          <Delta
            current={money.received}
            previous={previousTotals.money.received}
            format={fmtMoney}
          />
        }
        amber={moneyPartial}
      />
      <Tile
        label="Средний цикл"
        value={totals.cycleMedianDays !== null ? `${fmtDays(totals.cycleMedianDays)} дн.` : '—'}
        sub={
          totals.cycleAvgDays !== null
            ? `среднее: ${fmtDays(totals.cycleAvgDays)} дн. · оплат: ${fmt(totals.wonCount)}`
            : `оплат: ${fmt(totals.wonCount)}`
        }
      />
      {/* Кнопка, а не просто плашка: клик ставит фильтр на «Без источника» —
          в таблице ниже остаётся одна строка, а её раскрытие даёт список
          сделок со ссылками в AMO. Это и есть выгрузка для продаж, только
          живая. Плашка без сделок кликом ничего не даст — гасим. */}
      <button
        type="button"
        onClick={onNoSourceClick}
        disabled={totals.noSourceLeads === 0}
        title="Показать только сделки без заполненного «Источник» — со ссылками в AMO"
        className="text-left enabled:cursor-pointer disabled:cursor-default"
      >
        <Tile
          label="Без источника"
          value={fmt(totals.noSourceLeads)}
          amber={totals.noSourceLeads > 0}
        />
      </button>
      <Tile
        label="Данные на"
        value={syncedValid && syncedDate ? syncedDate.toLocaleString('ru-RU') : '—'}
        sub={!syncedValid ? 'синка ещё не было' : undefined}
        amber={syncStale}
      />
    </div>
  );
}
