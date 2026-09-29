import { NextRequest, NextResponse } from 'next/server';
import { logAudit } from '@/lib/loggerServer';
import { authenticateRequest, jsonError } from '@/lib/sender/apiHelpers';
import { findFolderByKey, parseFolderKey, parseSettingsInput, settingsDto } from '@/lib/senderLeads/history';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

const NO_FOLDER = 'Папка ещё не создана — появится с первой заливкой в Рассылку';

/** GET — настройки квалификатора папки: { enabled, telegram, criteria }. */
export async function GET(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.senderLeads.settings.get' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const key = parseFolderKey(new URL(req.url).searchParams.get('folder'));
    if (!key) return jsonError('Не указана папка', 400);

    const folder = await findFolderByKey(supabaseAdmin, key);
    return NextResponse.json(settingsDto(folder));
  });
}

/**
 * PUT — сохранить настройки. Воркер квалификатора перечитывает их каждый
 * круг (раз в минуту), поэтому перезапуск не нужен. Уже оценённые ответы
 * не переоцениваются.
 */
export async function PUT(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.senderLeads.settings.update' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const key = parseFolderKey(new URL(req.url).searchParams.get('folder'));
    if (!key) return jsonError('Не указана папка', 400);

    const parsed = parseSettingsInput(await req.json().catch(() => null));
    if (!parsed.ok) return jsonError(parsed.error, 400);

    const { data, error } = await supabaseAdmin
      .from('sender_folders')
      .update({ ...parsed.value, updated_at: new Date().toISOString() })
      .eq('key', key)
      .select('id, name, lead_criteria, leads_enabled, leads_telegram')
      .maybeSingle();
    if (error) return jsonError(error.message, 500);
    if (!data) return jsonError(NO_FOLDER, 404);

    // Правило «что считать лидом» решает, что уйдёт в чат продаж, — кто и
    // когда его менял, должно быть видно в журнале.
    await logAudit(
      'sender.leads.settings.updated',
      `Рассылка: изменены настройки квалификации папки «${data.name}»`,
      {
        folderKey: key,
        enabled: parsed.value.leads_enabled,
        telegram: parsed.value.leads_telegram,
        criteriaLength: parsed.value.lead_criteria?.length ?? 0,
      },
      { userId: auth.user.id },
    );

    return NextResponse.json(settingsDto(data));
  });
}
