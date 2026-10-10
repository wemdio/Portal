'use client';

/**
 * Отказы гейта платных шагов (requireEngPaidAccess, lib/hypothesisEngine/
 * engPaidAccess.ts) на экране кабинета — ДЕЙСТВИЕМ, а не «спросите менеджера».
 *
 *  - EngPaidAccessNotice — отказ конкретной кнопки: текст роута (он уже
 *    английский и называет действие) и, у неподтверждённой почты, кнопка
 *    «Send confirmation link» прямо под ним плюс ссылка на страницу
 *    подтверждения. Остальные коды несут действие в самом тексте: лимит
 *    стартов исследования — «после полуночи UTC», потолок — Support, лимит
 *    проектов — удалить ненужный проект или Support (под текстом — ссылка на
 *    список проектов, где у каждого есть «Delete project»; при заданном
 *    потолке расхода удаление закрыто — только Support, без ссылки),
 *    'unavailable' — «обновите страницу». У профиля без адреса кнопки
 *    отправки нет — текст ведёт в Support.
 *  - EngSupportText — слово «Support» в тексте кабинета ссылкой на чат
 *    поддержки (/client/support, пункт «Support» меню ENG-кабинета). Им
 *    печатаются и отказ кнопки, и полоса ниже.
 *  - EngVerifyEmailBanner — та же кнопка ДО нажатия: полоса над экраном,
 *    пока почта не подтверждена (GET /api/client/eng-email/status). Не
 *    прочитали статус, почта подтверждена или проверка этому аккаунту не нужна
 *    — полосы нет: выдумывать состояние экран не должен.
 *
 * Тексты отправки — те же, что у страницы /client/eng/verify-email: ссылка
 * одноразовая и живёт 48 часов (engEmailVerification.ts).
 */

import Link from 'next/link';
import type { Route } from 'next';
import { Fragment, useCallback, useEffect, useState } from 'react';
import { Mail } from 'lucide-react';
import {
  fetchEngEmailStatus,
  resendEngEmailLink,
  type EngEmailStatus,
  type EngPaidAccessError,
} from './api-client';
import { EngSpinner, fmtDate } from './ui';

const VERIFY_PAGE = '/client/eng/verify-email' as Route;
const SUPPORT_PAGE = '/client/support' as Route;
/** Список проектов без авто-перехода на Command Center (EngProjectsList, ?list=1). */
const PROJECTS_LIST = '/client/eng?list=1' as Route;

/** «Support» отдельным словом с заглавной — имя пункта меню. */
const SUPPORT_WORD_RE = /\bSupport\b/;

/**
 * Текст кабинета, в котором каждое слово «Support» — ссылка на чат поддержки.
 * Тексты отказов приходят строками (роуты, справочник кодов), поэтому ссылку
 * ставит экран, а не текст. Строчное «support» («not supported») и слова,
 * которые с него начинаются, не трогаются.
 */
export function EngSupportText({ text }: { text: string }) {
  const parts = text.split(SUPPORT_WORD_RE);
  if (parts.length === 1) return <>{text}</>;
  return (
    <>
      {parts.map((part, i) => (
        <Fragment key={i}>
          {i > 0 && (
            <Link href={SUPPORT_PAGE} prefetch={false} className="underline">
              Support
            </Link>
          )}
          {part}
        </Fragment>
      ))}
    </>
  );
}

/** Отправка ссылки и строка итога под кнопкой. `onDone` — перечитать статус. */
function useResendLink(onDone?: () => void) {
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const send = useCallback(async () => {
    setSending(true);
    setNote(null);
    const result = await resendEngEmailLink();
    if (result.kind === 'sent') {
      setNote({
        tone: 'ok',
        text: `We sent a new link to ${result.email ?? 'your email'}. It works once and expires in 48 hours.`,
      });
      // Перечитать статус: полоса над экраном иначе описывала бы прежнюю,
      // уже заменённую ссылку (дату её отправки или «истекла»).
      onDone?.();
    } else if (result.kind === 'not_needed') {
      // Роут: почта уже подтверждена либо этому аккаунту не нужна — оба
      // значат одно: шаг, который отказал, можно повторить.
      setNote({ tone: 'ok', text: 'No confirmation is needed any more — try again.' });
      onDone?.();
    } else {
      setNote({ tone: 'error', text: result.text });
    }
    setSending(false);
  }, [onDone]);
  return { sending, note, send };
}

