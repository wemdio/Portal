import type { SupabaseClient } from '@supabase/supabase-js';

import * as instantly from './client';
import {
  mappingCampaignId,
  parseAccountCampaignMappingItems,
} from './accountCampaignMappings';
import { fetchThreadContext, getBodyText, type ThreadContext } from './leadQualifier';
import { CampaignStatus, type Email } from './types';
import { resolveCampaignProjectOwner } from './campaignProjectOwnerResolver';

const MAPPING_POSITIVE_TTL_MS = 10 * 60 * 1000;
const MAPPING_NEGATIVE_TTL_MS = 60 * 1000;
const MAPPING_CACHE_MAX = 1_500;
const MAX_OWNERSHIP_EVIDENCE_CALLS = 2;

interface MappedCampaigns {
  allCampaignIds: string[];
  currentCampaignIds: string[];
  /** A live positive cache omitted the email's provider campaign, so we refreshed it. */
  refreshedForProviderMismatch?: boolean;
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

async function getMappedCampaigns(
  mailbox: string,
  accountId?: string,
  providerCampaignId?: string,
): Promise<MappedCampaigns> {
  const key = `${accountId ?? 'main'}:${mailbox}`;
  const cached = mappingCache.get(key);
  let refreshedForProviderMismatch = false;
  if (cached) {
    const ttl = cached.value.allCampaignIds.length > 0
      ? MAPPING_POSITIVE_TTL_MS
      : MAPPING_NEGATIVE_TTL_MS;
    const cacheIsLive = Date.now() - cached.at < ttl;
    const providerMissingFromPositiveCache = Boolean(
      cacheIsLive &&
      providerCampaignId &&
      cached.value.allCampaignIds.length > 0 &&
      !cached.value.allCampaignIds.includes(providerCampaignId),
    );
    // Provider campaign_id is fresh per email. If it is absent from an
    // otherwise-live mailbox cache, the mailbox may have moved projects since
    // the cache was populated. Force one provider refresh instead of routing
    // the reply through the previous owner's ten-minute snapshot.
    if (cacheIsLive && !providerMissingFromPositiveCache) {
      return cached.value;
    }
    refreshedForProviderMismatch = providerMissingFromPositiveCache;
    mappingCache.delete(key);
  }

  const raw = await instantly.getAccountCampaignMappings(mailbox, { accountId });
  // getAccountCampaignMappings drains every provider cursor (the live endpoint
  // otherwise defaults to 10). Draft/completed (0/3) assignments are history;
  // paused, subsequence and temporary account-health states still own replies.
  const items = parseAccountCampaignMappingItems(raw)
    .map((item) => ({
      id: mappingCampaignId(item),
      current:
        typeof item.status === 'number' &&
        item.status !== CampaignStatus.Draft &&
        item.status !== CampaignStatus.Completed,
      createdAt: Date.parse(item.timestamp_created ?? '') || 0,
    }))
    .filter((item): item is { id: string; current: boolean; createdAt: number } =>
      Boolean(item.id),
    )
    .sort((a, b) => Number(b.current) - Number(a.current) || b.createdAt - a.createdAt);
  const value: MappedCampaigns = {
    allCampaignIds: [...new Set(items.map((item) => item.id))],
    currentCampaignIds: [
      ...new Set(items.filter((item) => item.current).map((item) => item.id)),
    ],
  };
  mappingCache.set(key, { at: Date.now(), value });
  pruneMappingCache();
  return refreshedForProviderMismatch
    ? { ...value, refreshedForProviderMismatch: true }
    : value;
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

interface CampaignEvidence {
  parents: Array<{ email: Email; score: number }>;
  contextEmails: Email[];
}

interface WorkspaceEvidenceResult {
  evidence: Map<string, CampaignEvidence>;
  /** Every provider page relevant to this bounded lookup was consumed. */
  complete: boolean;
}

interface CampaignParentMatch {
  campaignId: string;
  parent: Email;
  score: number;
  campaignEmails: Email[];
}

function emailAddressTokens(value: string | null | undefined): string[] {
  return (value ?? '').toLowerCase().match(/[a-z0-9._%+\-]+@[a-z0-9.\-]+/g) ?? [];
}

function jsonAddressTokens(value: Email['from_address_json']): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => emailAddressTokens(entry?.address));
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
    ...jsonAddressTokens(email.from_address_json),
    ...jsonAddressTokens(email.to_address_json),
    ...jsonAddressTokens(email.cc_address_json),
  ];
  return addresses.some((address) => identities.has(address));
}

