/**
 * Nash Outreach SMTP Validation Worker.
 * Mirrors bugorOutreach/smtpValidationWorker but operates on nash_outreach_leads.
 */

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { validateEmail, type DomainInfo } from '@/lib/emailValidation/validator';
import { generateEmailSequences } from './generateEmails';
import { scrapeCompanyContext } from '@/lib/bugorOutreach/scrapeCompanyContext';
import { uploadNashToInstantly } from './uploadToInstantly';
import type { NashLead, SenderConfig } from './types';

const BATCH_SIZE = 20;
const SMTP_CONCURRENCY = 5;

const LEAD_SELECT = 'id, company_name, website, city, employee_count, description, niche, signal_type, signal_detail, intent_score, priority, outreach_angle, source_url, hh_employer_id, hh_vacancy_name, inn, batch_date, raw_data, created_at, emails_found, emails_validated, email_sequence, instantly_uploaded, instantly_lead_id, smtp_status, smtp_tier, smtp_retry_count';

async function loadSenderConfig(): Promise<SenderConfig> {
  const defaults: SenderConfig = {
    sender_name: 'Егор',
    sender_calendly: 'https://calendly.com/nickerhov89/brief-intro',
    sender_website: 'polzaagency.com',
    auto_upload_enabled: true,
  };
  if (!supabaseAdmin) return defaults;
  const { data } = await supabaseAdmin.from('nash_outreach_config').select('key, value');
  if (!data) return defaults;
  for (const row of data) {
    if (row.key === 'sender_name') defaults.sender_name = row.value;
    if (row.key === 'sender_calendly') defaults.sender_calendly = row.value;
    if (row.key === 'sender_website') defaults.sender_website = row.value;
    if (row.key === 'auto_upload_enabled') defaults.auto_upload_enabled = row.value === 'true';
  }
  return defaults;
}

interface SmtpResult {
  email: string;
  result: string;
  accepted: boolean;
}

async function verifyEmails(
  emails: string[],
  smtpTier: number | null,
  domainCache: Map<string, DomainInfo>,
): Promise<SmtpResult[]> {
  const results: SmtpResult[] = [];
  for (const email of emails) {
    const vr = await validateEmail(email, domainCache);
    let accepted = false;

    if (vr.result === 'ok') {
      accepted = true;
    } else if (vr.result === 'catch_all') {
      accepted = smtpTier !== null && smtpTier <= 3;
    }

    results.push({ email, result: vr.result, accepted });
    console.log(`[nash-smtp] ${email}: ${vr.result} (smtp_code=${vr.smtp_code}) → ${accepted ? 'ACCEPT' : 'REJECT'}`);
  }
  return results;
}

function mapSmtpStatus(results: SmtpResult[]): NashLead['smtp_status'] {
  if (results.some((r) => r.accepted && r.result === 'ok')) return 'valid';
  if (results.some((r) => r.accepted && r.result === 'catch_all')) return 'catch_all';
  if (results.every((r) => r.result === 'invalid')) return 'invalid';
  return 'unknown';
}

