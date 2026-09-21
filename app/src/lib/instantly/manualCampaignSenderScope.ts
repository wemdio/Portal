import type { CampaignCreatePayload } from '@/lib/instantly/types';

type ManualCampaignPayload = Record<string, unknown>;

export type ManualCampaignSenderScopeResult =
  | { ok: true; payload: CampaignCreatePayload }
  | { ok: false; error: string };

/**
 * Manual campaigns must keep a fixed sender scope. Tags in this screen are a
 * convenient account filter, not an ownership boundary: pool tags can span
 * several clients and their membership can change after launch.
 */
export function normalizeManualCampaignSenderScope(
  input: unknown,
): ManualCampaignSenderScopeResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'Некорректные данные кампании' };
  }

  const source = input as ManualCampaignPayload;
  const hasSenderSelector = 'email_list' in source || 'email_tag_list' in source;
  if (!hasSenderSelector) {
    // Other Portal flows create an empty campaign first and configure it later.
    // They are outside this guard because they have no sender selector yet.
    return {
      ok: true,
      payload: { ...source } as unknown as CampaignCreatePayload,
    };
  }

  if (!Array.isArray(source.email_list)) {
    return { ok: false, error: 'Выберите хотя бы один ящик отправки' };
  }

  const emails: string[] = [];
  for (const value of source.email_list) {
    if (typeof value !== 'string' || !value.trim()) {
      return { ok: false, error: 'Список ящиков содержит некорректный адрес' };
    }
    const email = value.trim().toLowerCase();
    if (!emails.includes(email)) emails.push(email);
  }
  if (emails.length === 0) {
    return { ok: false, error: 'Выберите хотя бы один ящик отправки' };
  }

  const payload: ManualCampaignPayload = { ...source, email_list: emails };
  // Never persist the UI filter as a dynamic campaign sender selector. This
  // avoids a broad pool tag silently adding another client's mailbox later.
  delete payload.email_tag_list;
  return { ok: true, payload: payload as unknown as CampaignCreatePayload };
}
