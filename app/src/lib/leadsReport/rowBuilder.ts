import { extractUtm } from '@/lib/leadsReport/extractUtm';
import {
  mapPlatform,
  mapCategory,
} from '@/lib/leadsReport/platformMapper';
import type {
  ColumnKey,
  LeadsReportConfig,
} from '@/lib/leadsReport/config';

export type AmoLead = {
  amo_id: number;
  name: string | null;
  status_name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  company_name: string | null;
  company_website: string | null;
  responsible_name: string | null;
  created_at: string | null; // ISO
  raw: unknown;
};

/**
 * Возвращает то, что записать в колонку «Имя».
 *
 * AMO хранит контакт отдельной сущностью и `amo_leads.name` — это ИМЯ САМОЙ
 * СДЕЛКИ, а не контакта. Приоритет (сверху вниз):
 *   1. «Бот: <имя>»      → «<имя>» (TG-бот кладёт реальное имя после префикса)
 *   2. «Сделка #NNN»     → ссылка на сделку в AMO (менеджер откроет по клику,
 *                          там уже есть контакт с именем)
 *   3. Всё остальное     → как есть, в т.ч. «Заявка: <домен>», компании,
 *                          заранее заполненные имена — их не переделываем.
 *   4. Пустое имя        → тоже ссылка на сделку.
 */
function pickNameColumn(dealName: string | null, amoUrl: string): string {
  const trimmed = (dealName ?? '').trim();
  if (!trimmed) return amoUrl;
  const botMatch = /^Бот:\s*(.+)$/i.exec(trimmed);
  if (botMatch) return botMatch[1].trim();
  if (/^Сделка\s*#/i.test(trimmed)) return amoUrl;
  return trimmed;
}

/** Форматирует UTM в многострочный текстовый блок (как у Максима сейчас). */
function formatUtmBlock(raw: unknown): string {
  const utm = extractUtm(raw);
  const lines: string[] = [];
  if (utm.source) lines.push(`UTM source: ${utm.source}`);
  if (utm.medium) lines.push(`UTM medium: ${utm.medium}`);
  if (utm.campaign) lines.push(`UTM campaign: ${utm.campaign}`);
  if (utm.content) lines.push(`UTM content: ${utm.content}`);
  if (utm.term) lines.push(`UTM term: ${utm.term}`);
  return lines.join('\n');
}

/** ISO-строку `2026-07-01T10:15:00Z` в русский формат `01.07.2026`. */
function formatMskDate(iso: string | null): string {
  if (!iso) return '';
  const yyyyMmDd = iso.slice(0, 10); // '2026-07-01'
  const [yyyy, mm, dd] = yyyyMmDd.split('-');
  if (!yyyy || !mm || !dd) return '';
  return `${dd}.${mm}.${yyyy}`;
}

/** Собирает строку для листа по конфигу — массив ячеек в порядке колонок. */
export function buildRow(
  lead: AmoLead,
  config: LeadsReportConfig,
  amoHost: string,
): string[] {
  const utm = extractUtm(lead.raw);
  const platform = mapPlatform(utm);

  const amoUrl = `https://${amoHost}/leads/detail/${lead.amo_id}`;
  const values: Record<ColumnKey, string> = {
    amo_url: amoUrl,
    amo_id_raw: String(lead.amo_id),
    utm_block: formatUtmBlock(lead.raw),
    platform,
    category: mapCategory(platform),
    created_at_short: formatMskDate(lead.created_at),
    phone: lead.contact_phone ?? '',
    email: lead.contact_email ?? '',
    name: pickNameColumn(lead.name, amoUrl),
    responsible_name: lead.responsible_name ?? '',
    company_name: lead.company_name ?? '',
    company_website: lead.company_website ?? '',
    status_name: lead.status_name ?? '',
    empty: '',
  };

  return config.columns.map((col) => values[col.key]);
}
