import { NextRequest, NextResponse } from 'next/server';
import { releaseOutreachRowsBeforeCampaignDelete, type OutreachCampaignDeleteResult } from '@/lib/outreachSender/deletion';
import { authenticateRequest, jsonError } from '@/lib/sender/apiHelpers';
import {
  cancelScheduledStart,
  clientUserIdOf,
  EDITABLE_CAMPAIGN_STATUSES,
  projectIdOf,
  replaceSteps,
  scheduleCampaignStart,
  SenderOpError,
  startCampaign,
  validateCampaignDraft,
  type CampaignStepInput,
} from '@/lib/sender/campaignOps';
import { fillPoolFromFolder } from '@/lib/sender/folders';
import { syncSenderCampaignStopList } from '@/lib/sender/stopLists';
import { describeSavedRecipients, mergeVariableStats } from '@/lib/sender/recipientImport';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { loadCampaignTagIds, saveCampaignTags } from '@/lib/sender/campaignTags';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

interface PatchBody {
  action?: 'start' | 'pause' | 'finish' | 'schedule' | 'unschedule';
  /** Отложенный запуск (action 'schedule'): момент в ISO, по UTC. */
  startAt?: string;
  /** Правка настроек: приезжает вместо action. */
  name?: string;
  mailboxIds?: string[];
  /** Теги ящиков, привязанные к кампании целиком. Нет поля — привязку не трогаем. */
  tagIds?: string[];
  steps?: CampaignStepInput[];
  timezone?: string;
  sendHourFrom?: number;
  sendHourTo?: number;
  sendWeekdays?: number[];
  gapSeconds?: number;
  gapJitterSeconds?: number;
  /** Проект портала: null — отвязать. Нет поля — привязку не трогаем. */
  projectId?: string | null;
  /** Клиент кабинета (стоп-лист): null — отвязать. Нет поля — не трогаем. */
  clientUserId?: string | null;
  /** Автосохранение недописанной формы: проверки откладываются до запуска. */
  draft?: boolean;
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
        supabaseAdmin
          .from('sender_campaign_steps')
          .select('*')
          .eq('campaign_id', id)
          .order('step_no')
          .order('variant_no'),
        supabaseAdmin
          .from('sender_campaign_mailboxes')
          .select('mailbox_id, sender_mailboxes(id, email, tag_id)')
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

    // Результаты А/Б-теста: сколько ушло и сколько ответили по каждому варианту
    // письма. Не посчиталось — экран просто не покажет таблицу, остальное от
    // этого не зависит.
    const { data: variantRows } = await db.rpc('sender_campaign_variant_stats', { p_campaign_id: id });
    const variantStats = (Array.isArray(variantRows) ? variantRows : []).map((row) => {
      const stat = row as { step_no: number; variant_no: number; sent: number; replied: number };
      return {
        step: Number(stat.step_no),
        variant: Number(stat.variant_no),
        sent: Number(stat.sent ?? 0),
        replied: Number(stat.replied ?? 0),
      };
    });

