'use client';

/**
 * «Цепочки писем 2.0» — мастер из трёх шагов (редизайн 06.07.2026 по макетам):
 *
 *   1. Продукт   — бриф (портал/файл/текст) → «Что мы выделили» (чипы ценностей)
 *   2. Аудитория — кому пишем + пожелания заказчика
 *   3. Письма    — master-detail редактор цепочки + «Отправить в рассылку»
 *
 * Справа — «Последние запуски» и «Новый запуск». Бэкенд-этапы прежние
 * (extract-values → PATCH run → generate-letters); поменялась только рамка UX.
 *
 * «Отправить в рассылку» (только clientMode): пишет цепочку в черновик мастера
 * запуска (CLIENT_LAUNCH_DRAFT_KEY) и уводит на /client/launch — там клиент
 * выбирает базу (файл или прогон Конструктора) и запускает кампанию.
 *
 * Компонент общий для двух кабинетов: clientMode=true — тёмные cp-токены
 * клиентского портала, false — светлая админская тема /tools.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Plus, Copy, Trash2, ChevronLeft, ChevronRight, FileText, X, Loader2, Send, RefreshCw, Check,
} from 'lucide-react';
import { authFetch, authFetchJson, getAccessToken } from '@/lib/authFetch';
import type { EmailSequenceV2LetterRow, EmailSequenceV2OutputLanguage, EmailSequenceV2RunRow } from '@/types';
import { ClientTariffUsageInline } from '@/components/client/ClientTariffUsageInline';
import { parseValuesChips } from '@/lib/emailSequenceV2/valuesChips';
import {
  decideLetterExit,
  LETTER_EXIT_MESSAGE,
  type LetterExitIntent,
} from '@/lib/emailSequenceV2/letterDirtyGuard';
import { CLIENT_LAUNCH_DRAFT_KEY } from '@/lib/clientLaunch/constants';
import { buildSequenceHandoffSteps } from '@/lib/clientLaunch/sequenceHandoff';

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

/** Русская словоформа «день/дня/дней». */
function daysWord(n: number): string {
  const abs = Math.abs(n) % 100;
  const d = abs % 10;
  if (abs > 10 && abs < 20) return 'дней';
  if (d === 1) return 'день';
  if (d >= 2 && d <= 4) return 'дня';
  return 'дней';
}

/** Подпись отправки в списке писем: кумулятивная сумма gap'ов до письма idx. */
function delayLabel(letters: EmailSequenceV2LetterRow[], idx: number): string {
  if (idx === 0) return 'Сразу';
  let total = 0;
  for (let i = 1; i <= idx; i += 1) total += Math.max(0, letters[i]?.wait_days ?? 2);
  return total === 0 ? 'Сразу' : `через ${total} ${daysWord(total)}`;
}

/* ─────────────────────────── Стилевые токены ─────────────────────────── */

function makeUi(clientMode: boolean) {
  return {
    card: clientMode ? 'neu-card' : 'rounded-2xl border border-gray-200 bg-white',
    cardInner: clientMode ? 'rounded-md' : 'rounded-xl border border-gray-200 bg-gray-50',
    cardInnerStyle: clientMode ? { border: '1px solid var(--cp-divider)', background: 'var(--cp-surface-rest)' } as React.CSSProperties : undefined,
    heading: clientMode ? 'text-base font-semibold m-0 text-[var(--cp-paper)]' : 'text-lg font-semibold text-gray-900',
    sub: clientMode ? 'mt-1 text-xs text-[var(--cp-paper-mute)]' : 'text-sm text-gray-500 mt-1',
    eyebrow: clientMode ? 'ds-eyebrow mb-1' : 'text-xs font-medium text-gray-600 mb-1',
    input: clientMode ? 'ds-input w-full' : 'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400',
    select: clientMode ? 'ds-input' : 'rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400',
    ghostBtn: clientMode ? 'ds-btn-ghost inline-flex items-center gap-1.5 text-xs disabled:opacity-40' : 'inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50',
    primaryBtn: clientMode ? 'ds-btn-primary inline-flex items-center gap-2 disabled:opacity-40' : 'inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50',
    dashedBtn: clientMode
      ? 'w-full rounded-md px-3 py-2.5 text-sm font-medium text-[var(--cp-paper-mute)] border border-dashed border-[var(--cp-divider-strong)] hover:text-[var(--cp-paper)] disabled:opacity-40 inline-flex items-center justify-center gap-1.5'
      : 'w-full rounded-xl border border-dashed border-gray-300 bg-white px-3 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 inline-flex items-center justify-center gap-1.5',
    text: (clientMode ? { color: 'var(--cp-paper)' } : { color: '#111827' }) as React.CSSProperties,
    mute: (clientMode ? { color: 'var(--cp-paper-mute)' } : { color: '#6b7280' }) as React.CSSProperties,
    faint: (clientMode ? { color: 'var(--cp-paper-faint)' } : { color: '#9ca3af' }) as React.CSSProperties,
    // .ds-mono активен только внутри .client-portal — в админской теме нужен font-mono.
    mono: clientMode ? 'ds-mono' : 'font-mono',
    chip: clientMode
      ? 'inline-flex items-center rounded-md px-2.5 py-1 text-xs border border-[var(--cp-divider)] bg-[var(--cp-surface-rest)] text-[var(--cp-paper)]'
      : 'inline-flex items-center rounded-md px-2.5 py-1 text-xs border border-gray-200 bg-gray-50 text-gray-800',
  };
}
type Ui = ReturnType<typeof makeUi>;

/* ────────────────────────────── Степпер ────────────────────────────── */

const WIZARD_STEPS: Array<{ label: string; sub: string }> = [
  { label: 'Продукт', sub: 'О чём письма' },
  { label: 'Аудитория', sub: 'Кому пишем' },
  { label: 'Письма', sub: 'Цепочка' },
];

