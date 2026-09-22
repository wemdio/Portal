import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/sender/apiHelpers';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 30;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Стоп-лист (задача 5.3 хендоффа фич): посмотреть, найти, добавить руками,
 * снять адрес. Таблица пополняется автоматически (отбойники, отказы SMTP,
 * «стоп» в ответе) — здесь появляется управление поверх неё.
 */
export async function GET(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.sender.suppressions.list' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const url = new URL(req.url);
    const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
    const search = (url.searchParams.get('search') ?? '').trim().replace(/[(),]/g, '').slice(0, 200);

    let query = supabaseAdmin
      .from('sender_suppressions')
      .select('email, reason, note, created_at', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
    if (search) query = query.ilike('email', `%${search}%`);

    const { data, error, count } = await query;
    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ suppressions: data ?? [], total: count ?? 0, pageSize: PAGE_SIZE });
  });
}

/** POST — добавить адрес руками (или списком строк: один адрес на строку). */
export async function POST(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.sender.suppressions.add' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const body = (await req.json().catch(() => null)) as
      | { email?: unknown; emails?: unknown; note?: unknown }
      | null;

    const raw = typeof body?.email === 'string'
      ? [body.email]
      : Array.isArray(body?.emails)
        ? body.emails.filter((e): e is string => typeof e === 'string')
        : [];
    const emails = [...new Set(raw.map((e) => e.trim().toLowerCase()).filter((e) => EMAIL_RE.test(e)))];
    if (!emails.length) return jsonError('Укажите хотя бы один корректный адрес', 400);

    const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 500) || null : null;
    const chunkSize = 500;
    let imported = 0;
    for (let i = 0; i < emails.length; i += chunkSize) {
      // Уже стоящие в стоп-листе не трогаем: автоматическая причина (отбойник,
      // отписка) информативнее ручной «на всякий случай».
      const { data, error: upsertError } = await supabaseAdmin
        .from('sender_suppressions')
        .upsert(
          emails.slice(i, i + chunkSize).map((email) => ({ email, reason: 'manual', note })),
          { onConflict: 'email', ignoreDuplicates: true },
        )
        .select('email');
      if (upsertError) return jsonError(upsertError.message, 500);
      imported += data?.length ?? 0;
    }

    return NextResponse.json({ imported, skippedExisting: emails.length - imported });
  });
}

/** DELETE — снять адрес со стоп-листа (?email=...). */
export async function DELETE(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.sender.suppressions.remove' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const url = new URL(req.url);
    const email = (url.searchParams.get('email') ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return jsonError('Укажите корректный адрес', 400);

    const { error } = await supabaseAdmin.from('sender_suppressions').delete().eq('email', email);
    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ ok: true });
  });
}
