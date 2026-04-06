/**
 * Bugor Outreach SMTP Validation Worker.
 *
 * Runs on the Docker worker (port 25 available). Picks up leads with
 * smtp_status='pending', verifies emails via SMTP RCPT TO, generates
 * email sequences for valid leads, and uploads to Instantly.
 */

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { validateEmail, type DomainInfo } from '@/lib/emailValidation/validator';
import { generateEmailSequences } from './generateEmails';
import { uploadToInstantly } from './uploadToInstantly';
import type { BugorLead, SenderConfig } from './types';

const BATCH_SIZE = 20;
const SMTP_CONCURRENCY = 5;

const BUGOR_LEAD_SELECT = 'id, company_name, website, founder_name, description, niche, signal_type, signal_detail, intent_score, priority, outreach_angle, timing, delay_days, send_after, region, source_url, email_guess, founder_linkedin, batch_date, raw_data, created_at, emails_found, emails_validated, email_sequence, instantly_uploaded, instantly_lead_id, smtp_status, smtp_tier';

async function loadSenderConfig(): Promise<SenderConfig> {
  const defaults: SenderConfig = {
    sender_name: 'Nick S.',
    sender_calendly: 'https://calendly.com/nickerhov89/brief-intro',
    sender_website: 'polzaagency.com',
    auto_upload_enabled: true,
  };
  if (!supabaseAdmin) return defaults;
  const { data } = await supabaseAdmin.from('bugor_outreach_config').select('key, value');
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
      // Catch-all: accept Tier 1-3 (found on web), reject Tier 4 (pattern guess)
      accepted = smtpTier !== null && smtpTier <= 3;
    }

    results.push({ email, result: vr.result, accepted });
    console.log(`[bugor-smtp] ${email}: ${vr.result} (smtp_code=${vr.smtp_code}) → ${accepted ? 'ACCEPT' : 'REJECT'}`);
  }
  return results;
}

function mapSmtpStatus(results: SmtpResult[]): BugorLead['smtp_status'] {
  if (results.some((r) => r.accepted && r.result === 'ok')) return 'valid';
  if (results.some((r) => r.accepted && r.result === 'catch_all')) return 'catch_all';
  if (results.every((r) => r.result === 'invalid')) return 'invalid';
  return 'unknown';
}

/**
 * Main entry point — called by the Docker worker poll loop.
 * Returns the number of leads processed (0 means nothing to do).
 */
export async function runBugorSmtpValidation(): Promise<number> {
  if (!supabaseAdmin) return 0;

  const { data: pendingLeads, error } = await supabaseAdmin
    .from('bugor_outreach_leads')
    .select(BUGOR_LEAD_SELECT)
    .eq('smtp_status', 'pending')
    .neq('emails_validated', '{}')
    .order('created_at', { ascending: true })
    .limit(BATCH_SIZE);

  if (error || !pendingLeads || pendingLeads.length === 0) return 0;

  const leads = pendingLeads as BugorLead[];
  console.log(`[bugor-smtp] Processing ${leads.length} leads for SMTP verification`);

  const domainCache = new Map<string, DomainInfo>();
  const report = {
    processed: 0,
    smtpValid: 0,
    smtpInvalid: 0,
    smtpCatchAll: 0,
    smtpUnknown: 0,
    sequencesGenerated: 0,
    instantlyUploaded: 0,
    errors: [] as string[],
  };

  // Phase 1: SMTP verification (sequential batches with per-domain concurrency)
  const validLeads: BugorLead[] = [];

  for (let i = 0; i < leads.length; i += SMTP_CONCURRENCY) {
    const batch = leads.slice(i, i + SMTP_CONCURRENCY);
    const batchResults = await Promise.allSettled(
      batch.map(async (lead) => {
        const smtpResults = await verifyEmails(
          lead.emails_validated,
          lead.smtp_tier,
          domainCache,
        );

        const acceptedEmails = smtpResults.filter((r) => r.accepted).map((r) => r.email);
        const status = mapSmtpStatus(smtpResults);
        report.processed++;

        if (status === 'valid') report.smtpValid++;
        else if (status === 'catch_all') report.smtpCatchAll++;
        else if (status === 'invalid') report.smtpInvalid++;
        else report.smtpUnknown++;

        await supabaseAdmin!
          .from('bugor_outreach_leads')
          .update({
            smtp_status: status,
            emails_validated: acceptedEmails,
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
        console.error('[bugor-smtp] Lead verification failed:', msg);
      }
    }
  }

  console.log(`[bugor-smtp] SMTP done: valid=${report.smtpValid}, catch_all=${report.smtpCatchAll}, invalid=${report.smtpInvalid}, unknown=${report.smtpUnknown}`);

  // Phase 2: Generate email sequences for valid leads without sequences
  const needSequences = validLeads.filter((l) => !l.email_sequence || l.email_sequence.length < 3);
  if (needSequences.length > 0) {
    try {
      console.log(`[bugor-smtp] Generating sequences for ${needSequences.length} leads...`);
      const senderConfig = await loadSenderConfig();
      const genResults = await generateEmailSequences(needSequences, senderConfig);

      for (const gr of genResults) {
        if (gr.sequence) {
          report.sequencesGenerated++;
          await supabaseAdmin
            .from('bugor_outreach_leads')
            .update({ email_sequence: gr.sequence })
            .eq('id', gr.id);

          const lead = validLeads.find((l) => l.id === gr.id);
          if (lead) lead.email_sequence = gr.sequence;
        }
      }
      console.log(`[bugor-smtp] Generated ${report.sequencesGenerated} sequences`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Sequence generation error';
      report.errors.push(msg);
      console.error('[bugor-smtp] Sequence generation failed:', msg);
    }
  }

  // Phase 3: Upload to Instantly (timing-gated + region-routed)
  const senderConfig = await loadSenderConfig();
  if (senderConfig.auto_upload_enabled) {
    const today = new Date().toISOString().slice(0, 10);
    const readyToUpload = validLeads.filter(
      (l) =>
        l.emails_validated.length > 0 &&
        l.email_sequence &&
        l.email_sequence.length >= 3 &&
        l.send_after <= today &&
        !l.instantly_uploaded,
    );

    if (readyToUpload.length > 0) {
      try {
        console.log(`[bugor-smtp] Uploading ${readyToUpload.length} leads to Instantly...`);
        const uploadResult = await uploadToInstantly(readyToUpload);
        report.instantlyUploaded = uploadResult.uploaded;
        if (uploadResult.errors.length > 0) {
          report.errors.push(...uploadResult.errors);
        }
        console.log(`[bugor-smtp] Uploaded ${uploadResult.uploaded} leads`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Upload error';
        report.errors.push(msg);
        console.error('[bugor-smtp] Upload failed:', msg);
      }
    }
  }

  return report.processed;
}
