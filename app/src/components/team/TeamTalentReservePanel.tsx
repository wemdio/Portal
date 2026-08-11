'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  ChevronDown,
  ExternalLink,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import {
  buildTeamTalentReserveWrite,
  normalizeTalentReserve,
  TeamApiError,
  teamApiFetch,
  type TeamTalentReserveEntry,
  type TeamTalentReserveResponse,
  type TeamTalentReserveStage,
} from './teamApi';
import { TEAM_FORM_INPUT_CLASS, TEAM_FORM_TEXTAREA_CLASS } from './teamFormStyles';

type FormMode = 'create' | 'edit';

interface TalentFormState {
  contact: string;
  candidateName: string;
  vacancyDirection: string;
  testAssignment: string;
  testResult: string;
  testSentOn: string;
  interviewOn: string;
  comment: string;
  revisitOn: string;
  revisitNote: string;
  stage: TeamTalentReserveStage;
}

interface TalentFormProps {
  mode: FormMode;
  values: TalentFormState;
  saving: boolean;
  error: string;
  deleting: boolean;
  onChange: <K extends keyof TalentFormState>(key: K, value: TalentFormState[K]) => void;
  onSubmit: () => void;
  onCancel: () => void;
  onArchive?: () => void;
  onDelete?: () => void;
  onCancelDelete?: () => void;
}

const ACTIVE_STAGES = new Set<TeamTalentReserveStage>([
  'new',
  'test',
  'interview',
  'reserve',
  'return_later',
]);

const STAGE_OPTIONS: ReadonlyArray<readonly [TeamTalentReserveStage, string]> = [
  ['new', 'Новый'],
  ['test', 'Тестовое'],
  ['interview', 'Собеседование'],
  ['reserve', 'Резерв'],
  ['return_later', 'Вернуться позже'],
  ['hired', 'Нанят'],
  ['rejected', 'Отказ'],
  ['archived', 'Архив'],
];

const STAGE_LABELS = Object.fromEntries(STAGE_OPTIONS) as Record<TeamTalentReserveStage, string>;
const CONFLICT_MESSAGE = 'Эту запись уже изменил другой пользователь. Ваш черновик остался в форме. Отмените редактирование, чтобы загрузить актуальную версию.';

function emptyForm(): TalentFormState {
  return {
    contact: '',
    candidateName: '',
    vacancyDirection: '',
    testAssignment: '',
    testResult: '',
    testSentOn: '',
    interviewOn: '',
    comment: '',
    revisitOn: '',
    revisitNote: '',
    stage: 'new',
  };
}

function entryForm(entry: TeamTalentReserveEntry): TalentFormState {
  return {
    contact: entry.contact,
    candidateName: entry.candidateName,
    vacancyDirection: entry.vacancyDirection,
    testAssignment: entry.testAssignment || '',
    testResult: entry.testResult || '',
    testSentOn: entry.testSentOn || '',
    interviewOn: entry.interviewOn || '',
    comment: entry.comment || '',
    revisitOn: entry.revisitOn || '',
    revisitNote: entry.revisitNote || '',
    stage: entry.stage,
  };
}

function shortDate(value: string | null): string {
  if (!value) return 'Не указана';
  const [year, month, day] = value.slice(0, 10).split('-');
  return year && month && day ? `${day}.${month}.${year}` : value;
}

