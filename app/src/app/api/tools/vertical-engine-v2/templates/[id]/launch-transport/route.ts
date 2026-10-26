import { NextResponse, type NextRequest } from 'next/server';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { veSenderTemplateIssue } from '@/lib/verticalEngineV2/senderTransport/senderLaunchPlan';
import { readVeSenderLaunchAvailability, veSenderOptionView } from '@/lib/verticalEngineV2/senderTransport/transport';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };

/**
 * GET — можно ли выбрать «Рассылку» для нового запуска шаблона (этап 7:
 * способ выбирает специалист, по умолчанию Instantly). transport — для
 * открытых до выкладки вкладок: всегда Instantly. sender: offered — показывать
 * ли вариант, allowed — можно ли выбрать сейчас, reason — почему нет. Письма,
 * которые «Рассылка» не примет (больше 5 писем, лишние варианты), — тоже
 * причина. Сам запуск проверяет всё ещё раз.
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
    const unknown = { offered: true, allowed: false, reason: 'Не удалось проверить, доступна ли «Рассылка». Повторите.' };
    const { data: template, error: templateError } = await supabaseAdmin.from('ve_templates')
      .select('base_id, letters').eq('id', templateId).maybeSingle();
    if (templateError) return NextResponse.json({ transport: 'instantly', sender: unknown });
    if (!template?.base_id) return NextResponse.json({ error: 'Шаблон не найден' }, { status: 404 });
    const { data: base, error: baseError } = await supabaseAdmin.from('ve_bases')
      .select('project_id').eq('id', template.base_id).maybeSingle();
    if (baseError) return NextResponse.json({ transport: 'instantly', sender: unknown });
    if (!base?.project_id) return NextResponse.json({ error: 'Шаблон не найден' }, { status: 404 });
    const availability = await readVeSenderLaunchAvailability(supabaseAdmin, base.project_id);
    const letterIssue = availability.allowed ? veSenderTemplateIssue((template as { letters?: unknown }).letters) : null;
    return NextResponse.json({
      transport: 'instantly',
      sender: veSenderOptionView(availability, letterIssue ? `${letterIssue.error} Этот шаблон можно запустить через Instantly.` : null),
    });
  });
}
