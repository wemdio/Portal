'use client';

/**
 * Раздел «Английские клиенты» — карточка клиента (/admin/eng-clients/[id]).
 * Данные — GET /api/admin/eng-clients/[id] (engAdminView.readHeEngAdminCard);
 * опроса нет: «Обновить» перечитывает, «Обновить статусы кампаний» — то же с
 * фоновым живым чтением статусов (?refresh=1).
 *
 * Действия — существующие роуты сотрудника:
 *  - «Включить / Выключить отправку», «Выключить ещё раз / доставить паузу» —
 *    POST api/admin/users/[id]/eng-sending (включение у заблокированного роут
 *    отказывает сам; кнопка выключена с подсказкой «Сначала разблокируйте»;
 *    у выключенной сотрудником — чип «Отправка выключена сотрудником» —
 *    включение переспрашивает);
 *  - «Заблокировать», «Заблокировать ещё раз / доставить остановку»,
 *    «Разблокировать» — POST api/admin/users/[id]/block (ветка английского
 *    кабинета: полная остановка / сначала та же остановка, потом только вход —
 *    бан снимается, только если она подтверждена; строки отчёта — из ответа);
 *  - «Сменить пароль» — POST api/admin/users/[id]/password (письма клиенту нет);
 *  - «Удалить аккаунт» — только у аккаунта без единого проекта (DELETE
 *    api/admin/users/[id]; с проектом роут отказывает и сам).
 * Не предлагаются: роль, инструменты, тариф RU, доступ к RU-кампаниям, бриф и
 * пресет клиента (пресет английского клиента ведёт пул ящиков —
 * engSendingPreset), правка имени и почты.
 */

import Link from 'next/link';
import type { Route } from 'next';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, RefreshCw } from 'lucide-react';
import { useIsTma } from '@/lib/useIsTma';
import type { HeEngBlockLine } from '@/lib/hypothesisEngine/engAccountBlockMarker';
import type { HeEngAdminCardProject, HeEngAdminMarket } from '@/lib/hypothesisEngine/engAdminView';
import {
  deleteEngAccount,
  fetchEngClientCard,
  postEngBlock,
  postEngPassword,
  postEngSending,
  type EngClientCardResponse,
} from './api';
import { EngBlockReport } from './EngBlockReport';
import {
  AUTO_LAUNCH_EXTRA_LABELS,
  MISSING_SOURCE_LABELS,
  REFILL_BEFORE_LABELS,
  SENDING_BEFORE_LABELS,
  SENDING_SUMMARY_LABELS,
  attentionText,
  autoLaunchCodeLabel,
  autoLaunchStateLabel,
  campaignStatusLabel,
  clientEmailLabel,
  engSendingAllowed,
  engSendingResultText,
  engSendingTitle,
  fmtDateTime,
  fmtNum,
  jobStageLabel,
  jobStatusLabel,
  leakText,
  projectStatusLabel,
  readErrorLabel,
  startErrorLabel,
} from './labels';

/** Итог последнего действия на карточке. */
interface ActionResult {
  title: string;
  complete: boolean;
  lines: HeEngBlockLine[];
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
      <h2 className="mb-3 text-base font-semibold text-gray-900">{title}</h2>
      {children}
    </section>
  );
}

