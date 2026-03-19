import 'server-only';

import Papa from 'papaparse';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { findByInn, hasDadataKey, suggestByName, type DadataFounder, type DadataManager } from '@/lib/enrich/dadataClient';
import { runPhoneEnrichmentBatch } from '@/lib/cisLeads/phoneEnrichmentWorker';
import { runContactAggregationBatch } from '@/lib/cisLeads/contactAggregationWorker';
import { runSerperLprEnrichment } from '@/lib/cisLeads/serperLprEnrichment';
import { runLprContactSerperEnrichment } from '@/lib/cisLeads/lprContactSerperEnrichment';
import { runSocialProfileEnrichment } from '@/lib/cisLeads/socialProfileEnrichment';
import { runWebsiteTeamEnrichment } from '@/lib/cisLeads/websiteTeamParser';
import { runSiteDiscoveryEnrichment } from '@/lib/cisLeads/siteDiscoveryEnrichment';
import { runEmailGuesser } from '@/lib/cisLeads/emailGuesser';
import { runYandexMapsEnrichment } from '@/lib/cisLeads/yandexMapsEnrichment';
import { guessLprRoleFromPost, normalizeInn, isLegalEntityName } from '@/lib/cisLeads/lprRole';
import { extractLeadFields, extractInnFromRow } from '@/lib/cisLeads/leadImportRow';

const BUCKET = 'cis-lead-imports';
const SUPABASE_BATCH_SIZE = 500;

type LeadImportJobRow = {
  id: string;
  user_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  source_filename: string;
  file_path: string | null;
};

function toRawLeadRow(params: {
  jobId: string;
  userId: string;
  rowIndex: number;
  row: Record<string, unknown>;
}) {
  const r = params.row;
  const {
    raw_inn,
    raw_company_name,
    raw_site,
    raw_city,
    raw_region,
    raw_phone,
    raw_email,
    raw_contact_name,
    raw_position,
    raw_notes,
  } = extractLeadFields(r);

  return {
    user_id: params.userId,
    import_job_id: params.jobId,
    row_index: params.rowIndex,
    raw_inn: raw_inn || null,
    raw_company_name: raw_company_name || null,
    raw_site: raw_site || null,
    raw_city: raw_city || null,
    raw_region: raw_region || null,
    raw_phone: raw_phone || null,
    raw_email: raw_email || null,
    raw_contact_name: raw_contact_name || null,
    raw_position: raw_position || null,
    raw_notes: raw_notes || null,
    raw_payload: r,
  };
}

async function updateJob(jobId: string, patch: Record<string, unknown>) {
  if (!supabaseAdmin) return;
  await supabaseAdmin.from('lead_import_jobs').update(patch).eq('id', jobId);
}


async function upsertDadataLprContact(params: {
  userId: string;
  companyId: string;
  fullName: string | null | undefined;
  post: string | null | undefined;
  source?: string;
}): Promise<boolean> {
  if (!supabaseAdmin) return false;
  const fullName = String(params.fullName ?? '').trim();
  if (!fullName) return false;
  if (isLegalEntityName(fullName)) return false;
  const post = String(params.post ?? '').trim() || null;
  const role = guessLprRoleFromPost(post);

  const sourceName = params.source === 'dadata_founder' ? 'DaData ЕГРЮЛ (учредитель)' : 'DaData ЕГРЮЛ';
  const sourceDetails: Record<string, string> = { name: sourceName };
  if (post) sourceDetails.title = sourceName;

  const { error } = await supabaseAdmin
    .from('company_contacts')
    .upsert(
      {
        user_id: params.userId,
        company_id: params.companyId,
        source: params.source ?? 'dadata_management',
        full_name: fullName,
        first_name: null,
        last_name: null,
        title: post,
        role_guess: role,
        channel_phone: null,
        channel_tg_username: null,
        channel_email: null,
        source_url: null,
        score: 78,
        confidence: 0.85,
        source_details: sourceDetails,
      },
      { onConflict: 'user_id,company_id,full_name' },
    );
  if (error) {
    console.error('[cis-leads] upsertDadataLprContact failed:', error.message, { companyId: params.companyId, fullName });
  }
  return !error;
}


function dadataFioToFullName(fio?: { surname?: string; name?: string; patronymic?: string }): string {
  if (!fio) return '';
  return [fio.surname, fio.name, fio.patronymic].filter(Boolean).join(' ').trim();
}

