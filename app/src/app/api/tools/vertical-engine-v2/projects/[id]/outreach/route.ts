import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { loadVeOutreachSetup } from '@/lib/verticalEngineV2/outreachSetup';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;
type Context = { params: Promise<{ id: string }> };
const uuid = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export async function GET(req: NextRequest, { params }: Context) {
  return withToolTrace({ request: req, operation: 'tools.vertical-engine-v2.outreach.get' }, async () => {
    const auth = await requireInternalToolAuth(req);
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 503 });
    try { return NextResponse.json(await loadVeOutreachSetup(supabaseAdmin, (await params).id)); }
    catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Не удалось загрузить подготовку' }, { status: 503 }); }
  });
}
export async function POST(req: NextRequest, { params }: Context) {
  return withToolTrace({ request: req, operation: 'tools.vertical-engine-v2.outreach.post' }, async () => {
    const auth = await requireInternalToolAuth(req);
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 503 });
    const projectId = (await params).id;
    const b = await req.json().catch(() => null);
    if (!uuid(projectId) || !b || typeof b !== 'object' || Array.isArray(b)
      || !Number.isSafeInteger(b.revision) || b.revision < 1) return NextResponse.json({ error: 'Нужна актуальная версия выбора' }, { status: 400 });
    try {
      let result;
      if (b.action === 'select') {
        if (!Array.isArray(b.hypothesis_ids) || b.hypothesis_ids.length > 50 || b.hypothesis_ids.some((id: unknown) => !uuid(id))
          || !['ru','en','pl'].includes(b.language)) {
          return NextResponse.json({ error: 'Выберите не более 50 гипотез и поддерживаемый язык' }, { status: 400 });
        }
        result = await supabaseAdmin.rpc('ve_save_outreach_setup', { p_project_id: projectId, p_revision: b.revision,
          p_hypothesis_ids: b.hypothesis_ids, p_language: b.language, p_actor: auth.auth.userId });
      } else if (b.action === 'prepare') {
        result = await supabaseAdmin.rpc('ve_request_outreach_preparation', { p_project_id: projectId, p_revision: b.revision });
      } else if (b.action === 'approve') {
        if (!uuid(b.base_id) || !uuid(b.template_id) || typeof b.reviewed_revision !== 'string'
          || !b.reviewed_revision.trim() || b.reviewed_revision.length > 128 || typeof b.approved !== 'boolean') {
          return NextResponse.json({ error: 'Укажите проверенную базу и версию писем' }, { status: 400 });
        }
        result = await supabaseAdmin.rpc('ve_approve_outreach_base', { p_project_id: projectId, p_revision: b.revision,
          p_base_id: b.base_id, p_template_id: b.template_id, p_reviewed_revision: b.reviewed_revision, p_approved: b.approved, p_actor: auth.auth.userId });
      } else return NextResponse.json({ error: 'Неизвестное действие' }, { status: 400 });
      if (result.error) return NextResponse.json({ error: result.error.message }, { status: 409 });
      return NextResponse.json(await loadVeOutreachSetup(supabaseAdmin, projectId));
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : 'Не удалось сохранить подготовку' }, { status: 503 });
    }
  });
}