function ResendControls({ onDone }: { onDone?: () => void }) {
  const { sending, note, send } = useResendLink(onDone);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void send()}
          disabled={sending}
          className="ds-btn-secondary inline-flex items-center gap-1.5 text-[11px]"
        >
          {sending ? <EngSpinner className="h-3 w-3" /> : <Mail className="h-3 w-3" />}
          Send confirmation link
        </button>
        <Link href={VERIFY_PAGE} prefetch={false} className="text-[11px] underline" style={{ color: 'var(--cp-text-m)' }}>
          Email confirmation
        </Link>
      </div>
      {note && (
        <span className="text-[11px]" style={{ color: note.tone === 'ok' ? 'var(--cp-text-m)' : 'var(--cp-red)' }}>
          {note.text}
        </span>
      )}
    </div>
  );
}

/**
 * Отказ гейта у кнопки: текст роута и действие (у почты — отправка ссылки, у
 * лимита проектов — ссылка на список проектов, где их удаляют).
 * `onProjectsList` — отказ показан на самом списке проектов, ссылка на него
 * не нужна. Действия нет, когда оно не сработает: у профиля без адреса
 * (`emailMissing` — текст ведёт в Support) и когда удаление проектов закрыто
 * потолком расхода (`projectDeleteAvailable` false — текст тоже ведёт в
 * Support).
 */
export function EngPaidAccessNotice({
  refusal,
  onProjectsList = false,
}: {
  refusal: EngPaidAccessError;
  onProjectsList?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2 text-sm" style={{ color: 'var(--cp-red)' }}>
      <span>
        <EngSupportText text={refusal.message} />
      </span>
      {refusal.code === 'email_not_verified' && !refusal.emailMissing && <ResendControls />}
      {refusal.code === 'project_limit' && refusal.projectDeleteAvailable && !onProjectsList && (
        <Link href={PROJECTS_LIST} prefetch={false} className="text-[11px] underline" style={{ color: 'var(--cp-text-m)' }}>
          Open your projects to delete one
        </Link>
      )}
    </div>
  );
}

/** Почему действия кабинета ждут подтверждения — одной фразой для полосы. */
const BANNER_HEAD = 'Confirm your email — until then research, outreach and launches do not start.';

/**
 * Полоса «подтвердите почту» над экраном кабинета. Одно чтение статуса при
 * появлении экрана и после «уже подтверждена»; сама не опрашивает.
 */
export function EngVerifyEmailBanner() {
  const [status, setStatus] = useState<EngEmailStatus | null>(null);
  const load = useCallback(async () => {
    setStatus(await fetchEngEmailStatus());
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (status?.state !== 'pending') return null;
  const detail =
    status.email === null
      ? 'Your account has no email address on file, so we cannot send a confirmation link. Contact Support.'
      : status.last_sent_at
        ? `We sent a confirmation link to ${status.email} on ${fmtDate(status.last_sent_at)} — open it, or send a new link.`
        : status.expired_link_sent_at
          ? `The link we sent to ${status.email} on ${fmtDate(status.expired_link_sent_at)} has expired — send a new link.`
          : `Send a confirmation link to ${status.email} and open it.`;
  return (
    <div className="ds-card p-3 flex flex-col gap-2 text-xs" style={{ color: 'var(--cp-amber)' }}>
      <span>
        {BANNER_HEAD} <EngSupportText text={detail} />
      </span>
      {status.email !== null && <ResendControls onDone={() => void load()} />}
    </div>
  );
}
