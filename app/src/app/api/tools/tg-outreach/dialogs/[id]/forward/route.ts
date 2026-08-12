/**
 * Ручная передача лида или кандидата в партнёры.
 *
 * GET — предпросмотр сообщения, POST — постановка в очередь. Текст собирается
 * одной и той же функцией и в POST сохраняется в задачу: оператор подтверждает
 * конкретный текст, и уйти должен ровно он.
 *
 * Здесь не отправляем: живое соединение с Telegram есть только у воркера, а
 * второе подключение к той же сессии — это AUTH_KEY_DUPLICATED и выключенный
 * аккаунт. Воркер заберёт задачу, когда дойдёт до этого аккаунта в круге.
 */
import { NextRequest, NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';
import { buildLeadMessage, type ForwardKind } from '@/lib/tgOutreach/leadMessage';
import { checkForwardConflict, type ExistingForward } from '@/lib/tgOutreach/forwardConflict';
import { usernameKey } from '@/lib/tgOutreach/report';
import type { OpenAISettings } from '@/lib/tgOutreach/types';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

function parseKind(value: string | null): ForwardKind | null {
  return value === 'lead' || value === 'partner' ? value : null;
}

interface Prepared {
  text: string;
  targetChat: string;
  campaignId: string;
  accountId: string;
  requestedByName: string;
}

/** Собрать сообщение и получателя. Общая часть предпросмотра и постановки. */
async function prepare(
  db: SupabaseClient,
  dialogId: string,
  kind: ForwardKind,
  requestedByName: string,
): Promise<Prepared | { error: string; status: number }> {

  const { data: dialogRow } = await db
    .from('tg_outreach_dialogs')
    .select('id, campaign_id, account_id, tg_user_id, tg_username, messages')
    .eq('id', dialogId)
    .maybeSingle();
  if (!dialogRow) return { error: 'Диалог не найден', status: 404 };

  const dialog = dialogRow as {
    campaign_id: string;
    account_id: string;
    tg_user_id: number | null;
    tg_username: string | null;
    messages: Array<{ role?: string; content?: string; timestamp?: string }> | null;
  };

  const { data: campaignRow } = await db
    .from('tg_outreach_campaigns')
    .select('id, name, openai_settings')
    .eq('id', dialog.campaign_id)
    .maybeSingle();
  if (!campaignRow) return { error: 'Кампания не найдена', status: 404 };
  const campaign = campaignRow as { name: string; openai_settings: OpenAISettings };

  const oai = campaign.openai_settings ?? ({} as OpenAISettings);
  // Партнёру — свой чат; пусто — падаем на чат положительного триггера, чтобы
  // кнопка работала сразу после выката, а не упиралась в пустую настройку.
  const targetChat = (kind === 'partner'
    ? (oai.target_chats_partner?.trim() || oai.target_chats_positive?.trim())
    : oai.target_chats_positive?.trim()) ?? '';
  if (!targetChat) {
    return {
      error: kind === 'partner'
        ? 'В настройках кампании не указан ни «Чат для партнёров», ни «Чат для пересылки (+)»'
        : 'В настройках кампании не указан «Чат для пересылки (+)»',
      status: 400,
    };
  }

  const { data: accountRow } = await db
    .from('tg_outreach_accounts')
    .select('id, session_name, phone')
    .eq('id', dialog.account_id)
    .maybeSingle();
  const account = (accountRow ?? {}) as { session_name?: string; phone?: string };

  // Оффер и чат-источник ищем по юзернейму в базах этой кампании: в диалоге
  // связи с контактом нет, а менеджеру важно, по какому офферу человек пришёл.
  let baseName: string | null = null;
  let sourceChat: string | null = null;
  const key = usernameKey(dialog.tg_username);
  if (key) {
    const { data: baseRows } = await db
      .from('tg_outreach_bases')
      .select('id, name')
      .eq('campaign_id', dialog.campaign_id)
      .limit(500);
    const bases = (baseRows ?? []) as Array<{ id: string; name: string }>;
    if (bases.length) {
      const { data: contactRows } = await db
        .from('tg_outreach_base_contacts')
        .select('base_id, username, raw')
        .in('base_id', bases.map((b) => b.id))
        .limit(50_000);
      const contact = ((contactRows ?? []) as Array<{
        base_id: string; username: string; raw: Record<string, unknown> | null;
      }>).find((c) => usernameKey(c.username) === key);
      if (contact) {
        baseName = bases.find((b) => b.id === contact.base_id)?.name ?? null;
        const raw = contact.raw ?? {};
        sourceChat = String(raw['Ссылка на источник'] ?? raw['Название источника'] ?? raw['Источник'] ?? '') || null;
      }
    }
  }

  const messages = dialog.messages ?? [];

  const text = buildLeadMessage({
    kind,
    campaignName: campaign.name,
    username: dialog.tg_username,
    tgUserId: dialog.tg_user_id,
    baseName,
    sourceChat,
    accountLabel: account.session_name ?? '—',
    accountPhone: account.phone ?? null,
    messages,
  });

  return {
    text,
    targetChat,
    campaignId: dialog.campaign_id,
    accountId: dialog.account_id,
    requestedByName,
  };
}

/**
 * Уже переданные и ожидающие передачи этого диалога.
 *
 * Отдельным запросом до сборки сообщения: собирать текст ради того, чтобы
 * отказать, — лишняя работа, а оператору нужен ответ сразу.
 */
async function loadForwards(db: SupabaseClient, dialogId: string): Promise<ExistingForward[]> {
  const { data } = await db
    .from('tg_outreach_lead_forwards')
    .select('kind, status, requested_at, sent_at')
    .eq('dialog_id', dialogId)
    .order('requested_at', { ascending: false })
    .limit(20);
  return (data ?? []) as ExistingForward[];
}

/** Человеческое имя того, кто нажал кнопку — для строки «передал». */
function operatorName(user: { email?: string | null; user_metadata?: Record<string, unknown> | null }): string {
  const meta = user.user_metadata ?? {};
  const named = [meta.full_name, meta.name, meta.username].find(
    (v): v is string => typeof v === 'string' && v.trim() !== '',
  );
  return named ?? user.email ?? 'сотрудник портала';
}

export async function GET(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.dialogs.forward.preview' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      const { id } = await ctx.params;

      const kind = parseKind(new URL(req.url).searchParams.get('kind'));
      if (!kind) return jsonError('kind должен быть lead или partner', 400);

      // Проверяем и в предпросмотре: показать текст, а потом отказать на
      // подтверждении — это обмануть ожидание оператора.
      const conflict = checkForwardConflict(await loadForwards(auth.supabase, id), kind);
      if (conflict) return jsonError(conflict, 409);

      const prepared = await prepare(auth.supabase, id, kind, operatorName(auth.user));
      if ('error' in prepared) return jsonError(prepared.error, prepared.status);

      return NextResponse.json({ text: prepared.text, target_chat: prepared.targetChat });
    },
  );
}

