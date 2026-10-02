import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { buildReplyPrompt } from '@/lib/replyPersonalization/buildPrompt';
import type { CampaignStepText } from '@/lib/replyPersonalization/campaignSequence';
import { getGlobalKnowledgeBase, getGlobalSystemPrompt } from '@/lib/replyPersonalization/db';
import { generateReplyWithSearch } from '@/lib/replyPersonalization/geminiClient';
import type { ReplyLanguage, ThreadMessage } from '@/lib/replyPersonalization/types';

/**
 * Персонализированный ответ лиду «Рассылки» — те же правила и та же модель,
 * что у инструмента «Персонализированные ответы» (lib/replyPersonalization),
 * но переписка, кампания и бриф — свои, из таблиц «Рассылки». Instantly здесь
 * не участвует: наши письма лежат в sender_messages, ответы — в sender_replies,
 * ручные ответы — в sender_manual_messages.
 */

/** Одно письмо длиннее не бывает; хвосты цитат обрезаем, не текст. */
const MAX_BODY = 6000;

export class SenderDraftError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

interface RecipientRow {
  id: string;
  email: string;
  name: string | null;
  campaign_id: string;
  vars: Record<string, unknown> | null;
  reply_language: ReplyLanguage | null;
}

interface CampaignRow {
  id: string;
  name: string;
  source_kind: string | null;
  reply_brief: string;
  reply_tone: string;
  reply_example: string;
  sender_folders: { key: string } | { key: string }[] | null;
}

export interface SenderReplyContext {
  recipient: RecipientRow;
  campaign: CampaignRow;
  thread: ThreadMessage[];
  steps: CampaignStepText[];
  language: ReplyLanguage;
}

function clip(text: string | null | undefined): string {
  const t = (text ?? '').trim();
  return t.length > MAX_BODY ? `${t.slice(0, MAX_BODY)}…` : t;
}

/** Язык по умолчанию: английский у английского автоаутрича, иначе русский. */
export function defaultReplyLanguage(campaign: Pick<CampaignRow, 'source_kind' | 'sender_folders'>): ReplyLanguage {
  const folder = Array.isArray(campaign.sender_folders) ? campaign.sender_folders[0] : campaign.sender_folders;
  return campaign.source_kind === 'polza_en' || folder?.key === 'auto_en' ? 'en' : 'ru';
}

export async function loadSenderReplyContext(db: SupabaseClient, recipientId: string): Promise<SenderReplyContext> {
  const { data: recipient, error: recipientError } = await db
    .from('sender_recipients')
    .select('id, email, name, campaign_id, vars, reply_language')
    .eq('id', recipientId)
    .maybeSingle();
  if (recipientError) throw new SenderDraftError(recipientError.message, 500);
  if (!recipient) throw new SenderDraftError('Переписка не найдена', 404);

  const [{ data: campaign, error: campaignError }, { data: messages }, { data: replies }, { data: manual }] = await Promise.all([
    db.from('sender_campaigns')
      .select('id, name, source_kind, reply_brief, reply_tone, reply_example, sender_folders(key)')
      .eq('id', recipient.campaign_id)
      .maybeSingle(),
    db.from('sender_messages')
      .select('step_no, subject, body, sent_at')
      .eq('recipient_id', recipientId)
      .eq('status', 'sent')
      .order('step_no')
      .limit(50),
    db.from('sender_replies')
      .select('body, kind, received_at, created_at')
      .eq('recipient_id', recipientId)
      .in('kind', ['human', 'unknown'])
      .order('created_at')
      .limit(50),
    db.from('sender_manual_messages')
      .select('body, sent_at, created_at')
      .eq('recipient_id', recipientId)
      .eq('status', 'sent')
      .order('created_at')
      .limit(50),
  ]);
  if (campaignError) throw new SenderDraftError(campaignError.message, 500);
  if (!campaign) throw new SenderDraftError('Кампания переписки не найдена', 404);

  const sent = (messages ?? []) as Array<{ step_no: number; subject: string | null; body: string | null; sent_at: string | null }>;
  const thread: ThreadMessage[] = [
    ...sent.map((m) => ({ fromUs: true, text: clip(m.body), timestamp: m.sent_at ?? undefined })),
    ...((replies ?? []) as Array<{ body: string | null; received_at: string | null; created_at: string }>).map((r) => ({
      fromUs: false,
      text: clip(r.body),
      timestamp: r.received_at ?? r.created_at,
    })),
    ...((manual ?? []) as Array<{ body: string | null; sent_at: string | null; created_at: string }>).map((m) => ({
      fromUs: true,
      text: clip(m.body),
      timestamp: m.sent_at ?? m.created_at,
    })),
  ]
    .filter((m) => m.text)
    .sort((a, b) => new Date(a.timestamp ?? 0).getTime() - new Date(b.timestamp ?? 0).getTime());

  // Цепочка кампании — те же отправленные письма по шагам: шаблон кампании
  // хранит {{email_N}}, а реальный текст есть только в отправленных.
  const steps: CampaignStepText[] = sent.map((m) => ({ step: m.step_no, subject: m.subject ?? '', body: clip(m.body) }));

  const typedCampaign = campaign as unknown as CampaignRow;
  const typedRecipient = recipient as unknown as RecipientRow;
  return {
    recipient: typedRecipient,
    campaign: typedCampaign,
    thread,
    steps,
    language: typedRecipient.reply_language ?? defaultReplyLanguage(typedCampaign),
  };
}

