import { NextResponse, type NextRequest } from 'next/server';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { resolveVeLaunchTransport } from '@/lib/verticalEngineV2/senderTransport/transport';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };

/**
 * GET — куда пойдёт новый запуск шаблона: Instantly или «Рассылка». Только
 * для подписей экрана до обзора плана: запуск проверяет способ сам. Ошибка —
 * Instantly, как у самого решения.
 */
export async function GET(req: NextRequest, { params }: Context) {
  return withToolTrace({ request: req, operation: 'tools.vertical-engine-v2.launch-transport.get' }, async () => {
    const authed = await requireInternalToolAuth(req);
    if ('error' in authed) return authed.error;
    if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
    const templateId = (await params).id;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(templateId)) {
      return NextResponse.json({ error: 'Шаблон не найден' }, { status: 404 });
    }
    const { data: template, error: templateError } = await supabaseAdmin.from('ve_templates')
      .select('base_id').eq('id', templateId).maybeSingle();
    if (templateError || !template?.base_id) return NextResponse.json({ transport: 'instantly' });
    const { data: base, error: baseError } = await supabaseAdmin.from('ve_bases')
      .select('project_id').eq('id', template.base_id).maybeSingle();
    if (baseError || !base?.project_id) return NextResponse.json({ transport: 'instantly' });
    const { transport } = await resolveVeLaunchTransport(supabaseAdmin, base.project_id);
    return NextResponse.json({ transport });
  });
}
