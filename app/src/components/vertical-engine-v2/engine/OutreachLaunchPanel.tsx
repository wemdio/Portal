'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { VeSegmentationAuditSummary, VeTemplate } from '@/lib/verticalEngineV2/types';
import type { VeOutreachSetupResponse } from '@/lib/verticalEngineV2/outreachSetup';
import type { VeOutreachLaunchRequest, VeOutreachRun } from '@/lib/verticalEngineV2/outreachLaunch';
import { VE_API, veEnginePost, type VeDeliveryPlanPreviewDto } from './api';
import { HE } from './design';
import { SearchableSelect } from './SearchableSelect';
import { StatusBox } from './ui';
import { CreateClientPresetInline, DeliveryPlanBlock, useTemplateLaunch } from './steps/Step5Template';
import { getVeLaunchSelectionState } from './launchSelection';
import { DeliveryRatePanel } from './DeliveryRatePanel';
import { ContactUploadModePanel, type ContactUploadMode } from './ContactUploadModePanel';
import { LaunchTransportSwitch } from './LaunchTransportSwitch';
import {
  veLaunchTransportSwitchView,
  veSenderRefusal,
  veSenderRefusalText,
  type VeSenderOption,
} from '@/lib/verticalEngineV2/senderTransport/labels';

type PreflightItem = VeOutreachLaunchRequest['items'][number] & {
  status: 'ready' | 'working' | 'blocked';
  error?: string;
  summary?: VeSegmentationAuditSummary;
  preview?: VeDeliveryPlanPreviewDto & { prospective_ready: number };
};
interface Preflight {
  ready: boolean;
  items: PreflightItem[];
  /** Эхо выбора специалиста (expected_transport); нет поля — Instantly. */
  transport?: 'instantly' | 'sender';
  error?: string;
  /** Отказ всего обзора: VE_LAUNCH_SENDER_DISABLED / VE_LAUNCH_TRANSPORT_UNAVAILABLE — у переключателя. */
  code?: string;
}
export function OutreachLaunchPanel({
  projectId,
  snapshot,
  templates,
  titles,
  hypothesisIds,
  onBack,
  onStarted,
  onPresetChange,
  uploadMode,
  onUploadModeSaved,
  senderOption,
  onSenderOptionReload,
}: {
  projectId: string;
  snapshot: VeOutreachSetupResponse;
  templates: VeTemplate[];
  titles: Record<string, string>;
  hypothesisIds: string[];
  onBack: () => void;
  onStarted: (run: VeOutreachRun) => void;
  onPresetChange: (presetId: string) => void;
  uploadMode: ContactUploadMode;
  onUploadModeSaved: (mode: ContactUploadMode) => void;
  /**
   * Можно ли выбрать «Рассылку» для нового автоаутрича проекта (GET /outreach,
   * без писем — их проверяет обзор по каждой гипотезе). Нет — переключателя
   * нет, только Instantly.
   */
  senderOption?: VeSenderOption | null;
  /** Перечитать доступность «Рассылки» (опрос проекта) — для «Повторить проверку», когда её не прочитали. */
  onSenderOptionReload?: () => void;
}) {
  const firstPreparation = snapshot.preparations.find(
    (p) => p.hypothesis_id === hypothesisIds[0],
  );
  const first = templates.find((t) => t.id === firstPreparation?.template_id) ?? null;
  const [preflightState, setPreflightState] = useState<{ key: string; result: Preflight } | null>(null);
  const [confirmedKey, setConfirmedKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** Ошибка проверки обзора (не старта): показываем рядом с «Повторить проверку» и только пока проверка возможна. */
  const [preflightError, setPreflightError] = useState('');
  const [uploadModePending, setUploadModePending] = useState(false);
  const onUploadModePending = useCallback((pending: boolean) => {
    setUploadModePending(pending);
    if (pending) setConfirmedKey(null);
  }, []);
  const [retry, setRetry] = useState(0);
  /** Новая проверка без повтора упавших аудитов: «Повторить проверку» доступности «Рассылки». */
  const [recheck, setRecheck] = useState(0);
  /**
   * Где создать кампании этого запуска — выбор специалиста (этап 7), по
   * умолчанию Instantly. Панель пересоздаётся для каждого состава гипотез —
   * выбор тоже. Экран выбор не меняет никогда, даже при отказе «Рассылки».
   */
  const [choice, setChoice] = useState<'instantly' | 'sender'>('instantly');
  /** Отказ сервера «Рассылке» (обзор или старт) — у переключателя, пока специалист не сменит выбор. */
  const [senderRefusal, setSenderRefusal] = useState<{ message: string; retryable: boolean; option: VeSenderOption | null | undefined } | null>(null);
  /**
   * Старт ушёл, ответа нет: ключ согласования именно того запроса. Повтор безопасен
   * только тем же запросом (сервер отвечает на повтор по ключу запуска раньше любых
   * проверок); другой запрос — уже не повтор, и замок к нему не относится.
   */
  const [unansweredKey, setUnansweredKey] = useState<string | null>(null);
  /** Последний senderOption — отказ запоминает, при каком ответе проекта пришёл (в замыканиях он мог устареть). */
  const latestSenderOption = useRef<VeSenderOption | null | undefined>(senderOption);
  useEffect(() => { latestSenderOption.current = senderOption; }, [senderOption]);
  // Более новый ответ проекта снимает прежний отказ: без повтора — всегда (можно — проверим заново,
  // нельзя — покажем нынешнюю причину); «не удалось проверить» — когда ответ проекта точный «нельзя».
  const refusalStale = senderRefusal !== null && senderOption != null && senderOption !== senderRefusal.option
    && (!senderRefusal.retryable || (!senderOption.allowed && !senderOption.retryable));
  const activeRefusal = refusalStale ? null : senderRefusal;
  const senderSwitch = veLaunchTransportSwitchView({ choice, option: senderOption, refusal: activeRefusal?.message ?? null });
  const retryRequest = useRef(0);
  const idempotency = useRef<{ key: string; id: string } | null>(null);
  const onAuditRejected = useCallback(() => setPreflightState(null), []);
  const launch = useTemplateLaunch(
    first,
    // prepare-launch owns both the audit and delivery preview. A second preview
    // request can race the unfinished audit and leave a stale error in the form.
    null,
    onAuditRejected,
  );
  const openForm = launch.openForm;
  // По id, не по объекту: опрос проекта заменяет объекты шаблонов, а openForm
  // каждый раз перечитывает доступность «Рассылки» (здесь она — из senderOption).
  const firstId = first?.id ?? null;
  useEffect(() => {
    const timer = setTimeout(() => {
      if (firstId) openForm();
    }, 0);
    return () => clearTimeout(timer);
  }, [firstId, openForm]);
  useEffect(() => {
    onPresetChange(launch.presetId);
  }, [launch.presetId, onPresetChange]);
  const rateTemplates = snapshot.preparations.filter(p => hypothesisIds.includes(p.hypothesis_id) && p.template_id)
    .map(p => p.template_id!).sort();
  const rateKey = `${launch.presetId}/${rateTemplates.join(',')}`;
  const [rateReady, setRateReady] = useState<{key: string; revision: number} | null>(null);
  const onRateReady = useCallback((revision: number | null) => setRateReady(revision == null ? null : {key: rateKey, revision}), [rateKey]);
  const rateRevision = rateReady?.key === rateKey ? rateReady.revision : null;
  const request = useMemo<VeOutreachLaunchRequest | null>(() => {
    // null — проект Portal без периодов; undefined — проект сейчас выбрать нельзя.
    if (!launch.presetId || !launch.portalProjectId || launch.expectedPortalPeriodId === undefined || !launch.targetContacts || !rateRevision || uploadModePending)
      return null;
    const ids = hypothesisIds;
    if (!ids.length) return null;
    const items: VeOutreachLaunchRequest['items'] = [];
    for (const id of ids) {
      if (!getVeLaunchSelectionState(snapshot, templates, id).ready) return null;
      const p = snapshot.preparations.find((row) => row.hypothesis_id === id);
      if (!p?.base_id || !p.template_id || p.status !== 'ready') return null;
      const review = snapshot.reviews[p.base_id],
        approval = snapshot.setup.approved_bases[p.base_id];
      if (!review || approval?.revision !== review.revision || approval.template_id !== p.template_id) return null;
      items.push({
        hypothesis_id: id,
        base_id: p.base_id,
        template_id: p.template_id,
        preview_revision: review.revision,
      });
    }
    return {
      setup_revision: snapshot.setup.revision,
      preset_id: launch.presetId,
      delivery_rate_revision: rateRevision,
      portal_project_id: launch.portalProjectId,
      expected_portal_period_id: launch.expectedPortalPeriodId,
      target_contacts: launch.targetContacts,
      items,
      // Только «Рассылка»: у Instantly запрос (и его хеш у повторов) прежний.
      ...(choice === 'sender' ? { expected_transport: 'sender' as const } : {}),
    };
  }, [snapshot, hypothesisIds, templates, launch.presetId, launch.portalProjectId, launch.expectedPortalPeriodId, launch.targetContacts, rateRevision, uploadModePending, choice]);
  const requestKey = request ? JSON.stringify(request) : '';
  const preflightKey = requestKey ? `${uploadMode}/${requestKey}` : '';
  // Выбрана «Рассылка», а она закрыта: обзор не запрашиваем и прежний не показываем —
  // кроме повтора старта без ответа тем же запросом.
  const senderBlocked = senderSwitch.blocked;
  const rawPreflight = preflightState?.key === preflightKey ? preflightState.result : null;
  const rawConfirmationKey = rawPreflight?.ready
    ? preflightKey + JSON.stringify(rawPreflight.items.map((i) => i.segmentation_audit_id)) + (rawPreflight.transport ?? '')
    : '';
  const replayPending = unansweredKey !== null && unansweredKey === rawConfirmationKey;
  const preflight = !senderBlocked || replayPending ? rawPreflight : null;
  const confirmationKey = preflight ? rawConfirmationKey : '';
  // Пока ждём повтора того же запроса, выбор держим. «Рассылку» тем временем закрыли — выбор
  // открыт (можно Instantly); принятый запуск сервер при новом старте назовёт сам.
  const switchLocked = busy || (replayPending && !senderBlocked);
  const blockedForStart = senderBlocked && !replayPending;
  const UNANSWERED_TEXT = 'Ответ о запуске не получен. Повторное нажатие безопасно: используем тот же запрос.';
  const shownError = error || (!senderBlocked ? preflightError : '') || (replayPending && !busy ? UNANSWERED_TEXT : '');
  useEffect(() => {
    if (!requestKey || senderBlocked) return;
    const input = JSON.parse(requestKey) as VeOutreachLaunchRequest;
    let cancelled = false,
      inFlight = false;
    const check = async () => {
      if (inFlight || cancelled) return;
      inFlight = true;
      try {
        const explicitRetry = retry > retryRequest.current;
        retryRequest.current = retry;
        const result = await veEnginePost<Preflight>(`${VE_API}/projects/${projectId}/outreach/prepare-launch`, {
          ...input,
          ...(explicitRetry ? { retry_failed_audits: true } : {}),
        });
        if (cancelled) return;
        if (!result.ok) {
          setPreflightState(null);
          clearInterval(timer);
          // Отказ «Рассылке» — по коду, не по статусу: причина у переключателя, не «Повторить проверку» аудитов.
          const refusal = input.expected_transport === 'sender' ? veSenderRefusal(result.data) : null;
          if (refusal) {
            setPreflightError('');
            setSenderRefusal({ ...refusal, option: latestSenderOption.current });
            return;
          }
          setPreflightError(result.data.error ?? 'Не удалось проверить запуск');
          return;
        }
        setPreflightError('');
        setPreflightState({ key: preflightKey, result: result.data });
        if (result.data.ready || result.data.items.some((i) => i.status === 'blocked')) clearInterval(timer);
      } catch {
        if (!cancelled) {
          setPreflightState(null);
          setPreflightError('Не удалось проверить запуск. Повторите проверку');
          clearInterval(timer);
        }
      } finally {
        inFlight = false;
      }
    };
    const timer = setInterval(() => void check(), 4000);
    void check();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [projectId, requestKey, preflightKey, retry, recheck, senderBlocked]);
  // Обзор — именно выбранного способа (нет поля — Instantly).
  const preflightMatchesChoice = (preflight?.transport ?? 'instantly') === choice;
  const start = async () => {
    if (!request || !preflight?.ready || !preflightMatchesChoice || blockedForStart || confirmedKey !== confirmationKey || busy) return;
    if (idempotency.current?.key !== confirmationKey)
      idempotency.current = { key: confirmationKey, id: crypto.randomUUID() };
    setBusy(true);
    setError('');
    try {
      const result = await veEnginePost<{ run?: VeOutreachRun; error?: string; code?: string }>(
        `${VE_API}/projects/${projectId}/outreach/start`,
        {
          ...request,
          items: preflight.items.map(
            ({ hypothesis_id, base_id, template_id, preview_revision, segmentation_audit_id }) => ({
              hypothesis_id,
              base_id,
              template_id,
              preview_revision,
              segmentation_audit_id,
            }),
          ),
          // expected_transport уже в request — только для «Рассылки».
          idempotency_key: idempotency.current.id,
          confirmed_customer_approval: true,
        },
      );
      setUnansweredKey(null);
      if (!result.ok || !result.data.run) {
        const refusal = request.expected_transport === 'sender' ? veSenderRefusal(result.data) : null;
        if (refusal) {
          // Выбор не меняем, причина — у переключателя. 409: обзор и согласование этого выбора
          // больше не годятся; 503: оставляем — «Повторить проверку» повторит.
          setSenderRefusal({ ...refusal, option: latestSenderOption.current });
          if (!refusal.retryable) {
            setPreflightState(null);
            setConfirmedKey(null);
          }
          return;
        }
        setError(veSenderRefusalText(result.data.error ?? 'Не удалось сохранить запуск', result.data.code));
        return;
      }
      onStarted(result.data.run);
    } catch {
      // Текст — из ключа (shownError): виден, пока жив тот же запрос.
      setUnansweredKey(confirmationKey);
      setError('');
    } finally {
      setBusy(false);
    }
  };
  /** Специалист выбрал, где создать кампании: новый запрос — новый обзор и новое согласование. */
  const selectTransport = (transport: 'instantly' | 'sender') => {
    if (switchLocked) return;
    setChoice(transport);
    setSenderRefusal(null);
    setError('');
    setPreflightError('');
    setConfirmedKey(null);
  };
  /** «Повторить проверку» после 503: тот же запрос, новая проверка без повтора аудитов. */
  const retrySenderCheck = () => {
    setSenderRefusal(null);
    setRecheck((value) => value + 1);
  };
  const preset = launch.presets?.find((p) => p.id === launch.presetId);
  const sender = choice === 'sender';
  // Ящики пресета в «Рассылке» одни на весь запуск; 0 рабочих — запуск откажет, не даём его начать.
  const senderPoolEmpty = sender && !!preflight?.items.some((item) => item.preview?.sender_pool?.ready === 0);
  const selectionBlocked = !hypothesisIds.length || hypothesisIds.some((id) => !getVeLaunchSelectionState(snapshot, templates, id).ready);
  if (!first || selectionBlocked) return (
    <section className="space-y-3">
      <StatusBox tone="info">Выберите готовые и одобренные базы на шаге «Базы и объём».</StatusBox>
      {hypothesisIds.map((id) => <p key={id} className={HE.muted}>
        {titles[id] ?? 'Гипотеза'}: {getVeLaunchSelectionState(snapshot, templates, id).label}.
      </p>)}
      <button type="button" className={HE.btnGhost} onClick={onBack}>К выбору баз</button>
    </section>
  );
  return (
    <section className="space-y-5">
      <div className="space-y-2">
        <h2 className="ve2-h2">Базы этого запуска: {hypothesisIds.length}</h2>
        <ul className="space-y-1">
          {hypothesisIds.map((id) => <li key={id}>{titles[id] ?? 'Гипотеза'}</li>)}
        </ul>
        <p className={HE.muted}>Остальные базы проекта в этот запуск не входят.</p>
        <button type="button" className={HE.btnQuiet} disabled={busy} onClick={onBack}>Изменить состав запуска</button>
      </div>
      <h2 className="ve2-h2">Клиент и отправители</h2>
      {launch.loadError ? <StatusBox tone="error">{launch.loadError}</StatusBox> : null}
      <SearchableSelect
        id="ve2-outreach-client"
        label="Клиент"
        value={launch.presetId}
        options={launch.presets ?? []}
        disabled={!!launch.boundPresetId || busy}
        onChange={launch.setPresetId}
        placeholder="Выберите клиента"
      />
      {preset ? (
        <p className={HE.muted}>
          {preset.instantly_account_label} ·{' '}
          {preset.mailbox_tags.map((t) => t.name).join(', ') || 'Сохранённый набор почт'} · отправителей:{' '}
          {preset.mailbox_count}
        </p>
      ) : null}
      {launch.canCreateClient && !launch.boundPresetId ? (
        <fieldset disabled={busy}>
          <CreateClientPresetInline launch={launch} templateId={first.id} />
        </fieldset>
      ) : null}
      <LaunchTransportSwitch choice={choice} view={senderSwitch} busy={switchLocked} onChange={selectTransport}
        onRetry={activeRefusal?.retryable ? retrySenderCheck
          : !activeRefusal && senderOption?.retryable && onSenderOptionReload ? onSenderOptionReload : undefined} />
      <DeliveryPlanBlock launch={launch} disabled={busy} uploadMode={uploadMode} preparedPreview={preflight?.items[0]?.preview ?? null} />
      <ContactUploadModePanel projectId={projectId} mode={uploadMode} disabled={busy} sender={sender}
        onSaved={onUploadModeSaved} onPendingChange={onUploadModePending} />
      {launch.presetId && rateTemplates.length ? <DeliveryRatePanel key={rateKey} projectId={projectId}
        presetId={launch.presetId} templateIds={rateTemplates} disabled={busy} onReady={onRateReady} supplyOnly={uploadMode === 'all_ready'}
        hintReload={recheck} transport={choice} /> : null}
      <div className="border-t border-[var(--ve2-line)] pt-5 space-y-3">
        <h2 className="ve2-h2">Обзор запуска</h2>
        {!request ? (
          <p className={HE.muted}>{uploadModePending ? 'Примените выбранный режим загрузки.' : 'Выберите клиента, проект и цель контактов, затем примените темп.'}</p>
        ) : blockedForStart ? (
          <p className={HE.muted}>Обзор не строится: «Рассылку» сейчас выбрать нельзя — причина выше, в «Где создать кампании».</p>
        ) : !preflight && !error && !preflightError ? (
          <p role="status">Проверяем аудиторию и настройки отправки…</p>
        ) : null}
        {preflight?.items.map((item) => (
          <div key={item.hypothesis_id} className="border-b border-[var(--ve2-line)] py-3">
            <h3 className="ve2-h3">{titles[item.hypothesis_id] ?? 'Гипотеза'}</h3>
            <p className={HE.muted}>
              {item.status === 'ready'
                ? 'Готово к запуску'
                : item.status === 'working'
                  ? 'Проверяем получателей…'
                  : item.error}
            </p>
            {item.status === 'ready' ? (
              <p className={HE.muted}>
                Будет создано кампаний:{' '}
                {item.summary
                  ? item.summary.segments.filter((s) => s.count > 0).length + (item.summary.default.count > 0 ? 1 : 0)
                  : '—'}{' '}
                · новых готовых контактов: {item.preview?.prospective_ready ?? '—'}
              </p>
            ) : null}
          </div>
        ))}
        {preflight?.ready && sender ? (
          <p className={HE.muted}>
            {uploadMode === 'all_ready'
              ? 'Система создаст в «Рассылке» черновики кампаний и начнёт загружать весь готовый запас в пределах общей цели проекта. Новые готовые контакты будут добавляться автоматически.'
              : 'Система создаст в «Рассылке» черновики кампаний и загрузит первую порцию контактов по плану. После запуска ежедневная дозаливка продолжится автоматически.'}
            {' '}Проверьте черновики и запустите их на карточке кампании или в «Рассылке».
          </p>
        ) : preflight?.ready ? (
          <p className={HE.muted}>
            {uploadMode === 'all_ready'
              ? 'Система создаст кампании без отправки и начнёт загружать весь готовый запас в пределах общей цели проекта. Новые готовые контакты будут добавляться автоматически.'
              : 'Система создаст кампании в Instantly без отправки и загрузит первую порцию контактов по плану. После запуска ежедневная дозаливка продолжится автоматически.'}
            {' '}Проверьте кампании и нажмите Start в Instantly.
          </p>
        ) : null}
        {shownError ? <StatusBox tone="error">{shownError}</StatusBox> : null}
        {/* Пока «Рассылка» закрыта, проверка не идёт — кнопка ничего бы не сделала. */}
        {!senderBlocked && (error || preflightError || preflight?.items.some((i) => i.status === 'blocked')) ? (
          <button type="button" className={HE.btnGhost} onClick={() => setRetry((v) => v + 1)} disabled={busy}>
            Повторить проверку
          </button>
        ) : null}
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            className="ve2-cbx mt-1"
            disabled={!preflight?.ready || busy}
            checked={!!confirmationKey && confirmedKey === confirmationKey}
            onChange={(event) => setConfirmedKey(event.target.checked ? confirmationKey : null)}
          />
          <span>Базы, письма и сегменты согласованы с заказчиком. Подтверждаю подготовку кампаний без отправки.</span>
        </label>
        <button
          type="button"
          className={HE.btnPrimary}
          disabled={
            busy || !preflight?.ready || !confirmationKey || confirmedKey !== confirmationKey || !preset?.mailbox_count
            || senderPoolEmpty || blockedForStart || !preflightMatchesChoice
          }
          onClick={() => void start()}
        >
          {busy ? 'Сохраняем запрос…' : sender ? 'Подготовить черновики в «Рассылке»' : 'Подготовить кампании в Instantly'}
        </button>
      </div>
    </section>
  );
}
