import type { SupabaseClient } from '@supabase/supabase-js';

import * as instantly from './client';
import {
  mappingCampaignId,
  parseAccountCampaignMappingItems,
} from './accountCampaignMappings';
import { fetchThreadContext, getBodyText, type ThreadContext } from './leadQualifier';
import type { Email } from './types';

const MAPPING_POSITIVE_TTL_MS = 10 * 60 * 1000;
const MAPPING_NEGATIVE_TTL_MS = 60 * 1000;
const MAPPING_CACHE_MAX = 1_500;
const MAX_PARENT_CAMPAIGN_PROBES = 8;

interface MappedCampaigns {
  allCampaignIds: string[];
  activeCampaignIds: string[];
}

type MappingCacheEntry = { at: number; value: MappedCampaigns };
const mappingCache = new Map<string, MappingCacheEntry>();

export type ReplyOwnershipResolution =
  | {
      status: 'resolved';
      providerCampaignId: string;
      effectiveCampaignId: string;
      effectiveProjectId: string | null;
      context: ThreadContext | null;
      corrected: boolean;
      /** Exact live mailbox configuration proved the effective campaign. */
      mailboxVerified: boolean;
      reason: string;
    }
  | {
      status: 'ambiguous';
      providerCampaignId: string;
      candidateCampaignIds: string[];
      candidateProjectIds: string[];
      reason: string;
    }
  | {
      status: 'defer';
      providerCampaignId: string;
      reason: string;
    };

function normalizeMailbox(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized || null;
}

function emailTs(email: Email): number {
  return Date.parse(email.timestamp_email ?? email.timestamp_created ?? '') || 0;
}

/**
 * Instantly prefixes the provider thread token with two campaign-specific
 * characters. The stable suffix survives the provider's erroneous campaign
 * reassignment (live incident: `9c-…` inbound vs `05-…` parent outbound).
 * Only strip the prefix when it has exactly the observed two-character shape;
 * arbitrary user-created thread ids are left untouched.
 */
export function stableThreadKey(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  return /^[a-z0-9]{2}-.+/i.test(normalized) ? normalized.slice(3) : normalized;
}

