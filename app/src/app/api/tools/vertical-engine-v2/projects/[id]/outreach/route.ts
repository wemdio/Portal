import { after, NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { enqueueVeContactReprojections, loadVeOutreachSetup } from '@/lib/verticalEngineV2/outreachSetup';
import { VE_MAX_EMAILS_PER_COMPANY_MAX, VE_MAX_EMAILS_PER_COMPANY_MIN } from '@/lib/verticalEngineV2/companyContactCap';
import { checkVeContinuationRequest, checkVePreparationRequest, type VePreparationAction } from '@/lib/verticalEngineV2/preparationRequest';
import { logAudit } from '@/lib/loggerServer';
import { resolveVeLaunchTransport } from '@/lib/verticalEngineV2/senderTransport/transport';

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
    try {
      const projectId = (await params).id;
      const setup = await loadVeOutreachSetup(supabaseAdmin, projectId);
      // Куда пойдут новые кампании — только для подписей экрана; запуск проверит сам.
      const { transport } = await resolveVeLaunchTransport(supabaseAdmin, projectId);
      return NextResponse.json(transport === 'sender' ? { ...setup, launch_transport: 'sender' } : setup);
    }
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
      let preparationAction: VePreparationAction | undefined;
      const auditPreparation = (action: VePreparationAction) => logAudit(
        'tools.vertical-engine-v2.preparation.requested', 'Запрос продолжения подготовки',
        { project_id: projectId, hypothesis_id: action.hypothesis_id, base_id: action.base_id ?? null,
          outcome: action.status, reason_code: action.code ?? null, revision: b.revision },
        { userId: auth.auth.userId, route: '/api/tools/vertical-engine-v2/projects/[id]/outreach' },
      );
      if (b.action === 'check_continuation') {
        if (!uuid(b.hypothesis_id)) return NextResponse.json({ error: 'Укажите гипотезу для проверки' }, { status: 400 });
        if (b.check_only !== undefined && typeof b.check_only !== 'boolean') return NextResponse.json({ error: 'Некорректный режим проверки' }, { status: 400 });
        const check = await checkVeContinuationRequest(supabaseAdmin, projectId, b.revision, b.hypothesis_id);
        await logAudit('tools.vertical-engine-v2.continuation.checked', 'Проверка возможности продолжения',
          { project_id: projectId, hypothesis_id: check.hypothesis_id, base_id: check.base_id ?? null,
            outcome: check.status, reason_code: check.code ?? null, revision: b.revision },
          { userId: auth.auth.userId, route: '/api/tools/vertical-engine-v2/projects/[id]/outreach' });
        // A negative verdict is also a successful check. Never fall through to
        // the prepare RPC, even when the preflight finds available work.
        // Automatic checks need no project-wide preview hashes. Keep the full
        // response for a previously deployed frontend during rolling releases.
        if (b.check_only === true) return NextResponse.json({ continuation_check: check });
        return NextResponse.json({ ...await loadVeOutreachSetup(supabaseAdmin, projectId), continuation_check: check });
      } else if (b.action === 'select') {
        if (!Array.isArray(b.hypothesis_ids) || b.hypothesis_ids.length > 50 || b.hypothesis_ids.some((id: unknown) => !uuid(id))
          || !['ru','en','pl'].includes(b.language)) {
          return NextResponse.json({ error: 'Выберите не более 50 гипотез и поддерживаемый язык' }, { status: 400 });
        }
        result = await supabaseAdmin.rpc('ve_save_outreach_setup', { p_project_id: projectId, p_revision: b.revision,
          p_hypothesis_ids: b.hypothesis_ids, p_language: b.language, p_actor: auth.auth.userId });
      } else if (b.action === 'prepare') {
        if (b.hypothesis_id !== undefined && !uuid(b.hypothesis_id)) {
          return NextResponse.json({ error: 'Укажите гипотезу для продолжения' }, { status: 400 });
        }
        if (b.hypothesis_id !== undefined) {
          preparationAction = await checkVePreparationRequest(supabaseAdmin, projectId, b.revision, b.hypothesis_id);
          if (preparationAction.status !== 'queued') {
            await auditPreparation(preparationAction);
            if (preparationAction.status === 'unavailable') return NextResponse.json({
              error: preparationAction.reason, preparation_action: preparationAction,
            }, { status: 409 });
            return NextResponse.json({ ...await loadVeOutreachSetup(supabaseAdmin, projectId), preparation_action: preparationAction });
          }
        }
        result = b.hypothesis_id === undefined
          ? await supabaseAdmin.rpc('ve_request_outreach_preparation', { p_project_id: projectId, p_revision: b.revision })
          : await supabaseAdmin.rpc('ve_request_outreach_hypothesis_preparation', {
            p_project_id: projectId, p_revision: b.revision, p_hypothesis_id: b.hypothesis_id,
            p_resume_collection: preparationAction?.resume_collection === true,
          });
      } else if (b.action === 'pause') {
        if (!uuid(b.hypothesis_id)) return NextResponse.json({ error: 'Укажите базу для паузы' }, { status: 400 });
        result = await supabaseAdmin.rpc('ve_pause_outreach_hypothesis_preparation', {
          p_project_id: projectId, p_revision: b.revision, p_hypothesis_id: b.hypothesis_id,
        });
        if (!result.error) await logAudit('tools.vertical-engine-v2.preparation.paused', 'Подготовка базы приостановлена',
          { project_id: projectId, hypothesis_id: b.hypothesis_id, revision: b.revision },
          { userId: auth.auth.userId, route: '/api/tools/vertical-engine-v2/projects/[id]/outreach' });
      } else if (b.action === 'approve') {
        if (!uuid(b.base_id) || !uuid(b.template_id) || typeof b.reviewed_revision !== 'string'
          || !b.reviewed_revision.trim() || b.reviewed_revision.length > 128 || typeof b.approved !== 'boolean') {
          return NextResponse.json({ error: 'Укажите проверенную базу и версию писем' }, { status: 400 });
        }
        result = await supabaseAdmin.rpc('ve_approve_outreach_base', { p_project_id: projectId, p_revision: b.revision,
          p_base_id: b.base_id, p_template_id: b.template_id, p_reviewed_revision: b.reviewed_revision, p_approved: b.approved, p_actor: auth.auth.userId });
      } else if (b.action === 'contact_limit') {
        const max = b.max_emails_per_company;
        if (max !== null && (!Number.isSafeInteger(max) || max < VE_MAX_EMAILS_PER_COMPANY_MIN || max > VE_MAX_EMAILS_PER_COMPANY_MAX)) {
          return NextResponse.json({ error: 'Укажите целое число от 1 до 100 или оставьте поле пустым' }, { status: 400 });
        }
        result = await supabaseAdmin.rpc('ve_save_outreach_contact_limit', { p_project_id: projectId, p_revision: b.revision,
          p_max: max, p_actor: auth.auth.userId });
        if (!result.error) {
          // Finished bases are re-partitioned by the worker (no paid work). This is
          // only a nudge for the project just edited: a base that is busy right now
          // keeps the mismatch and the worker sweep picks it up later.
          const db = supabaseAdmin;
          const apply = () => enqueueVeContactReprojections(db, { projectId }).then(() => undefined, () => undefined);
          try { after(apply); } catch { void apply(); }
        }
      } else return NextResponse.json({ error: 'Неизвестное действие' }, { status: 400 });
      if (result.error) return NextResponse.json({ error: result.error.message }, { status: 409 });
      const response = await loadVeOutreachSetup(supabaseAdmin, projectId);
      if (b.action === 'prepare') {
        preparationAction ??= { status: 'queued', hypothesis_id: null,
          reason: 'Запрос принят. Подготовка продолжится автоматически.' };
        // "Queued" acknowledges a durable request, never promises a worker has
        // already started. Keep the result scoped to the card that was clicked.
        await auditPreparation(preparationAction);
        return NextResponse.json({ ...response, preparation_action: preparationAction });
      }
      return NextResponse.json(response);
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : 'Не удалось сохранить подготовку' }, { status: 503 });
    }
  });
}
