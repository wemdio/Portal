import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { serveClientDemo } from '@/lib/clientDemo/demoResponse';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { filterAllowedIds } from '@/lib/clientAccess';
import { listEmails } from '@/lib/instantly/client';
import { mapInstantlyEmailToReply } from '@/lib/clientCampaignReplies/mapEmail';
import { readCampaignAnalyticsFromDb } from '@/lib/tools/instantlyCampaignCatalog';
import { logError } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_FORWARD_FETCH = 1000;
const REPLIES_PER_CAMPAIGN = 100;

type LeadSource = 'forwarded_lead' | 'reply';

type CommentCount = { count: number };

type LeadListItem = {
  id: string;
  source: LeadSource;
  qualification_id: string | null;
  campaign_id: string;
  campaign_name: string | null;
  lead_email: string;
  lead_name: string | null;
  company_name: string | null;
  phone: string | null;
  website: string | null;
  linkedin_url: string | null;
  reply_subject: string | null;
  reply_body: string | null;
  last_outbound_preview: string | null;
  reply_timestamp: string | null;
  status: string | null;
  ai_reason: string | null;
  created_at: string;
  client_lead_comments: CommentCount[];
  email_id?: string | null;
  lead_id?: string | null;
  thread_id?: string | null;
  is_unread?: boolean;
  ai_interest_value?: number | null;
};

type SyncedLeadRow = {
  email: string;
  first_name: string | null;
  last_name: string | null;
  company_name: string | null;
  website: string | null;
  linkedin_url: string | null;
};

