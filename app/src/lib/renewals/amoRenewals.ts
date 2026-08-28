import type { SupabaseClient } from '@supabase/supabase-js';

import { chunkArray, IN_CHUNK_SIZE } from '@/lib/cisLeads/batchedQuery';
import { SECONDARY_PIPELINE_ID } from '@/lib/renewals/funnel';
import type { ProjectPeriodRow, RenewalProjectRow } from '@/lib/renewals/metrics';

/**
 * Источник продлений для дашборда — воронка AMO «Вторичные (и не только)
 * продажи», а не портальная таблица `projects`.
 *
 * Почему переключились (28.08.2026). Плитки и таблица считались по строкам
 * `projects` с типом «Продление» — их заводят руками, и за август такая
 * строка нашлась ровно одна (Smartway_2, 159 000). Продажи при этом закрыли
 * за месяц пять продлений и вели их в AMO. Два учёта, ни один не полный,
 * расхождение всплыло в переписке с финансами. AMO — единый источник истины
 * по сделкам, поэтому дашборд идёт туда же.
 *
 * Что считается продлением: сделка воронки, которая ХОТЯ БЫ РАЗ дошла до
 * этапа «Продлено» (`sort` = 90). Именно «дошла», а не «стоит сейчас»:
 * продлённый клиент через месяц уезжает в «Паузу» или «Реанимацию», и по
 * текущему этапу продление молча исчезло бы из истории задним числом. Этапы
 * «Пауза»/«Отвал» имеют `sort` больше 90, так что сравнение «>= 90» тут тоже
 * не годится — только точное равенство плюс история переходов.
 *
 * Тип вторичной сделки («продление» / «реанимация» / «апсейл») на попадание в
 * цифру НЕ влияет: для финансов это всё оплата от текущего клиента. Тип виден
 * в колонке «Услуга», чтобы срез при желании делали глазами.
 *
 * Форма результата — `RenewalProjectRow`, та же, что раньше отдавала выборка
 * из `projects`. Это осознанно: `computeRenewalsMetrics`, `tableRows.ts` и
 * весь UI остаются нетронутыми, меняется только откуда берутся строки.
 */

/** «Продлено». Точное значение, не порог — см. шапку файла. */
export const RENEWED_SORT = 90;

/** «Счет / договор на продление» — из даты перехода сюда берём «дату договора». */
export const CONTRACT_SORT = 80;

export type AmoStatusRow = {
  status_id: number;
  status_name: string | null;
  sort: number | null;
};

export type AmoLeadRow = {
  amo_id: number;
  name: string | null;
  company_name: string | null;
  responsible_name: string | null;
  status_id: number | null;
  status_name: string | null;
  raw: unknown;
};

export type AmoStatusEventRow = {
  amo_deal_id: number;
  to_value: string | null;
  changed_at: string | null;
};

/** Поле «Сумма продления, ₽» в карточке AMO. */
const FIELD_AMOUNT = 'Сумма продления, ₽';
/** Поле «Дата оплаты продления» — именно оно, а не дата перетаскивания карточки. */
const FIELD_PAYMENT_DATE = 'Дата оплаты продления';
/** Поле «Тип вторичной сделки»: продление / реанимация / апсейл. */
const FIELD_DEAL_TYPE = 'Тип вторичной сделки';
/** Поле «KPI проекта» — свободный текст («20 лидов», «-»), не число. */
const FIELD_KPI = 'KPI проекта';
/** Поле «Дата окончания оплаченного периода» — конец ПРЕДЫДУЩЕГО периода. */
const FIELD_PAID_UNTIL = 'Дата окончания оплаченного периода';

const MSK_OFFSET_SECONDS = 3 * 60 * 60;
const UNIX_SECONDS_RE = /^\d{1,12}$/;
const ISO_DATE_PREFIX_RE = /^(\d{4}-\d{2}-\d{2})/;

/**
 * Читает первое значение кастомного поля карточки по имени.
 *
 * Ходим по `raw` (JSON карточки как его отдал AMO), а не по отдельной таблице
 * значений: такой таблицы в схеме нет, поля живут только в `raw`. Всё, что не
 * похоже на ожидаемую структуру, даёт `null` — карточка со сломанным `raw` не
 * должна валить весь дашборд.
 */
