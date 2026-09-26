import { NextResponse, type NextRequest } from 'next/server';
import { logError } from '@/lib/loggerServer';
import { describeTemplateFlag } from '@/lib/polzaOutreach/buildLetters';
import { authed, jsonError } from '@/lib/polzaOutreach/routeAuth';
import { PENDING_STALE_MS, REBUILD_LEASE_KEY } from '@/lib/polzaOutreach/templateWriter';
import { isPolzaOfferKey, POLZA_OFFER_LABELS } from '@/lib/polzaOutreach/types';

export const dynamic = 'force-dynamic';

const PAGE = 1000;

/**
 * Шаблоны цепочек запуска английского аутрича — для блока «Цепочки запуска»
 * на экране: оффер, статус, стоимость, письма шаблона с плейсхолдерами и
 * замечания проверки словами. waiting — сколько компаний ждут этот шаблон
 * (на ручной проверке с template_failed): их пересоберёт «Переписать
 * цепочку». stale — pending, чей процесс умер: её можно переписать заново.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  const auth = await authed(req);
  if ('error' in auth) return auth.error;
  const { jobId } = await ctx.params;

  const { data, error } = await auth.supabase
    .from('polza_chain_templates')
    .select('id,offer_key,status,letters,qa_flags,model,cost_usd,attempt,error,created_at,updated_at')
    .eq('job_id', jobId)
    .eq('lang', 'en')
    // Маркер «письма пересобираются» живёт в той же таблице — это не шаблон.
    .neq('offer_key', REBUILD_LEASE_KEY)
    .order('created_at', { ascending: true });
  if (error) {
    await logError('parser.polza_outreach.templates.list.failed', error, { jobId }, { userId: auth.user.id });
    return jsonError(error.message, 500);
  }

  // Строки, ждущие шаблон, помечены его id (раннер ставит chain_template_id
  // вместе с template_failed) — по нему и считаем.
  const waiting: Record<string, number> = {};
  for (let from = 0; ; from += PAGE) {
    const { data: rows, error: rowsErr } = await auth.supabase
      .from('polza_outreach_companies')
      .select('chain_template_id')
      .eq('job_id', jobId)
      .eq('status', 'needs_review')
      .like('review_reason', 'template_failed%')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (rowsErr) {
      await logError('parser.polza_outreach.templates.waiting.failed', rowsErr, { jobId }, { userId: auth.user.id });
      return jsonError(rowsErr.message, 500);
    }
    for (const r of rows ?? []) {
      const key = String(r.chain_template_id ?? '');
      if (key) waiting[key] = (waiting[key] ?? 0) + 1;
    }
    if (!rows || rows.length < PAGE) break;
  }

  const now = Date.now();
  const templates = (data ?? []).map((t) => {
    const offer = String(t.offer_key);
    const flags: string[] = Array.isArray(t.qa_flags) ? t.qa_flags : [];
    return {
      ...t,
      offer_label: isPolzaOfferKey(offer) ? POLZA_OFFER_LABELS[offer] : offer,
      // Замечания проверки словами — экран показывает их оператору.
      qa_flags_text: flags.map((flag) => describeTemplateFlag(flag, 'ru')),
      // numeric из PostgREST может прийти строкой.
      cost_usd: Number(t.cost_usd ?? 0) || 0,
      waiting: waiting[String(t.id)] ?? 0,
      stale: t.status === 'pending' && now - Date.parse(String(t.updated_at)) > PENDING_STALE_MS,
    };
  });
  return NextResponse.json({ templates });
}
