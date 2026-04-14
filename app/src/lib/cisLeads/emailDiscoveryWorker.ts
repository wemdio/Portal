/**
 * Email Discovery Worker for CIS Lead Finder.
 *
 * Multi-source pipeline to find real email addresses for decision-makers (ЛПР):
 *
 * 1. OfData — emails from government registries (Rosstat, GosZakupki, RKN)
 * 2. DaData EGRUL — emails already fetched but not linked to LPR contacts
 * 3. Email permutator + SMTP verify — generate candidates from ФИО + domain, verify delivery
 *
 * Runs as a post-processing step after LPR discovery (serperLprEnrichment)
 * and site discovery (siteDiscoveryEnrichment).
 */
import 'server-only';

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { sanitizeContactEmail } from '@/lib/cisLeads/contactEmailPolicy';
import { fetchOfDataCompany, hasOfDataKey, type OfDataCompanyResult } from '@/lib/cisLeads/ofDataClient';
import { generateEmailCandidates } from '@/lib/cisLeads/emailPermutator';
import { verifyEmail, type VerifyResult } from '@/lib/cisLeads/smtpEmailVerifier';
import { getCompanyIdsForJob, chunkArray, IN_CHUNK_SIZE } from '@/lib/cisLeads/batchedQuery';

const BATCH_LIMIT = 60;
const PERMUTATOR_CANDIDATES_LIMIT = 8;
const SMTP_VERIFY_ENABLED = (process.env.EMAIL_SMTP_VERIFY_ENABLED ?? 'true') === 'true';

const GENERIC_PREFIXES = new Set([
  'info', 'office', 'sales', 'support', 'admin', 'contact',
  'help', 'service', 'mail', 'hello', 'hr', 'marketing',
  'reception', 'secretary', 'general', 'company', 'order',
  'noreply', 'no-reply', 'feedback', 'request', 'priemnaya',
]);

function isGenericEmail(email: string): boolean {
  const local = email.split('@')[0]?.toLowerCase() ?? '';
  return GENERIC_PREFIXES.has(local);
}

function isPersonalEmail(email: string): boolean {
  return !isGenericEmail(email);
}

interface CompanyRow {
  id: string;
  name: string;
  short_name: string | null;
  inn: string | null;
  site: string | null;
  email: string | null;
  phone: string | null;
}

interface ContactRow {
  id: string;
  company_id: string;
  full_name: string;
  channel_email: string | null;
  channel_phone: string | null;
  source_details: Record<string, string> | null;
}

function domainFromSiteOrEmail(site: string | null, email: string | null): string | null {
  if (site) {
    const cleaned = site.replace(/^(?:https?:\/\/)?(?:www\.)?/i, '').replace(/\/.*$/, '').trim().toLowerCase();
    if (cleaned.includes('.')) return cleaned;
  }
  if (email && email.includes('@')) {
    const domain = email.split('@')[1]?.trim().toLowerCase();
    if (domain && domain.includes('.')) return domain;
  }
  return null;
}

// ── Source 1: OfData registry contacts ──

async function enrichFromOfData(
  company: CompanyRow,
  contacts: ContactRow[],
  userId: string,
): Promise<number> {
  if (!company.inn || !hasOfDataKey() || !supabaseAdmin) return 0;

  const ofdata = await fetchOfDataCompany(company.inn);
  if (!ofdata) return 0;

  let updated = 0;

  if (ofdata.contacts.sites.length > 0 && !company.site) {
    const site = ofdata.contacts.sites[0]!;
    await supabaseAdmin
      .from('companies')
      .update({ site })
      .eq('id', company.id)
      .is('site', null);
  }

  const ofdataEmails = ofdata.contacts.emails
    .map((e) => sanitizeContactEmail(e))
    .filter((e): e is string => e !== null);

  const personalEmails = ofdataEmails.filter(isPersonalEmail);
  const companyEmails = ofdataEmails.filter(isGenericEmail);

  if (companyEmails.length > 0 && !company.email) {
    await supabaseAdmin
      .from('companies')
      .update({ email: companyEmails[0] })
      .eq('id', company.id)
      .is('email', null);
  }

  if (ofdata.contacts.phones.length > 0 && !company.phone) {
    await supabaseAdmin
      .from('companies')
      .update({ phone: ofdata.contacts.phones[0] })
      .eq('id', company.id)
      .is('phone', null);
  }

  for (const dir of ofdata.directors) {
    const matchedContact = contacts.find(
      (c) => c.full_name.toLowerCase() === dir.fullName.toLowerCase(),
    );
    if (matchedContact && !matchedContact.channel_email && personalEmails.length > 0) {
      const email = personalEmails.shift()!;
      const details = { ...(matchedContact.source_details ?? {}), email: 'OfData реестры' };
      const { error } = await supabaseAdmin
        .from('company_contacts')
        .update({ channel_email: email, source_details: details })
        .eq('id', matchedContact.id)
        .eq('user_id', userId);
      if (!error) updated++;
    }
  }

  for (const contact of contacts) {
    if (contact.channel_email || personalEmails.length === 0) continue;
    const email = personalEmails.shift()!;
    const details = { ...(contact.source_details ?? {}), email: 'OfData реестры' };
    const { error } = await supabaseAdmin
      .from('company_contacts')
      .update({ channel_email: email, source_details: details })
      .eq('id', contact.id)
      .eq('user_id', userId);
    if (!error) updated++;
  }

  return updated;
}

// ── Source 2: DaData emails already in companies table ──