function Pill({ tone, children }: { tone: 'green' | 'red' | 'amber' | 'grey' | 'blue'; children: ReactNode }) {
  const cls = {
    green: 'bg-green-50 text-green-700 border-green-200',
    red: 'bg-red-50 text-red-700 border-red-200',
    amber: 'bg-amber-50 text-amber-800 border-amber-200',
    grey: 'bg-gray-100 text-gray-600 border-gray-200',
    blue: 'bg-blue-50 text-blue-700 border-blue-200',
  }[tone];
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${cls}`}>{children}</span>;
}

function generatePassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';
  let out = '';
  for (let i = 0; i < 14; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)] ?? '';
  return out;
}

function refillText(r: HeEngAdminCardProject['refill']): string {
  switch (r.state) {
    case 'on':
      return 'включён';
    case 'off':
      return 'выключен';
    case 'paused':
      return `на паузе${r.reason ? `: ${r.reason}` : ''}${r.paused_at ? ` (с ${fmtDateTime(r.paused_at)})` : ''}`;
    case 'none':
      return 'не настраивался';
  }
}

/** Срок проверки дальше года от последней записи строки — это «парковка», а не проверка. */
const PARKED_AFTER_MS = 365 * 24 * 60 * 60_000;

/**
 * Хвост строки автозапуска про следующую проверку. 'held account_blocked'
 * тик сам не берёт никогда (срок через ~10 лет, engAutoLaunch
 * ACCOUNT_BLOCKED_PARK_MIN) — даты не печатаем.
 */
function nextCheckText(al: NonNullable<HeEngAdminMarket['auto_launch']>): string {
  if (al.state !== 'waiting' && al.state !== 'held') return '';
  if (al.state === 'held' && al.code === 'account_blocked') {
    return '; сама не перепроверяется — продолжит только нажатие клиентом «Launch»';
  }
  if (!al.next_at) return '';
  const next = Date.parse(al.next_at);
  const written = Date.parse(al.updated_at ?? '');
  if (Number.isFinite(next) && Number.isFinite(written) && next - written > PARKED_AFTER_MS) return '; сама не перепроверяется';
  return `; следующая проверка ${fmtDateTime(al.next_at)}`;
}

function MarketRow({ market }: { market: HeEngAdminMarket }) {
  const al = market.auto_launch;
  return (
    <li className="rounded-lg border border-gray-100 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-medium text-gray-900">{market.name || 'Без названия'}</p>
        {market.selected ? <Pill tone="blue">выбран</Pill> : <Pill tone="grey">не выбран</Pill>}
        {market.launched_at ? <Pill tone="green">запущен {fmtDateTime(market.launched_at)}</Pill> : null}
        {market.summary ? <Pill tone="grey">{SENDING_SUMMARY_LABELS[market.summary.state] ?? market.summary.state}</Pill> : null}
      </div>
      <div className="mt-1 space-y-0.5 text-sm text-gray-600">
        {al ? (
          <p>
            Автозапуск: {autoLaunchStateLabel(al.state)}
            {al.code ? ` — ${autoLaunchCodeLabel(al.code)}` : ''}
            {al.state === 'running' ? (al.lease_live ? ' (идёт сейчас)' : ' (попытка брошена — аренда истекла)') : ''}
            {nextCheckText(al)}
            {al.attempts > 0 ? `; попыток ${al.attempts}` : ''}
            {al.paid_failures > 0 ? `, платных сбоев ${al.paid_failures}` : ''}
          </p>
        ) : market.template_id ? (
          <p>Автозапуска у этого рынка не было</p>
        ) : (
          <p>Итоговых писем ещё нет</p>
        )}
        {market.client_wish ? (
          <p>
            Клиент хочет: {market.client_wish.state === 'paused' ? 'пауза' : 'отправка'}
            {market.client_wish.changed_at ? ` (с ${fmtDateTime(market.client_wish.changed_at)})` : ''}
          </p>
        ) : null}
      </div>
      {market.campaigns.length > 0 ? (
        <ul className="mt-2 divide-y divide-gray-100 rounded-lg bg-gray-50 text-sm">
          {market.campaigns.map((c) => (
            <li key={c.campaign_id} className="px-3 py-2">
              <p className="break-words text-gray-800">
                {c.name || c.campaign_id}
                {c.segment ? <span className="text-gray-500"> · сегмент {c.segment}</span> : null}
              </p>
              <p className="text-gray-600">
                {campaignStatusLabel(c.status)} · адресов {fmtNum(c.leads)} · отправлено {fmtNum(c.sent)} · ответов{' '}
                {fmtNum(c.replies)}
                {c.status_read_at ? <span className="text-gray-400"> · статус от {fmtDateTime(c.status_read_at)}</span> : null}
              </p>
              {c.start_error ? <p className="text-red-700">Старт: {startErrorLabel(c.start_error)}</p> : null}
              {c.read_error ? <p className="text-amber-800">Чтение: {readErrorLabel(c.read_error)}</p> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function EngClientCard({ userId }: { userId: string }) {
  const isTma = useIsTma();
  const router = useRouter();
  const [card, setCard] = useState<EngClientCardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'sending' | 'block' | 'password' | 'delete'>(null);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [revealPassword, setRevealPassword] = useState(false);

  const load = useCallback(
    async (refresh: boolean) => {
      setLoading(true);
      setError(null);
      try {
        setCard(await fetchEngClientCard(userId, refresh));
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Не удалось загрузить карточку клиента');
      } finally {
        setLoading(false);
      }
    },
    [userId],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await fetchEngClientCard(userId, false);
        if (!cancelled) setCard(data);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Не удалось загрузить карточку клиента');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const pageClass = `mx-auto max-w-5xl px-4 ${isTma ? 'py-6 text-sm leading-relaxed' : 'py-10'}`;
  const back = (
    <div className="mb-6">
      <Link href="/admin/eng-clients" className="text-sm font-medium text-blue-600 hover:text-blue-700">
        ← Английские клиенты
      </Link>
    </div>
  );

  if (!card) {
    return (
      <div className={pageClass}>
        {back}
        {error ? (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>
        ) : (
          <div className="flex h-40 items-center justify-center text-sm text-gray-500">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Загрузка…
          </div>
        )}
      </div>
    );
  }

  const who = card.profile.email || card.profile.full_name || 'клиента';
  const banned = card.auth.state === 'read' ? card.auth.banned : null;
  const markerState = card.marker;
  const markerActive = markerState === 'active';
  // Блокировка действует: отметка или бан. Статус не прочитан и отметки нет — неизвестно.
  const blocked = markerActive || banned === true;
  const sending = card.sending;
  const allowed = engSendingAllowed(sending);
  const latestProject = card.projects[0] ?? null;
  const rowSending = card.row.sending;
  // Что блокировка, которая действует сейчас, не подтвердила (engAdminView card.block.stop_doubt).
  const blockDoubt = card.block?.active ? card.block.stop_doubt : null;
  // Эпизод отметки завело «Разблокировать» у бана без отметки (engAdminView card.block.opened_by).
  const openedByUnblock = card.block?.opened_by === 'unblock';
  const episodeAt = card.block?.blocked_at ?? null;

  /**
   * Вопрос перед «Разблокировать». Разблокировка сначала повторяет остановку
   * (у бана без отметки — ту же полную, что «Заблокировать», с отметкой) и
   * снимает бан, только если она подтверждена (engAccountBlock). Отметка есть,
   * а бана нет — снимает отметку.
   */
  function unblockConfirmText(): string {
    const parts =
      'отправка аккаунта, автопилот, автозапуск «Launch», ночной добор («Daily top-up»), задачи, сбор и проверка ' +
      'контактов, исследование, очередь писем клиенту и пауза кампаний (кампании, до которых кабинет не ' +
      'дотягивается, ответ назовёт — их ставят на паузу руками в Instantly, снятие они не держат)';
    const markerOnly = markerActive && banned === false;
    const first = markerActive
      ? openedByUnblock
        ? `Отметку блокировки завело прошлое «Разблокировать» ${fmtDateTime(episodeAt)} (бан стоял без ` +
          'отметки), и оно не довершилось — почему, сказал его ответ (и журнал действий). Сначала остановка ' +
          `повторится: ${parts}.`
        : `Сначала остановка блокировки повторится: ${parts}.` +
          (blockDoubt ? ` Остановка этой блокировки не подтверждена: ${blockDoubt}. Это выключится тоже.` : '')
      : markerState === 'unknown'
        ? 'Таблицы блокировок нет (миграция 20261013_0001), отметку не записать — сначала будет та же полная остановка, ' +
          `что у «Заблокировать»: ${parts}.`
        : 'Отметки блокировки у клиента нет (бан поставлен мимо раздела, или при «Заблокировать» она не записалась), ' +
          `поэтому сначала будет та же полная остановка, что у «Заблокировать», с отметкой: ${parts}.`;
    const tail =
      'само ничего не начнётся: отправка останется выключенной, пока вы её не включите здесь; рынки клиент запустит ' +
      'кнопкой «Launch», остановленные кампании — «Start sending», ночной добор — «Turn on».';
    if (markerOnly) {
      return (
        `Разблокировать ${who}? ${first} Бана сейчас нет — клиент может войти, но пока стоит отметка, платные шаги, ` +
        'запуск, отправку и ночной добор ему не включить. Остановка всё равно выключит ночной добор («Daily ' +
        'top-up») у каждого проекта, где он включён, кто бы его ни включил, — снова его включит только клиент ' +
        '(«Turn on»). Отметка снимется, только если всё это подтвердится; иначе она останется, и ответ скажет, что ' +
        `не остановилось. После снятия отметки ${tail}`
      );
    }
    return (
      `Разблокировать ${who}? ${first} Бан снимется, только если всё это подтвердится; иначе он останется, и ответ ` +
      `скажет, что не остановилось. После снятия бана клиент снова сможет войти, но ${tail}`
    );
  }

  /** Вопрос перед «Включить отправку» у выключенной сотрудником (чип «Отправка выключена сотрудником»); null — без вопроса. */
  function enableConfirmText(): string | null {
    if (!rowSending.staff_off) return null;
    const at = fmtDateTime(sending.revoked_at);
    const tail = 'Клиенту уйдёт письмо «Sending is on», и запуск, «Start sending» и ночной добор аккаунта перестанут получать отказ из-за выключенной отправки.';
    if (rowSending.off_by === 'block') {
      return `Отправку ${who} выключила блокировка ${at}; рынков клиент не запускал. Включить отправку? ${tail}`;
    }
    if (rowSending.off_by === 'unknown') {
      return `Отправку ${who} выключил сотрудник ${at} — кнопкой «Выключить отправку» или блокировкой (таблицы блокировок нет, не отличить). Включить её снова? ${tail}`;
    }
    // Не последней блокировкой через раздел: кнопкой — или остановкой, у которой не записалась отметка.
    return (
      `Отправку ${who} выключили ${at} не последней блокировкой через раздел: кнопкой «Выключить отправку» или ` +
      'остановкой «Заблокировать» / «Разблокировать», у которой не записалась отметка блокировки (её отчёт — в ' +
      `журнале действий). Включить её снова? ${tail}`
    );
  }

  async function onSending(redeliver: boolean) {
    if (busy) return;
    const enable = redeliver ? false : !allowed;
    if (!enable) {
      const text = redeliver
        ? 'Отправка аккаунта уже выключена. Поставить кампании всех его запусков на паузу ещё раз (что не встанет — покажем)?'
        : 'Выключить отправку аккаунта? Кампании всех его запусков встанут на паузу (что не встанет — покажем), а запуск, «Start sending» / «Resume» и ночной добор аккаунта будут отказаны.';
      if (!window.confirm(text)) return;
    } else {
      const text = enableConfirmText();
      if (text !== null && !window.confirm(text)) return;
    }
    setBusy('sending');
    setActionError(null);
    setResult(null);
    try {
      const res = await postEngSending(userId, enable);
      const line = engSendingResultText(enable, res);
      setResult({ title: enable ? 'Включение отправки' : 'Выключение отправки', complete: line.tone === 'ok', lines: [line] });
      await load(false);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Не удалось изменить отправку аккаунта');
    } finally {
      setBusy(null);
    }
  }

  async function onBlock(block: boolean) {
    if (busy) return;
    const text = block
      ? `Заблокировать клиента ${who}? Он не сможет войти. Все его кампании встанут на паузу, остановятся исследование, письма, сбор и проверка контактов, итоговые письма и ночной добор, автозапуск выключится, письма клиенту перестанут уходить. Что не остановится — покажем здесь и пришлём в Telegram.`
      : unblockConfirmText();
    if (!window.confirm(text)) return;
    setBusy('block');
    setActionError(null);
    setResult(null);
    try {
      const { status, body } = await postEngBlock(userId, block);
      const box = block ? body.eng_stop : body.eng_unblock;
      if (box) {
        // Итог блокировки — список несработавших шагов одной фразой. У
        // разблокировки то, что не вышло (остановка, бан или отметка), уже
        // названо красными строками отчёта (engAccountBlock.heEngUnblockReportLines)
        // — второй раз не повторяем.
        const lines = block && box.error && !box.complete ? [...box.lines, { tone: 'red' as const, text: box.error }] : box.lines;
        setResult({ title: block ? 'Блокировка' : 'Разблокировка', complete: box.complete && status < 400, lines });
      } else if (status >= 400) {
        setActionError(body.error || `Ошибка ${status}`);
      } else {
        // Ответ без отчёта — роут не узнал в аккаунте клиента английского кабинета.
        setActionError('Ответ пришёл без отчёта остановки — обновите карточку и проверьте, что это клиент английского кабинета.');
      }
      await load(false);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Ошибка изменения блокировки');
    } finally {
      setBusy(null);
    }
  }

  async function onPassword() {
    const pw = newPassword.trim();
    if (pw.length < 8 || pw.length > 72 || busy) return;
    setBusy('password');
    setActionError(null);
    try {
      await postEngPassword(userId, pw);
      setResult({
        title: 'Пароль',
        complete: true,
        lines: [
          { tone: 'ok', text: 'Пароль сменён' },
          { tone: 'note', text: 'Клиенту письмо не уходит — сообщите новый пароль в чате поддержки.' },
        ],
      });
      setPasswordOpen(false);
      setNewPassword('');
      setRevealPassword(false);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Ошибка обновления пароля');
    } finally {
      setBusy(null);
    }
  }

  async function onDelete() {
    if (busy) return;
    if (
      !window.confirm(
        `Удалить аккаунт ${who}? Проектов у него нет. Аккаунт и вход удаляются насовсем — это нельзя отменить.`,
      )
    ) {
      return;
    }
    setBusy('delete');
    setActionError(null);
    try {
      await deleteEngAccount(userId);
      router.push('/admin/eng-clients' as Route);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Ошибка удаления аккаунта');
      setBusy(null);
    }
  }

  const statusPill =
    banned === null && !markerActive ? (
      <Pill tone="grey">статус не прочитан</Pill>
    ) : blocked ? (
      <Pill tone="red">
        Заблокирован
        {card.block?.active && card.block.blocked_at && !openedByUnblock ? ` с ${fmtDateTime(card.block.blocked_at)}` : ''}
      </Pill>
    ) : (
      <Pill tone="green">Активен</Pill>
    );

  const sendingText =
    sending.state === 'enabled'
      ? `включена ${fmtDateTime(sending.enabled_at)}`
      : sending.state === 'revoked'
        ? rowSending.waiting_reason === 'unblocked'
          ? `выключена блокировкой ${fmtDateTime(sending.revoked_at)}; клиент разблокирован ${fmtDateTime(card.block?.unblocked_at)} — ждёт включения`
          : `${rowSending.off_by === 'block' ? 'выключена блокировкой' : rowSending.off_by === 'staff' ? 'выключена сотрудником' : 'выключена'} ${fmtDateTime(sending.revoked_at)}`
        : sending.state === 'unavailable'
          ? 'таблица выключателя не создана (миграция 20261011_0002)'
          : sending.state === 'error'
            ? 'не прочиталась'
            : rowSending.waiting
              ? `ждёт включения${rowSending.since ? ` с ${fmtDateTime(rowSending.since)}` : ''}`
              : 'не включена';

  const verification = card.verification;
  const verificationText =
    verification.state === 'yes'
      ? 'Почта подтверждена'
      : verification.state === 'backfill'
        ? 'Почта считается подтверждённой (старый аккаунт)'
        : verification.state === 'unknown'
          ? 'Подтверждение почты не читается (миграция 20261010_0001)'
          : `Почта не подтверждена${verification.last_sent_at ? ` (ссылка отправлена ${fmtDateTime(verification.last_sent_at)})` : ''}`;

  const btn = 'rounded-lg border px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50';

  return (
    <div className={pageClass}>
      {back}

      {/* Шапка */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className={`${isTma ? 'text-xl' : 'text-2xl'} break-words font-bold text-gray-900`}>
            {card.profile.full_name || card.profile.email || 'Без имени'}
          </h1>
          <p className="break-words text-sm text-gray-600">
            {card.profile.email || '—'}
            {card.profile.company ? ` · ${card.profile.company}` : ''}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {statusPill}
            <Pill tone={sending.state === 'enabled' ? 'green' : rowSending.waiting ? 'amber' : 'grey'}>Отправка: {sendingText}</Pill>
          </div>
          <p className="mt-2 text-sm text-gray-600">{verificationText}</p>
          <p className="text-sm text-gray-500">
            Зарегистрирован {fmtDateTime(card.profile.created_at)} · последний вход{' '}
            {card.auth.state === 'read'
              ? card.auth.last_sign_in_at
                ? fmtDateTime(card.auth.last_sign_in_at)
                : 'не входил'
              : card.auth.state === 'missing'
                ? '— пользователя нет в списке входа'
                : '— статус не прочитан'}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={() => void load(false)}
            disabled={loading}
            className={`${btn} inline-flex items-center gap-2 border-gray-300 text-gray-700 hover:bg-gray-50`}
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Обновить
          </button>
        </div>
      </div>

      {error ? <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div> : null}

      {/* Расхождения бана и отметки */}
      <div className="mb-4 space-y-2">
        {card.ban_without_stop ? (
          <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800">
            {card.marker === 'unknown'
              ? 'Вход закрыт баном, а таблицы блокировок нет (миграция 20261013_0001 не применена): блокировку видят только проверки бана (новые платные шаги, следующие шаги автопилота, автозапуск, ночной добор, письма клиенту); уже поставленные задачи и фоновая проверка заблокированных её не видят, а бан мимо раздела не ставит кампании на паузу и не выключает «Daily top-up». Примените миграцию и нажмите «Заблокировать ещё раз / доставить остановку».'
              : 'Вход закрыт баном, а отметки блокировки нет: бан поставлен мимо раздела, или при «Заблокировать» отметка не записалась (тогда остановка была — её отчёт в журнале действий). Бан мимо раздела не ставит кампании на паузу и не снимает уже поставленные задачи (новые платные шаги, автозапуск, ночной добор и письма клиенту бан держит). Нажмите «Заблокировать ещё раз / доставить остановку».'}
          </div>
        ) : null}
        {card.marker_without_ban ? (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            {card.block?.last_stop?.ban === 'failed'
              ? 'Отметка блокировки есть, а вход открыт: бан при блокировке не поставился — нажмите «Заблокировать ещё раз / доставить остановку».'
              : 'Отметка блокировки есть, а вход открыт. Хотели разблокировать — нажмите «Разблокировать» ещё раз (повторит остановку и снимет отметку); хотели заблокировать — «Заблокировать ещё раз / доставить остановку».'}
          </div>
        ) : null}
        {card.leak.length > 0 ? (
          <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800">
            <p className="font-semibold">Заблокирован, но работа идёт:</p>
            <ul className="mt-1 list-disc pl-5">
              {card.leak.map((l, i) => (
                <li key={i}>{leakText(l)}</li>
              ))}
            </ul>
            <p className="mt-1">
              Нажмите «Заблокировать ещё раз / доставить остановку» — остановка повторится там, где не дошла; кампании,
              которые кабинет на паузу поставить не может, отчёт назовёт — их ставят на паузу руками в Instantly.
            </p>
          </div>
        ) : null}
        {card.attention.length > 0 ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <p className="font-semibold">Нужна помощь:</p>
            <ul className="mt-1 list-disc pl-5">
              {card.attention.map((a, i) => (
                <li key={i}>{attentionText(a)}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {card.missing.length > 0 ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            Не применены миграции — эти данные не читаются: {card.missing.map((m) => MISSING_SOURCE_LABELS[m]).join('; ')}.
          </div>
        ) : null}
      </div>

      {/* Действия */}
      <div className="mb-4 rounded-xl border border-gray-200 bg-gray-50 p-4">
        <div className="flex flex-wrap gap-2">
          {sending.state !== 'unavailable' && sending.state !== 'error' ? (
            <button
              type="button"
              onClick={() => void onSending(false)}
              disabled={busy !== null || (!allowed && blocked)}
              title={!allowed && blocked ? 'Сначала разблокируйте' : engSendingTitle(sending)}
              className={`${btn} ${
                allowed ? 'border-amber-200 bg-white text-amber-700 hover:bg-amber-50' : 'border-green-200 bg-white text-green-700 hover:bg-green-50'
              }`}
            >
              {busy === 'sending' ? 'Сохранение…' : allowed ? 'Выключить отправку' : 'Включить отправку'}
            </button>
          ) : null}
          {sending.state === 'revoked' ? (
            <button
              type="button"
              onClick={() => void onSending(true)}
              disabled={busy !== null}
              className={`${btn} border-amber-200 bg-white text-amber-700 hover:bg-amber-50`}
            >
              {busy === 'sending' ? 'Сохранение…' : 'Выключить ещё раз / доставить паузу'}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void onBlock(true)}
            disabled={busy !== null}
            className={`${btn} border-red-200 bg-white text-red-700 hover:bg-red-50`}
          >
            {busy === 'block' ? 'Сохранение…' : blocked ? 'Заблокировать ещё раз / доставить остановку' : 'Заблокировать'}
          </button>
          {blocked ? (
            <button
              type="button"
              onClick={() => void onBlock(false)}
              disabled={busy !== null}
              className={`${btn} border-green-200 bg-white text-green-700 hover:bg-green-50`}
            >
              {busy === 'block' ? 'Сохранение…' : 'Разблокировать'}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              setPasswordOpen(true);
              setNewPassword('');
              setRevealPassword(false);
            }}
            disabled={busy !== null}
            className={`${btn} border-gray-300 bg-white text-gray-700 hover:bg-gray-100`}
          >
            Сменить пароль
          </button>
          {latestProject ? (
            <Link
              href={`/tools/hypothesis-engine?project=${latestProject.id}` as Route}
              className={`${btn} border-blue-200 bg-white text-blue-700 hover:bg-blue-50`}
            >
              Открыть проект в инструменте
            </Link>
          ) : null}
          {card.support ? (
            <Link
              href={`/support?thread=${card.support.thread_id}` as Route}
              className={`${btn} border-blue-200 bg-white text-blue-700 hover:bg-blue-50`}
            >
              Открыть чат поддержки
            </Link>
          ) : null}
          <button
            type="button"
            onClick={() => void load(true)}
            disabled={loading || busy !== null}
            className={`${btn} border-gray-300 bg-white text-gray-700 hover:bg-gray-100`}
          >
            Обновить статусы кампаний
          </button>
          {card.projects_total === 0 ? (
            <button
              type="button"
              onClick={() => void onDelete()}
              disabled={busy !== null}
              className={`${btn} border-red-200 bg-white text-red-700 hover:bg-red-50`}
            >
              {busy === 'delete' ? 'Удаление…' : 'Удалить аккаунт'}
            </button>
          ) : null}
        </div>
        {!allowed && blocked && sending.state !== 'unavailable' && sending.state !== 'error' ? (
          <p className="mt-2 text-xs text-gray-500">Включить отправку: сначала разблокируйте.</p>
        ) : null}
        {sending.state === 'unavailable' ? (
          <p className="mt-2 text-xs text-amber-800">Выключателя отправки нет: не применена миграция 20261011_0002.</p>
        ) : null}
        {!card.support ? <p className="mt-2 text-xs text-gray-500">Клиент в поддержку не писал.</p> : null}
        <p className="mt-2 text-xs text-gray-500">
          «Обновить статусы кампаний» перечитывает у рассыльщика статусы старше 5 минут, в фоне и не больше 10 кампаний
          проекта за нажатие; новые значения видны при следующем «Обновить». Пресет запуска здесь не предлагается — пресет
          английского клиента ведёт пул ящиков.
        </p>
      </div>

      {actionError ? (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{actionError}</div>
      ) : null}
      {result ? (
        <div className="mb-4">
          <EngBlockReport title={result.title} headline={null} complete={result.complete} lines={result.lines} />
        </div>
      ) : null}

      {passwordOpen ? (
        <div className="mb-4 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
          <p className="mb-2 text-sm font-medium text-gray-900">Новый пароль</p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              type={revealPassword ? 'text' : 'password'}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Минимум 8 символов"
              autoComplete="new-password"
              className="h-9 min-w-0 flex-1 rounded-lg border border-gray-300 px-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <div className="flex gap-2">
              <button type="button" onClick={() => setRevealPassword((v) => !v)} className={`${btn} border-gray-300 text-gray-700`}>
                {revealPassword ? 'Скрыть' : 'Показать'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setNewPassword(generatePassword());
                  setRevealPassword(true);
                }}
                className={`${btn} border-gray-300 text-gray-700`}
              >
                Сгенерировать
              </button>
              <button
                type="button"
                disabled={!newPassword.trim()}
                onClick={() => {
                  void navigator.clipboard?.writeText(newPassword.trim()).catch(() => undefined);
                }}
                className={`${btn} border-gray-300 text-gray-700`}
              >
                Копировать
              </button>
            </div>
          </div>
          <p className="mt-2 text-xs text-gray-500">Клиенту письмо не уходит — сообщите новый пароль в чате поддержки.</p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => void onPassword()}
              disabled={busy !== null || newPassword.trim().length < 8 || newPassword.trim().length > 72}
              className={`${btn} border-blue-600 bg-blue-600 text-white hover:bg-blue-700`}
            >
              {busy === 'password' ? 'Сохранение…' : 'Сохранить пароль'}
            </button>
            <button type="button" onClick={() => setPasswordOpen(false)} className={`${btn} border-gray-300 text-gray-700`}>
              Отмена
            </button>
          </div>
        </div>
      ) : null}

      <div className="space-y-4">
        {/* Последняя блокировка */}
        {card.block ? (
          <Section
            title={
              card.block.active
                ? 'Блокировка'
                : openedByUnblock
                  ? 'Последняя отметка блокировки (снята)'
                  : 'Последняя блокировка (снята)'
            }
          >
            <p className="mb-2 text-sm text-gray-600">
              {openedByUnblock
                ? `Отметку блокировки завело «Разблокировать» ${fmtDateTime(card.block.blocked_at)}: бан стоял без отметки, и перед его снятием «Разблокировать» делает ту же полную остановку, что «Заблокировать»`
                : `Заблокирован ${fmtDateTime(card.block.blocked_at)}`}
              {card.block.last_block_at && card.block.last_block_at !== card.block.blocked_at
                ? `, последнее нажатие ${openedByUnblock ? '«Заблокировать» ' : ''}${fmtDateTime(card.block.last_block_at)}`
                : ''}
              {!card.block.active && card.block.unblocked_at
                ? ` · ${openedByUnblock ? 'снята' : 'разблокирован'} ${fmtDateTime(card.block.unblocked_at)}`
                : ''}
            </p>
            <p className="mb-2 text-sm text-gray-600">
              {openedByUnblock ? 'Перед остановкой «Разблокировать» отправка была' : 'До блокировки отправка была'}:{' '}
              {SENDING_BEFORE_LABELS[card.block.sending_before as keyof typeof SENDING_BEFORE_LABELS] ?? card.block.sending_before}
              {card.block.refill_enabled_before && Object.keys(card.block.refill_enabled_before).length > 0
                ? `; ночной добор: ${Object.values(card.block.refill_enabled_before)
                    .map((v) => REFILL_BEFORE_LABELS[v as keyof typeof REFILL_BEFORE_LABELS] ?? v)
                    .join(', ')}`
                : ''}
            </p>
            {card.last_stop_lines ? (
              card.block.active ? (
                <EngBlockReport headline={null} complete={card.block.last_stop?.complete === true} lines={card.last_stop_lines} />
              ) : (
                // Снятая блокировка: строки уже без красного и без «Заблокировать ещё раз» (роут карточки).
                <EngBlockReport
                  history
                  headline={`${openedByUnblock ? 'Отчёт последнего «Заблокировать»' : 'Отчёт снятой блокировки'} от ${fmtDateTime(card.block.last_block_at ?? card.block.blocked_at)}:`}
                  complete={card.block.last_stop?.complete === true}
                  lines={card.last_stop_lines}
                />
              )
            ) : (
              <p className="text-sm text-gray-500">
                {card.block.last_stop
                  ? 'Отчёт последней блокировки не читается.'
                  : openedByUnblock
                    ? 'Что остановило «Разблокировать», сказал ответ того нажатия; он есть в журнале действий (admin.users.unblock.eng).'
                    : 'Отчёта последней блокировки нет.'}
              </p>
            )}
          </Section>
        ) : null}

        {/* Проект */}
        <Section title={card.projects.length > 1 ? `Проекты (${card.projects.length})` : 'Проект'}>
          {card.projects.length === 0 ? (
            <p className="text-sm text-gray-500">Проекта нет — клиент ещё не начинал.</p>
          ) : (
            <div className="space-y-6">
              {card.projects.map((p) => (
                <div key={p.id} className="space-y-3">
                  <div className="space-y-1 text-sm text-gray-700">
                    <p>
                      Сайт:{' '}
                      {p.website_url ? (
                        <a
                          href={p.website_url.includes('://') ? p.website_url : `https://${p.website_url}`}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="break-all text-blue-600 hover:text-blue-700"
                        >
                          {p.website_url}
                        </a>
                      ) : (
                        '—'
                      )}
                      {card.projects.length > 1 ? (
                        <Link
                          href={`/tools/hypothesis-engine?project=${p.id}` as Route}
                          className="ml-2 text-xs text-blue-600 hover:text-blue-700"
                        >
                          в инструменте →
                        </Link>
                      ) : null}
                    </p>
                    <p>
                      Статус: {projectStatusLabel(p.status)}
                      {p.research_last_job
                        ? ` · последний шаг исследования: ${jobStageLabel(p.research_last_job.stage)} — ${jobStatusLabel(
                            p.research_last_job.status,
                          )}`
                        : ''}
                    </p>
                    {p.error ? <p className="break-words text-red-700">Ошибка: {p.error}</p> : null}
                    {p.research_last_job?.error ? (
                      <p className="break-words text-red-700">Ошибка шага исследования: {p.research_last_job.error}</p>
                    ) : null}
                    {p.cancelled_at ? <p>Отменено {fmtDateTime(p.cancelled_at)}</p> : null}
                    <p>
                      Автопилот: {p.autopilot ? 'включён' : 'выключен'}
                      {p.autopilot_error ? ` · пауза: ${p.autopilot_error}` : ''}
                    </p>
                    <p>Ночной добор: {refillText(p.refill)}</p>
                    <p>
                      «Launch»:{' '}
                      {p.intent
                        ? p.intent.wanted
                          ? `нажат ${fmtDateTime(p.intent.requested_at)}, автозапуск включён${
                              p.intent.settled_at ? ` — ${AUTO_LAUNCH_EXTRA_LABELS.settled}` : ''
                            }`
                          : `автозапуск выключен${p.intent.cancelled_at ? ` ${fmtDateTime(p.intent.cancelled_at)}` : ''}`
                        : card.row.intent === 'unknown'
                          ? 'не читается'
                          : 'не нажимал'}
                    </p>
                    <p>
                      Сейчас в работе:{' '}
                      {p.active_jobs.length === 0
                        ? 'ничего'
                        : p.active_jobs
                            .map((j) => `${jobStageLabel(j.stage)} (${jobStatusLabel(j.status)} с ${fmtDateTime(j.started_at ?? j.created_at)})`)
                            .join(', ')}
                    </p>
                  </div>
                  <div>
                    <p className="mb-2 text-sm font-medium text-gray-900">Рынки</p>
                    {p.markets.length === 0 ? (
                      <p className="text-sm text-gray-500">Рынки не выбраны</p>
                    ) : (
                      <ul className="space-y-2">
                        {p.markets.map((m) => (
                          <MarketRow key={m.vertical_id} market={m} />
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* Ящики */}
        <Section title="Ящики отправки">
          {card.mailboxes === null ? (
            <p className="text-sm text-amber-800">Пул не читается: не применена миграция 20261011_0001.</p>
          ) : card.mailboxes.length === 0 ? (
            <p className="text-sm text-gray-500">Ящиков пула у клиента нет.</p>
          ) : (
            <ul className="space-y-1 text-sm text-gray-700">
              {card.mailboxes.map((m) => (
                <li key={m.email} className="break-all">
                  {m.email} · воркспейс {m.workspace} · отдан {fmtDateTime(m.assigned_at)}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-gray-500">
            Состояние ящиков проверяется вручную. После блокировки ящики остаются за клиентом, пока их не освободят вручную.
          </p>
        </Section>

        {/* Расход */}
        <Section title="Расход">
          <p className="text-sm text-gray-700">
            {card.spend.state === 'ok'
              ? `Известно не меньше $${card.spend.known_usd.toFixed(2)} (без цены: ${fmtNum(card.spend.unpriced_calls)} обращений; потеряно строк журнала: ${fmtNum(card.spend.lost_rows)})`
              : card.spend.state === 'timeout'
                ? 'Не посчитан — считался дольше 5 секунд'
                : 'Не посчитан'}
          </p>
          {latestProject ? (
            <Link
              href={`/tools/hypothesis-engine?project=${latestProject.id}` as Route}
              className="mt-1 inline-block text-sm text-blue-600 hover:text-blue-700"
            >
              Подробно в инструменте →
            </Link>
          ) : null}
        </Section>

        {/* Письма клиенту */}
        <Section title="Письма клиенту">
          {card.client_emails === null ? (
            <p className="text-sm text-amber-800">Не читаются: не применена миграция 20261012_0002.</p>
          ) : card.client_emails.length === 0 ? (
            <p className="text-sm text-gray-500">Писем не было.</p>
          ) : (
            <ul className="divide-y divide-gray-100 text-sm">
              {card.client_emails.map((m, i) => (
                <li key={i} className="py-1.5 text-gray-700">
                  <span className="text-gray-900">{clientEmailLabel(m.kind, m.code)}</span> · заявлено {fmtDateTime(m.created_at)} ·{' '}
                  {m.sent_at
                    ? `ушло ${fmtDateTime(m.sent_at)}`
                    : m.closed_at
                      ? `закрыто ${fmtDateTime(m.closed_at)}`
                      : `не ушло (попыток ${m.attempts})`}
                </li>
              ))}
            </ul>
          )}
        </Section>

        {/* Поддержка */}
        <Section title="Поддержка">
          {card.support ? (
            <p className="text-sm text-gray-700">
              Последнее сообщение {fmtDateTime(card.support.last_message_at)}{' '}
              {card.support.last_message_role === 'client' ? 'от клиента — ждёт ответа' : 'от нас'} ·{' '}
              <Link href={`/support?thread=${card.support.thread_id}` as Route} className="text-blue-600 hover:text-blue-700">
                открыть чат
              </Link>
            </p>
          ) : (
            <p className="text-sm text-gray-500">Клиент в поддержку не писал.</p>
          )}
        </Section>
      </div>
    </div>
  );
}
