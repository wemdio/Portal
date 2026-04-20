import type { Email, Lead } from './types';

export const INSTANTLY_INTEREST_LABELS: Record<number, string> = {
  0: 'Не обработан',
  1: 'Заинтересован',
  [-1]: 'Не заинтересован',
  [-2]: 'Ответ получен',
  [-3]: 'Неверный контакт',
};

export const UE_TYPE_LABELS: Record<number, string> = {
  1: 'Отправлено',
  2: 'Ответ лида',
  3: 'Наш ответ',
};

export type EmailExportRow = {
  'Дата': string;
  'Тип': string;
  'Email лида': string;
  'Имя': string;
  'Компания': string;
  'Должность': string;
  'Телефон': string;
  'Сайт': string;
  'LinkedIn': string;
  'Аккаунт-отправитель': string;
  'Тема': string;
  'Текст': string;
  'Статус Instantly': string;
  'Lead ID': string;
  'Email ID': string;
  'Thread ID': string;
};

function extractBodyText(body: Email['body']): string {
  if (!body) return '';
  if (typeof body === 'string') return body;
  if (body.text) return body.text;
  if (body.html) {
    return body.html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .trim();
  }
  return '';
}

/**
 * Builds export rows by joining emails with lead metadata.
 * Emails are sorted chronologically ascending by timestamp_email (fallback: timestamp_created).
 * Uses only Instantly-provided interest_status — does not reference any portal LLM statuses.
 */
export function buildEmailsExportRows(
  emails: Email[],
  leadsById: Map<string, Lead>,
): EmailExportRow[] {
  const sorted = [...emails].sort((a, b) => {
    const ta = a.timestamp_email ?? a.timestamp_created ?? '';
    const tb = b.timestamp_email ?? b.timestamp_created ?? '';
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  });

  return sorted.map((email): EmailExportRow => {
    const lead = email.lead ? leadsById.get(email.lead) : undefined;
    const interestStatus = lead?.interest_status;
    const name = [lead?.first_name, lead?.last_name].filter(Boolean).join(' ');

    return {
      'Дата': email.timestamp_email ?? email.timestamp_created ?? '',
      'Тип': UE_TYPE_LABELS[email.ue_type ?? 1] ?? '',
      'Email лида': lead?.email ?? '',
      'Имя': name,
      'Компания': lead?.company_name ?? '',
      'Должность': lead?.title ?? '',
      'Телефон': lead?.phone ?? '',
      'Сайт': lead?.website ?? '',
      'LinkedIn': lead?.linkedin_url ?? '',
      'Аккаунт-отправитель': email.eaccount ?? '',
      'Тема': email.subject ?? '',
      'Текст': extractBodyText(email.body),
      'Статус Instantly': interestStatus !== undefined
        ? (INSTANTLY_INTEREST_LABELS[interestStatus] ?? String(interestStatus))
        : '',
      'Lead ID': email.lead ?? '',
      'Email ID': email.id,
      'Thread ID': email.thread_id ?? '',
    };
  });
}