function normalizeQuotedText(value: string): string {
  return value
    .split('\n')
    .map((line) => line.replace(/^\s*>+\s?/, ''))
    .join(' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function correctedContext(
  reply: Email,
  campaignId: string,
  mailbox: string,
  campaignEmails: Email[],
  parent: Email | null,
): ThreadContext {
  const correctedReply: Email = { ...reply, campaign_id: campaignId };
  const uniqueCampaignEmails = campaignEmails.filter(
    (email, index, all) =>
      email.id !== correctedReply.id &&
      all.findIndex((candidate) => candidate.id === email.id) === index,
  );
  return {
    replyEmail: correctedReply,
    threadEmails: [...uniqueCampaignEmails, correctedReply].sort(
      (a, b) => emailTs(a) - emailTs(b),
    ),
    lastOutbound: parent,
    campaignOutboundMailboxes: [mailbox],
  };
}

/** Strongest available evidence that an outbound is the parent of `reply`. */
function parentScore(reply: Email, outbound: Email): number {
  const replyThread = stableThreadKey(reply.thread_id);
  const outboundThread = stableThreadKey(outbound.thread_id);
  if (replyThread && outboundThread && replyThread === outboundThread) return 100;

  const replyBody = normalizeQuotedText(getBodyText(reply.body));
  const outboundBodyRaw = getBodyText(outbound.body);
  const outboundBody = normalizeQuotedText(outboundBodyRaw);
  if (outboundBody.length >= 40 && replyBody.includes(outboundBody)) return 80;
  for (const line of outboundBodyRaw.split('\n')) {
    const normalizedLine = normalizeQuotedText(line);
    if (normalizedLine.length >= 40 && replyBody.includes(normalizedLine)) return 70;
  }

  return 0;
}

function pruneMappingCache(): void {
  const now = Date.now();
  for (const [key, entry] of mappingCache) {
    const ttl = entry.value.allCampaignIds.length > 0
      ? MAPPING_POSITIVE_TTL_MS
      : MAPPING_NEGATIVE_TTL_MS;
    if (now - entry.at >= ttl) mappingCache.delete(key);
  }
  if (mappingCache.size <= MAPPING_CACHE_MAX) return;
  const oldest = [...mappingCache.entries()].sort((a, b) => a[1].at - b[1].at);
  for (const [key] of oldest.slice(0, mappingCache.size - MAPPING_CACHE_MAX)) {
    mappingCache.delete(key);
  }
}

async function getMappedCampaigns(mailbox: string, accountId?: string): Promise<MappedCampaigns> {
  const key = `${accountId ?? 'main'}:${mailbox}`;
  const cached = mappingCache.get(key);
  if (cached) {
    const ttl = cached.value.allCampaignIds.length > 0
      ? MAPPING_POSITIVE_TTL_MS
      : MAPPING_NEGATIVE_TTL_MS;
    if (Date.now() - cached.at < ttl) return cached.value;
    mappingCache.delete(key);
  }

  const raw = await instantly.getAccountCampaignMappings(mailbox, { accountId });
  // getAccountCampaignMappings drains every provider cursor (the live endpoint
  // otherwise defaults to 10). Keep historical status=0/3 assignments for
  // late replies, but prefer status=1 as the current configured pool.
  const items = parseAccountCampaignMappingItems(raw)
    .map((item) => ({
      id: mappingCampaignId(item),
      active: item.status === 1,
      createdAt: Date.parse(item.timestamp_created ?? '') || 0,
    }))
    .filter((item): item is { id: string; active: boolean; createdAt: number } =>
      Boolean(item.id),
    )
    .sort((a, b) => Number(b.active) - Number(a.active) || b.createdAt - a.createdAt);
  const value: MappedCampaigns = {
    allCampaignIds: [...new Set(items.map((item) => item.id))],
    activeCampaignIds: [
      ...new Set(items.filter((item) => item.active).map((item) => item.id)),
    ],
  };
  mappingCache.set(key, { at: Date.now(), value });
  pruneMappingCache();
  return value;
}

interface OwnershipLinks {
  projectsByCampaign: Map<string, Set<string>>;
  clientsByCampaign: Map<string, Set<string>>;
  error: string | null;
}

async function loadOwnershipLinks(
  db: SupabaseClient,
  campaignIds: string[],
): Promise<OwnershipLinks> {
  const projectsByCampaign = new Map<string, Set<string>>();
  const clientsByCampaign = new Map<string, Set<string>>();
  if (campaignIds.length === 0) {
    return { projectsByCampaign, clientsByCampaign, error: null };
  }

  const [legacy, period, clientAccess] = await Promise.all([
    db
      .from('project_instantly_campaigns')
      .select('campaign_id, project_id')
      .in('campaign_id', campaignIds),
    db
      .from('project_period_instantly_campaigns')
      .select('campaign_id, project_id')
      .in('campaign_id', campaignIds),
    db
      .from('client_instantly_access')
      .select('resource_id, client_user_id')
      .eq('resource_type', 'campaign')
      .in('resource_id', campaignIds),
  ]);
  if (legacy.error || period.error || clientAccess.error) {
    return {
      projectsByCampaign,
      clientsByCampaign,
      error:
        legacy.error?.message ??
        period.error?.message ??
        clientAccess.error?.message ??
        'campaign ownership query failed',
    };
  }

  for (const row of [...(legacy.data ?? []), ...(period.data ?? [])] as Array<{
    campaign_id?: string | null;
    project_id?: string | null;
  }>) {
    if (!row.campaign_id || !row.project_id) continue;
    let projects = projectsByCampaign.get(row.campaign_id);
    if (!projects) {
      projects = new Set<string>();
      projectsByCampaign.set(row.campaign_id, projects);
    }
    projects.add(row.project_id);
  }

  for (const row of (clientAccess.data ?? []) as Array<{
    resource_id?: string | null;
    client_user_id?: string | null;
  }>) {
    if (!row.resource_id || !row.client_user_id) continue;
    let clients = clientsByCampaign.get(row.resource_id as string);
    if (!clients) {
      clients = new Set<string>();
      clientsByCampaign.set(row.resource_id as string, clients);
    }
    clients.add(row.client_user_id as string);
  }
  return { projectsByCampaign, clientsByCampaign, error: null };
}

function campaignOwnerKeys(links: OwnershipLinks, campaignId: string): string[] {
  const projectIds = [...(links.projectsByCampaign.get(campaignId) ?? [])];
  // Managed project links are authoritative even when the client also has
  // visibility via client_instantly_access.
  if (projectIds.length > 0) return projectIds.map((id) => `project:${id}`);
  const clientIds = [...(links.clientsByCampaign.get(campaignId) ?? [])];
  if (clientIds.length > 0) return clientIds.map((id) => `client:${id}`);
  return [`unknown:${campaignId}`];
}

function projectIdFromOwnerKey(ownerKey: string): string | null {
  return ownerKey.startsWith('project:') ? ownerKey.slice('project:'.length) : null;
}

interface ParentCandidateSearch {
  parents: Array<{ email: Email; score: number }>;
  contextEmails: Email[];
}

function emailAddressTokens(value: string | null | undefined): string[] {
  return (value ?? '').toLowerCase().match(/[a-z0-9._%+\-]+@[a-z0-9.\-]+/g) ?? [];
}

function emailBelongsToReply(
  email: Email,
  reply: Email,
  identities: Set<string>,
): boolean {
  const replyThread = stableThreadKey(reply.thread_id);
  const emailThread = stableThreadKey(email.thread_id);
  if (replyThread && emailThread && replyThread === emailThread) return true;

  const addresses = [
    ...emailAddressTokens(email.lead),
    ...emailAddressTokens(email.from_address_email),
    ...emailAddressTokens(email.to_address_email_list),
    ...emailAddressTokens(email.cc_address_email_list),
  ];
  return addresses.some((address) => identities.has(address));
}

async function fetchParentCandidates(
  campaignId: string,
  reply: Email,
  mailbox: string,
  leadEmail: string,
  accountId?: string,
): Promise<ParentCandidateSearch> {
  const identity = (reply.lead ?? leadEmail).trim() || leadEmail;
  let items: Email[] = [];
  const searched = await instantly.listEmails(
    {
      campaign_id: campaignId,
      search: identity,
      mode: 'emode_all',
      limit: 100,
    },
    { accountId },
  );
  items = searched.items ?? [];

  // Instantly search occasionally returns only inbound rows. One bounded
  // campaign-wide sent fallback is used solely on the rare ownership-conflict
  // path; normal replies pay no extra request.
  const hasExactOutbound = items.some((email) => {
    const ours = email.ue_type === 1 || email.ue_type === 3;
    return ours && normalizeMailbox(email.eaccount) === mailbox;
  });
  if (!hasExactOutbound) {
    const sent = await instantly.listEmails(
      { campaign_id: campaignId, email_type: 'sent', limit: 100 },
      { accountId },
    );
    const seen = new Set(items.map((email) => email.id));
    for (const email of sent.items ?? []) {
      if (!email.id || !seen.has(email.id)) items.push(email);
    }
  }

  const replyAt = emailTs(reply);
  const identities = new Set(
    [reply.lead, leadEmail, reply.from_address_email]
      .flatMap((value) => emailAddressTokens(value))
      .filter(Boolean),
  );
  const contextEmails = items
    .filter((email) => (!replyAt || emailTs(email) <= replyAt))
    .filter((email) => emailBelongsToReply(email, reply, identities));
  const parents = contextEmails
    .filter((email) => {
      const ours = email.ue_type === 1 || email.ue_type === 3;
      return (
        ours &&
        normalizeMailbox(email.eaccount) === mailbox &&
        (!replyAt || emailTs(email) < replyAt)
      );
    })
    .map((email) => ({ email, score: parentScore(reply, email) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || emailTs(b.email) - emailTs(a.email));
  return { parents, contextEmails };
}

/**
 * Resolve the real campaign/project before any qualification criteria or
 * user-visible side effects. Instantly can attach an inbound to a different
 * campaign merely because the same lead exists there; the exact receiving
 * mailbox plus the actual outbound parent are authoritative.
 */
export async function resolveEffectiveReplyOwner(args: {
  db: SupabaseClient;
  reply: Email;
  providerCampaignId: string;
  leadEmail: string;
  accountId?: string;
  prefetchedContext?: ThreadContext | null;
}): Promise<ReplyOwnershipResolution> {
  const {
    db,
    reply,
    providerCampaignId,
    leadEmail,
    accountId,
    prefetchedContext,
  } = args;
  const providerContext =
    prefetchedContext !== undefined
      ? prefetchedContext
      : await fetchThreadContext(providerCampaignId, leadEmail, reply.thread_id, accountId);
  const mailbox = normalizeMailbox(reply.eaccount);
  if (!mailbox) {
    return {
      status: 'resolved',
      providerCampaignId,
      effectiveCampaignId: providerCampaignId,
      effectiveProjectId: null,
      context: providerContext,
      corrected: false,
      mailboxVerified: false,
      reason: 'reply has no eaccount; provider campaign retained',
    };
  }

  let mappings: MappedCampaigns;
  try {
    mappings = await getMappedCampaigns(mailbox, accountId);
  } catch (error) {
    return {
      status: 'defer',
      providerCampaignId,
      reason: `exact mailbox mapping unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // An empty successful response provides no alternative owner. Preserve the
  // existing guard path; unlike an API error this is not a reason to stall all
  // replies on an old/rotated account.
  if (mappings.allCampaignIds.length === 0) {
    return {
      status: 'resolved',
      providerCampaignId,
      effectiveCampaignId: providerCampaignId,
      effectiveProjectId: null,
      context: providerContext,
      corrected: false,
      mailboxVerified: false,
      reason: 'mailbox has no current campaign mappings; provider campaign retained',
    };
  }

  // A provider campaign in the active exact pool is current authoritative
  // configuration; historical status=0/3 mappings must not make every normal
  // reply ambiguous. When provider is absent from the active pool, include
  // history so a late reply can still recover its original parent campaign.
  const mappedCampaignIds = mappings.activeCampaignIds.includes(providerCampaignId)
    ? mappings.activeCampaignIds
    : mappings.allCampaignIds;
  const linkIds = [...new Set([providerCampaignId, ...mappedCampaignIds])];
  const links = await loadOwnershipLinks(db, linkIds);
  if (links.error) {
    return {
      status: 'defer',
      providerCampaignId,
      reason: `campaign ownership unavailable: ${links.error}`,
    };
  }

  const candidateCampaignIds = mappedCampaignIds;
  const ownerKeysByCampaign = new Map(
    candidateCampaignIds.map((campaignId) => [
      campaignId,
      campaignOwnerKeys(links, campaignId),
    ]),
  );
  const candidateOwnerKeys = [
    ...new Set(candidateCampaignIds.flatMap(
      (campaignId) => ownerKeysByCampaign.get(campaignId) ?? [],
    )),
  ];
  const candidateProjectIds = [
    ...new Set(
      candidateCampaignIds.flatMap((campaignId) => [
        ...(links.projectsByCampaign.get(campaignId) ?? []),
      ]),
    ),
  ];

  const providerProjects = links.projectsByCampaign.get(providerCampaignId) ?? new Set<string>();
  if (providerProjects.size > 1) {
    return {
      status: 'ambiguous',
      providerCampaignId,
      candidateCampaignIds,
      candidateProjectIds: [...providerProjects],
      reason: `provider campaign ${providerCampaignId} is linked to multiple Portal projects`,
    };
  }
  const providerMapped = candidateCampaignIds.includes(providerCampaignId);
  if (providerMapped && candidateCampaignIds.length === 1) {
    return {
      status: 'resolved',
      providerCampaignId,
      effectiveCampaignId: providerCampaignId,
      effectiveProjectId: [...providerProjects][0] ?? null,
      context: providerContext,
      corrected: false,
      mailboxVerified: true,
      reason: 'provider campaign is the exact live mailbox mapping',
    };
  }

  if (candidateCampaignIds.length > MAX_PARENT_CAMPAIGN_PROBES) {
    if (candidateOwnerKeys.length === 1 && !candidateOwnerKeys[0].startsWith('unknown:')) {
      const chosenCampaignId = providerMapped ? providerCampaignId : candidateCampaignIds[0];
      return {
        status: 'resolved',
        providerCampaignId,
        effectiveCampaignId: chosenCampaignId,
        effectiveProjectId: projectIdFromOwnerKey(candidateOwnerKeys[0]),
        context: chosenCampaignId === providerCampaignId
          ? providerContext
          : correctedContext(reply, chosenCampaignId, mailbox, [], null),
        corrected: chosenCampaignId !== providerCampaignId,
        mailboxVerified: true,
        reason: `exact mailbox resolves one owner across ${candidateCampaignIds.length} campaigns`,
      };
    }
    return {
      status: 'ambiguous',
      providerCampaignId,
      candidateCampaignIds,
      candidateProjectIds,
      reason: `mailbox ${mailbox} has ${candidateCampaignIds.length} campaigns across multiple owners; parent probe budget is ${MAX_PARENT_CAMPAIGN_PROBES}`,
    };
  }

  const matches: Array<{
    campaignId: string;
    ownerKeys: string[];
    projectIds: string[];
    parent: Email;
    score: number;
    campaignEmails: Email[];
  }> = [];
  let parentFetchFailed = false;
  for (const candidateCampaignId of candidateCampaignIds) {
    try {
      const search = await fetchParentCandidates(
        candidateCampaignId,
        reply,
        mailbox,
        leadEmail,
        accountId,
      );
      const best = search.parents[0];
      if (!best) continue;
      matches.push({
        campaignId: candidateCampaignId,
        ownerKeys: ownerKeysByCampaign.get(candidateCampaignId) ?? [],
        projectIds: [...(links.projectsByCampaign.get(candidateCampaignId) ?? [])],
        parent: best.email,
        score: best.score,
        campaignEmails: search.contextEmails,
      });
    } catch {
      parentFetchFailed = true;
    }
  }

  // A missing candidate history can hide a competing parent. Never select the
  // one successful probe in that situation; retry next tick without dedup row.
  if (parentFetchFailed) {
    return {
      status: 'defer',
      providerCampaignId,
      reason: 'one or more candidate campaign histories were unavailable',
    };
  }

  if (matches.length === 0) {
    if (candidateOwnerKeys.length === 1 && !candidateOwnerKeys[0].startsWith('unknown:')) {
      // Several campaigns can intentionally share one project/client mailbox
      // pool. With no parent match the owner is still proven; keep the provider
      // campaign when it is itself mapped, otherwise use mapping order.
      const chosenCampaignId = providerMapped ? providerCampaignId : candidateCampaignIds[0];
      return {
        status: 'resolved',
        providerCampaignId,
        effectiveCampaignId: chosenCampaignId,
        effectiveProjectId: projectIdFromOwnerKey(candidateOwnerKeys[0]),
        context: chosenCampaignId === providerCampaignId
          ? providerContext
          : correctedContext(reply, chosenCampaignId, mailbox, [], null),
        corrected: chosenCampaignId !== providerCampaignId,
        mailboxVerified: true,
        reason: `exact mailbox resolves one owner; no unique parent, using mapped campaign ${chosenCampaignId}`,
      };
    }
    return {
      status: 'ambiguous',
      providerCampaignId,
      candidateCampaignIds,
      candidateProjectIds,
      reason: `mailbox ${mailbox} maps to multiple owners, but no unique outbound parent was found`,
    };
  }

  const bestScore = Math.max(...matches.map((match) => match.score));
  const strongest = matches.filter((match) => match.score === bestScore);
  const strongestOwnerKeys = [
    ...new Set(strongest.flatMap((match) => match.ownerKeys)),
  ];
  if (
    strongestOwnerKeys.length !== 1 ||
    strongestOwnerKeys[0].startsWith('unknown:')
  ) {
    return {
      status: 'ambiguous',
      providerCampaignId,
      candidateCampaignIds,
      candidateProjectIds: [
        ...new Set(strongest.flatMap((match) => match.projectIds)),
      ],
      reason: `outbound parent matches ${strongestOwnerKeys.length} distinct or unknown owners`,
    };
  }

  // Several campaigns of the same project are normal. They do not create an
  // ownership conflict; the newest strongest parent selects the campaign.
  strongest.sort((a, b) => emailTs(b.parent) - emailTs(a.parent));
  const chosen = strongest[0];
  const context = correctedContext(
    reply,
    chosen.campaignId,
    mailbox,
    chosen.campaignEmails,
    chosen.parent,
  );
  return {
    status: 'resolved',
    providerCampaignId,
    effectiveCampaignId: chosen.campaignId,
    effectiveProjectId: projectIdFromOwnerKey(strongestOwnerKeys[0]),
    context,
    corrected: chosen.campaignId !== providerCampaignId,
    mailboxVerified: true,
    reason: `exact mailbox and outbound parent resolve campaign ${chosen.campaignId}`,
  };
}
