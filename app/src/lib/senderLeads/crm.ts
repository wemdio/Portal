import type { SupabaseClient } from '@supabase/supabase-js';
import { AMO_NOTE_MAX_CHARS, isTransientAmoError } from '@/lib/crm/amoClient';
import {
  POLZA_CONNECTION, POLZA_CONTOUR_FIELD_ID, POLZA_SOURCE_FIELD_ID,
  resolveCrmConnection,
} from '@/lib/crm/connections';
import { leadMessageNote } from './telegram';
import type { Log } from './process';

/** Same first-sales destination as other agency email leads. */
const PIPELINE_ID = 7670334;
const NEW_LEAD_STATUS_ID = 63385358;
const RESPONSIBLE_USER_ID = 10539886;
const SUB_SOURCE_FIELD_ID = 1314381;
const BATCH = 1;
const MAX_ATTEMPTS = 5;
const RETRY_MS = 5 * 60_000;
const LEASE_MS = 10 * 60_000;

interface PushRow {
  id: string;
  reply_id: string;
  recipient_id: string;
  lead_email: string;
  contact_name: string;
  company_name: string | null;
  sub_source: 'Автоаутрич RU' | 'Автоаутрич EN';
  telegram_html: string;
  attempts: number;
  amo_contact_id: number | null;
  amo_company_id: number | null;
  amo_lead_id: number | null;
  action: 'created' | 'note_added' | null;
  note_sent_at: string | null;
}

const COLUMNS = 'id, reply_id, recipient_id, lead_email, contact_name, company_name, sub_source, telegram_html, attempts, amo_contact_id, amo_company_id, amo_lead_id, action, note_sent_at';

async function patch(db: SupabaseClient, id: string, values: Record<string, unknown>): Promise<void> {
  const { data, error } = await db.from('sender_auto_lead_crm_pushes')
    .update({ ...values, updated_at: new Date().toISOString() }).eq('id', id).select('id').maybeSingle();
  if (error) throw new Error(`sender_auto_lead_crm_pushes update: ${error.message}`);
  if (!data) throw new Error(`sender_auto_lead_crm_pushes ${id} disappeared during AMO handoff`);
}

