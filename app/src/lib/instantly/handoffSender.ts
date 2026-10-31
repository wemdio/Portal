import type { supabaseInstantly } from '@/lib/supabaseInstantly';
import * as instantly from './client';
import { computeReplyAllCc, mergeCcLists } from '@/lib/clientCampaignReplies/participants';
import { isNotPartOfCampaignError } from '@/lib/instantly/notPartOfCampaign';
import { textToReplyHtml } from '@/lib/clientCampaignReplies/bodyHtml';
import { logError } from '@/lib/loggerServer';
import { randomUUID } from 'node:crypto';
import { InstantlyApiError } from './errors';

/**
 * Общая отправка передачи лида клиенту: и TG-кнопка (webhook), и полный авто
 * (worker при projects.handoff_auto_send=ON). Reply в тред лида + клиент в CC;
 * для Others-письма (вне кампании) — fallback на test-email (лид+клиент в To).
 * Трекинг в client_forwarded_leads, статус pending → sent/failed.
 */

type InstantlyDb = NonNullable<typeof supabaseInstantly>;

// Rollout marker for rows created while the durable `auto_send` snapshot
// column is not available yet. It survives a failed send and lets recovery
// distinguish an automatic handoff from an old manual pending row after the
// migration backfills `auto_send=false`.
export const HANDOFF_AUTO_SEND_MARKER = '[auto_send]';

interface SendAttempt {
  version: 1;
  phase: 'ready' | 'claimed' | 'request_started' | 'unknown' | 'refused' | 'confirmed';
  id?: string;
  via?: 'reply' | 'test';
  claimed_at?: string;
  request_started_at?: string;
  confirmed_at?: string;
  provider_id?: string;
  reply_all_cc?: string[];
  sent_by_telegram_id?: number;
  error?: { name: string; code?: string; http_status?: number };
}

export interface PendingHandoffRow {
  id: string;
  qualification_id: string;
  campaign_id: string | null;
  draft_text: string;
  reply_to_uuid: string;
  eaccount: string;
  client_email: string;
  responsible_user_id: string | null;
  auto_send?: boolean;
  error_message?: string | null;
  edit_text?: string | null;
  status?: string;
  manual_send_claimed_at?: string | null;
  send_attempt?: SendAttempt | null;
}

export type HandoffSendResult =
  | { ok: true; via: 'reply' | 'test'; replyAllCc: string[]; publicationPending?: true }
  | { ok: false; error: string; outcome?: 'not_sent' | 'unknown' | 'in_progress'; retryable?: boolean };

const UNKNOWN_SEND = 'Результат отправки неизвестен. Повтор отключён: сначала проверьте исходящее письмо в Instantly.';
const notSent = (error: string, retryable = true): HandoffSendResult => ({ ok: false, error, outcome: 'not_sent', retryable });

// Deliberately exclude bodies, URLs and raw provider messages from the ledger.
function errorEvidence(error: unknown): NonNullable<SendAttempt['error']> {
  const e = error as { name?: string; cause?: { code?: string }; code?: string } | null;
  const code = e?.cause?.code ?? e?.code;
  return {
    name: typeof e?.name === 'string' ? e.name.slice(0, 80) : 'Error',
    ...(typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? { code: code.slice(0, 80) } : {}),
    ...(error instanceof InstantlyApiError ? { http_status: error.status } : {}),
  };
}

function buildReplySubject(subject?: string | null): string {
  const t = subject?.trim();
  if (!t) return 'Re:';
  return /^re:/i.test(t) ? t : `Re: ${t}`;
}

