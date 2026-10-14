'use client';

/**
 * /client/eng/verify-email — подтверждение почты ENG-клиента: статус и кнопка
 * «Send a new link». Ссылку из письма обслуживает не эта страница, а
 * GET /api/client/eng-email/confirm (без входа, см. его шапку); сюда ведут её
 * кнопки «Send a new link» (просрочена, заменена, повреждена).
 *
 * Данные — GET /api/client/eng-email/status, отправка —
 * POST /api/client/eng-email/resend. Тексты ответов роутов уже
 * английские; engSafeText — второй замок, как у остальных экранов кабинета.
 */

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { authFetch } from '@/lib/authFetch';
import { engSafeText } from '@/components/client-eng/engText';
import { EngSupportText } from '@/components/client-eng/EngPaidAccess';
import { EngCard, EngSpinner, fmtDate } from '@/components/client-eng/ui';

type StatusState = 'verified' | 'pending' | 'not_required' | 'unavailable';

interface StatusResponse {
  state: StatusState;
  email: string | null;
  /** Ссылка, которая ещё действует (роут считает срок своими часами). */
  last_sent_at: string | null;
  /** Ссылка, срок которой вышел; задано не больше одного из двух полей. */
  expired_link_sent_at?: string | null;
}

const UNLOCKS = 'research, contact collection, letters and launches';

function isStatus(raw: unknown): raw is StatusResponse {
  const s = (raw as { state?: unknown } | null)?.state;
  return s === 'verified' || s === 'pending' || s === 'not_required' || s === 'unavailable';
}

export default function EngVerifyEmailPage() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendNote, setSendNote] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await authFetch('/api/client/eng-email/status');
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok || !isStatus(body)) {
        setLoadError(
          res.status === 401
            ? 'Your session has expired. Sign in again to see your email status.'
            : 'Could not load your email status. Refresh the page.',
        );
        return;
      }
      setLoadError(null);
      setStatus(body);
    } catch {
      setLoadError('Could not load your email status. Refresh the page.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onResend = async () => {
    setSending(true);
    setSendNote(null);
    try {
      const res = await authFetch('/api/client/eng-email/resend', { method: 'POST', body: '{}' });
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; status?: string; email?: string; error?: string }
        | null;
      if (res.ok && body?.status === 'sent') {
        setSendNote({
          tone: 'ok',
          text: `We sent a new link to ${body.email ?? 'your email'}. It works once and expires in 48 hours.`,
        });
        await load();
        return;
      }
      if (res.ok && (body?.status === 'already_verified' || body?.status === 'not_required')) {
        await load();
        return;
      }
      const routeText = typeof body?.error === 'string' ? engSafeText(body.error) : null;
      setSendNote({ tone: 'error', text: routeText ?? 'Could not send the link. Try again in a few minutes.' });
    } catch {
      setSendNote({ tone: 'error', text: 'Could not send the link. Try again in a few minutes.' });
    } finally {
      setSending(false);
    }
  };

  let title = 'Confirm your email';
  let body: React.ReactNode = null;
  let canResend = false;
  if (status?.state === 'verified') {
    title = 'Your email is confirmed';
    body = `${status.email ?? 'Your email address'} is confirmed. ${UNLOCKS[0].toUpperCase()}${UNLOCKS.slice(1)} no longer wait for it.`;
  } else if (status?.state === 'not_required') {
    title = 'No confirmation needed';
    body = 'This account does not need to confirm its email.';
  } else if (status?.state === 'unavailable') {
    title = 'Email confirmation';
    body = 'We cannot check your email confirmation right now. Refresh the page later.';
  } else if (status?.state === 'pending' && status.email === null) {
    // Адреса у профиля нет — ссылку отправить некуда (роут ответил бы 503).
    body = 'Your account has no email address on file, so we cannot send a confirmation link. Contact Support.';
  } else if (status?.state === 'pending') {
    canResend = true;
    body = status.last_sent_at
      ? `We sent a confirmation link to ${status.email} on ${fmtDate(status.last_sent_at)}. Open it to unlock ${UNLOCKS}. If you cannot find it, check spam or send a new link.`
      : status.expired_link_sent_at
        ? `The link we sent to ${status.email} on ${fmtDate(status.expired_link_sent_at)} has expired — send a new link and open it to unlock ${UNLOCKS}.`
        : `Send a confirmation link to ${status.email} and open it to unlock ${UNLOCKS}.`;
  }

  return (
    <div className="mx-auto max-w-2xl">
      <header className="mb-6 sm:mb-8">
        <h1 className="text-xl sm:text-2xl font-bold m-0" style={{ color: 'var(--cp-paper)' }}>
          {title}
        </h1>
      </header>
      <EngCard>
        {loadError ? (
          <p className="text-sm m-0" style={{ color: 'var(--cp-red)' }}>{loadError}</p>
        ) : !status ? (
          <EngSpinner />
        ) : (
          <>
            <p className="text-sm m-0" style={{ color: 'var(--cp-paper-mute)' }}>
              {/* «Contact Support» (адреса нет) — ссылкой на чат поддержки. */}
              {typeof body === 'string' ? <EngSupportText text={body} /> : body}
            </p>
            {canResend && (
              <button
                type="button"
                onClick={() => void onResend()}
                disabled={sending}
                className="mt-4 rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50"
                style={{ background: 'var(--cp-paper)', color: 'var(--cp-bg)' }}
              >
                {sending
                  ? 'Sending…'
                  : status.state === 'pending' && (status.last_sent_at || status.expired_link_sent_at)
                    ? 'Send a new link'
                    : 'Send confirmation link'}
              </button>
            )}
            {sendNote && (
              <p
                className="mt-3 text-sm m-0"
                style={{ color: sendNote.tone === 'ok' ? 'var(--cp-paper-mute)' : 'var(--cp-red)' }}
              >
                {sendNote.text}
              </p>
            )}
            <p className="mt-5 text-sm m-0">
              <Link href="/client/eng" className="underline" style={{ color: 'var(--cp-text-m)' }}>
                Back to Outreach
              </Link>
            </p>
          </>
        )}
      </EngCard>
    </div>
  );
}
