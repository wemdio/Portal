'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { authFetch } from '@/lib/authFetch';
import { contactTargetDailyPlan, parseContactTarget, type ContactTargetState } from '@/lib/verticalEngineV2/contactDeliveryTarget';
import { VE_API, veEnginePost } from './api';
import { HE } from './design';
import { StatusBox } from './ui';

const number = (value: number) => value.toLocaleString('ru-RU');
export function DeliveryTargetPanel({ projectId, disabled = false, onSaved }: {
  projectId: string; disabled?: boolean; onSaved?: () => void;
}) {
  const id = useId();
  const [plan, setPlan] = useState<ContactTargetState | null>(null);
  const [value, setValue] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [reload, setReload] = useState(0);
  const identity = useRef(projectId);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { identity.current = projectId; return () => { identity.current = ''; }; }, [projectId]);
  useEffect(() => { if (editing) input.current?.focus(); }, [editing]);
  useEffect(() => {
    const controller = new AbortController();
    // Load a new project/explicit refresh, never overwrite typing on parent polling.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBusy(true); setPlan(null); setError(''); setEditing(false); setSaved(false);
    void authFetch(`${VE_API}/projects/${projectId}/delivery-target`, { signal: controller.signal })
      .then(async response => {
        const result = await response.json() as { plan?: ContactTargetState; error?: string };
        if (!response.ok || !result.plan) throw new Error(result.error ?? 'Не удалось прочитать цель проекта.');
        if (!controller.signal.aborted) { setPlan(result.plan); setValue(String(result.plan.target_contacts)); }
      })
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'План недоступен.'); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [projectId, reload]);
  const target = parseContactTarget(value);
  const valid = target !== null && plan !== null && target >= plan.minimum_target;
  let daily: number | null = null;
  if (plan && target !== null) {
    try { daily = contactTargetDailyPlan(plan, target); } catch { /* Term will be checked again on save. */ }
  }
  const save = async () => {
    if (!valid || !plan || busy || disabled || !plan.can_edit || target === plan.target_contacts) return;
    setBusy(true); setError(''); setSaved(false);
    try {
      const result = await veEnginePost<{ plan?: ContactTargetState; error?: string }>(`${VE_API}/projects/${projectId}/delivery-target`, {
        target_contacts: target, expected_target: plan.target_contacts, expected_revision: plan.revision,
      });
      if (identity.current !== projectId) return;
      if (!result.ok || !result.data.plan) throw new Error(result.data.error ?? 'Не удалось сохранить цель.');
      setPlan(result.data.plan); setValue(String(result.data.plan.target_contacts)); setEditing(false); setSaved(true);
      onSaved?.();
    } catch (reason) { if (identity.current === projectId) setError(reason instanceof Error ? reason.message : 'Не удалось сохранить цель.'); }
    finally { if (identity.current === projectId) setBusy(false); }
  };
  return <section aria-labelledby={`${id}-title`} className="border-t border-[var(--ve2-line)] pt-5 space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h3 id={`${id}-title`} className="ve2-h3">Общая цель проекта{plan && !editing ? `: ${number(plan.target_contacts)} контактов` : ''}</h3>
      {plan && !editing ? <button type="button" className={HE.btnGhost} disabled={busy || disabled || !plan.can_edit}
        onClick={() => { setEditing(true); setError(''); setSaved(false); }}>Изменить цель</button> : null}
    </div>
    <p className={HE.muted}>Одна цель для всех запущенных гипотез проекта. В выполнение засчитываются получатели первого письма, а не просто собранные адреса.</p>
    {plan ? <>
      <p className={HE.muted}>Выполнено: {number(plan.actual_contacted)}. Передано в загрузку: {number(plan.committed_contacts)}. Зарезервировано: {number(plan.reserved_contacts)}.</p>
      {!plan.has_period ? <p className={HE.muted}>Здесь учитываются кампании этого проекта вертикалей. Отдельные ручные кампании в расчёт не входят.</p> : null}
      {editing ? <form onSubmit={event => { event.preventDefault(); void save(); }} className="space-y-3">
        <div className="max-w-sm space-y-1">
          <label htmlFor={`${id}-target`} className="block text-sm font-medium">Новая общая цель контактов</label>
          <input ref={input} id={`${id}-target`} type="text" inputMode="numeric" value={value} disabled={busy || disabled}
            className={HE.input} aria-invalid={!valid} aria-describedby={`${id}-hint`}
            onChange={event => { setValue(event.target.value); setError(''); }} />
          <p id={`${id}-hint`} className={valid ? HE.muted : 'text-sm text-red-500'}>{target === null
            ? 'Укажите целое число от 1 до 1 000 000.'
            : `Минимум ${number(plan.minimum_target)}: уже учтённые, загруженные и зарезервированные контакты сохраняются.`}</p>
        </div>
        {valid && daily !== null ? <p>Расчётный дневной план по новой цели: <strong>до {number(daily)} контактов</strong>.</p> : null}
        <p className={HE.muted}>Новая цель изменит будущие порции и добор. Сегодняшний дневной лимит повторно не увеличится. Фактическая загрузка зависит от готового запаса и состояния кампаний.</p>
        <div className="flex flex-wrap gap-3">
          <button type="submit" className={HE.btnPrimary} disabled={busy || disabled || !plan.can_edit || !valid || target === plan.target_contacts}>
            {busy ? 'Сохраняем…' : 'Сохранить цель'}</button>
          <button type="button" className={HE.btnQuiet} disabled={busy} onClick={() => {
            setEditing(false); setValue(String(plan.target_contacts)); setError('');
          }}>Отмена</button>
        </div>
      </form> : daily !== null ? <p className={HE.muted}>Расчётный дневной план: до {number(daily)} контактов. Дедлайн: {plan.deadline.split('-').reverse().join('.')}.</p> : null}
      {!plan.can_edit ? <p role="status" className={HE.muted}>Цель можно изменить после завершения подготовки текущего запуска. Затем обновите план.</p> : null}
    </> : busy ? <p role="status" className={HE.muted}>Загружаем общий план…</p> : null}
    {saved ? <p role="status">Общая цель сохранена. Уже загруженные контакты остаются в кампаниях.</p> : null}
    {error ? <StatusBox tone="error">{error}</StatusBox> : null}
    {error || (plan && !plan.can_edit) ? <button type="button" className={HE.btnQuiet} disabled={busy}
      onClick={() => setReload(current => current + 1)}>Обновить план</button> : null}
  </section>;
}
