import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { logAudit, logError } from '@/lib/loggerServer';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { buildCampaignPayloadFromPreset } from '@/lib/clientLaunch/buildCampaignPayload';
import { hasUsableCampaignSequences } from '@/lib/clientLaunch/campaignSequences';
import type { ClientCampaignPreset } from '@/lib/clientLaunch/types';
import { createCampaign, createLeads, updateCampaign } from '@/lib/instantly/client';
import { resolveInstantlyAccountId } from '@/lib/instantly/accounts';
import type { HeBase, HeTemplate } from '@/lib/hypothesisEngine/types';
import {
  HE_LAUNCH_MAX_LEADS,
  buildLaunchCampaignName,
  buildLaunchSequence,
  instantlyCampaignUrl,
  mapBaseRowsToLeads,
  parseLaunchInfo,
  segmentVariantsWarning,
  type HeLaunchPresetOption,
  type HeTemplateLaunchInfo,
} from '@/lib/hypothesisEngine/launchHandoff';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// До HE_LAUNCH_MAX_LEADS лидов = 2 вызова /leads/add + создание кампании.
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
    { request: req, operation: 'tools.hypothesis-engine.template.launch.presets' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      if (!supabaseAdmin || !supabaseInstantly) return jsonError('Server misconfigured', 500);

      const { data: presetRows, error: presetErr } = await supabaseInstantly
        .from('client_campaign_presets')
        .select('id, client_user_id');
      if (presetErr) {
        await logError('tools.hypothesis-engine.template.launch.presets_failed', presetErr, {});
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
          await logError('tools.hypothesis-engine.template.launch.profiles_failed', profErr, {});
        }
        for (const p of (profiles ?? []) as Array<{ id: string; email?: string | null; full_name?: string | null }>) {
          const name = (p.full_name ?? '').trim() || (p.email ?? '').trim();
          if (name) nameByUserId.set(p.id, name);
        }
      }

      const presets: HeLaunchPresetOption[] = rows
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
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.hypothesis-engine.template.launch.post' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      const { userId } = authed.auth;
      if (!supabaseAdmin || !supabaseInstantly) return jsonError('Server misconfigured', 500);

      const { id } = await params;
      if (!id) return jsonError('Missing id', 400);

      let body: { preset_id?: unknown; force?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return jsonError('Invalid body', 400);
      }
      const presetId = typeof body?.preset_id === 'string' ? body.preset_id.trim() : '';
      if (!presetId) return jsonError('Укажите preset_id', 400);
      const force = body?.force === true;

      // 1. Шаблон.
      const { data: templateRow, error: tplErr } = await supabaseAdmin
        .from('he_templates')
        .select('*')
        .eq('id', id)
        .single();
      if (tplErr) {
        return jsonError(
          tplErr.code === 'PGRST116' ? 'Шаблон не найден' : tplErr.message,
          tplErr.code === 'PGRST116' ? 404 : 500,
        );
      }
      const template = templateRow as HeTemplate & { launch_info?: unknown };

      if (template.status !== 'ready') {
        return jsonError('Шаблон ещё не готов — запуск возможен после статуса «Готов»', 409);
      }

      const existingLaunch = parseLaunchInfo(template.launch_info);
      if (existingLaunch && !force) {
        return NextResponse.json(
          {
            error: 'Шаблон уже отправлен в запуск. Повторный — только с force: true.',
            launch: existingLaunch,
          },
          { status: 409 },
        );
      }

      // 2. База шаблона.
      const { data: baseRow, error: baseErr } = await supabaseAdmin
        .from('he_bases')
        .select('id, filename, columns, data')
        .eq('id', template.base_id)
        .single();
      if (baseErr) {
        return jsonError(
          baseErr.code === 'PGRST116' ? 'База не найдена' : baseErr.message,
          baseErr.code === 'PGRST116' ? 404 : 500,
        );
      }
      const base = baseRow as Pick<HeBase, 'id' | 'filename' | 'columns' | 'data'>;

      // 3. Пресет — service-level read по id (см. комментарий к GET).
      const { data: presetRow, error: presetErr } = await supabaseInstantly
        .from('client_campaign_presets')
        .select('*')
        .eq('id', presetId)
        .maybeSingle();
      if (presetErr) {
        await logError('tools.hypothesis-engine.template.launch.preset_failed', presetErr, { userId });
        return jsonError('Не удалось загрузить пресет', 500);
      }
      if (!presetRow) return jsonError('Пресет не найден', 404);
      const preset = presetRow as ClientCampaignPreset;

      // 4. Sequence из писем шаблона (segment_variants выкидываем — см. warning).
      const sequence = buildLaunchSequence(template.letters);
      if (!sequence) return jsonError('У шаблона нет писем для запуска', 400);

      // 5. Лиды из базы. Все проверки — ДО любого вызова Instantly.
      const rows = Array.isArray(base.data) ? (base.data as Array<Record<string, unknown>>) : [];
      const columns = Array.isArray(base.columns)
        ? base.columns.filter((c): c is string => typeof c === 'string')
        : [];
      const { leads, emailColumn } = mapBaseRowsToLeads({
        rows,
        columns,
        operatorMapping: template.personalization_plan?.operator_mapping,
      });
      if (!emailColumn) return jsonError('В базе не найдена колонка с email', 400);
      if (leads.length === 0) return jsonError('В базе нет валидных email-адресов', 400);
      if (leads.length > HE_LAUNCH_MAX_LEADS) {
        return jsonError(
          `Слишком много лидов для запуска из мастера: ${leads.length.toLocaleString('ru-RU')}. Максимум — ${HE_LAUNCH_MAX_LEADS.toLocaleString('ru-RU')}`,
          413,
        );
      }

      const instantlyRequestOptions = { accountId: resolveInstantlyAccountId(preset.instantly_account_id) };
      const campaignName = buildLaunchCampaignName(base.filename);

      // 6. Instantly: кампания (НЕ активируем!) + лиды. Текст ошибки идёт
      //    сотруднику, поэтому БЕЗ scrubBrand — нужна точная формулировка API.
      let instantlyCampaignId: string | null = null;
      let accepted = 0;
      try {
        const payload = buildCampaignPayloadFromPreset({
          preset,
          sequence: { name: campaignName, steps: sequence.steps },
        });
        const created = await createCampaign(payload, instantlyRequestOptions);
        instantlyCampaignId = (created as { id?: string }).id ?? null;
        if (!instantlyCampaignId) {
          throw new Error('Instantly вернул кампанию без идентификатора');
        }

        // Как в клиентском запуске: если Instantly не сохранил sequences при
        // создании — досылаем PATCH'ем.
        if (!hasUsableCampaignSequences(created.sequences)) {
          await updateCampaign(instantlyCampaignId, { sequences: payload.sequences }, instantlyRequestOptions);
        }

        const leadResult = await createLeads(
          leads,
          {
            campaign_id: instantlyCampaignId,
            skip_if_in_workspace: false,
            skip_if_in_campaign: false,
            skip_if_in_list: false,
          },
          instantlyRequestOptions,
        );
        accepted = leadResult.leads_uploaded;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Не удалось создать кампанию';
        await logError('tools.hypothesis-engine.template.launch.failed', err, {
          userId,
          templateId: id,
          instantlyCampaignId,
        });
        // Если кампания уже создана — говорим об этом явно, чтобы сотрудник не
        // плодил дубли слепым ретраем (лиды можно долить в Instantly вручную).
        return jsonError(
          `${message.slice(0, 300)}${
            instantlyCampaignId ? ` (кампания ${instantlyCampaignId} уже создана в Instantly и осталась на паузе)` : ''
          }`,
          500,
        );
      }

      if (accepted === 0) {
        return NextResponse.json(
          {
            error: 'Система рассылки не приняла ни одного контакта. Кампания оставлена на паузе.',
            campaign_id: instantlyCampaignId,
          },
          { status: 500 },
        );
      }

      // 7. Запись о запуске в шаблон.
      const launchInfo: HeTemplateLaunchInfo = {
        campaign_id: instantlyCampaignId,
        campaign_name: campaignName,
        campaign_url: instantlyCampaignUrl(instantlyCampaignId),
        leads_count: accepted,
        preset_id: presetId,
        created_at: new Date().toISOString(),
      };
      const warnings: string[] = [];
      const segWarning = segmentVariantsWarning(sequence);
      if (segWarning) warnings.push(segWarning);

      const { error: updErr } = await supabaseAdmin
        .from('he_templates')
        .update({ launch_info: launchInfo })
        .eq('id', id);
      if (updErr) {
        // Кампания уже создана — не превращаем ответ в ошибку (иначе слепой
        // ретрай плодит дубли), но честно предупреждаем, что дедуп-записи нет.
        await logError('tools.hypothesis-engine.template.launch.info_save_failed', updErr, {
          userId,
          templateId: id,
          instantlyCampaignId,
        });
        warnings.push(
          'Кампания создана, но запись о запуске не сохранилась в шаблон (вероятно, не применена миграция he_templates.launch_info) — повторный запуск не будет заблокирован.',
        );
      }

      await logAudit(
        'tools.hypothesis-engine.template.launch.success',
        'Hypothesis engine template sent to Instantly (paused)',
        {
          userId,
          templateId: id,
          baseId: base.id,
          presetId,
          instantlyCampaignId,
          accepted,
          totalLeads: leads.length,
          force,
        },
      );

      return NextResponse.json({ ok: true, launch: launchInfo, warnings });
    },
  );
}
