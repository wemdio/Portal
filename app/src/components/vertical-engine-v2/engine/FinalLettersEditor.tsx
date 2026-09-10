'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { VeChainLetter, VeTemplate } from '@/lib/verticalEngineV2/types';
import { normalizeVeFinalLetters } from '@/lib/verticalEngineV2/finalLetters';
import { VE_API, veEngineCall, veEnginePatch } from './api';
import { HE } from './design';
import { StatusBox } from './ui';
import { TemplateLeadPreview } from './steps/Step5Template';

interface EditorResponse { template: VeTemplate; revision: string; editable: boolean; error?: string }
const CTA_LABELS: Record<string, string> = { check_relevance: 'Уточнить интерес', identify_owner: 'Найти ответственного', choose_priority: 'Уточнить приоритет', confirm_timing: 'Уточнить сроки' };
interface EditorProps { templateId: string; onSaved: () => void | Promise<void>; onDirtyChange: (dirty: boolean) => void }
function editorLetters(template: VeTemplate): VeChainLetter[] {
  return template.letters.map((letter, index) => {
    const alternatives = Array.isArray(letter.variants) ? letter.variants.filter(v => v && typeof v === 'object' && typeof v.body === 'string') : [];
    const options = Array.isArray(letter.subject_options) ? letter.subject_options : [letter.subject ?? '', ...alternatives.map(v => v.subject ?? '')];
    return { ...letter, selected_variant: letter.selected_variant ?? 'A', variants: alternatives.slice(0, 1),
      ...(index === 0 ? { subject_options: [...options, '', '', '', '', '', ''].slice(0, 6), selected_subject_indices: letter.selected_subject_indices ?? [0] } : { subject: null }) };
  });
}

export function FinalLettersEditor(props: EditorProps) {
  // A late response for a previous hypothesis must never populate a new editor.
  return <FinalLettersEditorSession key={props.templateId} {...props} />;
}

