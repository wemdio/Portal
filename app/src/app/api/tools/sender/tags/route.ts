import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/sender/apiHelpers';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { isDuplicateName, normalizeTagName } from '@/lib/sender/tags';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

/**
 * GET — теги со счётчиком ящиков.
 *
 * Счётчик приезжает встроенной агрегацией, а не запросом на тег: тегов
 * немного, но список открывается по каждому клику на фильтр, и N запросов на
 * каждое открытие окошка — плохая привычка.
 */
export async function GET(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.sender.tags.list' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const { data, error } = await supabaseAdmin
      .from('sender_mailbox_tags')
      .select('id, name, created_at, sender_mailboxes(count)')
      .order('name', { ascending: true });

    if (error) return jsonError(error.message, 500);

    const tags = (data ?? []).map((row) => {
      const raw = (row as { sender_mailboxes?: unknown }).sender_mailboxes;
      const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
      const first = list[0] as { count?: number } | undefined;
      return {
        id: String(row.id),
        name: String(row.name),
        mailboxes: Number(first?.count ?? 0),
      };
    });

    // Ящики без тега — такой же пункт фильтра, как сам тег, и считать его
    // в браузере нельзя: на экране лежит одна страница из всего пула.
    const { count: untagged } = await supabaseAdmin
      .from('sender_mailboxes')
      .select('id', { count: 'exact', head: true })
      .is('tag_id', null);

    return NextResponse.json({ tags, untagged: untagged ?? 0 });
  });
}

/** POST — создать тег. */
export async function POST(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.sender.tags.create' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const body = (await req.json().catch(() => null)) as { name?: unknown } | null;
    const name = normalizeTagName(body?.name);
    if (!name) return jsonError('Укажите название тега', 400);

    const { data, error } = await supabaseAdmin
      .from('sender_mailbox_tags')
      .insert({ name, created_by: auth.user.id })
      .select('id, name')
      .single();

    if (error) {
      if (isDuplicateName(error.code)) return jsonError(`Тег «${name}» уже есть`, 409);
      return jsonError(error.message, 500);
    }

    return NextResponse.json({ id: String(data.id), name: String(data.name), mailboxes: 0 });
  });
}
