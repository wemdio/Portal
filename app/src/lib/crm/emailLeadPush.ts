/**
 * Лид email-аутрича → сделка в CRM (наша AMO или amoCRM клиента).
 *
 * Спека: docs/superpowers/specs/2026-10-06-email-outreach-polza-crm-design.md.
 *
 * Ставит задачу квалификатор (`lib/instantly/leadQualificationWorker.ts`) в
 * момент вердикта «лид», если у проекта кампании включена передача в CRM.
 * Разбирает общая очередь `lib/crm/dealQueue.ts` в worker-tg-outreach.
 *
 * Почта лида уходит в стандартное поле Email контакта: тогда встроенная почта
 * amoCRM подтягивает переписку в ленту сделки и даёт отвечать прямо из AMO —
 * если ящик, с которого шла рассылка, подключён к AMO (настройка AMO, не наша).
 *
 * Модуль не тянет квалификатор: текст писем приходит уже извлечённым, чтобы
 * воркер очередей не грузил ИИ-зависимости ради сборки карточки.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { POLZA_SOURCE_EMAIL_OUTREACH } from './connections';
import { activeCrmSettings, processCrmQueue, type CrmLogFn, type CrmQueueRow } from './dealQueue';

export interface EmailLeadMessage {
  role: 'us' | 'lead';
  text: string;
  timestamp: string | null;
}

/** Сколько последних писем переписки класть в примечание. */
const MAX_MESSAGES = 20;
/** Длина одного письма в примечании: цитаты и подписи иногда тянутся на страницы. */
const MAX_MESSAGE_CHARS = 3000;

function fmtStamp(value: string | null, tzOffsetHours = 3): string {
  if (!value) return '';
  const t = new Date(value).getTime();
  if (!Number.isFinite(t)) return '';
  const d = new Date(t + tzOffsetHours * 3600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `[${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}] `;
}

/** Карточка лида — тот же вид, что у TG-аутрича: шапка, контакты, переписка. */
export function buildEmailLeadCard(input: {
  campaignName: string;
  leadEmail: string;
  leadName?: string | null;
  companyName?: string | null;
  phone?: string | null;
  messages: EmailLeadMessage[];
}): string {
  const lines = [`Лид · ${input.campaignName || 'email-аутрич'}`, '', `Почта: ${input.leadEmail}`];
  if (input.leadName) lines.push(`Имя: ${input.leadName}`);
  if (input.companyName) lines.push(`Компания: ${input.companyName}`);
  if (input.phone) lines.push(`Телефон: ${input.phone}`);
  const messages = input.messages
    .filter((m) => m.text.trim())
    .slice()
    .sort((a, b) => Date.parse(a.timestamp ?? '') - Date.parse(b.timestamp ?? ''))
    .slice(-MAX_MESSAGES);
  if (messages.length) {
    lines.push('', '── Переписка ──');
    for (const m of messages) {
      const text = m.text.trim();
      const clipped = text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text;
      lines.push(`${fmtStamp(m.timestamp)}${m.role === 'us' ? 'Мы' : 'Клиент'}: ${clipped}`);
    }
  }
  return lines.join('\n');
}

export type EmailEnqueueResult = 'queued' | 'disabled' | 'duplicate' | 'error';

/** Поставить лида в очередь CRM, если у проекта она включена. Не бросает. */
export async function enqueueEmailLeadCrmPush(mainDb: SupabaseClient, args: {
  projectId: string;
  qualificationId: string;
  campaignId: string | null;
  campaignName: string;
  leadEmail: string;
  leadName?: string | null;
  companyName?: string | null;
  phone?: string | null;
  messageText: string;
  log?: CrmLogFn;
}): Promise<EmailEnqueueResult> {
  const log = args.log ?? (() => {});
  try {
    const { data: project, error: projErr } = await mainDb
      .from('projects')
      .select('crm_settings')
      .eq('id', args.projectId)
      .maybeSingle();
    if (projErr) throw new Error(projErr.message);
    const settings = activeCrmSettings((project as { crm_settings?: unknown } | null)?.crm_settings);
    if (!settings) return 'disabled';

    const { error } = await mainDb.from('email_lead_crm_pushes').insert({
      project_id: args.projectId,
      qualification_id: args.qualificationId,
      campaign_id: args.campaignId,
      campaign_name: args.campaignName,
      lead_email: args.leadEmail,
      lead_name: args.leadName ?? null,
      company_name: args.companyName ?? null,
      phone: args.phone ?? null,
      connection: settings.connection,
      pipeline_id: settings.pipeline_id,
      status_id: settings.status_id,
      message_text: args.messageText,
    });
    if (error) {
      // Уникальный индекс: у этой почты в проекте сделка уже есть или в очереди.
      if (error.code === '23505') return 'duplicate';
      throw new Error(error.message);
    }
    log('info', `CRM: ${args.leadEmail} поставлен в очередь на создание сделки (${args.campaignName})`);
    return 'queued';
  } catch (err) {
    log('warning', `CRM: не смог поставить ${args.leadEmail} в очередь — ${err instanceof Error ? err.message : String(err)}`);
    return 'error';
  }
}

interface EmailPushRow extends CrmQueueRow {
  campaign_name: string;
  lead_email: string;
  lead_name: string | null;
  company_name: string | null;
  phone: string | null;
}

/** Один проход по очереди email-лидов. */
export async function processEmailLeadCrmPushes(db: SupabaseClient, log: CrmLogFn): Promise<number> {
  return processCrmQueue<EmailPushRow>(db, {
    table: 'email_lead_crm_pushes',
    extraColumns: 'campaign_name, lead_email, lead_name, company_name, phone',
    log,
    toDeal: (row) => {
      const who = row.company_name || row.lead_name || row.lead_email;
      return {
        contact: {
          name: row.lead_name?.trim() || row.lead_email,
          email: row.lead_email,
          phone: row.phone,
        },
        leadName: row.campaign_name ? `${who} · ${row.campaign_name}` : who,
        tags: [],
        polzaSource: POLZA_SOURCE_EMAIL_OUTREACH,
        label: `${row.lead_email} (${row.campaign_name})`,
      };
    },
  });
}
