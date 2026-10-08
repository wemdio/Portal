/**
 * Кто сделал диалог лидом: ИИ по положительному триггеру или сотрудник руками.
 *
 * Статус «Лид» ставят три пути — ИИ по триггеру, кнопка «Передать лида» и
 * кнопка статуса «Лид» на карточке, — и на экране они были неразличимы:
 * метка автопересылки и плашка «Передан: лид» есть только у кампаний с чатом
 * пересылки, а имя нажавшего оставалось в журнале. 08.10.2026 операторы
 * попросили видеть, какие лиды передали они сами. Поля описаны в миграции
 * 20261008_0010_tg_outreach_dialogs_lead_mark.
 *
 * Модуль без серверных зависимостей: подпись нужна и экрану.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export type LeadSource = 'ai' | 'manual';

export interface LeadMarkFields {
  lead_source?: LeadSource | null;
  lead_marked_by?: string | null;
  lead_marked_by_name?: string | null;
  lead_marked_at?: string | null;
}

/** Фильтр списка диалогов «Передал»: мои, от ИИ, все ручные. */
export type LeadByFilter = 'me' | 'ai' | 'manual';

export function parseLeadByFilter(value: string | null): LeadByFilter | null {
  return value === 'me' || value === 'ai' || value === 'manual' ? value : null;
}

type PortalUser = { id: string; email?: string | null; user_metadata?: Record<string, unknown> | null };

/** Человеческое имя того, кто нажал кнопку — из данных входа, без запроса к базе. */
export function operatorName(user: Omit<PortalUser, 'id'>): string {
  const meta = user.user_metadata ?? {};
  const named = [meta.full_name, meta.name, meta.username].find(
    (v): v is string => typeof v === 'string' && v.trim() !== '',
  );
  return named ?? user.email ?? 'сотрудник портала';
}

/**
 * Метка «лид отметил сотрудник». Имя — из профиля портала: в данных входа у
 * многих вместо имени только почта, и подпись выходила «dima.kulaga5».
 * Свой профиль сотрудник читает всегда, поэтому хватает его же клиента.
 */
export async function manualLeadMark(db: SupabaseClient, user: PortalUser): Promise<LeadMarkFields> {
  const { data } = await db.from('profiles').select('full_name').eq('id', user.id).maybeSingle();
  const profileName = (data as { full_name?: string | null } | null)?.full_name?.trim();
  return {
    lead_source: 'manual',
    lead_marked_by: user.id,
    lead_marked_by_name: profileName || operatorName(user),
    lead_marked_at: new Date().toISOString(),
  };
}

/** Метка «лида сделал ИИ» — по положительному триггеру в ответе. */
export function aiLeadMark(): LeadMarkFields {
  return {
    lead_source: 'ai',
    lead_marked_by: null,
    lead_marked_by_name: null,
    lead_marked_at: new Date().toISOString(),
  };
}

/**
 * Подпись рядом со статусом «Лид»: текст плашки и подсказка. null — метки нет.
 * `lead_marked_by_me` проставляет роут списка диалогов: экран не знает, кто вошёл.
 */
export function leadMarkLabel(
  fields: LeadMarkFields & { status?: string | null; lead_marked_by_me?: boolean },
): { text: string; title: string; mine: boolean } | null {
  if (fields.status !== 'lead' || !fields.lead_source) return null;
  const when = fields.lead_marked_at ? ` — ${new Date(fields.lead_marked_at).toLocaleString('ru-RU')}` : '';
  if (fields.lead_source === 'ai') {
    return { text: '🤖 ИИ', title: `Лидом сделал ИИ: в ответе сработал положительный триггер${when}`, mine: false };
  }
  const mine = fields.lead_marked_by_me === true;
  const name = fields.lead_marked_by_name?.trim();
  return {
    text: mine ? '👤 вы' : `👤 ${name || 'вручную'}`,
    title: `Лидом отметили вручную${name ? `: ${name}` : ''}${when}`,
    mine,
  };
}