export async function sendHandoffNow(
  db: InstantlyDb,
  pending: PendingHandoffRow,
  opts: { sentByTelegramId?: number | null; editToken?: string } = {},
): Promise<HandoffSendResult> {
  // Never trust a queued snapshot: another process/click may already have sent.
  const requestedEditText = pending.edit_text;
  try {
    const fresh = await db.from('instantly_pending_handoffs').select('*').eq('id', pending.id).maybeSingle();
    if (fresh.error || !fresh.data) return notSent('Не удалось проверить передачу; новый запрос отправки не выполнялся');
    pending = fresh.data as PendingHandoffRow;
  } catch {
    return notSent('Не удалось проверить передачу; новый запрос отправки не выполнялся');
  }
  if (pending.status === 'sent') {
    return { ok: true, via: pending.send_attempt?.via ?? 'reply', replyAllCc: pending.send_attempt?.reply_all_cc ?? [] };
  }
  if (pending.status === 'rejected') return notSent('Передача отклонена специалистом', false);
  if (pending.send_attempt?.phase === 'refused') return notSent('Instantly отклонил запрос отправки. Нужна проверка причины; повтор отключён.', false);
  const manual = opts.sentByTelegramId != null;
  const automatic = pending.auto_send === true || pending.error_message?.startsWith(HANDOFF_AUTO_SEND_MARKER) === true;
  if (manual ? automatic || pending.auto_send !== false : !automatic) {
    return notSent('Режим передачи изменился; отправка недоступна', false);
  }
  const ready = pending.send_attempt?.version === 1 && pending.send_attempt.phase === 'ready';
  const activePhase = pending.send_attempt?.phase === 'claimed' || pending.send_attempt?.phase === 'request_started';
  const activeSince = Date.parse(pending.send_attempt?.request_started_at ?? pending.send_attempt?.claimed_at ?? '');
  if (pending.status === 'pending' && activePhase && Number.isFinite(activeSince) && Date.now() - activeSince < 5 * 60_000) {
    return { ok: false, error: 'Передача уже выполняется. Не нажимайте повторно.', outcome: 'in_progress', retryable: true };
  }
  // Legacy automatic pending is ALSO ambiguous (old process could die after
  // POST). Only newly materialized ready rows may start unattended delivery.
  if (pending.status !== 'pending' || pending.manual_send_claimed_at ||
    (pending.send_attempt != null && !ready) || (!manual && !ready)) {
    return { ok: false, error: UNKNOWN_SEND, outcome: 'unknown', retryable: false };
  }
  const { data: qual, error: qualificationError } = await Promise.resolve(db
    .from('instantly_lead_qualifications')
    .select('reply_subject, lead_email, lead_name, company_name, campaign_name, reply_body, last_outbound_preview, reply_timestamp, ai_reason, queue_archived_at')
    .eq('id', pending.qualification_id)
    .maybeSingle()).catch(() => ({ data: null, error: { message: 'qualification lookup unavailable' } }));
  // Both an old Telegram button and a previously queued automatic handoff
  // reach this shared sender. Never resume an archived reply, even if its
  // original business status/draft was deliberately retained for audit.
  if (qualificationError || !qual) {
    return notSent('Не удалось проверить состояние квалификации; передача не выполнена');
  }
  if (qual.queue_archived_at != null) {
    return notSent('Ответ снят с обработки и сохранён в архиве; передача недоступна', false);
  }

  // «Ответить всем»: к адресу клиента (handoff CC) добавляем участников, которых
  // лид завёл в тред (То+CC оригинала, кроме нашего ящика и самого лида).
  // getEmail best-effort: не достали оригинал → шлём только клиенту.
  let replyAllCc: string[] = [];
  try {
    const original = await instantly.getEmail(pending.reply_to_uuid);
    replyAllCc = computeReplyAllCc(original, {
      eaccount: pending.eaccount,
      leadEmail: (qual?.lead_email as string | null) ?? null,
    });
  } catch (err) {
    await logError('instantly.handoff.replyall_fetch_failed', err, {
      pendingId: pending.id,
      reply_to_uuid: pending.reply_to_uuid,
    }).catch(() => {});
  }
  const ccList = mergeCcLists(replyAllCc, (pending.client_email ?? '').split(','));

  // История переписки в теле: клиент в копии — НОВЫЙ в треде, ему доходит только
  // это письмо, поэтому предыдущий диалог цитируем прямо в тело.
  const draftText = opts.editToken ? requestedEditText : pending.draft_text;
  if (!draftText?.trim()) return notSent('Пустой черновик', false);
  const history = ((qual?.reply_body as string | null) ?? '').trim();
  let bodyText = draftText;
  if (history) {
    const who = (qual?.lead_name as string | null) || (qual?.lead_email as string | null) || 'Лид';
    // Контейнер в UTC — без явной таймзоны в шапке цитаты было бы «14:01»
    // вместо «17:01», которые лид видел у себя в письме.
    const when = qual?.reply_timestamp
      ? new Date(qual.reply_timestamp as string).toLocaleString('ru-RU', {
          timeZone: 'Europe/Moscow',
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })
      : '';
    const header = [when, who].filter(Boolean).join(', ');
    const quoted = history.split('\n').map((l) => `> ${l}`).join('\n');
    bodyText = `${draftText}\n\n${header ? `${header} писал(а):\n` : ''}${quoted}`;
  }

  // Reply в тред; Others-письма не принадлежат кампании — Instantly отвечает 400
  // «not part of an Instantly campaign» и на reply, и на forward (проверено
  // живьём 27.07), для них fallback — тест-эндпоинт (лид и клиент в To,
  // видимость адресов та же, что у cc). Плата: без сущности в Unibox.
  let via: 'reply' | 'test' = 'reply';
  let attempt: SendAttempt = {
    version: 1, id: randomUUID(), phase: 'claimed', via,
    claimed_at: new Date().toISOString(), reply_all_cc: replyAllCc,
    ...(manual ? { sent_by_telegram_id: opts.sentByTelegramId! } : {}),
  };
  let claimed = false;
  let claimAttempted = false;
  let requestStarted = false;
  let providerId: string | undefined;
  const saveAttempt = async (patch: Record<string, unknown>): Promise<boolean> => {
    // Only retry idempotent DB writes, never an email POST. The attempt token
    // prevents stale writers from changing another attempt or clearing its lock.
    for (let i = 0; i < 3; i++) {
      try {
        const saved = await db.from('instantly_pending_handoffs').update(patch)
          .eq('id', pending.id).eq('send_attempt->>id', attempt.id!)
          .select('id').maybeSingle();
        if (!saved.error && saved.data) return true;
      } catch { /* response can be lost after COMMIT */ }
    }
    return false;
  };
  const beforeRequest = async () => {
    attempt = { ...attempt, phase: 'request_started', via, request_started_at: new Date().toISOString() };
    if (!await saveAttempt({ send_attempt: attempt })) throw new Error('handoff_attempt_not_persisted');
    requestStarted = true;
  };
  const requestOptions = { onRequestAttempt: beforeRequest, timeoutIncludesBody: true, consumer: 'lead-handoff' };
  const resetUnsent = () => saveAttempt({
    send_attempt: { version: 1, phase: 'ready' },
    ...(manual ? { manual_send_claimed_at: null } : {}),
    // Cancelling the editor after a pre-POST failure must keep the ORIGINAL
    // draft. The proposed edit stays in edit_text for an explicit later send.
    ...(opts.editToken ? { draft_text: pending.draft_text } : {}),
  });
  try {
    // The source fetch above can take time. Re-check the archive boundary as
    // close to the external side effect as possible; a DB failure is not a
    // reason to send using the earlier cached row.
    const { data: current, error: currentError } = await db
      .from('instantly_lead_qualifications')
      .select('id, queue_archived_at')
      .eq('id', pending.qualification_id)
      .maybeSingle();
    if (currentError || !current) {
      return notSent('Не удалось повторно проверить состояние квалификации; передача не выполнена');
    }
    if (current.queue_archived_at != null) {
      return notSent('Ответ снят с обработки и сохранён в архиве; передача недоступна', false);
    }
    // Atomic for BOTH modes; preserve all manual edit/session predicates.
    let claim = db.from('instantly_pending_handoffs').update({
      send_attempt: attempt,
      ...(manual ? { manual_send_claimed_at: attempt.claimed_at } : {}),
      ...(opts.editToken ? { draft_text: requestedEditText } : {}),
    }).eq('id', pending.id).eq('status', 'pending');
    claim = ready ? claim.eq('send_attempt->>phase', 'ready') : claim.is('send_attempt', null);
    if (manual) {
      claim = claim.eq('auto_send', false).is('manual_send_claimed_at', null);
      if (opts.editToken) {
        claim = claim.eq('edit_token', opts.editToken).eq('edit_user_id', opts.sentByTelegramId!)
          .eq('edit_text', requestedEditText!).gt('edit_expires_at', new Date().toISOString());
      } else claim = claim.is('edit_token', null).eq('draft_text', pending.draft_text);
    } else {
      claim = pending.auto_send === true ? claim.eq('auto_send', true) : claim.eq('error_message', pending.error_message!);
    }
    claimAttempted = true;
    const claimResult = await claim.select('id').maybeSingle();
    if (claimResult.error) return notSent('Не удалось подтвердить сохранение начала передачи. Нужна проверка БД и миграции handoff_send_attempt; новый запрос отправки не выполнялся', false);
    if (!claimResult.data) return { ok: false, error: 'Передача уже начата или черновик изменён. Используйте актуальные кнопки.', outcome: 'in_progress', retryable: true };
    claimed = true;
    const replySubject = buildReplySubject((qual?.reply_subject as string | null) ?? null);
    const replyHtml = textToReplyHtml(bodyText);
    try {
      const receipt = await instantly.replyToEmail({
        reply_to_uuid: pending.reply_to_uuid,
        eaccount: pending.eaccount,
        subject: replySubject,
        // HTML с <br> сохраняет переносы строк (text-only с \n схлопывается
        // «простынёй» — жалоба спеца на Чизмоле). text — plain-text fallback.
        body: { html: replyHtml, text: bodyText },
        ...(ccList.length ? { cc_address_email_list: ccList.join(', ') } : {}),
      }, requestOptions);
      if (typeof receipt?.id !== 'string' || !receipt.id.trim()) throw new Error('handoff_reply_receipt_missing');
      providerId = receipt.id;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const leadEmail = ((qual?.lead_email as string | null) ?? '').trim();
      // A text match in an arbitrary transport exception is not proof of a
      // refusal. Fallback is allowed ONLY on the provider's explicit HTTP 400.
      if (!(err instanceof InstantlyApiError) || err.status !== 400 || !isNotPartOfCampaignError(msg) || !leadEmail) throw err;
      via = 'test';
      requestStarted = false; // the reply was definitively refused
      await instantly.sendTestEmail({
        eaccount: pending.eaccount,
        // Дедуп: при патологическом client_email == lead_email To не дублируется.
        to_address_email_list: [...new Set([leadEmail, ...ccList])].join(', '),
        subject: replySubject,
        body: { html: replyHtml },
      }, requestOptions);
    }
  } catch (err) {
    const evidence = errorEvidence(err);
    await logError('instantly.handoff.send_failed', new Error('Handoff send did not complete'), {
      pendingId: pending.id, attemptId: attempt.id, via, requestStarted, ...evidence,
    }).catch(() => {});
    // Proven pre-POST failure is safe to retry. If resetting its own claim
    // cannot be confirmed, fail closed instead of promising a usable button.
    if (!requestStarted) {
      if (claimAttempted && !claimed) return notSent('Новый запрос отправки не выполнялся, но состояние блокировки неизвестно. Нужна проверка администратора.', false);
      const reset = !claimed || await resetUnsent();
      return notSent(reset ? 'Запрос отправки не выполнялся. Попробуйте позже.' : 'Письмо не отправлено, но блокировку передачи снять не удалось. Нужна проверка администратора.', reset);
    }
    // Explicit provider refusals are different from an unknown network outcome.
    // Do not silently retry permanent validation/auth errors either. HTTP 408,
    // conflict and 5xx remain ambiguous, even if an error body was received.
    if (err instanceof InstantlyApiError && [400, 401, 403, 404, 422, 429].includes(err.status)) {
      if (err.status === 429) {
        const reset = await resetUnsent();
        return notSent('Instantly отклонил запрос по лимиту. Письмо не отправлено.', reset);
      }
      attempt = { ...attempt, phase: 'refused', error: evidence };
      await saveAttempt({ status: 'failed', send_attempt: attempt,
        error_message: `${automatic ? `${HANDOFF_AUTO_SEND_MARKER} ` : ''}Instantly rejected handoff: HTTP ${err.status}` });
      return notSent(`Instantly отклонил запрос отправки (HTTP ${err.status}). Нужна проверка причины; повтор отключён.`, false);
    }
    attempt = { ...attempt, phase: 'unknown', error: evidence };
    await saveAttempt({ status: 'failed', send_attempt: attempt,
      error_message: `${automatic ? `${HANDOFF_AUTO_SEND_MARKER} ` : ''}${UNKNOWN_SEND}` });
    return { ok: false, error: UNKNOWN_SEND, outcome: 'unknown', retryable: false };
  }

  attempt = { ...attempt, phase: 'confirmed', via, confirmed_at: new Date().toISOString(),
    ...(providerId ? { provider_id: providerId } : {}) };
  const sentPatch = {
    status: 'sent',
    error_message: null,
    ...(opts.sentByTelegramId != null ? { sent_by_telegram_id: opts.sentByTelegramId } : {}),
    sent_at: attempt.confirmed_at,
    send_attempt: attempt,
  };
  const publicationPending = !await saveAttempt(sentPatch);
  if (publicationPending) {
    // Preserve the receipt in runtime logs too: the application-log DB may be
    // unavailable together with the handoff DB. No body/addresses/keys here.
    console.error('instantly.handoff.confirmation_not_saved', {
      pendingId: pending.id, attemptId: attempt.id, via, providerId, confirmedAt: attempt.confirmed_at,
    });
    await logError('instantly.handoff.confirmation_not_saved', new Error('Provider accepted handoff; DB confirmation unavailable'), {
      pendingId: pending.id, attemptId: attempt.id, via, providerId, confirmedAt: attempt.confirmed_at,
    }).catch(() => {});
  }

  // Best-effort tracking (mirrors the manual forward-email flow).
  try {
    await db.from('client_forwarded_leads').insert({
      qualification_id: pending.qualification_id,
      forwarded_by: pending.responsible_user_id,
      campaign_id: pending.campaign_id,
      campaign_name: qual?.campaign_name ?? null,
      lead_email: qual?.lead_email ?? null,
      lead_name: qual?.lead_name ?? null,
      company_name: qual?.company_name ?? null,
      reply_subject: qual?.reply_subject ?? null,
      reply_body: qual?.reply_body ?? null,
      last_outbound_preview: qual?.last_outbound_preview ?? null,
      reply_timestamp: qual?.reply_timestamp ?? null,
      status: 'lead',
      ai_reason: qual?.ai_reason ?? null,
      forwarded_via: via === 'test' ? 'handoff-auto-test' : 'handoff-auto',
      client_email: pending.client_email,
    });
  } catch {
    /* tracking is best-effort */
  }

  return { ok: true, via, replyAllCc, ...(publicationPending ? { publicationPending: true } : {}) };
}
