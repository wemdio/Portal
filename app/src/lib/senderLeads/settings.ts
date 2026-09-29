import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Настройки квалификатора ответов «Рассылки» — у папки рассылок.
 *
 * Живут в базе (sender_folders), а не в env: вкладка «Квалификация»
 * автоаутрича сохраняет их, воркер перечитывает на каждом круге, и правка
 * применяется без перезапуска. Рассылка без папки (ручная) получает значения
 * по умолчанию: оценивать и слать в чат, общие правила.
 */

export const LEAD_CRITERIA_MAX = 2000;

export interface LeadSettings {
  folderId: string | null;
  folderKey: string | null;
  folderName: string | null;
  enabled: boolean;
  telegram: boolean;
  criteria: string | null;
}

export const DEFAULT_LEAD_SETTINGS: LeadSettings = {
  folderId: null,
  folderKey: null,
  folderName: null,
  enabled: true,
  telegram: true,
  criteria: null,
};

interface FolderRow {
  id: string;
  key: string;
  name: string;
  lead_criteria: string | null;
  leads_enabled: boolean;
  leads_telegram: boolean;
}

export function settingsFromFolder(row: FolderRow): LeadSettings {
  const criteria = row.lead_criteria?.trim() ?? '';
  return {
    folderId: row.id,
    folderKey: row.key,
    folderName: row.name,
    enabled: row.leads_enabled,
    telegram: row.leads_telegram,
    criteria: criteria ? criteria.slice(0, LEAD_CRITERIA_MAX) : null,
  };
}

/** Настройки для набора рассылок: id рассылки → настройки её папки. */
export async function loadCampaignSettings(
  db: SupabaseClient,
  campaignIds: string[],
): Promise<Map<string, { settings: LeadSettings; campaignName: string }>> {
  const out = new Map<string, { settings: LeadSettings; campaignName: string }>();
  const ids = Array.from(new Set(campaignIds));
  if (!ids.length) return out;

  const { data, error } = await db
    .from('sender_campaigns')
    .select('id, name, sender_folders(id, key, name, lead_criteria, leads_enabled, leads_telegram)')
    .in('id', ids);
  if (error) throw new Error(`sender_campaigns: ${error.message}`);

  for (const row of (data ?? []) as Array<{ id: string; name: string; sender_folders: FolderRow | FolderRow[] | null }>) {
    const folder = Array.isArray(row.sender_folders) ? row.sender_folders[0] ?? null : row.sender_folders;
    out.set(row.id, {
      settings: folder ? settingsFromFolder(folder) : DEFAULT_LEAD_SETTINGS,
      campaignName: row.name,
    });
  }
  return out;
}
