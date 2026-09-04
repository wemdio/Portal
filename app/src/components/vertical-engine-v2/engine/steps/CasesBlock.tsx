'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import {
  VE_API,
  veEngineDelete,
  veEnginePost,
  type VeCaseCreateResponse,
  type VeCaseDeleteResponse,
  type VeCaseDraft,
  type VeCaseEntry,
  type VeCasePreviewResponse,
} from '../api';
import { HE, Spinner } from '../design';

const MAX_TEXT_LENGTH = 20_000;
const MAX_CASES = 20;

interface CasesBlockProps {
  projectId: string | null;
  cases: VeCaseEntry[];
  onCasesChanged?: () => void;
}

interface PreviewItem {
  draft: VeCaseDraft;
  included: boolean;
  key: number;
}

type CaseContent = Pick<VeCaseEntry, 'industry' | 'client_type' | 'task' | 'result' | 'metrics' | 'text'>;

function caseTitle(entry: CaseContent): string {
  return entry.client_type?.trim() || entry.industry?.trim() || entry.task?.trim() || 'Содержание требует проверки';
}

function metricValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'boolean') return value ? 'да' : 'нет';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function CaseFields({ entry, preview = false }: { entry: CaseContent; preview?: boolean }) {
  const fields = [
    ['Клиент', entry.client_type],
    ['Отрасль', entry.industry],
    ['Задача', entry.task],
    ['Результат', entry.result],
  ] as const;
  const metrics = Object.entries(entry.metrics ?? {})
    .map(([label, value]) => [label, metricValue(value)] as const)
    .filter(([, value]) => value !== '');

  return (
    <div className="min-w-0 max-w-[70ch] space-y-3 pb-1">
      <dl className="space-y-2.5 text-sm leading-relaxed">
        {fields.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[76px_minmax(0,1fr)] gap-x-3">
            <dt className={`text-xs leading-relaxed ${HE.muted}`}>{label}</dt>
            <dd className="min-w-0 whitespace-pre-wrap break-words">{value?.trim() || <span className={HE.muted}>Не указано</span>}</dd>
          </div>
        ))}
        <div className="grid grid-cols-[76px_minmax(0,1fr)] gap-x-3">
          <dt className={`text-xs leading-relaxed ${HE.muted}`}>Цифры</dt>
          <dd className="min-w-0 break-words">
            {metrics.length > 0 ? (
              <ul className="space-y-1">
                {metrics.map(([label, value]) => <li key={label}>{label}: {value}</li>)}
              </ul>
            ) : <span className={HE.muted}>Не указано</span>}
          </dd>
        </div>
      </dl>
      {entry.text?.trim() ? (
        <details className="text-xs">
          <summary className={`cursor-pointer py-1 ${HE.muted}`}>
            {preview ? 'Фрагмент исходного текста' : 'Сохранённое содержание'}
          </summary>
          <p className={`mt-2 max-w-[70ch] whitespace-pre-wrap break-words leading-relaxed ${HE.muted}`}>{entry.text}</p>
        </details>
      ) : !preview ? (
        <p className={`text-xs ${HE.muted}`}>Сохранённого текста нет.</p>
      ) : null}
    </div>
  );
}

/** A new project owns a new draft; late responses cannot populate another project. */
export function CasesBlock(props: CasesBlockProps) {
  return <ProjectCasesBlock key={props.projectId ?? 'no-project'} {...props} />;
}

