/**
 * Ручная передача лида или кандидата в партнёры.
 *
 * GET — предпросмотр сообщения, POST — постановка в очередь. Текст собирается
 * одной и той же функцией и в POST сохраняется в задачу: оператор подтверждает
 * конкретный текст, и уйти должен ровно он.
 *
 * Здесь не отправляем: живое соединение с Telegram есть только у воркера, а
 * второе подключение к той же сессии — это AUTH_KEY_DUPLICATED и выключенный
 * аккаунт. Воркер запущенной кампании опрашивает очередь каждые несколько
 * секунд и отправляет сразу, не дожидаясь круга (см. lib/tgOutreach/leadForward.ts).
 */
import { NextRequest, NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';
import { buildLeadMessage, type ForwardKind } from '@/lib/tgOutreach/leadMessage';
import { checkForwardConflict, cancelBlockReason, type ExistingForward } from '@/lib/tgOutreach/forwardConflict';
import { loadLeadOrigin } from '@/lib/tgOutreach/leadOrigin';
import { logCampaign, forwardKindLabel, forwardWho } from '@/lib/tgOutreach/campaignLog';
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
  /** Кого передаём — в журнал и в сообщения об ошибках. */
  who: string;
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

  // Оффер и чат-источник ищем по юзернейму в базах этой кампании: в диалоге
  // связи с контактом нет, а менеджеру важно, по какому офферу человек пришёл.
  const { baseName, sourceChat } = await loadLeadOrigin(db, dialog.campaign_id, dialog.tg_username);

  const messages = dialog.messages ?? [];

  const text = buildLeadMessage({
    kind,
    campaignName: campaign.name,
    username: dialog.tg_username,
    tgUserId: dialog.tg_user_id,
    baseName,
    sourceChat,
    messages,
  });

  return {
    text,
    targetChat,
    campaignId: dialog.campaign_id,
    accountId: dialog.account_id,
    requestedByName,
    who: forwardWho(dialog.tg_username, dialog.tg_user_id),
  };
}

/**
 * Кампания и собеседник диалога — чтобы записать в журнал даже отказ, когда до
 * сборки сообщения дело не дошло.
 */
async function dialogRef(db: SupabaseClient, dialogId: string): Promise<{ campaignId: string; who: string } | null> {
  const { data } = await db
    .from('tg_outreach_dialogs')
    .select('campaign_id, tg_user_id, tg_username')
    .eq('id', dialogId)
    .maybeSingle();
  if (!data) return null;
  const row = data as { campaign_id: string; tg_user_id: number | null; tg_username: string | null };
  return { campaignId: row.campaign_id, who: forwardWho(row.tg_username, row.tg_user_id) };
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

      const who = operatorName(auth.user);
      const ref = await dialogRef(auth.supabase, id);

      // Проверяем и в предпросмотре: показать текст, а потом отказать на
      // подтверждении — это обмануть ожидание оператора.
      const conflict = checkForwardConflict(await loadForwards(auth.supabase, id), kind);
      if (conflict) {
        if (ref) {
          await logCampaign(auth.supabase, ref.campaignId, 'warning',
            `Передача (${forwardKindLabel(kind)}) ${ref.who}: отказ — ${conflict} (нажал ${who})`);
        }
        return jsonError(conflict, 409);
      }

      const prepared = await prepare(auth.supabase, id, kind, who);
      if ('error' in prepared) {
        if (ref) {
          await logCampaign(auth.supabase, ref.campaignId, 'warning',
            `Передача (${forwardKindLabel(kind)}) ${ref.who}: не смог собрать сообщение — ${prepared.error} (нажал ${who})`);
        }
        return jsonError(prepared.error, prepared.status);
      }

      // Нажатие на кнопку — уже действие: если оператор передумает на
      // подтверждении, в журнале останется только эта строка, и по ней видно,
      // что решение принимали и отменили.
      await logCampaign(auth.supabase, prepared.campaignId, 'info',
        `Передача (${forwardKindLabel(kind)}) ${prepared.who}: открыт предпросмотр, получатель ${prepared.targetChat} (нажал ${who})`);

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

      const name = operatorName(auth.user);
      const ref = await dialogRef(auth.supabase, id);

      const conflict = checkForwardConflict(await loadForwards(auth.supabase, id), kind);
      if (conflict) {
        if (ref) {
          await logCampaign(auth.supabase, ref.campaignId, 'warning',
            `Передача (${forwardKindLabel(kind)}) ${ref.who}: отказ — ${conflict} (нажал ${name})`);
        }
        return jsonError(conflict, 409);
      }

      const prepared = await prepare(auth.supabase, id, kind, name);
      if ('error' in prepared) {
        if (ref) {
          await logCampaign(auth.supabase, ref.campaignId, 'warning',
            `Передача (${forwardKindLabel(kind)}) ${ref.who}: не смог собрать сообщение — ${prepared.error} (нажал ${name})`);
        }
        return jsonError(prepared.error, prepared.status);
      }

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
        const duplicate = String(error.code) === '23505';
        const reason = duplicate ? 'этот диалог уже передан или стоит в очереди' : error.message;
        await logCampaign(auth.supabase, prepared.campaignId, 'warning',
          `Передача (${forwardKindLabel(kind)}) ${prepared.who}: не поставлена в очередь — ${reason} (нажал ${name})`);
        if (duplicate) {
          return jsonError('Этот диалог уже передан или стоит в очереди на передачу', 409);
        }
        return jsonError(error.message, 500);
      }

      await logCampaign(auth.supabase, prepared.campaignId, 'info',
        `Передача (${forwardKindLabel(kind)}) ${prepared.who}: поставлена в очередь, получатель ${prepared.targetChat} (нажал ${name})`);

      /**
       * Ручная передача лида — это и есть пометка «лид».
       *
       * До 27.08.2026 статус диалога она не трогала, и лид, отданный менеджеру
       * руками, нигде лидом не числился: и воронка на сводке, и «Кол-во целевых
       * ответов» в отчёте по договору считают по `status = 'lead'`. Автоматика
       * по положительному триггеру статус ставит, оператор — нет, и отчёт
       * клиенту занижался ровно на число ручных передач.
       *
       * Только для лида: кандидат в партнёры — не целевой ответ клиента, и в
       * его воронке ему не место.
       *
       * Отмена передачи статус обратно не снимает: решение «это лид» принял
       * человек, и несостоявшаяся отправка его не отменяет — снять статус можно
       * кнопками на карточке диалога.
       */
      if (kind === 'lead') {
        const { error: statusErr } = await auth.supabase
          .from('tg_outreach_dialogs')
          .update({ status: 'lead' })
          .eq('id', id)
          .neq('status', 'lead');
        if (statusErr) {
          // Передача уже в очереди — ронять её из-за статуса нельзя. Но и
          // молчать нельзя: цифра в отчёте разойдётся с реальностью, и узнать
          // об этом можно только из журнала.
          await logCampaign(auth.supabase, prepared.campaignId, 'warning',
            `Передача (лид) ${prepared.who}: в очереди, но статус «Лид» не проставился — ${statusErr.message}. Поставьте его руками, иначе лид не попадёт в отчёт.`);
        }
      }

      return NextResponse.json({ ok: true, id: (data as { id: string }).id, target_chat: prepared.targetChat }, { status: 201 });
    },
  );
}

