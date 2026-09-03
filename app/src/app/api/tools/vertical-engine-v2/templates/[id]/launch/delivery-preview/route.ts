import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { buildVeContactDeliveryPreview } from '@/lib/verticalEngineV2/contactDeliveryPreview';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

function jsonError(error: string, status: number, code: string) {
  return NextResponse.json({ error, code }, { status });
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withToolTrace(
    { request: req, operation: 'tools.vertical-engine-v2.template.launch.delivery-preview' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      if (!supabaseAdmin || !supabaseInstantly) {
        return jsonError('Server misconfigured', 500, 'SERVER_MISCONFIGURED');
      }

      const { id: templateId } = await params;
      if (!templateId) return jsonError('Не указан шаблон', 400, 'TEMPLATE_ID_REQUIRED');

      let body: Record<string, unknown>;
      try {
        const parsed = await req.json();
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        body = parsed as Record<string, unknown>;
      } catch {
        return jsonError('Некорректное тело запроса', 400, 'INVALID_BODY');
      }

      const result = await buildVeContactDeliveryPreview(supabaseAdmin, supabaseInstantly, {
        templateId,
        portalProjectId: stringField(body.portal_project_id),
        expectedPortalPeriodId: stringField(body.expected_portal_period_id),
        targetContacts:
          typeof body.target_contacts === 'number' ? body.target_contacts : Number.NaN,
        presetId: stringField(body.preset_id),
        segmentationAuditId: stringField(body.segmentation_audit_id) || null,
      });
      return NextResponse.json(result.body, { status: result.status });
    },
  );
}
