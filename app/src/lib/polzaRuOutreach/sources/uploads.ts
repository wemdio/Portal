/**
 * Загруженные файлы сигналов: каталоги выставок, выгрузки госконтрактов ЕИС и
 * списки получателей грантов / участников акселераторов (Сколково, ФРИИ …).
 *
 * У обоих источников нет доступного API (проверено 22.09.2026): каталог
 * экспонентов у каждой выставки свой, ЕИС не отвечает из-за рубежа, а
 * агрегаторы требуют ключ. Оператор кладёт файл (Excel/CSV), строки лежат в
 * polza_ru_signal_rows, запуск «по сигналам» берёт их по окну дат.
 *
 * Заголовки колонок узнаём по синонимам — ЕИС и организаторы называют их
 * по-разному; неузнанные колонки сохраняются в details как есть.
 */

import * as XLSX from 'xlsx';
import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizeInn } from '../company';

export type UploadKind = 'exhibitors' | 'contracts' | 'growth';

type Field = 'company_name' | 'company_website' | 'inn' | 'record_url' | 'record_date' | 'stand' | 'category'
  | 'contract_number' | 'subject' | 'amount' | 'customer';

const ALIASES: Record<Field, RegExp> = {
  company_name: /^(?!.*заказчик)(компания|название|наименование|участник|экспонент|поставщик|исполнитель|победитель|company|name|exhibitor|supplier)/i,
  company_website: /^(сайт|веб|website|site|url сайта|www)/i,
  inn: /^(?!.*заказчик).*(^|\s)инн(\s|$)|^inn$/i,
  record_url: /^(ссылка|url|link|карточка)/i,
  record_date: /^(дата|date)/i,
  stand: /^(стенд|павильон|stand|booth)/i,
  category: /^(категори|раздел|тематик|category|рубрик)/i,
  contract_number: /(реестровый номер|номер контракта|№ контракта|номер|contract)/i,
  subject: /^(предмет|объект закупки|наименование объекта|subject)/i,
  amount: /^(цена|сумма|стоимость|amount|price)/i,
  customer: /заказчик|customer/i,
};

/** Сопоставление колонок: порядок важен — ИНН и сайт раньше общего «названия». */
const FIELD_ORDER: Field[] = [
  'inn', 'company_website', 'record_url', 'record_date', 'contract_number', 'subject', 'amount', 'customer',
  'stand', 'category', 'company_name',
];

export interface ParsedSignalRow {
  company_name: string;
  company_website: string | null;
  inn: string | null;
  record_url: string | null;
  record_date: string | null;
  details: Record<string, unknown>;
}

function parseDate(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const s = String(value ?? '').trim();
  const ru = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})/);
  if (ru) return `${ru[3]}-${ru[2].padStart(2, '0')}-${ru[1].padStart(2, '0')}`;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  return null;
}

function parseAmount(value: unknown): number | null {
  if (typeof value === 'number') return value;
  const n = Number(String(value ?? '').replace(/[^\d,.-]/g, '').replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Файл → строки. Бросает понятную ошибку, если не нашлась колонка с компанией. */
export function parseSignalFile(buffer: Buffer, kind: UploadKind): ParsedSignalRow[] {
  // raw: CSV читается как текст — иначе 19-значный реестровый номер ЕИС
  // превращается в число и теряет последние цифры.
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true, codepage: 65001, raw: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new Error('В файле нет листов');
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null, raw: true });
  if (!rows.length) return [];

  const headers = Object.keys(rows[0]);
  const mapping = new Map<string, Field>();
  const used = new Set<Field>();
  for (const field of FIELD_ORDER) {
    const header = headers.find((h) => !mapping.has(h) && ALIASES[field].test(h.trim()));
    if (header && !used.has(field)) {
      mapping.set(header, field);
      used.add(field);
    }
  }
  if (!used.has('company_name')) {
    throw new Error(`Не нашлась колонка с названием компании. Колонки файла: ${headers.join(', ')}`);
  }

  const out: ParsedSignalRow[] = [];
  for (const row of rows) {
    const picked: Partial<Record<Field, unknown>> = {};
    const extra: Record<string, unknown> = {};
    for (const [header, value] of Object.entries(row)) {
      const field = mapping.get(header);
      if (field) picked[field] = value;
      else if (value !== null && value !== '') extra[header] = value;
    }
    const name = String(picked.company_name ?? '').trim();
    if (!name) continue;
    const details: Record<string, unknown> =
      kind === 'contracts'
        ? {
            contract_number: picked.contract_number ? String(picked.contract_number).trim() : null,
            subject: picked.subject ? String(picked.subject).trim() : null,
            amount: parseAmount(picked.amount),
            customer: picked.customer ? String(picked.customer).trim() : null,
            extra,
          }
        : kind === 'growth'
        ? {
            program: picked.category ? String(picked.category).trim() : null,
            subject: picked.subject ? String(picked.subject).trim() : null,
            extra,
          }
        : {
            stand: picked.stand ? String(picked.stand).trim() : null,
            category: picked.category ? String(picked.category).trim() : null,
            extra,
          };
    out.push({
      company_name: name,
      company_website: picked.company_website ? String(picked.company_website).trim() : null,
      inn: normalizeInn(picked.inn),
      record_url: picked.record_url ? String(picked.record_url).trim() : null,
      record_date: parseDate(picked.record_date),
      details,
    });
  }
  return out;
}