function contactHref(value: string): string | null {
  const contact = value.trim();
  if (/^https?:\/\//i.test(contact)) return contact;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) return `mailto:${contact}`;
  if (/^@[a-z0-9_]+$/i.test(contact)) return `https://t.me/${contact.slice(1)}`;
  if (/^\+?[\d\s()-]{7,}$/.test(contact)) return `tel:${contact.replace(/[^+\d]/g, '')}`;
  return null;
}

function isAttention(entry: TeamTalentReserveEntry, asOf: string): boolean {
  if (!asOf) return false;
  if (entry.stage === 'interview') return Boolean(entry.interviewOn && entry.interviewOn <= asOf);
  if (entry.stage === 'return_later') return Boolean(entry.revisitOn && entry.revisitOn <= asOf);
  return false;
}

function TalentForm({
  mode,
  values,
  saving,
  error,
  deleting,
  onChange,
  onSubmit,
  onCancel,
  onArchive,
  onDelete,
  onCancelDelete,
}: TalentFormProps) {
  const confirmDeleteRef = useRef<HTMLButtonElement>(null);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  const revisitOnRef = useRef<HTMLInputElement>(null);
  const [validationError, setValidationError] = useState('');

  useEffect(() => {
    if (deleting) confirmDeleteRef.current?.focus();
  }, [deleting]);

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!values.contact.trim() || !values.candidateName.trim() || !values.vacancyDirection.trim()) return;
    if (values.stage === 'return_later' && !values.revisitOn && !values.revisitNote.trim()) {
      setValidationError('Укажите дату или заметку, чтобы сохранить кандидата.');
      revisitOnRef.current?.focus();
      return;
    }
    setValidationError('');
    onSubmit();
  };

  const change = <K extends keyof TalentFormState>(key: K, value: TalentFormState[K]) => {
    if (validationError && (key === 'stage' || key === 'revisitOn' || key === 'revisitNote')) {
      setValidationError('');
    }
    onChange(key, value);
  };

  return (
    <form
      aria-label={mode === 'create'
        ? 'Новая запись кадрового резерва'
        : `Редактирование ${values.candidateName}`}
      aria-busy={saving}
      onSubmit={submit}
      className="border-t border-gray-200 bg-gray-50/70 px-4 py-5 sm:px-6"
    >
      <div className="mb-5 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-bold text-gray-900">
            {mode === 'create' ? 'Добавить кандидата' : `Редактирование: ${values.candidateName}`}
          </h3>
          <p className="mt-1 text-sm text-gray-500">Сначала зафиксируйте контакт, направление и текущий этап. Остальные поля можно дополнять позже.</p>
        </div>
        <button
          type="button"
          disabled={saving}
          onClick={onCancel}
          aria-label="Закрыть форму"
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-gray-500 outline-none hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50"
        >
          <X aria-hidden="true" className="h-4 w-4" />
        </button>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <label className="space-y-1.5 text-sm font-medium text-gray-700">
          <span>Контакт</span>
          <input autoFocus required maxLength={500} disabled={saving} value={values.contact} onChange={(event) => onChange('contact', event.target.value)} className={TEAM_FORM_INPUT_CLASS} />
        </label>
        <label className="space-y-1.5 text-sm font-medium text-gray-700">
          <span>Имя</span>
          <input required maxLength={200} disabled={saving} value={values.candidateName} onChange={(event) => onChange('candidateName', event.target.value)} className={TEAM_FORM_INPUT_CLASS} />
        </label>
        <label className="space-y-1.5 text-sm font-medium text-gray-700">
          <span>Вакансия или направление</span>
          <input required maxLength={500} disabled={saving} value={values.vacancyDirection} onChange={(event) => onChange('vacancyDirection', event.target.value)} className={TEAM_FORM_INPUT_CLASS} />
        </label>
        <label className="space-y-1.5 text-sm font-medium text-gray-700 md:col-span-2">
          <span>Тестовое задание</span>
          <textarea maxLength={5000} disabled={saving} rows={2} value={values.testAssignment} onChange={(event) => onChange('testAssignment', event.target.value)} className={TEAM_FORM_TEXTAREA_CLASS} />
        </label>
        <label className="space-y-1.5 text-sm font-medium text-gray-700">
          <span>Результат тестового</span>
          <textarea maxLength={500} disabled={saving} rows={2} value={values.testResult} onChange={(event) => onChange('testResult', event.target.value)} className={TEAM_FORM_TEXTAREA_CLASS} />
        </label>
        <label className="space-y-1.5 text-sm font-medium text-gray-700">
          <span>Дата отправки тестового</span>
          <input type="date" disabled={saving} value={values.testSentOn} onChange={(event) => onChange('testSentOn', event.target.value)} className={TEAM_FORM_INPUT_CLASS} />
        </label>
        <label className="space-y-1.5 text-sm font-medium text-gray-700">
          <span>Дата собеседования</span>
          <input type="date" disabled={saving} value={values.interviewOn} onChange={(event) => onChange('interviewOn', event.target.value)} className={TEAM_FORM_INPUT_CLASS} />
        </label>
        <label className="space-y-1.5 text-sm font-medium text-gray-700">
          <span>Этап</span>
          <select disabled={saving} value={values.stage} onChange={(event) => change('stage', event.target.value as TeamTalentReserveStage)} className={TEAM_FORM_INPUT_CLASS}>
            {STAGE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className="space-y-1.5 text-sm font-medium text-gray-700 md:col-span-2 lg:col-span-3">
          <span>Комментарий</span>
          <textarea maxLength={5000} disabled={saving} rows={3} value={values.comment} onChange={(event) => onChange('comment', event.target.value)} className={TEAM_FORM_TEXTAREA_CLASS} />
        </label>

        {values.stage === 'return_later' && (
          <fieldset className="grid gap-4 rounded-xl border border-gray-200 p-4 md:col-span-2 md:grid-cols-2 lg:col-span-3">
            <legend className="px-1 text-sm font-semibold text-gray-800">Напоминание</legend>
            <p id="talent-return-reminder-help" className="text-sm text-gray-500 md:col-span-2">Укажите дату или заметку, чтобы не потерять кандидата.</p>
            <label className="space-y-1.5 text-sm font-medium text-gray-700">
              <span>Когда вернуться</span>
              <input
                ref={revisitOnRef}
                type="date"
                disabled={saving}
                value={values.revisitOn}
                onChange={(event) => change('revisitOn', event.target.value)}
                aria-invalid={validationError ? true : undefined}
                aria-describedby={`talent-return-reminder-help${validationError ? ' talent-return-reminder-error' : ''}`}
                className={TEAM_FORM_INPUT_CLASS}
              />
            </label>
            <label className="space-y-1.5 text-sm font-medium text-gray-700">
              <span>Заметка к возврату</span>
              <input
                maxLength={500}
                disabled={saving}
                value={values.revisitNote}
                onChange={(event) => change('revisitNote', event.target.value)}
                aria-invalid={validationError ? true : undefined}
                aria-describedby={`talent-return-reminder-help${validationError ? ' talent-return-reminder-error' : ''}`}
                className={TEAM_FORM_INPUT_CLASS}
              />
            </label>
            {validationError && <p id="talent-return-reminder-error" role="alert" className="text-sm text-red-700 md:col-span-2">{validationError}</p>}
          </fieldset>
        )}
      </div>

      {error && <p role="alert" className="mt-4 text-sm text-red-700">{error}</p>}

      <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center">
        {mode === 'edit' && !deleting && (
          <div className="flex flex-wrap gap-2 sm:mr-auto">
            <button type="button" disabled={saving} onClick={onArchive} className="inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm font-medium text-gray-600 outline-none hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50">
              <Archive aria-hidden="true" className="h-4 w-4" /> В архив
            </button>
            <button ref={deleteButtonRef} type="button" disabled={saving} onClick={onDelete} className="inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm font-medium text-red-700 outline-none hover:bg-red-50 focus-visible:ring-2 focus-visible:ring-red-500 disabled:opacity-50">
              <Trash2 aria-hidden="true" className="h-4 w-4" /> Удалить запись
            </button>
          </div>
        )}
        {deleting ? (
          <div role="group" aria-label="Подтверждение удаления" className="flex flex-wrap items-center gap-2 sm:ml-auto">
            <span className="text-sm text-red-700">Запись будет удалена без возможности восстановления.</span>
            <button ref={confirmDeleteRef} type="button" disabled={saving} onClick={onDelete} className="min-h-11 rounded-xl bg-red-600 px-3 text-sm font-semibold text-white outline-none hover:bg-red-700 focus-visible:ring-2 focus-visible:ring-red-500 disabled:opacity-50">Удалить без возможности восстановления</button>
            <button
              type="button"
              disabled={saving}
              onClick={() => {
                onCancelDelete?.();
                queueMicrotask(() => deleteButtonRef.current?.focus());
              }}
              className="min-h-11 rounded-xl px-3 text-sm font-medium text-gray-700 outline-none hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-blue-500"
            >
              Отмена удаления
            </button>
          </div>
        ) : (
          <div className="flex flex-col-reverse gap-2 sm:ml-auto sm:flex-row">
            <button type="button" disabled={saving} onClick={onCancel} className="min-h-11 rounded-xl border border-gray-200 bg-white px-4 text-sm font-medium text-gray-700 outline-none hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50">Отмена</button>
            <button type="submit" disabled={saving} className="min-h-11 rounded-xl bg-gray-900 px-4 text-sm font-semibold text-white outline-none hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-60">
              {saving ? 'Сохраняем…' : mode === 'create' ? 'Сохранить кандидата' : 'Сохранить изменения'}
            </button>
          </div>
        )}
      </div>
    </form>
  );
}

