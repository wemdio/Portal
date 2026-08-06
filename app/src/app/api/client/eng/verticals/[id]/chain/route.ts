import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit, logError } from '@/lib/loggerServer';
import { loadClientHeVertical } from '@/lib/hypothesisEngine/apiGuards';
import { defaultChainLanguageForMarket, projectMarket } from '@/lib/hypothesisEngine/market';
import type { HeChainLanguage } from '@/lib/hypothesisEngine/types';

export const dynamic = 'force-dynamic';

const LANGUAGES: HeChainLanguage[] = ['ru', 'en', 'pl'];

// POST — поставить генерацию цепочки писем для СВОЕЙ вертикали.
// Дефолт языка — по рынку проекта (кабинет всегда market='us' → 'en'); явный
// language (ru/en/pl) в приоритете. Дедуп как у staff: активная chain-задача
// на эту вертикаль уже есть → возвращаем её со статусом 200.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const { id } = await params;
  if (!id) return jsonError('Missing id', 400);

  // null = язык явно не задан — дефолт вычислим по рынку проекта ниже.
  let language: HeChainLanguage | null = null;
  try {
    const body = (await req.json()) as { language?: unknown };
    if (body?.language !== undefined) {
      if (typeof body.language !== 'string' || !LANGUAGES.includes(body.language as HeChainLanguage)) {
        return jsonError('language must be ru, en or pl', 400);
      }
      language = body.language as HeChainLanguage;
    }
  } catch {
    // Пустое/битое тело = язык по умолчанию.
  }

  const owned = await loadClientHeVertical(supabaseAdmin, id, result.auth.userId);
  if (!owned.ok) return jsonError(owned.failure.message, owned.failure.status);

  const { data: active, error: activeErr } = await supabaseAdmin
    .from('he_jobs')
    .select('*')
    .eq('project_id', owned.vertical.project_id as string)
    .eq('stage', 'chain')
    .in('status', ['pending', 'running']);
  if (activeErr) return jsonError(activeErr.message, 500);
  const existing = (active ?? []).find(
    (j) => (j.payload as { vertical_id?: string } | null)?.vertical_id === id,
  );
  if (existing) return NextResponse.json({ ok: true, job: existing });

  if (language === null) {
    language = defaultChainLanguageForMarket(projectMarket(owned.project));
  }

  const { data: job, error: jobErr } = await supabaseAdmin
    .from('he_jobs')
    .insert({
      project_id: owned.vertical.project_id as string,
      stage: 'chain',
      status: 'pending',
      payload: { vertical_id: id, language },
    })
    .select()
    .single();
  if (jobErr || !job) {
    await logError('client.eng.chain.enqueue_failed', jobErr, { userId: result.auth.userId, verticalId: id });
    return jsonError(jobErr?.message ?? 'Failed to enqueue the job', 500);
  }

  void logAudit('client.eng.chain.enqueued', 'ENG cabinet chain enqueued', {
    userId: result.auth.userId,
    verticalId: id,
    language,
    jobId: job.id,
  });

  return NextResponse.json({ ok: true, job }, { status: 201 });
}
