import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { logError } from '@/lib/loggerServer';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { isTechnician } from '@/lib/roles';
import {
  listInstantlyAccounts,
  resolveInstantlyAccountId,
} from '@/lib/instantly/accounts';
import { runVeTemplateLaunch } from '@/lib/verticalEngineV2/launchTemplate';
import {
  buildVeContactDeliveryPreview,
  parseExactNonNegativeContactCount,
} from '@/lib/verticalEngineV2/contactDeliveryPreview';
import {
  listVeInstantlyAccountTagMappings,
  listVeInstantlyCustomTags,
} from '@/lib/verticalEngineV2/launchClientProvisioning';
import {
  type VeLaunchPresetOption,
  type VeMailboxTagOption,
} from '@/lib/verticalEngineV2/launchHandoff';
import {
  resolveVeLaunchPresetMailboxTags,
  type VeInstantlyTagMapping,
} from '@/lib/verticalEngineV2/launchPresets';
import type { CustomTag } from '@/lib/instantly/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// Кампании и durable reserve создаются синхронно; сами контакты грузит daily runner.
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

interface PortalProjectOptionRow {
  id: string;
  client?: string | null;
  name?: string | null;
}

interface PortalActivePeriodRow {
  id: string;
  project_id: string;
  name?: string | null;
  period_start?: string | null;
  deadline?: string | null;
  contacts_done?: string | number | null;
}

function portalProjectOptionName(project: PortalProjectOptionRow): string {
  return project.client?.trim() || project.name?.trim() || `Проект ${project.id.slice(0, 8)}`;
}

interface WorkspaceTagData {
  tagsAvailable: boolean;
  mappingsAvailable: boolean;
  tags: CustomTag[];
  mappings: VeInstantlyTagMapping[];
}