export interface SignalUploadRow {
  id: string;
  upload_id: string;
  kind: UploadKind;
  company_name: string;
  company_website: string | null;
  inn: string | null;
  details: Record<string, unknown>;
  record_url: string | null;
  record_date: string | null;
  upload: {
    title: string;
    event_start: string | null;
    event_end: string | null;
    official_url: string | null;
    catalog_year: number | null;
  };
}

/**
 * Строки загрузок в окне свежести. Выставка — по дате события: окно контакта
 * T−90…T+14 (SPEC §4.1); контракт и грант — по дате записи за последние N дней
 * (у гранта без даты — по дате загрузки списка).
 */
export async function loadSignalRows(db: SupabaseClient, kind: UploadKind, freshnessDays: number): Promise<SignalUploadRow[]> {
  const { data: uploads, error: upErr } = await db
    .from('polza_ru_signal_uploads')
    .select('id,title,event_start,event_end,official_url,catalog_year,created_at')
    .eq('kind', kind);
  if (upErr) throw new Error(`signal uploads load failed: ${upErr.message}`);

  const now = Date.now();
  const day = 86_400_000;
  const activeUploads = (uploads ?? []).filter((u) => {
    if (kind === 'growth') return true;
    if (kind !== 'exhibitors') return true;
    if (!u.event_start) return false;
    const start = new Date(String(u.event_start)).getTime();
    const end = u.event_end ? new Date(String(u.event_end)).getTime() : start;
    return start - now <= 90 * day && now - end <= 14 * day;
  });
  if (!activeUploads.length) return [];
  const uploadById = new Map(activeUploads.map((u) => [String(u.id), u]));

  const rows: SignalUploadRow[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    let q = db
      .from('polza_ru_signal_rows')
      .select('id,upload_id,kind,company_name,company_website,inn,details,record_url,record_date')
      .in('upload_id', Array.from(uploadById.keys()))
      .range(from, from + PAGE - 1);
    const sinceDate = new Date(now - freshnessDays * day).toISOString().slice(0, 10);
    if (kind === 'contracts') q = q.gte('record_date', sinceDate);
    const { data, error } = await q;
    if (error) throw new Error(`signal rows load failed: ${error.message}`);
    for (const r of data ?? []) {
      const u = uploadById.get(String(r.upload_id));
      if (!u) continue;
      if (kind === 'growth') {
        const date = r.record_date ?? String(u.created_at ?? '').slice(0, 10);
        if (!date || date < sinceDate) continue;
      }
      rows.push({
        id: String(r.id),
        upload_id: String(r.upload_id),
        kind,
        company_name: String(r.company_name),
        company_website: r.company_website ?? null,
        inn: r.inn ?? null,
        details: (r.details ?? {}) as Record<string, unknown>,
        record_url: r.record_url ?? null,
        record_date: r.record_date ?? null,
        upload: {
          title: String(u.title),
          event_start: u.event_start ?? null,
          event_end: u.event_end ?? null,
          official_url: u.official_url ?? null,
          catalog_year: u.catalog_year ?? null,
        },
      });
    }
    if (!data || data.length < PAGE) break;
  }
  return rows;
}