export async function POST(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.dialogs.forward.post' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      const { id } = await ctx.params;

      const body = (await req.json().catch(() => null)) as { kind?: string } | null;
      const kind = parseKind(body?.kind ?? null);
      if (!kind) return jsonError('kind должен быть lead или partner', 400);

      const conflict = checkForwardConflict(await loadForwards(auth.supabase, id), kind);
      if (conflict) return jsonError(conflict, 409);

      const name = operatorName(auth.user);
      const prepared = await prepare(auth.supabase, id, kind, name);
      if ('error' in prepared) return jsonError(prepared.error, prepared.status);

      const { data, error } = await auth.supabase
        .from('tg_outreach_lead_forwards')
        .insert({
          campaign_id: prepared.campaignId,
          dialog_id: id,
          account_id: prepared.accountId,
          kind,
          target_chat: prepared.targetChat,
          message_text: prepared.text,
          requested_by: auth.user.id,
          requested_by_name: name,
        })
        .select('id')
        .single();

      if (error) {
        // Частичный уникальный индекс — последняя защита от гонки: два клика
        // могли пройти проверку выше одновременно. Отвечаем тем же языком.
        if (String(error.code) === '23505') {
          return jsonError('Этот диалог уже передан или стоит в очереди на передачу', 409);
        }
        return jsonError(error.message, 500);
      }

      return NextResponse.json({ ok: true, id: (data as { id: string }).id, target_chat: prepared.targetChat }, { status: 201 });
    },
  );
}
