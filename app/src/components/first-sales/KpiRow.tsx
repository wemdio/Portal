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

/** `YYYY-MM-DD` → `ДД.ММ`, без `new Date`: разбор ISO-даты подставил бы
 *  часовой пояс браузера и мог бы съехать на день. */
function shortDay(key: string): string {
  const [, m, d] = key.split('-');
  return m && d ? `${d}.${m}` : key;
}

/**
 * Абсолютная и (если есть с чем сравнивать) процентная дельта к прошлому
 * периоду. Прошлый период пустой → делить на ноль бессмысленно, показываем
 * только абсолютную разницу.
 *
 * Голая цифра «-36 (-51%)» под плиткой не говорит, с чем сравнили: её читали
 * как «минус к плану», «минус к прошлому месяцу», «минус к прошлому году».
 * Поэтому в подсказке — и период сравнения, и само значение, с которым
 * считали разницу, а под шапкой страницы стоит общая подпись (см.
 * FirstSalesView).
 */
function Delta({
  current,
  previous,
  label,
  previousFrom,
  previousTo,
  format = fmt,
}: {
  current: number;
  previous: number;
  /** Название метрики для подсказки: «Квал», «Встречи», … */
  label: string;
  previousFrom: string;
  previousTo: string;
  /** Деньги показываются рублями, остальное — штуками. */
  format?: (n: number) => string;
}) {
  const diff = current - previous;
  const color = diff > 0 ? 'text-emerald-600' : diff < 0 ? 'text-red-600' : 'text-zinc-400';
  const sign = diff > 0 ? '+' : '';
  const pct = previous > 0 ? Math.round((diff / previous) * 100) : null;
  const pctSign = pct !== null && pct > 0 ? '+' : '';
  return (
    <span
      className={`cursor-help text-[11px] font-medium tabular-nums ${color}`}
      title={
        `Сравнение с предыдущим периодом такой же длины: `
        + `${shortDay(previousFrom)} — ${shortDay(previousTo)}. `
        + `${label} тогда: ${format(previous)}, сейчас: ${format(current)}.`
      }
    >
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
  hint,
}: {
  label: string;
  value: string;
  sub?: string;
  delta?: React.ReactNode;
  amber?: boolean;
  /** Подсказка по наведению на заголовок: что именно считает плитка. */
  hint?: string;
}) {
  return (
    // h-full — чтобы плашка занимала всю высоту ячейки сетки. Без него та,
    // что обёрнута в кнопку («Без источника»), села бы по высоте своего
    // содержимого: у неё нет ни подписи, ни дельты, и она оказалась бы ниже
    // соседей. Сетка растягивает саму кнопку, но не вложенный в неё div.
    <div className={`glass-tile h-full px-4 py-3 ${amber ? 'glass-tint-amber' : ''}`}>
      <p
        className={`text-[10px] font-medium uppercase tracking-wider ${amber ? 'text-amber-600' : 'text-zinc-400'} ${hint ? 'cursor-help' : ''}`}
        title={hint}
      >
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
  previousFrom,
  previousTo,
  syncedAt,
  onNoSourceClick,
}: {
  totals: FirstSalesTotals;
  previousTotals: FirstSalesTotals;
  /** Границы окна сравнения (`YYYY-MM-DD`, МСК) — считает сервер, см.
   *  summary/route.ts. */
  previousFrom: string;
  previousTo: string;
  syncedAt: string | null;
  /** Клик по плашке «Без источника» — поставить фильтр на неё. */
  onNoSourceClick: () => void;
}) {
  // Один объект на все плитки — период сравнения у них общий, а метрика и
  // значения свои.
  const prevWindow = { previousFrom, previousTo };
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
        delta={<Delta current={totals.leads} previous={previousTotals.leads} label="Лидов" {...prevWindow} />}
      />
      <Tile
        label="Квал"
        value={fmt(totals.qualified)}
        delta={<Delta current={totals.qualified} previous={previousTotals.qualified} label="Квалов" {...prevWindow} />}
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
            ? <Delta current={totals.meetings} previous={previousTotals.meetings} label="Встреч" {...prevWindow} />
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
            ? <Delta current={totals.contracts} previous={previousTotals.contracts} label="Договоров" {...prevWindow} />
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
            label="Денег"
            format={fmtMoney}
            {...prevWindow}
          />
        }
        amber={moneyPartial}
      />
      {/* «Средний цикл» крупно показывал МЕДИАНУ, а среднее пряталось в
          подписи — заголовок противоречил цифре под ним, и плитку читали как
          «средний срок 13,9 дня, а рядом почему-то ещё какие-то 31,4».
          Название теперь нейтральное, а какая цифра медиана и какая среднее —
          сказано прямо в подписи. Медиана осталась крупной намеренно:
          распределение длиннохвостое (одна сделка, зревшая полгода, тянет
          среднее вверх и выдаёт нетипичный срок за типичный). */}
      <Tile
        label="Цикл сделки"
        value={totals.cycleMedianDays !== null ? `${fmtDays(totals.cycleMedianDays)} дн.` : '—'}
        sub={
          totals.cycleAvgDays !== null
            ? `медиана · среднее: ${fmtDays(totals.cycleAvgDays)} дн. · оплат: ${fmt(totals.wonCount)}`
            : `оплат: ${fmt(totals.wonCount)}`
        }
        hint={
          'Сколько проходит от создания сделки до оплаты. Считается по сделкам, '
          + 'ОПЛАЧЕННЫМ в выбранном периоде, — сама сделка могла прийти раньше. '
          + 'Крупно медиана: половина сделок закрылась быстрее, половина дольше. '
          + 'Среднее выше медианы — значит несколько долгих сделок тянут его вверх.'
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
