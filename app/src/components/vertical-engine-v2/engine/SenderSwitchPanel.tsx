'use client';

/**
 * Панель выключателей Движка → «Рассылка» (этап 6) над списком проектов.
 * Состояние — GET /sender-switches (при открытии, раз в минуту и после
 * каждого действия). Кнопки — только admin (can_manage): POST
 * /api/admin/ve2-sender, перед каждым — подтверждение «что встанет и что
 * продолжит идти», после — отчёт строками под панелью. Остальные сотрудники
 * видят панель, только когда что-то не по умолчанию (выключено, остановлено,
 * запасной выключатель, или рынку разрешена «Рассылка» — бывшая плашка этапа 4).
 * Этап 7: «Разрешить выбор «Рассылки»» (только РФ) — специалист выбирает
 * способ при запуске, по умолчанию Instantly; «Запретить выбор» снимает его,
 * ничего не запоминая. США — только Instantly.
 */

import { useEffect, useRef, useState } from 'react';
import {
  SENDER_LEAD_CARDS_OFF_CONFIRM,
  SENDER_PANEL_ENV_KILL_LINE,
  SENDER_PANEL_UNREAD,
  SENDER_PANEL_US_INSTANTLY_ONLY,
  senderAllowChoiceConfirm,
  senderForbidChoiceConfirm,
  senderKeepPausedConfirm,
  senderLeadCardsMissedButton,
  senderLeadCardsOnConfirm,
  senderPanelChangedLine,
  senderPanelLaunchLine,
  senderPanelLeadCardsLine,
  senderPanelNoteLine,
  senderPanelPauseLine,
  senderPanelRunningLine,
  senderPanelSendingLine,
  senderPanelUploadsLine,
  senderRestoreLaunchesConfirm,
  senderResumeSendingConfirm,
  senderStopLaunchesConfirm,
  senderStopSendingConfirm,
  senderUploadsConfirm,
} from '@/lib/verticalEngineV2/senderTransport/labels';
import {
  VE_API,
  veEngineCall,
  veEnginePost,
  type VeSenderSwitchActionResponse,
  type VeSenderSwitchesResponse,
  type VeSenderSwitchState,
} from './api';
import { HE } from './design';
import { StatusBox } from './ui';

const ADMIN_API = '/api/admin/ve2-sender';
const POLL_MS = 60_000;
/** Как VE_SENDER_NOTE_MAX на сервере (switches.ts — серверный модуль). */
const NOTE_MAX = 300;

type Market = NonNullable<VeSenderSwitchState['markets']>[number];
type ActionBody = {
  action: string;
  market?: string;
  enabled?: boolean;
  include_missed?: boolean;
  pause_id?: string;
};

async function loadSwitches(signal?: AbortSignal): Promise<{ state: VeSenderSwitchState; canManage: boolean }> {
  const response = await veEngineCall<VeSenderSwitchesResponse>(`${VE_API}/sender-switches`, signal ? { signal } : undefined);
  if (!response.ok || !response.data.state) throw new Error(response.data.error ?? 'Не удалось прочитать выключатели');
  return { state: response.data.state, canManage: response.data.can_manage === true };
}

/** Не по умолчанию — панель видят и не-админы. */
function notDefault(state: VeSenderSwitchState): boolean {
  return state.env_kill
    || (state.markets ?? []).some((m) => m.mode !== 'instantly' || m.mode_before_stop != null || !m.sender_uploads_enabled)
    || (state.sending != null && (!state.sending.enabled || state.sending.open_pauses_total > 0))
    || (state.lead_cards != null && !state.lead_cards.enabled);
}

/** Что-то выключено или остановлено — плашка тоном «внимание». */
function somethingStopped(state: VeSenderSwitchState): boolean {
  return state.env_kill
    || (state.markets ?? []).some((m) => m.mode_before_stop != null || !m.sender_uploads_enabled)
    || (state.sending != null && (!state.sending.enabled || state.sending.open_pauses_total > 0))
    || (state.lead_cards != null && !state.lead_cards.enabled);
}