    // Вложенная запись приезжает объектом или массивом — приводим к одному виду.
    const mailboxes = (pool ?? []).flatMap((row) => {
      const raw = (row as { sender_mailboxes?: unknown }).sender_mailboxes;
      const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
      return list
        .map((m) => m as { id?: string; email?: string; tag_id?: string | null })
        .filter((m): m is { id: string; email: string; tag_id?: string | null } => Boolean(m.id && m.email))
        .map((m) => ({ id: String(m.id), email: String(m.email), tagId: m.tag_id ? String(m.tag_id) : null }));
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
      tagIds: await loadCampaignTagIds(id),
      repliesByStep,
      variantStats,
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

/** Сверка базы со стоп-листами клиента и проекта при постановке запуска; ответ-ошибка или null. */
async function checkStopListsBeforeStart(id: string) {
  if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);
  const { data: campaign } = await supabaseAdmin
    .from('sender_campaigns').select('id, client_user_id, project_id').eq('id', id).maybeSingle();
  if (!campaign) return jsonError('Кампания не найдена', 404);
  try {
    await syncSenderCampaignStopList(supabaseAdmin, supabaseInstantly, campaign);
    return null;
  } catch (e) {
    return jsonError(
      `Стоп-листы клиента и проекта не сверены — запуск отложен: ${e instanceof Error ? e.message : String(e)}`,
      503,
    );
  }
}

/**
 * Кампанией запуска Движка вертикалей управляет он сам: по ней считается факт
 * проекта и идёт подача контактов. Завершённая или удалённая кампания
 * оставила бы запуск без кампании, поэтому — только пауза.
 */
const VE2_MANAGED_CAMPAIGN = 'Кампанией управляет Движок вертикалей: её можно только поставить на паузу';

/**
 * Черновик Движка вертикалей, которого нет в его очереди, — след
 * несостоявшегося запуска: сверка запуска его удаляет. Запустить его — значит
 * слать мимо плана и запереть сверку. null — запускать можно.
 */
async function orphanVeDraftError(id: string) {
  const { data: campaign, error } = await supabaseAdmin!
    .from('sender_campaigns').select('source_kind').eq('id', id).maybeSingle();
  if (error) return jsonError(error.message, 500);
  if (campaign?.source_kind !== 've2') return null;
  const { data: queued, error: queueError } = await supabaseAdmin!
    .from('ve_launch_queue_campaigns').select('id').eq('campaign_id', id).limit(1);
  if (queueError) return jsonError(queueError.message, 500);
  if ((queued ?? []).length) return null;
  return jsonError('Это черновик несостоявшегося запуска Движка вертикалей — сверьте запуск в Движке, запускать его нельзя', 409);
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
    .from('sender_campaigns').select('id, status, client_user_id, project_id, source_kind').eq('id', id).maybeSingle();
  if (!campaign) return jsonError('Кампания не найдена', 404);
  if (!EDITABLE_CAMPAIGN_STATUSES.includes(String(campaign.status))) {
    return jsonError('Идущую и завершённую кампанию править нельзя — сначала поставьте на паузу', 409);
  }
  // Другой клиент или проект — другие стоп-листы: прежняя сверка не в счёт,
  // запуск по расписанию дождётся новой.
  const scopeChanged =
    ('clientUserId' in body && clientUserIdOf(body.clientUserId) !== (campaign.client_user_id ?? null)) ||
    ('projectId' in body && projectIdOf(body.projectId) !== (campaign.project_id ?? null));
  // По проекту кампании Движок вертикалей считает факт, по клиенту — стоп-лист.
  if (campaign.source_kind === 've2' && scopeChanged) {
    return jsonError('У кампании Движка вертикалей проект и клиента менять нельзя', 409);
  }

  // Та же проверка, что при создании (campaignOps): ошибка — SenderOpError,
  // её в ответ превращает PATCH.
  const { name, mailboxIds, steps } = validateCampaignDraft(
    {
      name: body.name ?? '',
      mailboxIds: body.mailboxIds ?? [],
      steps: body.steps ?? [],
    },
    // Автосохранение недописанного черновика: править его можно и пустым,
    // отправить — нет (проверки на запуске, startCampaign).
    { partial: body.draft === true },
  );

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
      // Без поля привязку не трогаем: кампанию правят и не из формы.
      ...('projectId' in body ? { project_id: projectIdOf(body.projectId) } : {}),
      ...('clientUserId' in body ? { client_user_id: clientUserIdOf(body.clientUserId) } : {}),
      ...(scopeChanged ? { stoplist_checked_at: null } : {}),
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
  // Привязка к тегам целиком: без поля в теле не трогаем (кампанию правят и не из формы).
  if (Array.isArray(body.tagIds)) await saveCampaignTags(id, body.tagIds.map(String));

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
      if (body.action === 'start' || body.action === 'schedule') {
        const orphanError = await orphanVeDraftError(id);
        if (orphanError) return orphanError;
      }
      if (body.action === 'schedule') {
        // Сверка и при запуске (startCampaign), но о закрытых адресах лучше
        // узнать сейчас, а не когда подойдёт время.
        const stopError = await checkStopListsBeforeStart(id);
        if (stopError) return stopError;
      }
      if (body.action === 'start') {
        // Сколько ящиков взято из папки — экран скажет, откуда они взялись.
        const mailboxesAdded = await fillPoolFromFolder(id);
        await startCampaign(id, { instantlyDb: supabaseInstantly });
        return NextResponse.json({ ok: true, status: 'running', mailboxesAdded });
      }
      if (body.action === 'schedule') {
        // Ящики папки берём сразу: проверка запуска должна увидеть пул сейчас.
        const mailboxesAdded = await fillPoolFromFolder(id);
        await scheduleCampaignStart(id, new Date(String(body.startAt ?? '')));
        return NextResponse.json({ ok: true, mailboxesAdded });
      }
      if (body.action === 'unschedule') {
        await cancelScheduledStart(id);
        return NextResponse.json({ ok: true });
      }
      if (body.action !== 'pause' && body.action !== 'finish') return jsonError('Неизвестное действие', 400);
    } catch (e) {
      if (e instanceof SenderOpError) return jsonError(e.message, e.status);
      throw e;
    }

    if (body.action === 'finish') {
      const { data: target, error: targetError } = await supabaseAdmin
        .from('sender_campaigns').select('source_kind').eq('id', id).maybeSingle();
      if (targetError) return jsonError(targetError.message, 500);
      if (target?.source_kind === 've2') return jsonError(VE2_MANAGED_CAMPAIGN, 409);
    }

    const status = body.action === 'pause' ? 'paused' : 'done';
    const { error } = await supabaseAdmin
      .from('sender_campaigns')
      // Завершённая кампания не должна запуститься по отложенному времени.
      .update({
        status,
        updated_at: new Date().toISOString(),
        ...(status === 'done' ? { scheduled_start_at: null, scheduled_start_error: null } : {}),
      })
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
 *
 * Кампания из автоаутрича: до удаления решаем, что станет с отметками
 * заливки в строках запуска (outreachSender/deletion.ts). Письма уходили —
 * отметки остаются, и эти компании второй раз не зальются; не уходили —
 * отметки снимаются, и заливку можно повторить. В ответе — что вышло
 * (outreach), экран скажет это оператору.
 */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.sender.campaigns.delete' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const { id } = await params;
    const { data: campaign } = await supabaseAdmin
      .from('sender_campaigns')
      .select('id, status, source_kind')
      .eq('id', id)
      .maybeSingle();
    if (!campaign) return jsonError('Кампания не найдена', 404);
    if (campaign.source_kind === 've2') return jsonError(VE2_MANAGED_CAMPAIGN, 409);
    if (String(campaign.status) === 'running') {
      return jsonError('Идущую кампанию удалить нельзя — сначала поставьте на паузу или завершите', 409);
    }

    let outreach: OutreachCampaignDeleteResult | null = null;
    if (campaign.source_kind && campaign.source_kind !== 'manual') {
      try {
        outreach = await releaseOutreachRowsBeforeCampaignDelete(id);
      } catch (e) {
        if (e instanceof SenderOpError) return jsonError(e.message, e.status);
        throw e;
      }
    }

    const { error } = await supabaseAdmin.from('sender_campaigns').delete().eq('id', id);
    if (error) return jsonError(error.message, 500);
    return NextResponse.json(outreach ? { ok: true, outreach } : { ok: true });
  });
}
