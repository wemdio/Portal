/**
 * Фоновое выполнение задач tg_parser_jobs (отдельный Docker worker).
 */
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { parseTgUsers } from '@/lib/tgParser/parser';
import { clampTgParserMaxContactsPerRun } from '@/lib/tgParser/constants';
import type { TgParserAccount } from '@/lib/tgParser/types';

export type TgParserJobConfig = {
  links: string[];
  parse_chat_messages?: boolean;
  parse_chat_members?: boolean;
  parse_post_comments?: boolean;
  message_limit?: number;
  filter_online?: boolean;
  filter_recently?: boolean;
  max_offline_days?: number | null;
  is_target?: boolean;
  account_label?: string;
  links_summary?: string;
};

export async function runTgParserJob(jobId: string): Promise<void> {
  const db = supabaseAdmin;
  if (!db) {
    console.error('[tg-parser-job] supabaseAdmin missing');
    return;
  }

  const { data: job, error: loadErr } = await db
    .from('tg_parser_jobs')
    .select('id, status, config, account_id')
    .eq('id', jobId)
    .single();

  if (loadErr || !job) {
    console.error('[tg-parser-job] load failed', loadErr);
    return;
  }
  if (job.status !== 'running') return;

  const cfg = job.config as TgParserJobConfig;
  const links = Array.isArray(cfg.links) ? cfg.links.filter((l): l is string => typeof l === 'string') : [];
  if (links.length === 0) {
    await db
      .from('tg_parser_jobs')
      .update({
        status: 'error',
        error_message: 'Пустой список ссылок',
        completed_at: new Date().toISOString(),
      })
      .eq('id', jobId);
    return;
  }

  let account: TgParserAccount | undefined;
  let max_contacts: number | null = null;
  const accountId = typeof job.account_id === 'string' ? job.account_id.trim() : '';

  if (cfg.is_target) {
    if (!process.env.TG_TARGET_API_ID || !process.env.TG_TARGET_SESSION) {
      await db
        .from('tg_parser_jobs')
        .update({
          status: 'error',
          error_message: 'Целевой аккаунт не настроен на сервере',
          completed_at: new Date().toISOString(),
        })
        .eq('id', jobId);
      return;
    }
    account = {
      api_id: Number(process.env.TG_TARGET_API_ID),
      api_hash: process.env.TG_TARGET_API_HASH || '',
      session_data: process.env.TG_TARGET_SESSION,
    };
    max_contacts = clampTgParserMaxContactsPerRun(50000); // Higher limit for target parsing
  } else if (accountId) {
    const { data: row } = await db
      .from('tg_parser_accounts')
      .select('api_id, api_hash, session_data, proxy_url, max_contacts_per_run')
      .eq('id', accountId)
      .eq('is_active', true)
      .single();
    if (!row?.session_data) {
      await db
        .from('tg_parser_jobs')
        .update({
          status: 'error',
          error_message: 'Аккаунт не найден или неактивен',
          completed_at: new Date().toISOString(),
        })
        .eq('id', jobId);
      return;
    }
    account = {
      api_id: row.api_id,
      api_hash: row.api_hash,
      session_data: row.session_data,
      proxy_url: row.proxy_url || undefined,
    };
    max_contacts = clampTgParserMaxContactsPerRun(row.max_contacts_per_run);
  }

  try {
    const result = await parseTgUsers({
      links,
      parse_chat_messages: cfg.parse_chat_messages ?? true,
      parse_chat_members: cfg.parse_chat_members ?? true,
      parse_post_comments: cfg.parse_post_comments ?? true,
      message_limit: Math.min(5000, Math.max(10, Number(cfg.message_limit) || 100)),
      filter_online: Boolean(cfg.filter_online),
      filter_recently: Boolean(cfg.filter_recently),
      max_offline_days: cfg.max_offline_days != null ? Number(cfg.max_offline_days) : null,
      account,
      max_contacts,
    });

    if (result.status === 'error') {
      await db
        .from('tg_parser_jobs')
        .update({
          status: 'error',
          error_message: result.error,
          completed_at: new Date().toISOString(),
        })
        .eq('id', jobId);
      return;
    }

    if (result.status === 'partial') {
      await db
        .from('tg_parser_jobs')
        .update({
          status: 'done',
          result_users: result.users,
          stop_reason: result.stop_reason,
          error_message: result.error ?? null,
          completed_at: new Date().toISOString(),
        })
        .eq('id', jobId);
      return;
    }

    await db
      .from('tg_parser_jobs')
      .update({
        status: 'done',
        result_users: result.users,
        stop_reason: null,
        error_message: null,
        completed_at: new Date().toISOString(),
      })
      .eq('id', jobId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[tg-parser-job] run failed', err);
    await db
      .from('tg_parser_jobs')
      .update({
        status: 'error',
        error_message: msg,
        completed_at: new Date().toISOString(),
      })
      .eq('id', jobId);
  }
}