export function SenderSwitchPanel() {
  const [state, setState] = useState<VeSenderSwitchState | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [result, setResult] = useState<string[] | null>(null);
  const [actionError, setActionError] = useState('');
  const requestVersion = useRef(0);
  const submitting = useRef(false);
  // Панель закрыли (открыли проект) — ответы, пришедшие после, не применяем.
  const alive = useRef(true);

  /** Перечитать после действия; ответ отброшен, если за это время начался другой запрос. */
  async function reload() {
    const version = ++requestVersion.current;
    try {
      const loaded = await loadSwitches();
      if (!alive.current || version !== requestVersion.current) return;
      setState(loaded.state);
      setCanManage(loaded.canManage);
      setLoadError('');
    } catch (caught) {
      if (!alive.current || version !== requestVersion.current) return;
      setLoadError(caught instanceof Error ? caught.message : 'Не удалось прочитать выключатели');
    }
  }

  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    async function poll() {
      if (submitting.current) return;
      const version = ++requestVersion.current;
      try {
        const loaded = await loadSwitches(controller.signal);
        if (version !== requestVersion.current) return;
        setState(loaded.state);
        setCanManage(loaded.canManage);
        setLoadError('');
      } catch (caught) {
        if (controller.signal.aborted || version !== requestVersion.current) return;
        setLoadError(caught instanceof Error ? caught.message : 'Не удалось прочитать выключатели');
      }
    }
    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      alive.current = false;
      controller.abort();
      clearInterval(timer);
    };
  }, []);

  async function run(key: string, body: ActionBody, confirmText: string) {
    if (submitting.current) return;
    if (!window.confirm(confirmText)) return;
    submitting.current = true;
    // Опрос, начатый до действия, не перепишет его результат старым состоянием.
    ++requestVersion.current;
    setBusy(key);
    setActionError('');
    setResult(null);
    const trimmed = note.trim();
    try {
      const response = await veEnginePost<VeSenderSwitchActionResponse>(ADMIN_API, { ...body, ...(trimmed ? { note: trimmed } : {}) });
      if (!alive.current) return;
      if (response.data.state) setState(response.data.state);
      if (response.ok) {
        setResult(response.data.lines?.length ? response.data.lines : ['Готово.']);
        setNote('');
      } else if (response.status === 401 || response.status === 403) {
        // Ответ requireAdminAuth/middleware — по-английски; говорим по-русски.
        setActionError('Нет прав администратора или сессия истекла — обновите страницу.');
      } else {
        setActionError(response.data.error ?? 'Не удалось — повторите');
      }
    } catch {
      // Ответ не пришёл: действие могло и пройти — смотрим свежее состояние.
      if (alive.current) setActionError('Ответ сервера не пришёл — проверьте состояние на панели и при необходимости повторите.');
    } finally {
      submitting.current = false;
      if (alive.current) {
        setBusy(null);
        void reload();
      }
    }
  }

  // Ещё не прочитали — не знаем и роли: ничего не показываем.
  if (!state) return null;
  if (!canManage && !notDefault(state)) return null;

  const locked = busy !== null;
  const label = (key: string, text: string) => (busy === key ? 'Выполняем…' : text);
  const sending = state.sending;
  const cards = state.lead_cards;

  function marketButtons(market: Market) {
    const stopKey = `stop_launches:${market.market}`;
    const restoreKey = `restore_launches:${market.market}`;
    const allowKey = `allow_choice:${market.market}`;
    const forbidKey = `forbid_choice:${market.market}`;
    const uploadsKey = `set_uploads:${market.market}`;
    // США — только Instantly: кнопок запусков нет, выбор «Рассылки» там не включается.
    const us = market.market === 'us';
    return <div className="flex flex-wrap items-center gap-2 pt-1">
      {us ? <span className={HE.muted}>{SENDER_PANEL_US_INSTANTLY_ONLY}</span> : null}
      {!us && market.mode === 'instantly' && !market.mode_before_stop ? <button type="button" className={HE.btnSmall} disabled={locked}
        aria-label={`${market.label}: разрешить выбор «Рассылки»`}
        onClick={() => void run(allowKey, { action: 'allow_choice', market: market.market },
          senderAllowChoiceConfirm(market.label, state?.env_kill === true))}>
        {label(allowKey, 'Разрешить выбор «Рассылки»')}
      </button> : null}
      {!us && market.mode === 'choice' ? <button type="button" className={HE.btnSmall} disabled={locked}
        aria-label={`${market.label}: запретить выбор «Рассылки»`}
        onClick={() => void run(forbidKey, { action: 'forbid_choice', market: market.market },
          senderForbidChoiceConfirm(market.label, market.inflight_outreach_runs))}>
        {label(forbidKey, 'Запретить выбор «Рассылки»')}
      </button> : null}
      {us ? null : market.mode !== 'instantly' ? <button type="button" className={`${HE.btnSmall} ve2-b-dan`} disabled={locked}
        aria-label={`${market.label}: новые запуски — только Instantly`}
        onClick={() => void run(stopKey, { action: 'stop_launches', market: market.market },
          senderStopLaunchesConfirm(market.label, market.inflight_outreach_runs, market.mode))}>
        {label(stopKey, 'Новые запуски — только Instantly')}
      </button> : market.mode_before_stop ? <button type="button" className={HE.btnSmall} disabled={locked}
        aria-label={`${market.label}: вернуть запуски как было`}
        onClick={() => void run(restoreKey, { action: 'restore_launches', market: market.market },
          senderRestoreLaunchesConfirm(market.label, market.mode_before_stop))}>
        {label(restoreKey, 'Вернуть запуски как было')}
      </button> : null}
      <button type="button" className={market.sender_uploads_enabled ? `${HE.btnSmall} ve2-b-dan` : HE.btnSmall} disabled={locked}
        aria-label={`${market.label}: ${market.sender_uploads_enabled ? 'выключить' : 'включить'} подачу`}
        onClick={() => void run(uploadsKey, { action: 'set_uploads', market: market.market, enabled: !market.sender_uploads_enabled },
          senderUploadsConfirm(market.label, !market.sender_uploads_enabled, market))}>
        {label(uploadsKey, market.sender_uploads_enabled ? 'Выключить подачу' : 'Включить подачу')}
      </button>
    </div>;
  }

  return <section aria-label="Движок → «Рассылка»"
    className={`mb-5 ve2-nt ${somethingStopped(state) ? 've2-nt-warn' : 've2-nt-info'} px-4 py-3 text-sm`}>
    <p className="ve2-eb">Движок → «Рассылка»</p>
    <div className="mt-2 space-y-3">
      {state.env_kill ? <p className="font-medium">{SENDER_PANEL_ENV_KILL_LINE}</p> : null}

      {state.markets == null ? <p>Режимы запусков и подача контактов: {SENDER_PANEL_UNREAD}.</p>
        : state.markets.map((market) => {
          const changed = senderPanelChangedLine(market.updated_by_name, market.updated_at, market.note);
          return <div key={market.market} className="space-y-1">
            <p>{senderPanelLaunchLine(market, state.env_kill, state.sending?.enabled === false)}</p>
            <p>{senderPanelUploadsLine(market)}</p>
            {changed ? <p className={HE.muted}>{changed}</p> : null}
            {canManage ? marketButtons(market) : null}
          </div>;
        })}

      {sending == null ? <p>Отправка кампаний Движка: {SENDER_PANEL_UNREAD}.</p> : <div className="space-y-1">
        <p className={sending.enabled ? undefined : 'font-medium'}>{senderPanelSendingLine(sending)}</p>
        <p className={HE.muted}>{senderPanelRunningLine(sending.running_campaigns, sending.enabled)}</p>
        {senderPanelNoteLine(sending.note) ? <p className={HE.muted}>{senderPanelNoteLine(sending.note)}</p> : null}
        {canManage ? <div className="flex flex-wrap gap-2 pt-1">
          <button type="button" className={`${HE.btnSmall} ve2-b-dan`} disabled={locked}
            onClick={() => void run('stop_sending', { action: 'stop_sending' },
              senderStopSendingConfirm(sending.running_campaigns, !sending.enabled))}>
            {label('stop_sending', sending.enabled ? 'Остановить отправку' : 'Остановить ещё раз')}
          </button>
          {!sending.enabled || sending.open_pauses_total > 0 ? <button type="button" className={HE.btnSmall} disabled={locked}
            onClick={() => {
              const partial = sending.open_pauses_total > sending.open_pauses.length;
              const paused = sending.open_pauses.filter((pause) => pause.action === 'paused').length;
              void run('resume_sending', { action: 'resume_sending' }, senderResumeSendingConfirm({
                campaigns: partial ? sending.open_pauses_total : paused,
                unscheduled: sending.open_pauses.length - paused,
                partial,
                sendingStopped: !sending.enabled,
              }));
            }}>
            {label('resume_sending', 'Продолжить отправку')}
          </button> : null}
        </div> : null}
        {sending.open_pauses.length ? <details className="pt-1">
          <summary className={`cursor-pointer ${HE.muted}`}>
            Остановленные выключателем: {sending.open_pauses_total.toLocaleString('ru-RU')}
          </summary>
          <ul className="mt-2 space-y-1">
            {sending.open_pauses.map((pause) => {
              const key = `keep_paused:${pause.pause_id}`;
              return <li key={pause.pause_id} className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0">{senderPanelPauseLine(pause)}</span>
                {canManage ? <button type="button" className={HE.btnSmall} disabled={locked}
                  aria-label={`Оставить на паузе: ${pause.campaign_name ?? 'кампания без названия'}`}
                  onClick={() => void run(key, { action: 'keep_paused', pause_id: pause.pause_id }, senderKeepPausedConfirm(pause))}>
                  {label(key, 'Оставить на паузе')}
                </button> : null}
              </li>;
            })}
          </ul>
          {sending.open_pauses_total > sending.open_pauses.length ? <p className={`mt-1 ${HE.faint}`}>
            Показаны первые {sending.open_pauses.length} из {sending.open_pauses_total.toLocaleString('ru-RU')}.
          </p> : null}
        </details> : null}
      </div>}

      {cards == null ? <p>Карточки лидов: {SENDER_PANEL_UNREAD}.</p> : <div className="space-y-1">
        <p className={cards.enabled ? undefined : 'font-medium'}>{senderPanelLeadCardsLine(cards)}</p>
        {senderPanelNoteLine(cards.note) ? <p className={HE.muted}>{senderPanelNoteLine(cards.note)}</p> : null}
        {canManage ? <div className="flex flex-wrap gap-2 pt-1">
          {cards.enabled ? <button type="button" className={`${HE.btnSmall} ve2-b-dan`} disabled={locked}
            onClick={() => void run('lead_cards_off', { action: 'set_lead_cards', enabled: false }, SENDER_LEAD_CARDS_OFF_CONFIRM)}>
            {label('lead_cards_off', 'Выключить карточки')}
          </button> : <>
            <button type="button" className={HE.btnSmall} disabled={locked}
              onClick={() => void run('lead_cards_on', { action: 'set_lead_cards', enabled: true },
                senderLeadCardsOnConfirm(false, cards.missed_leads))}>
              {label('lead_cards_on', 'Включить — только новые лиды')}
            </button>
            {cards.missed_leads !== 0 ? <button type="button" className={HE.btnSmall} disabled={locked}
              onClick={() => void run('lead_cards_missed', { action: 'set_lead_cards', enabled: true, include_missed: true },
                senderLeadCardsOnConfirm(true, cards.missed_leads))}>
              {label('lead_cards_missed', senderLeadCardsMissedButton(cards.missed_leads))}
            </button> : null}
          </>}
        </div> : null}
      </div>}

      {canManage ? <label className="block">
        <span className={`mb-1 block ${HE.faint}`}>Заметка к действию — необязательно, до {NOTE_MAX} символов</span>
        <input type="text" className={HE.input} maxLength={NOTE_MAX} value={note} disabled={locked}
          placeholder="Например: жалобы на спам, проверяем ящики" onChange={(event) => setNote(event.target.value)} />
      </label> : null}

      <div aria-live="polite" className="space-y-2">
        {result ? <StatusBox tone="info">{result.map((line, index) => <span key={index} className="block">{line}</span>)}</StatusBox> : null}
        {actionError ? <StatusBox tone="error">{actionError}</StatusBox> : null}
        {loadError ? <p className={HE.faint}>Панель не обновилась: {loadError}</p> : null}
      </div>
    </div>
  </section>;
}