export function readCustomField(raw: unknown, fieldName: string): string | null {
  if (raw === null || typeof raw !== 'object') return null;
  const fields = (raw as { custom_fields_values?: unknown }).custom_fields_values;
  if (!Array.isArray(fields)) return null;
  for (const field of fields) {
    if (field === null || typeof field !== 'object') continue;
    if ((field as { field_name?: unknown }).field_name !== fieldName) continue;
    const values = (field as { values?: unknown }).values;
    if (!Array.isArray(values) || values.length === 0) return null;
    const first = values[0];
    if (first === null || typeof first !== 'object') return null;
    const value = (first as { value?: unknown }).value;
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    return text === '' ? null : text;
  }
  return null;
}

/**
 * Дата из поля AMO в ключ `YYYY-MM-DD` по МСК.
 *
 * AMO отдаёт даты unix-секундами полуночи по часовому поясу аккаунта (МСК),
 * то есть 21:00 UTC предыдущего дня. Резать такую метку по UTC — значит
 * стабильно получать вчерашний день, поэтому сдвигаем на +3 часа и читаем
 * через `getUTC*`. Тот же приём, что в `firstSales/buckets.ts`.
 *
 * Строку в формате ISO тоже принимаем: этим же разбором приходит `changed_at`
 * события, да и само поле в AMO при пересоздании может приехать текстом. Всё
 * остальное — `null`, дальше такая карточка попадёт в блок «без даты оплаты»,
 * а не тихо исчезнет.
 */
