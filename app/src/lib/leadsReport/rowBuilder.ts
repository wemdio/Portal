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

/** Собирает строку для листа по конфигу — массив ячеек в порядке колонок. */
export function buildRow(
  lead: AmoLead,
  config: LeadsReportConfig,
  amoHost: string,
): string[] {
  const utm = extractUtm(lead.raw);
  const platform = mapPlatform(utm);

  const values: Record<ColumnKey, string> = {
    amo_url: `https://${amoHost}/leads/detail/${lead.amo_id}`,
    amo_id_raw: String(lead.amo_id),
    utm_block: formatUtmBlock(lead.raw),
    platform,
    category: mapCategory(platform),
    created_at_short: lead.created_at ? lead.created_at.slice(0, 10) : '',
    phone: lead.contact_phone ?? '',
    email: lead.contact_email ?? '',
    name: lead.name ?? '',
    responsible_name: lead.responsible_name ?? '',
    company_name: lead.company_name ?? '',
    company_website: lead.company_website ?? '',
    status_name: lead.status_name ?? '',
  };

  return config.columns.map((col) => values[col.key]);
}
