import { NextResponse, type NextRequest } from 'next/server';
import { logAudit, logError } from '@/lib/loggerServer';
import { authed, jsonError } from '@/lib/polzaOutreach/routeAuth';
import { loadSignatureSetting, saveSignature } from '@/lib/polzaOutreach/settings';
import { POLZA_OUTREACH_DEFAULT_SIGNATURE, sanitizePolzaSignature } from '@/lib/polzaOutreach/types';

export const dynamic = 'force-dynamic';

/**
 * Настройки английского автоаутрича — подпись писем, одна на все запуски
 * (спека 2026-09-26-outreach-to-sender-design.md §0). Раннер ставит её в
 * конец каждого письма, «Переписать цепочку» — в пересобранные.
 *
 * Настройки общие для всех операторов инструмента, как подписи русского
 * аутрича в «Библиотеках»: таблица открыта authenticated (select/insert/update),
 * роут ходит клиентом пользователя.
 */
export async function GET(req: NextRequest) {
  const auth = await authed(req);
  if ('error' in auth) return auth.error;
  try {
    const setting = await loadSignatureSetting(auth.supabase);
    return NextResponse.json({
      signature: setting.signature,
      updated_at: setting.updatedAt,
      default_signature: POLZA_OUTREACH_DEFAULT_SIGNATURE,
    });
  } catch (err) {
    await logError('parser.polza_outreach.settings.read.failed', err, undefined, { userId: auth.user.id, route: req.nextUrl.pathname });
    return jsonError(err instanceof Error ? err.message : 'Не удалось прочитать настройки', 500);
  }
}

export async function PUT(req: NextRequest) {
  const auth = await authed(req);
  if ('error' in auth) return auth.error;

  let body: { signature?: unknown };
  try {
    body = (await req.json()) as { signature?: unknown };
  } catch {
    return jsonError('Invalid JSON body', 400);
  }
  const clean = sanitizePolzaSignature(body?.signature);
  if (!clean.ok) return jsonError(clean.error, 400);

  try {
    const saved = await saveSignature(auth.supabase, clean.value);
    await logAudit(
      'parser.polza_outreach.settings.signature_updated',
      'Polza outreach: letters signature updated',
      { signature: saved.signature },
      { userId: auth.user.id, route: req.nextUrl.pathname },
    );
    return NextResponse.json({ signature: saved.signature, updated_at: saved.updatedAt });
  } catch (err) {
    await logError('parser.polza_outreach.settings.save.failed', err, undefined, { userId: auth.user.id, route: req.nextUrl.pathname });
    return jsonError(err instanceof Error ? err.message : 'Не удалось сохранить подпись', 500);
  }
}