async function pushOne(db: SupabaseClient, row: PushRow, log: Log): Promise<void> {
  try {
    const { data: recipient, error: recipientError } = await db.from('sender_recipients')
      .select('lead_verdict, lead_verdict_source').eq('id', row.recipient_id).maybeSingle();
    if (recipientError) throw new Error(`sender_recipients: ${recipientError.message}`);
    if (recipient?.lead_verdict_source === 'manual' && recipient.lead_verdict === 'not_lead') {
      await patch(db, row.id, { status: 'skipped', error_message: 'Человек отметил «не лид»' });
      return;
    }
    const { client } = await resolveCrmConnection(db, POLZA_CONNECTION);
    let contactId = row.amo_contact_id;
    let companyId = row.amo_company_id;
    let leadId = row.amo_lead_id;
    let action = row.action;

    if (!contactId) {
      contactId = await client.findContactByEmail(row.lead_email)
        ?? await client.createContact({ name: row.contact_name, email: row.lead_email });
      await patch(db, row.id, { amo_contact_id: contactId });
    }

    if (!leadId) {
      leadId = await client.findOpenLeadOfContact(contactId);
      if (leadId) {
        action = 'note_added';
        await patch(db, row.id, {
          amo_lead_id: leadId, action,
          lead_url: `${client.baseUrl}/leads/detail/${leadId}`,
        });
      } else {
        if (row.company_name) {
          if (!companyId) {
            companyId = await client.findCompanyByName(row.company_name)
              ?? await client.createCompany(row.company_name);
            await patch(db, row.id, { amo_company_id: companyId });
          }
          await client.linkContactCompany(contactId, companyId);
        }

        const [source, contour] = await Promise.all([
          client.findLeadFieldEnumId(POLZA_SOURCE_FIELD_ID, 'Автоаутрич'),
          client.findLeadFieldEnumId(POLZA_CONTOUR_FIELD_ID, 'Email-outreach'),
        ]);
        if (!source || !contour) {
          throw new Error(`В AMO не найдены варианты полей: ${!source ? 'Источник = Автоаутрич' : ''}${!source && !contour ? ', ' : ''}${!contour ? 'Контур = Email-outreach' : ''}`);
        }
        leadId = await client.createLead({
          name: (row.company_name || row.contact_name).slice(0, 250),
          pipelineId: PIPELINE_ID,
          statusId: NEW_LEAD_STATUS_ID,
          responsibleUserId: RESPONSIBLE_USER_ID,
          contactId,
          companyId,
          tags: ['портал'],
          customFields: [
            { field_id: POLZA_SOURCE_FIELD_ID, values: [{ enum_id: source }] },
            { field_id: POLZA_CONTOUR_FIELD_ID, values: [{ enum_id: contour }] },
            { field_id: SUB_SOURCE_FIELD_ID, values: [{ value: row.sub_source }] },
          ],
        });
        action = 'created';
        await patch(db, row.id, {
          amo_lead_id: leadId, action,
          lead_url: `${client.baseUrl}/leads/detail/${leadId}`,
        });
      }
    }

    // The marker makes a retry after an AMO timeout or DB write failure safe.
    const marker = `[Portal sender reply ${row.reply_id}]`;
    const note = `${leadMessageNote(row.telegram_html)}\n\n${marker}`;
    if (note.length > AMO_NOTE_MAX_CHARS) throw new Error('Сообщение для примечания AMO слишком длинное');
    if (!row.note_sent_at) {
      if (!(await client.findLeadNoteContaining(leadId, marker))) await client.addLeadNote(leadId, note);
      await patch(db, row.id, { note_sent_at: new Date().toISOString() });
    }
    await patch(db, row.id, {
      status: 'sent', action: action ?? 'note_added', sent_at: new Date().toISOString(), error_message: null,
    });
    log('info', `AMO: ${action === 'created' ? 'создана сделка' : 'добавлено примечание в сделку'} ${leadId} для ${row.sub_source}`);
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    const attempts = row.attempts + 1;
    const retry = attempts < MAX_ATTEMPTS && isTransientAmoError(err);
    await patch(db, row.id, {
      status: retry ? 'pending' : 'failed', attempts,
      next_attempt_at: new Date(Date.now() + RETRY_MS).toISOString(),
      error_message: message,
    });
    log(retry ? 'warn' : 'error', `AMO: ${row.sub_source}, ${row.lead_email}: ${message}${retry ? ' — повтор через 5 мин' : ''}`);
  }
}

/** Reconcile Telegram deliveries, then process one due AMO task per pass. */
export async function processSenderAutoLeadCrm(db: SupabaseClient, log: Log): Promise<number> {
  const { error: enqueueError } = await db.rpc('enqueue_sender_auto_leads_crm');
  if (enqueueError) throw new Error(`enqueue_sender_auto_leads_crm: ${enqueueError.message}`);

  const now = new Date().toISOString();
  const { data, error } = await db.from('sender_auto_lead_crm_pushes')
    .select(COLUMNS).eq('status', 'pending').lte('next_attempt_at', now)
    .order('created_at').limit(BATCH);
  if (error) throw new Error(`sender_auto_lead_crm_pushes: ${error.message}`);

  let handled = 0;
  for (const row of (data ?? []) as PushRow[]) {
    const { data: claimed, error: claimError } = await db.from('sender_auto_lead_crm_pushes')
      .update({ next_attempt_at: new Date(Date.now() + LEASE_MS).toISOString() })
      .eq('id', row.id).eq('status', 'pending').lte('next_attempt_at', now).select('id');
    if (claimError) throw new Error(`sender_auto_lead_crm_pushes claim: ${claimError.message}`);
    if (!claimed?.length) continue;
    await pushOne(db, row, log);
    handled++;
  }
  return handled;
}