async function upsertAllDadataLprContacts(params: {
  userId: string;
  companyId: string;
  management?: { name?: string; post?: string };
  managers?: DadataManager[];
  founders?: DadataFounder[];
}): Promise<number> {
  const { userId, companyId, management, managers, founders } = params;
  const seen = new Set<string>();
  let created = 0;

  const tryUpsert = async (fullName: string, post: string | null, source: string) => {
    const key = fullName.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const ok = await upsertDadataLprContact({ userId, companyId, fullName, post, source });
    if (ok) created++;
  };

  if (management?.name) {
    await tryUpsert(management.name, management.post ?? null, 'dadata_management');
  }

  if (managers?.length) {
    for (const m of managers) {
      const name = dadataFioToFullName(m.fio) || m.name || '';
      if (!name) continue;
      await tryUpsert(name, m.post ?? null, 'dadata_management');
    }
  }

  if (founders?.length) {
    for (const f of founders) {
      if (f.type !== 'PHYSICAL') continue;
      const name = dadataFioToFullName(f.fio) || f.name || '';
      if (!name) continue;
      await tryUpsert(name, 'Учредитель', 'dadata_founder');
    }
  }

  return created;
}

async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let idx = 0;
  const run = async () => {
    while (idx < items.length) {
      const i = idx++;
      await worker(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => run()));
}

async function normalizeCompaniesForJob(jobId: string, userId: string): Promise<void> {
  if (!supabaseAdmin) return;
  if (!hasDadataKey()) return;

  const db = supabaseAdmin;

  // Keep this bounded; the job can be resumed by re-running normalization later.
  const { data: leads, error } = await db
    .from('raw_leads')
    .select('id, raw_inn, raw_company_name, raw_city, raw_region')
    .eq('import_job_id', jobId)
    .is('company_id', null)
    .limit(5000);

  if (error) throw new Error(error.message);
  const rows = (leads ?? []) as Array<{
    id: string;
    raw_inn: string | null;
    raw_company_name: string | null;
    raw_city: string | null;
    raw_region: string | null;
  }>;

  const now = new Date().toISOString();
  let normalized = 0;
  let contactsCreated = 0;

  console.log(`[cis-leads][${jobId}] normalizeCompanies: ${rows.length} leads to process`);

  await mapWithConcurrency(rows, 6, async (lead) => {
    const inn = normalizeInn(lead.raw_inn);
    const name = (lead.raw_company_name ?? '').trim();
    const city = (lead.raw_city ?? '').trim();

    let suggestion = null as Awaited<ReturnType<typeof findByInn>>;
    try {
      if (inn) suggestion = await findByInn(inn);
      else if (name) suggestion = await suggestByName(name, city || undefined);
    } catch {
      suggestion = null;
    }
    if (!suggestion) return;

    const sData = suggestion.data ?? {};
    const outInn = normalizeInn(String(sData.inn ?? inn ?? '')) ?? inn;
    const outOgrn = String(sData.ogrn ?? '').trim() || null;
    const outName =
      String(sData.name?.full_with_opf ?? '').trim() ||
      String(suggestion.value ?? '').trim() ||
      name;
    if (!outName) return;
    const outShort = String(sData.name?.short_with_opf ?? '').trim() || null;
    const outRegion = String(sData.address?.data?.region ?? lead.raw_region ?? '').trim() || null;
    const outCity = String(sData.address?.data?.city ?? lead.raw_city ?? '').trim() || null;

    const dadataPhones = (sData.phones as Array<{ value?: string }> | undefined) ?? [];
    const dadataEmails = (sData.emails as Array<{ value?: string }> | undefined) ?? [];
    const outPhone = dadataPhones[0]?.value?.trim() || null;
    const outEmail = dadataEmails[0]?.value?.trim()?.toLowerCase() || null;

    let companyId: string | null = null;
    if (outInn) {
      const { data: company, error: upsertErr } = await db
        .from('companies')
        .upsert(
          {
            inn: outInn,
            ogrn: outOgrn,
            name: outName,
            short_name: outShort,
            brand_name: null,
            region: outRegion,
            city: outCity,
            okved_main: null,
            employees_range: null,
            site: null,
            phone: outPhone,
            email: outEmail,
            source: 'dadata',
            source_confidence: 1.0,
            updated_at: now,
          },
          { onConflict: 'inn' },
        )
        .select('id')
        .single<{ id: string }>();
      if (!upsertErr && company) companyId = company.id;
    } else {
      const { data: company, error: insErr } = await db
        .from('companies')
        .insert({
          inn: null,
          ogrn: outOgrn,
          name: outName,
          short_name: outShort,
          brand_name: null,
          region: outRegion,
          city: outCity,
          okved_main: null,
          employees_range: null,
          site: null,
          phone: outPhone,
          email: outEmail,
          source: 'dadata',
          source_confidence: 0.7,
          updated_at: now,
        })
        .select('id')
        .single<{ id: string }>();
      if (!insErr && company) companyId = company.id;
    }

    if (!companyId) return;
    normalized++;

    const count = await upsertAllDadataLprContacts({
      userId,
      companyId,
      management: sData.management ?? undefined,
      managers: (sData.managers as DadataManager[] | undefined) ?? undefined,
      founders: (sData.founders as DadataFounder[] | undefined) ?? undefined,
    });
    contactsCreated += count;

    await db
      .from('raw_leads')
      .update({ company_id: companyId })
      .eq('id', lead.id)
      .eq('user_id', userId);
  });

  console.log(`[cis-leads][${jobId}] normalizeCompanies: done, ${normalized} companies, ${contactsCreated} contacts`);
}

