import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { checkSyntax } from '@/lib/emailValidation/shared';
import { logAudit, logError } from '@/lib/loggerServer';
import { isTechnician } from '@/lib/roles';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import {
  createManagedPortalUser,
  deleteManagedPortalUser,
} from '@/lib/auth/managedUserProvisioning';
import {
  VE_LAUNCH_CLIENT_PRESET_DEFAULTS,
  resolveVeLaunchClientMailboxSnapshot,
} from '@/lib/verticalEngineV2/launchClientProvisioning';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

interface LaunchClientBody {
  template_id?: unknown;
  email?: unknown;
  password?: unknown;
  instantly_account_id?: unknown;
  mailbox_tag_id?: unknown;
}

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

async function resolveProjectName(templateId: string): Promise<
  | { ok: true; name: string }
  | { ok: false; status: 404 | 500; error: string; cause?: unknown }
> {
  if (!supabaseAdmin) {
    return { ok: false, status: 500, error: 'Server misconfigured' };
  }

  const { data: template, error: templateError } = await supabaseAdmin
    .from('ve_templates')
    .select('base_id')
    .eq('id', templateId)
    .maybeSingle();
  if (templateError) {
    return {
      ok: false,
      status: 500,
      error: 'Не удалось загрузить шаблон',
      cause: templateError,
    };
  }
  if (!template || typeof template.base_id !== 'string') {
    return { ok: false, status: 404, error: 'Шаблон не найден' };
  }

  const { data: base, error: baseError } = await supabaseAdmin
    .from('ve_bases')
    .select('project_id')
    .eq('id', template.base_id)
    .maybeSingle();
  if (baseError) {
    return {
      ok: false,
      status: 500,
      error: 'Не удалось загрузить базу шаблона',
      cause: baseError,
    };
  }
  if (!base || typeof base.project_id !== 'string') {
    return { ok: false, status: 404, error: 'База шаблона не найдена' };
  }

  const { data: project, error: projectError } = await supabaseAdmin
    .from('ve_projects')
    .select('name')
    .eq('id', base.project_id)
    .maybeSingle();
  if (projectError) {
    return {
      ok: false,
      status: 500,
      error: 'Не удалось загрузить проект',
      cause: projectError,
    };
  }

  const name = typeof project?.name === 'string' ? project.name.trim() : '';
  if (!project) return { ok: false, status: 404, error: 'Проект не найден' };
  if (!name) {
    return {
      ok: false,
      status: 500,
      error: 'У проекта не указано имя клиента',
    };
  }

  return { ok: true, name };
}

/**
 * Creates the minimal Portal client + launch preset needed by VE2.
 * The VE project is intentionally not bound here: its first actual launch
 * remains the single authority for the project/preset/workspace binding.
 */