function parsePositiveInt(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function itemTimestamp(item: LeadListItem): number {
  const raw = item.reply_timestamp ?? item.created_at;
  const parsed = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function dedupeKey(item: LeadListItem): string {
  const email = item.lead_email.trim().toLowerCase();
  if (item.campaign_id && email && item.reply_timestamp) {
    return `reply:${item.campaign_id}:${email}:${item.reply_timestamp}`;
  }
  if (item.email_id) return `email:${item.email_id}`;
  return `${item.source}:${item.id}`;
}

function mergeAndSortItems(items: LeadListItem[]): LeadListItem[] {
  const seen = new Set<string>();
  const unique: LeadListItem[] = [];

  for (const item of items) {
    const key = dedupeKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }

  unique.sort((a, b) => itemTimestamp(b) - itemTimestamp(a));
  return unique;
}

async function readCampaignNames(campaignIds: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (campaignIds.length === 0) return names;

  try {
    const { campaigns } = await readCampaignAnalyticsFromDb(campaignIds);
    for (const campaign of campaigns) {
      if (campaign.id && campaign.name) {
        names.set(campaign.id, campaign.name);
      }
    }
  } catch (err) {
    await logError('client.leads.campaign_names_failed', err, { campaignIds });
  }

  return names;
}

async function readForwardedLeads(
  userId: string,
  fetchLimit: number,
): Promise<{ items: LeadListItem[]; total: number }> {
  if (!supabaseInstantly) return { items: [], total: 0 };

  const { data, count, error } = await supabaseInstantly
    .from('client_forwarded_leads')
    .select('*, client_lead_comments(count)', { count: 'exact' })
    .eq('client_user_id', userId)
    .order('created_at', { ascending: false })
    .range(0, fetchLimit - 1);

  if (error) {
    throw new Error(error.message);
  }

  const rows = (data ?? []) as Array<Omit<LeadListItem, 'source'>>;
  return {
    items: rows.map((row) => ({
      ...row,
      source: 'forwarded_lead',
      client_lead_comments: row.client_lead_comments ?? [],
    })),
    total: count ?? rows.length,
  };
}

async function readReplyItems(
  campaignIds: string[],
  campaignNames: Map<string, string>,
  search?: string,
): Promise<{ items: LeadListItem[]; failures: number }> {
  const settled = await Promise.allSettled(
    campaignIds.map(async (campaignId) => {
      const data = await listEmails({
        campaign_id: campaignId,
        ue_type: 2,
        limit: REPLIES_PER_CAMPAIGN,
        search,
      });

      return (data.items ?? []).map((email) => {
        const reply = mapInstantlyEmailToReply(email);
        const timestamp = reply.timestamp;
        const createdAt = timestamp ?? new Date(0).toISOString();

        return {
          id: `reply:${campaignId}:${reply.id}`,
          source: 'reply' as const,
          qualification_id: null,
          campaign_id: campaignId,
          campaign_name: campaignNames.get(campaignId) ?? null,
          lead_email: reply.from_email ?? '',
          lead_name: reply.from_name,
          company_name: null,
          phone: null,
          website: null,
          linkedin_url: null,
          reply_subject: reply.subject,
          reply_body: reply.body_text,
          last_outbound_preview: null,
          reply_timestamp: timestamp,
          status: reply.is_unread ? 'unread' : 'reply',
          ai_reason: reply.ai_interest_value == null
            ? null
            : `Interest: ${reply.ai_interest_value}`,
          created_at: createdAt,
          client_lead_comments: [],
          email_id: reply.id,
          lead_id: reply.lead_id,
          thread_id: reply.thread_id,
          is_unread: reply.is_unread,
          ai_interest_value: reply.ai_interest_value,
        } satisfies LeadListItem;
      });
    }),
  );

  const items: LeadListItem[] = [];
  let failures = 0;

  for (let i = 0; i < settled.length; i += 1) {
    const result = settled[i];
    if (result.status === 'fulfilled') {
      items.push(...result.value);
      continue;
    }

    failures += 1;
    await logError('client.leads.campaign_replies_failed', result.reason, {
      campaignId: campaignIds[i],
    });
  }

  return { items, failures };
}

async function enrichFromSyncedLeads(userId: string, items: LeadListItem[]) {
  if (!supabaseAdmin || items.length === 0) return;

  const emails = [...new Set(items.map((item) => item.lead_email).filter(Boolean))];
  if (emails.length === 0) return;

  const { data: synced } = await supabaseAdmin
    .from('client_campaign_leads')
    .select('email, first_name, last_name, company_name, website, linkedin_url')
    .eq('client_user_id', userId)
    .in('email', emails);

  if (!synced?.length) return;

  const byEmail = new Map((synced as SyncedLeadRow[]).map((row) => [row.email, row]));
  for (const item of items) {
    const match = byEmail.get(item.lead_email);
    if (!match) continue;
    if (!item.lead_name && (match.first_name || match.last_name)) {
      item.lead_name = [match.first_name, match.last_name].filter(Boolean).join(' ');
    }
    if (!item.company_name && match.company_name) item.company_name = match.company_name;
    if (!item.website && match.website) item.website = match.website;
    if (!item.linkedin_url && match.linkedin_url) item.linkedin_url = match.linkedin_url;
  }
}

export async function GET(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (result.auth.isDemo) return serveClientDemo(req);
  if (!supabaseInstantly) return jsonError('Server misconfigured', 500);

  const { accessRows, userId } = result.auth;

  const url = new URL(req.url);
  const limit = Math.min(parsePositiveInt(url.searchParams.get('limit'), DEFAULT_LIMIT), MAX_LIMIT);
  const offset = Math.max(0, parsePositiveInt(url.searchParams.get('offset'), 0));
  const search = url.searchParams.get('search')?.trim() || undefined;

  const allowedCampaignIds = filterAllowedIds([], accessRows, 'campaign');
  const forwardFetchLimit = Math.min(Math.max(offset + limit, limit), MAX_FORWARD_FETCH);

  let forwarded: { items: LeadListItem[]; total: number };
  try {
    forwarded = await readForwardedLeads(userId, forwardFetchLimit);
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : 'Ошибка загрузки', 500);
  }

  const campaignNames = await readCampaignNames(allowedCampaignIds);
  const { items: replyItems, failures } = await readReplyItems(
    allowedCampaignIds,
    campaignNames,
    search,
  );

  if (
    allowedCampaignIds.length > 0 &&
    failures === allowedCampaignIds.length &&
    forwarded.items.length === 0
  ) {
    return jsonError('Не удалось загрузить ответы', 502);
  }

  const merged = mergeAndSortItems([...forwarded.items, ...replyItems]);
  const total = merged.length + Math.max(0, forwarded.total - forwarded.items.length);
  const items = merged.slice(offset, offset + limit);

  await enrichFromSyncedLeads(userId, items);

  return NextResponse.json({
    items,
    total,
    limit,
    offset,
  });
}