export interface SenderDraftResult {
  id: string;
  text: string;
  factsUsed: string;
  sources: Array<{ url: string; title?: string }>;
  language: ReplyLanguage;
  createdAt: string;
}

export async function generateSenderDraft(
  db: SupabaseClient,
  recipientId: string,
  userId: string,
  language: ReplyLanguage,
): Promise<SenderDraftResult> {
  const ctx = await loadSenderReplyContext(db, recipientId);
  if (!ctx.thread.some((m) => !m.fromUs)) {
    throw new SenderDraftError('Отвечать пока не на что: в переписке нет ответа получателя', 409);
  }

  const [globalKb, systemPrompt] = await Promise.all([getGlobalKnowledgeBase(), getGlobalSystemPrompt()]);
  const vars = ctx.recipient.vars ?? {};
  const companyName = ctx.recipient.name || (typeof vars.company === 'string' ? vars.company : null);

  const messages = buildReplyPrompt({
    kb: { toneNotes: ctx.campaign.reply_tone ?? '', exampleCase: ctx.campaign.reply_example ?? '', productFacts: '' },
    globalKb,
    systemPrompt,
    brief: ctx.campaign.reply_brief ?? '',
    qualification: { companyName, leadEmail: ctx.recipient.email },
    thread: ctx.thread,
    contextComplete: true,
    campaignSteps: ctx.steps,
    language,
  });

  const started = Date.now();
  const result = await generateReplyWithSearch(messages);
  const factsUsed = result.sources.map((s) => s.title || s.url).join(', ');

  const { data, error } = await db
    .from('sender_reply_drafts')
    .insert({
      recipient_id: recipientId,
      campaign_id: ctx.campaign.id,
      generated_text: result.text,
      facts_used: factsUsed,
      sources: result.sources,
      language,
      model: result.model,
      latency_ms: Date.now() - started,
      created_by: userId,
    })
    .select('id, created_at')
    .single();
  if (error) throw new SenderDraftError(error.message, 500);

  // Выбор языка запоминаем на переписке: следующий сотрудник увидит тот же.
  await db.from('sender_recipients').update({ reply_language: language }).eq('id', recipientId);

  return { id: data.id, text: result.text, factsUsed, sources: result.sources, language, createdAt: data.created_at };
}

/** Последний неотправленный черновик переписки — чтобы он пережил перезагрузку страницы. */
export async function latestOpenDraft(db: SupabaseClient, recipientId: string): Promise<SenderDraftResult | null> {
  const { data } = await db
    .from('sender_reply_drafts')
    .select('id, generated_text, facts_used, sources, language, created_at, status')
    .eq('recipient_id', recipientId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data || data.status !== 'draft') return null;
  return {
    id: data.id,
    text: data.generated_text,
    factsUsed: data.facts_used ?? '',
    sources: Array.isArray(data.sources) ? data.sources : [],
    language: data.language === 'en' ? 'en' : 'ru',
    createdAt: data.created_at,
  };
}
