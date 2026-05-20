import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { serveClientDemo } from '@/lib/clientDemo/demoResponse';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { listEmails } from '@/lib/instantly/client';
import { mapInstantlyEmailToReply } from '@/lib/clientCampaignReplies/mapEmail';
import { getResourceInstantlyAccountId, type ClientAccessRow } from '@/lib/clientAccess';

export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const REPLIES_PER_CAMPAIGN = 100;

type LeadSource = 'forwarded_lead';

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

async function readForwardedLeads(
  userId: string,
  limit: number,
  offset: number,
  search?: string,
): Promise<{ items: LeadListItem[]; total: number }> {
  if (!supabaseInstantly) return { items: [], total: 0 };

  let query = supabaseInstantly
    .from('client_forwarded_leads')
    .select('*, client_lead_comments(count)', { count: 'exact' })
    .eq('client_user_id', userId)
    .order('created_at', { ascending: false });

  if (search) {
    const safeSearch = search.replaceAll(',', ' ').trim();
    query = query.or(
      `lead_email.ilike.%${safeSearch}%,lead_name.ilike.%${safeSearch}%,company_name.ilike.%${safeSearch}%,campaign_name.ilike.%${safeSearch}%`,
    );
  }

  const { data, count, error } = await query.range(offset, offset + limit - 1);

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

function timestampDistance(a: string | null, b: string | null): number {
  const ta = a ? Date.parse(a) : NaN;
  const tb = b ? Date.parse(b) : NaN;
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return Number.POSITIVE_INFINITY;
  return Math.abs(ta - tb);
}

async function enrichFromInstantlyReplies(items: LeadListItem[], accessRows: ClientAccessRow[]) {
  const pending = items.filter((item) => item.campaign_id && item.lead_email && !item.email_id);
  if (pending.length === 0) return;

  const byCampaign = new Map<string, LeadListItem[]>();
  for (const item of pending) {
    const list = byCampaign.get(item.campaign_id) ?? [];
    list.push(item);
    byCampaign.set(item.campaign_id, list);
  }

  await Promise.allSettled([...byCampaign.entries()].map(async ([campaignId, campaignItems]) => {
    const data = await listEmails({
      campaign_id: campaignId,
      ue_type: 2,
      limit: REPLIES_PER_CAMPAIGN,
    }, {
      accountId: getResourceInstantlyAccountId(campaignId, accessRows, 'campaign'),
    });

    const replies = (data.items ?? []).map((email) => {
      const reply = mapInstantlyEmailToReply(email);
      return { email, reply };
    });

    for (const item of campaignItems) {
      const itemEmail = item.lead_email.trim().toLowerCase();
      const matches = replies.filter(({ reply }) => (
        reply.from_email?.trim().toLowerCase() === itemEmail
      ));
      if (matches.length === 0) continue;

      matches.sort((a, b) => (
        timestampDistance(a.reply.timestamp, item.reply_timestamp) -
        timestampDistance(b.reply.timestamp, item.reply_timestamp)
      ));

      const match = matches[0];
      item.email_id = match.reply.id;
      item.lead_id = match.reply.lead_id;
      item.thread_id = match.reply.thread_id;
      item.is_unread = match.reply.is_unread;
      item.ai_interest_value = match.reply.ai_interest_value;
    }
  }));
}

export async function GET(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (result.auth.isDemo) return serveClientDemo(req);
  if (!supabaseInstantly) return jsonError('Server misconfigured', 500);

  const { userId, accessRows } = result.auth;

  const url = new URL(req.url);
  const limit = Math.min(parsePositiveInt(url.searchParams.get('limit'), DEFAULT_LIMIT), MAX_LIMIT);
  const offset = Math.max(0, parsePositiveInt(url.searchParams.get('offset'), 0));
  const search = url.searchParams.get('search')?.trim() || undefined;

  let forwarded: { items: LeadListItem[]; total: number };
  try {
    forwarded = await readForwardedLeads(userId, limit, offset, search);
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : 'Ошибка загрузки', 500);
  }

  const items = forwarded.items;

  await enrichFromSyncedLeads(userId, items);
  await enrichFromInstantlyReplies(items, accessRows);

  return NextResponse.json({
    items,
    total: forwarded.total,
    limit,
    offset,
  });
}