async function fallbackLinkCompaniesFromRawLeads(jobId: string, userId: string): Promise<void> {
  if (!supabaseAdmin) return;
  const db = supabaseAdmin;

  const { data: leads, error } = await db
    .from('raw_leads')
    .select('id, raw_inn, raw_company_name, raw_city, raw_region, raw_site')
    .eq('import_job_id', jobId)
    .is('company_id', null)
    .limit(5000);
  if (error) throw new Error(error.message);

  const rows = (leads ?? []) as Array<{
    id: string;
    raw_inn: string | null;
    raw_company_name: string | null;
    raw_city: string | null;
    raw_region: string | null;
    raw_site: string | null;
  }>;
  if (rows.length === 0) return;

  const now = new Date().toISOString();
  for (const lead of rows) {
    const inn = normalizeInn(lead.raw_inn);
    const name = (lead.raw_company_name ?? '').trim();
    const region = (lead.raw_region ?? '').trim() || null;
    const city = (lead.raw_city ?? '').trim() || null;
    const site = (lead.raw_site ?? '').trim() || null;

    let companyId: string | null = null;

    if (inn) {
      const { data: company, error: upsertErr } = await db
        .from('companies')
        .upsert(
          {
            inn,
            name: name || `Компания ${inn}`,
            short_name: name || null,
            region,
            city,
            site,
            source: 'import_raw',
            source_confidence: 0.6,
            updated_at: now,
          },
          { onConflict: 'inn' },
        )
        .select('id')
        .single<{ id: string }>();
      if (!upsertErr && company) companyId = company.id;
    } else if (name) {
      let existingQuery = db
        .from('companies')
        .select('id')
        .eq('name', name);
      existingQuery = region ? existingQuery.eq('region', region) : existingQuery.is('region', null);
      const { data: existing } = await existingQuery
        .limit(1)
        .maybeSingle<{ id: string }>();
      if (existing?.id) {
        companyId = existing.id;
      } else {
        const { data: inserted } = await db
          .from('companies')
          .insert({
            inn: null,
            name,
            short_name: name,
            region,
            city,
            site,
            source: 'import_raw',
            source_confidence: 0.5,
            updated_at: now,
          })
          .select('id')
          .single<{ id: string }>();
        companyId = inserted?.id ?? null;
      }
    }

    if (!companyId) continue;

    await db
      .from('raw_leads')
      .update({ company_id: companyId })
      .eq('id', lead.id)
      .eq('user_id', userId);
  }
}

async function backfillRawInn(jobId: string, userId: string): Promise<void> {
  if (!supabaseAdmin) return;
  const db = supabaseAdmin;
  const { data: leads } = await db
    .from('raw_leads')
    .select('id,raw_inn,raw_payload')
    .eq('import_job_id', jobId)
    .eq('user_id', userId)
    .is('company_id', null)
    .limit(5000);
  if (!leads?.length) return;

  for (const lead of leads as Array<{ id: string; raw_inn: string | null; raw_payload: Record<string, unknown> | null }>) {
    if (lead.raw_inn) continue;
    const payload = lead.raw_payload;
    if (!payload || typeof payload !== 'object') continue;
    const inn = extractInnFromRow(payload);
    if (!inn) continue;
    await db.from('raw_leads').update({ raw_inn: inn }).eq('id', lead.id).eq('user_id', userId);
  }
}

async function setEnrichmentProgress(jobId: string, progress: number): Promise<void> {
  if (!supabaseAdmin) return;
  await supabaseAdmin
    .from('lead_import_jobs')
    .update({ enrichment_progress: Math.max(0, Math.min(1, progress)) })
    .eq('id', jobId);
}

