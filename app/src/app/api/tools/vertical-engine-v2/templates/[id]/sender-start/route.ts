import { NextResponse, type NextRequest } from 'next/server';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { logAudit, logError } from '@/lib/loggerServer';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { loadContactUploadProject } from '@/lib/verticalEngineV2/contactUploadStatus';
import { startVeSenderBundle, VeSenderStartError } from '@/lib/verticalEngineV2/senderTransport/senderStart';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;
type Context = { params: Promise<{ id: string }> };

/**
 * POST — запустить кампании «Рассылки» запуска шаблона (черновики и паузы с
 * контактами). Проект — из шаблона, не из запроса; запускает
 * campaignOps.startCampaign, как кнопка «Рассылки».
 */
export async function POST(req: NextRequest, { params }: Context) {
  return withToolTrace({ request: req, operation: 'tools.vertical-engine-v2.sender.start' }, async () => {
    const authed = await requireInternalToolAuth(req);
    if ('error' in authed) return authed.error;
    if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
    const templateId = (await params).id;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(templateId)) {
      return NextResponse.json({ error: 'Шаблон не найден' }, { status: 404 });
    }
    let projectId: string;
    try {
      projectId = await loadContactUploadProject(supabaseAdmin, templateId);
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : 'Шаблон недоступен' }, { status: 404 });
    }
    try {
      const { results, notes, diagnostics } = await startVeSenderBundle(supabaseAdmin, supabaseInstantly, { veProjectId: projectId, templateId });
      void logAudit('tools.vertical-engine-v2.sender.started', 'VE2 sender campaigns started', {
        userId: authed.auth.userId,
        projectId,
        templateId,
        results: results.map((row) => ({
          campaign_id: row.campaign_id,
          outcome: row.outcome,
          ...(row.outcome === 'started' || !row.message ? {} : { message: row.message.slice(0, 300) }),
        })),
        ...(diagnostics.length ? { diagnostics: diagnostics.map((line) => line.slice(0, 500)) } : {}),
      });
      return NextResponse.json({ ok: true, results, notes });
    } catch (error) {
      if (error instanceof VeSenderStartError) {
        return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
      }
      void logError('tools.vertical-engine-v2.sender.start_failed', error, { userId: authed.auth.userId, projectId, templateId });
      return NextResponse.json({ error: 'Не удалось запустить кампании в «Рассылке». Обновите карточку и повторите.' }, { status: 503 });
    }
  });
}
