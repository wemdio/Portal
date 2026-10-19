import type { SupabaseClient } from '@supabase/supabase-js';

export const HANDOFF_SCOPES = ['auto_ru', 'auto_en', 'own_ru', 'own_en'] as const;
export type HandoffScope = typeof HANDOFF_SCOPES[number];

export interface AgencyHandoffSettings {
  scope: HandoffScope;
  enabled: boolean;
  enabled_at: string | null;
  cc_emails: string[];
  colleague_text: string;
  self_text: string;
  /** Exact mailbox addresses that write as the person receiving the handoff. */
  self_sender_emails: string[];
}

export function handoffText(settings: AgencyHandoffSettings, senderEmail: string): string {
  return settings.self_sender_emails.includes(senderEmail.trim().toLowerCase())
    ? settings.self_text : settings.colleague_text;
}

const ADDRESS = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i;

export function parseHandoffSettings(body: unknown): AgencyHandoffSettings {
  if (!body || typeof body !== 'object') throw new Error('Неверные настройки');
  const b = body as Record<string, unknown>;
  if (!HANDOFF_SCOPES.includes(b.scope as HandoffScope) || typeof b.enabled !== 'boolean') {
    throw new Error('Выберите поток и режим отправки');
  }
  const addresses = (value: unknown, max: number): string[] => {
    if (!Array.isArray(value) || value.length > max || value.some(v => typeof v !== 'string' || !ADDRESS.test(v.trim()))) {
      throw new Error('Укажите корректные email-адреса без имён, каждый отдельно');
    }
    return [...new Set((value as string[]).map(v => v.trim().toLowerCase()))];
  };
  const cc = addresses(b.cc_emails, 10);
  const self = addresses(b.self_sender_emails, 100);
  if (b.enabled && !cc.length) throw new Error('Для отправки нужен адрес в копии');
  const text = (value: unknown): string => {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 3000) {
      throw new Error('Текст ответа должен содержать от 1 до 3000 символов');
    }
    return value.trim();
  };
  return { scope: b.scope as HandoffScope, enabled: b.enabled, enabled_at: null,
    cc_emails: cc, self_sender_emails: self,
    colleague_text: text(b.colleague_text), self_text: text(b.self_text) };
}

export async function loadHandoffSettings(db: SupabaseClient): Promise<AgencyHandoffSettings[]> {
  const { data, error } = await db.from('agency_lead_handoff_settings').select('*').order('scope');
  if (error) throw new Error(`Настройки передачи: ${error.message}`);
  return (data ?? []) as AgencyHandoffSettings[];
}
