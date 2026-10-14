import { NextResponse, type NextRequest } from 'next/server';
import { logError } from '@/lib/loggerServer';
import { PENDING_STALE_MS } from '@/lib/polzaRuOutreach/letters/templateWriter';
import { describeTemplateFlag } from '@/lib/polzaRuOutreach/qa';
import { authed, jsonError } from '@/lib/polzaRuOutreach/routeAuth';
import { CHAIN_LABELS, type ChainType } from '@/lib/polzaRuOutreach/types';

export const dynamic = 'force-dynamic';

const PAGE = 1000;

/**
 * Шаблоны цепочек запуска — для блока «Цепочки запуска» на экране: оффер,
 * статус, стоимость, письма шаблона с плейсхолдерами и замечания проверки
 * словами (components/outreach/ChainTemplates.tsx). waiting — сколько
 * компаний оффера ждут цепочку (очень спорные с TEMPLATE_FAILED): их
 * пересоберёт «Переписать цепочку». stale — pending, чей процесс умер: её
 * можно переписать заново.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  const auth = await authed(req);
  if ('error' in auth) return auth.error;
  const { jobId } = await ctx.params;

  const { data, error } = await auth.supabase
    .from('polza_chain_templates')
    .select('id,offer_key,status,letters,qa_flags,model,cost_usd,attempt,error,created_at,updated_at')
    .eq('job_id', jobId)
    .eq('lang', 'ru')
    .order('created_at', { ascending: true });
  if (error) {
    await logError('polza_ru_outreach.templates.list.failed', error, { jobId }, { userId: auth.user.id });
    return jsonError(error.message, 500);
  }

  const waiting: Record<string, number> = {};
  for (let from = 0; ; from += PAGE) {
    const { data: rows, error: rowsErr } = await auth.supabase
      .from('polza_ru_outreach_companies')
      .select('chain_type')
      .eq('job_id', jobId)
      .eq('row_status', 'doubtful')
      .contains('doubt_flags', ['TEMPLATE_FAILED'])
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (rowsErr) return jsonError(rowsErr.message, 500);
    for (const r of rows ?? []) {
      const key = String(r.chain_type ?? '');
      waiting[key] = (waiting[key] ?? 0) + 1;
    }
    if (!rows || rows.length < PAGE) break;
  }

  const now = Date.now();
  const templates = (data ?? []).map((t) => {
    const flags: string[] = Array.isArray(t.qa_flags) ? t.qa_flags : [];
    return {
      ...t,
      offer_label: CHAIN_LABELS[t.offer_key as ChainType] ?? t.offer_key,
      // Замечания проверки словами — экран показывает их оператору, а
      // describeTemplateFlag живёт в серверном qa.ts (как у английского аутрича).
      qa_flags_text: flags.map((flag) => describeTemplateFlag(flag)),
      // numeric из PostgREST может прийти строкой.
      cost_usd: Number(t.cost_usd ?? 0) || 0,
      waiting: waiting[t.offer_key] ?? 0,
      stale: t.status === 'pending' && now - Date.parse(String(t.updated_at)) > PENDING_STALE_MS,
    };
  });
  return NextResponse.json({ templates });
}