function collectCampaignEvidence(
  campaignIds: string[],
  reply: Email,
  mailbox: string,
  leadEmail: string,
  emails: Email[],
  trustedParentId: string | null,
): Map<string, CampaignEvidence> {
  const campaignSet = new Set(campaignIds);
  const replyAt = emailTs(reply);
  const identities = new Set(
    [reply.lead, leadEmail, reply.from_address_email]
      .flatMap((value) => emailAddressTokens(value))
      .filter(Boolean),
  );
  const unique = new Map<string, Email>();
  for (const email of emails) {
    const campaignId = email.campaign_id?.trim();
    if (!campaignId || !campaignSet.has(campaignId)) continue;
    if (replyAt && emailTs(email) > replyAt) continue;
    const isTrustedParent = Boolean(trustedParentId && email.id === trustedParentId);
    if (!isTrustedParent && !emailBelongsToReply(email, reply, identities)) continue;
    // The same provider message id can be exposed under both the polluted and
    // real campaign. Preserve both copies; cross-owner ties become manual.
    const key = email.id
      ? `${campaignId}:${email.id}`
      : `${campaignId}:${email.thread_id ?? ''}:${emailTs(email)}`;
    if (!unique.has(key)) unique.set(key, email);
  }

  const evidence = new Map<string, CampaignEvidence>();
  for (const campaignId of campaignIds) {
    const contextEmails = [...unique.values()]
      .filter((email) => email.campaign_id === campaignId)
      .sort((a, b) => emailTs(a) - emailTs(b));
    const exactOutbounds = contextEmails
      .filter((email) => {
        const ours = email.ue_type === 1 || email.ue_type === 3;
        return (
          ours &&
          normalizeMailbox(email.eaccount) === mailbox &&
          (!replyAt || emailTs(email) < replyAt)
        );
      })
      .sort((a, b) => emailTs(b) - emailTs(a));
    evidence.set(campaignId, {
      parents: exactOutbounds
        .map((email) => {
          const outboundAt = emailTs(email);
          // Cross-owner correction must be chronologically provable. Missing
          // timestamps otherwise let a later manual send in the same provider
          // thread masquerade as the parent. The explicit Others trust contract
          // is the sole exception because that caller matched the send itself.
          const temporalOrderProven = replyAt > 0 && outboundAt > 0 && outboundAt < replyAt;
          const inferredScore = temporalOrderProven ? parentScore(reply, email) : 0;
          // The Others watchdog has already compared this outbound against
          // every candidate campaign (subject/body) before handing it here.
          // Keep a stable-thread match stronger, but do not discard that
          // caller-proven parent merely because the orphan reply lacks quotes.
          const score = trustedParentId && email.id === trustedParentId
            ? Math.max(inferredScore, 90)
            : inferredScore;
          return { email, score };
        })
        .filter((candidate) => candidate.score > 0)
        .sort((a, b) => b.score - a.score || emailTs(b.email) - emailTs(a.email)),
      contextEmails,
    });
  }
  return evidence;
}

