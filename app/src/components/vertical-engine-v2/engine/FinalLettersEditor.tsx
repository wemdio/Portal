'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { VeChainLetter, VeTemplate } from '@/lib/verticalEngineV2/types';
import { LetterBodyEditor } from './LetterBodyEditor';
import { normalizeVeFinalLetters, selectedVeBodies, VE_BODY_VARIANTS, type VeBodyVariant } from '@/lib/verticalEngineV2/finalLetters';
import { VE_API, veEngineCall, veEnginePatch } from './api';
import { HE } from './design';
import { StatusBox } from './ui';
import { TemplateLeadPreview } from './steps/Step5Template';

interface EditorResponse { template: VeTemplate; revision: string; editable: boolean; error?: string }

interface EditorProps { templateId: string; onSaved: () => void | Promise<void>; onDirtyChange: (dirty: boolean) => void; readOnly?: boolean }
function editorLetters(template: VeTemplate): VeChainLetter[] {
  return template.letters.map((letter, index) => {
    const alternatives = Array.isArray(letter.variants) ? letter.variants.filter(v => v && typeof v === 'object' && typeof v.body === 'string') : [];
    const options = Array.isArray(letter.subject_options) ? letter.subject_options : [letter.subject ?? '', ...alternatives.map(v => v.subject ?? '')];
    return { ...letter, selected_variant: letter.selected_variant ?? 'A', variants: alternatives.slice(0, 2),
      ...(index === 0 ? { subject_options: [...options, '', '', '', '', '', ''].slice(0, 6), selected_subject_indices: letter.selected_subject_indices ?? [0] } : { subject: null }) };
  });
}

export function FinalLettersEditor(props: EditorProps) {
  // A late response for a previous hypothesis must never populate a new editor.
  return <FinalLettersEditorSession key={props.templateId} {...props} />;
}

