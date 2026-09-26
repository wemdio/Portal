import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/sender/apiHelpers';
import {
  EDITABLE_CAMPAIGN_STATUSES,
  replaceSteps,
  SenderOpError,
  startCampaign,
  validateCampaignDraft,
  type CampaignStepInput,
} from '@/lib/sender/campaignOps';
import { fillPoolFromFolder } from '@/lib/sender/folders';
import { describeSavedRecipients, mergeVariableStats } from '@/lib/sender/recipientImport';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

interface PatchBody {
  action?: 'start' | 'pause' | 'finish';
  /** Правка настроек: приезжает вместо action. */
  name?: string;
  mailboxIds?: string[];
  steps?: CampaignStepInput[];
  timezone?: string;
  sendHourFrom?: number;
  sendHourTo?: number;
  sendWeekdays?: number[];
  gapSeconds?: number;
  gapJitterSeconds?: number;
}

/**
 * Сколько получателей читаем ради примеров значений в подсказках формы.
 * Сами ключи и счётчики «заполнено у N» считаются по всей базе
 * (sender_campaign_var_stats): по выборке колонка, которой не оказалось в
 * последней тысяче строк, считалась «неизвестной», и кампанию нельзя было
 * сохранить.
 */
const VARS_SAMPLE = 1000;

/** GET — кампания целиком: шаги, ящики, база получателей и её переменные. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.sender.campaigns.get' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const { id } = await params;
    const [{ data: campaign }, { data: steps }, { data: pool }, { data: sample }, { count }] =
      await Promise.all([
        supabaseAdmin.from('sender_campaigns').select('*').eq('id', id).maybeSingle(),
        supabaseAdmin.from('sender_campaign_steps').select('*').eq('campaign_id', id).order('step_no'),
        supabaseAdmin
          .from('sender_campaign_mailboxes')
          .select('mailbox_id, sender_mailboxes(id, email)')
          .eq('campaign_id', id),
        supabaseAdmin
          .from('sender_recipients')
          .select('email, name, vars')
          .eq('campaign_id', id)
          .order('created_at', { ascending: false })
          .limit(VARS_SAMPLE),
        supabaseAdmin
          .from('sender_recipients')
          .select('id', { count: 'exact', head: true })
          .eq('campaign_id', id),
      ]);

    if (!campaign) return jsonError('Кампания не найдена', 404);

    const db = supabaseAdmin;
    // Разбивка ответов по шагам цепочки (задача 6.4): на каком касании лид
    // ответил. last_step_sent фиксируется после отправки шага, поэтому
    // «ответил на шаге N» = ответил после N отправленных писем.
    const MAX_STEP = 5;
    const stepCounts = await Promise.all(
      Array.from({ length: MAX_STEP }, (_, i) =>
        db
          .from('sender_recipients')
          .select('id', { count: 'exact', head: true })
          .eq('campaign_id', id)
          .eq('status', 'replied')
          .eq('last_step_sent', i + 1)
          .then(({ count }) => count ?? 0),
      ),
    );
    const repliesByStep = stepCounts
      .map((count, index) => ({ step: index + 1, replied: count }))
      .filter((row) => row.replied > 0);

    // Вложенная запись приезжает объектом или массивом — приводим к одному виду.
    const mailboxes = (pool ?? []).flatMap((row) => {
      const raw = (row as { sender_mailboxes?: unknown }).sender_mailboxes;
      const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
      return list
        .map((m) => m as { id?: string; email?: string })
        .filter((m): m is { id: string; email: string } => Boolean(m.id && m.email))
        .map((m) => ({ id: String(m.id), email: String(m.email) }));
    });

    const rows = (sample ?? []) as { email: string; name: string | null; vars: Record<string, string> }[];
    const total = count ?? 0;

    // Выборка покрывает всю базу — считать нечего. Иначе добираем ключи и
    // счётчики по всем строкам; не посчиталось — остаёмся на выборке.
    let columns = describeSavedRecipients(rows);
    let exact = total <= VARS_SAMPLE;
    if (!exact) {
      const [{ data: stats, error: statsError }, { count: namedCount }] = await Promise.all([
        db.rpc('sender_campaign_var_stats', { p_campaign_id: id }),
        db
          .from('sender_recipients')
          .select('id', { count: 'exact', head: true })
          .eq('campaign_id', id)
          .not('name', 'is', null)
          .neq('name', ''),
      ]);
      if (!statsError && Array.isArray(stats)) {
        columns = mergeVariableStats(columns, stats as { key: string; filled: number }[], {
          total,
          named: namedCount ?? 0,
        });
        exact = true;
      }
    }

    return NextResponse.json({
      campaign,
      steps: steps ?? [],
      mailboxes,
      repliesByStep,
      recipients: {
        total,
        // Счётчики «заполнено у N» честны, только если посчитаны по всей
        // базе; иначе форма покажет переменные без цифр, а не цифры наугад.
        exact,
        columns,
      },
      editable: EDITABLE_CAMPAIGN_STATUSES.includes(String(campaign.status)),
    });
  });
}

/**
 * Правка настроек кампании: название, пул ящиков, письмо и окно отправки.
 *
 * Только у черновика и остановленной кампании. У идущей запрещено намеренно:
 * планировщик материализует текст письма в очередь заранее, и правка догнала
 * бы только тех, кого он ещё не успел поставить, — то есть половина базы
 * получила бы старое письмо, половина новое, и понять границу нельзя.
 */
