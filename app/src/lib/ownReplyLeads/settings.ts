import type { SupabaseClient } from '@supabase/supabase-js';
import { DEFAULT_LEAD_CRITERIA, LEAD_CRITERIA_MAX, isDefaultLeadCriteria } from '@/lib/senderLeads/settings';

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
  criteria: string | null;
  cursorAt: string | null;
  cursorId: string | null;
}

interface SettingsRow {
  enabled: boolean;
  enabled_at: string | null;
  lead_criteria: string | null;
  inbox_cursor_at: string | null;
  inbox_cursor_id: string | null;
}

const COLUMNS = 'enabled, enabled_at, lead_criteria, inbox_cursor_at, inbox_cursor_id';

export async function loadOwnReplySettings(db: Pick<SupabaseClient, 'from'>): Promise<OwnReplySettings> {
  const { data, error } = await db.from('own_reply_lead_settings').select(COLUMNS).eq('id', 1).maybeSingle();
  if (error) throw new Error(`own_reply_lead_settings: ${error.message}`);
  const row = data as SettingsRow | null;
  const criteria = row?.lead_criteria?.trim() ?? '';
  return {
    enabled: Boolean(row?.enabled),
    enabledAt: row?.enabled_at ?? null,
    criteria: criteria ? criteria.slice(0, LEAD_CRITERIA_MAX) : null,
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

export interface OwnReplySettingsDto {
  enabled: boolean;
  enabledAt: string | null;
  criteria: string;
}

export function ownReplySettingsDto(s: OwnReplySettings): OwnReplySettingsDto {
  // Своего правила нет — показываем пересказ общих правил, как у папок «Рассылки».
  return { enabled: s.enabled, enabledAt: s.enabledAt, criteria: s.criteria ?? DEFAULT_LEAD_CRITERIA };
}

export function parseOwnReplySettingsInput(body: unknown):
  | { ok: true; value: { enabled: boolean; criteria: string | null } }
  | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Невалидный JSON' };
  const { enabled, criteria } = body as Record<string, unknown>;
  if (typeof enabled !== 'boolean') return { ok: false, error: 'enabled — да/нет' };
  if (criteria != null && typeof criteria !== 'string') return { ok: false, error: 'criteria — текст' };
  const text = (criteria ?? '').trim();
  if (text.length > LEAD_CRITERIA_MAX) return { ok: false, error: `Правило длиннее ${LEAD_CRITERIA_MAX} символов` };
  return { ok: true, value: { enabled, criteria: !text || isDefaultLeadCriteria(text) ? null : text } };
}

/**
 * Что записать при сохранении. Включение после выключения ставит новую точку
 * отсчёта: ответы, пришедшие пока блок был выключен, не оцениваются.
 */
export function ownReplySettingsPatch(
  prev: OwnReplySettings,
  input: { enabled: boolean; criteria: string | null },
  nowIso: string,
  userId: string | null,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    enabled: input.enabled,
    lead_criteria: input.criteria,
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
