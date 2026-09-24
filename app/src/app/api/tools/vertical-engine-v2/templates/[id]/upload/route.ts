import { NextResponse, type NextRequest } from 'next/server';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { loadContactUploadProject, loadContactUploadStatus } from '@/lib/verticalEngineV2/contactUploadStatus';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Context) {
  return withToolTrace({ request: req, operation: 'tools.vertical-engine-v2.upload.get' }, async () => {
    const authed = await requireInternalToolAuth(req);
    if ('error' in authed) return authed.error;
    if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
    try {
      const projectId = await loadContactUploadProject(supabaseAdmin, (await params).id);
      return NextResponse.json(await loadContactUploadStatus(supabaseAdmin, projectId));
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : 'Загрузка недоступна' }, { status: 503 });
    }
  });
}

export async function POST(req: NextRequest, { params }: Context) {
  return withToolTrace({ request: req, operation: 'tools.vertical-engine-v2.upload.retry' }, async () => {
    const authed = await requireInternalToolAuth(req);
    if ('error' in authed) return authed.error;
    if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
    const body: unknown = await req.json().catch(() => null);
    const input = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
    if (input.action !== 'retry' || typeof input.run_id !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.run_id)
      || typeof input.blocked_at !== 'string' || !Number.isFinite(Date.parse(input.blocked_at))) {
      return NextResponse.json({ error: 'Обновите состояние загрузки и повторите попытку' }, { status: 400 });
    }
    try {
      const projectId = await loadContactUploadProject(supabaseAdmin, (await params).id);
      const { data, error } = await supabaseAdmin.rpc('ve_retry_contact_delivery_upload', {
        p_ve_project_id: projectId, p_run_id: input.run_id, p_blocked_at: input.blocked_at,
        p_actor_id: authed.auth.userId, p_now: new Date().toISOString(),
      });
      if (error) throw new Error(error.message);
      if (data?.ok !== true) throw new Error('Не удалось подтвердить запрос дозаливки');
      // The worker retains ownership checks, daily quota and the provider fence.
      return NextResponse.json({ ok: true, queued: true });
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : 'Не удалось продолжить загрузку' }, { status: 409 });
    }
  });
}
