'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { authFetch, authFetchJson, getAccessToken } from '@/lib/authFetch';
import type { EmailSequenceV2LetterRow, EmailSequenceV2OutputLanguage, EmailSequenceV2RunRow } from '@/types';
import { ClientTariffUsageInline } from '@/components/client/ClientTariffUsageInline';

const VALUES_MODEL_OPTIONS = [
  { value: 'gpt-5.2', label: 'gpt-5.2 (качество)' },
  { value: 'gpt-4.1', label: 'gpt-4.1 (баланс)' },
  { value: 'gpt-4.1-mini', label: 'gpt-4.1-mini (быстро)' },
];

const WRITER_MODEL_OPTIONS = [
  { value: 'gpt-5.2', label: 'gpt-5.2 (качество писем)' },
  { value: 'gpt-4.1', label: 'gpt-4.1 (баланс)' },
  { value: 'gpt-4.1-mini', label: 'gpt-4.1-mini (быстро)' },
];

// Язык, на котором инструмент пишет ценности и цепочку писем.
// Входные данные (бриф, сегмент, правки) могут быть на любом из языков.
const LANGUAGE_OPTIONS: Array<{ value: EmailSequenceV2OutputLanguage; label: string }> = [
  { value: 'ru', label: '🇷🇺 Русский' },
  { value: 'en', label: '🇬🇧 English' },
  { value: 'pl', label: '🇵🇱 Polski' },
];

const REQUEST_TIMEOUT_VALUES_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_LETTERS_MS = 6 * 60 * 1000;

type Busy =
  | null
  | 'creating'
  | 'extracting-values'
  | 'saving-stage-2'
  | 'generating-letters'
  | 'deleting-run'
  | { type: 'letter'; action: 'save' | 'delete' | 'add'; id: string }
  | 'export-docx';

function busyEquals(a: Busy, b: Busy): boolean {
  if (a == null || b == null) return a === b;
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  return a.type === b.type && a.action === b.action && a.id === b.id;
}

async function authedFetchWithTimeout<T = unknown>(path: string, init?: RequestInit, timeoutMs = REQUEST_TIMEOUT_VALUES_MS): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await authFetchJson<T>(path, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('Операция заняла слишком много времени. Попробуйте ещё раз.');
    }
    throw err;
  } finally {
    window.clearTimeout(timer);
  }
}