async function updateSettings(id: string, body: PatchBody) {
  if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

  const { data: campaign } = await supabaseAdmin
    .from('sender_campaigns').select('id, status').eq('id', id).maybeSingle();
  if (!campaign) return jsonError('Кампания не найдена', 404);
  if (!EDITABLE_CAMPAIGN_STATUSES.includes(String(campaign.status))) {
    return jsonError('Идущую и завершённую кампанию править нельзя — сначала поставьте на паузу', 409);
  }

  // Та же проверка, что при создании (campaignOps): ошибка — SenderOpError,
  // её в ответ превращает PATCH.
  const { name, mailboxIds, steps } = validateCampaignDraft({
    name: body.name ?? '',
    mailboxIds: body.mailboxIds ?? [],
    steps: body.steps ?? [],
  });

  const nowIso = new Date().toISOString();
  const { error } = await supabaseAdmin
    .from('sender_campaigns')
    .update({
      name,
      timezone: body.timezone?.trim() || 'Europe/Moscow',
      send_hour_from: body.sendHourFrom ?? 9,
      send_hour_to: body.sendHourTo ?? 18,
      send_weekdays: body.sendWeekdays?.length ? body.sendWeekdays : [1, 2, 3, 4, 5],
      gap_seconds: Math.max(0, Math.round(body.gapSeconds ?? 180)),
      gap_jitter_seconds: Math.max(0, Math.round(body.gapJitterSeconds ?? 120)),
      updated_at: nowIso,
    })
    .eq('id', id);
  if (error) return jsonError(error.message, 500);

  // Пул и шаги переписываются целиком: набор маленький, а разбор «что
  // добавили, что убрали» на каждое сохранение — лишний источник расхождений.
  await supabaseAdmin.from('sender_campaign_mailboxes').delete().eq('campaign_id', id);
  const { error: poolError } = await supabaseAdmin
    .from('sender_campaign_mailboxes')
    .insert(mailboxIds.map((mailboxId) => ({ campaign_id: id, mailbox_id: mailboxId })));
  if (poolError) return jsonError(poolError.message, 500);

  await replaceSteps(id, steps);

  // Лид закреплён за ящиком на всю переписку. Если ящик убрали из пула, те,
  // кому ещё не писали, зависли бы навсегда: планировщик ждёт именно «свой»
  // ящик. Открепляем их — уедут с другого. Тех, с кем переписка уже началась,
  // не трогаем: для получателя смена отправителя выглядит как чужое письмо.
  const { data: stuck } = await supabaseAdmin
    .from('sender_recipients')
    .select('id, mailbox_id')
    .eq('campaign_id', id)
    .eq('last_step_sent', 0)
    .not('mailbox_id', 'is', null);

  const orphanIds = (stuck ?? [])
    .filter((row) => !mailboxIds.includes(String(row.mailbox_id)))
    .map((row) => String(row.id));
  if (orphanIds.length) {
    await supabaseAdmin
      .from('sender_recipients')
      .update({ mailbox_id: null, updated_at: nowIso })
      .in('id', orphanIds);
  }

  return NextResponse.json({ ok: true, unstuck: orphanIds.length });
}

/**
 * PATCH — запустить, поставить на паузу или закрыть кампанию; без action —
 * правка настроек. Запуск — campaignOps.startCampaign: тем же путём рассылку
 * запускает кнопка на экране автоаутрича. Рассылка папки без ящиков перед
 * запуском берёт ящики папки (folders.fillPoolFromFolder) — как и там.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.sender.campaigns.patch' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const { id } = await params;
    const body = (await req.json().catch(() => null)) as PatchBody | null;
    if (!body) return jsonError('Невалидный JSON', 400);

    try {
      if (!body.action) return await updateSettings(id, body);
      if (body.action === 'start') {
        // Сколько ящиков взято из папки — экран скажет, откуда они взялись.
        const mailboxesAdded = await fillPoolFromFolder(id);
        await startCampaign(id);
        return NextResponse.json({ ok: true, status: 'running', mailboxesAdded });
      }
    } catch (e) {
      if (e instanceof SenderOpError) return jsonError(e.message, e.status);
      throw e;
    }

    const status = body.action === 'pause' ? 'paused' : 'done';
    const { error } = await supabaseAdmin
      .from('sender_campaigns')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) return jsonError(error.message, 500);

    // Пауза и закрытие снимают уже запланированные, но ещё не отправленные
    // письма: иначе кампания продолжила бы «доезжать» после остановки.
    await supabaseAdmin
      .from('sender_messages')
      .update({ status: 'canceled' })
      .eq('campaign_id', id)
      .eq('status', 'scheduled');

    return NextResponse.json({ ok: true, status });
  });
}

/**
 * DELETE — убрать кампанию. Идущую удалить нельзя: письма физически уходят,
 * и исчезновение кампании вместе с очередью скрыло бы факт отправки. Пауза
 * или завершение — сначала, удаление — потом.
 */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.sender.campaigns.delete' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const { id } = await params;
    const { data: campaign } = await supabaseAdmin
      .from('sender_campaigns')
      .select('id, status')
      .eq('id', id)
      .maybeSingle();
    if (!campaign) return jsonError('Кампания не найдена', 404);
    if (String(campaign.status) === 'running') {
      return jsonError('Идущую кампанию удалить нельзя — сначала поставьте на паузу или завершите', 409);
    }

    const { error } = await supabaseAdmin.from('sender_campaigns').delete().eq('id', id);
    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ ok: true });
  });
}