function buildMailboxTagOptions(input: {
  workspaces: Array<{ id: string; label: string }>;
  tagDataByWorkspace: Map<string, WorkspaceTagData>;
}): VeMailboxTagOption[] {
  return input.workspaces
    .flatMap((workspace) => {
      const workspaceTagData = input.tagDataByWorkspace.get(workspace.id);
      if (!workspaceTagData?.tagsAvailable) return [];

      const mailboxIdsByTag = new Map<string, Set<string>>();
      for (const mapping of workspaceTagData.mappings) {
        if (mapping.resource_type !== 'account') continue;
        const tagId = mapping.tag_id?.trim();
        const mailboxId = mapping.resource_id?.trim().toLowerCase();
        if (!tagId || !mailboxId) continue;
        const mailboxIds = mailboxIdsByTag.get(tagId) ?? new Set<string>();
        mailboxIds.add(mailboxId);
        mailboxIdsByTag.set(tagId, mailboxIds);
      }

      const seenTagIds = new Set<string>();
      return workspaceTagData.tags.flatMap((tag) => {
        const id = tag.id?.trim();
        if (!id || seenTagIds.has(id)) return [];
        seenTagIds.add(id);
        return [{
          id,
          name: tag.name?.trim() || tag.label?.trim() || id,
          instantly_account_id: workspace.id,
          instantly_account_label: workspace.label,
          mailbox_count:
            workspaceTagData.mappingsAvailable && (mailboxIdsByTag.get(id)?.size ?? 0) > 0
              ? mailboxIdsByTag.get(id)?.size ?? null
              : null,
        }];
      });
    })
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name, 'ru') ||
        left.instantly_account_label.localeCompare(right.instantly_account_label, 'ru') ||
        left.instantly_account_id.localeCompare(right.instantly_account_id) ||
        left.id.localeCompare(right.id),
    );
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
      const canCreateClient = isTechnician(authed.auth.role);

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
        .select(
          'id, launch_preset_id, launch_instantly_account_id, portal_project_id, portal_period_id, target_contacts',
        )
        .eq('id', baseRow.project_id)
        .maybeSingle();
      if (projectErr) return jsonError(projectErr.message, 500);
      if (!projectRow) return jsonError('Проект не найден', 404);

      const { data: portalProjectRows, error: portalProjectsError } = await supabaseAdmin
        .from('projects')
        .select('id, client, name, status')
        .in('status', ['В работе', 'Тестирование', 'Подготовка', 'На паузе']);
      if (portalProjectsError) {
        await logError(
          'tools.vertical-engine-v2.template.launch.portal_projects_failed',
          portalProjectsError,
          { templateId },
        );
        return jsonError('Не удалось загрузить проекты Portal', 500);
      }
      const portalProjectsRaw = (portalProjectRows ?? []) as PortalProjectOptionRow[];
      const portalProjectIds = portalProjectsRaw.map((project) => project.id);
      let activePeriods: PortalActivePeriodRow[] = [];
      if (portalProjectIds.length > 0) {
        const { data: activePeriodRows, error: activePeriodsError } = await supabaseAdmin
          .from('project_periods')
          .select('id, project_id, name, period_start, deadline, contacts_done')
          .in('project_id', portalProjectIds)
          .eq('status', 'active');
        if (activePeriodsError) {
          await logError(
            'tools.vertical-engine-v2.template.launch.portal_periods_failed',
            activePeriodsError,
            { templateId },
          );
          return jsonError('Не удалось загрузить активные периоды Portal', 500);
        }
        activePeriods = (activePeriodRows ?? []) as PortalActivePeriodRow[];
      }
      const activePeriodByProjectId = new Map(
        activePeriods.map((period) => [period.project_id, period] as const),
      );
      const portalProjects = portalProjectsRaw
        .map((project) => {
          const period = activePeriodByProjectId.get(project.id) ?? null;
          return {
            id: project.id,
            name: portalProjectOptionName(project),
            active_period: period
              ? {
                  id: period.id,
                  label: period.name?.trim() || null,
                  starts_at: period.period_start ?? null,
                  deadline: period.deadline ?? null,
                  contacts_done_count: parseExactNonNegativeContactCount(period.contacts_done),
                }
              : null,
          };
        })
        .sort((left, right) => left.name.localeCompare(right.name, 'ru') || left.id.localeCompare(right.id));

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

      let configuredWorkspaces: Array<{ id: string; label: string }> = [];
      let workspaceLabels = new Map<string, string>();
      try {
        configuredWorkspaces = listInstantlyAccounts().map((account) => ({
          id: account.id,
          label: account.label,
        }));
        workspaceLabels = new Map(
          configuredWorkspaces.map((account) => [account.id, account.label] as const),
        );
      } catch (error) {
        await logError('tools.vertical-engine-v2.template.launch.accounts_failed', error, {});
      }

      // Preset workspaces stay readable even when their configuration was
      // removed, while onboarding options cover every currently configured
      // workspace — including workspaces not referenced by any preset yet.
      const workspaceIds = Array.from(
        new Set([
          ...(canCreateClient ? configuredWorkspaces.map((workspace) => workspace.id) : []),
          ...rows.map((row) => resolveInstantlyAccountId(row.instantly_account_id)),
        ]),
      );

      const tagDataByWorkspace = new Map<string, WorkspaceTagData>();
      await Promise.all(
        workspaceIds.map(async (accountId) => {
          // Display metadata must not hold the pre-launch screen for the
          // adapter's full write-oriented timeout/retry budget. Tags and their
          // approximate mapping count degrade independently: POST resolves the
          // selected tag against live /accounts?tag_ids before any write.
          const requestOptions = {
            accountId,
            timeoutMs: 15_000,
            retryRateLimits: false,
          };
          const [tagsResult, mappingsResult] = await Promise.allSettled([
            listVeInstantlyCustomTags(requestOptions),
            listVeInstantlyAccountTagMappings(requestOptions),
          ]);
          tagDataByWorkspace.set(accountId, {
            tagsAvailable: tagsResult.status === 'fulfilled',
            mappingsAvailable: mappingsResult.status === 'fulfilled',
            tags: tagsResult.status === 'fulfilled' ? tagsResult.value : [],
            mappings: mappingsResult.status === 'fulfilled' ? mappingsResult.value : [],
          });
          if (tagsResult.status === 'rejected') {
            await logError(
              'tools.vertical-engine-v2.template.launch.mailbox_tags_failed',
              tagsResult.reason,
              { accountId },
            );
          }
          if (mappingsResult.status === 'rejected') {
            await logError(
              'tools.vertical-engine-v2.template.launch.mailbox_tag_mappings_failed',
              mappingsResult.reason,
              { accountId },
            );
          }
        }),
      );

      const presets: VeLaunchPresetOption[] = rows
        .map((row) => {
          const instantlyAccountId = resolveInstantlyAccountId(row.instantly_account_id);
          const workspaceTagData = tagDataByWorkspace.get(instantlyAccountId) ?? {
            tagsAvailable: false,
            mappingsAvailable: false,
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
              available: workspaceTagData.tagsAvailable && workspaceTagData.mappingsAvailable,
            }),
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name, 'ru'));

      const mailboxTagOptions = canCreateClient
        ? buildMailboxTagOptions({
            workspaces: configuredWorkspaces,
            tagDataByWorkspace,
          })
        : [];

      let deliveryPlan: Record<string, unknown> | null = null;
      if (
        typeof projectRow.portal_project_id === 'string' &&
        projectRow.portal_project_id &&
        typeof projectRow.portal_period_id === 'string' &&
        projectRow.portal_period_id &&
        typeof projectRow.target_contacts === 'number' &&
        Number.isSafeInteger(projectRow.target_contacts) &&
        projectRow.target_contacts > 0 &&
        typeof projectRow.launch_preset_id === 'string' &&
        projectRow.launch_preset_id
      ) {
        const boundPreview = await buildVeContactDeliveryPreview(
          supabaseAdmin,
          supabaseInstantly,
          {
            templateId,
            portalProjectId: projectRow.portal_project_id,
            expectedPortalPeriodId: projectRow.portal_period_id,
            targetContacts: projectRow.target_contacts,
            presetId: projectRow.launch_preset_id,
          },
        );
        const preview = boundPreview.body.preview;
        if (boundPreview.status === 200 && preview && typeof preview === 'object') {
          deliveryPlan = preview as Record<string, unknown>;
        } else if (boundPreview.status >= 500) {
          await logError(
            'tools.vertical-engine-v2.template.launch.delivery_plan_failed',
            new Error(
              typeof boundPreview.body.error === 'string'
                ? boundPreview.body.error
                : 'Bound delivery plan preview failed',
            ),
            { templateId, veProjectId: projectRow.id },
          );
        }
      }

      return NextResponse.json({
        presets,
        can_create_client: canCreateClient,
        mailbox_tag_options: mailboxTagOptions,
        portal_projects: portalProjects,
        delivery_plan: deliveryPlan,
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
// сохранить проверенную базу для дозированной загрузки. Один запуск на шаблон: повтор только с {force:true}
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
        portal_project_id?: unknown;
        expected_portal_period_id?: unknown;
        target_contacts?: unknown;
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
      const portalProjectId =
        typeof body?.portal_project_id === 'string' ? body.portal_project_id.trim() : '';
      const expectedPortalPeriodId =
        typeof body?.expected_portal_period_id === 'string'
          ? body.expected_portal_period_id.trim()
          : '';
      const targetContacts = body?.target_contacts;
      if (
        !portalProjectId ||
        !expectedPortalPeriodId ||
        typeof targetContacts !== 'number' ||
        !Number.isSafeInteger(targetContacts) ||
        targetContacts <= 0
      ) {
        return jsonError(
          'Укажите Portal-проект, его активный период и точное обязательство по контактам',
          400,
        );
      }

      const outcome = await runVeTemplateLaunch({
        portalDb: supabaseAdmin,
        instantlyDb: supabaseInstantly,
        templateId: id,
        presetId,
        force,
        segmentationAuditId,
        confirmSegmentation,
        portalProjectId,
        expectedPortalPeriodId,
        targetContacts,
        userId,
        locale: 'ru',
        eventPrefix: 'tools.vertical-engine-v2.template.launch',
      });

      return NextResponse.json(outcome.body, { status: outcome.status });
    },
  );
}
