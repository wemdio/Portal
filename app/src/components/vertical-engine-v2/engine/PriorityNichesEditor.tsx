'use client';

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { VeProject } from '@/lib/verticalEngineV2/types';
import {
  VE_PRIORITY_NICHES_MAX,
  VE_PRIORITY_NICHE_MAX_LENGTH,
  VePriorityNichesSchema,
  readVePriorityNiches,
  readVePriorityNicheReport,
} from '@/lib/verticalEngineV2/priorityNiches';
import { VE_API, veEnginePatch, type VeProjectResponse } from './api';
import { HE, Spinner } from './design';

export interface PriorityNichesEditorHandle {
  save: () => Promise<boolean>;
}

export const PriorityNichesEditor = forwardRef<PriorityNichesEditorHandle, {
  project: VeProject;
  disabled: boolean;
  disabledReason?: string;
  onSaved: (project: VeProject) => void;
  onDirtyChange?: (dirty: boolean) => void;
}>(function PriorityNichesEditor({ project, disabled, disabledReason, onSaved, onDirtyChange }, ref) {
  // Polls update saved preferences without replacing a specialist's draft.
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef<Promise<boolean> | null>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const stored = readVePriorityNiches(project.brief);
  const text = draft ?? stored.join('\n');
  const parsed = VePriorityNichesSchema.safeParse(text.split(/\r?\n/));
  const dirty = !parsed.success || JSON.stringify(parsed.data) !== JSON.stringify(stored);
  const invalid = !parsed.success;
  const issue = parsed.success ? null : parsed.error.issues[0];
  const validationError = !issue ? '' : issue.code === 'too_big'
    ? issue.path.length > 0
      ? `В каждой нише не более ${VE_PRIORITY_NICHE_MAX_LENGTH} символов.`
      : `Можно указать до ${VE_PRIORITY_NICHES_MAX} ниш.`
    : issue.message;

  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

  const save = useCallback(async (): Promise<boolean> => {
    if (pending.current) return pending.current;
    if (!dirty) return true;
    if (!parsed.success) {
      setError(validationError);
      fieldRef.current?.focus();
      return false;
    }
    if (disabled) return false;
    const niches = parsed.data;
    setSaving(true);
    setError('');
    pending.current = (async () => {
      try {
        const result = await veEnginePatch<VeProjectResponse>(`${VE_API}/projects/${project.id}`, {
          priority_niches: niches,
        });
        if (!result.ok || !result.data.project) {
          setError(result.data.error ?? 'Не удалось сохранить ниши. Попробуйте ещё раз.');
          return false;
        }
        onSaved(result.data.project);
        setDraft(null);
        setSaved(true);
        return true;
      } catch {
        setError('Не удалось сохранить ниши. Проверьте соединение и повторите попытку.');
        return false;
      } finally {
        pending.current = null;
        setSaving(false);
      }
    })();
    return pending.current;
  }, [dirty, disabled, onSaved, parsed, project.id, validationError]);

  useImperativeHandle(ref, () => ({ save }), [save]);

  return (
    <div className="mb-6 max-w-2xl" aria-busy={saving || undefined}>
      <label htmlFor="ve2-priority-niches" className="ve2-label block">Приоритетные ниши</label>
      <p id="ve2-priority-niches-hint" className={`mt-1 text-sm ${HE.muted}`}>
        {disabled && disabledReason ? disabledReason : <>
          {project.status === 'researched' ? 'Для следующего исследования. ' : ''}
          По одной нише на строке, до {VE_PRIORITY_NICHES_MAX}.
        </>}
      </p>
      <textarea
        ref={fieldRef}
        id="ve2-priority-niches"
        className={`${HE.input} mt-2 resize-y`}
        rows={3}
        value={text}
        disabled={disabled || saving}
        aria-describedby={`ve2-priority-niches-hint${invalid || error ? ' ve2-priority-niches-error' : ''}`}
        aria-invalid={invalid || undefined}
        placeholder={'Агентства недвижимости\nЗастройщики\nСтоматологии'}
        onChange={(event) => { setDraft(event.target.value); setSaved(false); setError(''); }}
      />
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button type="button" className={HE.btnSmall} disabled={disabled || saving || !dirty || invalid}
          onClick={() => void save()}>
          {saving ? <Spinner className="h-3.5 w-3.5" /> : null}
          {saving ? 'Сохраняем…' : 'Сохранить ниши'}
        </button>
        {saved && !dirty ? <span className={`text-sm ${HE.muted}`} role="status">Сохранено</span> : null}
      </div>
      {invalid || error ? <p id="ve2-priority-niches-error" className="ve2-t-dan mt-2 text-sm" role="alert">{error || validationError}</p> : null}
    </div>
  );
});

export function PriorityNicheResults({ brief }: { brief: VeProject['brief'] }) {
  const report = readVePriorityNicheReport(brief);
  if (!report?.results.length) return null;
  return (
    <details className="mb-5">
      <summary className="ve2-link">Результат по приоритетным нишам</summary>
      <ul className="mt-3 space-y-3 text-sm">
        {report.results.map((result) => (
          <li key={result.niche}>
            <p className="font-medium">{result.niche}</p>
            <p className={HE.muted}>
              {result.status === 'suggested' && result.hypothesis_titles.length ? result.hypothesis_titles.join('; ') : result.reason}
            </p>
          </li>
        ))}
      </ul>
    </details>
  );
}