function TalentRow({
  entry,
  expanded,
  canManage,
  editDisabled,
  onToggle,
  onEdit,
  editButtonRef,
}: {
  entry: TeamTalentReserveEntry;
  expanded: boolean;
  canManage: boolean;
  editDisabled: boolean;
  onToggle: () => void;
  onEdit: () => void;
  editButtonRef: (node: HTMLButtonElement | null) => void;
}) {
  const contactLink = contactHref(entry.contact);
  const testLink = entry.testAssignment && /^https?:\/\//i.test(entry.testAssignment.trim())
    ? entry.testAssignment.trim()
    : null;
  return (
    <article role="listitem" className="border-t border-gray-100 first:border-t-0">
      <div className="flex min-w-0 items-stretch">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={`talent-details-${entry.id}`}
          onClick={onToggle}
          className="grid min-h-11 min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 text-left outline-none hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 sm:grid-cols-[minmax(180px,1.1fr)_minmax(160px,1fr)_auto_auto] sm:px-5"
        >
          <span className="min-w-0">
            <span className="block break-words text-sm font-semibold text-gray-900">{entry.candidateName}</span>
            <span className="block truncate text-xs text-gray-500">{entry.contact}</span>
          </span>
          <span className="hidden min-w-0 break-words text-sm text-gray-600 sm:block">{entry.vacancyDirection}</span>
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-gray-600">
            <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${entry.stage === 'return_later' || entry.stage === 'interview' ? 'bg-amber-500' : entry.stage === 'hired' ? 'bg-emerald-500' : 'bg-gray-400'}`} />
            {STAGE_LABELS[entry.stage]}
          </span>
          <ChevronDown aria-hidden="true" className={`h-4 w-4 text-gray-400 transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </button>
        {canManage && (
          <button
            ref={editButtonRef}
            type="button"
            disabled={editDisabled}
            onClick={onEdit}
            aria-label={`Редактировать ${entry.candidateName}`}
            className="inline-flex min-h-11 min-w-11 items-center justify-center self-center rounded-xl text-gray-500 outline-none hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Pencil aria-hidden="true" className="h-4 w-4" />
          </button>
        )}
      </div>

      {expanded && (
        <div id={`talent-details-${entry.id}`} role="region" aria-label={`Детали кандидата ${entry.candidateName}`} className="grid min-w-0 gap-x-6 gap-y-4 bg-gray-50/60 px-4 py-4 text-sm sm:grid-cols-2 sm:px-5 lg:grid-cols-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-gray-500">Контакт</p>
            {contactLink ? <a href={contactLink} target={contactLink.startsWith('http') ? '_blank' : undefined} rel={contactLink.startsWith('http') ? 'noopener noreferrer' : undefined} className="mt-1 inline-flex max-w-full items-center gap-1 break-all font-medium text-gray-900 underline-offset-2 hover:underline">{entry.contact}<ExternalLink aria-hidden="true" className="h-3.5 w-3.5 shrink-0" /></a> : <p className="mt-1 break-all text-gray-800">{entry.contact}</p>}
          </div>
          <div className="min-w-0"><p className="text-xs font-medium text-gray-500">Вакансия или направление</p><p className="mt-1 break-words text-gray-800">{entry.vacancyDirection}</p></div>
          <div><p className="text-xs font-medium text-gray-500">Дата отправки тестового</p><p className="mt-1 text-gray-800">{shortDate(entry.testSentOn)}</p></div>
          <div className="min-w-0"><p className="text-xs font-medium text-gray-500">Тестовое задание</p>{testLink ? <a href={testLink} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex max-w-full items-center gap-1 break-all text-gray-900 underline-offset-2 hover:underline">Открыть тестовое<ExternalLink aria-hidden="true" className="h-3.5 w-3.5" /></a> : <p className="mt-1 break-words text-gray-800">{entry.testAssignment || 'Не указано'}</p>}</div>
          <div className="min-w-0"><p className="text-xs font-medium text-gray-500">Результат тестового</p><p className="mt-1 break-words text-gray-800">{entry.testResult || 'Не указан'}</p></div>
          <div><p className="text-xs font-medium text-gray-500">Дата собеседования</p><p className="mt-1 text-gray-800">{shortDate(entry.interviewOn)}</p></div>
          {entry.stage === 'return_later' && <><div><p className="text-xs font-medium text-gray-500">Когда вернуться</p><p className="mt-1 text-gray-800">{shortDate(entry.revisitOn)}</p></div><div className="min-w-0"><p className="text-xs font-medium text-gray-500">Заметка к возврату</p><p className="mt-1 break-words text-gray-800">{entry.revisitNote || 'Не указана'}</p></div></>}
          <div className="min-w-0 sm:col-span-2 lg:col-span-3"><p className="text-xs font-medium text-gray-500">Комментарий</p><p className="mt-1 whitespace-pre-wrap break-words text-gray-800">{entry.comment || 'Не указан'}</p></div>
        </div>
      )}
    </article>
  );
}

export default function TeamTalentReservePanel() {
  const [response, setResponse] = useState<TeamTalentReserveResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [query, setQuery] = useState('');
  const [stageFilter, setStageFilter] = useState<'all' | TeamTalentReserveStage>('all');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<FormMode | null>(null);
  const [editing, setEditing] = useState<TeamTalentReserveEntry | null>(null);
  const [values, setValues] = useState<TalentFormState>(emptyForm());
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState('');
  const [conflicted, setConflicted] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const requestSequence = useRef(0);
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const editButtonRefs = useRef(new Map<string, HTMLButtonElement>());

  const load = useCallback(async () => {
    const requestId = ++requestSequence.current;
    setLoading(true);
    setLoadError('');
    try {
      const payload = await teamApiFetch('/api/team/talent-reserve');
      if (requestId !== requestSequence.current) return;
      setResponse(normalizeTalentReserve(payload));
    } catch (error) {
      if (requestId !== requestSequence.current) return;
      setLoadError(error instanceof Error ? error.message : 'Не удалось загрузить кадровый резерв.');
    } finally {
      if (requestId === requestSequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Initial remote synchronization belongs to this subscription effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    return () => { requestSequence.current += 1; };
  }, [load]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('ru-RU');
    return (response?.entries || []).filter((entry) => {
      if (stageFilter !== 'all' && entry.stage !== stageFilter) return false;
      if (!needle) return true;
      return [entry.candidateName, entry.contact, entry.vacancyDirection, entry.testAssignment || '', entry.testResult || '', entry.comment || '', entry.revisitNote || '']
        .some((value) => value.toLocaleLowerCase('ru-RU').includes(needle));
    });
  }, [query, response?.entries, stageFilter]);

  const asOf = response?.asOf || '';
  const attentionEntries = filtered.filter((entry) => isAttention(entry, asOf));
  const activeEntries = filtered.filter((entry) => ACTIVE_STAGES.has(entry.stage) && !isAttention(entry, asOf));
  const historyEntries = filtered.filter((entry) => !ACTIVE_STAGES.has(entry.stage));
  const canManage = response?.canManage === true;
  const editDisabled = mode !== null || saving;

  const openCreate = () => {
    setMode('create');
    setEditing(null);
    setValues(emptyForm());
    setActionError('');
    setConflicted(false);
    setDeleting(false);
  };

  const openEdit = (entry: TeamTalentReserveEntry) => {
    if (editDisabled) return;
    setMode('edit');
    setEditing(entry);
    setValues(entryForm(entry));
    setActionError('');
    setConflicted(false);
    setDeleting(false);
  };

  const closeForm = async () => {
    if (saving) return;
    const editedId = editing?.id;
    setMode(null);
    setEditing(null);
    setActionError('');
    setDeleting(false);
    if (conflicted) await load();
    window.requestAnimationFrame(() => {
      if (editedId) editButtonRefs.current.get(editedId)?.focus();
      else createButtonRef.current?.focus();
    });
  };

  const save = async () => {
    setSaving(true);
    setActionError('');
    const current = editing;
    try {
      const body = buildTeamTalentReserveWrite(values);
      await teamApiFetch(current ? `/api/team/talent-reserve/${current.id}` : '/api/team/talent-reserve', {
        method: current ? 'PATCH' : 'POST',
        body: JSON.stringify(current ? { ...body, expectedUpdatedAt: current.updatedAt } : body),
      });
      setMode(null);
      setEditing(null);
      await load();
      window.requestAnimationFrame(() => {
        if (current) editButtonRefs.current.get(current.id)?.focus();
        else createButtonRef.current?.focus();
      });
    } catch (error) {
      if (error instanceof TeamApiError && error.code === 'talent_reserve_conflict') {
        setConflicted(true);
        setActionError(CONFLICT_MESSAGE);
      } else {
        setActionError(error instanceof Error ? error.message : 'Не удалось сохранить запись.');
      }
    } finally {
      setSaving(false);
    }
  };

  const archive = async () => {
    if (!editing) return;
    const current = editing;
    setSaving(true);
    setActionError('');
    try {
      await teamApiFetch(`/api/team/talent-reserve/${current.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ stage: 'archived', expectedUpdatedAt: current.updatedAt }),
      });
      setMode(null);
      setEditing(null);
      await load();
      window.requestAnimationFrame(() => editButtonRefs.current.get(current.id)?.focus());
    } catch (error) {
      if (error instanceof TeamApiError && error.code === 'talent_reserve_conflict') {
        setConflicted(true);
        setActionError(CONFLICT_MESSAGE);
      } else setActionError(error instanceof Error ? error.message : 'Не удалось переместить запись в архив.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!editing) return;
    if (!deleting) {
      setDeleting(true);
      return;
    }
    const current = editing;
    setSaving(true);
    setActionError('');
    try {
      await teamApiFetch(`/api/team/talent-reserve/${current.id}`, {
        method: 'DELETE',
        body: JSON.stringify({ expectedUpdatedAt: current.updatedAt }),
      });
      setMode(null);
      setEditing(null);
      setDeleting(false);
      await load();
      window.requestAnimationFrame(() => createButtonRef.current?.focus());
    } catch (error) {
      if (error instanceof TeamApiError && error.code === 'talent_reserve_conflict') {
        setConflicted(true);
        setActionError(CONFLICT_MESSAGE);
      } else setActionError(error instanceof Error ? error.message : 'Не удалось удалить запись.');
    } finally {
      setSaving(false);
    }
  };

  const renderGroup = (key: 'attention' | 'active' | 'history', title: string, entries: TeamTalentReserveEntry[]) => {
    if (!entries.length) return null;
    return (
      <section aria-labelledby={`talent-group-${key}`}>
        <div className="flex items-center justify-between border-b border-gray-100 bg-gray-50/60 px-4 py-2.5 sm:px-5">
          <h3 id={`talent-group-${key}`} className="text-sm font-semibold text-gray-800">{title}</h3>
          <span className="text-xs tabular-nums text-gray-500">{entries.length}</span>
        </div>
        <div role="list">
          {entries.map((entry) => (
            <TalentRow
              key={entry.id}
              entry={entry}
              expanded={expanded.has(entry.id)}
              canManage={canManage}
              editDisabled={editDisabled}
              onToggle={() => setExpanded((current) => {
                const next = new Set(current);
                if (next.has(entry.id)) next.delete(entry.id);
                else next.add(entry.id);
                return next;
              })}
              onEdit={() => openEdit(entry)}
              editButtonRef={(node) => {
                if (node) editButtonRefs.current.set(entry.id, node);
                else editButtonRefs.current.delete(entry.id);
              }}
            />
          ))}
        </div>
      </section>
    );
  };

  return (
    <section role="region" aria-label="Кадровый резерв" aria-busy={loading || saving} className="min-w-0 overflow-hidden rounded-2xl border border-gray-200 bg-white text-gray-900">
      <header className="flex flex-col gap-4 px-4 py-5 sm:px-6 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <h3 className="text-lg font-bold tracking-tight">Кадровый резерв</h3>
          <p className="mt-1 max-w-[70ch] text-sm text-gray-500">Контакты кандидатов, текущий этап и дата следующего действия.</p>
        </div>
        {canManage && (
          <button ref={createButtonRef} type="button" disabled={mode !== null || loading} onClick={openCreate} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-gray-900 px-4 text-sm font-semibold text-white outline-none hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:opacity-60">
            <Plus aria-hidden="true" className="h-4 w-4" /> Добавить кандидата
          </button>
        )}
      </header>

      {mode && canManage && (
        <TalentForm
          mode={mode}
          values={values}
          saving={saving}
          error={actionError}
          deleting={deleting}
          onChange={(key, value) => setValues((current) => ({ ...current, [key]: value }))}
          onSubmit={save}
          onCancel={() => void closeForm()}
          onArchive={() => void archive()}
          onDelete={() => void remove()}
          onCancelDelete={() => setDeleting(false)}
        />
      )}

      <div className="grid gap-2 border-t border-gray-200 p-3 sm:grid-cols-[minmax(220px,1fr)_220px] sm:p-4">
        <label className="relative block">
          <span className="sr-only">Поиск по кадровому резерву</span>
          <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input type="search" aria-label="Поиск по кадровому резерву" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Имя, контакт или направление" className={`${TEAM_FORM_INPUT_CLASS} pl-9`} />
        </label>
        <label>
          <span className="sr-only">Фильтр по этапу</span>
          <select aria-label="Фильтр по этапу" value={stageFilter} onChange={(event) => setStageFilter(event.target.value as 'all' | TeamTalentReserveStage)} className={TEAM_FORM_INPUT_CLASS}>
            <option value="all">Все этапы</option>
            {STAGE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
      </div>

      {loadError && (
        <div role="alert" className="m-4 flex flex-col gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 sm:flex-row sm:items-center sm:justify-between">
          <span>{loadError}</span>
          <button type="button" onClick={() => void load()} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-red-300 bg-white px-3 font-medium outline-none hover:bg-red-100 focus-visible:ring-2 focus-visible:ring-red-500"><RefreshCw aria-hidden="true" className="h-4 w-4" /> Повторить</button>
        </div>
      )}

      {loading && !response ? (
        <div aria-label="Загрузка кадрового резерва" role="status">
          {[1, 2, 3].map((item) => <div key={item} className="flex min-h-20 items-center gap-3 border-t border-gray-100 px-5"><span className="h-4 w-40 animate-pulse rounded bg-gray-100 motion-reduce:animate-none" /><span className="ml-auto h-4 w-24 animate-pulse rounded bg-gray-100 motion-reduce:animate-none" /></div>)}
        </div>
      ) : !loadError && filtered.length === 0 ? (
        <div className="border-t border-gray-100 px-5 py-10 text-center"><p className="text-sm font-medium text-gray-800">{query || stageFilter !== 'all' ? 'По этим условиям никого не нашли' : 'В кадровом резерве пока никого нет'}</p><p className="mt-1 text-sm text-gray-500">Измените фильтры или добавьте первого кандидата.</p></div>
      ) : (
        <div className="border-t border-gray-200">
          {renderGroup('attention', 'Требуют внимания', attentionEntries)}
          {renderGroup('active', 'В работе', activeEntries)}
          {renderGroup('history', 'История', historyEntries)}
        </div>
      )}
    </section>
  );
}
