import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';
import { parseChatLink } from '@/lib/tgOutreach/warmup/chatSchedule';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * Список публичных чатов кампании для этапа прогрева.
 *
 * Список живёт долго и не привязан к запуску прогрева: собирается один раз, а
 * прогревов на кампании может быть несколько.
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.campaigns.by-id.warmup.chats.get' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      const { id } = await ctx.params;

      const { data: chats, error } = await auth.supabase
        .from('tg_outreach_warmup_chats')
        .select('*')
        .eq('campaign_id', id)
        .order('created_at', { ascending: true });
      if (error) return jsonError(error.message, 500);

      // Сколько аккаунтов состоит в каждом чате — оператору нужно понимать,
      // работает ли чат вообще, а не только числится ли он в списке.
      const { data: members } = await auth.supabase
        .from('tg_outreach_warmup_chat_members')
        .select('chat_id, status')
        .eq('campaign_id', id);

      const joined = new Map<string, number>();
      const forbidden = new Map<string, number>();
      for (const m of (members ?? []) as Array<{ chat_id: string; status: string }>) {
        const target = m.status === 'joined' ? joined : m.status === 'forbidden' ? forbidden : null;
        if (target) target.set(m.chat_id, (target.get(m.chat_id) ?? 0) + 1);
      }

      return NextResponse.json({
        items: (chats ?? []).map((c) => ({
          ...c,
          joined_accounts: joined.get(c.id) ?? 0,
          forbidden_accounts: forbidden.get(c.id) ?? 0,
        })),
      });
    },
  );
}

/**
 * Добавить чаты. Принимает и одну ссылку, и список — оператор обычно копирует
 * сразу пачку.
 *
 * Ссылки только разбираем, но не резолвим: проверка требует подключения
 * аккаунта через прокси, это отдельная кнопка. Здесь важно другое — сразу
 * отсечь то, что заведомо не подойдёт (приглашения в закрытые чаты, мусор),
 * чтобы оператор не узнал об этом посреди прогрева.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.campaigns.by-id.warmup.chats.post' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      const { id } = await ctx.params;

      const body = (await req.json().catch(() => ({}))) as { links?: string[]; link?: string };
      const raw = body.links?.length ? body.links : body.link ? [body.link] : [];
      if (!raw.length) return jsonError('Добавьте хотя бы одну ссылку', 400);

      const rows: Array<{ campaign_id: string; link: string; username: string }> = [];
      const rejected: string[] = [];
      const seen = new Set<string>();

      for (const item of raw) {
        const username = parseChatLink(item);
        if (!username) {
          rejected.push(item.trim());
          continue;
        }
        // Telegram не различает регистр в адресах, а уникальный индекс
        // различает — нормализуем до вставки, иначе один чат заедет дважды.
        const key = username.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({ campaign_id: id, link: `t.me/${key}`, username: key });
      }

      if (rows.length) {
        const { error } = await auth.supabase
          .from('tg_outreach_warmup_chats')
          .upsert(rows, { onConflict: 'campaign_id,link', ignoreDuplicates: true });
        if (error) return jsonError(error.message, 500);
      }

      return NextResponse.json({ added: rows.length, rejected }, { status: 201 });
    },
  );
}