function Stepper({ current, maxReachable, onGo, clientMode }: {
  current: number;
  maxReachable: number;
  onGo: (i: number) => void;
  clientMode: boolean;
}) {
  return (
    <div className="flex items-center gap-3">
      {WIZARD_STEPS.map((s, i) => {
        const done = i < current;
        const active = i === current;
        const reachable = i <= maxReachable;
        return (
          <div key={s.label} className={`flex items-center gap-3 ${i > 0 ? 'flex-1' : ''}`}>
            {i > 0 && (
              <div
                className="h-px flex-1"
                style={{ background: clientMode ? (done || active ? 'var(--cp-paper-faint)' : 'var(--cp-divider)') : done || active ? '#9ca3af' : '#e5e7eb' }}
                aria-hidden
              />
            )}
            <button
              type="button"
              onClick={() => reachable && onGo(i)}
              disabled={!reachable}
              className="flex items-center gap-2.5 shrink-0 disabled:cursor-not-allowed"
            >
              <span
                className="inline-flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold"
                style={clientMode
                  ? {
                      background: done ? 'var(--cp-paper)' : active ? 'var(--cp-surface-active)' : 'transparent',
                      border: '1px solid var(--cp-divider-strong)',
                      color: done ? 'var(--cp-ink)' : active ? 'var(--cp-paper)' : 'var(--cp-paper-faint)',
                    }
                  : {
                      background: done ? '#111827' : active ? '#e5e7eb' : 'transparent',
                      border: '1px solid #d1d5db',
                      color: done ? '#fff' : active ? '#111827' : '#9ca3af',
                    }}
              >
                {done ? <Check className="h-4 w-4" aria-hidden /> : i + 1}
              </span>
              <span className="text-left">
                <span
                  className="block text-sm font-semibold leading-tight"
                  style={clientMode ? { color: done || active ? 'var(--cp-paper)' : 'var(--cp-paper-faint)' } : { color: done || active ? '#111827' : '#9ca3af' }}
                >
                  {s.label}
                </span>
                <span className="block text-xs leading-tight" style={clientMode ? { color: 'var(--cp-paper-faint)' } : { color: '#9ca3af' }}>
                  {s.sub}
                </span>
              </span>
            </button>
          </div>
        );
      })}
    </div>
  );
}

/* ─────────────────────── Чипы «Что мы выделили» ─────────────────────── */

