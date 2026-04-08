/**
 * Outreach worker: SMTP verification, email sequence generation, and Instantly upload
 * for both Bugor (ENG) and Nash (RU) outreach pipelines.
 *
 * Also runs the scheduled Nash Outreach daily collection (07:00 MSK by default).
 */

import { runBugorSmtpValidation } from '@/lib/bugorOutreach/smtpValidationWorker';
import { runNashSmtpValidation } from '@/lib/nashOutreach/smtpValidationWorker';
import { collectRawSignals } from '@/lib/nashOutreach/collectLeads';
import { enrichRawSignals } from '@/lib/nashOutreach/enrichLeads';
import { findEmailsForLeads } from '@/lib/bugorOutreach/findEmails';
import { validateLeadEmails } from '@/lib/bugorOutreach/validateEmails';
import { syncInstantlyCampaignAnalytics } from '@/lib/tools/instantlyCampaignCatalog';
import { createWorkerLogger, pollLoop, requireSupabaseAdmin, setupGracefulShutdown, sleep } from './_shared';

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? '5000');
const NASH_COLLECT_HOUR_UTC = Number(process.env.NASH_COLLECT_HOUR_UTC ?? '4');
const WORKER_ID = `outreach-${process.pid}-${Date.now()}`;
const log = createWorkerLogger(WORKER_ID);

async function pollOnce(): Promise<boolean> {
  const db = requireSupabaseAdmin(log);

  try {
    const bugorCount = await runBugorSmtpValidation();
    if (bugorCount > 0) {
      log('info', `Bugor SMTP processed ${bugorCount} lead(s)`);
      return true;
    }
  } catch (err) {
    log('error', 'Bugor SMTP error', err);
  }

  try {
    const nashCount = await runNashSmtpValidation();
    if (nashCount > 0) {
      log('info', `Nash SMTP processed ${nashCount} lead(s)`);
      return true;
    }
  } catch (err) {
    log('error', 'Nash SMTP error', err);
  }

  return false;
}

function getNextRunMs(hourUtc: number): number {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(hourUtc, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

async function runNashCollect(): Promise<void> {
  const db = requireSupabaseAdmin(log);
  log('info', 'Nash Outreach scheduled collection starting...');

  try {
    const rawItems = await collectRawSignals();
    log('info', `Nash collect: ${rawItems.length} raw items`);
    if (rawItems.length === 0) return;

    const enriched = await enrichRawSignals(rawItems);
    log('info', `Nash collect: ${enriched.length} enriched leads`);
    if (enriched.length === 0) return;

    const today = new Date().toISOString().slice(0, 10);
    const { data: existing } = await db
      .from('nash_outreach_leads')
      .select('company_name, website')
      .gte('batch_date', new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10));

    const existingKeys = new Set(
      (existing ?? []).map((r: { company_name?: string; website?: string }) =>
        `${(r.company_name ?? '').toLowerCase()}|${(r.website ?? '').toLowerCase()}`),
    );

    const toInsert = enriched.filter((lead) => {
      const key = `${lead.company_name.toLowerCase()}|${(lead.website ?? '').toLowerCase()}`;
      if (existingKeys.has(key)) return false;
      existingKeys.add(key);
      return true;
    });

    if (toInsert.length === 0) {
      log('info', 'Nash collect: all leads were duplicates');
      return;
    }

    const rows = toInsert.map((lead) => ({
      batch_date: today,
      company_name: lead.company_name,
      website: lead.website,
      city: lead.city,
      employee_count: lead.employee_count,
      description: lead.description,
      niche: lead.niche,
      signal_type: lead.signal_type,
      signal_detail: lead.signal_detail,
      intent_score: lead.intent_score,
      priority: lead.priority,
      outreach_angle: lead.outreach_angle,
      source_url: lead.source_url,
      hh_employer_id: lead.hh_employer_id,
      hh_vacancy_name: lead.hh_vacancy_name,
      raw_data: { source: lead.source_url },
    }));

    const { data: insertedRows, error: insertError } = await db
      .from('nash_outreach_leads')
      .insert(rows)
      .select('id, company_name, website, source_url, emails_found');

    if (insertError) {
      log('error', `Nash collect insert error: ${insertError.message}`);
      return;
    }

    const leads = insertedRows ?? [];
    log('info', `Nash collect: inserted ${leads.length} leads`);

    const emailResults = await findEmailsForLeads(
      leads.map((l: { id: string; company_name: string; website?: string | null; source_url?: string | null }) => ({
        id: l.id, company_name: l.company_name, website: l.website ?? null,
        founder_name: null, source_url: l.source_url ?? null,
      })),
    );

    let emailsFound = 0;
    for (const er of emailResults) {
      if (er.emails.length > 0) {
        emailsFound++;
        await db.from('nash_outreach_leads')
          .update({ emails_found: er.emails, smtp_tier: er.tier }).eq('id', er.id);
      } else {
        await db.from('nash_outreach_leads')
          .update({ smtp_status: 'skipped' }).eq('id', er.id);
      }
    }

    const leadsWithEmails = emailResults.filter((er) => er.emails.length > 0);
    if (leadsWithEmails.length > 0) {
      const validationResults = await validateLeadEmails(
        leadsWithEmails.map((er) => ({ id: er.id, emails: er.emails })),
      );
      let validated = 0;
      for (const vr of validationResults) {
        if (vr.validated.length > 0) {
          validated++;
          await db.from('nash_outreach_leads')
            .update({ emails_validated: vr.validated, smtp_status: 'pending' }).eq('id', vr.id);
        } else {
          await db.from('nash_outreach_leads')
            .update({ smtp_status: 'skipped' }).eq('id', vr.id);
        }
      }
      log('info', `Nash collect: emails found=${emailsFound}, MX validated=${validated}`);
    }

    log('info', 'Nash collect complete (SMTP + sequences + upload handled by poll loop)');
  } catch (err) {
    log('error', 'Nash collect failed', err);
  }
}

let _shuttingDown = false;

async function nashCollectScheduler(): Promise<void> {
  while (!_shuttingDown) {
    const waitMs = getNextRunMs(NASH_COLLECT_HOUR_UTC);
    const nextRun = new Date(Date.now() + waitMs).toISOString();
    log('info', `Nash collect: next run at ${nextRun} (in ${Math.round(waitMs / 60_000)} min)`);
    await sleep(waitMs);
    if (_shuttingDown) break;
    await runNashCollect();
  }
}

async function main(): Promise<void> {
  log('info', `Starting Outreach worker (pid=${process.pid})`);
  requireSupabaseAdmin(log);
  const shouldStop = setupGracefulShutdown(log);

  const origShouldStop = shouldStop;
  const wrappedShouldStop = () => {
    const v = origShouldStop();
    _shuttingDown = v;
    return v;
  };

  void nashCollectScheduler();

  await pollLoop({
    log,
    pollIntervalMs: POLL_INTERVAL_MS,
    shouldStop: wrappedShouldStop,
    pollOnce,
    realtimeTables: ['bugor_outreach_leads', 'nash_outreach_leads'],
  });
}

main().catch((err) => {
  log('error', 'Worker crashed', err);
  process.exit(1);
});
