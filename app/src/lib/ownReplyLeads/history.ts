import type { SupabaseClient } from '@supabase/supabase-js';

/** История блока «Instantly · наши кампании»: оценки ответов и что сделано в AMO. */

export type OwnHistoryFilter = 'all' | 'lead' | 'not_lead' | 'pending' | 'error';
const FILTERS: OwnHistoryFilter[] = ['all', 'lead', 'not_lead', 'pending', 'error'];
const PAGE_SIZE = 30;

export function parseOwnFilter(raw: string | null): OwnHistoryFilter {
  return FILTERS.includes(raw as OwnHistoryFilter) ? (raw as OwnHistoryFilter) : 'all';
}

export interface OwnHistoryRowDto {
  emailId: string;
  campaignName: string;
  leadEmail: string;
  replySubject: string | null;
  replyPreview: string | null;
  replyAt: string | null;
  status: 'pending' | 'lead' | 'not_lead' | 'error' | 'skipped';
  aiReason: string | null;
  lastError: string | null;
  attempts: number;
  handoffNote: string | null;
  aiReply: { status: string; decision: string | null; reason: string | null; sentAt: string | null } | null;
  aiReplyStatus: string | null;
  crm: {
    status: 'pending' | 'sent' | 'failed';
    action: 'created' | 'note_added' | null;
    leadUrl: string | null;
    amoLeadName: string | null;
    error: string | null;
    tgSentAt: string | null;
    tgError: string | null;
  } | null;
}

export interface OwnHistoryDto {
  rows: OwnHistoryRowDto[];
  counts: Record<OwnHistoryFilter, number>;
  total: number;
  page: number;
  pageSize: number;
}

type Db = Pick<SupabaseClient, 'from'>;

async function countOf(db: Db, filter: OwnHistoryFilter): Promise<number> {
  let q = db.from('own_reply_qualifications').select('email_id', { count: 'exact', head: true });
  if (filter !== 'all') q = q.eq('status', filter);
  const { count, error } = await q;
  if (error) throw new Error(error.message);
  return count ?? 0;
}

export async function loadOwnHistory(db: Db, filter: OwnHistoryFilter, page: number): Promise<OwnHistoryDto> {
  const safePage = Math.max(1, Math.floor(page) || 1);
  const countsList = await Promise.all(FILTERS.map((f) => countOf(db, f)));
  const counts = Object.fromEntries(FILTERS.map((f, i) => [f, countsList[i]])) as Record<OwnHistoryFilter, number>;

  let q = db
    .from('own_reply_qualifications')
    .select('email_id, campaign_name, lead_email, reply_subject, reply_preview, reply_timestamp, status, ai_reason, last_error, attempts, handoff_note, ai_reply_status')
    .order('reply_timestamp', { ascending: false, nullsFirst: false })
    .range((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE - 1);
  if (filter !== 'all') q = q.eq('status', filter);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const quals = (data ?? []) as Array<{
    email_id: string; campaign_name: string; lead_email: string; reply_subject: string | null; reply_preview: string | null;
    reply_timestamp: string | null; status: OwnHistoryRowDto['status']; ai_reason: string | null; last_error: string | null;
    attempts: number; handoff_note: string | null; ai_reply_status: string | null;
  }>;

  const pushes = new Map<string, OwnHistoryRowDto['crm']>();
  const aiReplies = new Map<string, NonNullable<OwnHistoryRowDto['aiReply']>>();
  if (quals.length) {
    const { data: turns, error: turnError } = await db.from('own_reply_ai_turns')
      .select('email_id, status, decision, reason, sent_at').in('email_id', quals.map((r) => r.email_id));
    if (turnError) throw new Error(turnError.message);
    for (const t of turns ?? []) aiReplies.set(t.email_id, {
      status: t.status, decision: t.decision, reason: t.reason, sentAt: t.sent_at,
    });
    const { data: pushRows, error: pushError } = await db
      .from('own_reply_crm_pushes')
      .select('qualification_id, status, action, lead_url, amo_lead_name, error_message, tg_sent_at, tg_error, created_at')
      .in('qualification_id', quals.map((r) => r.email_id))
      .order('created_at', { ascending: true });
    if (pushError) throw new Error(pushError.message);
    for (const p of (pushRows ?? []) as Array<{
      qualification_id: string; status: 'pending' | 'sent' | 'failed'; action: 'created' | 'note_added' | null;
      lead_url: string | null; amo_lead_name: string | null; error_message: string | null; tg_sent_at: string | null; tg_error: string | null;
    }>) {
      // Последняя задача ответа — главная (упавшую мог сменить повтор).
      pushes.set(p.qualification_id, {
        status: p.status, action: p.action, leadUrl: p.lead_url, amoLeadName: p.amo_lead_name,
        error: p.error_message, tgSentAt: p.tg_sent_at, tgError: p.tg_error,
      });
    }
  }

  return {
    rows: quals.map((r) => ({
      emailId: r.email_id,
      campaignName: r.campaign_name,
      leadEmail: r.lead_email,
      replySubject: r.reply_subject,
      replyPreview: r.reply_preview,
      replyAt: r.reply_timestamp,
      status: r.status,
      aiReason: r.ai_reason,
      lastError: r.last_error,
      attempts: r.attempts,
      handoffNote: r.handoff_note,
      aiReply: aiReplies.get(r.email_id) ?? null,
      aiReplyStatus: r.ai_reply_status,
      crm: pushes.get(r.email_id) ?? null,
    })),
    counts,
    total: counts[filter],
    page: safePage,
    pageSize: PAGE_SIZE,
  };
}
