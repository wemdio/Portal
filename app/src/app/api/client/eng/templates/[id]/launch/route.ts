import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { serveClientDemo } from '@/lib/clientDemo/demoResponse';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { logError } from '@/lib/loggerServer';
import { scrubBrand } from '@/lib/scrubBrand';
import { loadClientHeTemplate } from '@/lib/hypothesisEngine/apiGuards';
import { runHeTemplateLaunch } from '@/lib/hypothesisEngine/launchTemplate';
import type { HeLaunchPresetOption } from '@/lib/hypothesisEngine/launchHandoff';
import type { ClientCampaignPreset } from '@/lib/clientLaunch/types';

export const dynamic = 'force-dynamic';
// До HE_LAUNCH_MAX_LEADS лидов = 2 вызова /leads/add + создание кампании.
export const maxDuration = 60;

// GET — пресеты для селектора «Launch»: ТОЛЬКО свои (у staff — все, пресет
// выбирает сотрудник). Имени у пресета нет — подписываем отправителем.
export async function GET(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (result.auth.isDemo) return serveClientDemo(req);
  if (!supabaseInstantly) return jsonError('Server misconfigured', 500);

  const { userId } = result.auth;

  const { data: rows, error } = await supabaseInstantly
    .from('client_campaign_presets')
    .select('id, instantly_account_id, email_account_ids')
    .eq('client_user_id', userId);
  if (error) {
    await logError('client.eng.template.launch.presets_failed', error, { userId });
    return jsonError('Failed to load presets', 500);
  }

  const presets: HeLaunchPresetOption[] = (rows ?? []).map((r) => {
    const row = r as Pick<ClientCampaignPreset, 'id' | 'instantly_account_id' | 'email_account_ids'>;
    const sender = Array.isArray(row.email_account_ids) ? row.email_account_ids[0] : null;
    return {
      id: row.id,
      name: sender ?? row.instantly_account_id ?? `Preset ${row.id.slice(0, 8)}`,
    };
  });

  return NextResponse.json({ presets });
}

// POST — «Launch (paused)»: ДЕЛЕГИРУЕМ в общее ядро runHeTemplateLaunch (та
// же механика, что у staff: PAUSED-кампания, лиды базы, launch_info в
// шаблоне, повтор только с force). Отличия клиентского контура: пресет читается
// со скоупом владельца, тексты EN, бренд рассыльщика скрабим из ошибок.
// TODO(tariffs): гейт запуска по тарифу — пока доступен любому клиенту.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (!supabaseAdmin || !supabaseInstantly) return jsonError('Server misconfigured', 500);

  const { userId } = result.auth;

  const { id } = await params;
  if (!id) return jsonError('Missing id', 400);

  let body: { preset_id?: unknown; force?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonError('Invalid body', 400);
  }
  const presetId = typeof body?.preset_id === 'string' ? body.preset_id.trim() : '';
  if (!presetId) return jsonError('Provide preset_id', 400);
  const force = body?.force === true;

  // Скоуп шаблона ДО запуска: чужой — 404, существование не раскрываем.
  const owned = await loadClientHeTemplate(supabaseAdmin, id, userId);
  if (!owned.ok) return jsonError(owned.failure.message, owned.failure.status);

  const outcome = await runHeTemplateLaunch({
    portalDb: supabaseAdmin,
    instantlyDb: supabaseInstantly,
    templateId: id,
    presetId,
    force,
    userId,
    scopeClientUserId: userId,
    locale: 'en',
    eventPrefix: 'client.eng.template.launch',
  });

  // White-label: в текстах ядра (напр. динамической ошибке API) может
  // проскочить бренд рассыльщика — скрабим как все клиентские ошибки.
  const responseBody = { ...outcome.body };
  if (typeof responseBody.error === 'string') {
    responseBody.error = scrubBrand(responseBody.error);
  }

  return NextResponse.json(responseBody, { status: outcome.status });
}