function FinalLettersEditorSession({ templateId, onSaved, onDirtyChange }: EditorProps) {
  const [record, setRecord] = useState<EditorResponse | null>(null);
  const [letters, setLetters] = useState<VeChainLetter[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [viewSides, setViewSides] = useState<Record<number, 'A' | 'B'>>({});
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
      setRecord(result.data); setLetters(editorLetters(result.data.template)); setViewSides({});
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
    setLetters(current => current.map((letter, i) => i === index ? change(letter) : letter)); setDirty(true); setError('');
  };
  const save = async () => {
    if (!record?.editable || busyRef.current) return;
    const normalized = normalizeVeFinalLetters(letters);
    if (!normalized.letters) { setError(normalized.error ?? 'Проверьте письма'); return; }
    const serial = ++requestSerial.current;
    busyRef.current = true; setBusy(true);
    try {
      const result = await veEnginePatch<EditorResponse>(`${VE_API}/templates/${templateId}`, { letters: normalized.letters, expected_revision: record.revision });
      if (!alive.current || serial !== requestSerial.current) return;
      if (!result.ok) { setError(result.data.error ?? 'Не удалось сохранить письма'); return; }
      if (result.data.template?.id !== templateId || !Array.isArray(result.data.template?.letters)) { setError('Сервер не подтвердил сохранённую версию. Ваши правки остались в редакторе.'); return; }
      setRecord(result.data); setLetters(editorLetters(result.data.template)); setViewSides({}); setDirty(false); setError('');
      try { await onSaved(); } catch {
        if (alive.current) setError('Письма сохранены, но не удалось обновить проект. Обновите страницу.');
      }
    } catch {
      if (alive.current && serial === requestSerial.current) setError('Не удалось сохранить письма. Правки остались в редакторе, попробуйте ещё раз.');
    } finally {
      if (alive.current && serial === requestSerial.current) { busyRef.current = false; setBusy(false); }
    }
  };
  const disabled = busy || !record?.editable;
  if (!record) return <StatusBox tone={error ? 'error' : 'info'}>{error || 'Загружаем итоговые письма…'}{error ? <button type="button" className={`${HE.btnGhost} ml-3`} disabled={busy} onClick={() => { setBusy(true); void load(); }}>Повторить</button> : null}</StatusBox>;
  const legacy = record.template.letters.some(letter => !letter.selected_variant);
  // Confirmation is required even when accepting A unchanged. Merely opening
  // an old version is not an edit and should not trigger an exit warning.
  const needsSelectionConfirmation = legacy && record.editable;
  return <section className="space-y-5" aria-label="Итоговые письма">
    <p className={HE.muted}>Выберите текст A или B. У первого письма можно выбрать несколько тем — текст у этих вариантов будет одинаковым.</p>
    {legacy && record.editable ? <StatusBox tone="info">Это ранее созданные письма. Проверьте выбранные тексты и темы, затем сохраните выбор. Не выбранный текст останется в редакторе и не пойдёт в отправку.</StatusBox> : null}
    {record.template.letters.some(letter => (letter.variants?.length ?? 0) > 1) && record.editable ? <StatusBox tone="info">В прежней версии было больше двух текстов. В этом редакторе оставлены A и B; сохранение подтвердит отправку только выбранного текста.</StatusBox> : null}
    {!record.editable ? <StatusBox tone="info">Эта версия уже проверяется или передана в запуск. Письма доступны для просмотра.</StatusBox> : null}
    {letters.map((letter, index) => {
      const side = viewSides[index] ?? letter.selected_variant ?? 'A';
      const active = side === 'B' ? letter.variants?.[0] : letter;
      return <article key={index} className="border-t border-[var(--ve2-line)] pt-5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="ve2-h3">Письмо {index + 1}</h3>
          <div className="flex flex-wrap gap-2" role="group" aria-label={`Текст письма ${index + 1} для отправки`}>
            {(['A', 'B'] as const).map(variant => <button key={variant} type="button" aria-pressed={side === variant}
              disabled={busy || (variant === 'B' && !letter.variants?.[0])}
              className={side === variant ? HE.btnPrimary : HE.btnGhost}
              onClick={() => {
                setViewSides(current => ({ ...current, [index]: variant }));
                if (record.editable) update(index, current => ({ ...current, selected_variant: variant }));
              }}>Текст {variant}{record.editable ? letter.selected_variant === variant ? ' · выбран' : '' : side === variant ? ' · просмотр' : ''}</button>)}
          </div>
        </div>
        {active?.angle || active?.cta_intent ? <p className={HE.muted}>{active.angle ? `Заход: ${active.angle}` : ''}{active.angle && active.cta_intent ? ' · ' : ''}{active.cta_intent ? `Следующий шаг: ${CTA_LABELS[active.cta_intent] ?? active.cta_intent}` : ''}</p> : null}
        {index === 0 ? <fieldset className="space-y-2"><legend className="ve2-label mb-2">Темы первого письма · выберите от одной до шести</legend>
          {letter.subject_options?.map((subject, subjectIndex) => <div key={subjectIndex} className="flex items-center gap-3">
            <input type="checkbox" className="ve2-cbx shrink-0" disabled={disabled} aria-label={`Использовать тему ${subjectIndex + 1}`}
              checked={letter.selected_subject_indices?.includes(subjectIndex) ?? false}
              onChange={event => update(index, current => ({ ...current, selected_subject_indices: event.target.checked
                ? [...(current.selected_subject_indices ?? []), subjectIndex].sort((a,b) => a-b)
                : (current.selected_subject_indices ?? []).filter(i => i !== subjectIndex) }))} />
            <input type="text" value={subject} disabled={disabled} maxLength={500} className={`${HE.input} min-w-0 flex-1`} aria-label={`Тема ${subjectIndex + 1}`}
              placeholder="Добавить тему" onChange={event => update(index, current => ({ ...current, subject_options: current.subject_options?.map((s,i) => i === subjectIndex ? event.target.value : s) }))} />
          </div>)}
        </fieldset> : <p className={HE.muted}>Продолжение переписки, без новой темы.</p>}
        <label className="block ve2-label">Текст {side}
          <textarea rows={8} value={active?.body ?? ''} aria-label={`Текст письма ${index + 1}, вариант ${side}`} disabled={disabled} className={`${HE.input} mt-2 w-full resize-y leading-relaxed`} maxLength={12000}
            onChange={event => update(index, current => side === 'A' ? { ...current, body: event.target.value }
              : { ...current, variants: [{ ...current.variants![0], body: event.target.value }] })} />
        </label>
        {index > 0 ? <label className="ve2-label inline-flex items-center gap-3">Через сколько дней после предыдущего
          <input type="number" min={0} max={90} value={Number.isFinite(letter.wait_days) ? letter.wait_days : ''} disabled={disabled} className={`${HE.input} w-24`}
            onChange={event => update(index, current => ({ ...current, wait_days: event.target.value === '' ? NaN : Number(event.target.value) }))} /></label> : null}
        {letter.segment_variants?.length ? <div className="space-y-3"><p className={HE.muted}>Для этих сегментов используются отдельные тексты вместо общего A/B. Проверьте их перед запуском.</p>
          {letter.segment_variants.map((segment, segmentIndex) => <label key={segmentIndex} className="block ve2-label">{segment.when}
            <textarea rows={5} value={segment.text} maxLength={12000} disabled={disabled} className={`${HE.input} mt-2 w-full`} onChange={event => update(index, current => ({ ...current,
              segment_variants: current.segment_variants?.map((s,i) => i === segmentIndex ? { ...s, text: event.target.value } : s) }))} />
          </label>)}
        </div> : null}
      </article>;
    })}
    {error ? <StatusBox tone="error">{error}</StatusBox> : null}
    <div className="flex items-center flex-wrap gap-3"><button type="button" className={HE.btnPrimary} disabled={disabled || (!dirty && !needsSelectionConfirmation)} onClick={() => void save()}>{busy ? 'Сохраняем…' : needsSelectionConfirmation ? 'Сохранить выбор' : 'Сохранить письма'}</button>
      <span className={HE.muted} role="status">{dirty ? 'Есть несохранённые изменения' : needsSelectionConfirmation ? 'Выбор ещё не подтверждён' : 'Письма сохранены'}</span>
      {dirty ? <button type="button" className={HE.btnGhost} disabled={busy} onClick={() => { if (window.confirm('Отменить несохранённые изменения?')) { setBusy(true); void load(); } }}>Отменить правки</button> : null}
    </div>
    {!dirty && !needsSelectionConfirmation ? <TemplateLeadPreview key={record.revision} template={record.template} baseId={record.template.base_id} /> : <p className={HE.muted}>Сохраните выбор и правки, чтобы проверить итоговое письмо на получателе.</p>}
  </section>;
}