/**
 * Снять передачу из очереди, пока воркер до неё не дошёл.
 *
 * Окно короткое: у запущенной кампании воркер берёт задачу в ближайшие
 * секунды. Оно растягивается, только если кампания остановлена или аккаунт
 * не отвечает, — и тогда это единственный шанс исправить ошибку, потому что
 * отозвать сообщение из Telegram нельзя.
 */
export async function DELETE(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.dialogs.forward.cancel' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      const { id } = await ctx.params;

      const name = operatorName(auth.user);
      const ref = await dialogRef(auth.supabase, id);

      /**
       * `status = 'pending'` стоит условием самой записи, а не только проверкой
       * перед ней: воркер мог отправить задачу ровно между нашим чтением и
       * записью. Тогда ноль изменённых строк — честный ответ «не успели», а
       * проверка-до-записи в том же случае отрапортовала бы об отмене того, что
       * уже лежит у менеджера в чате.
       *
       * Кого снимать, не уточняем: уникальный индекс держит на диалоге не
       * больше одной живой передачи.
       */
      const { data: cancelledRows, error } = await auth.supabase
        .from('tg_outreach_lead_forwards')
        .update({
          status: 'cancelled',
          // Поле объясняет отсутствие отправки, и для снятой задачи ответ —
          // это человек, который её снял. Он же уходит в журнал кампании.
          error_message: `Отменил ${name}`,
        })
        .eq('dialog_id', id)
        .eq('status', 'pending')
        .select('kind');

      if (error) {
        if (ref) {
          await logCampaign(auth.supabase, ref.campaignId, 'error',
            `Отмена передачи ${ref.who}: не удалась — ${error.message} (нажал ${name})`);
        }
        return jsonError(error.message, 500);
      }

      const cancelled = (cancelledRows ?? []) as Array<{ kind: string }>;
      if (!cancelled.length) {
        // Ничего не сняли — объясняем почему. Последняя передача диалога и
        // отвечает на этот вопрос: ушла, сорвалась или её вовсе не было.
        const latest = (await loadForwards(auth.supabase, id))[0] ?? null;
        const reason = cancelBlockReason(latest) ?? 'Эту передачу уже нельзя отменить';
        if (ref) {
          await logCampaign(auth.supabase, ref.campaignId, 'warning',
            `Отмена передачи ${ref.who}: отказ — ${reason} (нажал ${name})`);
        }
        return jsonError(reason, 409);
      }

      const kind = cancelled[0].kind;
      // Тем же языком, что и ручное гашение очереди 13.08.2026, — чтобы вся
      // история отмен в журнале кампании читалась одинаково.
      if (ref) {
        await logCampaign(auth.supabase, ref.campaignId, 'warning',
          `Передача (${forwardKindLabel(kind)}) ${ref.who}: отменена до отправки — снята из очереди (нажал ${name})`);
      }

      return NextResponse.json({ ok: true, kind });
    },
  );
}
