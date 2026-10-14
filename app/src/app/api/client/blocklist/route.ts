import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import {
  BLOCKLIST_MAX_ENTRIES,
  normalizeBlockedEmail,
} from '@/lib/clientBlocklist/blockedContacts';
import { logAudit, logError } from '@/lib/loggerServer';
import { engBlocklistGet, engBlocklistPost } from './_eng';

export const dynamic = 'force-dynamic';

interface BlocklistEntryRow {
  id: string;
  email: string;
  reason: string | null;
  source: string;
  created_at: string;
}

/**
 * GET /api/client/blocklist — чёрный список контактов клиента.
 *
 * Возвращает все записи (новые сверху). Список ограничен
 * BLOCKLIST_MAX_ENTRIES, пагинация не нужна: это ручные блоки негатива,
 * а не загрузка баз.
 */
export async function GET(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  // ENG-кабинет («Do not contact»): своя страница списка и английские тексты
  // (./_eng.ts). Ниже — RU-ветка, без изменений.
  if (result.auth.market === 'eng') {
    if (result.auth.isDemo) {
      return NextResponse.json({
        items: [],
        total: 0,
        matching: 0,
        offset: 0,
        next_offset: null,
        in_campaign_removal: 'off',
        pending: null,
        failed: null,
        failed_examples: [],
        failed_at_least: false,
      });
    }
    if (!supabaseInstantly) return jsonError('Server misconfigured', 500);
    return engBlocklistGet(req, supabaseInstantly, result.auth.userId);
  }
  // Демо-аккаунт: список пуст, фикстура не нужна.
  if (result.auth.isDemo) return NextResponse.json({ items: [], total: 0 });

  const db = supabaseInstantly;
  if (!db) return jsonError('Server misconfigured', 500);

  const { userId } = result.auth;

  const { data, error } = await db
    .from('client_blocked_contacts')
    .select('id, email, reason, source, created_at')
    .eq('client_user_id', userId)
    .order('created_at', { ascending: false })
    .limit(BLOCKLIST_MAX_ENTRIES);

  if (error) {
    await logError('client.blocklist.list_failed', error, {}, { userId });
    return jsonError('Не удалось загрузить чёрный список', 500);
  }

  const items = (data ?? []) as BlocklistEntryRow[];
  return NextResponse.json({ items, total: items.length });
}

/**
 * POST /api/client/blocklist — добавить контакт в чёрный список.
 *
 * Body: { email: string, reason?: string, source?: 'manual' | 'reply' }.
 * Идемпотентен: повторное добавление того же email не ошибка (upsert).
 * Скоуп — только список самого клиента: влияет исключительно на его
 * будущие запуски, чужие рассылки не затрагивает.
 */
export async function POST(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  // Мутации демо-аккаунта режутся в requireClientAuth (DEMO_READONLY).

  const db = supabaseInstantly;
  if (!db) return jsonError('Server misconfigured', 500);

  const { userId } = result.auth;

  // ENG-кабинет: пачка из вставленного текста, строгий потолок, английские
  // тексты (./_eng.ts); заблокированному аккаунту (отметка блокировки ENG) —
  // 403 тем же текстом, что у рыночного гейта кабинета, до разбора тела. Ниже
  // — RU-ветка, без изменений.
  if (result.auth.market === 'eng') return engBlocklistPost(req, db, userId);

  let body: { email?: unknown; reason?: unknown; source?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonError('Invalid body', 400);
  }

  const email = normalizeBlockedEmail(body.email);
  if (!email) {
    return jsonError('Укажите корректный email', 400);
  }

  const reason =
    typeof body.reason === 'string' && body.reason.trim()
      ? body.reason.trim().slice(0, 500)
      : null;
  const source = body.source === 'reply' ? 'reply' : 'manual';

  // Потолок на размер списка — см. BLOCKLIST_MAX_ENTRIES.
  const { count } = await db
    .from('client_blocked_contacts')
    .select('id', { count: 'exact', head: true })
    .eq('client_user_id', userId);
  if ((count ?? 0) >= BLOCKLIST_MAX_ENTRIES) {
    return jsonError(
      `Чёрный список переполнен (макс. ${BLOCKLIST_MAX_ENTRIES.toLocaleString('ru-RU')}). Удалите неактуальные записи.`,
      400,
    );
  }

  const { data, error } = await db
    .from('client_blocked_contacts')
    .upsert(
      { client_user_id: userId, email, reason, source },
      { onConflict: 'client_user_id,email', ignoreDuplicates: false },
    )
    .select('id, email, reason, source, created_at')
    .single();

  if (error || !data) {
    await logError('client.blocklist.add_failed', error, { email }, { userId });
    return jsonError('Не удалось добавить контакт в чёрный список', 500);
  }

  await logAudit(
    'client.blocklist.added',
    'Client blocked a contact',
    { email, source },
    { userId },
  );

  return NextResponse.json({ entry: data as BlocklistEntryRow }, { status: 201 });
}