const ENRICHMENT_STAGES = [
  'backfillRawInn',
  'normalizeCompanies',
  'fallbackLinkCompanies',
  'serperLprEnrichment',
  'lprContactSerperEnrichment',
  'siteDiscoveryEnrichment',
  'websiteTeamEnrichment',
  'yandexMapsEnrichment',
  'emailGuesser',
  'phoneEnrichment',
  'socialProfileEnrichment',
  'contactAggregation',
] as const;

async function runLeadPostProcessingInternal(jobId: string, userId: string): Promise<void> {
  const log = (step: string, detail?: unknown) =>
    console.log(`[cis-leads][${jobId}] ${step}`, detail ?? '');
  const logErr = (step: string, err: unknown) =>
    console.error(`[cis-leads][${jobId}] ${step} failed:`, err instanceof Error ? err.message : err);

  const totalStages = ENRICHMENT_STAGES.length;
  let stageIdx = 0;

  const advanceProgress = async (stageName: string) => {
    stageIdx++;
    const progress = stageIdx / totalStages;
    log(`${stageName} done — progress ${Math.round(progress * 100)}%`);
    await setEnrichmentProgress(jobId, progress);
  };

  try {
    log('backfillRawInn start');
    await backfillRawInn(jobId, userId);
    await advanceProgress('backfillRawInn');
  } catch (e) { logErr('backfillRawInn', e); stageIdx++; }

  try {
    log('normalizeCompaniesForJob start');
    await normalizeCompaniesForJob(jobId, userId);
    await advanceProgress('normalizeCompaniesForJob');
  } catch (e) { logErr('normalizeCompaniesForJob', e); stageIdx++; }

  try {
    log('fallbackLinkCompanies start');
    await fallbackLinkCompaniesFromRawLeads(jobId, userId);
    await advanceProgress('fallbackLinkCompanies');
  } catch (e) { logErr('fallbackLinkCompanies', e); stageIdx++; }

  try {
    log('serperLprEnrichment start');
    const serperResult = await runSerperLprEnrichment(jobId, userId);
    log('serperLprEnrichment', { processed: serperResult.processed, contacts: serperResult.contactsFound });
    await advanceProgress('serperLprEnrichment');
  } catch (e) { logErr('serperLprEnrichment', e); stageIdx++; }

  try {
    log('lprContactSerperEnrichment start');
    const personalSerper = await runLprContactSerperEnrichment(jobId, userId);
    log('lprContactSerperEnrichment', { processed: personalSerper.processed, updated: personalSerper.contactsUpdated });
    await advanceProgress('lprContactSerperEnrichment');
  } catch (e) { logErr('lprContactSerperEnrichment', e); stageIdx++; }

  try {
    log('siteDiscoveryEnrichment start');
    const siteDiscovery = await runSiteDiscoveryEnrichment(jobId, userId);
    log('siteDiscoveryEnrichment', { processed: siteDiscovery.processed, sites: siteDiscovery.sitesFound });
    await advanceProgress('siteDiscoveryEnrichment');
  } catch (e) { logErr('siteDiscoveryEnrichment', e); stageIdx++; }

  try {
    log('websiteTeamEnrichment start');
    const siteResult = await runWebsiteTeamEnrichment(jobId, userId);
    log('websiteTeamEnrichment', { processed: siteResult.processed, contacts: siteResult.contactsFound });
    await advanceProgress('websiteTeamEnrichment');
  } catch (e) { logErr('websiteTeamEnrichment', e); stageIdx++; }

  try {
    log('yandexMapsEnrichment start');
    const ymResult = await runYandexMapsEnrichment(jobId, userId);
    log('yandexMapsEnrichment', { processed: ymResult.processed, updated: ymResult.updated });
    await advanceProgress('yandexMapsEnrichment');
  } catch (e) { logErr('yandexMapsEnrichment', e); stageIdx++; }

  try {
    log('emailGuesser start');
    const emailResult = await runEmailGuesser(jobId, userId);
    log('emailGuesser', { processed: emailResult.processed, emails: emailResult.emailsFound });
    await advanceProgress('emailGuesser');
  } catch (e) { logErr('emailGuesser', e); stageIdx++; }

  try {
    log('phoneEnrichment start');
    const phoneResult = await runPhoneEnrichmentBatch();
    log('phoneEnrichment', { processed: phoneResult.processed });
    await advanceProgress('phoneEnrichment');
  } catch (e) { logErr('phoneEnrichment', e); stageIdx++; }

  try {
    log('socialProfileEnrichment start');
    const socialResult = await runSocialProfileEnrichment(jobId, userId);
    log('socialProfileEnrichment', { processed: socialResult.processed, linksFound: socialResult.linksFound });
    await advanceProgress('socialProfileEnrichment');
  } catch (e) { logErr('socialProfileEnrichment', e); stageIdx++; }

  try {
    log('contactAggregation start');
    const contactResult = await runContactAggregationBatch();
    log('contactAggregation', { processed: contactResult.processed });
    await advanceProgress('contactAggregation');
  } catch (e) { logErr('contactAggregation', e); stageIdx++; }
}