export async function runNashSmtpValidation(): Promise<number> {
  if (!supabaseAdmin) return 0;

  const { data: pendingLeads, error } = await supabaseAdmin
    .from('nash_outreach_leads')
    .select(LEAD_SELECT)
    .eq('smtp_status', 'pending')
    .neq('emails_validated', '{}')
    .order('created_at', { ascending: true })
    .limit(BATCH_SIZE);

  if (error || !pendingLeads || pendingLeads.length === 0) return 0;

  const leads = pendingLeads as NashLead[];
  console.log(`[nash-smtp] Processing ${leads.length} leads for SMTP verification`);

  const domainCache = new Map<string, DomainInfo>();
  const report = {
    processed: 0, smtpValid: 0, smtpInvalid: 0, smtpCatchAll: 0, smtpUnknown: 0,
    sequencesGenerated: 0, instantlyUploaded: 0, errors: [] as string[],
  };

  const validLeads: NashLead[] = [];

  for (let i = 0; i < leads.length; i += SMTP_CONCURRENCY) {
    const batch = leads.slice(i, i + SMTP_CONCURRENCY);
    const batchResults = await Promise.allSettled(
      batch.map(async (lead) => {
        const smtpResults = await verifyEmails(lead.emails_validated, lead.smtp_tier, domainCache);
        const acceptedEmails = smtpResults.filter((r) => r.accepted).map((r) => r.email);
        const status = mapSmtpStatus(smtpResults);
        report.processed++;

        if (status === 'valid') report.smtpValid++;
        else if (status === 'catch_all') report.smtpCatchAll++;
        else if (status === 'invalid') report.smtpInvalid++;
        else report.smtpUnknown++;

        // Track when this lead was last probed and whether to bump retry_count.
        // The retry scheduler (worker/outreach.ts) uses these to give one more
        // chance to leads that landed in 'unknown' (proxy timeout / tarpit / blacklist).
        const prevRetryCount = lead.smtp_retry_count ?? 0;
        const nextRetryCount = status === 'unknown' ? prevRetryCount + 1 : prevRetryCount;

        await supabaseAdmin!
          .from('nash_outreach_leads')
          .update({
            smtp_status: status,
            emails_validated: acceptedEmails,
            smtp_last_attempt_at: new Date().toISOString(),
            smtp_retry_count: nextRetryCount,
          })
          .eq('id', lead.id);

        if (acceptedEmails.length > 0) {
          lead.emails_validated = acceptedEmails;
          lead.smtp_status = status;
          validLeads.push(lead);
        }
      }),
    );

    for (const r of batchResults) {
      if (r.status === 'rejected') {
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        report.errors.push(msg);
        console.error('[nash-smtp] Lead verification failed:', msg);
      }
    }
  }

  console.log(`[nash-smtp] SMTP done: valid=${report.smtpValid}, catch_all=${report.smtpCatchAll}, invalid=${report.smtpInvalid}, unknown=${report.smtpUnknown}`);

  const needSequences = validLeads.filter((l) => !l.email_sequence || l.email_sequence.length < 3);
  if (needSequences.length > 0) {
    try {
      console.log(`[nash-smtp] Scraping company context for ${needSequences.length} leads...`);
      const companyContexts = new Map<string, string>();
      await Promise.allSettled(
        needSequences.map(async (lead) => {
          const ctx = await scrapeCompanyContext(lead.website, lead.company_name);
          if (ctx) {
            companyContexts.set(lead.id, ctx);
            if (supabaseAdmin) {
              const existing = (lead.raw_data as Record<string, unknown>) ?? {};
              await supabaseAdmin.from('nash_outreach_leads')
                .update({ raw_data: { ...existing, company_context: ctx } })
                .eq('id', lead.id);
            }
          }
        }),
      );
      console.log(`[nash-smtp] Company context: ${companyContexts.size}/${needSequences.length} scraped`);

      console.log(`[nash-smtp] Generating sequences for ${needSequences.length} leads...`);
      const senderConfig = await loadSenderConfig();
      const genResults = await generateEmailSequences(needSequences, senderConfig, companyContexts);

      for (const gr of genResults) {
        if (gr.sequence) {
          report.sequencesGenerated++;
          await supabaseAdmin
            .from('nash_outreach_leads')
            .update({ email_sequence: gr.sequence })
            .eq('id', gr.id);
          const lead = validLeads.find((l) => l.id === gr.id);
          if (lead) lead.email_sequence = gr.sequence;
        }
      }
      console.log(`[nash-smtp] Generated ${report.sequencesGenerated} sequences`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Sequence generation error';
      report.errors.push(msg);
      console.error('[nash-smtp] Sequence generation failed:', msg);
    }
  }

  const senderConfig = await loadSenderConfig();
  if (senderConfig.auto_upload_enabled) {
    const readyToUpload = validLeads.filter(
      (l) =>
        l.emails_validated.length > 0 &&
        l.email_sequence &&
        l.email_sequence.length >= 3 &&
        !l.instantly_uploaded,
    );

    if (readyToUpload.length > 0) {
      try {
        console.log(`[nash-smtp] Uploading ${readyToUpload.length} leads to Instantly...`);
        const uploadResult = await uploadNashToInstantly(readyToUpload);
        report.instantlyUploaded = uploadResult.uploaded;
        if (uploadResult.errors.length > 0) report.errors.push(...uploadResult.errors);
        console.log(`[nash-smtp] Uploaded ${uploadResult.uploaded} leads`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Upload error';
        report.errors.push(msg);
        console.error('[nash-smtp] Upload failed:', msg);
      }
    }
  }

  return report.processed;
}

/**
 * Retry SMTP validation for leads that landed in 'unknown' on the first pass.
 *
 * Why: ~15% of high-priority leads end up unknown because of transient issues
 * on the recipient MX side — proxy connect timeouts, anti-harvest tarpits
 * (e.g. itadvisor.ru), or temporary IP blacklisting (554 from ritso.ru). Most
 * of these clear within a few hours.
 *
 * Strategy:
 *   - Pick unknown leads where retry_count = 0 AND last_attempt_at is at least
 *     4 hours old. This guarantees exactly one retry per lead per day.
 *   - Restore emails_validated from emails_found (the SMTP worker zeros out
 *     emails_validated on a fail, so we need the original list back).
 *   - Reset smtp_status to 'pending' so the regular SMTP worker poll picks them
 *     up on the next tick. Worker bumps retry_count to 1 on the next attempt,
 *     so they will not loop a third time.
 *
 * Called by nashRetryScheduler() in worker/outreach.ts roughly 4 hours after
 * the daily Nash collection (NASH_COLLECT_HOUR_UTC + 4).
 */
export async function retryUnknownNashLeads(): Promise<number> {
  if (!supabaseAdmin) return 0;

  const cutoff = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();

  const { data: candidates, error } = await supabaseAdmin
    .from('nash_outreach_leads')
    .select('id, company_name, emails_found')
    .eq('smtp_status', 'unknown')
    .eq('smtp_retry_count', 0)
    .lt('smtp_last_attempt_at', cutoff)
    .not('smtp_last_attempt_at', 'is', null);

  if (error) {
    console.error('[nash-retry] Query failed:', error.message);
    return 0;
  }
  if (!candidates || candidates.length === 0) {
    console.log('[nash-retry] No unknown leads to retry');
    return 0;
  }

  let resetCount = 0;
  for (const c of candidates as Array<{ id: string; company_name: string; emails_found: string[] | null }>) {
    const emails = Array.isArray(c.emails_found) ? c.emails_found : [];
    if (emails.length === 0) continue;

    const { error: updErr } = await supabaseAdmin
      .from('nash_outreach_leads')
      .update({ smtp_status: 'pending', emails_validated: emails })
      .eq('id', c.id);

    if (updErr) {
      console.error(`[nash-retry] Failed to reset lead ${c.id} (${c.company_name}):`, updErr.message);
      continue;
    }
    resetCount++;
    console.log(`[nash-retry] Queued for retry: ${c.company_name} (${emails.length} emails)`);
  }

  console.log(`[nash-retry] Reset ${resetCount}/${candidates.length} unknown leads to pending`);
  return resetCount;
}