function ProjectCasesBlock({ projectId, cases, onCasesChanged }: CasesBlockProps) {
  const id = useId();
  const mountedRef = useRef(true);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const previewHeadingRef = useRef<HTMLHeadingElement>(null);
  const requestBusyRef = useRef(false);
  const [text, setText] = useState('');
  const [filename, setFilename] = useState('');
  const [preview, setPreview] = useState<PreviewItem[] | null>(null);
  const [action, setAction] = useState<'preview' | 'save' | 'delete' | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const isPreview = preview !== null;
  const busy = action !== null;
  const selected = preview?.filter((item) => item.included) ?? [];
  const tooLong = text.length > MAX_TEXT_LENGTH;

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (isPreview) previewHeadingRef.current?.focus();
  }, [isPreview]);

  const refreshCases = async () => {
    try {
      await onCasesChanged?.();
    } catch {
      if (mountedRef.current) setError('Изменения сохранены, но список не обновился. Обновите страницу.');
    }
  };

  const finishRequest = () => {
    requestBusyRef.current = false;
    if (mountedRef.current) {
      setAction(null);
      setDeletingId(null);
    }
  };

  const handlePreview = async () => {
    if (!projectId || !text.trim() || tooLong || requestBusyRef.current) return;
    requestBusyRef.current = true;
    setAction('preview');
    setError('');
    setNotice('');
    try {
      const { ok, data } = await veEnginePost<VeCasePreviewResponse>(`${VE_API}/projects/${projectId}/cases`, {
        mode: 'preview', text: text.trim(), filename: filename.trim() || undefined,
      });
      if (!mountedRef.current) return;
      if (!ok || !data.cases?.length) {
        setError(data.error || 'Не удалось выделить законченные кейсы. Укажите, для кого была работа, что сделали и какой получили результат.');
        return;
      }
      if (data.cases.length > MAX_CASES) {
        setError('В одном разборе можно сохранить до 20 кейсов. Разделите текст на несколько частей.');
        return;
      }
      setPreview(data.cases.map((draft, key) => ({ draft, key, included: true })));
    } catch {
      if (mountedRef.current) setError('Не удалось разобрать текст. Проверьте соединение и попробуйте снова, введённый текст сохранён.');
    } finally {
      finishRequest();
    }
  };

  const handleSave = async () => {
    if (!projectId || !selected.length || requestBusyRef.current) return;
    requestBusyRef.current = true;
    setAction('save');
    setError('');
    try {
      const { ok, data } = await veEnginePost<VeCaseCreateResponse>(`${VE_API}/projects/${projectId}/cases`, {
        mode: 'save', text: text.trim(), filename: filename.trim() || undefined,
        cases: selected.map((item) => item.draft),
      });
      if (!mountedRef.current) return;
      if (!ok || !data.cases?.length) {
        setError(data.error || 'Не удалось подтвердить сохранение кейсов. Проверьте список перед повторной попыткой.');
        return;
      }
      setNotice(`Сохранено кейсов: ${data.count ?? data.cases.length}.`);
      setPreview(null);
      setText('');
      setFilename('');
      await refreshCases();
    } catch {
      if (mountedRef.current) setError('Ответ о сохранении не получен. Проверьте список кейсов перед повторной попыткой, разбор остаётся здесь.');
    } finally {
      finishRequest();
    }
  };

  const handleDelete = async (entry: VeCaseEntry) => {
    if (!projectId || requestBusyRef.current || !window.confirm(`Удалить кейс «${caseTitle(entry)}»?`)) return;
    requestBusyRef.current = true;
    setAction('delete');
    setDeletingId(entry.id);
    setError('');
    setNotice('');
    try {
      const { ok, data } = await veEngineDelete<VeCaseDeleteResponse>(`${VE_API}/projects/${projectId}/cases`, { id: entry.id });
      if (!mountedRef.current) return;
      if (!ok) {
        setError(data.error || 'Не удалось удалить кейс');
        return;
      }
      setNotice('Кейс удалён.');
      await refreshCases();
    } catch {
      if (mountedRef.current) setError('Не удалось получить ответ об удалении. Обновите список кейсов.');
    } finally {
      finishRequest();
    }
  };

  return (
    <section className={`min-w-0 text-left ${HE.formPanel}`} aria-labelledby={`${id}-title`} aria-busy={busy}>
      <h3 id={`${id}-title`} className={HE.eyebrow}>Кейсы клиента ({cases.length})</h3>
      <p className={`mt-2 max-w-[70ch] text-xs leading-relaxed ${HE.muted}`}>
        Один кейс описывает одну выполненную работу для клиента. Можно вставить несколько кейсов одним текстом: перед сохранением вы увидите, как движок их разделил и какие факты извлёк.
      </p>
      <p className={`mt-2 max-w-[70ch] text-xs leading-relaxed ${HE.muted}`}>
        Кейсы с сайта появятся после его изучения. При подготовке писем движок выбирает подходящие кейсы под аудиторию.
      </p>

      {cases.length > 0 ? (
        <ol className="mt-4 list-none">
          {cases.map((entry, index) => (
            <li key={entry.id} className="flex items-start gap-2 border-b border-[var(--ve2-line)] py-3 first:border-t">
              <details className="group min-w-0 flex-1">
                <summary className="flex cursor-pointer list-none items-start gap-2 [&::-webkit-details-marker]:hidden">
                  <span className={`${HE.faint} shrink-0 pt-0.5`}>{String(index + 1).padStart(2, '0')}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block break-words text-sm font-medium leading-relaxed">{caseTitle(entry)}</span>
                    <span className={`mt-0.5 block text-xs ${HE.muted}`}>{entry.source === 'site' ? 'С сайта' : 'Добавлен вручную'}</span>
                    <span className={`mt-2 block line-clamp-2 break-words text-xs leading-relaxed ${HE.muted}`}>Задача: {entry.task?.trim() || 'Не указано'}</span>
                    <span className={`mt-1 block line-clamp-2 break-words text-xs leading-relaxed ${HE.muted}`}>Результат: {entry.result?.trim() || 'Не указано'}</span>
                  </span>
                  <ChevronDown aria-hidden className="mt-1 h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-180" />
                </summary>
                <div className="mt-4">
                  {entry.filename ? <p className={`mb-3 break-words text-xs ${HE.muted}`}>Источник: {entry.filename}</p> : null}
                  <CaseFields entry={entry} />
                </div>
              </details>
              {entry.source === 'upload' ? (
                <button type="button" className={`${HE.btnQuiet} shrink-0`} disabled={busy} onClick={() => void handleDelete(entry)} aria-label={`Удалить кейс ${index + 1}`}>
                  {deletingId === entry.id ? <Spinner className="h-3.5 w-3.5" /> : 'Удалить'}
                </button>
              ) : null}
            </li>
          ))}
        </ol>
      ) : <p className={`mt-4 text-xs ${HE.muted}`}>Сохранённых кейсов пока нет. Добавьте описание выполненной работы ниже.</p>}

      <div className="mt-6">
        {isPreview ? (
          <>
            <h4 ref={previewHeadingRef} tabIndex={-1} className="text-sm font-semibold">Найдено кейсов: {preview.length}</h4>
            <p className={`mt-1 text-xs leading-relaxed ${HE.muted}`}>Проверьте каждый кейс и его исходный фрагмент. Снимите отметку с того, что не нужно сохранять. Пока ничего не добавлено.</p>
            {filename.trim() ? <p className={`mt-2 break-words text-xs ${HE.muted}`}>Источник: {filename.trim()}</p> : null}
            <ol className="mt-3 list-none">
              {preview.map(({ draft, key, included }, index) => (
                <li key={key} className="border-t border-[var(--ve2-line)] py-4">
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <h5 className="min-w-0 break-words text-sm font-semibold">{index + 1}. {caseTitle(draft)}</h5>
                    <label className="flex shrink-0 cursor-pointer items-center gap-1.5 py-0.5 text-xs">
                      <input type="checkbox" checked={included} disabled={busy} aria-label={`Сохранить кейс ${index + 1}`} onChange={(event) => setPreview((items) => items?.map((item) => item.key === key ? { ...item, included: event.target.checked } : item) ?? null)} />
                      Сохранить
                    </label>
                  </div>
                  <CaseFields entry={draft} preview />
                </li>
              ))}
            </ol>
            <div className="flex flex-wrap items-center gap-2 border-t border-[var(--ve2-line)] pt-3">
              <button type="button" className={HE.btnPrimary} disabled={busy || !selected.length} onClick={() => void handleSave()}>
                {action === 'save' ? <Spinner className="h-3.5 w-3.5" /> : null}
                Сохранить выбранные ({selected.length})
              </button>
              <button type="button" className={HE.btnQuiet} disabled={busy} onClick={() => {
                setPreview(null);
                setError('');
                window.requestAnimationFrame(() => textRef.current?.focus());
              }}>Изменить исходный текст</button>
            </div>
          </>
        ) : (
          <>
            <label htmlFor={`${id}-text`} className="text-sm font-medium">Добавить кейсы из текста</label>
            <p id={`${id}-hint`} className={`mt-1 text-xs leading-relaxed ${HE.muted}`}>Вставьте текст из документа или презентации. Для каждого проекта желательно указать клиента, задачу и результат. До 20 кейсов за один разбор.</p>
            <textarea ref={textRef} id={`${id}-text`} rows={5} value={text} disabled={busy || !projectId} aria-describedby={`${id}-hint ${id}-limit`} aria-invalid={tooLong} onChange={(event) => { setText(event.target.value); setError(''); setNotice(''); }} placeholder={'Кейс 1. Для кого работали, что сделали, какой результат получили.\n\nКейс 2. Другой проект и его результат.'} className={`mt-2 resize-y ${HE.input}`} />
            <p id={`${id}-limit`} className={`mt-1 text-xs ${tooLong ? 'text-[var(--ve2-err)]' : HE.muted}`}>{text.length.toLocaleString('ru-RU')} / 20 000 символов{tooLong ? '. Разделите текст на несколько частей.' : ''}</p>
            <label htmlFor={`${id}-source`} className={`mt-3 block text-xs ${HE.muted}`}>Источник (необязательно)</label>
            <input id={`${id}-source`} type="text" value={filename} disabled={busy || !projectId} maxLength={200} onChange={(event) => setFilename(event.target.value)} placeholder="Например: презентация клиента, сентябрь" className={`mt-1 ${HE.input}`} />
            <button type="button" className={`mt-3 ${HE.btnSmall}`} disabled={busy || !projectId || !text.trim() || tooLong} onClick={() => void handlePreview()}>
              {action === 'preview' ? <Spinner className="h-3.5 w-3.5" /> : null}
              {action === 'preview' ? 'Разбираем кейсы…' : 'Разобрать текст'}
            </button>
          </>
        )}
      </div>
      {error ? <p role="alert" className="mt-3 text-xs leading-relaxed text-[var(--ve2-err)]">{error}</p> : null}
      {notice ? <p role="status" className="mt-3 text-xs text-[var(--ve2-ok)]">{notice}</p> : null}
    </section>
  );
}