export async function runLeadPostProcessing(jobId: string): Promise<void> {
  if (!supabaseAdmin) return;
  const { data: job } = await supabaseAdmin
    .from('lead_import_jobs')
    .select('id,user_id')
    .eq('id', jobId)
    .single<{ id: string; user_id: string }>();
  if (!job?.id || !job.user_id) return;
  await runLeadPostProcessingInternal(job.id, job.user_id);
}

function getExtension(filename: string): string {
  const idx = filename.lastIndexOf('.');
  if (idx === -1) return '';
  return filename.slice(idx).toLowerCase();
}

async function downloadJobFile(path: string): Promise<ArrayBuffer> {
  const res = await supabaseAdmin!.storage.from(BUCKET).download(path);
  if (res.error) throw new Error(res.error.message);
  return await res.data.arrayBuffer();
}

function parseCsv(bytes: ArrayBuffer): { rows: Record<string, unknown>[] } {
  const text = Buffer.from(bytes).toString('utf8');
  const parsed = Papa.parse<Record<string, unknown>>(text, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false,
  });
  if (parsed.errors?.length) {
    const msg = parsed.errors[0]?.message || 'CSV parse error';
    throw new Error(msg);
  }
  const rows = Array.isArray(parsed.data) ? parsed.data : [];
  return { rows };
}

async function parseXlsOrXlsx(bytes: ArrayBuffer): Promise<{ rows: Record<string, unknown>[] }> {
  const mod = await import('xlsx');
  const XLSX = mod.default ?? mod;
  const workbook = XLSX.read(bytes, { type: 'array' });
  const sheetName = workbook.SheetNames?.[0];
  if (!sheetName) return { rows: [] };
  const sheet = workbook.Sheets[sheetName];
  const json = XLSX.utils.sheet_to_json(sheet, { defval: '' }) as Record<string, unknown>[];
  return { rows: json };
}

export async function runLeadImportJob(jobId: string): Promise<void> {
  if (!supabaseAdmin) {
    console.error('supabaseAdmin not configured');
    return;
  }

  const { data: job, error } = await supabaseAdmin
    .from('lead_import_jobs')
    .select('id,user_id,status,source_filename,file_path')
    .eq('id', jobId)
    .single<LeadImportJobRow>();

  if (error || !job) throw new Error(error?.message ?? 'Job not found');
  if (!job.file_path) throw new Error('Missing job file_path');
  if (job.status !== 'pending') return;

  const startedAt = new Date().toISOString();
  const { data: claimedRows, error: claimError } = await supabaseAdmin
    .from('lead_import_jobs')
    .update({ status: 'running', started_at: startedAt, error_message: null })
    .eq('id', jobId)
    .eq('status', 'pending')
    .select('id');
  if (claimError) throw new Error(claimError.message);
  if (!claimedRows || claimedRows.length === 0) return;

  try {
    const bytes = await downloadJobFile(job.file_path);
    const ext = getExtension(job.source_filename);

    const parsed =
      ext === '.csv'
        ? parseCsv(bytes)
        : await parseXlsOrXlsx(bytes);

    const rows = parsed.rows;
    await updateJob(jobId, { total_rows: rows.length, processed_rows: 0 });

    let processed = 0;
    for (let i = 0; i < rows.length; i += SUPABASE_BATCH_SIZE) {
      const slice = rows.slice(i, i + SUPABASE_BATCH_SIZE);
      const toInsert = slice.map((row, idx) =>
        toRawLeadRow({ jobId, userId: job.user_id, rowIndex: i + idx, row }),
      );

      const { error: insErr } = await supabaseAdmin
        .from('raw_leads')
        .insert(toInsert);

      if (insErr) throw new Error(insErr.message);
      processed += toInsert.length;
      await updateJob(jobId, { processed_rows: processed });
    }

    await runLeadPostProcessingInternal(jobId, job.user_id);
    await updateJob(jobId, { status: 'completed', completed_at: new Date().toISOString() });
  } catch (e) {
    await updateJob(jobId, {
      status: 'failed',
      error_message: e instanceof Error ? e.message : 'Import error',
      completed_at: new Date().toISOString(),
    });
    throw e;
  }
}