function FinalLettersEditorSession({ templateId, onSaved, onDirtyChange, readOnly = false }: EditorProps) {
  const [record, setRecord] = useState<EditorResponse | null>(null);
  const [letters, setLetters] = useState<VeChainLetter[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const editable = !!record?.editable && !readOnly;
  const [viewSides, setViewSides] = useState<Record<number, VeBodyVariant>>({});
  const [structureVersion, setStructureVersion] = useState(0);
  const [removeIntent, setRemoveIntent] = useState<{ index: number; side?: VeBodyVariant } | null>(null);
  const alive = useRef(false);
  const requestSerial = useRef(0);
  const busyRef = useRef(false);
  const dirtyCallback = useRef(onDirtyChange);
  useEffect(() => { dirtyCallback.current = onDirtyChange; }, [onDirtyChange]);
  const load = useCallback(async () => {
    if (busyRef.current) return;
    const serial = ++requestSerial.current;
    busyRef.current = true;
    try {
      const result = await veEngineCall<EditorResponse>(`${VE_API}/templates/${templateId}`);
      if (!alive.current || serial !== requestSerial.current) return;
      if (!result.ok || result.data.template?.id !== templateId || !Array.isArray(result.data.template?.letters)) { setError(result.data.error ?? 'Не удалось загрузить письма'); return; }
      setRecord(result.data); setLetters(editorLetters(result.data.template)); setViewSides({}); setRemoveIntent(null);
      setDirty(false);
      setError('');
    } catch {
      if (alive.current && serial === requestSerial.current) setError('Не удалось загрузить письма. Попробуйте ещё раз.');
    } finally {
      if (alive.current && serial === requestSerial.current) { busyRef.current = false; setBusy(false); }
    }
  }, [templateId]);
  useEffect(() => {
    alive.current = true; busyRef.current = false;
    // Start asynchronous I/O after the subscription is installed; Strict Mode
    // cleanup can invalidate it before any response mutates this session.
    void Promise.resolve().then(() => { if (alive.current) return load(); });
    return () => { alive.current = false; requestSerial.current += 1; busyRef.current = false; dirtyCallback.current(false); };
  }, [load]);
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirty]);
  const update = (index: number, change: (letter: VeChainLetter) => VeChainLetter) => {
    setLetters(current => current.map((letter, i) => i === index ? change(letter) : letter)); setDirty(true); setError(''); setRemoveIntent(null);
  };
  const save = async () => {
    if (!record || !editable || busyRef.current) return;
    if (record.template.letters.some(letter => (letter.variants?.length ?? 0) > 2)
      && !window.confirm('В старой цепочке есть тексты после C. Сохранить только A, B и C?')) return;
    const normalized = normalizeVeFinalLetters(letters);
    if (!normalized.letters) { setError(normalized.error ?? 'Проверьте письма'); return; }
    const serial = ++requestSerial.current;
    busyRef.current = true; setBusy(true);
    try {
      const result = await veEnginePatch<EditorResponse>(`${VE_API}/templates/${templateId}`, { letters: normalized.letters, expected_revision: record.revision });
      if (!alive.current || serial !== requestSerial.current) return;
      if (!result.ok) { setError(result.data.error ?? 'Не удалось сохранить письма'); return; }
      if (result.data.template?.id !== templateId || !Array.isArray(result.data.template?.letters)) { setError('Сервер не подтвердил сохранённую версию. Ваши правки остались в редакторе.'); return; }
      setRecord(result.data); setLetters(editorLetters(result.data.template)); setViewSides({}); setRemoveIntent(null); setDirty(false); setError('');
      try { await onSaved(); } catch {
        if (alive.current) setError('Письма сохранены, но не удалось обновить проект. Обновите страницу.');
      }
    } catch {
      if (alive.current && serial === requestSerial.current) setError('Не удалось сохранить письма. Правки остались в редакторе, попробуйте ещё раз.');
    } finally {
      if (alive.current && serial === requestSerial.current) { busyRef.current = false; setBusy(false); }
    }
  };
  const disabled = busy || !editable;
  if (!record) return <StatusBox tone={error ? 'error' : 'info'}>{error || 'Загружаем итоговые письма…'}{error ? <button type="button" className={`${HE.btnGhost} ml-3`} disabled={busy} onClick={() => { setBusy(true); void load(); }}>Повторить</button> : null}</StatusBox>;
  const legacy = record.template.letters.some(letter => !letter.selected_variant);
  // Confirmation is required even when accepting A unchanged. Merely opening
  // an old version is not an edit and should not trigger an exit warning.
  const needsSelectionConfirmation = legacy && editable;
  const changeStructure = (next: VeChainLetter[]) => {
    setLetters(next); setViewSides({}); setStructureVersion(version => version + 1); setDirty(true); setError(''); setRemoveIntent(null);
  };
  const removeLetter = (index: number) => {
    const next = letters.filter((_, i) => i !== index);
    if (index === 0 && next[0]) next[0] = { ...next[0], subject: letters[0].subject, subject_options: letters[0].subject_options,
      selected_subject_indices: selectedVeBodies(next[0]).length > 1 ? [letters[0].selected_subject_indices?.[0] ?? 0] : letters[0].selected_subject_indices, wait_days: 0 };
    changeStructure(next);
  };
  return <section className="space-y-5" aria-label="Итоговые письма">
    <div className="flex items-center justify-between gap-3"><h3 className="ve2-h3">Цепочка · {letters.length} из 6 писем</h3>
      {editable ? <button type="button" className={HE.btnGhost} disabled={disabled || letters.length >= 6} onClick={() => changeStructure([...letters, { subject: null, body: '', wait_days: 2, selected_variant: 'A', variants: [] }])}>Добавить письмо</button> : null}
    </div>
    {legacy && editable ? <StatusBox tone="info">Проверьте тексты для отправки и сохраните выбор.</StatusBox> : null}
    {!record.editable && !readOnly ? <StatusBox tone="info">Письма переданы в запуск или проверяются. Доступен просмотр.</StatusBox> : null}
    {letters.map((letter, index) => {
      const side = viewSides[index] ?? letter.selected_variant ?? 'A';
      const available = VE_BODY_VARIANTS.slice(0, 1 + (letter.variants?.length ?? 0));
      const active = side === 'A' ? letter : letter.variants?.[VE_BODY_VARIANTS.indexOf(side) - 1];
      const selected = selectedVeBodies(letter);
      const combinations = ['A', 'B', 'C', 'AB', 'AC', 'BC', 'ABC'].filter(combo => [...combo].every(v => available.includes(v as VeBodyVariant)));
      return <article key={`${structureVersion}-${index}`} className="border-t border-[var(--ve2-line)] pt-5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="ve2-h3">Письмо {index + 1}</h3>
          {editable ? <button type="button" className={HE.btnQuiet} disabled={disabled || letters.length <= 1} aria-label={`Удалить письмо ${index + 1}`} onClick={() => setRemoveIntent({ index })}>Удалить</button> : null}
        </div>
        {index > 0 ? <label className="ve2-label ve2-letter-gap">Через дней
          <input aria-label={`Интервал письма ${index + 1}`} type="number" min={0} max={90} value={Number.isFinite(letter.wait_days) ? letter.wait_days : ''} disabled={disabled} className={`${HE.input} w-24`}
            onChange={event => update(index, current => ({ ...current, wait_days: event.target.value === '' ? NaN : Number(event.target.value) }))} /></label> : null}
        {index === 0 ? <details className="py-2"><summary className="cursor-pointer break-words">Тема: {letter.selected_subject_indices?.map(i => letter.subject_options?.[i]).filter(Boolean).join(' / ') || 'Укажите тему'}{(letter.selected_subject_indices?.length ?? 0) > 1 ? ' · тест тем' : ''}</summary>
          <fieldset className="mt-3 space-y-2"><legend className="ve2-label mb-2">{selected.length > 1 ? 'Общая тема для теста текстов' : 'Темы для отправки'}</legend>
          {letter.subject_options?.map((subject, subjectIndex) => <div key={subjectIndex} className="flex items-center gap-3">
            <input type={selected.length > 1 ? 'radio' : 'checkbox'} name={`${templateId}-subjects`} className="ve2-cbx shrink-0" disabled={disabled} aria-label={`Использовать тему ${subjectIndex + 1}`}
              checked={letter.selected_subject_indices?.includes(subjectIndex) ?? false}
              onChange={event => update(index, current => ({ ...current, selected_subject_indices: selected.length > 1 ? [subjectIndex] : event.target.checked
                ? [...(current.selected_subject_indices ?? []), subjectIndex].sort((a,b) => a-b)
                : (current.selected_subject_indices ?? []).filter(i => i !== subjectIndex) }))} />
            <input type="text" value={subject} disabled={disabled} maxLength={500} className={`${HE.input} min-w-0 flex-1`} aria-label={`Тема ${subjectIndex + 1}`}
              placeholder="Добавить тему" onChange={event => update(index, current => ({ ...current, subject_options: current.subject_options?.map((s,i) => i === subjectIndex ? event.target.value : s) }))} />
          </div>)}
          </fieldset>
        </details> : null}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-1" role="group" aria-label={`Варианты текста письма ${index + 1}`}>
            {available.map(variant => <button key={variant} type="button" aria-pressed={side === variant} disabled={busy}
              className={side === variant ? HE.btnPrimary : HE.btnGhost}
              onClick={() => setViewSides(current => ({ ...current, [index]: variant }))}>Текст {variant}</button>)}
            {editable && available.length < 3 ? <button type="button" className={HE.btnQuiet} disabled={disabled} onClick={() => {
              const added = VE_BODY_VARIANTS[available.length];
              update(index, current => ({ ...current, variants: [...(current.variants ?? []), { subject: null, body: '' }] }));
              setViewSides(current => ({ ...current, [index]: added }));
            }}>+ Текст {VE_BODY_VARIANTS[available.length]}</button> : null}
          </div>
          <label className="ve2-label flex items-center gap-2">Отправлять
            <select className={HE.input} aria-label={`Отправлять тексты письма ${index + 1}`} disabled={disabled} value={selected.join('')}
              onChange={event => update(index, current => {
                const chosen = [...event.target.value] as VeBodyVariant[];
                return { ...current, selected_variant: chosen[0], selected_variants: chosen,
                  ...(index === 0 && chosen.length > 1 ? { selected_subject_indices: [current.selected_subject_indices?.[0] ?? 0] } : {}) };
              })}>{combinations.map(combo => <option key={combo} value={combo}>{[...combo].join(' + ')}{combo.length > 1 ? ' · тест текстов' : ''}</option>)}</select>
          </label>
        </div>
        {editable && side !== 'A' && VE_BODY_VARIANTS.indexOf(side) === available.length - 1 ? <button type="button" className={HE.btnQuiet} disabled={disabled} onClick={() => setRemoveIntent({ index, side })}>Удалить текст {side}</button> : null}
        {removeIntent?.index === index ? <div role="group" aria-label="Подтвердить удаление" className="flex flex-wrap items-center gap-3">
          <span>{removeIntent.side ? `Удалить текст ${removeIntent.side}?` : `Удалить письмо ${index + 1}?`}</span>
          <button type="button" className={HE.btnGhost} disabled={disabled} onClick={() => {
            if (removeIntent.side) {
              const removed = removeIntent.side;
              update(index, current => {
                const remaining = selectedVeBodies(current).filter(v => v !== removed);
                return { ...current, variants: current.variants?.slice(0, -1), selected_variant: remaining[0] ?? 'A', selected_variants: remaining.length ? remaining : ['A'] };
              });
              setViewSides(current => ({ ...current, [index]: 'A' }));
            } else removeLetter(index);
            setRemoveIntent(null);
          }}>Да, удалить</button>
          <button type="button" className={HE.btnQuiet} onClick={() => setRemoveIntent(null)}>Отмена</button>
        </div> : null}
        <LetterBodyEditor key={side} value={active?.body ?? ''} label={`Текст письма ${index + 1}, вариант ${side}`} disabled={disabled}
          campaign={templateId} content={`letter_${index + 1}_${side.toLowerCase()}`}
          onChange={body => update(index, current => side === 'A' ? { ...current, body }
            : { ...current, variants: current.variants?.map((v, i) => i === VE_BODY_VARIANTS.indexOf(side) - 1 ? { ...v, body } : v) })} />
        {letter.segment_variants?.length ? <details><summary className="cursor-pointer">Отдельные тексты сегментов · {letter.segment_variants.length}</summary>
          <p className={`${HE.muted} my-3`}>В этих сегментах отправляется отдельный текст, без A/B-теста.</p>
          {letter.segment_variants.map((segment, segmentIndex) => <div key={segmentIndex} className="space-y-2 py-3"><p className="ve2-label">{segment.when}</p>
            <LetterBodyEditor value={segment.text} label={`Текст сегмента ${segment.when}, письмо ${index + 1}`} disabled={disabled} campaign={templateId} content={`letter_${index + 1}_segment_${segmentIndex + 1}`}
              onChange={text => update(index, current => ({ ...current, segment_variants: current.segment_variants?.map((s,i) => i === segmentIndex ? { ...s, text } : s) }))} />
          </div>)}
        </details> : null}
      </article>;
    })}
    {error ? <StatusBox tone="error">{error}</StatusBox> : null}
    {!readOnly ? <div className="flex items-center flex-wrap gap-3"><button type="button" className={HE.btnPrimary} disabled={disabled || (!dirty && !needsSelectionConfirmation)} onClick={() => void save()}>{busy ? 'Сохраняем…' : needsSelectionConfirmation ? 'Сохранить выбор' : 'Сохранить письма'}</button>
      <span className={HE.muted} role="status">{dirty ? 'Есть несохранённые изменения' : needsSelectionConfirmation ? 'Выбор ещё не подтверждён' : 'Письма сохранены'}</span>
      {dirty ? <button type="button" className={HE.btnGhost} disabled={busy} onClick={() => { if (window.confirm('Отменить несохранённые изменения?')) { setBusy(true); void load(); } }}>Отменить правки</button> : null}
    </div> : null}
    {!dirty && !needsSelectionConfirmation ? <TemplateLeadPreview key={record.revision} template={record.template} baseId={record.template.base_id} /> : <p className={HE.muted}>Сохраните письма, чтобы открыть превью на получателе.</p>}
  </section>;
}
