'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { authFetch } from '@/lib/authFetch';
import type { DeliveryRateRow, DeliveryRateSnapshot } from '@/lib/verticalEngineV2/contactDeliveryRate';
import { VE_API, veEnginePost } from './api';
import { HE } from './design';
import { StatusBox } from './ui';

type RateResponse = { rate: DeliveryRateRow | null; revision: number; snapshot: DeliveryRateSnapshot; bound: boolean; error?: string };

export function DeliveryRatePanel({ projectId, presetId, templateIds, disabled = false, onReady }: {
  projectId: string; presetId: string; templateIds: string[]; disabled?: boolean;
  onReady?: (revision: number | null) => void;
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
      setData({ ...data, rate, revision: rate.revision, snapshot: rate.snapshot }); setDirty(false);
      // Pending changes for a bound project are applied by the worker before any new upload.
      callback.current?.(rate.revision);
    } catch (reason) {
      if (currentIdentity.current === savingIdentity) setError(reason instanceof Error ? reason.message : 'Не удалось сохранить темп');
    } finally { if (currentIdentity.current === savingIdentity) setBusy(false); }
  };
  return <section className="border-t border-[var(--ve2-line)] pt-5 space-y-3" aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`} className="ve2-h3">Темп новых контактов</h3>
    <p className={HE.muted}>Общий лимит для всех запусков этого проекта. До дедлайна дневной план учитывает оставшуюся цель и рабочие дни. После дедлайна пополнение продолжается в выбранном темпе до достижения цели. Пауза кампании в Instantly останавливает дозагрузку.</p>
    <fieldset disabled={busy || disabled} className="space-y-3">
      <legend className="sr-only">Режим дневного лимита</legend>
      <label className="flex items-start gap-2"><input type="radio" name={id} checked={mode === 'auto'} onChange={() => { setMode('auto'); invalidate(); }} className="mt-1" />
        <span>Автоматически <span className={HE.muted}>— по доступным отправителям, с запасом для продолжений цепочки</span></span></label>
      <label className="flex items-start gap-2"><input type="radio" name={id} checked={mode === 'manual'} onChange={() => { setMode('manual'); invalidate(); }} className="mt-1" />
        <span>Ограничить вручную</span></label>
      {mode === 'manual' ? <div className="max-w-sm space-y-1">
        <label htmlFor={`${id}-limit`} className="block text-sm">Не больше новых контактов в день</label>
        <input id={`${id}-limit`} type="number" inputMode="numeric" min={1} max={100000} step={1} value={limit}
          className={HE.input} aria-invalid={!valid} onChange={event => { setLimit(event.target.value); invalidate(); }} />
        {!valid ? <p className="text-sm text-red-500">Укажите целое число от 1 до 100 000.</p> : null}
      </div> : null}
    </fieldset>
    {snapshot ? <div className="space-y-1">
      <p><strong>До {valid ? cap : snapshot.max_new_contacts} новых контактов в день</strong></p>
      <p className={HE.muted}>Доступно почт: {snapshot.usable_mailboxes} из {snapshot.mailbox_count}. В расчёте — до {snapshot.sequence_steps} писем на контакт, включая продолжения.</p>
      {snapshot.busy_mailboxes > 0 ? <p className={HE.muted}>Почт, используемых также в других активных кампаниях: {snapshot.busy_mailboxes}. Это допустимо: Instantly делит общий дневной лимит каждой почты между кампаниями. Фактический темп здесь может быть ниже расчётного.</p> : null}
      {snapshot.max_new_contacts === 0 ? <p className={HE.muted}>Сейчас лимиты и состояние почт не позволяют добавлять новые контакты. Проверьте их в Instantly, затем обновите расчёт.</p> : null}
      {snapshot.unavailable_mailboxes > 0 ? <p className={HE.muted}>Недоступно или не настроено почт: {snapshot.unavailable_mailboxes}.</p> : null}
      {snapshot.slow_ramp_mailboxes > 0 ? <p className={HE.muted}>У {snapshot.slow_ramp_mailboxes} почт включён постепенный разгон. Instantly не сообщает текущую ступень: учитываем по 2 письма в день, пока разгон включён.</p> : null}
      <p className={HE.muted}>Это верхняя граница, а не обещание отправки. Лимиты самих почт не повышаются. Расчёт обновляется перед очередной загрузкой.</p>
    </div> : busy ? <p role="status">Проверяем отправителей в Instantly…</p> : null}
    {data?.rate && !dirty ? <p role="status" className={HE.muted}>{data.rate.status === 'ready'
      ? 'Темп сохранён.' : data.rate.status === 'blocked' ? 'Новая загрузка отложена: система повторит проверку темпа.'
        : 'Темп сохранён. Система применит его перед следующей загрузкой.'}</p> : null}
    {data?.bound ? <p className={HE.muted}>Уже загруженные и зарезервированные контакты не загружаются заново. Новый лимит действует на следующие порции; сегодняшняя зарезервированная порция остаётся прежней.</p> : null}
    {error ? <StatusBox tone="error">{error}</StatusBox> : null}
    <div className="flex flex-wrap gap-3">
      <button type="button" className={HE.btnGhost} disabled={disabled || busy || !data || !valid || !cap} onClick={() => void save()}>{busy ? 'Проверяем…' : 'Применить темп'}</button>
      <button type="button" className={HE.btnQuiet} disabled={disabled || busy} onClick={() => setReload(value => value + 1)}>Обновить расчёт</button>
    </div>
  </section>;
}
