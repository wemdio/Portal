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
  criteria: OwnLeadCriteria;
  aiEnabledRu: boolean;
  aiEnabledEn: boolean;
  aiEnabledAtRu: string | null;
  aiEnabledAtEn: string | null;
}

interface SettingsRow {
  enabled: boolean;
  enabled_at: string | null;
  inbox_cursor_at: string | null;
  inbox_cursor_id: string | null;
  lead_criteria_ru: string | null;
  lead_criteria_en: string | null;
  ai_enabled_ru: boolean;
  ai_enabled_en: boolean;
  ai_enabled_at_ru: string | null;
  ai_enabled_at_en: string | null;
}

const COLUMNS = 'enabled, enabled_at, inbox_cursor_at, inbox_cursor_id, lead_criteria_ru, lead_criteria_en, ai_enabled_ru, ai_enabled_en, ai_enabled_at_ru, ai_enabled_at_en';

function cleanCriteria(value: string | null | undefined): string | null {
  const text = value?.trim() ?? '';
  return text ? text.slice(0, LEAD_CRITERIA_MAX) : null;
}

export async function loadOwnReplySettings(db: Pick<SupabaseClient, 'from'>): Promise<OwnReplySettings> {
  const { data, error } = await db.from('own_reply_lead_settings').select(COLUMNS).eq('id', 1).maybeSingle();
  if (error) throw new Error(`own_reply_lead_settings: ${error.message}`);
  const row = data as SettingsRow | null;
  return {
    enabled: Boolean(row?.enabled),
    enabledAt: row?.enabled_at ?? null,
    cursorAt: row?.inbox_cursor_at ?? null,
    cursorId: row?.inbox_cursor_id ?? null,
    criteria: { ru: cleanCriteria(row?.lead_criteria_ru), en: cleanCriteria(row?.lead_criteria_en) },
    aiEnabledRu: Boolean(row?.ai_enabled_ru), aiEnabledEn: Boolean(row?.ai_enabled_en),
    aiEnabledAtRu: row?.ai_enabled_at_ru ?? null, aiEnabledAtEn: row?.ai_enabled_at_en ?? null,
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
 * «Что считать лидом» для наших кампаний — своё на язык: «N. Polza_…» — RU,
 * «ENagency …» — EN (own_reply_lead_settings.lead_criteria_ru/en). Решение
 * пользователя 28.10.2026: отдельно от правил автоаутрича («Рассылка»), которые
 * лежат в sender_folders. Пусто — общие правила квалификатора.
 */
export interface OwnLeadCriteria {
  ru: string | null;
  en: string | null;
}

export async function loadOwnLeadCriteria(db: Pick<SupabaseClient, 'from'>): Promise<OwnLeadCriteria> {
  return (await loadOwnReplySettings(db)).criteria;
}

export function criteriaForCampaign(criteria: OwnLeadCriteria, campaignName: string | null | undefined): string | null {
  return isEnAgencyCampaign(campaignName) ? criteria.en : criteria.ru;
}

export interface OwnReplySettingsDto {
  enabled: boolean;
  enabledAt: string | null;
  criteriaRu: string;
  criteriaEn: string;
  aiEnabledRu: boolean;
  aiEnabledEn: boolean;
}

export function ownReplySettingsDto(s: OwnReplySettings): OwnReplySettingsDto {
  return { enabled: s.enabled, enabledAt: s.enabledAt, criteriaRu: s.criteria.ru ?? '', criteriaEn: s.criteria.en ?? '', aiEnabledRu: s.aiEnabledRu, aiEnabledEn: s.aiEnabledEn };
}

export interface OwnReplySettingsInput {
  enabled: boolean;
  /** undefined — не менять; '' — очистить (общие правила квалификатора). */
  criteriaRu?: string;
  criteriaEn?: string;
  aiEnabledRu?: boolean;
  aiEnabledEn?: boolean;
}

export function parseOwnReplySettingsInput(body: unknown):
  | { ok: true; value: OwnReplySettingsInput }
  | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Невалидный JSON' };
  const { enabled, criteriaRu, criteriaEn, aiEnabledRu, aiEnabledEn } = body as Record<string, unknown>;
  if (typeof enabled !== 'boolean') return { ok: false, error: 'enabled — да/нет' };
  const value: OwnReplySettingsInput = { enabled };
  for (const [key, raw] of [['criteriaRu', criteriaRu], ['criteriaEn', criteriaEn]] as const) {
    if (raw === undefined) continue;
    if (typeof raw !== 'string') return { ok: false, error: 'Что считать лидом — текст' };
    if (raw.trim().length > LEAD_CRITERIA_MAX) return { ok: false, error: `Что считать лидом — не длиннее ${LEAD_CRITERIA_MAX} символов` };
    value[key] = raw.trim();
  }
  if (aiEnabledRu !== undefined && typeof aiEnabledRu !== 'boolean') return { ok: false, error: 'ИИ RU — да/нет' };
  if (aiEnabledEn !== undefined && typeof aiEnabledEn !== 'boolean') return { ok: false, error: 'ИИ EN — да/нет' };
  if (aiEnabledRu !== undefined) value.aiEnabledRu = aiEnabledRu;
  if (aiEnabledEn !== undefined) value.aiEnabledEn = aiEnabledEn;
  return { ok: true, value };
}

/**
 * Что записать при сохранении. Включение после выключения ставит новую точку
 * отсчёта: ответы, пришедшие пока блок был выключен, не оцениваются.
 */
export function ownReplySettingsPatch(
  prev: OwnReplySettings,
  input: OwnReplySettingsInput,
  nowIso: string,
  userId: string | null,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    enabled: input.enabled,
    updated_at: nowIso,
    updated_by: userId,
  };
  if (input.criteriaRu !== undefined) patch.lead_criteria_ru = input.criteriaRu || null;
  if (input.criteriaEn !== undefined) patch.lead_criteria_en = input.criteriaEn || null;
  if (input.aiEnabledRu !== undefined) {
    patch.ai_enabled_ru = input.aiEnabledRu;
    if (input.aiEnabledRu && !prev.aiEnabledRu) patch.ai_enabled_at_ru = nowIso;
  }
  if (input.aiEnabledEn !== undefined) {
    patch.ai_enabled_en = input.aiEnabledEn;
    if (input.aiEnabledEn && !prev.aiEnabledEn) patch.ai_enabled_at_en = nowIso;
  }
  if (input.enabled && !prev.enabled) {
    patch.enabled_at = nowIso;
    patch.inbox_cursor_at = nowIso;
    patch.inbox_cursor_id = '';
  }
  return patch;
}