async function enrichFromCompanyEmails(
  company: CompanyRow,
  contacts: ContactRow[],
  userId: string,
): Promise<number> {
  if (!company.email || !supabaseAdmin) return 0;
  if (isGenericEmail(company.email)) return 0;

  const email = sanitizeContactEmail(company.email);
  if (!email) return 0;

  const contactWithoutEmail = contacts.find((c) => !c.channel_email);
  if (!contactWithoutEmail) return 0;

  const details = { ...(contactWithoutEmail.source_details ?? {}), email: 'DaData ЕГРЮЛ (компания)' };
  const { error } = await supabaseAdmin
    .from('company_contacts')
    .update({ channel_email: email, source_details: details })
    .eq('id', contactWithoutEmail.id)
    .eq('user_id', userId);

  return error ? 0 : 1;
}

// ── Source 3: Email permutator + SMTP verification ──

async function enrichFromPermutator(
  company: CompanyRow,
  contacts: ContactRow[],
  userId: string,
): Promise<number> {
  if (!supabaseAdmin) return 0;

  const domain = domainFromSiteOrEmail(company.site, company.email);
  if (!domain) return 0;

  const contactsWithoutEmail = contacts.filter((c) => !c.channel_email);
  if (contactsWithoutEmail.length === 0) return 0;

  let updated = 0;

  for (const contact of contactsWithoutEmail.slice(0, 3)) {
    const candidates = generateEmailCandidates(contact.full_name, domain);
    if (candidates.length === 0) continue;

    const topCandidates = candidates.slice(0, PERMUTATOR_CANDIDATES_LIMIT);

    if (!SMTP_VERIFY_ENABLED) {
      const email = topCandidates[0]!;
      const details = { ...(contact.source_details ?? {}), email: 'Email Permutator (не верифицирован)' };
      const { error } = await supabaseAdmin
        .from('company_contacts')
        .update({ channel_email: email, source_details: details })
        .eq('id', contact.id)
        .eq('user_id', userId);
      if (!error) updated++;
      continue;
    }

    let foundEmail: string | null = null;
    let verifySource = '';

    for (const candidate of topCandidates) {
      let result: VerifyResult;
      try {
        result = await verifyEmail(candidate);
      } catch {
        result = 'unknown';
      }

      if (result === 'valid') {
        foundEmail = candidate;
        verifySource = 'Email Permutator + SMTP (подтверждён)';
        break;
      }
      if (result === 'catch_all') {
        foundEmail = candidate;
        verifySource = 'Email Permutator (catch-all домен)';
        break;
      }
    }

    if (foundEmail) {
      const details = { ...(contact.source_details ?? {}), email: verifySource };
      const { error } = await supabaseAdmin
        .from('company_contacts')
        .update({ channel_email: foundEmail, source_details: details })
        .eq('id', contact.id)
        .eq('user_id', userId);
      if (!error) updated++;
    }
  }

  return updated;
}

// ── Main orchestrator ──

export async function runEmailDiscoveryEnrichment(
  jobId: string,
  userId: string,
): Promise<{ processed: number; emailsFound: number }> {
  if (!supabaseAdmin) return { processed: 0, emailsFound: 0 };

  const companyIds = await getCompanyIdsForJob(supabaseAdmin, jobId, userId);
  if (companyIds.length === 0) return { processed: 0, emailsFound: 0 };

  const companiesData: CompanyRow[] = [];
  for (const chunk of chunkArray(companyIds, IN_CHUNK_SIZE)) {
    if (companiesData.length >= BATCH_LIMIT) break;
    const { data } = await supabaseAdmin
      .from('companies')
      .select('id, name, short_name, inn, site, email, phone')
      .in('id', chunk)
      .limit(BATCH_LIMIT - companiesData.length);
    if (data) companiesData.push(...(data as CompanyRow[]));
  }

  if (!companiesData.length) return { processed: 0, emailsFound: 0 };

  const allContacts: ContactRow[] = [];
  for (const chunk of chunkArray(companyIds, IN_CHUNK_SIZE)) {
    const { data } = await supabaseAdmin
      .from('company_contacts')
      .select('id, company_id, full_name, channel_email, channel_phone, source_details')
      .eq('user_id', userId)
      .in('company_id', chunk)
      .is('channel_email', null)
      .order('score', { ascending: false });
    if (data) allContacts.push(...(data as ContactRow[]));
  }

  const contactsByCompany = new Map<string, ContactRow[]>();
  for (const c of allContacts) {
    const list = contactsByCompany.get(c.company_id) ?? [];
    list.push(c);
    contactsByCompany.set(c.company_id, list);
  }

  let processed = 0;
  let emailsFound = 0;

  for (const company of companiesData) {
    const contacts = contactsByCompany.get(company.id) ?? [];
    if (contacts.length === 0) continue;

    try {
      const fromOfData = await enrichFromOfData(company, contacts, userId);
      emailsFound += fromOfData;

      const refreshedContacts = contacts.filter((c) => !c.channel_email);

      const fromCompanyEmail = await enrichFromCompanyEmails(company, refreshedContacts, userId);
      emailsFound += fromCompanyEmail;

      const stillNoEmail = refreshedContacts.filter((c) => !c.channel_email);
      if (stillNoEmail.length > 0 && company.site) {
        const fromPermutator = await enrichFromPermutator(company, stillNoEmail, userId);
        emailsFound += fromPermutator;
      }

      processed++;
      if (emailsFound > 0 || processed % 10 === 0) {
        console.log(`[cis-leads] emailDiscovery: ${company.short_name ?? company.name} → +${fromOfData} ofdata, +${fromCompanyEmail} company, +${(emailsFound - fromOfData - fromCompanyEmail)} permutator`);
      }
    } catch (e) {
      console.error(`[cis-leads] emailDiscovery failed for ${company.name}:`, e instanceof Error ? e.message : e);
    }

    if (processed < companiesData.length) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  console.log(`[cis-leads] emailDiscovery done: processed=${processed}, emailsFound=${emailsFound}`);
  return { processed, emailsFound };
}