export async function POST(req: NextRequest) {
  return withToolTrace(
    // Never attach the request body: it contains the client's initial password.
    { request: req, operation: 'tools.vertical-engine-v2.launch-clients.post' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      const { userId, role } = authed.auth;
      if (!isTechnician(role)) return jsonError('Forbidden', 403);
      if (!supabaseAdmin || !supabaseInstantly) {
        return jsonError('Server misconfigured', 500);
      }

      let body: LaunchClientBody;
      try {
        body = (await req.json()) as LaunchClientBody;
      } catch {
        return jsonError('Invalid body', 400);
      }

      const templateId = typeof body.template_id === 'string'
        ? body.template_id.trim()
        : '';
      const email = typeof body.email === 'string'
        ? body.email.trim().toLocaleLowerCase('en-US')
        : '';
      // Do not trim passwords: leading/trailing spaces may be intentional and
      // changing them here would make the credentials shown to the client fail.
      const password = typeof body.password === 'string' ? body.password : '';
      const instantlyAccountId = typeof body.instantly_account_id === 'string'
        ? body.instantly_account_id.trim()
        : '';
      const mailboxTagId = typeof body.mailbox_tag_id === 'string'
        ? body.mailbox_tag_id.trim()
        : '';

      if (!templateId) return jsonError('Укажите template_id', 400);
      if (!checkSyntax(email).valid) return jsonError('Укажите корректный email клиента', 400);
      if (password.length < 8) {
        return jsonError('Пароль должен содержать не менее 8 символов', 400);
      }
      if (password.length > 72) {
        return jsonError('Пароль должен содержать не более 72 символов', 400);
      }
      if (!instantlyAccountId) return jsonError('Укажите аккаунт Instantly', 400);
      if (!mailboxTagId) return jsonError('Укажите тег почт Instantly', 400);

      const project = await resolveProjectName(templateId);
      if (!project.ok) {
        if (project.cause) {
          await logError(
            'tools.vertical-engine-v2.launch-clients.project_failed',
            project.cause,
            { userId, templateId },
          );
        }
        return jsonError(project.error, project.status);
      }

      const mailboxResolution = await resolveVeLaunchClientMailboxSnapshot({
        instantlyAccountId,
        mailboxTagId,
      });
      if (!mailboxResolution.ok) {
        if (mailboxResolution.cause) {
          await logError(
            'tools.vertical-engine-v2.launch-clients.mailboxes_failed',
            mailboxResolution.cause,
            { userId, templateId, instantlyAccountId, mailboxTagId },
          );
        }
        return jsonError(mailboxResolution.error, mailboxResolution.status);
      }
      const { snapshot } = mailboxResolution;

      const created = await createManagedPortalUser({
        email,
        password,
        fullName: project.name,
        // Never accept a role from the browser. This endpoint can only create
        // the client identity needed for the launch handoff.
        role: 'client',
      });
      if (!created.ok) {
        if (created.kind === 'duplicate') {
          await logAudit(
            'tools.vertical-engine-v2.launch-clients.conflict',
            'Client login already exists',
            { userId, templateId, email },
          );
          return jsonError('Пользователь с таким email уже существует', 409);
        }

        await logError(
          'tools.vertical-engine-v2.launch-clients.user_failed',
          created.error,
          { userId, templateId, email, stage: created.kind },
        );
        if (created.cleanupError) {
          await logError(
            'tools.vertical-engine-v2.launch-clients.user_cleanup_failed',
            created.cleanupError,
            { userId, templateId, email },
          );
        }
        return jsonError('Не удалось создать аккаунт клиента', 500);
      }

      const presetId = randomUUID();
      let presetError: unknown = null;
      try {
        const result = await supabaseInstantly
          .from('client_campaign_presets')
          .insert({
            id: presetId,
            client_user_id: created.user.id,
            created_by: userId,
            instantly_account_id: snapshot.instantlyAccountId,
            email_account_ids: snapshot.mailboxIds,
            ...VE_LAUNCH_CLIENT_PRESET_DEFAULTS,
          });
        presetError = result.error;
      } catch (error) {
        presetError = error;
      }

      if (presetError) {
        // A generated id lets us compensate even if the write reached the
        // separate Instantly DB but its response was lost in transit.
        let presetCleanupError: unknown = null;
        try {
          const result = await supabaseInstantly
            .from('client_campaign_presets')
            .delete()
            .eq('id', presetId);
          presetCleanupError = result.error;
        } catch (error) {
          presetCleanupError = error;
        }
        const userCleanupError = await deleteManagedPortalUser(created.user.id);

        await logError(
          'tools.vertical-engine-v2.launch-clients.preset_failed',
          presetError,
          {
            userId,
            templateId,
            targetUserId: created.user.id,
            instantlyAccountId: snapshot.instantlyAccountId,
            mailboxTagId: snapshot.tag.id,
            mailboxCount: snapshot.mailboxIds.length,
          },
        );
        if (presetCleanupError) {
          await logError(
            'tools.vertical-engine-v2.launch-clients.preset_cleanup_failed',
            presetCleanupError,
            { userId, targetUserId: created.user.id, presetId },
          );
        }
        if (userCleanupError) {
          await logError(
            'tools.vertical-engine-v2.launch-clients.user_cleanup_failed',
            userCleanupError,
            { userId, targetUserId: created.user.id },
          );
        }
        return jsonError('Не удалось сохранить пресет запуска', 500);
      }

      await logAudit(
        'tools.vertical-engine-v2.launch-clients.created',
        'VE2 client and launch preset created',
        {
          userId,
          templateId,
          targetUserId: created.user.id,
          email,
          presetId,
          instantlyAccountId: snapshot.instantlyAccountId,
          mailboxTagId: snapshot.tag.id,
          mailboxCount: snapshot.mailboxIds.length,
        },
      );

      return NextResponse.json(
        {
          ok: true,
          client: {
            id: created.user.id,
            email: created.user.email,
          },
          preset: {
            id: presetId,
            name: project.name,
            instantly_account_id: snapshot.instantlyAccountId,
            instantly_account_label: snapshot.instantlyAccountLabel,
            mailbox_count: snapshot.mailboxIds.length,
            mailbox_tags: [snapshot.tag],
            mailbox_tag_resolution: 'exact',
          },
        },
        { status: 201 },
      );
    },
  );
}
