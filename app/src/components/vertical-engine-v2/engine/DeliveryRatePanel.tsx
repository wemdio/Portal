'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { authFetch } from '@/lib/authFetch';
import type { DeliveryRateRow, DeliveryRateSnapshot } from '@/lib/verticalEngineV2/contactDeliveryRate';
import { senderPaceWarning, senderPoolLine, type VeSenderPoolSummary } from '@/lib/verticalEngineV2/senderTransport/labels';
import { VE_API, veEnginePost } from './api';
import { HE } from './design';
import { StatusBox } from './ui';

type RateResponse = { rate: DeliveryRateRow | null; revision: number; snapshot: DeliveryRateSnapshot; bound: boolean; error?: string;
  /** Только у запуска в «Рассылку»: темп выше — по почтам Instantly, отправляют ящики «Рассылки». */
  transport?: 'sender'; sender_pool?: VeSenderPoolSummary | null };
/** Подсказка о «Рассылке» отдельно от расчёта: её перечитывают, не трогая принятый темп. */
type SenderHint = { identity: string; transport?: 'sender'; sender_pool?: VeSenderPoolSummary | null };

export function DeliveryRatePanel({
  projectId, presetId, templateIds, disabled = false, onReady, supplyOnly = false, hintReload = 0, transport,
}: {
  projectId: string; presetId: string; templateIds: string[]; disabled?: boolean;
  onReady?: (revision: number | null) => void; supplyOnly?: boolean;
  /** Перечитать только подсказку о «Рассылке», не трогая принятый темп. */
  hintReload?: number;
  /**
   * Способ отправки запуска: выбор специалиста (новый запуск) или способ
   * идущего. Нет — как скажет сервер по записанным запускам. Ни в ключ, ни в
   * основной расчёт не входит: смена способа не сбрасывает принятый темп.
   */
  transport?: 'instantly' | 'sender';
}) {
  const id = useId();
  const [data, setData] = useState<RateResponse | null>(null);
  const [mode, setMode] = useState<'auto' | 'manual'>('auto');
  const [limit, setLimit] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [dirty, setDirty] = useState(false);
  const ids = [...new Set(templateIds)].sort().join(',');
  const callback = useRef(onReady);
  useEffect(() => { callback.current = onReady; }, [onReady]);
  const identity = `${projectId}/${presetId}/${ids}`;
  const currentIdentity = useRef(identity);
  useEffect(() => { currentIdentity.current = identity; return () => { currentIdentity.current = ''; }; }, [identity]);

  useEffect(() => {
    const controller = new AbortController();
    callback.current?.(null);
    // Synchronize loading state with this new remote request.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setData(null); setError(''); setBusy(true); setDirty(false);
    const query = new URLSearchParams({ preset_id: presetId, template_ids: ids });
    void authFetch(`${VE_API}/projects/${projectId}/delivery-rate?${query}`, { signal: controller.signal })
      .then(async response => {
        const result = await response.json() as RateResponse;
        if (!response.ok) throw new Error(result.error ?? 'Не удалось рассчитать темп');
        if (controller.signal.aborted) return;
        setData(result); setMode(result.rate?.mode ?? 'auto');
        setLimit(result.rate?.manual_limit == null ? '' : String(result.rate.manual_limit));
        const saved = result.rate;
        if (saved && ids.split(',').every(t => saved.template_ids.includes(t)) && saved.status === 'ready'
          && Date.now() - Date.parse(saved.snapshot.checked_at) < 10 * 60_000) callback.current?.(saved.revision);
      })
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Расчёт недоступен'); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [projectId, presetId, ids, reload]);

  const [hint, setHint] = useState<SenderHint | null>(null);
  useEffect(() => {
    if (!hintReload && transport !== 'sender') return;
    const controller = new AbortController();
    // transport=sender — только отсюда: сервер берёт его, когда записанных запусков нет.
    const query = new URLSearchParams({ preset_id: presetId, template_ids: ids, ...(transport === 'sender' ? { transport: 'sender' } : {}) });
    const hintIdentity = `${projectId}/${presetId}/${ids}`;
    void authFetch(`${VE_API}/projects/${projectId}/delivery-rate?${query}`, { signal: controller.signal })
      .then(async response => {
        const result = await response.json() as RateResponse;
        if (!response.ok || controller.signal.aborted) return;
        setHint({ identity: hintIdentity, transport: result.transport, sender_pool: result.sender_pool });
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [projectId, presetId, ids, hintReload, transport]);
  // Свежая подсказка этого набора — главнее подсказки из расчёта.
  const senderSource = hint?.identity === identity ? hint : data;
  const showSender = (transport ?? senderSource?.transport) === 'sender';
  // Сервер прислал ящики «Рассылки» — sender_pool есть (null — проверить не вышло); иначе ещё не знаем.
  const senderPoolKnown = senderSource?.transport === 'sender';
  const senderPool = senderPoolKnown ? senderSource?.sender_pool : undefined;

  const invalidate = () => { setDirty(true); callback.current?.(null); };
  const manual = Number(limit);
  const valid = mode === 'auto' || (limit.trim() !== '' && Number.isSafeInteger(manual) && manual > 0 && manual <= 100_000);
  const snapshot = data?.snapshot;
  const cap = snapshot ? mode === 'manual' && valid ? Math.min(snapshot.max_new_contacts, manual) : snapshot.max_new_contacts : null;
  const save = async () => {
    if (!data || !valid || busy || disabled) return;
    const savingIdentity = identity;
    setBusy(true); setError(''); callback.current?.(null);
    try {
      const response = await veEnginePost<{rate: DeliveryRateRow; error?: string}>(`${VE_API}/projects/${projectId}/delivery-rate`, {
        preset_id: presetId, template_ids: ids.split(','), mode, manual_limit: mode === 'manual' ? manual : null,
        expected_revision: data.revision,
      });
      if (currentIdentity.current !== savingIdentity) return;
      if (!response.ok || !response.data.rate) throw new Error(response.data.error ?? 'Не удалось сохранить темп');
      const rate = response.data.rate;
      // От текущего состояния, а не от снятого при клике: подсказка о «Рассылке» могла обновиться, пока шло сохранение.
      setData(current => ({ ...(current ?? data), rate, revision: rate.revision, snapshot: rate.snapshot })); setDirty(false);
      // Pending changes for a bound project are applied by the worker before any new upload.
      callback.current?.(rate.revision);
    } catch (reason) {
      if (currentIdentity.current === savingIdentity) setError(reason instanceof Error ? reason.message : 'Не удалось сохранить темп');
    } finally { if (currentIdentity.current === savingIdentity) setBusy(false); }
  };
  return <section className="border-t border-[var(--ve2-line)] pt-5 space-y-3" aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`} className="ve2-h3">{supplyOnly ? 'Темп добора' : 'Дневной лимит загрузки'}</h3>
    <p className={HE.muted}>{supplyOnly
      ? 'Для расчёта запаса. Загрузку готовых контактов не ограничивает.'
      : 'Общий лимит для всех кампаний проекта.'}</p>
    <fieldset disabled={busy || disabled} className="space-y-3">
      <legend className="sr-only">{supplyOnly ? 'Режим расчёта запаса' : 'Режим дневного лимита'}</legend>
      <label className="flex items-start gap-2"><input type="radio" name={id} checked={mode === 'auto'} onChange={() => { setMode('auto'); invalidate(); }} className="mt-1" />
        <span>Автоматически</span></label>
      <label className="flex items-start gap-2"><input type="radio" name={id} checked={mode === 'manual'} onChange={() => { setMode('manual'); invalidate(); }} className="mt-1" />
        <span>Ограничить вручную</span></label>
      {mode === 'manual' ? <div className="max-w-sm space-y-1">
        <label htmlFor={`${id}-limit`} className="block text-sm">{supplyOnly ? 'Контактов в день' : 'Не больше новых контактов в день'}</label>
        <input id={`${id}-limit`} type="number" inputMode="numeric" min={1} max={100000} step={1} value={limit}
          className={HE.input} aria-invalid={!valid} onChange={event => { setLimit(event.target.value); invalidate(); }} />
        {!valid ? <p className="text-sm text-red-500">Укажите целое число от 1 до 100 000.</p> : null}
      </div> : null}
    </fieldset>
    {snapshot ? <div className="space-y-1">
      <p><strong>{supplyOnly ? 'Ориентир: ' : 'До '}{valid ? cap : snapshot.max_new_contacts} новых контактов в день</strong></p>
      {snapshot.max_new_contacts === 0 ? <p className={HE.muted}>Проверьте почты и их лимиты в Instantly, затем обновите расчёт.</p> : <>
        {snapshot.busy_mailboxes > 0 ? <p className={HE.muted}>Почты используются и в других кампаниях. Фактический темп может быть ниже.</p> : null}
        {snapshot.unavailable_mailboxes > 0 ? <p className={HE.muted}>Часть почт недоступна. В расчёте: {snapshot.usable_mailboxes} из {snapshot.mailbox_count}.</p> : null}
        {snapshot.slow_ramp_mailboxes > 0 ? <p className={HE.muted}>На {snapshot.slow_ramp_mailboxes} почтах включён разгон, поэтому темп снижен.</p> : null}
      </>}
    </div> : busy ? <p role="status">Проверяем отправителей в Instantly…</p> : null}
    {snapshot && showSender ? <div className="space-y-1">
      <p className={HE.muted}>Темп считается по лимитам почт в Instantly, а отправлять будет «Рассылка».{senderPoolKnown
        ? ` ${senderPoolLine(senderPool)}` : ''}</p>
      {!supplyOnly && senderPaceWarning(valid ? cap : snapshot.max_new_contacts, senderPool)
        ? <p className="text-sm text-amber-700">{senderPaceWarning(valid ? cap : snapshot.max_new_contacts, senderPool)}</p> : null}
    </div> : null}
    {data?.rate && !dirty ? <p role="status" className={HE.muted}>{data.rate.status === 'ready'
      ? 'Темп сохранён.' : data.rate.status === 'blocked'
        ? supplyOnly ? 'Расчёт добора отложен. Повторим автоматически.' : 'Загрузка отложена. Повторим расчёт автоматически.'
        : supplyOnly ? 'Темп сохранён.' : 'Темп сохранён для следующих загрузок.'}</p> : null}
    {error ? <StatusBox tone="error">{error}</StatusBox> : null}
    <div className="flex flex-wrap gap-3">
      <button type="button" className={HE.btnGhost} disabled={disabled || busy || !data || !valid || !cap} onClick={() => void save()}>{busy ? 'Проверяем…' : 'Применить темп'}</button>
      <button type="button" className={HE.btnQuiet} disabled={disabled || busy} onClick={() => setReload(value => value + 1)}>Обновить расчёт</button>
    </div>
  </section>;
}