async function fetchWorkspaceEvidence(args: {
  campaignIds: string[];
  reply: Email;
  mailbox: string;
  leadEmail: string;
  accountId?: string;
  prefetchedContext: ThreadContext | null;
  providerCampaignId: string;
  trustPrefetchedParent: boolean;
}): Promise<WorkspaceEvidenceResult> {
  const {
    campaignIds,
    reply,
    mailbox,
    leadEmail,
    accountId,
    prefetchedContext,
    providerCampaignId,
    trustPrefetchedParent,
  } = args;
  const identity = (reply.lead ?? leadEmail).trim() || leadEmail;
  const items: Email[] = [];
  if (prefetchedContext) {
    for (const email of [
      ...prefetchedContext.threadEmails,
      ...(prefetchedContext.lastOutbound ? [prefetchedContext.lastOutbound] : []),
    ]) {
      items.push(
        email.campaign_id
          ? email
          : { ...email, campaign_id: providerCampaignId },
      );
    }
  }

  const trustedParentId = trustPrefetchedParent
    ? prefetchedContext?.lastOutbound?.id?.trim() || null
    : null;
  let evidence = collectCampaignEvidence(
    campaignIds,
    reply,
    mailbox,
    leadEmail,
    items,
    trustedParentId,
  );
  const trustedParentAlreadyProven = Boolean(
    trustedParentId &&
    [...evidence.values()].some((entry) =>
      entry.parents.some((candidate) => candidate.email.id === trustedParentId),
    ),
  );
  if (trustedParentAlreadyProven) return { evidence, complete: true };

  let calls = 0;
  let searchCursor: string | undefined;
  let searchComplete = false;
  while (calls < MAX_OWNERSHIP_EVIDENCE_CALLS) {
    const searched = await instantly.listEmails(
      {
        search: identity,
        mode: 'emode_all',
        limit: 100,
        ...(searchCursor ? { starting_after: searchCursor } : {}),
      },
      { accountId },
    );
    calls++;
    items.push(...(searched.items ?? []));
    evidence = collectCampaignEvidence(
      campaignIds,
      reply,
      mailbox,
      leadEmail,
      items,
      trustedParentId,
    );
    searchCursor = searched.next_starting_after?.trim() || undefined;
    if (!searchCursor) {
      searchComplete = true;
      break;
    }
  }

  // A parent from an early page is not enough to correct ownership when later
  // pages may contain an equally strong parent for another project.
  if (!searchComplete) return { evidence, complete: false };

  // Instantly's generic search can omit sent rows even when it returned one
  // apparently strong outbound. Cross-owner routing therefore also verifies
  // the dedicated sent surface. If search pagination consumed the whole call
  // budget, fail closed instead of trusting a potentially polluted copy.
  if (calls >= MAX_OWNERSHIP_EVIDENCE_CALLS) {
    return { evidence, complete: false };
  }
  const sent = await instantly.listEmails(
    { email_type: 'sent', mode: 'emode_all', limit: 100 },
    { accountId },
  );
  items.push(...(sent.items ?? []));
  evidence = collectCampaignEvidence(
    campaignIds,
    reply,
    mailbox,
    leadEmail,
    items,
    trustedParentId,
  );
  return {
    evidence,
    complete: !sent.next_starting_after?.trim(),
  };
}

function campaignParentMatches(
  evidence: Map<string, CampaignEvidence>,
  campaignIds: string[],
): CampaignParentMatch[] {
  return campaignIds.flatMap((campaignId) => {
    const campaignEvidence = evidence.get(campaignId);
    const best = campaignEvidence?.parents[0];
    return best
      ? [{
          campaignId,
          parent: best.email,
          score: best.score,
          campaignEmails: campaignEvidence?.contextEmails ?? [],
        }]
      : [];
  });
}

function strongExactProviderParent(args: {
  context: ThreadContext | null;
  reply: Email;
  providerCampaignId: string;
  mailbox: string;
  leadEmail: string;
}): Email | null {
  const { context, reply, providerCampaignId, mailbox, leadEmail } = args;
  const parent = context?.lastOutbound;
  if (!parent) return null;
  const parentCampaignId = parent.campaign_id?.trim();
  if (parentCampaignId && parentCampaignId !== providerCampaignId) return null;

  const normalizedParent = parentCampaignId
    ? parent
    : { ...parent, campaign_id: providerCampaignId };
  const evidence = collectCampaignEvidence(
    [providerCampaignId],
    reply,
    mailbox,
    leadEmail,
    [normalizedParent],
    null,
  );
  return evidence.get(providerCampaignId)?.parents[0]?.email ?? null;
}

