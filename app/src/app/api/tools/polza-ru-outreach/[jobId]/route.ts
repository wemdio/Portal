import { NextResponse, type NextRequest } from 'next/server';
import { logAudit, logError } from '@/lib/loggerServer';
import { jobHasSenderUploads, UPLOADED_JOB_DELETE_MESSAGE } from '@/lib/outreachSender/deletion';
import { authed, jsonError } from '@/lib/polzaRuOutreach/routeAuth';
import { RU_OUTREACH_PARSER_TYPE } from '@/lib/polzaRuOutreach/types';

export const dynamic = 'force-dynamic';

/** Остановка запуска: раннер увидит статус и выйдет между строками. */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  const auth = await authed(req);
  if ('error' in auth) return auth.error;
  const { jobId } = await ctx.params;
  let body: { action?: string } = {};
  try {
    body = (await req.json()) as { action?: string };
  } catch {
    /* пустое тело */
  }
  if (body.action !== 'stop') return jsonError('Unsupported action', 400);

  const { error } = await auth.supabase
    .from('parser_jobs')
    .update({
      status: 'failed',
      progress_stage: 'failed',
      error_message: 'Остановлено пользователем',
      completed_at: new Date().toISOString(),
    })
    .eq('id', jobId)
    .eq('parser_type', RU_OUTREACH_PARSER_TYPE)
    .in('status', ['pending', 'running']);
  if (error) {
    await logError('polza_ru_outreach.job.stop.failed', error, { jobId }, { userId: auth.user.id });
    return jsonError(error.message, 500);
  }
  await logAudit('polza_ru_outreach.job.stopped', 'Наш автоаутрич: запуск остановлен', { jobId }, { userId: auth.user.id });
  return NextResponse.json({ ok: true });
}

/**
 * Удаление запуска вместе с журналом. Запуск, залитый в «Рассылку», не
 * удаляется: его строки — память о том, что компаниям уже писали
 * (outreachSender/deletion.ts), без неё следующий запуск нашёл бы их снова.
 */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  const auth = await authed(req);
  if ('error' in auth) return auth.error;
  const { jobId } = await ctx.params;
  try {
    if (await jobHasSenderUploads(auth.supabase, 'ru', jobId)) return jsonError(UPLOADED_JOB_DELETE_MESSAGE, 409);
  } catch (e) {
    await logError('polza_ru_outreach.job.delete.failed', e, { jobId }, { userId: auth.user.id });
    return jsonError(e instanceof Error ? e.message : 'Не удалось проверить запуск', 500);
  }
  const { error } = await auth.supabase
    .from('parser_jobs')
    .delete()
    .eq('id', jobId)
    .eq('parser_type', RU_OUTREACH_PARSER_TYPE)
    .not('status', 'in', '(pending,running)');
  if (error) {
    await logError('polza_ru_outreach.job.delete.failed', error, { jobId }, { userId: auth.user.id });
    return jsonError(error.message, 500);
  }
  await logAudit('polza_ru_outreach.job.deleted', 'Наш автоаутрич: запуск удалён', { jobId }, { userId: auth.user.id });
  return NextResponse.json({ ok: true });
}