function ValuesChips({ valuesText, ui }: { valuesText: string; ui: Ui }) {
  const [showRaw, setShowRaw] = useState(false);
  const groups = useMemo(() => parseValuesChips(valuesText), [valuesText]);

  if (!groups || showRaw) {
    return (
      <div>
        {groups && (
          <button type="button" onClick={() => setShowRaw(false)} className={`${ui.ghostBtn} mb-2`}>
            ← Показать карточками
          </button>
        )}
        <pre className={`whitespace-pre-wrap text-sm ${ui.mono} leading-relaxed m-0`} style={ui.mute}>
          {valuesText}
        </pre>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {groups.map((g) => (
        <div key={g.key}>
          <div className={ui.eyebrow}>{g.title}</div>
          <div className="flex flex-wrap gap-1.5">
            {g.items.map((item) => (
              <span key={item} className={ui.chip} title={item}>{item}</span>
            ))}
          </div>
        </div>
      ))}
      <button type="button" onClick={() => setShowRaw(true)} className={ui.ghostBtn}>
        Показать полный текст
      </button>
    </div>
  );
}

/* ───────────────────────── Редактор письма ───────────────────────── */

function LetterEditor({
  letter,
  delayCaption,
  busy,
  onSave,
  onDelete,
  onDirtyChange,
  ui,
  clientMode,
}: {
  letter: EmailSequenceV2LetterRow;
  delayCaption: string;
  busy: Busy;
  onSave: (id: string, patch: { subject: string; body: string; wait_days: number }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  /** Репорт наверх (в ref-реестр родителя) о несохранённых правках. */
  onDirtyChange: (id: string, dirty: boolean) => void;
  ui: Ui;
  clientMode: boolean;
}) {
  // Сбрасываем локальное состояние формы, когда меняется содержимое письма
  // на сервере (после Save/регенерации/переключения письма). Ленивая
  // инициализация без useEffect (правило react-hooks/set-state-in-effect).
  const versionKey = `${letter.id}|${letter.subject ?? ''}|${letter.body ?? ''}|${letter.wait_days}|${letter.updated_at}`;
  const [storedVersionKey, setStoredVersionKey] = useState(versionKey);
  const [subject, setSubject] = useState(letter.subject ?? '');
  const [body, setBody] = useState(letter.body ?? '');
  const [waitDays, setWaitDays] = useState<number>(letter.wait_days ?? 2);
  const [dirty, setDirty] = useState(false);
  if (storedVersionKey !== versionKey) {
    setStoredVersionKey(versionKey);
    setSubject(letter.subject ?? '');
    setBody(letter.body ?? '');
    setWaitDays(letter.wait_days ?? 2);
    setDirty(false);
    // Мутация ref родителя во время рендера безопасна (не setState).
    onDirtyChange(letter.id, false);
  }

  const markDirty = () => {
    setDirty(true);
    onDirtyChange(letter.id, true);
  };

  const isSaving = busyEquals(busy, { type: 'letter', action: 'save', id: letter.id });
  const isDeleting = busyEquals(busy, { type: 'letter', action: 'delete', id: letter.id });
  const isFirst = letter.letter_index === 1;

  return (
    <div className={`${ui.cardInner} p-4 sm:p-5`} style={ui.cardInnerStyle}>
      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap">
          <span
            className="inline-flex items-center rounded-md px-2.5 py-1 text-xs font-bold"
            style={clientMode ? { background: 'var(--cp-paper)', color: 'var(--cp-ink)' } : { background: '#111827', color: '#fff' }}
          >
            Письмо {letter.letter_index}
          </span>
          {isFirst ? (
            <span className="text-xs" style={ui.mute}>Отправка: сразу</span>
          ) : (
            <label className="inline-flex items-center gap-1.5 text-xs" style={ui.mute}>
              Отправка: через
              <input
                type="number"
                min={0}
                max={90}
                value={waitDays}
                onChange={(e) => {
                  const v = Math.min(90, Math.max(0, Math.trunc(Number(e.target.value) || 0)));
                  setWaitDays(v);
                  markDirty();
                }}
                className={clientMode ? 'ds-input w-16 text-center' : 'w-16 rounded-lg border border-gray-300 px-2 py-1 text-sm text-center'}
              />
              {daysWord(waitDays)} после предыдущего
            </label>
          )}
          <span className="text-xs" style={ui.faint}>({delayCaption} от старта)</span>
          {letter.is_user_added && (
            <span
              className="inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-semibold"
              style={clientMode
                ? { background: 'var(--cp-surface-elev)', border: '1px solid var(--cp-divider)', color: 'var(--cp-paper-mute)' }
                : { background: '#eff6ff', border: '1px solid #bfdbfe', color: '#1d4ed8' }}
            >
              добавлено вручную
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => navigator.clipboard.writeText(`${subject ? `Тема: ${subject}\n\n` : ''}${body}`)}
            className={ui.ghostBtn}
            title="Скопировать письмо"
            aria-label="Скопировать письмо"
          >
            <Copy className="h-4 w-4" aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => onDelete(letter.id)}
            disabled={busy != null}
            className={ui.ghostBtn}
            style={{ color: clientMode ? 'var(--cp-red)' : '#b91c1c' }}
            title="Удалить письмо"
            aria-label="Удалить письмо"
          >
            {isDeleting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Trash2 className="h-4 w-4" aria-hidden />}
          </button>
        </div>
      </div>

      <label className="block">
        <div className={ui.eyebrow}>Тема письма</div>
        <input
          value={subject}
          onChange={(e) => { setSubject(e.target.value); markDirty(); }}
          placeholder="Тема письма"
          className={ui.input}
        />
      </label>
      <label className="mt-3 block">
        <div className={ui.eyebrow}>Текст письма</div>
        <textarea
          value={body}
          onChange={(e) => { setBody(e.target.value); markDirty(); }}
          rows={Math.min(20, Math.max(8, body.split('\n').length + 1))}
          className={`${ui.input} ${ui.mono} leading-relaxed`}
        />
      </label>
      <div className="mt-3 flex items-center justify-between gap-3">
        <span className="text-xs" style={ui.faint}>Обновлено: {formatDate(letter.updated_at)}</span>
        <button
          type="button"
          onClick={() => onSave(letter.id, { subject, body, wait_days: isFirst ? 0 : waitDays })}
          disabled={!dirty || busy != null}
          className={ui.primaryBtn}
        >
          {isSaving ? 'Сохранение…' : dirty ? 'Сохранить' : 'Сохранено'}
        </button>
      </div>
    </div>
  );
}

/* ────────────────────────── Основной компонент ────────────────────────── */

export function EmailSequenceV2View({ clientMode = false }: { clientMode?: boolean } = {}) {
  const router = useRouter();
  const ui = useMemo(() => makeUi(clientMode), [clientMode]);

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
  // Сохранённый бриф из портала: client мог уже заполнить /client/brief —
  // предлагаем его автоматически (см. эффект ниже).
  const [savedBriefText, setSavedBriefText] = useState<string>('');
  const [savedBriefAvailable, setSavedBriefAvailable] = useState<boolean>(false);
  const [briefInputMode, setBriefInputMode] = useState<'saved' | 'file' | 'text'>('file');
  const [segmentText, setSegmentText] = useState<string>('');
  const [customerEdits, setCustomerEdits] = useState<string>('');
  const [personalizationOps, setPersonalizationOps] = useState<string>('');

  // Мастер: текущий шаг + выбранное письмо в master-detail.
  const [step, setStep] = useState<number>(0);
  const [selectedLetterId, setSelectedLetterId] = useState<string | null>(null);

  const briefInputRef = useRef<HTMLInputElement | null>(null);
  const initialLoaded = useRef(false);
  // Реестр писем с несохранёнными правками (репортится из LetterEditor).
  // В один момент смонтирован один редактор, но реестр защищает от потери
  // текста при переключении письма и при «Отправить в рассылку».
  const dirtyLettersRef = useRef<Set<string>>(new Set());
  const markLetterDirty = useCallback((id: string, dirty: boolean) => {
    if (dirty) dirtyLettersRef.current.add(id);
    else dirtyLettersRef.current.delete(id);
  }, []);
  // Единая политика выхода из редактора при несохранённых правках (см.
  // letterDirtyGuard). Возвращает true = продолжать, false = пользователь
  // отменил. Побочно чистит реестр по политике интента.
  const requestLetterExit = useCallback((intent: LetterExitIntent): boolean => {
    const { confirm, clear } = decideLetterExit(intent, dirtyLettersRef.current.size > 0);
    if (confirm && !window.confirm(LETTER_EXIT_MESSAGE[intent])) return false;
    if (clear) dirtyLettersRef.current.clear();
    return true;
  }, []);

  const loadRuns = useCallback(async () => {
    const data = await authFetchJson<{ runs: EmailSequenceV2RunRow[] }>('/api/tools/email-sequence-v2/runs', { method: 'GET' });
    setRuns(data.runs ?? []);
  }, []);

  const loadRun = useCallback(async (runId: string) => {
    const data = await authFetchJson<{ run: EmailSequenceV2RunRow; letters: EmailSequenceV2LetterRow[] }>(
      `/api/tools/email-sequence-v2/runs/${runId}`,
      { method: 'GET' },
    );
    dirtyLettersRef.current.clear(); // серверные данные — источник истины
    setRun(data.run);
    const ls = (data.letters ?? []).slice().sort((a, b) => a.letter_index - b.letter_index);
    setLetters(ls);
    setSegmentText(data.run.segment_text ?? '');
    setCustomerEdits(data.run.customer_edits ?? '');
    setPersonalizationOps(data.run.personalization_operators ?? '');
    setValuesModel(data.run.values_model ?? VALUES_MODEL_OPTIONS[0].value);
    setWriterModel(data.run.writer_model ?? WRITER_MODEL_OPTIONS[0].value);
    setOutputLanguage(data.run.output_language ?? 'ru');
    // Открываем самый дальний осмысленный шаг прогона.
    setStep(ls.length > 0 ? 2 : data.run.values_text ? 1 : 0);
    setSelectedLetterId(ls[0]?.id ?? null);
  }, []);

  useEffect(() => {
    if (initialLoaded.current) return;
    initialLoaded.current = true;
    loadRuns().catch((e) => setError(e instanceof Error ? e.message : 'Ошибка'));
  }, [loadRuns]);

  // Fire-and-forget: сохранённый бриф клиента с /api/client/brief (см. историю:
  // клиент, заполнивший бриф на портале, не должен загружать PDF заново).
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
      dirtyLettersRef.current.clear();
      setSegmentText('');
      setCustomerEdits('');
      setPersonalizationOps('');
      setBriefFile(null);
      setBriefText('');
      setStep(0);
      setSelectedLetterId(null);
      await loadRuns();
      showNotice('Создан новый запуск');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка');
    } finally {
      setBusy(null);
    }
  }, [loadRuns, showNotice, valuesModel, writerModel, outputLanguage]);

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

  const extractValues = useCallback(async () => {
    if (!run) return;
    const effectiveText =
      briefInputMode === 'saved' ? savedBriefText :
      briefInputMode === 'text' ? briefText :
      '';
    const useFileUpload = briefInputMode === 'file' && briefFile != null;
    // Повторная экстракция из УЖЕ загруженного брифа (режим «файл», новый файл
    // не выбран): шлём JSON без text — сервер сам возьмёт run.brief_text.
    const reuseStored =
      briefInputMode === 'file' && !briefFile && Boolean(run.brief_file_name || run.brief_text);
    if (!useFileUpload && !reuseStored && !effectiveText.trim()) {
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
        res = await authFetch(`/api/tools/email-sequence-v2/runs/${run.id}/extract-values`, {
          method: 'POST',
          body: JSON.stringify({ text: effectiveText, model: valuesModel, language: outputLanguage }),
        });
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(data?.error ?? `Error ${res.status}`);
      }
      const data = (await res.json()) as { run: EmailSequenceV2RunRow };
      setRun(data.run);
      setBriefFile(null);
      if (briefInputRef.current) briefInputRef.current.value = '';
      await loadRuns();
      showNotice('Ценности выделены');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка');
    } finally {
      setBusy(null);
    }
  }, [briefFile, briefText, briefInputMode, savedBriefText, loadRuns, run, showNotice, valuesModel, outputLanguage]);

  const saveStage2 = useCallback(async (): Promise<boolean> => {
    if (!run) return false;
    if (!segmentText.trim()) {
      setError('Опишите, кому отправляем письма.');
      return false;
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
      showNotice('Сохранено');
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка');
      return false;
    } finally {
      setBusy(null);
    }
  }, [customerEdits, personalizationOps, run, segmentText, showNotice, writerModel]);

  const generateLetters = useCallback(async () => {
    if (!run) return;
    if (!segmentText.trim()) {
      setError('Сначала опишите аудиторию (шаг 2).');
      return;
    }
    if (!run.values_text) {
      setError('Сначала выделите ценности из брифа (шаг 1).');
      return;
    }
    setBusy('generating-letters');
    setError(null);
    try {
      // Сохраняем шаг 2 перед генерацией, если есть несохранённые изменения.
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
      const ls = (data.letters ?? []).slice().sort((a, b) => a.letter_index - b.letter_index);
      dirtyLettersRef.current.clear();
      setLetters(ls);
      setSelectedLetterId(ls[0]?.id ?? null);
      showNotice(`Цепочка сгенерирована: ${ls.length} писем`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка');
    } finally {
      setBusy(null);
    }
  }, [customerEdits, personalizationOps, run, segmentText, showNotice, writerModel, outputLanguage]);

  const saveLetter = useCallback(
    async (id: string, patch: { subject: string; body: string; wait_days: number }) => {
      if (!run) return;
      setBusy({ type: 'letter', action: 'save', id });
      setError(null);
      try {
        const data = await authFetchJson<{ letter: EmailSequenceV2LetterRow }>(
          `/api/tools/email-sequence-v2/runs/${run.id}/letters/${id}`,
          {
            method: 'PATCH',
            body: JSON.stringify({ subject: patch.subject || null, body: patch.body, wait_days: patch.wait_days }),
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

  // Добавление письма: сразу создаём с заготовкой и открываем в редакторе
  // (раньше — два window.prompt подряд, главный UX-раздражитель инструмента).
  const addLetterAtEnd = useCallback(async () => {
    if (!run) return;
    // loadRun ниже заменит letters серверными строками и очистит реестр —
    // предупреждаем, чтобы не потерять правки открытого письма молча.
    if (!requestLetterExit('addLetter')) return;
    setBusy({ type: 'letter', action: 'add', id: 'new' });
    setError(null);
    try {
      const data = await authFetchJson<{ letter: EmailSequenceV2LetterRow }>(
        `/api/tools/email-sequence-v2/runs/${run.id}/letters`,
        { method: 'POST', body: JSON.stringify({ subject: '', body: 'Здравствуйте!\n\n' }) },
      );
      await loadRun(run.id);
      setStep(2);
      setSelectedLetterId(data.letter.id);
      showNotice('Письмо добавлено — отредактируйте текст');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка');
    } finally {
      setBusy(null);
    }
  }, [loadRun, run, showNotice, requestLetterExit]);

  const deleteRun = useCallback(async () => {
    if (!run) return;
    if (!window.confirm('Удалить весь запуск (с письмами)? Восстановить нельзя.')) return;
    setBusy('deleting-run');
    setError(null);
    try {
      await authFetchJson(`/api/tools/email-sequence-v2/runs/${run.id}`, { method: 'DELETE' });
      setRun(null);
      setLetters([]);
      dirtyLettersRef.current.clear();
      setSegmentText('');
      setCustomerEdits('');
      setPersonalizationOps('');
      setBriefFile(null);
      setBriefText('');
      setStep(0);
      setSelectedLetterId(null);
      await loadRuns();
      showNotice('Запуск удалён');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка');
    } finally {
      setBusy(null);
    }
  }, [loadRuns, run, showNotice]);

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

  // «Отправить в рассылку»: цепочка → черновик мастера запуска → /client/launch.
  const sendToLaunch = useCallback(() => {
    if (!clientMode || letters.length === 0) return;
    // В рассылку уходит СЕРВЕРНОЕ состояние писем — предупреждаем, если в
    // открытом редакторе есть несохранённые правки (иначе уедет старый текст).
    if (!requestLetterExit('sendToLaunch')) return;
    try {
      const existing = window.localStorage.getItem(CLIENT_LAUNCH_DRAFT_KEY);
      if (existing && !window.confirm('В мастере запуска уже есть черновик — заменить его этой цепочкой?')) {
        return;
      }
      // Темы писем → A/B-варианты первого шага; тела фоллоу-апов → отдельные
      // шаги с пустой темой (та же ветка). См. buildSequenceHandoffSteps.
      const steps = buildSequenceHandoffSteps(letters);
      const draft = {
        campaignName: run?.company_name ?? '',
        sequenceSteps: steps,
        activeVariantIdx: steps.map(() => 0),
        savedAt: new Date().toISOString(),
      };
      window.localStorage.setItem(CLIENT_LAUNCH_DRAFT_KEY, JSON.stringify(draft));
    } catch {
      // sandbox/квота — уходим без черновика, клиент вставит вручную
    }
    router.push('/client/launch');
  }, [clientMode, letters, run, router, requestLetterExit]);

  /* ── деривативы ── */
  const stage1Done = Boolean(run?.values_text);
  const stage2Done = Boolean(segmentText.trim());
  const maxReachable = stage1Done ? (stage2Done ? 2 : 1) : 0;

  const selectedLetter = useMemo(
    () => letters.find((l) => l.id === selectedLetterId) ?? letters[0] ?? null,
    [letters, selectedLetterId],
  );
  const selectedIdx = selectedLetter ? letters.findIndex((l) => l.id === selectedLetter.id) : -1;

  const goToStep = useCallback((i: number) => {
    if (i > maxReachable) return;
    // Уход со шага «Письма» размонтирует редактор (его правки теряются) —
    // тихо чистим реестр грязных (политика leaveStep).
    if (step === 2 && i !== 2) requestLetterExit('leaveStep');
    setStep(i);
  }, [maxReachable, step, requestLetterExit]);

  // Переключение письма с защитой от потери несохранённых правок открытого.
  const selectLetter = useCallback((id: string) => {
    if (id === selectedLetterId) return;
    if (!requestLetterExit('switchLetter')) return;
    setSelectedLetterId(id);
  }, [selectedLetterId, requestLetterExit]);

  const nextFromAudience = useCallback(async () => {
    const ok = await saveStage2();
    if (ok) setStep(2);
  }, [saveStage2]);

  /* ─────────────────────────────── Render ─────────────────────────────── */

  return (
    <div className="space-y-5">
      {/* Заголовок + тариф */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <h1 className={clientMode ? 'text-2xl font-bold m-0 text-[var(--cp-paper)]' : 'text-2xl font-bold text-gray-900'}>
          Цепочки писем 2.0
        </h1>
        {clientMode && (
          <div className="rounded-md px-3 py-1.5 text-xs ds-mono" style={{ background: 'var(--cp-surface-rest)', border: '1px solid var(--cp-divider)', color: 'var(--cp-paper-mute)' }}>
            <ClientTariffUsageInline
              metric="max_chains_per_month"
              spent={letters.length > 0 ? 1 : undefined}
              unit="цепочек"
              refreshKey={`${run?.id ?? 'new'}:${run?.status ?? 'none'}:${letters.length}`}
            />
          </div>
        )}
      </div>

      {error ? (
        <div
          className={clientMode ? 'rounded-md px-4 py-3 text-sm' : 'rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700'}
          style={clientMode ? { border: '1px solid var(--cp-red)', color: 'var(--cp-red)' } : undefined}
          role="alert"
        >
          {error}
        </div>
      ) : null}
      {/* Уведомление вне рана (например «Запуск удалён»): inline-версия в
          хедере рана размонтируется вместе с ним. */}
      {notice && !run ? (
        <div
          className={clientMode ? 'rounded-md px-4 py-3 text-sm' : 'rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800'}
          style={clientMode ? { border: '1px solid var(--cp-divider-strong)', color: 'var(--cp-green)' } : undefined}
        >
          {notice}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
        {/* ───── Основная карточка мастера ───── */}
        <div className={`${ui.card} p-5 sm:p-6`}>
          {!run ? (
            <div className="py-14 text-center">
              <p className="text-sm mb-5" style={ui.mute}>
                Создайте запуск: загрузите бриф, опишите аудиторию — и получите готовую цепочку писем.
              </p>
              <button type="button" onClick={createRun} disabled={busy != null} className={ui.primaryBtn}>
                {busy === 'creating' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />}
                Новый запуск
              </button>
            </div>
          ) : (
            <>
              {/* Шапка прогона */}
              <div className="flex items-center justify-between gap-3 flex-wrap mb-5">
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className="text-sm font-bold truncate" style={ui.text}>
                    {run.company_name ?? 'Без названия'}
                  </span>
                  <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold shrink-0 ${statusClasses(run.status, clientMode)}`}>
                    {statusLabel(run.status)}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {notice && (
                    <span className="inline-flex items-center gap-1 text-xs" style={clientMode ? { color: 'var(--cp-green)' } : { color: '#047857' }}>
                      <Check className="h-3.5 w-3.5" aria-hidden /> {notice}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={deleteRun}
                    disabled={busy != null}
                    className={ui.ghostBtn}
                    style={{ color: clientMode ? 'var(--cp-red)' : '#b91c1c' }}
                    title="Удалить запуск"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </button>
                </div>
              </div>

              <Stepper current={step} maxReachable={maxReachable} onGo={goToStep} clientMode={clientMode} />

              {/* ───── Шаг 1: Продукт ───── */}
              {step === 0 && (
                <div className="mt-6">
                  <div className="flex items-start justify-between gap-4 flex-wrap">
                    <div>
                      <h2 className={ui.heading}>О продукте</h2>
                      <p className={ui.sub}>
                        Загрузите бриф или вставьте описание — мы сами выделим главные ценности, на которых построим письма.
                      </p>
                    </div>
                    {!clientMode && (
                      <label className="block">
                        <div className={ui.eyebrow}>Модель ценностей</div>
                        <select value={valuesModel} onChange={(e) => setValuesModel(e.target.value)} disabled={busy != null} className={ui.select}>
                          {VALUES_MODEL_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      </label>
                    )}
                  </div>

                  <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
                    {/* Источник брифа */}
                    <div className={`${ui.cardInner} p-4`} style={ui.cardInnerStyle}>
                      <div className={clientMode ? 'mb-3 inline-flex gap-1 rounded-md p-0.5 text-xs' : 'mb-3 inline-flex gap-1 rounded-lg bg-gray-100 p-1 text-xs'} style={clientMode ? { background: 'var(--cp-surface-elev)', border: '1px solid var(--cp-divider)' } : undefined}>
                        {savedBriefAvailable && (
                          <button
                            type="button"
                            onClick={() => setBriefInputMode('saved')}
                            className={clientMode
                              ? `rounded px-3 py-1.5 font-medium transition-colors ${briefInputMode === 'saved' ? 'bg-[var(--cp-paper)] text-[var(--cp-ink)]' : 'text-[var(--cp-paper-mute)]'}`
                              : `rounded-md px-3 py-1.5 font-medium transition-colors ${briefInputMode === 'saved' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'}`}
                          >
                            Бриф с портала
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => setBriefInputMode('file')}
                          className={clientMode
                            ? `rounded px-3 py-1.5 font-medium transition-colors ${briefInputMode === 'file' ? 'bg-[var(--cp-paper)] text-[var(--cp-ink)]' : 'text-[var(--cp-paper-mute)]'}`
                            : `rounded-md px-3 py-1.5 font-medium transition-colors ${briefInputMode === 'file' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'}`}
                        >
                          Файл
                        </button>
                        <button
                          type="button"
                          onClick={() => setBriefInputMode('text')}
                          className={clientMode
                            ? `rounded px-3 py-1.5 font-medium transition-colors ${briefInputMode === 'text' ? 'bg-[var(--cp-paper)] text-[var(--cp-ink)]' : 'text-[var(--cp-paper-mute)]'}`
                            : `rounded-md px-3 py-1.5 font-medium transition-colors ${briefInputMode === 'text' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'}`}
                        >
                          Текст
                        </button>
                      </div>

                      {briefInputMode === 'saved' && savedBriefAvailable && (
                        <div>
                          <div className="text-xs mb-2" style={ui.faint}>
                            Используем ваш бриф с портала (<a href="/client/brief" className="underline" style={ui.mute}>страница «Бриф»</a>).
                          </div>
                          <textarea value={savedBriefText} readOnly rows={7} className={ui.input} style={ui.mute} />
                        </div>
                      )}

                      {briefInputMode === 'file' && (
                        <div>
                          {(briefFile || run.brief_file_name) && (
                            <div className="mb-3 flex items-center gap-3 rounded-md px-3 py-2.5" style={clientMode ? { background: 'var(--cp-surface-elev)', border: '1px solid var(--cp-divider)' } : { background: '#f9fafb', border: '1px solid #e5e7eb' }}>
                              <FileText className="h-5 w-5 shrink-0" style={ui.faint} aria-hidden />
                              <div className="min-w-0 flex-1">
                                <p className="text-sm font-semibold truncate m-0" style={ui.text}>
                                  {briefFile ? briefFile.name : run.brief_file_name}
                                </p>
                                <p className="text-xs m-0" style={ui.faint}>
                                  {briefFile
                                    ? `${(briefFile.size / 1024).toFixed(0)} КБ · будет обработан`
                                    : stage1Done ? 'обработан' : 'загружен'}
                                </p>
                              </div>
                              {briefFile && (
                                <button type="button" onClick={() => { setBriefFile(null); if (briefInputRef.current) briefInputRef.current.value = ''; }} className={ui.ghostBtn} aria-label="Убрать файл">
                                  <X className="h-4 w-4" aria-hidden />
                                </button>
                              )}
                            </div>
                          )}
                          <label
                            onDragOver={(e) => e.preventDefault()}
                            onDrop={(e) => {
                              e.preventDefault();
                              const f = e.dataTransfer.files?.[0];
                              if (f) setBriefFile(f);
                            }}
                            className="flex cursor-pointer items-center justify-center rounded-md px-4 py-5 text-sm"
                            style={clientMode
                              ? { border: '1px dashed var(--cp-divider-strong)', color: 'var(--cp-paper-faint)' }
                              : { border: '1px dashed #d1d5db', color: '#6b7280' }}
                          >
                            {briefFile || run.brief_file_name ? 'Перетащите другой PDF или DOCX' : 'Перетащите PDF или DOCX — или нажмите'}
                            <input
                              ref={briefInputRef}
                              type="file"
                              accept=".pdf,.docx,.txt"
                              className="hidden"
                              onChange={(e) => setBriefFile(e.target.files?.[0] ?? null)}
                            />
                          </label>
                        </div>
                      )}

                      {briefInputMode === 'text' && (
                        <textarea
                          value={briefText}
                          onChange={(e) => setBriefText(e.target.value)}
                          rows={7}
                          placeholder="Вставьте текст брифа или описание продукта"
                          className={ui.input}
                        />
                      )}

                      <div className="mt-3">
                        <button
                          type="button"
                          onClick={extractValues}
                          disabled={
                            busy != null ||
                            (briefInputMode === 'file' && !briefFile && !run.brief_file_name) ||
                            (briefInputMode === 'text' && !briefText.trim()) ||
                            (briefInputMode === 'saved' && !savedBriefText.trim())
                          }
                          className={stage1Done ? ui.ghostBtn : ui.primaryBtn}
                        >
                          {busy === 'extracting-values'
                            ? <><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Выделяем ценности…</>
                            : stage1Done
                              ? <><RefreshCw className="h-4 w-4" aria-hidden /> Выделить ценности заново</>
                              : 'Выделить ценности'}
                        </button>
                      </div>
                    </div>

                    {/* Что мы выделили */}
                    <div className={`${ui.cardInner} p-4 max-h-[440px] overflow-auto`} style={ui.cardInnerStyle}>
                      <div className="flex items-center justify-between gap-2 mb-3">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold" style={ui.text}>Что мы выделили</span>
                          {stage1Done && (
                            <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${statusClasses('completed', clientMode)}`}>
                              Готово
                            </span>
                          )}
                        </div>
                        {stage1Done && (
                          <div className="flex items-center gap-1">
                            <button type="button" onClick={downloadValuesDocx} disabled={busy != null} className={ui.ghostBtn}>
                              {busy === 'export-docx' ? 'Готовим…' : 'DOCX'}
                            </button>
                            <button type="button" onClick={downloadValuesPdf} disabled={busy != null} className={ui.ghostBtn}>
                              PDF
                            </button>
                          </div>
                        )}
                      </div>
                      {run.values_text ? (
                        <ValuesChips valuesText={run.values_text} ui={ui} />
                      ) : (
                        <p className="text-sm m-0" style={ui.faint}>
                          {busy === 'extracting-values'
                            ? 'Анализируем бриф — обычно занимает до минуты…'
                            : '— пока пусто. Загрузите бриф слева и нажмите «Выделить ценности».'}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* ───── Шаг 2: Аудитория ───── */}
              {step === 1 && (
                <div className="mt-6">
                  <h2 className={ui.heading}>Кому пишем</h2>
                  <p className={ui.sub}>Опишите получателей своими словами — этого достаточно, чтобы письма звучали адресно.</p>

                  <div className="mt-4 space-y-4 max-w-2xl">
                    <label className="block">
                      <div className="text-sm font-semibold mb-1.5" style={ui.text}>Кому отправляем письма?</div>
                      <textarea
                        value={segmentText}
                        onChange={(e) => setSegmentText(e.target.value)}
                        rows={4}
                        placeholder="Например: маркетологи и продюсеры видеостудий, продакшн-агентства. Россия и СНГ."
                        className={ui.input}
                      />
                      <div className="mt-1 text-xs" style={ui.faint}>Должность, сфера, регион — что знаете о базе.</div>
                    </label>
                    <label className="block">
                      <div className="text-sm font-semibold mb-1.5" style={ui.text}>
                        Пожелания заказчика <span className="font-normal" style={ui.faint}>— необязательно</span>
                      </div>
                      <textarea
                        value={customerEdits}
                        onChange={(e) => setCustomerEdits(e.target.value)}
                        rows={4}
                        placeholder="Например: сделать акцент на скорости, упомянуть скидку в первом письме, тон дружелюбный…"
                        className={ui.input}
                      />
                    </label>

                    {!clientMode && (
                      <label className="block">
                        <div className={ui.eyebrow}>Операторы для персонализации (опционально)</div>
                        <textarea
                          value={personalizationOps}
                          onChange={(e) => setPersonalizationOps(e.target.value)}
                          rows={4}
                          placeholder={'Например:\n- {{companyName}}\n- {{firstName}}\n- {% if last_email_opened %}…{% else %}…{% endif %}'}
                          className={`${ui.input} ${ui.mono}`}
                        />
                      </label>
                    )}
                  </div>
                </div>
              )}

              {/* ───── Шаг 3: Письма ───── */}
              {step === 2 && (
                <div className="mt-6">
                  <div className="flex items-start justify-between gap-4 flex-wrap">
                    <div>
                      <h2 className={ui.heading}>Цепочка писем</h2>
                      <p className={ui.sub}>
                        {letters.length > 0
                          ? `${letters.length} писем · можно править, удалять и добавлять свои.`
                          : 'Сгенерируем 3–5 коротких писем по брифу, ценностям и аудитории.'}
                      </p>
                    </div>
                    <div className="flex items-end gap-2 flex-wrap">
                      <label className="block">
                        <div className={ui.eyebrow}>Язык</div>
                        <select
                          value={outputLanguage}
                          onChange={(e) => changeLanguage(e.target.value as EmailSequenceV2OutputLanguage)}
                          disabled={busy != null}
                          className={ui.select}
                        >
                          {LANGUAGE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      </label>
                      {!clientMode && (
                        <label className="block">
                          <div className={ui.eyebrow}>Модель писем</div>
                          <select value={writerModel} onChange={(e) => setWriterModel(e.target.value)} disabled={busy != null} className={ui.select}>
                            {WRITER_MODEL_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                        </label>
                      )}
                      <button
                        type="button"
                        onClick={generateLetters}
                        disabled={busy != null || !run.values_text || !segmentText.trim()}
                        className={letters.length ? ui.ghostBtn : ui.primaryBtn}
                      >
                        {busy === 'generating-letters'
                          ? <><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Генерация…</>
                          : letters.length
                            ? <><RefreshCw className="h-4 w-4" aria-hidden /> Сгенерировать заново</>
                            : 'Сгенерировать цепочку'}
                      </button>
                    </div>
                  </div>

                  {busy === 'generating-letters' && (
                    <div className="mt-4 rounded-md px-4 py-3 text-sm" style={clientMode ? { background: 'var(--cp-surface-rest)', border: '1px solid var(--cp-divider)', color: 'var(--cp-paper-mute)' } : { background: '#eff6ff', border: '1px solid #bfdbfe', color: '#1e40af' }}>
                      Модель пишет цепочку. Это занимает 2–4 минуты — не закрывайте вкладку.
                    </div>
                  )}

                  {letters.length === 0 ? (
                    busy !== 'generating-letters' && (
                      <div className="mt-4 rounded-md p-6 text-sm" style={clientMode ? { border: '1px dashed var(--cp-divider-strong)', color: 'var(--cp-paper-mute)' } : { border: '1px dashed #d1d5db', color: '#6b7280' }}>
                        Цепочка ещё не сгенерирована. Нажмите «Сгенерировать цепочку» — займёт пару минут.
                      </div>
                    )
                  ) : (
                    <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
                      {/* Список писем */}
                      <div className="space-y-2">
                        {letters.map((l, i) => {
                          const active = selectedLetter?.id === l.id;
                          return (
                            <button
                              key={l.id}
                              type="button"
                              onClick={() => selectLetter(l.id)}
                              className="w-full flex items-center gap-3 rounded-md px-3 py-2.5 text-left transition"
                              style={clientMode
                                ? active
                                  ? { background: 'var(--cp-surface-active)', border: '1px solid var(--cp-paper-faint)' }
                                  : { background: 'var(--cp-surface-rest)', border: '1px solid var(--cp-divider)' }
                                : active
                                  ? { background: '#eff6ff', border: '1px solid #93c5fd' }
                                  : { background: '#fff', border: '1px solid #e5e7eb' }}
                            >
                              <span
                                className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold"
                                style={clientMode
                                  ? { background: active ? 'var(--cp-paper)' : 'var(--cp-surface-elev)', color: active ? 'var(--cp-ink)' : 'var(--cp-paper-mute)', border: '1px solid var(--cp-divider)' }
                                  : { background: active ? '#111827' : '#f3f4f6', color: active ? '#fff' : '#4b5563' }}
                              >
                                {l.letter_index}
                              </span>
                              <span className="min-w-0">
                                <span className="block truncate text-sm font-medium" style={ui.text}>
                                  {l.subject?.trim() || 'Без темы'}
                                </span>
                                <span className="block text-xs" style={ui.faint}>{delayLabel(letters, i)}</span>
                              </span>
                            </button>
                          );
                        })}
                        <button type="button" onClick={addLetterAtEnd} disabled={busy != null} className={ui.dashedBtn}>
                          {busyEquals(busy, { type: 'letter', action: 'add', id: 'new' })
                            ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                            : <Plus className="h-4 w-4" aria-hidden />}
                          Добавить письмо
                        </button>
                      </div>

                      {/* Редактор выбранного письма */}
                      {selectedLetter && selectedIdx >= 0 ? (
                        <LetterEditor
                          letter={selectedLetter}
                          delayCaption={delayLabel(letters, selectedIdx)}
                          busy={busy}
                          onSave={saveLetter}
                          onDelete={deleteLetter}
                          onDirtyChange={markLetterDirty}
                          ui={ui}
                          clientMode={clientMode}
                        />
                      ) : null}
                    </div>
                  )}
                </div>
              )}

              {/* ───── Футер мастера ───── */}
              <div className="mt-7 flex items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={() => {
                    // Уход со шага «Письма» размонтирует редактор — его локальные
                    // правки теряются (политика leaveStep: тихо чистим реестр).
                    if (step === 2) requestLetterExit('leaveStep');
                    setStep((s) => Math.max(0, s - 1));
                  }}
                  disabled={step === 0 || busy != null}
                  className={ui.ghostBtn}
                >
                  <ChevronLeft className="h-4 w-4" aria-hidden /> Назад
                </button>
                <span className={`${ui.mono} text-xs`} style={ui.faint}>ШАГ {step + 1} / 3</span>
                {step === 0 && (
                  <button type="button" onClick={() => goToStep(1)} disabled={!stage1Done || busy != null} className={ui.primaryBtn}>
                    Далее <ChevronRight className="h-4 w-4" aria-hidden />
                  </button>
                )}
                {step === 1 && (
                  <button type="button" onClick={nextFromAudience} disabled={!segmentText.trim() || busy != null} className={ui.primaryBtn}>
                    {busy === 'saving-stage-2' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                    Далее <ChevronRight className="h-4 w-4" aria-hidden />
                  </button>
                )}
                {step === 2 && (clientMode ? (
                  <button type="button" onClick={sendToLaunch} disabled={letters.length === 0 || busy != null} className={ui.primaryBtn}>
                    <Send className="h-4 w-4" aria-hidden /> Отправить в рассылку
                  </button>
                ) : (
                  <span aria-hidden />
                ))}
              </div>
            </>
          )}
        </div>

        {/* ───── Сайдбар: последние запуски ───── */}
        <div className={`${ui.card} p-5 self-start`}>
          <h2 className={ui.heading}>Последние запуски</h2>
          <p className={ui.sub}>Топ-30</p>
          <button type="button" onClick={createRun} disabled={busy != null} className={`${ui.primaryBtn} w-full justify-center mt-3`}>
            {busy === 'creating' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />}
            Новый запуск
          </button>
          <div className="mt-3 space-y-2 max-h-[420px] overflow-y-auto pr-1">
            {runs.length ? (
              runs.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => loadRun(r.id).catch((e) => setError(e instanceof Error ? e.message : 'Ошибка'))}
                  className="w-full text-left rounded-md border px-3 py-2 text-sm transition"
                  style={clientMode
                    ? run?.id === r.id
                      ? { background: 'var(--cp-surface-active)', borderColor: 'var(--cp-paper-faint)' }
                      : { background: 'var(--cp-surface-rest)', borderColor: 'var(--cp-divider)' }
                    : run?.id === r.id
                      ? { background: '#eff6ff', borderColor: '#93c5fd' }
                      : { background: '#fff', borderColor: '#e5e7eb' }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-medium truncate" style={ui.text}>{r.company_name ?? r.id.slice(0, 8)}</div>
                    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold shrink-0 ${statusClasses(r.status, clientMode)}`}>
                      {statusLabel(r.status)}
                    </span>
                  </div>
                  <div className={`mt-1 ${ui.mono} text-xs truncate`} style={ui.faint}>{formatDate(r.created_at)}</div>
                </button>
              ))
            ) : (
              <div className="text-sm" style={ui.faint}>Пока пусто.</div>
            )}
          </div>
        </div>
      </div>
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