async function resolveProviderCampaignFallback(args: {
  db: SupabaseClient;
  providerCampaignId: string;
  providerContext: ThreadContext | null;
  reason: string;
}): Promise<ReplyOwnershipResolution> {
  const { db, providerCampaignId, providerContext, reason } = args;
  let owner;
  try {
    owner = await resolveCampaignProjectOwner(db, providerCampaignId);
  } catch (error) {
    return {
      status: 'defer',
      providerCampaignId,
      reason: `campaign ownership unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (owner.status === 'ambiguous') {
    return {
      status: 'ambiguous',
      providerCampaignId,
      candidateCampaignIds: [providerCampaignId],
      candidateProjectIds: owner.projectIds,
      reason: `provider campaign ${providerCampaignId} is linked to multiple Portal projects`,
    };
  }
  return {
    status: 'resolved',
    providerCampaignId,
    effectiveCampaignId: providerCampaignId,
    effectiveProjectId: owner.status === 'resolved' ? owner.projectId : null,
    context: providerContext,
    corrected: false,
    mailboxVerified: false,
    reason,
  };
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
  /** Caller has already matched prefetched lastOutbound across campaigns. */
  trustPrefetchedParent?: boolean;
}): Promise<ReplyOwnershipResolution> {
  const {
    db,
    reply,
    providerCampaignId,
    leadEmail,
    accountId,
    prefetchedContext,
    trustPrefetchedParent = false,
  } = args;
  const providerContext =
    prefetchedContext !== undefined
      ? prefetchedContext
      : await fetchThreadContext(providerCampaignId, leadEmail, reply.thread_id, accountId);
  const mailbox = normalizeMailbox(reply.eaccount);
  if (!mailbox) {
    return resolveProviderCampaignFallback({
      db,
      providerCampaignId,
      providerContext,
      reason: 'reply has no eaccount; provider campaign retained',
    });
  }

  let mappings: MappedCampaigns;
  try {
    mappings = await getMappedCampaigns(mailbox, accountId, providerCampaignId);
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
    return resolveProviderCampaignFallback({
      db,
      providerCampaignId,
      providerContext,
      reason: 'mailbox has no current campaign mappings; provider campaign retained',
    });
  }

  if (
    mappings.refreshedForProviderMismatch &&
    !mappings.allCampaignIds.includes(providerCampaignId)
  ) {
    return {
      status: 'defer',
      providerCampaignId,
      reason:
        `mailbox mapping refresh still omits provider campaign ${providerCampaignId}; ` +
        'waiting for provider ownership to converge',
    };
  }

  // Every exact-mailbox mapping is ownership evidence. Current mappings choose
  // the representative campaign when all mapped campaigns belong to one owner;
  // historical mappings remain candidates for late replies.
  const evidenceCampaignIds = mappings.allCampaignIds;
  const currentCampaignIds = mappings.currentCampaignIds;
  const linkIds = [...new Set([providerCampaignId, ...evidenceCampaignIds])];
  const links = await loadOwnershipLinks(db, linkIds);
  if (links.error) {
    return {
      status: 'defer',
      providerCampaignId,
      reason: `campaign ownership unavailable: ${links.error}`,
    };
  }

  const ownerKeysByCampaign = new Map(
    evidenceCampaignIds.map((campaignId) => [
      campaignId,
      campaignOwnerKeys(links, campaignId),
    ]),
  );
  const candidateProjectIds = [
    ...new Set(
      evidenceCampaignIds.flatMap((campaignId) => [
        ...(links.projectsByCampaign.get(campaignId) ?? []),
      ]),
    ),
  ];

  const providerProjects = links.projectsByCampaign.get(providerCampaignId) ?? new Set<string>();
  if (providerProjects.size > 1) {
    return {
      status: 'ambiguous',
      providerCampaignId,
      candidateCampaignIds: evidenceCampaignIds,
      candidateProjectIds: [...providerProjects],
      reason: `provider campaign ${providerCampaignId} is linked to multiple Portal projects`,
    };
  }

  const providerProjectId = [...providerProjects][0] ?? null;
  // A sibling campaign can retain stale duplicate project links even while
  // the provider campaign itself is unambiguous. Such a sibling is compatible
  // when one of its links still names the provider project; a current campaign
  // owned only by somebody else remains a real conflict and stays fail-closed.
  const providerIsCurrent = currentCampaignIds.includes(providerCampaignId);
  const currentMappingsRemainCompatible = Boolean(
    providerProjectId &&
    currentCampaignIds.every((campaignId) =>
      campaignId === providerCampaignId ||
      links.projectsByCampaign.get(campaignId)?.has(providerProjectId),
    ),
  );
  const providerParent = providerProjectId && providerIsCurrent && currentMappingsRemainCompatible
    ? strongExactProviderParent({
        context: providerContext,
        reply,
        providerCampaignId,
        mailbox,
        leadEmail,
      })
    : null;
  if (providerProjectId && providerParent) {
    return {
      status: 'resolved',
      providerCampaignId,
      effectiveCampaignId: providerCampaignId,
      effectiveProjectId: providerProjectId,
      context: providerContext,
      corrected: false,
      mailboxVerified: true,
      reason: `current exact mailbox and strong provider parent resolve campaign ${providerCampaignId}`,
    };
  }

  const allOwnerKeys = [
    ...new Set(
      evidenceCampaignIds.flatMap(
        (campaignId) => ownerKeysByCampaign.get(campaignId) ?? [],
      ),
    ),
  ];
  if (allOwnerKeys.length === 1 && !allOwnerKeys[0].startsWith('unknown:')) {
    const providerMapped = evidenceCampaignIds.includes(providerCampaignId);
    let chosenCampaignId = providerMapped
      ? providerCampaignId
      : currentCampaignIds[0] ?? evidenceCampaignIds[0];
    let context = chosenCampaignId === providerCampaignId
      ? providerContext
      : correctedContext(reply, chosenCampaignId, mailbox, [], null);
    let reason = `exact mailbox mappings resolve one owner; using ${chosenCampaignId}`;

    // When Instantly attached the inbound to an unrelated campaign — or to a
    // mapped sibling whose thread contains only the reply — the exact mailbox
    // still proves the owner. Recover the real parent to keep short answers
    // such as "интересно" tied to the offer. Evidence errors never change the
    // already-proven owner; qualification safely continues with known context.
    if (!providerMapped || !providerContext?.lastOutbound) {
      try {
        const workspaceEvidence = await fetchWorkspaceEvidence({
          campaignIds: evidenceCampaignIds,
          reply,
          mailbox,
          leadEmail,
          accountId,
          prefetchedContext: providerContext,
          providerCampaignId,
          trustPrefetchedParent,
        });
        // All candidate campaigns belong to the same proven owner here, so a
        // later global sent page cannot introduce a competing specialist.
        // Use a strong parent already found by search even when the account-wide
        // sent surface is larger than the bounded enrichment window.
        const parentMatch = campaignParentMatches(
          workspaceEvidence.evidence,
          evidenceCampaignIds,
        ).sort(
          (left, right) =>
            right.score - left.score || emailTs(right.parent) - emailTs(left.parent),
        )[0];
        if (parentMatch) {
          chosenCampaignId = parentMatch.campaignId;
          context = correctedContext(
            reply,
            parentMatch.campaignId,
            mailbox,
            parentMatch.campaignEmails,
            parentMatch.parent,
          );
          reason = `exact mailbox resolves one owner and outbound parent ${parentMatch.campaignId}`;
        }
      } catch (error) {
        reason += `; context enrichment unavailable: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    return {
      status: 'resolved',
      providerCampaignId,
      effectiveCampaignId: chosenCampaignId,
      effectiveProjectId: projectIdFromOwnerKey(allOwnerKeys[0]),
      context,
      corrected: chosenCampaignId !== providerCampaignId,
      mailboxVerified: true,
      reason,
    };
  }

  let workspaceEvidence: WorkspaceEvidenceResult;
  try {
    workspaceEvidence = await fetchWorkspaceEvidence({
      campaignIds: evidenceCampaignIds,
      reply,
      mailbox,
      leadEmail,
      accountId,
      prefetchedContext: providerContext,
      providerCampaignId,
      trustPrefetchedParent,
    });
  } catch (error) {
    return {
      status: 'defer',
      providerCampaignId,
      reason: `workspace ownership history unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!workspaceEvidence.complete) {
    return {
      status: 'ambiguous',
      providerCampaignId,
      candidateCampaignIds: evidenceCampaignIds,
      candidateProjectIds,
      reason: 'workspace ownership evidence exceeded the bounded page budget',
    };
  }
  const evidence = workspaceEvidence.evidence;

  const matches: Array<{
    campaignId: string;
    ownerKeys: string[];
    projectIds: string[];
    parent: Email;
    score: number;
    campaignEmails: Email[];
  }> = campaignParentMatches(evidence, evidenceCampaignIds).map((match) => ({
    ...match,
    ownerKeys: ownerKeysByCampaign.get(match.campaignId) ?? [],
    projectIds: [...(links.projectsByCampaign.get(match.campaignId) ?? [])],
  }));

  if (matches.length === 0) {
    // Historical-only assignments are evidence, not a safe default. Without a
    // strong parent they must stay manual instead of silently reviving an old
    // campaign/project.
    if (currentCampaignIds.length === 0) {
      return {
        status: 'ambiguous',
        providerCampaignId,
        candidateCampaignIds: evidenceCampaignIds,
        candidateProjectIds,
        reason: `mailbox ${mailbox} has only historical mappings and no strong outbound parent`,
      };
    }

    return {
      status: 'ambiguous',
      providerCampaignId,
      candidateCampaignIds: evidenceCampaignIds,
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
      candidateCampaignIds: evidenceCampaignIds,
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
