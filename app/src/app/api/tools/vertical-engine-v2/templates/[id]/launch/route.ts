import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { logError } from '@/lib/loggerServer';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import {
  listInstantlyAccounts,
  resolveInstantlyAccountId,
} from '@/lib/instantly/accounts';
import {
  listAllCustomTagMappings,
  listAllCustomTags,
} from '@/lib/instantly/client';
import { runVeTemplateLaunch } from '@/lib/verticalEngineV2/launchTemplate';
import { type VeLaunchPresetOption } from '@/lib/verticalEngineV2/launchHandoff';
import {
  resolveVeLaunchPresetMailboxTags,
  type VeInstantlyTagMapping,
} from '@/lib/verticalEngineV2/launchPresets';
import type { CustomTag } from '@/lib/instantly/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// До VE_LAUNCH_MAX_LEADS лидов = 2 вызова /leads/add + создание кампании.
export const maxDuration = 60;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

interface LaunchPresetRow {
  id: string;
  client_user_id: string;
  instantly_account_id?: string | null;
  email_account_ids?: unknown;
}

interface WorkspaceTagData {
  available: boolean;
  tags: CustomTag[];
  mappings: VeInstantlyTagMapping[];
}

// GET — display-safe список клиентских пресетов для «Отправить в запуск».
// Точные mailbox ids нужны только server-side для вычисления общего тега и
// количества; в JSON они не возвращаются. Теги читаются отдельно в каждом
// Instantly workspace, поэтому идентичности разных аккаунтов не смешиваются.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withToolTrace(
    { request: req, operation: 'tools.vertical-engine-v2.template.launch.presets' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      if (!supabaseAdmin || !supabaseInstantly) return jsonError('Server misconfigured', 500);

      const { id: templateId } = await params;
      if (!templateId) return jsonError('Missing id', 400);

      const { data: templateRow, error: templateErr } = await supabaseAdmin
        .from('ve_templates')
        .select('base_id')
        .eq('id', templateId)
        .maybeSingle();
      if (templateErr) return jsonError(templateErr.message, 500);
      if (!templateRow) return jsonError('Шаблон не найден', 404);

      const { data: baseRow, error: baseErr } = await supabaseAdmin
        .from('ve_bases')
        .select('project_id')
        .eq('id', templateRow.base_id)
        .maybeSingle();
      if (baseErr) return jsonError(baseErr.message, 500);
      if (!baseRow) return jsonError('База не найдена', 404);

      const { data: projectRow, error: projectErr } = await supabaseAdmin
        .from('ve_projects')
        .select('launch_preset_id, launch_instantly_account_id')
        .eq('id', baseRow.project_id)
        .maybeSingle();
      if (projectErr) return jsonError(projectErr.message, 500);
      if (!projectRow) return jsonError('Проект не найден', 404);

      const { data: presetRows, error: presetErr } = await supabaseInstantly
        .from('client_campaign_presets')
        .select('id, client_user_id, instantly_account_id, email_account_ids');
      if (presetErr) {
        await logError('tools.vertical-engine-v2.template.launch.presets_failed', presetErr, {});
        return jsonError('Не удалось загрузить пресеты', 500);
      }

      const rows = (presetRows ?? []) as LaunchPresetRow[];
      const userIds = Array.from(new Set(rows.map((r) => r.client_user_id).filter(Boolean)));

      const nameByUserId = new Map<string, string>();
      if (userIds.length > 0) {
        const { data: profiles, error: profErr } = await supabaseAdmin
          .from('profiles')
          .select('id, full_name')
          .in('id', userIds);
        if (profErr) {
          // Не роняем выдачу: имена деградируют до обрезанного id.
          await logError('tools.vertical-engine-v2.template.launch.profiles_failed', profErr, {});
        }
        for (const p of (profiles ?? []) as Array<{ id: string; full_name?: string | null }>) {
          const name = (p.full_name ?? '').trim();
          if (name) nameByUserId.set(p.id, name);
        }
      }

      const workspaceIds = Array.from(
        new Set(rows.map((row) => resolveInstantlyAccountId(row.instantly_account_id))),
      );
      let workspaceLabels = new Map<string, string>();
      try {
        workspaceLabels = new Map(
          listInstantlyAccounts().map((account) => [account.id, account.label] as const),
        );
      } catch (error) {
        await logError('tools.vertical-engine-v2.template.launch.accounts_failed', error, {});
      }

      const tagDataByWorkspace = new Map<string, WorkspaceTagData>();
      await Promise.all(
        workspaceIds.map(async (accountId) => {
          try {
            // Display metadata must not hold the pre-launch screen for the
            // adapter's full write-oriented timeout/retry budget. Exact
            // mailbox ids remain usable even when this live label read fails.
            const requestOptions = {
              accountId,
              timeoutMs: 15_000,
              retryRateLimits: false,
            };
            const [tags, mappings] = await Promise.all([
              listAllCustomTags(requestOptions),
              listAllCustomTagMappings('account', requestOptions),
            ]);
            tagDataByWorkspace.set(accountId, {
              available: true,
              tags,
              mappings,
            });
          } catch (error) {
            tagDataByWorkspace.set(accountId, {
              available: false,
              tags: [],
              mappings: [],
            });
            await logError(
              'tools.vertical-engine-v2.template.launch.mailbox_tags_failed',
              error,
              { accountId },
            );
          }
        }),
      );

      const presets: VeLaunchPresetOption[] = rows
        .map((row) => {
          const instantlyAccountId = resolveInstantlyAccountId(row.instantly_account_id);
          const workspaceTagData = tagDataByWorkspace.get(instantlyAccountId) ?? {
            available: false,
            tags: [],
            mappings: [],
          };
          return {
            id: row.id,
            name:
              nameByUserId.get(row.client_user_id) ??
              `Клиент ${row.client_user_id.slice(0, 8)}`,
            instantly_account_id: instantlyAccountId,
            instantly_account_label: workspaceLabels.get(instantlyAccountId) ?? instantlyAccountId,
            ...resolveVeLaunchPresetMailboxTags({
              emailAccountIds: row.email_account_ids,
              tags: workspaceTagData.tags,
              mappings: workspaceTagData.mappings,
              available: workspaceTagData.available,
            }),
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name, 'ru'));

      return NextResponse.json({
        presets,
        bound_preset_id:
          typeof projectRow.launch_preset_id === 'string' && projectRow.launch_preset_id
            ? projectRow.launch_preset_id
            : null,
      });
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