function formatDate(value: string | null | undefined): string {
  const s = String(value ?? '').trim();
  if (!s) return '—';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('ru-RU', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function statusLabel(s: EmailSequenceV2RunRow['status']): string {
  switch (s) {
    case 'draft':
      return 'Черновик';
    case 'extracting_values':
      return 'Извлечение ценностей…';
    case 'values_ready':
      return 'Ценности готовы';
    case 'generating_letters':
      return 'Генерация писем…';
    case 'completed':
      return 'Готово';
    case 'failed':
      return 'Ошибка';
    case 'cancelled':
      return 'Отменено';
    default:
      return String(s);
  }
}

function statusClasses(s: EmailSequenceV2RunRow['status'], clientMode = false): string {
  if (clientMode) {
    // Editorial: neutral pill (no candy-coloured fills), semantic text colour
    // only where it carries meaning. Border via divider token.
    if (s === 'failed') return 'text-[var(--cp-red)] border-[var(--cp-divider-strong)]';
    if (s === 'completed') return 'text-[var(--cp-green)] border-[var(--cp-divider-strong)]';
    return 'text-[var(--cp-paper-mute)] border-[var(--cp-divider-strong)]';
  }
  switch (s) {
    case 'extracting_values':
    case 'generating_letters':
      return 'bg-blue-50 text-blue-700 border-blue-200';
    case 'values_ready':
      return 'bg-amber-50 text-amber-800 border-amber-200';
    case 'completed':
      return 'bg-emerald-50 text-emerald-700 border-emerald-200';
    case 'failed':
      return 'bg-red-50 text-red-700 border-red-200';
    case 'cancelled':
      return 'bg-gray-50 text-gray-600 border-gray-200';
    default:
      return 'bg-gray-50 text-gray-600 border-gray-200';
  }
}

function Section({ title, subtitle, children, right, clientMode }: { title: string; subtitle?: string; children: React.ReactNode; right?: React.ReactNode; clientMode?: boolean }) {
  return (
    <div className={clientMode ? 'neu-card p-6' : 'rounded-2xl border border-gray-200 bg-white p-6'}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className={clientMode ? 'text-base font-semibold m-0' : 'text-lg font-semibold text-gray-900'} style={clientMode ? { color: 'var(--cp-paper)' } : undefined}>{title}</h2>
          {subtitle && <p className={clientMode ? 'mt-1 text-xs' : 'text-sm text-gray-500 mt-1'} style={clientMode ? { color: 'var(--cp-paper-mute)' } : undefined}>{subtitle}</p>}
        </div>
        {right}
      </div>
      <div className="mt-5">{children}</div>
    </div>
  );
}

function StageBadge({ index, label, active, done, clientMode }: { index: number; label: string; active: boolean; done: boolean; clientMode?: boolean }) {
  if (clientMode) {
    return (
      <div
        className="inline-flex items-center gap-2 rounded-md px-3 py-1 text-xs font-medium"
        style={{
          background: done ? 'var(--cp-surface-active)' : active ? 'var(--cp-surface-rest)' : 'transparent',
          border: '1px solid var(--cp-divider)',
          color: done || active ? 'var(--cp-paper)' : 'var(--cp-paper-faint)',
        }}
      >
        <span
          className="inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold"
          style={{
            background: done ? 'var(--cp-paper)' : 'var(--cp-surface-active)',
            color: done ? 'var(--cp-ink)' : active ? 'var(--cp-paper)' : 'var(--cp-paper-faint)',
          }}
        >
          {done ? '✓' : index}
        </span>
        {label}
      </div>
    );
  }
  const tone = done
    ? 'bg-emerald-100 text-emerald-700 border-emerald-200'
    : active
      ? 'bg-blue-100 text-blue-700 border-blue-200'
      : 'bg-gray-100 text-gray-600 border-gray-200';
  return (
    <div className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold ${tone}`}>
      <span className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold ${done ? 'bg-emerald-600 text-white' : active ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-600'}`}>
        {done ? '✓' : index}
      </span>
      {label}
    </div>
  );
}

function LetterCard({
  letter,
  busy,
  onSave,
  onDelete,
  onInsertAfter,
  isLast,
  clientMode,
}: {
  letter: EmailSequenceV2LetterRow;
  busy: Busy;
  onSave: (id: string, subject: string, body: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onInsertAfter: (afterIndex: number) => void;
  isLast: boolean;
  clientMode?: boolean;
}) {
  // Сбрасываем локальное состояние формы, когда меняется содержимое письма
  // на сервере (например, после Save или регенерации цепочки). Сравниваем
  // строкой "subject|body|updated_at" — чистая ленивая инициализация useState
  // без useEffect и без cascading-renders (правило react-hooks/set-state-in-effect).
  const versionKey = `${letter.subject ?? ''}|${letter.body ?? ''}|${letter.updated_at}`;
  const [storedVersionKey, setStoredVersionKey] = useState(versionKey);
  const [subject, setSubject] = useState(letter.subject ?? '');
  const [body, setBody] = useState(letter.body ?? '');
  const [dirty, setDirty] = useState(false);
  if (storedVersionKey !== versionKey) {
    setStoredVersionKey(versionKey);
    setSubject(letter.subject ?? '');
    setBody(letter.body ?? '');
    setDirty(false);
  }

  const isSaving = busyEquals(busy, { type: 'letter', action: 'save', id: letter.id });
  const isDeleting = busyEquals(busy, { type: 'letter', action: 'delete', id: letter.id });

  const dashedBtn = clientMode
    ? 'ds-btn-ghost inline-flex items-center text-xs disabled:opacity-40'
    : 'inline-flex items-center rounded-lg border border-dashed border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50';

  return (
    <div className={clientMode ? 'neu-card p-5' : 'rounded-2xl border border-gray-200 bg-white p-5'}>
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2">
          <span
            className={clientMode
              ? 'inline-flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold'
              : 'inline-flex h-7 w-7 items-center justify-center rounded-full bg-gray-900 text-white text-xs font-bold'}
            style={clientMode ? { background: 'var(--cp-paper)', color: 'var(--cp-ink)' } : undefined}
          >
            {letter.letter_index}
          </span>
          <div className={clientMode ? 'text-sm font-semibold' : 'text-sm font-semibold text-gray-900'} style={clientMode ? { color: 'var(--cp-paper)' } : undefined}>Письмо {letter.letter_index}</div>
          {letter.is_user_added && (
            <span
              className={clientMode ? 'inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-semibold' : 'inline-flex items-center rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[10px] font-semibold text-blue-700'}
              style={clientMode ? { background: 'var(--cp-surface-elev)', border: '1px solid var(--cp-divider)', color: 'var(--cp-paper-mute)' } : undefined}
            >
              добавлено вручную
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => navigator.clipboard.writeText(`${subject ? `Тема: ${subject}\n\n` : ''}${body}`)}
            className={clientMode ? 'ds-btn-ghost inline-flex items-center text-xs' : 'inline-flex items-center rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50'}
          >
            Копировать
          </button>
          <button
            type="button"
            onClick={() => onDelete(letter.id)}
            disabled={busy != null}
            className={clientMode ? 'ds-btn-ghost inline-flex items-center text-xs disabled:opacity-40' : 'inline-flex items-center rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50'}
            style={clientMode ? { color: 'var(--cp-red)' } : undefined}
          >
            {isDeleting ? 'Удаление…' : 'Удалить'}
          </button>
        </div>
      </div>
      <label className="block">
        <div className={clientMode ? 'ds-eyebrow mb-1' : 'text-xs font-medium text-gray-600 mb-1'}>Тема</div>
        <input
          value={subject}
          onChange={(e) => {
            setSubject(e.target.value);
            setDirty(true);
          }}
          placeholder="Тема письма"
          className={clientMode ? 'ds-input w-full' : 'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400'}
        />
      </label>
      <label className="mt-3 block">
        <div className={clientMode ? 'ds-eyebrow mb-1' : 'text-xs font-medium text-gray-600 mb-1'}>Тело письма</div>
        <textarea
          value={body}
          onChange={(e) => {
            setBody(e.target.value);
            setDirty(true);
          }}
          rows={Math.min(20, Math.max(6, body.split('\n').length + 1))}
          className={clientMode ? 'ds-input ds-mono w-full leading-relaxed' : 'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono leading-relaxed focus:outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400'}
        />
      </label>
      <div className="mt-3 flex items-center justify-between gap-3">
        <div className="text-xs" style={clientMode ? { color: 'var(--cp-paper-faint)' } : undefined}>
          <span className={clientMode ? '' : 'text-gray-500'}>Обновлено: {formatDate(letter.updated_at)}</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onInsertAfter(letter.letter_index)}
            disabled={busy != null}
            className={dashedBtn}
            title="Добавить новое письмо после этого"
          >
            + после
          </button>
          {isLast && (
            <button
              type="button"
              onClick={() => onInsertAfter(letter.letter_index)}
              disabled={busy != null}
              className={dashedBtn}
            >
              + добавить в конец
            </button>
          )}
          <button
            type="button"
            onClick={() => onSave(letter.id, subject, body)}
            disabled={!dirty || busy != null}
            className={clientMode ? 'ds-btn-primary inline-flex items-center disabled:opacity-40' : 'inline-flex items-center rounded-lg bg-blue-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50'}
          >
            {isSaving ? 'Сохранение…' : dirty ? 'Сохранить' : 'Сохранено'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function EmailSequenceV2View({ clientMode = false }: { clientMode?: boolean } = {}) {
  const [runs, setRuns] = useState<EmailSequenceV2RunRow[]>([]);
  const [run, setRun] = useState<EmailSequenceV2RunRow | null>(null);
  const [letters, setLetters] = useState<EmailSequenceV2LetterRow[]>([]);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [valuesModel, setValuesModel] = useState<string>(VALUES_MODEL_OPTIONS[0].value);
  const [writerModel, setWriterModel] = useState<string>(WRITER_MODEL_OPTIONS[0].value);
  const [outputLanguage, setOutputLanguage] = useState<EmailSequenceV2OutputLanguage>('ru');
  const [briefFile, setBriefFile] = useState<File | null>(null);
  const [briefText, setBriefText] = useState<string>('');
  // Сохранённый бриф из портала: client мог уже заполнить /client/brief,
  // тогда инструмент должен предложить взять его автоматом, а не
  // заставлять снова загружать PDF/копировать текст. По умолчанию для
  // клиента — режим 'saved', если сохранённый бриф не пустой.
  // Источник: /api/client/brief.compiled_brief_text — то же поле что
  // использует base-constructor.
  const [savedBriefText, setSavedBriefText] = useState<string>('');
  const [savedBriefAvailable, setSavedBriefAvailable] = useState<boolean>(false);
  const [briefInputMode, setBriefInputMode] = useState<'saved' | 'file' | 'text'>('file');
  const [segmentText, setSegmentText] = useState<string>('');
  const [customerEdits, setCustomerEdits] = useState<string>('');
  const [personalizationOps, setPersonalizationOps] = useState<string>('');

  const briefInputRef = useRef<HTMLInputElement | null>(null);
  const initialLoaded = useRef(false);

  const loadRuns = useCallback(async () => {
    const data = await authFetchJson<{ runs: EmailSequenceV2RunRow[] }>('/api/tools/email-sequence-v2/runs', { method: 'GET' });
    setRuns(data.runs ?? []);
  }, []);

  const loadRun = useCallback(async (runId: string) => {
    const data = await authFetchJson<{ run: EmailSequenceV2RunRow; letters: EmailSequenceV2LetterRow[] }>(
      `/api/tools/email-sequence-v2/runs/${runId}`,
      { method: 'GET' },
    );
    setRun(data.run);
    setLetters(data.letters ?? []);
    setSegmentText(data.run.segment_text ?? '');
    setCustomerEdits(data.run.customer_edits ?? '');
    setPersonalizationOps(data.run.personalization_operators ?? '');
    setValuesModel(data.run.values_model ?? VALUES_MODEL_OPTIONS[0].value);
    setWriterModel(data.run.writer_model ?? WRITER_MODEL_OPTIONS[0].value);
    setOutputLanguage(data.run.output_language ?? 'ru');
  }, []);

  useEffect(() => {
    if (initialLoaded.current) return;
    initialLoaded.current = true;
    loadRuns().catch((e) => setError(e instanceof Error ? e.message : 'Ошибка'));
  }, [loadRuns]);

  // Fire-and-forget: загружаем сохранённый бриф клиента с /api/client/brief.
  // Если есть compiled_brief_text — переключаем дефолтный режим ввода в
  // 'saved' и подсовываем его текст в инпут (read-only preview). Без
  // этого клиент, заполнивший бриф на /client/brief, был вынужден
  // отдельно загружать PDF/копировать текст — это исходный UX-провал
  // («у нас цепочка работает только по загруженному брифу, не из
  // заполненного на сайте?»). Тихий failure: если запрос упал, остаёмся
  // в режиме file/text как раньше.
  const savedBriefLoaded = useRef(false);
  useEffect(() => {
    if (savedBriefLoaded.current) return;
    savedBriefLoaded.current = true;
    void (async () => {
      try {
        const res = await authFetchJson<{ compiled_brief_text?: string }>('/api/client/brief');
        const text = (res.compiled_brief_text ?? '').trim();
        if (text) {
          setSavedBriefText(text);
          setSavedBriefAvailable(true);
          setBriefInputMode('saved');
        }
      } catch { /* non-critical: leave defaults */ }
    })();
  }, []);

  const showNotice = useCallback((msg: string, ms = 3500) => {
    setNotice(msg);
    window.setTimeout(() => setNotice((cur) => (cur === msg ? null : cur)), ms);
  }, []);

  const createRun = useCallback(async () => {
    setBusy('creating');
    setError(null);
    try {
      const data = await authFetchJson<{ run: EmailSequenceV2RunRow }>('/api/tools/email-sequence-v2/runs', {
        method: 'POST',
        body: JSON.stringify({ values_model: valuesModel, writer_model: writerModel, output_language: outputLanguage }),
      });
      setRun(data.run);
      setLetters([]);
      setSegmentText('');
      setCustomerEdits('');
      setPersonalizationOps('');
      setBriefFile(null);
      setBriefText('');
      await loadRuns();
      showNotice('Создан новый запуск');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка');
    } finally {
      setBusy(null);
    }
  }, [loadRuns, showNotice, valuesModel, writerModel, outputLanguage]);

  // Смена языка вывода. Если запуск уже существует — сразу сохраняем выбор,
  // чтобы он применился и к ценностям, и к генерации цепочки.
  const changeLanguage = useCallback(
    async (lang: EmailSequenceV2OutputLanguage) => {
      setOutputLanguage(lang);
      if (!run) return;
      try {
        const data = await authFetchJson<{ run: EmailSequenceV2RunRow }>(`/api/tools/email-sequence-v2/runs/${run.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ output_language: lang }),
        });
        setRun(data.run);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Ошибка');
      }
    },
    [run],
  );

  const resetForNewRun = useCallback(() => {
    setRun(null);
    setLetters([]);
    setSegmentText('');
    setCustomerEdits('');
    setPersonalizationOps('');
    setBriefFile(null);
    setBriefText('');
    setError(null);
  }, []);

  const extractValues = useCallback(async () => {
    if (!run) return;
    // Source resolution by mode:
    //   - saved: используем cached savedBriefText (read-only preview из портала)
    //   - file: multipart/form-data с PDF/DOCX
    //   - text: plain text JSON
    // Если выбранный режим не имеет данных — soft error прежде чем сетевой
    // запрос. file и saved оба в итоге шлют text через JSON-endpoint, так
    // что серверный API не меняется (multipart остаётся для file-uploads).
    const effectiveText =
      briefInputMode === 'saved' ? savedBriefText :
      briefInputMode === 'text' ? briefText :
      '';
    const useFileUpload = briefInputMode === 'file' && briefFile != null;
    if (!useFileUpload && !effectiveText.trim()) {
      setError(
        briefInputMode === 'saved'
          ? 'Сохранённый бриф пуст. Заполните его на странице «Бриф» или переключитесь на файл/текст.'
          : briefInputMode === 'file'
            ? 'Загрузите PDF/DOCX файл брифа.'
            : 'Вставьте текст брифа.',
      );
      return;
    }
    setBusy('extracting-values');
    setError(null);
    try {
      let res: Response;
      if (useFileUpload) {
        const fd = new FormData();
        fd.append('file', briefFile!);
        fd.append('model', valuesModel);
        fd.append('language', outputLanguage);
        const token = await getAccessToken();
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_VALUES_MS);
        try {
          res = await fetch(`/api/tools/email-sequence-v2/runs/${run.id}/extract-values`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            body: fd,
            signal: controller.signal,
          });
        } finally {
          window.clearTimeout(timer);
        }
      } else {
        const fetchedRes = await authFetch(`/api/tools/email-sequence-v2/runs/${run.id}/extract-values`, {
          method: 'POST',
          body: JSON.stringify({ text: effectiveText, model: valuesModel, language: outputLanguage }),
        });
        res = fetchedRes;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(data?.error ?? `Error ${res.status}`);
      }
      const data = (await res.json()) as { run: EmailSequenceV2RunRow };
      setRun(data.run);
      setBriefFile(null);
      await loadRuns();
      showNotice('Ценности сгенерированы');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка');
    } finally {
      setBusy(null);
    }
  }, [briefFile, briefText, briefInputMode, savedBriefText, loadRuns, run, showNotice, valuesModel, outputLanguage]);

  const saveStage2 = useCallback(async () => {
    if (!run) return;
    if (!segmentText.trim()) {
      setError('Заполните сегмент базы.');
      return;
    }
    setBusy('saving-stage-2');
    setError(null);
    try {
      const data = await authFetchJson<{ run: EmailSequenceV2RunRow }>(`/api/tools/email-sequence-v2/runs/${run.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          segment_text: segmentText,
          customer_edits: customerEdits,
          personalization_operators: personalizationOps,
          writer_model: writerModel,
        }),
      });
      setRun(data.run);
      showNotice('Сегмент и правки сохранены');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка');
    } finally {
      setBusy(null);
    }
  }, [customerEdits, personalizationOps, run, segmentText, showNotice, writerModel]);

  const generateLetters = useCallback(async () => {
    if (!run) return;
    if (!segmentText.trim()) {
      setError('Сначала заполните сегмент (этап 2) и сохраните.');
      return;
    }
    if (!run.values_text) {
      setError('Сначала сгенерируйте ценности (этап 1).');
      return;
    }
    setBusy('generating-letters');
    setError(null);
    try {
      // Сохраним этап 2 перед генерацией, если есть несохранённые изменения.
      await authFetchJson(`/api/tools/email-sequence-v2/runs/${run.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          segment_text: segmentText,
          customer_edits: customerEdits,
          personalization_operators: personalizationOps,
          writer_model: writerModel,
        }),
      });
      const data = await authedFetchWithTimeout<{ run: EmailSequenceV2RunRow; letters: EmailSequenceV2LetterRow[] }>(
        `/api/tools/email-sequence-v2/runs/${run.id}/generate-letters`,
        { method: 'POST', body: JSON.stringify({ model: writerModel, language: outputLanguage }) },
        REQUEST_TIMEOUT_LETTERS_MS,
      );
      setRun(data.run);
      setLetters(data.letters ?? []);
      showNotice(`Цепочка сгенерирована: ${data.letters?.length ?? 0} писем`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка');
    } finally {
      setBusy(null);
    }
  }, [customerEdits, personalizationOps, run, segmentText, showNotice, writerModel, outputLanguage]);

  const saveLetter = useCallback(
    async (id: string, subject: string, body: string) => {
      if (!run) return;
      setBusy({ type: 'letter', action: 'save', id });
      setError(null);
      try {
        const data = await authFetchJson<{ letter: EmailSequenceV2LetterRow }>(
          `/api/tools/email-sequence-v2/runs/${run.id}/letters/${id}`,
          {
            method: 'PATCH',
            body: JSON.stringify({ subject: subject || null, body }),
          },
        );
        setLetters((prev) => prev.map((l) => (l.id === id ? data.letter : l)));
        showNotice('Письмо сохранено');
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Ошибка');
      } finally {
        setBusy(null);
      }
    },
    [run, showNotice],
  );

  const deleteLetter = useCallback(
    async (id: string) => {
      if (!run) return;
      if (!window.confirm('Удалить это письмо? Восстановить будет нельзя.')) return;
      setBusy({ type: 'letter', action: 'delete', id });
      setError(null);
      try {
        await authFetchJson(`/api/tools/email-sequence-v2/runs/${run.id}/letters/${id}`, { method: 'DELETE' });
        await loadRun(run.id);
        showNotice('Письмо удалено');
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Ошибка');
      } finally {
        setBusy(null);
      }
    },
    [loadRun, run, showNotice],
  );

  const insertLetterAfter = useCallback(
    async (afterIndex: number) => {
      if (!run) return;
      const subject = window.prompt('Тема нового письма (можно оставить пустым):', '') ?? '';
      const body = window.prompt('Текст нового письма:', '') ?? '';
      if (!body.trim()) return;
      setBusy({ type: 'letter', action: 'add', id: 'new' });
      setError(null);
      try {
        await authFetchJson(`/api/tools/email-sequence-v2/runs/${run.id}/letters`, {
          method: 'POST',
          body: JSON.stringify({ subject, body, insert_after_index: afterIndex }),
        });
        await loadRun(run.id);
        showNotice('Письмо добавлено');
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Ошибка');
      } finally {
        setBusy(null);
      }
    },
    [loadRun, run, showNotice],
  );

  const addLetterAtEnd = useCallback(async () => {
    if (!run) return;
    const lastIndex = letters.length ? Math.max(...letters.map((l) => l.letter_index)) : 0;
    await insertLetterAfter(lastIndex);
  }, [insertLetterAfter, letters, run]);

  const deleteRun = useCallback(async () => {
    if (!run) return;
    if (!window.confirm('Удалить весь запуск (с письмами)? Восстановить нельзя.')) return;
    setBusy('deleting-run');
    setError(null);
    try {
      await authFetchJson(`/api/tools/email-sequence-v2/runs/${run.id}`, { method: 'DELETE' });
      resetForNewRun();
      await loadRuns();
      showNotice('Запуск удалён');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка');
    } finally {
      setBusy(null);
    }
  }, [loadRuns, resetForNewRun, run, showNotice]);

  const downloadValuesDocx = useCallback(async () => {
    if (!run) return;
    setBusy('export-docx');
    setError(null);
    try {
      const token = await getAccessToken();
      const res = await fetch(`/api/tools/email-sequence-v2/runs/${run.id}/values-export?format=docx`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(data?.error ?? `Error ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Ценности ${run.company_name ?? 'компании'}.docx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка');
    } finally {
      setBusy(null);
    }
  }, [run]);

  const downloadValuesPdf = useCallback(() => {
    if (!run?.values_text) return;
    const html = `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><title>Ценности ${run.company_name ?? ''}</title>
<style>
  @page { size: A4; margin: 18mm 16mm; }
  body { font-family: Arial, Helvetica, sans-serif; color: #111; line-height: 1.45; font-size: 12pt; }
  h1 { font-size: 18pt; margin: 0 0 12pt; }
  pre { white-space: pre-wrap; word-wrap: break-word; font-family: inherit; font-size: 12pt; }
  .meta { color: #666; font-size: 10pt; margin-bottom: 16pt; }
</style></head><body>
<h1>Ценности ${escapeHtml(run.company_name ?? '')}</h1>
<div class="meta">Сгенерировано инструментом «Цепочки писем 2.0»</div>
<pre>${escapeHtml(run.values_text)}</pre>
<script>window.onload = () => { setTimeout(() => window.print(), 250); };</script>
</body></html>`;
    const w = window.open('', '_blank', 'noopener,noreferrer');
    if (!w) {
      setError('Браузер заблокировал всплывающее окно. Разрешите всплывающие окна для этого сайта.');
      return;
    }
    w.document.open();
    w.document.write(html);
    w.document.close();
  }, [run]);

  const stage1Done = Boolean(run?.values_text);
  const stage2Done = Boolean(run?.segment_text);
  const stage3Done = letters.length > 0;

  const filteredLetters = useMemo(() => letters.slice().sort((a, b) => a.letter_index - b.letter_index), [letters]);

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-3">
          <h1 className={clientMode ? 'text-2xl font-bold m-0' : 'text-2xl font-bold text-gray-900'} style={clientMode ? { color: 'var(--cp-paper)' } : undefined}>Цепочки писем 2.0</h1>
        </div>
        <p className={clientMode ? 'mt-1 text-sm' : 'text-sm text-gray-500 mt-1'} style={clientMode ? { color: 'var(--cp-paper-mute)' } : undefined}>
          Загрузите бриф → получите ценности → опишите сегмент и правки → сгенерируйте цепочку и доредактируйте письма.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <StageBadge index={1} label="Бриф → Ценности" active={!stage1Done} done={stage1Done} clientMode={clientMode} />
        <span className={clientMode ? '' : 'text-gray-300'} style={clientMode ? { color: 'var(--cp-paper-faint)' } : undefined}>→</span>
        <StageBadge index={2} label="Сегмент + правки" active={stage1Done && !stage2Done} done={stage2Done} clientMode={clientMode} />
        <span className={clientMode ? '' : 'text-gray-300'} style={clientMode ? { color: 'var(--cp-paper-faint)' } : undefined}>→</span>
        <StageBadge index={3} label="Генерация цепочки" active={stage1Done && stage2Done && !stage3Done} done={stage3Done} clientMode={clientMode} />
      </div>

      {clientMode ? (
        <div className="rounded-md px-4 py-3 text-sm" style={{ background: 'var(--cp-surface-rest)', border: '1px solid var(--cp-divider)', color: 'var(--cp-paper-mute)' }}>
          <ClientTariffUsageInline
            metric="max_chains_per_month"
            spent={stage3Done ? 1 : undefined}
            unit="цепочек"
            refreshKey={`${run?.id ?? 'new'}:${run?.status ?? 'none'}:${letters.length}`}
          />
        </div>
      ) : null}

      {error ? (
        <div
          className={clientMode ? 'rounded-md px-4 py-3 text-sm' : 'rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700'}
          style={clientMode ? { border: '1px solid var(--cp-red)', color: 'var(--cp-red)' } : undefined}
        >
          {error}
        </div>
      ) : null}
      {notice ? (
        <div
          className={clientMode ? 'rounded-md px-4 py-3 text-sm' : 'rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800'}
          style={clientMode ? { border: '1px solid var(--cp-divider-strong)', color: 'var(--cp-green)' } : undefined}
        >
          {notice}
        </div>
      ) : null}

      {/* Top: actions + recent runs */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className={clientMode ? 'xl:col-span-2 neu-card p-6' : 'xl:col-span-2 rounded-2xl border border-gray-200 bg-white p-6'}>
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className={clientMode ? 'text-base font-semibold m-0' : 'text-lg font-semibold text-gray-900'} style={clientMode ? { color: 'var(--cp-paper)' } : undefined}>Запуск</h2>
              <p className={clientMode ? 'mt-1 text-sm' : 'text-sm text-gray-500 mt-1'} style={clientMode ? { color: 'var(--cp-paper-mute)' } : undefined}>
                {run ? (
                  <>
                    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold mr-2 ${statusClasses(run.status, clientMode)}`}>
                      {statusLabel(run.status)}
                    </span>
                    {run.company_name ?? '—'} · создан {formatDate(run.created_at)}
                  </>
                ) : 'Создайте новый запуск или выберите справа.'}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {run && (
                <button
                  type="button"
                  onClick={deleteRun}
                  disabled={busy != null}
                  className={clientMode ? 'ds-btn-ghost inline-flex items-center text-xs text-[var(--cp-red)] disabled:opacity-40' : 'inline-flex items-center rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50'}
                >
                  Удалить запуск
                </button>
              )}
              <button
                type="button"
                onClick={resetForNewRun}
                disabled={busy != null || !run}
                className={clientMode ? 'ds-btn-ghost inline-flex items-center text-xs disabled:opacity-40' : 'inline-flex items-center rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50'}
              >
                Закрыть
              </button>
              <button
                type="button"
                onClick={createRun}
                disabled={busy != null}
                className={clientMode ? 'ds-btn-primary inline-flex items-center disabled:opacity-40' : 'inline-flex items-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50'}
              >
                {busy === 'creating' ? 'Создание…' : 'Новый запуск'}
              </button>
            </div>
          </div>

          {!run && (
            <div
              className={clientMode ? 'mt-5 rounded-md p-6 text-sm' : 'mt-5 rounded-xl border border-dashed border-gray-300 bg-gray-50 p-6 text-sm text-gray-600'}
              style={clientMode ? { border: '1px dashed var(--cp-divider-strong)', color: 'var(--cp-paper-mute)' } : undefined}
            >
              Нажмите «Новый запуск», чтобы начать. Все данные сохраняются автоматически и доступны в правом списке.
            </div>
          )}
        </div>

        <div className={clientMode ? 'neu-card p-6 flex flex-col' : 'rounded-2xl border border-gray-200 bg-white p-6 flex flex-col'}>
          <h2 className={clientMode ? 'text-base font-semibold m-0' : 'text-lg font-semibold text-gray-900'} style={clientMode ? { color: 'var(--cp-paper)' } : undefined}>Последние запуски</h2>
          <p className={clientMode ? 'mt-1 text-xs' : 'text-sm text-gray-500 mt-1'} style={clientMode ? { color: 'var(--cp-paper-mute)' } : undefined}>Топ-30.</p>
          <div className="mt-4 space-y-2 max-h-[320px] overflow-y-auto pr-1">
            {runs.length ? (
              runs.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => loadRun(r.id).catch((e) => setError(e instanceof Error ? e.message : 'Ошибка'))}
                  className={clientMode
                    ? 'w-full text-left rounded-md border px-3 py-2 text-sm transition'
                    : `w-full text-left rounded-xl border px-3 py-2 text-sm transition ${
                        run?.id === r.id ? 'border-blue-200 bg-blue-50' : 'border-gray-200 bg-white hover:bg-gray-50'
                      }`}
                  style={clientMode
                    ? run?.id === r.id
                      ? { background: 'var(--cp-surface-active)', borderColor: 'var(--cp-paper-faint)' }
                      : { background: 'var(--cp-surface-rest)', borderColor: 'var(--cp-divider)' }
                    : undefined}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className={clientMode ? 'font-medium truncate' : 'font-medium text-gray-900 truncate'} style={clientMode ? { color: 'var(--cp-paper)' } : undefined}>{r.company_name ?? r.id.slice(0, 8)}</div>
                    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold shrink-0 ${statusClasses(r.status, clientMode)}`}>
                      {statusLabel(r.status)}
                    </span>
                  </div>
                  <div className="mt-1 text-xs truncate" style={clientMode ? { color: 'var(--cp-paper-faint)' } : undefined}>
                    <span className={clientMode ? '' : 'text-gray-500'}>{formatDate(r.created_at)}</span>
                  </div>
                </button>
              ))
            ) : (
              <div className="text-sm" style={clientMode ? { color: 'var(--cp-paper-faint)' } : undefined}>
                <span className={clientMode ? '' : 'text-gray-500'}>Пока пусто.</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {run && (
        <>
          {/* Stage 1 */}
          <Section
            clientMode={clientMode}
            title="Этап 1. Бриф → Ценности продукта"
            subtitle="Загрузите PDF/DOCX-бриф (или вставьте текст). AI извлечёт УТП, преимущества, акции, социальные доказательства."
            right={
              <div className="flex items-end gap-3">
                <label className="block">
                  <div className={clientMode ? 'ds-eyebrow mb-1' : 'text-xs font-medium text-gray-600 mb-1'}>Модель ценностей</div>
                  <select
                    value={valuesModel}
                    onChange={(e) => setValuesModel(e.target.value)}
                    disabled={busy != null}
                    className={clientMode ? 'ds-input' : 'rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400'}
                  >
                    {VALUES_MODEL_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </label>
              </div>
            }
          >
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <div className="space-y-3">
                <div className={clientMode ? 'rounded-md p-4' : 'rounded-xl border border-dashed border-gray-300 bg-gray-50 p-4'} style={clientMode ? { border: '1px solid var(--cp-divider)', background: 'var(--cp-ink)' } : undefined}>
                  <div className={clientMode ? 'text-sm font-medium mb-2' : 'text-sm font-medium text-gray-900 mb-2'} style={clientMode ? { color: 'var(--cp-paper)' } : undefined}>Бриф</div>
                  {/* Three-way input mode: 'saved' (auto-loaded from
                      /client/brief), 'file' (PDF/DOCX upload), 'text'
                      (paste). Default = 'saved' when saved brief is
                      available, else 'file'. */}
                  <div className={clientMode ? 'mb-3 flex gap-1 rounded-md p-0.5 text-xs' : 'mb-3 flex gap-1 rounded-lg bg-gray-100 p-1 text-xs'} style={clientMode ? { background: 'var(--cp-surface-rest)', border: '1px solid var(--cp-divider)' } : undefined}>
                    {savedBriefAvailable && (
                      <button
                        type="button"
                        onClick={() => setBriefInputMode('saved')}
                        className={clientMode
                          ? `flex-1 rounded px-3 py-1.5 font-medium transition-colors ${briefInputMode === 'saved' ? 'bg-[var(--cp-paper)] text-[var(--cp-ink)]' : 'text-[var(--cp-paper-mute)]'}`
                          : `flex-1 rounded-md px-3 py-1.5 font-medium transition-colors ${
                              briefInputMode === 'saved'
                                ? 'bg-white text-gray-900 shadow-sm'
                                : 'text-gray-600 hover:text-gray-900'
                            }`}
                      >
                        Сохранённый бриф
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setBriefInputMode('file')}
                      className={clientMode
                        ? `flex-1 rounded px-3 py-1.5 font-medium transition-colors ${briefInputMode === 'file' ? 'bg-[var(--cp-paper)] text-[var(--cp-ink)]' : 'text-[var(--cp-paper-mute)]'}`
                        : `flex-1 rounded-md px-3 py-1.5 font-medium transition-colors ${
                            briefInputMode === 'file'
                              ? 'bg-white text-gray-900 shadow-sm'
                              : 'text-gray-600 hover:text-gray-900'
                          }`}
                    >
                      Файл
                    </button>
                    <button
                      type="button"
                      onClick={() => setBriefInputMode('text')}
                      className={clientMode
                        ? `flex-1 rounded px-3 py-1.5 font-medium transition-colors ${briefInputMode === 'text' ? 'bg-[var(--cp-paper)] text-[var(--cp-ink)]' : 'text-[var(--cp-paper-mute)]'}`
                        : `flex-1 rounded-md px-3 py-1.5 font-medium transition-colors ${
                            briefInputMode === 'text'
                              ? 'bg-white text-gray-900 shadow-sm'
                              : 'text-gray-600 hover:text-gray-900'
                          }`}
                    >
                      Текст
                    </button>
                  </div>

                  {briefInputMode === 'saved' && savedBriefAvailable && (
                    <div>
                      <div className="text-xs text-gray-500 mb-2">
                        Используем ваш бриф с портала (
                        <a href="/client/brief" className="underline">страница «Бриф»</a>
                        ). Чтобы AI пересобрал ценности после изменений — отредактируйте там и запустите этот шаг снова.
                      </div>
                      <textarea
                        value={savedBriefText}
                        readOnly
                        rows={8}
                        className={clientMode ? 'ds-input w-full' : 'w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700'}
                        style={clientMode ? { color: 'var(--cp-paper-mute)' } : undefined}
                      />
                    </div>
                  )}

                  {briefInputMode === 'file' && (
                    <div>
                      <input
                        ref={briefInputRef}
                        type="file"
                        accept=".pdf,.docx,.txt"
                        onChange={(e) => setBriefFile(e.target.files?.[0] ?? null)}
                        className={clientMode ? 'block w-full text-sm text-[var(--cp-paper-mute)] file:mr-3 file:rounded-md file:border-0 file:bg-[var(--cp-paper)] file:px-3 file:py-2 file:text-sm file:font-semibold file:text-[var(--cp-ink)]' : 'block w-full text-sm text-gray-700 file:mr-3 file:rounded-lg file:border-0 file:bg-blue-600 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-blue-700'}
                      />
                      {briefFile && (
                        <div className="mt-2 text-xs text-gray-600">
                          {briefFile.name} · {(briefFile.size / 1024).toFixed(1)} KB
                        </div>
                      )}
                      {run.brief_file_name && !briefFile && (
                        <div className="mt-2 text-xs text-gray-600">
                          Текущий бриф: <span className="font-medium">{run.brief_file_name}</span>
                        </div>
                      )}
                    </div>
                  )}

                  {briefInputMode === 'text' && (
                    <textarea
                      value={briefText}
                      onChange={(e) => setBriefText(e.target.value)}
                      rows={8}
                      placeholder="Вставьте текст брифа сюда"
                      className={clientMode ? 'ds-input w-full' : 'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400'}
                    />
                  )}

                  <div className="mt-3 flex items-center justify-end">
                    <button
                      type="button"
                      onClick={extractValues}
                      disabled={
                        busy != null ||
                        (briefInputMode === 'file' && !briefFile) ||
                        (briefInputMode === 'text' && !briefText.trim()) ||
                        (briefInputMode === 'saved' && !savedBriefText.trim())
                      }
                      className={clientMode ? 'ds-btn-primary inline-flex items-center disabled:opacity-40' : 'inline-flex items-center rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50'}
                    >
                      {busy === 'extracting-values' ? 'Извлечение…' : 'Отправить → выделить ценности'}
                    </button>
                  </div>
                </div>
              </div>

              <div className="space-y-3">
                <div className={clientMode ? 'rounded-md p-4 max-h-[420px] overflow-auto' : 'rounded-xl border border-gray-200 bg-gray-50 p-4 max-h-[420px] overflow-auto'} style={clientMode ? { border: '1px solid var(--cp-divider)', background: 'var(--cp-ink)' } : undefined}>
                  <div className="flex items-center justify-between">
                    <div className={clientMode ? 'text-sm font-medium' : 'text-sm font-medium text-gray-900'} style={clientMode ? { color: 'var(--cp-paper)' } : undefined}>
                      Ценности {run.company_name ? <span className={clientMode ? '' : 'text-gray-500'} style={clientMode ? { color: 'var(--cp-paper-faint)' } : undefined}>({run.company_name})</span> : null}
                    </div>
                    <div className="flex items-center gap-2">
                      {run.values_text && (
                        <>
                          <button
                            type="button"
                            onClick={downloadValuesDocx}
                            disabled={busy != null}
                            className={clientMode ? 'ds-btn-ghost inline-flex items-center text-xs disabled:opacity-40' : 'inline-flex items-center rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50'}
                          >
                            {busy === 'export-docx' ? 'Готовим…' : 'Скачать DOCX'}
                          </button>
                          <button
                            type="button"
                            onClick={downloadValuesPdf}
                            disabled={busy != null}
                            className={clientMode ? 'ds-btn-ghost inline-flex items-center text-xs disabled:opacity-40' : 'inline-flex items-center rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50'}
                          >
                            Скачать PDF
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  <pre className={clientMode ? 'mt-3 whitespace-pre-wrap text-sm ds-mono leading-relaxed' : 'mt-3 whitespace-pre-wrap text-sm text-gray-800 font-mono leading-relaxed'} style={clientMode ? { color: 'var(--cp-paper-mute)' } : undefined}>
                    {run.values_text ?? '— ещё не сгенерировано —'}
                  </pre>
                </div>
              </div>
            </div>
          </Section>

          {/* Stage 2 */}
          <Section
            clientMode={clientMode}
            title="Этап 2. Сегмент базы и правки заказчика"
            subtitle="Опишите гипотезу, по которой собрана база, и любые правки/уточнения от заказчика. Опционально — операторы персонализации."
          >
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <label className="block">
                <div className={clientMode ? 'ds-eyebrow mb-1' : 'text-sm font-medium text-gray-700 mb-1'}>Сегмент базы (по гипотезе)*</div>
                <textarea
                  value={segmentText}
                  onChange={(e) => setSegmentText(e.target.value)}
                  rows={8}
                  placeholder={'Например: Сборщик рекламных конструкций, Макетчик наружной рекламы, Дизайнер-конструктор, Оператор 3D-печати. Регионы: РФ, СФО, Забайкальский край…'}
                  className={clientMode ? 'ds-input w-full' : 'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400'}
                />
              </label>
              <label className="block">
                <div className={clientMode ? 'ds-eyebrow mb-1' : 'text-sm font-medium text-gray-700 mb-1'}>Правки от заказчика</div>
                <textarea
                  value={customerEdits}
                  onChange={(e) => setCustomerEdits(e.target.value)}
                  rows={8}
                  placeholder={'Триггеры для ЛПР, страхи которые нужно закрыть, специальные предложения, цены…'}
                  className={clientMode ? 'ds-input w-full' : 'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400'}
                />
              </label>
              <label className="lg:col-span-2 block">
                <div className={clientMode ? 'ds-eyebrow mb-1' : 'text-sm font-medium text-gray-700 mb-1'}>Операторы для персонализации (опционально)</div>
                <textarea
                  value={personalizationOps}
                  onChange={(e) => setPersonalizationOps(e.target.value)}
                  rows={5}
                  placeholder={'Например:\n- {{companyName}}\n- {{firstName}}\n- {{Personalization}}\n- {% if last_email_opened %}…{% else %}…{% endif %}'}
                  className={clientMode ? 'ds-input ds-mono w-full' : 'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400'}
                />
              </label>
            </div>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={saveStage2}
                disabled={busy != null || !segmentText.trim()}
                className={clientMode ? 'ds-btn-primary inline-flex items-center disabled:opacity-40' : 'inline-flex items-center rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-900 hover:bg-gray-50 disabled:opacity-50'}
              >
                {busy === 'saving-stage-2' ? 'Сохранение…' : 'Сохранить этап 2'}
              </button>
            </div>
          </Section>

          {/* Stage 3 */}
          <Section
            clientMode={clientMode}
            title="Этап 3. Генерация и редактор цепочки"
            subtitle="Модель сгенерирует 3–5 коротких писем по брифу, ценностям, сегменту и регламенту. Письма можно править, удалять и добавлять свои."
            right={
              <div className="flex items-end gap-3">
                <label className="block">
                  <div className={clientMode ? 'ds-eyebrow mb-1' : 'text-xs font-medium text-gray-600 mb-1'}>Язык цепочки</div>
                  <select
                    value={outputLanguage}
                    onChange={(e) => changeLanguage(e.target.value as EmailSequenceV2OutputLanguage)}
                    disabled={busy != null}
                    className={clientMode ? 'ds-input disabled:opacity-40' : 'rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400 disabled:opacity-50'}
                  >
                    {LANGUAGE_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <div className={clientMode ? 'ds-eyebrow mb-1' : 'text-xs font-medium text-gray-600 mb-1'}>Модель писем</div>
                  <select
                    value={writerModel}
                    onChange={(e) => setWriterModel(e.target.value)}
                    disabled={busy != null}
                    className={clientMode ? 'ds-input' : 'rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400'}
                  >
                    {WRITER_MODEL_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  onClick={generateLetters}
                  disabled={busy != null || !run.values_text || !segmentText.trim()}
                  className={clientMode ? 'ds-btn-primary inline-flex items-center disabled:opacity-40' : 'inline-flex items-center rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-800 disabled:opacity-50'}
                >
                  {busy === 'generating-letters' ? 'Генерация…' : letters.length ? 'Перегенерировать цепочку' : 'Сгенерировать цепочку'}
                </button>
              </div>
            }
          >
            {busy === 'generating-letters' && (
              <div
                className={clientMode ? 'rounded-md px-4 py-3 text-sm mb-4' : 'rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800 mb-4'}
                style={clientMode ? { background: 'var(--cp-surface-rest)', border: '1px solid var(--cp-divider)', color: 'var(--cp-paper-mute)' } : undefined}
              >
                Модель пишет цепочку. Это занимает 2–4 минуты — не закрывайте вкладку.
              </div>
            )}
            {filteredLetters.length === 0 ? (
              <div
                className={clientMode ? 'rounded-md p-6 text-sm' : 'rounded-xl border border-dashed border-gray-300 bg-gray-50 p-6 text-sm text-gray-600'}
                style={clientMode ? { border: '1px dashed var(--cp-divider-strong)', color: 'var(--cp-paper-mute)' } : undefined}
              >
                Цепочка ещё не сгенерирована. Заполните этапы 1 и 2, затем нажмите «Сгенерировать цепочку».
              </div>
            ) : (
              <div className="space-y-4">
                {filteredLetters.map((l, idx) => (
                  <LetterCard
                    key={l.id}
                    letter={l}
                    busy={busy}
                    onSave={saveLetter}
                    onDelete={deleteLetter}
                    onInsertAfter={insertLetterAfter}
                    isLast={idx === filteredLetters.length - 1}
                    clientMode={clientMode}
                  />
                ))}
                <div className="flex items-center justify-end">
                  <button
                    type="button"
                    onClick={addLetterAtEnd}
                    disabled={busy != null}
                    className="inline-flex items-center rounded-xl border border-dashed border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                  >
                    + добавить письмо
                  </button>
                </div>
              </div>
            )}
          </Section>
        </>
      )}
    </div>
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
