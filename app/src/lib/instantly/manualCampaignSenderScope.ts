import type { CampaignCreatePayload } from '@/lib/instantly/types';

type ManualCampaignPayload = Record<string, unknown>;

export type ManualCampaignSenderScopeResult =
  | { ok: true; mode: 'none' | 'emails'; payload: CampaignCreatePayload }
  | { ok: true; mode: 'tag'; tagId: string; payload: CampaignCreatePayload }
  | { ok: false; error: string };

/**
 * A campaign may use either an explicit mailbox list or one dynamic project
 * tag. The API route separately resolves the tag name and rejects reserve-pool
 * tags, which describe inventory rather than project ownership.
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
      mode: 'none',
      payload: { ...source } as unknown as CampaignCreatePayload,
    };
  }

  const hasEmailList = 'email_list' in source;
  const hasTagList = 'email_tag_list' in source;
  if (hasEmailList && hasTagList) {
    return { ok: false, error: 'Укажите либо тег проекта, либо конкретные ящики' };
  }

  if (hasTagList) {
    if (!Array.isArray(source.email_tag_list) || source.email_tag_list.length !== 1) {
      return { ok: false, error: 'Выберите один тег проекта' };
    }
    const [value] = source.email_tag_list;
    if (typeof value !== 'string' || !value.trim()) {
      return { ok: false, error: 'Некорректный тег проекта' };
    }
    const tagId = value.trim();
    return {
      ok: true,
      mode: 'tag',
      tagId,
      payload: { ...source, email_tag_list: [tagId] } as unknown as CampaignCreatePayload,
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
  return { ok: true, mode: 'emails', payload: payload as unknown as CampaignCreatePayload };
}