export function amoDateToDayKey(raw: string | null): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  if (UNIX_SECONDS_RE.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    const shifted = new Date((seconds + MSK_OFFSET_SECONDS) * 1000);
    if (Number.isNaN(shifted.getTime())) return null;
    const y = shifted.getUTCFullYear();
    const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
    const d = String(shifted.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  const iso = ISO_DATE_PREFIX_RE.exec(trimmed);
  return iso ? iso[1] : null;
}

/**
 * `changed_at` события в ключ дня по МСК.
 *
 * Отдельно от `amoDateToDayKey`: у события это полноценная метка времени с
 * часами (`2026-08-18T13:37:56Z`), и просто отрезать от неё первые десять
 * символов нельзя. Событие, случившееся в 00:30 МСК, записано как 21:30 UTC
 * предыдущего дня — без сдвига дата договора уехала бы на сутки назад.
 */
function eventDayKey(changedAt: string | null): string | null {
  if (changedAt === null) return null;
  const time = Date.parse(changedAt);
  if (Number.isNaN(time)) return null;
  const shifted = new Date(time + MSK_OFFSET_SECONDS * 1000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Сумма продления в вид, который понимает `parseAmount` из metrics.ts.
 *
 * Ноль возвращаем как `null`, а не как 0. В карточках он стоит там, где сумму
 * просто не заполнили (у отвалившихся сделок так и есть), и ноль в обороте
 * читался бы как «продлили бесплатно», да ещё и тянул бы вниз средний чек.
 * `null` уводит карточку в честную плитку «Без суммы».
 */
export function normalizeAmount(raw: string | null): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  // Разделители разрядов — обычный, неразрывный и узкий пробел: ровно тот
  // набор, что прощает `parseAmount` в metrics.ts.
  const numeric = Number(trimmed.replace(/[\s   ]/g, '').replace(',', '.'));
  if (Number.isFinite(numeric) && numeric === 0) return null;
  return trimmed;
}

export type AmoRenewalsData = {
  rows: RenewalProjectRow[];
  /**
   * История периодов в форме, которую ждёт `computeRenewalsMetrics` для
   * расчёта цикла. Раньше приходила из таблицы `project_periods`, теперь — из
   * поля «Дата окончания оплаченного периода» карточки: по смыслу это ровно
   * тот же «конец предыдущего оплаченного периода», просто заполняют его
   * продажи в AMO, а не портал.
   *
   * `period_start` при этом взять неоткуда, и это не потеря: расчёт цикла
   * читает только `period_end`.
   */
  periods: ProjectPeriodRow[];
};

/**
 * Собирает строки дашборда из выгрузки AMO.
 *
 * Чистая функция — вся работа с БД снаружи (`fetchAmoRenewals`), чтобы
 * правила «что считать продлением» проверялись тестами без Supabase.
 */
export function mapAmoRenewals(
  leads: AmoLeadRow[],
  statuses: AmoStatusRow[],
  events: AmoStatusEventRow[],
): AmoRenewalsData {
  const sortById = new Map<number, number>();
  for (const status of statuses) {
    if (status.sort !== null) sortById.set(Number(status.status_id), Number(status.sort));
  }

  const reachedRenewed = new Set<number>();
  for (const lead of leads) {
    const sort = lead.status_id === null ? undefined : sortById.get(Number(lead.status_id));
    if (sort === RENEWED_SORT) reachedRenewed.add(Number(lead.amo_id));
  }

  // Самый ранний переход в «Счет / договор на продление» — он и есть дата
  // договора. Именно ранний: сделка может вернуться на этап после правок в
  // документах, и тогда поздний переход соврал бы про длину цикла.
  const contractDayByDeal = new Map<number, string>();

  for (const event of events) {
    if (!event.to_value) continue;
    const sort = sortById.get(Number(event.to_value));
    if (sort === undefined) continue; // чужая воронка — её номеров нет в карте
    const dealId = Number(event.amo_deal_id);

    if (sort === RENEWED_SORT) reachedRenewed.add(dealId);

    if (sort === CONTRACT_SORT) {
      const day = eventDayKey(event.changed_at);
      const known = contractDayByDeal.get(dealId);
      if (day !== null && (known === undefined || day < known)) contractDayByDeal.set(dealId, day);
    }
  }

  const rows: RenewalProjectRow[] = [];
  const periods: ProjectPeriodRow[] = [];
  for (const lead of leads) {
    const dealId = Number(lead.amo_id);
    if (!reachedRenewed.has(dealId)) continue;

    const id = `amo-${dealId}`;
    const paidUntil = amoDateToDayKey(readCustomField(lead.raw, FIELD_PAID_UNTIL));
    if (paidUntil !== null) periods.push({ project_id: id, period_start: null, period_end: paidUntil });

    rows.push({
      // Префикс, а не голый номер: `id` уходит в React-ключи и стоит рядом со
      // строками другой природы — пусть по нему сразу читается, что это
      // сделка AMO, а не uuid проекта.
      id,
      // Название компании — то, чем клиента зовут финансы. Имя сделки
      // («Заявка с сайта — форма поп-ап…») для таблицы бесполезно, но лучше
      // пустой ячейки, поэтому идёт запасным вариантом.
      client: lead.company_name ?? lead.name,
      name: readCustomField(lead.raw, FIELD_DEAL_TYPE),
      project_type: 'Продление',
      budget: normalizeAmount(readCustomField(lead.raw, FIELD_AMOUNT)),
      payment_date: amoDateToDayKey(readCustomField(lead.raw, FIELD_PAYMENT_DATE)),
      contract_date: contractDayByDeal.get(dealId) ?? null,
      // Свободный текст: «20 лидов», «без KPI», «-». В число он не
      // превращается и не должен — в таблице показывается как есть.
      kpi_fact: readCustomField(lead.raw, FIELD_KPI),
      status: lead.status_name,
      manager: lead.responsible_name,
      specialist: null,
    });
  }

  return { rows, periods };
}

/** Тянет продления из воронки вторичных продаж AMO. */
export async function fetchAmoRenewals(db: SupabaseClient): Promise<AmoRenewalsData> {
  const { data: statusData, error: statusError } = await db
    .from('amo_statuses')
    .select('status_id, status_name, sort')
    .eq('pipeline_id', SECONDARY_PIPELINE_ID);
  if (statusError) throw new Error(`amo_statuses: ${statusError.message}`);
  const statuses = (statusData ?? []) as AmoStatusRow[];

  const { data: leadData, error: leadError } = await db
    .from('amo_leads')
    .select('amo_id, name, company_name, responsible_name, status_id, status_name, raw')
    .eq('pipeline_id', SECONDARY_PIPELINE_ID);
  if (leadError) throw new Error(`amo_leads: ${leadError.message}`);
  const leads = (leadData ?? []) as AmoLeadRow[];

  const events: AmoStatusEventRow[] = [];
  if (leads.length > 0) {
    // Порционируем `.in(...)`, как в funnel.ts и firstSales: одной строкой
    // список номеров упирается в лимит длины URL PostgREST.
    for (const chunk of chunkArray(leads.map((l) => Number(l.amo_id)), IN_CHUNK_SIZE)) {
      const { data, error } = await db
        .from('amo_events')
        .select('amo_deal_id, to_value, changed_at')
        .eq('event_type', 'lead_status_changed')
        .in('amo_deal_id', chunk);
      if (error) throw new Error(`amo_events: ${error.message}`);
      events.push(...((data ?? []) as AmoStatusEventRow[]));
    }
  }

  return mapAmoRenewals(leads, statuses, events);
}
