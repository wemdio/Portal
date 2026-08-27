import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.bases.by-id.get' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      const { id } = await ctx.params;

      const { data: base } = await auth.supabase
        .from('tg_outreach_bases')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (!base) return jsonError('База не найдена', 404);

      const { data: contacts } = await auth.supabase
        .from('tg_outreach_base_contacts')
        .select('id, username, message, status, skip_reason, sent_at')
        .eq('base_id', id)
        .order('created_at', { ascending: true })
        .limit(1000);

      return NextResponse.json({ base, contacts: contacts ?? [] });
    },
  );
}

/**
 * Перенести базу без владельца в кампанию.
 *
 * Только для баз с `campaign_id is null` — это те, что остались от кнопки
 * «Создать базу», не спрашивавшей кампанию. Отобрать базу у кампании-владельца
 * этим роутом нельзя: у контактов уже есть отправки, и переезд к чужой рассылке
 * смешал бы счётчики ровно так, как раньше это делала общая база. Нужен переезд
 * работающей базы — это копирование, отдельная операция.
 */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.bases.by-id.patch' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      const { id } = await ctx.params;

      const body = (await req.json().catch(() => null)) as { campaign_id?: string } | null;
      const campaignId = body?.campaign_id?.trim();
      if (!campaignId) return jsonError('campaign_id обязателен', 400);

      const { data: base } = await auth.supabase
        .from('tg_outreach_bases')
        .select('id, campaign_id')
        .eq('id', id)
        .maybeSingle();
      if (!base) return jsonError('База не найдена', 404);

      const owner = (base as { campaign_id: string | null }).campaign_id;
      if (owner && owner !== campaignId) {
        return jsonError('База уже принадлежит другой кампании — перенос работающей базы делается копированием', 409);
      }

      const { error } = await auth.supabase
        .from('tg_outreach_bases')
        .update({ campaign_id: campaignId, updated_at: new Date().toISOString() })
        .eq('id', id)
        .is('campaign_id', null);
      if (error) return jsonError(error.message, 500);

      return NextResponse.json({ ok: true });
    },
  );
}

/**
 * Правка самой базы: название, заметка и чаты-источники.
 *
 * Отдельно от PATCH: тот занят одним делом — переносом базы без владельца в
 * кампанию, и подмешивать к переезду редактирование полей значило бы сделать
 * обе операции менее понятными.
 *
 * Чаты-источники — то, ради чего роут и появился. Отчёт по договору спрашивает
 * «Кол-во обработанных чатов» и «Канал/чат» по офферу, а в файле базы источника
 * нет: там только юзернейм и текст. Три-четыре ссылки на гипотезу вводятся
 * здесь один раз, и обе колонки отчёта считаются сами.
 */
export async function PUT(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.bases.by-id.put' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      const { id } = await ctx.params;

      const body = (await req.json().catch(() => null)) as
        { name?: string; notes?: string; source_chats?: string } | null;
      if (!body) return jsonError('Неверный JSON', 400);

      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (typeof body.name === 'string') {
        const name = body.name.trim();
        if (!name) return jsonError('Название базы не может быть пустым', 400);
        patch.name = name;
      }
      if (typeof body.notes === 'string') patch.notes = body.notes.trim();
      if (typeof body.source_chats === 'string') patch.source_chats = body.source_chats.trim();

      const { data, error } = await auth.supabase
        .from('tg_outreach_bases')
        .update(patch)
        .eq('id', id)
        .select('id, name, notes, source_chats')
        .maybeSingle();
      if (error) return jsonError(error.message, 500);
      if (!data) return jsonError('База не найдена', 404);

      return NextResponse.json(data);
    },
  );
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.bases.by-id.delete' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      const { id } = await ctx.params;

      // Контакты и привязки к кампаниям уходят каскадом (on delete cascade).
      const { error } = await auth.supabase.from('tg_outreach_bases').delete().eq('id', id);
      if (error) return jsonError(error.message, 500);

      return NextResponse.json({ ok: true });
    },
  );
}
