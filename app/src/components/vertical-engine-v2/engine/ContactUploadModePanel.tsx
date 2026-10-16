'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { VE_API, veEnginePost } from './api';
import { HE } from './design';
import { StatusBox } from './ui';

export type ContactUploadMode = 'daily' | 'all_ready';

export function ContactUploadModePanel({ projectId, mode, disabled = false, onSaved, onPendingChange }: {
  projectId: string;
  mode: ContactUploadMode;
  disabled?: boolean;
  onSaved: (mode: ContactUploadMode) => void;
  onPendingChange?: (pending: boolean) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState<ContactUploadMode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const identity = useRef(projectId);
  useEffect(() => { identity.current = projectId; return () => { identity.current = ''; }; }, [projectId]);
  const selected = draft ?? mode;
  const dirty = selected !== mode;
  useEffect(() => { onPendingChange?.(dirty || busy); }, [dirty, busy, onPendingChange]);

  const save = async () => {
    if (!dirty || busy || disabled) return;
    setBusy(true); setError(''); setSaved(false);
    try {
      const result = await veEnginePost<{ mode?: ContactUploadMode; error?: string }>(
        `${VE_API}/projects/${projectId}/contact-upload-mode`, { mode: selected, expected_mode: mode },
      );
      if (identity.current !== projectId) return;
      if (!result.ok || !result.data.mode) throw new Error(result.data.error ?? 'Не удалось сохранить режим загрузки.');
      setDraft(null); setSaved(true); onSaved(result.data.mode);
    } catch (reason) {
      if (identity.current === projectId) setError(reason instanceof Error ? reason.message : 'Не удалось сохранить режим загрузки.');
    } finally { if (identity.current === projectId) setBusy(false); }
  };

  return <section className="border-t border-[var(--ve2-line)] pt-5 space-y-3" aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`} className="ve2-h3">Загрузка контактов в Instantly</h3>
    <fieldset className="space-y-3" disabled={busy || disabled} aria-describedby={`${id}-hint`}>
      <legend className="sr-only">Режим загрузки для всех кампаний проекта</legend>
      {([['all_ready', 'Все готовые контакты сразу'], ['daily', 'Дневными порциями']] as const).map(([value, label]) =>
        <label key={value} className="flex items-start gap-2">
          <input type="radio" name={id} value={value} checked={selected === value} className="mt-1"
            onChange={() => { setDraft(value); setSaved(false); setError(''); }} />
          <span>{label}</span>
        </label>)}
    </fieldset>
    <p id={`${id}-hint`} className={HE.muted}>{selected === 'all_ready'
      ? 'Для всех кампаний проекта, в пределах цели и свободного места. Отправку запускаете в Instantly.'
      : 'Дневной лимит для всех кампаний проекта задаётся ниже.'}</p>
    {dirty ? <button type="button" className={HE.btnGhost} disabled={busy || disabled} onClick={() => void save()}>
      {busy ? 'Сохраняем…' : 'Применить режим загрузки'}
    </button> : null}
    {saved && !dirty ? <p role="status" className={HE.muted}>Режим загрузки сохранён.</p> : null}
    {error ? <StatusBox tone="error">{error}</StatusBox> : null}
  </section>;
}
