import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit, logWarn } from '@/lib/loggerServer';
import { withToolTrace } from '@/lib/toolTrace';
import { requireEngMarket } from '@/lib/hypothesisEngine/apiGuards';
import { readHeEngEmailStatus } from '@/lib/hypothesisEngine/engEmailVerification';
import { sendHeEngVerificationEmail } from '@/lib/hypothesisEngine/engEmailVerificationMail';
import {
  heEngRetryMinutes,
  hitHeEngRateLimit,
  releaseHeEngRateHit,
  type HeEngRateBucket,
  type HeEngRateDecision,
} from '@/lib/hypothesisEngine/engRateLimit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/client/eng-email/resend — «Send a new link»: новая ссылка
 * подтверждения на адрес профиля (не на адрес из тела — тела нет). Прежняя
 * ссылка после этого не работает.
 *
 * Частота: не чаще раза в минуту и не больше 5 в час на пользователя
 * (engRateLimit, общий счёт всех процессов portal; без миграции — память
 * процесса). Считается только ушедшее письмо: попадания записываются до
 * отправки, а при любом другом итоге (почтовый сервер не принял письмо,
 * таблица или ключ недоступны, почта уже подтверждена) возвращаются
 * (releaseHeEngRateHit) — сбой отправки не отнимает у клиента повтор. Ссылка
 * при сбое отправки тоже остаётся прежней (engEmailVerification, issue).
 *
 * Ответы:
 *  - 200 `{ ok: true, status: 'sent', email }`;
 *  - 200 `{ ok: true, status: 'already_verified' }`;
 *  - 200 `{ ok: true, status: 'not_required' }` — сотрудник в ENG-кабинете;
 *  - 429 `{ error, code: 'resend_too_soon', retry_after_seconds }`;
 *  - 503 `{ error, code: 'unavailable' }` — таблицы нет, адреса нет, сбой БД;
 *  - 502 `{ error, code: 'send_failed' }` — почтовый сервер не принял письмо.
 * Демо сюда не доходит: requireClientAuth режет мутации демо (DEMO_READONLY).
 * Скоуп — id пользователя сессии; почему роут вне /api/client/eng — шапка
 * ../confirm/route.ts.
 */

const UNAVAILABLE_TEXT = 'Email confirmation is not available right now. Try again in a few minutes.';
const SEND_FAILED_TEXT = 'We could not send the email. Try again in a few minutes.';

export async function POST(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'client.eng.verify_email.resend' }, async () => {
    const result = await requireClientAuth(req);
    if ('error' in result) return result.error;
    if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

    const { userId } = result.auth;
    const gate = await requireEngMarket(supabaseAdmin, userId);
    if (!gate.ok) return jsonError(gate.failure.message, gate.failure.status);

    const status = await readHeEngEmailStatus(supabaseAdmin, userId);
    if (status.state === 'not_required') return NextResponse.json({ ok: true, status: 'not_required' });
    if (status.state === 'verified') return NextResponse.json({ ok: true, status: 'already_verified' });
    if (status.state === 'error' || status.state === 'table_missing') {
      void logWarn('client.eng.verify_email.resend_unavailable', status.state === 'error' ? status.message : 'table missing', { userId });
      return NextResponse.json({ error: UNAVAILABLE_TEXT, code: 'unavailable' }, { status: 503 });
    }

    // Записанные попадания — чтобы вернуть их, если письмо не уйдёт.
    const db = supabaseAdmin;
    const hits: Array<{ bucket: HeEngRateBucket; decision: HeEngRateDecision }> = [];
    const releaseHits = async () => {
      for (const hit of hits) {
        const failure = await releaseHeEngRateHit(db, hit.bucket, userId, hit.decision);
        if (failure) {
          void logWarn('client.eng.verify_email.rate_release_failed', `resend hit kept: ${failure}`, { userId, bucket: hit.bucket });
        }
      }
    };

    for (const bucket of ['verify_resend_min', 'verify_resend_hour'] as HeEngRateBucket[]) {
      const decision = await hitHeEngRateLimit(supabaseAdmin, bucket, userId);
      if (decision.fallbackReason) {
        void logWarn('client.eng.verify_email.rate_limit_fallback', `rate limit decided in process memory: ${decision.fallbackReason}`, { userId, bucket });
      }
      if (!decision.allowed) {
        // Минутное попадание уже записано, а письма не будет — возвращаем.
        await releaseHits();
        const minutes = heEngRetryMinutes(decision.retryAfterSeconds);
        return NextResponse.json(
          {
            error: `A new link was sent recently. You can send another in about ${minutes} minute${minutes === 1 ? '' : 's'}.`,
            code: 'resend_too_soon',
            retry_after_seconds: decision.retryAfterSeconds,
          },
          { status: 429, headers: { 'Retry-After': String(decision.retryAfterSeconds) } },
        );
      }
      hits.push({ bucket, decision });
    }

    const outcome = await sendHeEngVerificationEmail(supabaseAdmin, { userId, email: status.email });
    if (outcome.kind !== 'sent') await releaseHits();
    switch (outcome.kind) {
      case 'sent':
        void logAudit('client.eng.verify_email.resent', 'ENG email confirmation link re-sent', { userId });
        return NextResponse.json({ ok: true, status: 'sent', email: outcome.email });
      case 'already_verified':
        return NextResponse.json({ ok: true, status: 'already_verified' });
      case 'send_failed':
        void logWarn('client.eng.verify_email.send_failed', outcome.reason, { userId });
        return NextResponse.json({ error: SEND_FAILED_TEXT, code: 'send_failed' }, { status: 502 });
      case 'unavailable':
      case 'error':
        void logWarn('client.eng.verify_email.resend_unavailable', `${outcome.kind}: ${outcome.reason}`, { userId });
        return NextResponse.json({ error: UNAVAILABLE_TEXT, code: 'unavailable' }, { status: 503 });
    }
  });
}
