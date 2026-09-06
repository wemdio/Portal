import { NextResponse, type NextRequest } from 'next/server';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { approveVeContactSupply } from '@/lib/verticalEngineV2/contactSupplyApproval';
import { loadVeContactSupplyStatus } from '@/lib/verticalEngineV2/contactSupplyStatus';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;
type Context = { params: Promise<{ id: string }> };
const clean = (value: unknown) => typeof value === 'string' ? value.trim() : '';

export async function GET(req: NextRequest, { params }: Context) {
  return withToolTrace({ request: req, operation: 'tools.vertical-engine-v2.supply.get' }, async () => {
    const authed = await requireInternalToolAuth(req);
    if ('error' in authed) return authed.error;
    if (!supabaseAdmin || !supabaseInstantly) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
    try {
      return NextResponse.json(await loadVeContactSupplyStatus(supabaseAdmin, supabaseInstantly, (await params).id));
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : 'Не удалось загрузить автопополнение' }, { status: 503 });
    }
  });
}

export async function POST(req: NextRequest, { params }: Context) {
  return withToolTrace({ request: req, operation: 'tools.vertical-engine-v2.supply.post' }, async () => {
    const authed = await requireInternalToolAuth(req);
    if ('error' in authed) return authed.error;
    if (!supabaseAdmin || !supabaseInstantly) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
    const body: unknown = await req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'Некорректный запрос' }, { status: 400 });
    const input = body as Record<string, unknown>;
    const templateId = (await params).id;
    if (input.action === 'approve') {
      const result = await approveVeContactSupply(supabaseAdmin, supabaseInstantly, {
        templateId, userId: authed.auth.userId, confirmed: input.confirm_customer_approval === true,
        reviewedRevision: clean(input.expected_preview_revision),
        presetId: clean(input.preset_id), portalProjectId: clean(input.portal_project_id),
        expectedPortalPeriodId: clean(input.expected_portal_period_id),
        targetContacts: typeof input.target_contacts === 'number' ? input.target_contacts : NaN,
        segmentationAuditId: clean(input.segmentation_audit_id),
      });
      return NextResponse.json(result.body, { status: result.status });
    }
    if (input.action !== 'pause' && input.action !== 'resume') return NextResponse.json({ error: 'Неизвестное действие' }, { status: 400 });
    const { data: plan, error: planError } = await supabaseAdmin.from('ve_contact_supply_plans')
      .select('id').eq('template_id', templateId).maybeSingle();
    if (planError || !plan) return NextResponse.json({ error: 'План пополнения недоступен' }, { status: 409 });
    const { error } = await supabaseAdmin.rpc('ve_set_contact_supply_status', {
      p_plan_id: plan.id, p_status: input.action === 'pause' ? 'paused' : 'active',
      p_actor_id: authed.auth.userId, p_now: new Date().toISOString(),
    });
    return NextResponse.json(error ? { error: error.message } : { ok: true }, { status: error ? 409 : 200 });
  });
}
