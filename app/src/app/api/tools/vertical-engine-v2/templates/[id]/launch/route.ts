import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { logError } from '@/lib/loggerServer';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { runVeTemplateLaunch } from '@/lib/verticalEngineV2/launchTemplate';
import { type VeLaunchPresetOption } from '@/lib/verticalEngineV2/launchHandoff';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// До VE_LAUNCH_MAX_LEADS лидов = 2 вызова /leads/add + создание кампании.
export const maxDuration = 60;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

// GET — список пресетов для селектора «Отправить в запуск» (id + имя клиента).
// Чтение — тот же путь, что и у клиентского запуска (client_campaign_presets
// через supabaseInstantly, service-level), только без фильтра client_user_id:
// пресет выбирает сотрудник. Имя подставляем из profiles основной БД.
export async function GET(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.vertical-engine-v2.template.launch.presets' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      if (!supabaseAdmin || !supabaseInstantly) return jsonError('Server misconfigured', 500);

      const { data: presetRows, error: presetErr } = await supabaseInstantly
        .from('client_campaign_presets')
        .select('id, client_user_id');
      if (presetErr) {
        await logError('tools.vertical-engine-v2.template.launch.presets_failed', presetErr, {});
        return jsonError('Не удалось загрузить пресеты', 500);
      }

      const rows = (presetRows ?? []) as Array<{ id: string; client_user_id: string }>;
      const userIds = Array.from(new Set(rows.map((r) => r.client_user_id).filter(Boolean)));

      const nameByUserId = new Map<string, string>();
      if (userIds.length > 0) {
        const { data: profiles, error: profErr } = await supabaseAdmin
          .from('profiles')
          .select('id, email, full_name')
          .in('id', userIds);
        if (profErr) {
          // Не роняем выдачу: имена деградируют до обрезанного id.
          await logError('tools.vertical-engine-v2.template.launch.profiles_failed', profErr, {});
        }
        for (const p of (profiles ?? []) as Array<{ id: string; email?: string | null; full_name?: string | null }>) {
          const name = (p.full_name ?? '').trim() || (p.email ?? '').trim();
          if (name) nameByUserId.set(p.id, name);
        }
      }

      const presets: VeLaunchPresetOption[] = rows
        .map((r) => ({
          id: r.id,
          name: nameByUserId.get(r.client_user_id) ?? `Клиент ${r.client_user_id.slice(0, 8)}`,
        }))
        .sort((a, b) => a.name.localeCompare(b.name, 'ru'));

      return NextResponse.json({ presets });
    },
  );
}

// POST — «Отправить в запуск»: из готового шаблона создать кампанию в Instantly
// НА ПАУЗЕ (никогда не активируем — сотрудник проверяет её в Instantly сам) и
// загрузить лидов базы. Один запуск на шаблон: повтор только с {force:true}
// (создаёт НОВУЮ paused-кампанию и перезаписывает launch_info).
// Вся механика — в lib/verticalEngineV2/launchTemplate.ts. ENG-контур сюда
// не делегирует: он остаётся на отдельном hypothesisEngine backend.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.vertical-engine-v2.template.launch.post' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      const { userId } = authed.auth;
      if (!supabaseAdmin || !supabaseInstantly) return jsonError('Server misconfigured', 500);

      const { id } = await params;
      if (!id) return jsonError('Missing id', 400);

      let body: {
        preset_id?: unknown;
        force?: unknown;
        segmentation_audit_id?: unknown;
        confirm_segmentation?: unknown;
      };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return jsonError('Invalid body', 400);
      }
      const presetId = typeof body?.preset_id === 'string' ? body.preset_id.trim() : '';
      if (!presetId) return jsonError('Укажите preset_id', 400);
      const force = body?.force === true;
      const segmentationAuditId =
        typeof body?.segmentation_audit_id === 'string'
          ? body.segmentation_audit_id.trim()
          : '';
      const confirmSegmentation = body?.confirm_segmentation === true;

      const outcome = await runVeTemplateLaunch({
        portalDb: supabaseAdmin,
        instantlyDb: supabaseInstantly,
        templateId: id,
        presetId,
        force,
        segmentationAuditId,
        confirmSegmentation,
        userId,
        locale: 'ru',
        eventPrefix: 'tools.vertical-engine-v2.template.launch',
      });

      return NextResponse.json(outcome.body, { status: outcome.status });
    },
  );
}
