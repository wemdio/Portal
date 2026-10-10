'use client';

import { useEffect, useRef, useState } from 'react';
import type { VeHypothesis, VeVertical } from '@/lib/verticalEngineV2/types';
import { VE_API, veEnginePost } from './api';
import { HE, Spinner } from './design';

type CreatedHypothesis = { hypothesis: VeHypothesis; vertical: VeVertical };
type CreateResponse = Partial<CreatedHypothesis> & { ok?: boolean; existing?: boolean; error?: string };

export function ManualHypothesisForm({
  projectId,
  disabled,
  onCreated,
}: {
  projectId: string;
  disabled: boolean;
  onCreated: (created: CreatedHypothesis) => void;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const request = useRef<{ id: string; title: string; description: string } | null>(null);
  const savingRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) {
      if (uncertain) submitRef.current?.focus();
      else titleRef.current?.focus();
    }
  }, [open, uncertain]);

  const close = () => {
    if (savingRef.current) return;
    setOpen(false);
    triggerRef.current?.focus();
  };

  const submit = async () => {
    if (savingRef.current || disabled || !title.trim() || !description.trim()) return;
    savingRef.current = true;
    setSaving(true);
    setError('');
    try {
      const content = { title: title.trim().replace(/\s+/g, ' '), description: description.trim() };
      if (!request.current || request.current.title !== content.title || request.current.description !== content.description) {
        request.current = { id: crypto.randomUUID(), ...content };
      }
      const result = await veEnginePost<CreateResponse>(`${VE_API}/projects/${projectId}/hypotheses`, {
        title: request.current.title,
        description: request.current.description,
        request_id: request.current.id,
      });
      if (!result.ok || !result.data.hypothesis || !result.data.vertical) {
        // A lost/malformed server response may follow a committed insert. Keep the
        // request immutable until a retry tells us whether it already succeeded.
        setUncertain(result.status >= 500 || result.ok);
        setError(result.data.error ?? 'Не удалось подтвердить добавление. Повторите попытку.');
        return;
      }
      onCreated({ hypothesis: result.data.hypothesis, vertical: result.data.vertical });
      setSaved(`Добавлена гипотеза «${result.data.hypothesis.title}»`);
      setTitle('');
      setDescription('');
      setUncertain(false);
      request.current = null;
      setOpen(false);
      triggerRef.current?.focus();
    } catch {
      setUncertain(true);
      setError('Не удалось получить ответ. Повторите добавление, дубликат не появится.');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <div className="my-5">
      <button
        ref={triggerRef}
        type="button"
        className={HE.btnGhost}
        disabled={disabled || saving}
        aria-expanded={open}
        aria-controls="ve2-manual-hypothesis-form"
        onClick={() => { setOpen(!open); setSaved(''); }}
      >
        Добавить свою гипотезу
      </button>
      {saved ? <p className={`mt-2 ${HE.muted}`} role="status">{saved}</p> : null}
      <form
        id="ve2-manual-hypothesis-form"
        hidden={!open}
        className="mt-4 max-w-2xl space-y-4"
        aria-busy={saving || undefined}
        onSubmit={(event) => { event.preventDefault(); void submit(); }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
        }}
      >
        <label className="ve2-label block" htmlFor="ve2-manual-hypothesis-title">
          Название гипотезы
          <input
            ref={titleRef}
            id="ve2-manual-hypothesis-title"
            className={`${HE.input} mt-2`}
            value={title}
            onChange={(event) => { setTitle(event.target.value); setError(''); }}
            maxLength={160}
            required
            disabled={disabled || saving || uncertain}
            placeholder="Например, стоматологические клиники"
          />
        </label>
        <label className="ve2-label block" htmlFor="ve2-manual-hypothesis-description">
          Кого ищем
          <textarea
            id="ve2-manual-hypothesis-description"
            className={`${HE.input} mt-2 resize-y`}
            value={description}
            onChange={(event) => { setDescription(event.target.value); setError(''); }}
            maxLength={2000}
            rows={3}
            required
            disabled={disabled || saving || uncertain}
            placeholder="Частные стоматологии в России, от трёх кресел. Исключить государственные клиники."
          />
        </label>
        {error ? <p className="ve2-t-dan text-sm" role="alert">{error}</p> : null}
        <div className="flex flex-wrap items-center gap-3">
          <button ref={submitRef} type="submit" className={HE.btnPrimary}
            disabled={disabled || saving || !title.trim() || !description.trim()}>
            {saving ? <Spinner /> : null}
            {saving ? 'Добавляем…' : uncertain ? 'Проверить добавление' : 'Добавить гипотезу'}
          </button>
          <button type="button" className={HE.btnQuiet} disabled={saving} onClick={close}>Отмена</button>
        </div>
      </form>
    </div>
  );
}
