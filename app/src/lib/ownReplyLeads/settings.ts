import type { SupabaseClient } from '@supabase/supabase-js';
import { LEAD_CRITERIA_MAX } from '@/lib/senderLeads/settings';
import { isEnAgencyCampaign } from '@/lib/instantly/ownAgencyCampaign';

/**
 * Блок «Instantly · наши кампании» вкладки «Квалификация»: ответы наших кампаний
 * («N. Polza_…» и «ENagency …») → оценка ИИ → сделка в нашей AMO
 * (docs/superpowers/specs/2026-10-11-polza-email-reply-leads-amo-design.md).
 *
 * Куда и кому ставить сделку — решение пользователя 11.10.2026, по id
 * (правило «этапы AMO только по id»): удалят этап и создадут заново — id новый.
 */
export const OWN_REPLY_PIPELINE_ID = 7670334; // «Воронка - новые лиды»
export const OWN_REPLY_STATUS_ID = 63385358; // «Новый лид»
export const OWN_REPLY_RESPONSIBLE_USER_ID = 12036498; // Егор Каныгин (решение 14.10.2026, как у RU/EN автоаутрича)
export const OWN_REPLY_TAG = 'портал';

export interface OwnReplySettings {
  enabled: boolean;
  enabledAt: string | null;
  cursorAt: string | null;
  cursorId: string | null;
}

interface SettingsRow {
  enabled: boolean;
  enabled_at: string | null;
  inbox_cursor_at: string | null;
  inbox_cursor_id: string | null;
}

const COLUMNS = 'enabled, enabled_at, inbox_cursor_at, inbox_cursor_id';

export async function loadOwnReplySettings(db: Pick<SupabaseClient, 'from'>): Promise<OwnReplySettings> {
  const { data, error } = await db.from('own_reply_lead_settings').select(COLUMNS).eq('id', 1).maybeSingle();
  if (error) throw new Error(`own_reply_lead_settings: ${error.message}`);
  const row = data as SettingsRow | null;
  return {
    enabled: Boolean(row?.enabled),
    enabledAt: row?.enabled_at ?? null,
    cursorAt: row?.inbox_cursor_at ?? null,
    cursorId: row?.inbox_cursor_id ?? null,
  };
}

export async function saveInboxCursor(db: Pick<SupabaseClient, 'from'>, at: string, id: string): Promise<void> {
  const { error } = await db
    .from('own_reply_lead_settings')
    .update({ inbox_cursor_at: at, inbox_cursor_id: id })
    .eq('id', 1);
  if (error) throw new Error(`own_reply_lead_settings cursor: ${error.message}`);
}

/**
 * «Что считать лидом» для наших кампаний — правило автоаутрича того же языка
 * (решение пользователя 27.10.2026): «N. Polza_…» — папки auto_ru, «ENagency …» —
 * auto_en. Правится в одном месте, на вкладке «Квалификация» автоаутрича.
 */
export interface OwnLeadCriteria {
  ru: string | null;
  en: string | null;
}

export async function loadOwnLeadCriteria(db: Pick<SupabaseClient, 'from'>): Promise<OwnLeadCriteria> {
  const { data, error } = await db.from('sender_folders').select('key, lead_criteria').in('key', ['auto_ru', 'auto_en']);
  if (error) throw new Error(`sender_folders: ${error.message}`);
  const out: OwnLeadCriteria = { ru: null, en: null };
  for (const row of (data ?? []) as Array<{ key: string; lead_criteria: string | null }>) {
    const text = row.lead_criteria?.trim() ?? '';
    out[row.key === 'auto_en' ? 'en' : 'ru'] = text ? text.slice(0, LEAD_CRITERIA_MAX) : null;
  }
  return out;
}

export function criteriaForCampaign(criteria: OwnLeadCriteria, campaignName: string | null | undefined): string | null {
  return isEnAgencyCampaign(campaignName) ? criteria.en : criteria.ru;
}

export interface OwnReplySettingsDto {
  enabled: boolean;
  enabledAt: string | null;
}

export function ownReplySettingsDto(s: OwnReplySettings): OwnReplySettingsDto {
  return { enabled: s.enabled, enabledAt: s.enabledAt };
}

export function parseOwnReplySettingsInput(body: unknown):
  | { ok: true; value: { enabled: boolean } }
  | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Невалидный JSON' };
  const { enabled } = body as Record<string, unknown>;
  if (typeof enabled !== 'boolean') return { ok: false, error: 'enabled — да/нет' };
  return { ok: true, value: { enabled } };
}

/**
 * Что записать при сохранении. Включение после выключения ставит новую точку
 * отсчёта: ответы, пришедшие пока блок был выключен, не оцениваются.
 */
export function ownReplySettingsPatch(
  prev: OwnReplySettings,
  input: { enabled: boolean },
  nowIso: string,
  userId: string | null,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    enabled: input.enabled,
    updated_at: nowIso,
    updated_by: userId,
  };
  if (input.enabled && !prev.enabled) {
    patch.enabled_at = nowIso;
    patch.inbox_cursor_at = nowIso;
    patch.inbox_cursor_id = '';
  }
  return patch;
}
