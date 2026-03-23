'use client';

import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ClipboardEvent, DragEvent, KeyboardEvent, MouseEvent } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { supabase } from '@/lib/supabaseClient';
import { logError } from '@/lib/loggerClient';
import { deletePendingDbImport, readPendingDbImport } from '@/lib/databases/pendingImport';
import { parseXlsxInWorker } from '@/lib/databases/xlsxWorker';
import { backgroundSave, cancelBackgroundSave } from '@/lib/databases/backgroundSave';
import { loadStateViaWorker } from '@/lib/databases/backgroundLoad';

type Sheet = {
  id: string;
  name: string;
  data: string[][];
};

type Selection = {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
};

type SelectionMode = 'cell' | 'row' | 'col';

function useDebouncedValue<T>(value: T, delayMs: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(id);
  }, [delayMs, value]);
  return debounced;
}

type ContextMenuState = {
  x: number;
  y: number;
};

type FilterOption = {
  key: string;
  label: string;
};

type FilterMenuState = {
  col: number;
  x: number;
  y: number;
  options: FilterOption[];
  search: string;
  overflow: boolean;
};

type ActionSummary = {
  message: string;
  time: number;
};

type UndoState = {
  tabId: string;
  data: string[][];
  message: string;
  time: number;
};

type ConfirmState = {
  title: string;
  message: string;
  confirmLabel: string;
};

type ImportStatus = {
  status: 'idle' | 'reading' | 'parsing' | 'done' | 'error';
  progress: number;
  filename?: string;
  message?: string;
};

type CopyNotice = {
  message: string;
  tone: 'success' | 'error';
};

type PersistedSpreadsheetState = {
  version: number;
  tabs: Sheet[];
  activeTabId: string;
  tabCounter: number;
  columnWidths?: number[];
  savedAt?: number;
};

type PersistedEnrichmentRun = {
  jobId: string;
  tabId: string;
  sourceCol: number;
  targetCol: number;
  headerLabel: string;
  totalRows: number;
  startedAt: string;
};

type PersistedEnrichmentState = {
  version: number;
  runs: PersistedEnrichmentRun[];
};

type PersistedBriefScoringRun = {
  jobId: string;
  tabId: string;
  scoreCol: number;
  reasonCol: number;
  totalRows: number;
  startedAt: string;
};

type PersistedBriefScoringState = {
  version: number;
  runs: PersistedBriefScoringRun[];
};

type PersonalizationState = {
  isOpen: boolean;
  sourceCol: number;
  prompt: string;
  activePreset: string | null;
  briefText: string;
  briefFileName: string;
  isBriefUploading: boolean;
  isGenerating: boolean;
  progress: number;
  totalRows: number;
  currentRow: number;
  error: string | null;
};

type WebsiteEnrichmentState = {
  isOpen: boolean;
  sourceCol: number;
  isGenerating: boolean;
  progress: number;
  totalRows: number;
  currentRow: number;
  retryCount: number;
  error: string | null;
  jobId: string | null;
};

type BriefScoringState = {
  showPreCheck: boolean;
  isOpen: boolean;
  inputMode: 'pdf' | 'text';
  briefText: string;
  briefFileName: string;
  manualText: string;
  isUploading: boolean;
  isScoring: boolean;
  progress: number;
  totalRows: number;
  currentRow: number;
  error: string | null;
  jobId: string | null;
};

type NameCleanupState = {
  isOpen: boolean;
  nameCol: number;
  domainCol: number | null;
  useDomain: boolean;
  isProcessing: boolean;
  progress: number;
  totalRows: number;
  currentRow: number;
  error: string | null;
};

type SiteAvailabilityState = {
  isOpen: boolean;
  sourceCol: number;
  isChecking: boolean;
  progress: number;
  totalRows: number;
  currentRow: number;
  error: string | null;
};

type EmailSplitState = {
  isOpen: boolean;
  sourceCol: number;
};

type PhoneSplitState = {
  isOpen: boolean;
  sourceCol: number;
};

type EmailScrapingState = {
  isOpen: boolean;
  sourceCol: number;
  isGenerating: boolean;
  progress: number;
  totalRows: number;
  currentRow: number;
  retryCount: number;
  error: string | null;
  jobId: string | null;
};

type EmailValidationState = {
  isOpen: boolean;
  sourceCol: number;
  isValidating: boolean;
  progress: number;
  totalRows: number;
  currentRow: number;
  error: string | null;
  jobId: string | null;
  detectedJob: { id: string; total: number; processed: number; progress: number } | null;
};

type DadataFieldOption = {
  key: string;
  label: string;
};

type DadataEnrichmentState = {
  isOpen: boolean;
  sourceCol: number;
  mode: 'inn';
  selectedFields: string[];
  isProcessing: boolean;
  progress: number;
  totalRows: number;
  currentRow: number;
  error: string | null;
};

const DADATA_FIELDS: DadataFieldOption[] = [
  { key: 'full_name', label: 'Полное название' },
  { key: 'short_name', label: 'Краткое название' },
  { key: 'inn', label: 'ИНН' },
  { key: 'kpp', label: 'КПП' },
  { key: 'ogrn', label: 'ОГРН' },
  { key: 'address', label: 'Адрес' },
  { key: 'city', label: 'Город' },
  { key: 'region', label: 'Регион' },
  { key: 'postal_code', label: 'Индекс' },
  { key: 'manager_name', label: 'Руководитель' },
  { key: 'manager_post', label: 'Должность руководителя' },
  { key: 'status', label: 'Статус' },
  { key: 'okved', label: 'ОКВЭД (код)' },
  { key: 'opf', label: 'ОПФ (ООО, ПАО...)' },
  { key: 'org_type', label: 'Тип (ЮЛ/ИП)' },
  { key: 'registration_date', label: 'Дата регистрации' },
  { key: 'branch_count', label: 'Кол-во филиалов' },
];

const DADATA_DEFAULT_FIELDS = [
  'full_name', 'inn', 'kpp', 'ogrn', 'address', 'city',
  'manager_name', 'manager_post', 'status', 'okved', 'opf', 'registration_date',
];

const DADATA_BATCH_SIZE = 20;

const PERSONALIZATION_BATCH_SIZE = 2;
const PERSONALIZATION_MAX_RETRIES = 3;
const PERSONALIZATION_RETRY_BASE_DELAY = 1200;
const PERSONALIZATION_HIGHLIGHT_DURATION = 2500;

const INSTANTLY_FIELD_OPTIONS = [
  { value: 'email', label: 'Email' },
  { value: 'first_name', label: 'Имя (First Name)' },
  { value: 'last_name', label: 'Фамилия (Last Name)' },
  { value: 'company_name', label: 'Компания (Company)' },
  { value: 'phone', label: 'Телефон (Phone)' },
  { value: 'website', label: 'Сайт (Website)' },
  { value: 'linkedin_url', label: 'LinkedIn' },
  { value: 'personalization', label: 'Персонализация (Personalization)' },
  { value: 'custom_variable', label: '{{Переменная}}' },
  { value: 'skip', label: '— Пропустить —' },
] as const;

type InstantlyFieldValue = (typeof INSTANTLY_FIELD_OPTIONS)[number]['value'];

const INSTANTLY_AUTO_DETECT: Array<{ pattern: RegExp; field: InstantlyFieldValue }> = [
  { pattern: /^e-?mail$/i, field: 'email' },
  { pattern: /^(почта|эл[._\s]?почта|e-?mail\s*адрес)$/i, field: 'email' },
  { pattern: /^(first[_\s]?name|имя|firstname)$/i, field: 'first_name' },
  { pattern: /^(last[_\s]?name|фамилия|lastname|surname)$/i, field: 'last_name' },
  { pattern: /^(company[_\s]?name|company|компания|название|организация)$/i, field: 'company_name' },
  { pattern: /^(phone|телефон|тел|mobile|моб)$/i, field: 'phone' },
  { pattern: /^(website|сайт|site|url|домен|domain)$/i, field: 'website' },
  { pattern: /^(linkedin[_\s]?url|linkedin)$/i, field: 'linkedin_url' },
  { pattern: /^(персонализаци|personalization)/i, field: 'personalization' },
];

function autoDetectInstantlyField(header: string): InstantlyFieldValue {
  const trimmed = header.trim();
  if (!trimmed) return 'skip';
  for (const rule of INSTANTLY_AUTO_DETECT) {
    if (rule.pattern.test(trimmed)) return rule.field;
  }
  return 'custom_variable';
}

const PERSONALIZATION_PRESETS = [
  {
    id: 'pain-point',
    label: 'Занимаетесь X, боль - Y',
    needsBrief: true,
    prompt: `На основе данных о компании определи:
1. X - чем конкретно занимается компания, на что делает ставку (кратко, 3-7 слов)
2. Y - какая настоящая, глубинная боль у такого бизнеса (не очевидная, а та что лежит глубже)

Сформулируй ответ СТРОГО в формате:
"По сайту видно, что вы делаете ставку на [X]. В таких бизнесах обычно основная боль - [Y], а не то, что лежит на поверхности."

Замени [X] и [Y] на конкретные значения. Убери квадратные скобки. Пиши одним абзацем, 1-2 предложения.
Если данных недостаточно для определения боли - напиши нейтральную, но правдоподобную формулировку исходя из сферы.
При определении боли учитывай контекст из брифа компании-отправителя (приложен ниже) - боль должна быть релевантна тому, что мы можем решить.`,
  },
] as const;
const ENRICHMENT_PROGRESS_INTERVAL_MS = 200;
const ENRICHMENT_UPDATE_FLUSH_MS = 250;
const ENRICHMENT_UPDATE_BATCH = 20;
const ENRICHMENT_HIGHLIGHT_DURATION = 2500;
const ENRICHMENT_MAX_CONSECUTIVE_FAILURES = 10;
const ENRICHMENT_STALL_TIMEOUT_MS = 3 * 60 * 1000;
const EMAIL_SCRAPING_STALL_TIMEOUT_MS = 10 * 60 * 1000;
const BRIEF_SCORING_HIGHLIGHT_DURATION = 2500;
const BRIEF_SCORING_POLL_INTERVAL_MS = 1000;
const BRIEF_SCORING_MAX_POLL_DELAY_MS = 5000;
const BRIEF_SCORING_MAX_CONSECUTIVE_FAILURES = 10;
const BRIEF_SCORING_ENQUEUE_CHUNK_SIZE = 50;
const BRIEF_SCORING_MAX_FIELDS_PER_ROW = 20;
const BRIEF_SCORING_MAX_CELL_CHARS = 280;
const BRIEF_STORAGE_BUCKET = process.env.NEXT_PUBLIC_BRIEF_STORAGE_BUCKET ?? 'briefs';
const BRIEF_STORAGE_PREFIX = 'brief-scoring';
const MAX_BRIEF_FILE_BYTES = 20 * 1024 * 1024;
const NAME_CLEANUP_BATCH_SIZE = 100;
const NAME_CLEANUP_CONCURRENCY = 2;
const NAME_CLEANUP_HIGHLIGHT_DURATION = 2500;
const SITE_AVAILABILITY_BATCH_SIZE = 50;
const SITE_AVAILABILITY_MAX_RETRIES = 2;
const SITE_AVAILABILITY_RETRY_BASE_DELAY = 1200;
const SITE_AVAILABILITY_HIGHLIGHT_DURATION = 2500;
const EMAIL_VALIDATION_PROGRESS_INTERVAL_MS = 500;
const EMAIL_VALIDATION_MAX_CONSECUTIVE_FAILURES = 10;
const EMAIL_VALIDATION_STALL_TIMEOUT_MS = 5 * 60 * 1000;
const VIRTUALIZATION_THRESHOLD = 1500;
const VIRTUAL_ROW_HEIGHT = 22;
const VIRTUAL_OVERSCAN = 10;
const GROUP_SUMMARY_PAGE_SIZE = 200;
const WRAP_STORAGE_KEY = 'portal:db-wrap-cells';
const COPY_NOTICE_DURATION_MS = 4000;

const EMAIL_HEADER_REGEX = /(e-?mail|email|почта|mail)/i;
const EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const INVISIBLE_WHITESPACE_REGEX = /[\u200B-\u200F\uFEFF\u00AD\u2060\u180E]/g;
const NON_STANDARD_SPACE_REGEX = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;
const MAX_FILTER_OPTIONS = 1000;
const BLANK_FILTER_LABEL = '(пусто)';
const EMOJI_REGEX = /[\u{1F300}-\u{1FAFF}]/gu;
const DEFAULT_COLUMN_WIDTH = 130;
const MIN_COLUMN_WIDTH = 30;
const COMPANY_HEADER_REGEX = /(компан|company|организац)/i;
const HEADER_LABEL_HINT_REGEX =
  /(названи|компан|company|сайт|website|url|домен|email|почта|контакт|телефон|phone|industry|сфера|описан|about|адрес|address)/i;
const ENRICHMENT_COLUMN_REGEX =
  /(обогащен|описан|description|about|сфера|industry|сотрудник|employee|штат|revenue|оборот|инн|телефон|phone|dadata|фнс|город|city|регион|region)/i;

const DEFAULT_ROWS = 20;
const DEFAULT_COLS = 10;
const STORAGE_KEY_PREFIX = 'portal:database-spreadsheet';
const STORAGE_VERSION = 1;
const STORAGE_SAVE_DELAY = 700;
const STORAGE_SAVE_DELAY_LARGE = 10_000;
const LARGE_DATASET_ROW_THRESHOLD = 10_000;
const ENRICHMENT_STORAGE_KEY_PREFIX = 'portal:website-enrichment';
const ENRICHMENT_STORAGE_VERSION = 1;
const BRIEF_SCORING_STORAGE_KEY_PREFIX = 'portal:brief-scoring';
const BRIEF_SCORING_STORAGE_VERSION = 1;

const createId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const createSheet = (name: string, rows = DEFAULT_ROWS, cols = DEFAULT_COLS): Sheet => ({
  id: createId(),
  name,
  data: Array.from({ length: rows }, () => Array.from({ length: cols }, () => '')),
});

const toColumnLabel = (index: number) => {
  let label = '';
  let current = index;
  while (current >= 0) {
    label = String.fromCharCode((current % 26) + 65) + label;
    current = Math.floor(current / 26) - 1;
  }
  return label;
};

const safeMaxCols = (rows: string[][]) =>
  rows.reduce((max, row) => (row.length > max ? row.length : max), 1);

const normalizeRows = (rows: string[][]) => {
  const maxCols = safeMaxCols(rows);
  return rows.map((row) => {
    if (row.length >= maxCols) return row;
    return [...row, ...Array.from({ length: maxCols - row.length }, () => '')];
  });
};

const normalizeClipboardCell = (value: unknown) =>
  `${value ?? ''}`.replaceAll('\r\n', '\n').replaceAll('\r', '\n');

const buildClipboardTsv = (rows: string[][]) =>
  Papa.unparse(
    rows.map((row) => row.map((cell) => normalizeClipboardCell(cell))),
    {
      delimiter: '\t',
      newline: '\n',
      header: false,
    },
  );

const parseClipboardTsv = (text: string) => {
  const parsed = Papa.parse<string[]>(text, {
    delimiter: '\t',
    skipEmptyLines: false,
  });
  const values = parsed.data.map((row) => row.map((cell) => `${cell ?? ''}`));

  while (values.length > 0 && values[values.length - 1].every((cell) => cell.length === 0)) {
    values.pop();
  }

  return values;
};

const parseClipboardHtml = (html: string): string[][] | null => {
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const table = doc.querySelector('table');
    if (!table) return null;
    const rows = Array.from(table.querySelectorAll('tr'));
    if (rows.length === 0) return null;
    const result = rows.map((tr) =>
      Array.from(tr.querySelectorAll('td, th')).map((cell) =>
        (cell.textContent ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n'),
      ),
    );
    while (result.length > 0 && result[result.length - 1].every((c) => c.trim().length === 0)) {
      result.pop();
    }
    return result.length > 0 ? result : null;
  } catch {
    return null;
  }
};

const parseBestClipboard = (plain: string, html: string): string[][] => {
  const fromTsv = parseClipboardTsv(plain);
  const fromHtml = parseClipboardHtml(html);
  if (fromHtml && fromHtml.length > fromTsv.length) return fromHtml;
  return fromTsv;
};

const writeTextToClipboard = async (text: string) => {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  if (typeof document === 'undefined') {
    throw new Error('Clipboard API unavailable');
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  textarea.style.top = '0';
  textarea.style.left = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();

  if (!copied) {
    throw new Error('Clipboard API unavailable');
  }
};

const buildCopySummary = (rows: number, cols: number) => {
  const safeRows = Math.max(0, rows);
  const safeCols = Math.max(0, cols);
  const cells = safeRows * safeCols;
  return `Скопировано: ${safeRows}x${safeCols} (${cells} ячеек)`;
};

const buildStorageKey = (userId: string | null) =>
  `${STORAGE_KEY_PREFIX}:${userId ?? 'anonymous'}`;

const buildEnrichmentStorageKey = (userId: string | null) =>
  `${ENRICHMENT_STORAGE_KEY_PREFIX}:${userId ?? 'anonymous'}`;

const buildBriefScoringStorageKey = (userId: string | null) =>
  `${BRIEF_SCORING_STORAGE_KEY_PREFIX}:${userId ?? 'anonymous'}`;

const isStringArray = (arr: unknown[]): arr is string[] =>
  arr.length === 0 || typeof arr[0] === 'string';

const coerceRows = (rows: unknown) => {
  if (!Array.isArray(rows)) return [];
  if (rows.length > 0 && Array.isArray(rows[0]) && isStringArray(rows[0])) {
    return rows as string[][];
  }
  return rows.map((row) => {
    if (!Array.isArray(row)) return [''];
    return row.map((cell) => `${cell ?? ''}`);
  });
};

const coerceTabs = (value: unknown) => {
  if (!Array.isArray(value)) return [] as Sheet[];
  return value
    .map((tab, index) => {
      if (!tab || typeof tab !== 'object') return null;
      const { id, name, data } = tab as Partial<Sheet>;
      const safeId = typeof id === 'string' && id.trim().length > 0 ? id : createId();
      const safeName =
        typeof name === 'string' && name.trim().length > 0 ? name : `Вкладка ${index + 1}`;
      const rows = coerceRows(data);
      if (rows.length === 0) {
        return { id: safeId, name: safeName, data: [Array.from({ length: DEFAULT_COLS }, () => '')] };
      }
      const maxCols = safeMaxCols(rows);
      const needsNormalization = rows.some((row) => row.length !== maxCols);
      return { id: safeId, name: safeName, data: needsNormalization ? normalizeRows(rows) : rows };
    })
    .filter((tab): tab is Sheet => tab !== null);
};

const resolveActiveTabId = (tabs: Sheet[], activeTabId?: string) => {
  if (tabs.length === 0) return '';
  if (activeTabId && tabs.some((tab) => tab.id === activeTabId)) return activeTabId;
  return tabs[0].id;
};

const deriveTabCounter = (tabs: Sheet[], storedCounter?: number) => {
  const safeStored =
    typeof storedCounter === 'number' && Number.isFinite(storedCounter)
      ? Math.max(1, Math.floor(storedCounter))
      : 1;
  const maxFromNames = tabs.reduce((max, tab) => {
    const match = tab.name.match(/Вкладка\s+(\d+)/i);
    if (!match) return max;
    const value = Number(match[1]);
    return Number.isFinite(value) ? Math.max(max, value) : max;
  }, 1);
  return Math.max(safeStored, maxFromNames, tabs.length);
};

const sanitizeColumnWidths = (value: unknown) => {
  if (!Array.isArray(value)) return [];
  return value.map((width) => {
    if (typeof width !== 'number' || !Number.isFinite(width)) return DEFAULT_COLUMN_WIDTH;
    return Math.max(MIN_COLUMN_WIDTH, width);
  });
};

const readPersistedState = (raw: unknown): PersistedSpreadsheetState | null => {
  if (!raw) return null;
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const candidate = parsed as PersistedSpreadsheetState;
  if (candidate.version !== STORAGE_VERSION) return null;
  const tabs = coerceTabs(candidate.tabs);
  if (tabs.length === 0) return null;
  const activeTabId = resolveActiveTabId(tabs, candidate.activeTabId);
  const tabCounter = deriveTabCounter(tabs, candidate.tabCounter);
  const columnWidths = sanitizeColumnWidths(candidate.columnWidths);
  const savedAt = typeof candidate.savedAt === 'number' ? candidate.savedAt : 0;
  return { version: STORAGE_VERSION, tabs, activeTabId, tabCounter, columnWidths, savedAt };
};

const readPersistedEnrichment = (raw: unknown): PersistedEnrichmentState => {
  if (!raw) return { version: ENRICHMENT_STORAGE_VERSION, runs: [] };
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { version: ENRICHMENT_STORAGE_VERSION, runs: [] };
    }
  }
  if (!parsed || typeof parsed !== 'object') return { version: ENRICHMENT_STORAGE_VERSION, runs: [] };
  const candidate = parsed as Partial<PersistedEnrichmentState>;
  if (candidate.version !== ENRICHMENT_STORAGE_VERSION || !Array.isArray(candidate.runs)) {
    return { version: ENRICHMENT_STORAGE_VERSION, runs: [] };
  }
  const runs = candidate.runs
    .map((run) => {
      if (!run || typeof run !== 'object') return null;
      const value = run as Partial<PersistedEnrichmentRun>;
      if (!value.jobId || !value.tabId) return null;
      const sourceCol = Number(value.sourceCol ?? 0);
      const targetCol = Number(value.targetCol ?? 0);
      return {
        jobId: String(value.jobId),
        tabId: String(value.tabId),
        sourceCol: Number.isFinite(sourceCol) ? sourceCol : 0,
        targetCol: Number.isFinite(targetCol) ? targetCol : 0,
        headerLabel: typeof value.headerLabel === 'string' ? value.headerLabel : '',
        totalRows: typeof value.totalRows === 'number' && Number.isFinite(value.totalRows) ? value.totalRows : 0,
        startedAt: typeof value.startedAt === 'string' ? value.startedAt : new Date().toISOString(),
      } satisfies PersistedEnrichmentRun;
    })
    .filter((run): run is PersistedEnrichmentRun => run !== null);
  return { version: ENRICHMENT_STORAGE_VERSION, runs };
};

const readPersistedBriefScoring = (raw: unknown): PersistedBriefScoringState => {
  if (!raw) return { version: BRIEF_SCORING_STORAGE_VERSION, runs: [] };
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { version: BRIEF_SCORING_STORAGE_VERSION, runs: [] };
    }
  }
  if (!parsed || typeof parsed !== 'object') return { version: BRIEF_SCORING_STORAGE_VERSION, runs: [] };
  const candidate = parsed as Partial<PersistedBriefScoringState>;
  if (candidate.version !== BRIEF_SCORING_STORAGE_VERSION || !Array.isArray(candidate.runs)) {
    return { version: BRIEF_SCORING_STORAGE_VERSION, runs: [] };
  }
  const runs = candidate.runs
    .map((run) => {
      if (!run || typeof run !== 'object') return null;
      const value = run as Partial<PersistedBriefScoringRun>;
      if (!value.jobId || !value.tabId) return null;
      const scoreCol = Number(value.scoreCol ?? 0);
      const reasonCol = Number(value.reasonCol ?? 1);
      return {
        jobId: String(value.jobId),
        tabId: String(value.tabId),
        scoreCol: Number.isFinite(scoreCol) ? scoreCol : 0,
        reasonCol: Number.isFinite(reasonCol) ? reasonCol : 1,
        totalRows: typeof value.totalRows === 'number' && Number.isFinite(value.totalRows) ? value.totalRows : 0,
        startedAt: typeof value.startedAt === 'string' ? value.startedAt : new Date().toISOString(),
      } satisfies PersistedBriefScoringRun;
    })
    .filter((run): run is PersistedBriefScoringRun => run !== null);
  return { version: BRIEF_SCORING_STORAGE_VERSION, runs };
};

const trimTrailingEmptyRows = (rows: string[][]) => {
  const nextRows = [...rows];
  while (nextRows.length > 0) {
    const lastRow = nextRows[nextRows.length - 1];
    if (lastRow.some((cell) => cell.trim().length > 0)) break;
    nextRows.pop();
  }
  return nextRows;
};

const getBaseFilename = (filename: string) => filename.replace(/\.[^/.]+$/, '').trim();

const parseTerms = (value: string) =>
  value
    .split(/[\n,;]+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0);

const normalizeText = (
  value: string,
  options: { lower: boolean; trim: boolean; removeEmoji: boolean },
) => {
  let next = value;
  if (options.removeEmoji) {
    next = next.replace(EMOJI_REGEX, '');
  }
  if (options.trim) {
    next = next.replace(/\s+/g, ' ').trim();
  }
  if (options.lower) {
    next = next.toLowerCase();
  }
  return next;
};

const sanitizeCellWhitespaceForExport = (value: string, isEmailField: boolean) => {
  let next = value
    .replace(INVISIBLE_WHITESPACE_REGEX, '')
    .replace(NON_STANDARD_SPACE_REGEX, ' ');

  if (isEmailField) {
    // Instantly is sensitive to any whitespace in email cells.
    return next.replace(/\s+/g, '').trim();
  }

  next = next.replace(/[\t\r\n]+/g, ' ');
  return next.trim();
};

const formatTime = (value: number) =>
  new Date(value).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

const cloneData = (data: string[][]) => data.map((row) => [...row]);

const normalizeCellKey = (value: string) => value.trim().toLowerCase();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const parseJsonResponse = async <T,>(
  res: Response,
  context: string,
): Promise<T & { error?: string }> => {
  const text = await res.text();
  if (!text) return { error: 'Empty response from server' } as T & { error?: string };
  try {
    return JSON.parse(text) as T & { error?: string };
  } catch (error) {
    void logError('spreadsheet.api.invalid_json', error, {
      context,
      status: res.status,
      preview: text.slice(0, 200),
    });
    return { error: 'Сервер вернул некорректный ответ' } as T & { error?: string };
  }
};

const buildFilterOptions = (data: string[][], colIndex: number) => {
  const map = new Map<string, string>();
  let overflow = false;
  for (let r = 1; r < data.length; r += 1) {
    const raw = data[r]?.[colIndex] ?? '';
    const trimmed = raw.trim();
    const key = normalizeCellKey(trimmed);
    if (map.has(key)) continue;
    if (map.size >= MAX_FILTER_OPTIONS) {
      overflow = true;
      continue;
    }
    map.set(key, trimmed.length > 0 ? trimmed : BLANK_FILTER_LABEL);
  }

  const options = [...map.entries()]
    .map(([key, label]) => ({ key, label }))
    .sort((a, b) => a.label.localeCompare(b.label, 'ru'));

  return { options, overflow };
};

const formatProgressLabel = (status: ImportStatus) => {
  if (status.status === 'reading') return 'Чтение файла';
  if (status.status === 'parsing') return 'Импорт';
  if (status.status === 'done') return 'Готово';
  if (status.status === 'error') return status.message ?? 'Ошибка импорта';
  return '';
};

const countFilledCells = (row: string[]) => row.reduce((acc, cell) => {
  return acc + (cell.trim().length > 0 ? 1 : 0);
}, 0);

const isRowEmpty = (row: string[]) => row.every((cell) => cell.trim().length === 0);

const hasHeaderRow = (data: string[][]) => {
  const firstRow = data[0] ?? [];
  return firstRow.some((cell) => EMAIL_HEADER_REGEX.test(cell.trim().toLowerCase()));
};

const detectEmailColumns = (data: string[][]) => {
  if (data.length === 0) return [] as number[];
  const firstRow = data[0];
  const headerMatches = firstRow
    .map((cell, index) => (EMAIL_HEADER_REGEX.test(cell.trim().toLowerCase()) ? index : -1))
    .filter((index) => index >= 0);
  if (headerMatches.length > 0) return headerMatches;

  const colCount = data.reduce((max, row) => (row.length > max ? row.length : max), 0);
  const emailCounts = Array.from({ length: colCount }, () => 0);
  const rowCount = data.length;
  for (let r = 0; r < rowCount; r += 1) {
    for (let c = 0; c < colCount; c += 1) {
      const value = data[r][c] ?? '';
      if (EMAIL_REGEX.test(value)) {
        emailCounts[c] += 1;
      }
    }
  }
  const maxCount = emailCounts.reduce((max, c) => (c > max ? c : max), 0);
  if (maxCount === 0) return [] as number[];
  return emailCounts
    .map((count, index) => (count === maxCount ? index : -1))
    .filter((index) => index >= 0);
};

const extractEmail = (value: string) => {
  const match = value.match(EMAIL_REGEX);
  return match ? match[0].trim().toLowerCase() : null;
};

const getRowEmail = (row: string[], emailColumns: number[]) => {
  for (const col of emailColumns) {
    const email = extractEmail(row[col] ?? '');
    if (email) return email;
  }
  for (const cell of row) {
    const email = extractEmail(cell ?? '');
    if (email) return email;
  }
  return null;
};

export function DatabaseSpreadsheet() {
  const searchParams = useSearchParams();
  const importId = searchParams.get('import');
  const importHandledRef = useRef<string | null>(null);

  const [tabs, setTabs] = useState<Sheet[]>(() => [createSheet('Вкладка 1')]);
  const [activeTabId, setActiveTabId] = useState<string>(() => tabs[0].id);
  const [tabCounter, setTabCounter] = useState(1);
  const [storageKey, setStorageKey] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const enrichmentStorageKey = useMemo(() => buildEnrichmentStorageKey(userId), [userId]);
  const briefScoringStorageKey = useMemo(() => buildBriefScoringStorageKey(userId), [userId]);
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingTabName, setEditingTabName] = useState('');
  const [selectionMode, setSelectionMode] = useState<SelectionMode>('cell');
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [filterMenu, setFilterMenu] = useState<FilterMenuState | null>(null);
  const [columnFilters, setColumnFilters] = useState<Record<number, string[]>>({});
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOnlyMatches, setSearchOnlyMatches] = useState(false);
  const [wrapCells, setWrapCells] = useState(true);
  const [forceWrapLarge, setForceWrapLarge] = useState(false);
  const [dragCol, setDragCol] = useState<number | null>(null);
  const [dragOverCol, setDragOverCol] = useState<number | null>(null);
  const [dragRow, setDragRow] = useState<number | null>(null);
  const [dragOverRow, setDragOverRow] = useState<number | null>(null);
  const [normalizeLowercase, setNormalizeLowercase] = useState(true);
  const [normalizeSpaces, setNormalizeSpaces] = useState(true);
  const [normalizeEmoji, setNormalizeEmoji] = useState(true);
  const [groupByCol, setGroupByCol] = useState<number | null>(null);
  const [groupSearch, setGroupSearch] = useState('');
  const [groupSummaryLimit, setGroupSummaryLimit] = useState(GROUP_SUMMARY_PAGE_SIZE);
  const [rightPanelTab, setRightPanelTab] = useState<'summary' | 'cleanup'>('summary');
  const [rightPanelOpen, setRightPanelOpen] = useState(true);
  const debouncedSearchQuery = useDebouncedValue(searchQuery, 300);
  const debouncedGroupSearch = useDebouncedValue(groupSearch, 300);
  const debouncedFilterMenuSearch = useDebouncedValue(filterMenu?.search ?? '', 300);
  const [lastAction, setLastAction] = useState<ActionSummary | null>(null);
  const [copyNotice, setCopyNotice] = useState<CopyNotice | null>(null);
  const [lastUndo, setLastUndo] = useState<UndoState | null>(null);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [selection, setSelection] = useState<Selection>({
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
  });
  const [selectionAnchor, setSelectionAnchor] = useState({ row: 0, col: 0 });
  const [activeCell, setActiveCell] = useState({ row: 0, col: 0 });
  const [isSelecting, setIsSelecting] = useState(false);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const selectAllRef = useRef<HTMLInputElement | null>(null);
  const tableWrapperRef = useRef<HTMLDivElement | null>(null);
  const tableElementRef = useRef<HTMLTableElement | null>(null);
  const filterMenuRef = useRef<HTMLDivElement | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const scrollRafRef = useRef<number | null>(null);
  const [scrollMetrics, setScrollMetrics] = useState({ scrollTop: 0, height: 0 });
  const [horizontalScrollLeft, setHorizontalScrollLeft] = useState(0);
  const [horizontalScrollbarMetrics, setHorizontalScrollbarMetrics] = useState({
    scrollWidth: 0,
    clientWidth: 0,
  });
  const [fixedScrollbarViewport, setFixedScrollbarViewport] = useState({
    left: 0,
    width: 0,
  });
  const confirmActionRef = useRef<(() => void) | null>(null);
  const [columnWidths, setColumnWidths] = useState<number[]>([]);
  const [highlightedCol, setHighlightedCol] = useState<number | null>(null);
  const highlightTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resizingRef = useRef<{ col: number; startX: number; startWidth: number } | null>(
    null,
  );
  const [isResizing, setIsResizing] = useState(false);
  const importTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyNoticeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastProgressRef = useRef(0);
  const [importStatus, setImportStatus] = useState<ImportStatus>({
    status: 'idle',
    progress: 0,
  });
  const [isHydrated, setIsHydrated] = useState(false);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const accessTokenRef = useRef<string | null>(null);
  const hydratedStateRef = useRef<string | null>(null);

  const [reviewSubmit, setReviewSubmit] = useState<{
    isOpen: boolean;
    comment: string;
    projectId: string;
    submitting: boolean;
  }>({ isOpen: false, comment: '', projectId: '', submitting: false });
  const [reviewSubmitToast, setReviewSubmitToast] = useState('');
  const [instantlyPush, setInstantlyPush] = useState<{
    isOpen: boolean;
    campaignId: string;
    leadListId: string;
    pushing: boolean;
    result: string;
    loadingLists: boolean;
    columnMapping: InstantlyFieldValue[];
    mappingStep: boolean;
  }>({ isOpen: false, campaignId: '', leadListId: '', pushing: false, result: '', loadingLists: false, columnMapping: [], mappingStep: false });
  const [instantlyCampaigns, setInstantlyCampaigns] = useState<Array<{ id: string; name: string; ts?: string }>>([]);
  const [instantlyLeadLists, setInstantlyLeadLists] = useState<Array<{ id: string; name: string }>>([]);
  const [instantlyCampaignSearch, setInstantlyCampaignSearch] = useState('');
  const [instantlyCreateMode, setInstantlyCreateMode] = useState(false);
  const [instantlyNewName, setInstantlyNewName] = useState('');
  const [projectsList, setProjectsList] = useState<Array<{ id: string; name: string }>>([]);
  const [reviewPublish, setReviewPublish] = useState<{
    isOpen: boolean;
    requestId: string;
    chatId: number | null;
    message: string;
    publishing: boolean;
  }>({ isOpen: false, requestId: '', chatId: null, message: '', publishing: false });
  const [tgChats, setTgChats] = useState<Array<{ id: number; title: string }>>([]);
  const [myReviewRequests, setMyReviewRequests] = useState<Array<{
    id: string; tab_id: string; tab_name: string; status: string; project_name?: string;
    reviewer_comment?: string;
  }>>([]);
  const [reviewMarks, setReviewMarks] = useState<Array<{
    row_index: number; color: string; comment: string; author_type: string;
  }>>([]);
  const [reviewMarksPopup, setReviewMarksPopup] = useState<{
    rowIndex: number; marks: Array<{ color: string; comment: string; author_type: string }>;
    top: number; left: number;
  } | null>(null);

  const flushSave = () => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }
    if (!storageKey || !isHydrated || tabs.length === 0) return;
    const safeActiveTabId = resolveActiveTabId(tabs, activeTabId);
    const payload: PersistedSpreadsheetState = {
      version: STORAGE_VERSION,
      tabs,
      activeTabId: safeActiveTabId,
      tabCounter: deriveTabCounter(tabs, tabCounter),
      columnWidths,
      savedAt: Date.now(),
    };
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(payload));
    } catch {
      /* quota exceeded — acceptable for very large datasets */
    }
    if (userId) {
      const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const sbKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      if (sbUrl && sbKey && accessTokenRef.current) {
        try {
          void fetch(`${sbUrl}/rest/v1/database_spreadsheet_states`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Prefer': 'resolution=merge-duplicates,return=minimal',
              'apikey': sbKey,
              'Authorization': `Bearer ${accessTokenRef.current}`,
            },
            body: JSON.stringify({
              user_id: userId,
              state: payload,
              updated_at: new Date().toISOString(),
            }),
            keepalive: true,
          });
        } catch {
          /* best-effort during unload */
        }
      }
    }
  };

  const [personalization, setPersonalization] = useState<PersonalizationState>({
    isOpen: false,
    sourceCol: 0,
    prompt: '',
    activePreset: null,
    briefText: '',
    briefFileName: '',
    isBriefUploading: false,
    isGenerating: false,
    progress: 0,
    totalRows: 0,
    currentRow: 0,
    error: null,
  });
  const personalizationAbortRef = useRef<AbortController | null>(null);
  const personalizationBriefInputRef = useRef<HTMLInputElement | null>(null);
  const [websiteEnrichment, setWebsiteEnrichment] = useState<WebsiteEnrichmentState>({
    isOpen: false,
    sourceCol: 0,
    isGenerating: false,
    progress: 0,
    totalRows: 0,
    currentRow: 0,
    retryCount: 0,
    error: null,
    jobId: null,
  });
  const [enrichmentTargetOverride, setEnrichmentTargetOverride] = useState<number | null>(null);
  const enrichmentAbortRef = useRef<AbortController | null>(null);
  const resumeEnrichmentRef = useRef<string | null>(null);
  const resumeBriefScoringRef = useRef<string | null>(null);
  const [briefScoring, setBriefScoring] = useState<BriefScoringState>({
    showPreCheck: false,
    isOpen: false,
    inputMode: 'pdf',
    briefText: '',
    briefFileName: '',
    manualText: '',
    isUploading: false,
    isScoring: false,
    progress: 0,
    totalRows: 0,
    currentRow: 0,
    error: null,
    jobId: null,
  });
  const briefScoringAbortRef = useRef<AbortController | null>(null);
  const briefFileInputRef = useRef<HTMLInputElement | null>(null);
  const [nameCleanup, setNameCleanup] = useState<NameCleanupState>({
    isOpen: false,
    nameCol: 0,
    domainCol: null,
    useDomain: false,
    isProcessing: false,
    progress: 0,
    totalRows: 0,
    currentRow: 0,
    error: null,
  });
  const nameCleanupAbortRef = useRef<AbortController | null>(null);
  const [siteAvailability, setSiteAvailability] = useState<SiteAvailabilityState>({
    isOpen: false,
    sourceCol: 0,
    isChecking: false,
    progress: 0,
    totalRows: 0,
    currentRow: 0,
    error: null,
  });
  const siteAvailabilityAbortRef = useRef<AbortController | null>(null);
  const [dedupModal, setDedupModal] = useState<{ isOpen: boolean; mode: 'email' | 'company'; col: number }>({
    isOpen: false,
    mode: 'email',
    col: 0,
  });
  const [emailSplit, setEmailSplit] = useState<EmailSplitState>({
    isOpen: false,
    sourceCol: 0,
  });
  const [phoneSplit, setPhoneSplit] = useState<PhoneSplitState>({
    isOpen: false,
    sourceCol: 0,
  });
  const [emailScraping, setEmailScraping] = useState<EmailScrapingState>({
    isOpen: false,
    sourceCol: 0,
    isGenerating: false,
    progress: 0,
    totalRows: 0,
    currentRow: 0,
    retryCount: 0,
    error: null,
    jobId: null,
  });
  const emailScrapingAbortRef = useRef<AbortController | null>(null);
  const [emailValidation, setEmailValidation] = useState<EmailValidationState>({
    isOpen: false,
    sourceCol: 0,
    isValidating: false,
    progress: 0,
    totalRows: 0,
    currentRow: 0,
    error: null,
    jobId: null,
    detectedJob: null,
  });
  const emailValidationAbortRef = useRef<AbortController | null>(null);
  const [dadataEnrichment, setDadataEnrichment] = useState<DadataEnrichmentState>({
    isOpen: false,
    sourceCol: 0,
    mode: 'inn',
    selectedFields: DADATA_DEFAULT_FIELDS,
    isProcessing: false,
    progress: 0,
    totalRows: 0,
    currentRow: 0,
    error: null,
  });
  const dadataAbortRef = useRef<AbortController | null>(null);

  const [fnsEnrichment, setFnsEnrichment] = useState<{
    isOpen: boolean;
    sourceCol: number;
    isProcessing: boolean;
    progress: number;
    totalRows: number;
    currentRow: number;
    found: number;
  }>({
    isOpen: false,
    sourceCol: 0,
    isProcessing: false,
    progress: 0,
    totalRows: 0,
    currentRow: 0,
    found: 0,
  });
  const fnsAbortRef = useRef<AbortController | null>(null);

  const [innLookup, setInnLookup] = useState<{
    isOpen: boolean;
    urlCol: number;
    isProcessing: boolean;
    progress: number;
    totalRows: number;
    currentRow: number;
    found: number;
  }>({
    isOpen: false,
    urlCol: 0,
    isProcessing: false,
    progress: 0,
    totalRows: 0,
    currentRow: 0,
    found: 0,
  });
  const innLookupAbortRef = useRef<AbortController | null>(null);

  const readEnrichmentStorage = useCallback(() => {
    try {
      return readPersistedEnrichment(window.localStorage.getItem(enrichmentStorageKey));
    } catch (error) {
      void logError('spreadsheet.enrichment.state.read_failed', error);
      return { version: ENRICHMENT_STORAGE_VERSION, runs: [] };
    }
  }, [enrichmentStorageKey]);

  const writeEnrichmentStorage = useCallback((state: PersistedEnrichmentState) => {
    try {
      window.localStorage.setItem(enrichmentStorageKey, JSON.stringify(state));
    } catch (error) {
      void logError('spreadsheet.enrichment.state.write_failed', error);
    }
  }, [enrichmentStorageKey]);

  const upsertEnrichmentRun = useCallback((run: PersistedEnrichmentRun) => {
    const current = readEnrichmentStorage();
    const nextRuns = current.runs.filter(
      (existing) => existing.jobId !== run.jobId && existing.tabId !== run.tabId,
    );
    nextRuns.push(run);
    writeEnrichmentStorage({ version: ENRICHMENT_STORAGE_VERSION, runs: nextRuns });
  }, [readEnrichmentStorage, writeEnrichmentStorage]);

  const removeEnrichmentRun = useCallback((jobId: string) => {
    const current = readEnrichmentStorage();
    const nextRuns = current.runs.filter((run) => run.jobId !== jobId);
    writeEnrichmentStorage({ version: ENRICHMENT_STORAGE_VERSION, runs: nextRuns });
  }, [readEnrichmentStorage, writeEnrichmentStorage]);

  const getEnrichmentRunForTab = useCallback((tabId: string) => {
    const current = readEnrichmentStorage();
    return current.runs.find((run) => run.tabId === tabId) ?? null;
  }, [readEnrichmentStorage]);

  const readBriefScoringStorage = useCallback(() => {
    try {
      return readPersistedBriefScoring(window.localStorage.getItem(briefScoringStorageKey));
    } catch (error) {
      void logError('spreadsheet.brief_scoring.state.read_failed', error);
      return { version: BRIEF_SCORING_STORAGE_VERSION, runs: [] };
    }
  }, [briefScoringStorageKey]);

  const writeBriefScoringStorage = useCallback((state: PersistedBriefScoringState) => {
    try {
      window.localStorage.setItem(briefScoringStorageKey, JSON.stringify(state));
    } catch (error) {
      void logError('spreadsheet.brief_scoring.state.write_failed', error);
    }
  }, [briefScoringStorageKey]);

  const upsertBriefScoringRun = useCallback((run: PersistedBriefScoringRun) => {
    const current = readBriefScoringStorage();
    const nextRuns = current.runs.filter(
      (existing) => existing.jobId !== run.jobId && existing.tabId !== run.tabId,
    );
    nextRuns.push(run);
    writeBriefScoringStorage({ version: BRIEF_SCORING_STORAGE_VERSION, runs: nextRuns });
  }, [readBriefScoringStorage, writeBriefScoringStorage]);

  const removeBriefScoringRun = useCallback((jobId: string) => {
    const current = readBriefScoringStorage();
    const nextRuns = current.runs.filter((run) => run.jobId !== jobId);
    writeBriefScoringStorage({ version: BRIEF_SCORING_STORAGE_VERSION, runs: nextRuns });
  }, [readBriefScoringStorage, writeBriefScoringStorage]);

  const getBriefScoringRunForTab = useCallback((tabId: string) => {
    const current = readBriefScoringStorage();
    return current.runs.find((run) => run.tabId === tabId) ?? null;
  }, [readBriefScoringStorage]);

  const getFreshToken = useCallback(async (): Promise<string | null> => {
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.access_token) return session.access_token;
    const { data: refreshed } = await supabase.auth.refreshSession();
    return refreshed.session?.access_token ?? null;
  }, []);

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? tabs[0],
    [tabs, activeTabId],
  );

  const normalizedSelection = useMemo(() => {
    return {
      startRow: Math.min(selection.startRow, selection.endRow),
      endRow: Math.max(selection.startRow, selection.endRow),
      startCol: Math.min(selection.startCol, selection.endCol),
      endCol: Math.max(selection.startCol, selection.endCol),
    };
  }, [selection]);

  const updateScrollMetrics = useCallback(() => {
    const wrapper = tableWrapperRef.current;
    if (!wrapper) return;
    const next = { scrollTop: wrapper.scrollTop, height: wrapper.clientHeight };
    setScrollMetrics((prev) =>
      prev.scrollTop === next.scrollTop && prev.height === next.height ? prev : next,
    );
    setHorizontalScrollLeft((prev) =>
      Math.abs(prev - wrapper.scrollLeft) < 1 ? prev : wrapper.scrollLeft,
    );
    setHorizontalScrollbarMetrics((prev) => {
      const nextWidth = wrapper.scrollWidth;
      const nextClientWidth = wrapper.clientWidth;
      return prev.scrollWidth === nextWidth && prev.clientWidth === nextClientWidth
        ? prev
        : { scrollWidth: nextWidth, clientWidth: nextClientWidth };
    });
    const rect = wrapper.getBoundingClientRect();
    const nextLeft = Math.max(8, Math.round(rect.left));
    const nextWidth = Math.max(0, Math.round(rect.width));
    setFixedScrollbarViewport((prev) =>
      prev.left === nextLeft && prev.width === nextWidth
        ? prev
        : { left: nextLeft, width: nextWidth },
    );
  }, []);

  const handleTableScroll = useCallback(() => {
    if (scrollRafRef.current !== null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      updateScrollMetrics();
    });
  }, [updateScrollMetrics]);

  useEffect(() => {
    updateScrollMetrics();
  }, [updateScrollMetrics, activeTabId]);

  useEffect(() => {
    setEnrichmentTargetOverride(null);
  }, [activeTabId, websiteEnrichment.sourceCol]);

  useEffect(() => {
    const wrapper = tableWrapperRef.current;
    if (!wrapper || typeof ResizeObserver === 'undefined') return;
    const tableElement = tableElementRef.current;
    const observer = new ResizeObserver(() => updateScrollMetrics());
    observer.observe(wrapper);
    if (tableElement) {
      observer.observe(tableElement);
    }
    updateScrollMetrics();
    return () => {
      observer.disconnect();
      if (scrollRafRef.current !== null) {
        cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
    };
  }, [updateScrollMetrics, isHydrated]);

  useEffect(() => {
    const handleViewportUpdate = () => updateScrollMetrics();
    window.addEventListener('resize', handleViewportUpdate);
    window.addEventListener('scroll', handleViewportUpdate, true);
    return () => {
      window.removeEventListener('resize', handleViewportUpdate);
      window.removeEventListener('scroll', handleViewportUpdate, true);
    };
  }, [updateScrollMetrics]);

  const handleToggleWrapCells = () => {
    if (isLargeTable && !forceWrapLarge) {
      requestConfirm(
        'Включить перенос строк?',
        'Для больших таблиц перенос строк может сильно замедлить работу и зависнуть. Рекомендуем оставить как есть.',
        () => {
          setForceWrapLarge(true);
          setWrapCells(true);
        },
        'Включить',
      );
      return;
    }

    if (isLargeTable && forceWrapLarge) {
      setForceWrapLarge(false);
      setWrapCells(false);
      return;
    }

    setWrapCells((prev) => !prev);
  };

  const normalizeOptions = useMemo(
    () => ({
      lower: normalizeLowercase,
      trim: normalizeSpaces,
      removeEmoji: normalizeEmoji,
    }),
    [normalizeLowercase, normalizeSpaces, normalizeEmoji],
  );

  const normalizeSig = useMemo(
    () => `${normalizeOptions.lower ? 1 : 0}${normalizeOptions.trim ? 1 : 0}${normalizeOptions.removeEmoji ? 1 : 0}`,
    [normalizeOptions],
  );

  const normalizedCellCacheRef = useRef(
    new Map<string, { raw: string; sig: string; normalized: string }>(),
  );

  useEffect(() => {
    // Avoid leaking cache across tabs / normalization settings changes
    normalizedCellCacheRef.current.clear();
  }, [activeTabId, normalizeSig]);

  const getNormalizedCell = useCallback(
    (rowIndex: number, colIndex: number, raw: string) => {
      const key = `${activeTabId}:${rowIndex}:${colIndex}`;
      const cached = normalizedCellCacheRef.current.get(key);
      if (cached && cached.raw === raw && cached.sig === normalizeSig) {
        return cached.normalized;
      }
      const normalized = normalizeText(raw, normalizeOptions);
      normalizedCellCacheRef.current.set(key, { raw, sig: normalizeSig, normalized });
      return normalized;
    },
    [activeTabId, normalizeOptions, normalizeSig],
  );

  const searchTerms = useMemo(() => {
    const baseTerms = parseTerms(debouncedSearchQuery);
    if (baseTerms.length === 0) return [];
    const normalizedBase = baseTerms
      .map((term) => normalizeText(term, normalizeOptions))
      .filter((term) => term.length > 0);
    return Array.from(new Set(normalizedBase));
  }, [debouncedSearchQuery, normalizeOptions]);

  const handleUndo = useCallback(() => {
    if (!lastUndo) return;
    setTabs((prev) =>
      prev.map((tab) => (tab.id === lastUndo.tabId ? { ...tab, data: lastUndo.data } : tab)),
    );
    setLastAction({ message: `Вернули: ${lastUndo.message}`, time: Date.now() });
    setLastUndo(null);
  }, [lastUndo]);


  useEffect(() => {
    const handleGlobalKeyDown = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'z' || e.code === 'KeyZ')) {
        e.preventDefault();
        handleUndo();
        return;
      }

      const inCellInput =
        (document.activeElement instanceof HTMLInputElement ||
          document.activeElement instanceof HTMLTextAreaElement) &&
        document.activeElement.closest('td');

      if (
        (document.activeElement instanceof HTMLInputElement ||
          document.activeElement instanceof HTMLTextAreaElement) &&
        !inCellInput
      ) {
        return;
      }

      if (!activeTab) return;

      const { row, col } = activeCell;
      const maxRow = activeTab.data.length - 1;
      const maxCol = (activeTab.data[0]?.length ?? 1) - 1;

      let nextRow = row;
      let nextCol = col;
      let handled = false;

      const isArrow = e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight';

      if (inCellInput && isArrow && !e.shiftKey) return;

      if (e.key === 'ArrowUp') {
        nextRow = Math.max(0, row - 1);
        handled = true;
      } else if (e.key === 'ArrowDown') {
        nextRow = Math.min(maxRow, row + 1);
        handled = true;
      } else if (e.key === 'ArrowLeft') {
        nextCol = Math.max(0, col - 1);
        handled = true;
      } else if (e.key === 'ArrowRight') {
        nextCol = Math.min(maxCol, col + 1);
        handled = true;
      }

      if (handled) {
        e.preventDefault();
        if (e.shiftKey) {
          const anchorRow = selectionAnchor.row;
          const anchorCol = selectionAnchor.col;

          setSelection({
            startRow: Math.min(anchorRow, nextRow),
            endRow: Math.max(anchorRow, nextRow),
            startCol: Math.min(anchorCol, nextCol),
            endCol: Math.max(anchorCol, nextCol),
          });
        } else {
          setSelection({
            startRow: nextRow,
            endRow: nextRow,
            startCol: nextCol,
            endCol: nextCol,
          });
          setSelectionAnchor({ row: nextRow, col: nextCol });
        }

        setActiveCell({ row: nextRow, col: nextCol });
      }
    };

    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [activeTab, activeCell, selectionAnchor, handleUndo]);

  useEffect(() => {
    const handleMouseUp = () => setIsSelecting(false);
    window.addEventListener('mouseup', handleMouseUp);
    return () => window.removeEventListener('mouseup', handleMouseUp);
  }, []);

  useEffect(() => {
    const isMenuEventTarget = (target: EventTarget | null) => (
      target instanceof Node
      && (
        filterMenuRef.current?.contains(target)
        || contextMenuRef.current?.contains(target)
      )
    );
    const handleClose = () => {
      setContextMenu(null);
      setFilterMenu(null);
    };
    const handleWindowClick: EventListener = (event) => {
      if (isMenuEventTarget(event.target)) return;
      handleClose();
    };
    const handleScrollableClose: EventListener = () => {
      handleClose();
    };
    const tableEl = tableWrapperRef.current;
    window.addEventListener('click', handleWindowClick);
    window.addEventListener('scroll', handleScrollableClose);
    tableEl?.addEventListener('scroll', handleScrollableClose);
    window.addEventListener('resize', handleClose);
    return () => {
      window.removeEventListener('click', handleWindowClick);
      window.removeEventListener('scroll', handleScrollableClose);
      tableEl?.removeEventListener('scroll', handleScrollableClose);
      window.removeEventListener('resize', handleClose);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (importTimeoutRef.current) {
        clearTimeout(importTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    return () => {
      if (highlightTimeoutRef.current) {
        clearTimeout(highlightTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    return () => {
      if (copyNoticeTimeoutRef.current) {
        clearTimeout(copyNoticeTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setSelection({ startRow: 0, startCol: 0, endRow: 0, endCol: 0 });
    setSelectionAnchor({ row: 0, col: 0 });
    setActiveCell({ row: 0, col: 0 });
    setSelectionMode('cell');
    setColumnFilters({});
    setSelectedRows(new Set());
  }, [activeTabId]);

  useEffect(() => {
    if (!isResizing) return;
    const handleMove = (event: globalThis.MouseEvent) => {
      const info = resizingRef.current;
      if (!info) return;
      const nextWidth = Math.max(
        MIN_COLUMN_WIDTH,
        info.startWidth + (event.clientX - info.startX),
      );
      setColumnWidths((prev) => {
        const next = [...prev];
        next[info.col] = nextWidth;
        return next;
      });
    };
    const handleUp = () => {
      setIsResizing(false);
      resizingRef.current = null;
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [isResizing]);

  const updateActiveSheet = (updater: (sheet: Sheet) => Sheet) => {
    setTabs((prev) => prev.map((tab) => (tab.id === activeTabId ? updater(tab) : tab)));
  };

  const showCopyNotice = useCallback((message: string, tone: CopyNotice['tone']) => {
    const now = Date.now();
    setLastAction({ message, time: now });
    setCopyNotice({ message, tone });
    if (copyNoticeTimeoutRef.current) {
      clearTimeout(copyNoticeTimeoutRef.current);
    }
    copyNoticeTimeoutRef.current = setTimeout(() => {
      setCopyNotice(null);
    }, COPY_NOTICE_DURATION_MS);
  }, []);

  const ensureSize = (data: string[][], rows: number, cols: number) => {
    const targetRows = Math.max(rows, data.length);
    const targetCols = Math.max(cols, data[0]?.length ?? 0);
    return Array.from({ length: targetRows }, (_, rowIndex) => {
      const row = data[rowIndex] ?? [];
      return Array.from({ length: targetCols }, (_, colIndex) => row[colIndex] ?? '');
    });
  };

  const handleAddRow = () => {
    if (!activeTab) return;
    updateActiveSheet((sheet) => ({
      ...sheet,
      data: [...sheet.data, Array.from({ length: sheet.data[0]?.length ?? DEFAULT_COLS }, () => '')],
    }));
  };

  const handleAddColumn = () => {
    if (!activeTab) return;
    updateActiveSheet((sheet) => ({
      ...sheet,
      data: sheet.data.map((row) => [...row, '']),
    }));
  };

  const handleInsertRowAbove = (rowIndex: number) => {
    if (!activeTab) return;
    setUndoSnapshot('Вставка строки выше');
    updateActiveSheet((sheet) => {
      const colLen = sheet.data[0]?.length ?? DEFAULT_COLS;
      const newRow = Array.from({ length: colLen }, () => '');
      const nextData = [...sheet.data];
      nextData.splice(rowIndex, 0, newRow);
      return { ...sheet, data: nextData };
    });
    setLastAction({ message: `Строка добавлена выше (${rowIndex + 1})`, time: Date.now() });
  };

  const handleInsertRowBelow = (rowIndex: number) => {
    if (!activeTab) return;
    setUndoSnapshot('Вставка строки ниже');
    updateActiveSheet((sheet) => {
      const colLen = sheet.data[0]?.length ?? DEFAULT_COLS;
      const newRow = Array.from({ length: colLen }, () => '');
      const nextData = [...sheet.data];
      nextData.splice(rowIndex + 1, 0, newRow);
      return { ...sheet, data: nextData };
    });
    setLastAction({ message: `Строка добавлена ниже (${rowIndex + 1})`, time: Date.now() });
  };

  const copyEntireTable = async () => {
    if (!activeTab) return;
    const indicesToCopy = hasActiveFilters ? [0, ...visibleRowIndices] : activeTab.data.map((_, i) => i);
    const rows = indicesToCopy.map((i) => (activeTab.data[i] ?? []).map((cell) => `${cell ?? ''}`));
    const cols = activeTab.data[0]?.length ?? 0;
    if (rows.length === 0 || cols === 0) {
      showCopyNotice('Нет данных для копирования', 'error');
      return;
    }
    const text = buildClipboardTsv(rows);
    try {
      await writeTextToClipboard(text);
      const label = hasActiveFilters ? ` (фильтр: ${rows.length} из ${activeTab.data.length})` : '';
      showCopyNotice(buildCopySummary(rows.length, cols) + label, 'success');
    } catch (error) {
      void logError('spreadsheet.copy_all.failed', error);
      showCopyNotice('Не удалось скопировать таблицу в буфер обмена', 'error');
    }
  };

  // --- Column drag reorder ---
  const handleColDragStart = (e: DragEvent<HTMLTableCellElement>, colIndex: number) => {
    setDragCol(colIndex);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(colIndex));
  };

  const handleColDragOver = (e: DragEvent<HTMLTableCellElement>, colIndex: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragCol !== null && dragCol !== colIndex) {
      setDragOverCol(colIndex);
    }
  };

  const handleColDrop = (e: DragEvent<HTMLTableCellElement>, targetCol: number) => {
    e.preventDefault();
    if (dragCol === null || dragCol === targetCol || !activeTab) {
      setDragCol(null);
      setDragOverCol(null);
      return;
    }
    setUndoSnapshot('Перемещение колонки');
    const srcCol = dragCol;
    updateActiveSheet((sheet) => {
      const nextData = sheet.data.map((row) => {
        const newRow = [...row];
        const [moved] = newRow.splice(srcCol, 1);
        newRow.splice(targetCol, 0, moved);
        return newRow;
      });
      return { ...sheet, data: nextData };
    });
    setColumnWidths((prev) => {
      if (prev.length === 0) return prev;
      const next = [...prev];
      const [movedW] = next.splice(srcCol, 1);
      next.splice(targetCol, 0, movedW);
      return next;
    });
    setDragCol(null);
    setDragOverCol(null);
    setLastAction({ message: 'Колонка перемещена', time: Date.now() });
  };

  const handleColDragEnd = () => {
    setDragCol(null);
    setDragOverCol(null);
  };

  // --- Row drag reorder ---
  const handleRowDragStart = (e: DragEvent<HTMLTableCellElement>, rowIndex: number) => {
    if (rowIndex === 0) { e.preventDefault(); return; }
    setDragRow(rowIndex);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(rowIndex));
  };

  const handleRowDragOver = (e: DragEvent<HTMLTableCellElement>, rowIndex: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragRow !== null && dragRow !== rowIndex && rowIndex !== 0) {
      setDragOverRow(rowIndex);
    }
  };

  const handleRowDrop = (e: DragEvent<HTMLTableCellElement>, targetRow: number) => {
    e.preventDefault();
    if (dragRow === null || dragRow === targetRow || targetRow === 0 || !activeTab) {
      setDragRow(null);
      setDragOverRow(null);
      return;
    }
    setUndoSnapshot('Перемещение строки');
    const srcRow = dragRow;
    updateActiveSheet((sheet) => {
      const nextData = [...sheet.data];
      const [moved] = nextData.splice(srcRow, 1);
      nextData.splice(targetRow, 0, moved);
      return { ...sheet, data: nextData };
    });
    setDragRow(null);
    setDragOverRow(null);
    setLastAction({ message: 'Строка перемещена', time: Date.now() });
  };

  const handleRowDragEnd = () => {
    setDragRow(null);
    setDragOverRow(null);
  };

  const handleAddTab = () => {
    if (!activeTab) return;
    const nextNumber = tabCounter + 1;
    setTabCounter(nextNumber);
    const newTab = createSheet(
      `Вкладка ${nextNumber}`,
      activeTab.data.length,
      activeTab.data[0]?.length ?? DEFAULT_COLS,
    );
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newTab.id);
  };

  const handleRemoveTab = (id: string) => {
    if (tabs.length === 1) return;
    const nextTabs = tabs.filter((tab) => tab.id !== id);
    setTabs(nextTabs);
    if (activeTabId === id) {
      setActiveTabId(nextTabs[0]?.id ?? '');
    }
  };

  const startEditingTab = (tab: Sheet) => {
    setEditingTabId(tab.id);
    setEditingTabName(tab.name);
  };

  const commitTabName = () => {
    if (!editingTabId) return;
    const trimmed = editingTabName.trim();
    if (trimmed.length === 0) {
      setEditingTabId(null);
      setEditingTabName('');
      return;
    }
    setTabs((prev) =>
      prev.map((tab) => (tab.id === editingTabId ? { ...tab, name: trimmed } : tab)),
    );
    setEditingTabId(null);
    setEditingTabName('');
  };

  const cancelTabEdit = () => {
    setEditingTabId(null);
    setEditingTabName('');
  };

  const handleRowHeaderClick = (rowIndex: number, isShift: boolean, isCtrl = false) => {
    const lastCol = Math.max((activeTab?.data[0]?.length ?? 0) - 1, 0);
    if (isCtrl && selectionMode === 'row') {
      const cur = normalizedSelection;
      setSelection({
        startRow: Math.min(cur.startRow, rowIndex),
        endRow: Math.max(cur.endRow, rowIndex),
        startCol: 0,
        endCol: lastCol,
      });
    } else {
      const anchorRow = isShift ? selectionAnchor.row : rowIndex;
      setSelection({ startRow: anchorRow, endRow: rowIndex, startCol: 0, endCol: lastCol });
      if (!isShift) setSelectionAnchor({ row: rowIndex, col: 0 });
    }
    setActiveCell({ row: rowIndex, col: 0 });
    setSelectionMode('row');
    tableWrapperRef.current?.focus();
  };

  const handleColumnHeaderClick = (colIndex: number, isShift: boolean, isCtrl = false) => {
    const lastRow = Math.max((activeTab?.data.length ?? 0) - 1, 0);
    if (isCtrl && selectionMode === 'col') {
      const cur = normalizedSelection;
      setSelection({
        startRow: 0,
        endRow: lastRow,
        startCol: Math.min(cur.startCol, colIndex),
        endCol: Math.max(cur.endCol, colIndex),
      });
    } else {
      const anchorCol = isShift ? selectionAnchor.col : colIndex;
      setSelection({ startRow: 0, endRow: lastRow, startCol: anchorCol, endCol: colIndex });
      if (!isShift) setSelectionAnchor({ row: 0, col: colIndex });
    }
    setActiveCell({ row: 0, col: colIndex });
    setSelectionMode('col');
    tableWrapperRef.current?.focus();
  };

  const openContextMenu = (event: MouseEvent, mode: SelectionMode) => {
    event.preventDefault();
    event.stopPropagation();
    setSelectionMode(mode);
    setFilterMenu(null);
    setContextMenu({ x: event.clientX, y: event.clientY });
  };

  const startColumnResize = (event: MouseEvent, colIndex: number) => {
    event.preventDefault();
    event.stopPropagation();
    const currentWidth = columnWidths[colIndex] ?? DEFAULT_COLUMN_WIDTH;
    resizingRef.current = { col: colIndex, startX: event.clientX, startWidth: currentWidth };
    setIsResizing(true);
  };

  const handleCellMouseDown = (
    row: number,
    col: number,
    event: MouseEvent<HTMLTableCellElement>,
  ) => {
    if (event.button !== 0) return;
    setIsSelecting(true);
    setActiveCell({ row, col });
    if (event.shiftKey) {
      const maxRow = Math.max((activeTab?.data.length ?? 1) - 1, 0);
      const maxCol = Math.max((activeTab?.data[0]?.length ?? 1) - 1, 0);
      const anchorRow = Math.min(Math.max(selectionAnchor.row, 0), maxRow);
      const anchorCol = Math.min(Math.max(selectionAnchor.col, 0), maxCol);
      setSelection({
        startRow: anchorRow,
        startCol: anchorCol,
        endRow: row,
        endCol: col,
      });
    } else if (event.ctrlKey || event.metaKey) {
      setSelection((prev) => ({ ...prev, endRow: row, endCol: col }));
    } else {
      setSelection({ startRow: row, startCol: col, endRow: row, endCol: col });
      setSelectionAnchor({ row, col });
    }
    setSelectionMode('cell');
  };

  const handleCellMouseOver = (row: number, col: number) => {
    if (!isSelecting) return;
    setSelection((prev) => ({ ...prev, endRow: row, endCol: col }));
  };

  const handleCellFocus = (row: number, col: number) => {
    setActiveCell({ row, col });
    setSelection({ startRow: row, startCol: col, endRow: row, endCol: col });
    setSelectionAnchor({ row, col });
    setSelectionMode('cell');
  };

  const handleValueChange = (row: number, col: number, value: string) => {
    updateActiveSheet((sheet) => {
      const nextData = [...sheet.data];
      if (!nextData[row]) return sheet;
      nextData[row] = [...nextData[row]];
      nextData[row][col] = value;
      return { ...sheet, data: nextData };
    });
  };

  const copySelection = async () => {
    if (!activeTab) return;
    const { startRow, endRow, startCol, endCol } = normalizedSelection;
    const visibleSet = hasActiveFilters ? new Set(allRowIndices) : null;
    const values: string[][] = [];
    for (let r = startRow; r <= endRow; r += 1) {
      if (visibleSet && !visibleSet.has(r)) continue;
      const row = activeTab.data[r] ?? [];
      const cells: string[] = [];
      for (let c = startCol; c <= endCol; c += 1) {
        cells.push(row[c] ?? '');
      }
      values.push(cells);
    }
    const text = buildClipboardTsv(values);
    const cols = endCol - startCol + 1;
    try {
      await writeTextToClipboard(text);
      showCopyNotice(buildCopySummary(values.length, cols), 'success');
    } catch (error) {
      void logError('spreadsheet.copy.failed', error);
      showCopyNotice('Не удалось скопировать выделение в буфер обмена', 'error');
    }
  };

  const applyPaste = (values: string[][]) => {
    if (!activeTab || values.length === 0) return;
    const maxCols = safeMaxCols(values);

    const { startRow, startCol } = normalizedSelection;

    updateActiveSheet((sheet) => {
      const expanded = ensureSize(sheet.data, startRow + values.length, startCol + maxCols);
      for (let r = 0; r < values.length; r += 1) {
        for (let c = 0; c < values[r].length; c += 1) {
          expanded[startRow + r][startCol + c] = values[r][c];
        }
      }
      return { ...sheet, data: expanded };
    });

    setSelection({
      startRow,
      startCol,
      endRow: startRow + values.length - 1,
      endCol: startCol + maxCols - 1,
    });
    setActiveCell({ row: startRow, col: startCol });
    setSelectionMode('cell');
  };

  const applyRows = (nextRows: string[][]) => {
    const normalized = normalizeRows(trimTrailingEmptyRows(nextRows));
    updateActiveSheet((sheet) => ({
      ...sheet,
      data:
        normalized.length > 0
          ? normalized
          : [Array.from({ length: sheet.data[0]?.length ?? 1 }, () => '')],
    }));
    setSelection({ startRow: 0, startCol: 0, endRow: 0, endCol: 0 });
    setSelectionAnchor({ row: 0, col: 0 });
    setActiveCell({ row: 0, col: 0 });
    setSelectionMode('cell');
  };

  const applyNormalizationToData = () => {
    if (!activeTab) return;
    const changed = activeTab.data.length;
    setUndoSnapshot(`Нормализация (${changed} строк)`);
    updateActiveSheet((sheet) => {
      const nextData = sheet.data.map((row) =>
        row.map((cell) => normalizeText(cell, normalizeOptions)),
      );
      return { ...sheet, data: nextData };
    });
    setLastAction({ message: `Нормализация применена к ${changed} строкам`, time: Date.now() });
  };

  const applyRowsToNewTab = useCallback((nextRows: string[][], filename?: string) => {
    const normalized = normalizeRows(trimTrailingEmptyRows(nextRows));
    const fallbackName = `Вкладка ${tabCounter + 1}`;
    const baseName = filename ? getBaseFilename(filename) : '';
    const tabName = baseName.length > 0 ? baseName : fallbackName;
    if (baseName.length === 0) {
      setTabCounter((prev) => prev + 1);
    }
    const colCount = normalized[0]?.length ?? DEFAULT_COLS;
    const data = normalized.length > 0 ? normalized : [Array.from({ length: colCount }, () => '')];
    const newTab: Sheet = {
      id: createId(),
      name: tabName,
      data,
    };
    startTransition(() => {
      setTabs((prev) => [...prev, newTab]);
      setActiveTabId(newTab.id);
    });
  }, [tabCounter]);

  useEffect(() => {
    if (!isHydrated) return;
    if (!importId) return;
    if (importHandledRef.current === importId) return;
    importHandledRef.current = importId;

    const cleanUrl = () => {
      try {
        window.history.replaceState(null, '', window.location.pathname);
      } catch {
        // ignore
      }
    };

    try {
      const payload = readPendingDbImport(importId);
      if (!payload) {
        showCopyNotice('Импорт не найден (возможно, устарел или был очищен браузером)', 'error');
        cleanUrl();
        return;
      }

      const MAX_ROWS = 10_000;
      const MAX_COLS = 80;

      const rawRows = Array.isArray(payload.rows) ? payload.rows : [];
      const limitedRows = rawRows.slice(0, MAX_ROWS).map((row) => {
        const cells = Array.isArray(row) ? row : [];
        return cells.slice(0, MAX_COLS).map((cell) => String(cell ?? ''));
      });

      if (limitedRows.length === 0) {
        showCopyNotice('Импорт пустой (0 строк)', 'error');
        deletePendingDbImport(importId);
        cleanUrl();
        return;
      }

      applyRowsToNewTab(limitedRows, `${payload.title || 'import'}.csv`);
      const trimmed = limitedRows.length < rawRows.length;
      showCopyNotice(
        trimmed
          ? `Импортировано: ${limitedRows.length} строк (обрезано до лимита)`
          : `Импортировано: ${limitedRows.length} строк`,
        'success',
      );

      deletePendingDbImport(importId);
      cleanUrl();
    } catch (e) {
      showCopyNotice(e instanceof Error ? e.message : 'Ошибка импорта', 'error');
      cleanUrl();
    }
  }, [importId, isHydrated, applyRowsToNewTab, showCopyNotice]);

  const finalizeImport = (status: ImportStatus['status'], filename?: string, message?: string) => {
    const progress = status === 'done' ? 100 : 0;
    setImportStatus({ status, progress, filename, message });
    if (importTimeoutRef.current) {
      clearTimeout(importTimeoutRef.current);
    }
    importTimeoutRef.current = setTimeout(() => {
      setImportStatus({ status: 'idle', progress: 0 });
    }, status === 'done' ? 1500 : 4000);
  };

  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const handleImportFile = async (file: File) => {
    const extension = file.name.split('.').pop()?.toLowerCase();
    lastProgressRef.current = 0;
    setImportStatus({ status: 'reading', progress: 0, filename: file.name });
    try {
      if (extension === 'csv') {
        const rows: string[][] = [];
        setImportStatus({ status: 'parsing', progress: 0, filename: file.name });
        await new Promise<void>((resolve, reject) => {
          Papa.parse<string[]>(file, {
            skipEmptyLines: false,
            worker: true,
            chunk: (results) => {
              const chunkRows = results.data.map((row) => row.map((cell) => `${cell ?? ''}`));
              rows.push(...chunkRows);
              const cursor = results.meta?.cursor ?? 0;
              if (cursor && file.size) {
                const nextProgress = Math.min(99, Math.round((cursor / file.size) * 100));
                if (nextProgress - lastProgressRef.current >= 1) {
                  lastProgressRef.current = nextProgress;
                  setImportStatus({ status: 'parsing', progress: nextProgress, filename: file.name });
                }
              }
            },
            complete: () => resolve(),
            error: (error) => reject(error),
          });
        });
        applyRowsToNewTab(rows, file.name);
        finalizeImport('done', file.name);
        return;
      }

      const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader();
        reader.onprogress = (event) => {
          if (!event.lengthComputable) return;
          const progress = Math.min(80, Math.round((event.loaded / event.total) * 80));
          if (progress - lastProgressRef.current >= 1) {
            lastProgressRef.current = progress;
            setImportStatus({ status: 'reading', progress, filename: file.name });
          }
        };
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(file);
      });
      setImportStatus({ status: 'parsing', progress: 85, filename: file.name });

      const workerRows = await parseXlsxInWorker(buffer);
      if (workerRows) {
        setImportStatus({ status: 'parsing', progress: 95, filename: file.name });
        applyRowsToNewTab(workerRows, file.name);
        finalizeImport('done', file.name);
      } else {
        const workbook = XLSX.read(buffer, { type: 'array' });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json<string[]>(sheet, {
          header: 1,
          raw: false,
          blankrows: true,
        });
        const normalizedRows = rows.map((row) => row.map((cell) => `${cell ?? ''}`));
        setImportStatus({ status: 'parsing', progress: 95, filename: file.name });
        applyRowsToNewTab(normalizedRows, file.name);
        finalizeImport('done', file.name);
      }
    } catch (error) {
      void logError('spreadsheet.import.failed', error, { fileName: file.name });
      finalizeImport('error', file.name, 'Не удалось импортировать файл');
    }
  };

  const handleExportCsv = () => {
    if (!activeTab) return;
    const csv = Papa.unparse(activeTab.data);
    const filename = `${activeTab.name || 'таблица'}.csv`;
    downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), filename);
  };

  const handleExportXlsx = () => {
    if (!activeTab) return;
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet(activeTab.data);
    XLSX.utils.book_append_sheet(workbook, sheet, activeTab.name || 'Sheet1');
    const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
    const filename = `${activeTab.name || 'таблица'}.xlsx`;
    downloadBlob(
      new Blob([buffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
      filename,
    );
  };

  const filterEntries = useMemo(
    () =>
      Object.entries(columnFilters).map(([key, values]) => ({
        col: Number(key),
        values: new Set(values),
      })),
    [columnFilters],
  );

  const rowMatchesFilters = useCallback(
    (rowIndex: number, row: string[], excludeCol?: number) => {
      if (rowIndex === 0) return true;
      for (const entry of filterEntries) {
        if (excludeCol !== undefined && entry.col === excludeCol) continue;
        if (entry.values.size === 0) return false;
        const cellKey = normalizeCellKey(row[entry.col] ?? '');
        if (!entry.values.has(cellKey)) return false;
      }
      if (searchOnlyMatches && searchTerms.length > 0) {
        let normalizedRow = '';
        for (let c = 0; c < row.length; c += 1) {
          const raw = row[c] ?? '';
          const normalizedCell = getNormalizedCell(rowIndex, c, raw);
          if (normalizedCell) normalizedRow += `${normalizedCell} `;
        }
        const matches = searchTerms.some((term) => normalizedRow.includes(term));
        if (!matches) return false;
      }
      return true;
    },
    [filterEntries, getNormalizedCell, searchOnlyMatches, searchTerms],
  );

  const openFilterMenu = (event: MouseEvent, colIndex: number) => {
    event.preventDefault();
    event.stopPropagation();
    if (!activeTab) return;
    const { options, overflow } = buildFilterOptions(activeTab.data, colIndex);
    setFilterMenu({
      col: colIndex,
      x: event.clientX,
      y: event.clientY,
      options,
      overflow,
      search: '',
    });
    setContextMenu(null);
  };

  const getSelectedKeys = (colIndex: number, options: FilterOption[]) => {
    const stored = columnFilters[colIndex];
    if (!stored) return new Set(options.map((option) => option.key));
    return new Set(stored);
  };

  const setFilterForColumn = (colIndex: number, keys: string[], options: FilterOption[]) => {
    setColumnFilters((prev) => {
      if (keys.length === options.length) {
        const next = { ...prev };
        delete next[colIndex];
        return next;
      }
      return { ...prev, [colIndex]: keys };
    });
  };

  const toggleFilterOption = (colIndex: number, key: string, options: FilterOption[]) => {
    const selected = getSelectedKeys(colIndex, options);
    if (selected.has(key)) {
      selected.delete(key);
    } else {
      selected.add(key);
    }
    setFilterForColumn(colIndex, Array.from(selected), options);
  };

  const resetFilter = (colIndex: number) => {
    setColumnFilters((prev) => {
      const next = { ...prev };
      delete next[colIndex];
      return next;
    });
  };

  const clearFilter = (colIndex: number) => {
    setColumnFilters((prev) => ({ ...prev, [colIndex]: [] }));
  };

  const getColumnWidth = (colIndex: number) =>
    columnWidths[colIndex] ?? DEFAULT_COLUMN_WIDTH;

  const toggleRowSelection = (rowIndex: number) => {
    if (rowIndex === 0) return;
    setSelectedRows((prev) => {
      const next = new Set(prev);
      if (next.has(rowIndex)) {
        next.delete(rowIndex);
      } else {
        next.add(rowIndex);
      }
      return next;
    });
  };

  const toggleSelectAllVisible = () => {
    if (allVisibleSelected) {
      setSelectedRows(new Set());
      return;
    }
    setSelectedRows(new Set(visibleRowIndices));
  };

  const removeSelectedRowsByCheckbox = () => {
    if (!activeTab || selectedRows.size === 0) return;
    updateActiveSheet((sheet) => {
      const nextData = sheet.data.filter((_, index) =>
        index === 0 ? true : !selectedRows.has(index),
      );
      if (nextData.length === 0) {
        const colCount = sheet.data[0]?.length ?? DEFAULT_COLS;
        return { ...sheet, data: [Array.from({ length: colCount }, () => '')] };
      }
      return { ...sheet, data: nextData };
    });
    setSelectedRows(new Set());
  };

  const confirmRemoveSelectedRows = () => {
    if (selectedRows.size === 0) return;
    const count = selectedRows.size;
    requestConfirm(
      'Удалить выбранные строки?',
      `Будет удалено строк: ${count}.`,
      () => {
        setUndoSnapshot(`Удаление выбранных строк (${count})`);
        removeSelectedRowsByCheckbox();
        setLastAction({ message: `Удалено выбранных строк: ${count}`, time: Date.now() });
      },
      'Удалить',
    );
  };

  const applyGroupFilter = (key: string) => {
    if (groupByCol === null) return;
    setColumnFilters((prev) => ({ ...prev, [groupByCol]: [key] }));
  };

  const handleRemoveDuplicates = () => {
    if (!activeTab) return;
    flushSave();
    const data = activeTab.data;
    const header = hasHeaderRow(data) ? data[0] : null;
    const body = header ? data.slice(1) : data;
    const seen = new Set<string>();
    const nextRows: string[][] = [];

    for (const row of body) {
      const key = row.join('\u0001');
      if (seen.has(key)) continue;
      seen.add(key);
      nextRows.push(row);
    }

    const removed = body.length - nextRows.length;
    if (removed === 0) {
      setLastAction({ message: 'Полных дубликатов не найдено', time: Date.now() });
      return;
    }

    requestConfirm(
      'Удалить полные дубликаты?',
      `Будет удалено строк: ${removed} (было ${body.length}, станет ${nextRows.length}).`,
      () => {
        setUndoSnapshot(`Удаление дубликатов (${removed})`);
        applyRows(header ? [header, ...nextRows] : nextRows);
        setLastAction({
          message: `Удалено строк: ${removed} (было ${body.length}, стало ${nextRows.length})`,
          time: Date.now(),
        });
      },
      'Удалить',
    );
  };

  const handleRemoveDuplicatesByEmail = (selectedCol?: number) => {
    if (!activeTab) return;
    flushSave();
    const data = activeTab.data;
    const header = hasHeaderRow(data) ? data[0] : null;
    const body = header ? data.slice(1) : data;
    const emailColumns = selectedCol !== undefined ? [selectedCol] : detectEmailColumns(data);

    const emailMap = new Map<string, { row: string[]; score: number }>();
    const rowsWithoutEmail: string[][] = [];

    for (const row of body) {
      const email = getRowEmail(row, emailColumns);
      if (!email) {
        rowsWithoutEmail.push(row);
        continue;
      }
      const score = countFilledCells(row);
      const existing = emailMap.get(email);
      if (!existing || score > existing.score) {
        emailMap.set(email, { row, score });
      }
    }

    const nextRows = [...emailMap.values().map((item) => item.row), ...rowsWithoutEmail];
    const removed = body.length - nextRows.length;
    if (removed === 0) {
      setLastAction({ message: 'Дубликатов по почте не найдено', time: Date.now() });
      return;
    }

    requestConfirm(
      'Удалить дубликаты по почте?',
      `Будет удалено строк: ${removed} (было ${body.length}, станет ${nextRows.length}).`,
      () => {
        setUndoSnapshot(`Удаление дублей по почте (${removed})`);
        applyRows(header ? [header, ...nextRows] : nextRows);
        setLastAction({
          message: `Удалено строк по почте: ${removed} (было ${body.length}, стало ${nextRows.length})`,
          time: Date.now(),
        });
      },
      'Удалить',
    );
  };

  const handleRemoveDuplicatesByCompanyName = (selectedCol: number) => {
    if (!activeTab) return;
    flushSave();
    const data = activeTab.data;
    const header = hasHeaderRow(data) ? data[0] : null;
    const body = header ? data.slice(1) : data;

    const nameMap = new Map<string, { row: string[]; score: number }>();
    const rowsWithoutName: string[][] = [];

    for (const row of body) {
      const raw = (row[selectedCol] ?? '').trim().toLowerCase();
      if (!raw) {
        rowsWithoutName.push(row);
        continue;
      }
      const score = countFilledCells(row);
      const existing = nameMap.get(raw);
      if (!existing || score > existing.score) {
        nameMap.set(raw, { row, score });
      }
    }

    const nextRows = [...nameMap.values().map((item) => item.row), ...rowsWithoutName];
    const removed = body.length - nextRows.length;
    if (removed === 0) {
      setLastAction({ message: 'Дубликатов по названию компании не найдено', time: Date.now() });
      return;
    }

    requestConfirm(
      'Удалить дубликаты по названию компании?',
      `Будет удалено строк: ${removed} (было ${body.length}, станет ${nextRows.length}). Для каждой компании останется строка с наибольшим количеством заполненных ячеек.`,
      () => {
        setUndoSnapshot(`Удаление дублей по компании (${removed})`);
        applyRows(header ? [header, ...nextRows] : nextRows);
        setLastAction({
          message: `Удалено строк по компании: ${removed} (было ${body.length}, стало ${nextRows.length})`,
          time: Date.now(),
        });
      },
      'Удалить',
    );
  };

  const handleRemoveEmptyRows = () => {
    if (!activeTab) return;
    flushSave();
    const data = activeTab.data;
    const header = data[0] ?? [];
    const body = data.slice(1);
    const nextBody = body.filter((row) => !isRowEmpty(row));
    const removed = body.length - nextBody.length;

    if (removed === 0) {
      setLastAction({ message: 'Пустые строки не найдены', time: Date.now() });
      return;
    }

    requestConfirm(
      'Удалить пустые строки?',
      `Будет удалено строк: ${removed}.`,
      () => {
        setUndoSnapshot(`Удаление пустых строк (${removed})`);
        applyRows([header, ...nextBody]);
        setLastAction({ message: `Удалено пустых строк: ${removed}`, time: Date.now() });
      },
      'Удалить',
    );
  };

  const handleRemoveEmptyColumns = () => {
    if (!activeTab) return;
    const data = activeTab.data;
    const maxCols = safeMaxCols(data);
    const hasValue = Array.from({ length: maxCols }, () => false);

    for (const row of data) {
      for (let c = 0; c < maxCols; c += 1) {
        if ((row[c] ?? '').trim().length > 0) {
          hasValue[c] = true;
        }
      }
    }

    const keepCols = hasValue
      .map((value, index) => (value ? index : -1))
      .filter((index) => index >= 0);

    const removed = maxCols - keepCols.length;
    if (removed === 0) {
      setLastAction({ message: 'Пустые колонки не найдены', time: Date.now() });
      return;
    }

    requestConfirm(
      'Удалить пустые колонки?',
      `Будет удалено колонок: ${removed}.`,
      () => {
        setUndoSnapshot(`Удаление пустых колонок (${removed})`);
        const nextRows = data.map((row) =>
          keepCols.length > 0 ? keepCols.map((idx) => row[idx] ?? '') : [''],
        );
        applyRows(nextRows);
        setColumnWidths(() =>
          keepCols.length > 0
            ? keepCols.map((idx) => columnWidths[idx] ?? DEFAULT_COLUMN_WIDTH)
            : [DEFAULT_COLUMN_WIDTH],
        );
        setLastAction({ message: `Удалено пустых колонок: ${removed}`, time: Date.now() });
      },
      'Удалить',
    );
  };

  const handleCleanInvisibleWhitespace = () => {
    if (!activeTab) return;
    const data = activeTab.data;
    const emailColumns = detectEmailColumns(data);

    let changedCells = 0;
    let changedRows = 0;

    const nextData = data.map((row, rowIndex) => {
      let rowChanged = false;
      const nextRow = row.map((cell, colIndex) => {
        const raw = cell ?? '';
        const isEmailField = rowIndex > 0 && emailColumns.includes(colIndex);
        const sanitized = sanitizeCellWhitespaceForExport(raw, isEmailField);
        if (sanitized !== raw) {
          changedCells += 1;
          rowChanged = true;
        }
        return sanitized;
      });
      if (rowChanged) changedRows += 1;
      return nextRow;
    });

    if (changedCells === 0) {
      setLastAction({ message: 'Невидимые символы и лишние пробелы не найдены', time: Date.now() });
      return;
    }

    const emailHint = emailColumns.length > 0
      ? ` Email-колонок найдено: ${emailColumns.length}.`
      : '';

    requestConfirm(
      'Очистить невидимые символы?',
      `Будет обновлено ячеек: ${changedCells} (строк: ${changedRows}).${emailHint}`,
      () => {
        setUndoSnapshot(`Очистка whitespace (${changedCells} ячеек)`);
        updateActiveSheet((sheet) => ({
          ...sheet,
          data: nextData,
        }));
        setLastAction({
          message: `Очистка whitespace: ${changedCells} ячеек в ${changedRows} строках`,
          time: Date.now(),
        });
      },
      'Очистить',
    );
  };

  const clearSelectedCells = () => {
    if (!activeTab) return;
    const { startRow, endRow, startCol, endCol } = normalizedSelection;
    updateActiveSheet((sheet) => {
      const nextData = sheet.data.map((row, rowIndex) => {
        if (rowIndex < startRow || rowIndex > endRow) return row;
        const nextRow = [...row];
        for (let c = startCol; c <= endCol; c += 1) {
          nextRow[c] = '';
        }
        return nextRow;
      });
      return { ...sheet, data: nextData };
    });
  };

  const removeSelectedRows = () => {
    if (!activeTab) return;
    const { startRow, endRow } = normalizedSelection;
    updateActiveSheet((sheet) => {
      const remaining = sheet.data.filter((_, idx) => idx < startRow || idx > endRow);
      const colCount = sheet.data[0]?.length ?? DEFAULT_COLS;
      const data = remaining.length > 0 ? remaining : [Array.from({ length: colCount }, () => '')];
      return { ...sheet, data };
    });
    setSelection({ startRow: 0, startCol: 0, endRow: 0, endCol: 0 });
    setSelectionAnchor({ row: 0, col: 0 });
    setActiveCell({ row: 0, col: 0 });
    setSelectionMode('cell');
  };

  const removeSelectedColumns = () => {
    if (!activeTab) return;
    const { startCol, endCol } = normalizedSelection;
    const scrollLeft = tableWrapperRef.current?.scrollLeft ?? 0;
    updateActiveSheet((sheet) => {
      const nextData = sheet.data.map((row) => {
        const filtered = row.filter((_, idx) => idx < startCol || idx > endCol);
        return filtered.length > 0 ? filtered : [''];
      });
      return { ...sheet, data: nextData };
    });
    setColumnWidths((prev) => {
      if (prev.length === 0) return prev;
      return prev.filter((_, idx) => idx < startCol || idx > endCol);
    });
    const newColCount = (activeTab.data[0]?.length ?? 1) - (endCol - startCol + 1);
    const clampedCol = Math.min(startCol, Math.max(0, newColCount - 1));
    setSelection({ startRow: 0, startCol: clampedCol, endRow: 0, endCol: clampedCol });
    setSelectionAnchor({ row: 0, col: clampedCol });
    setActiveCell({ row: 0, col: clampedCol });
    setSelectionMode('cell');
    requestAnimationFrame(() => {
      if (tableWrapperRef.current) tableWrapperRef.current.scrollLeft = scrollLeft;
    });
  };

  const confirmDeleteSelection = () => {
    if (!activeTab) return;
    const rowsCount = normalizedSelection.endRow - normalizedSelection.startRow + 1;
    const colsCount = normalizedSelection.endCol - normalizedSelection.startCol + 1;
    const cellCount = rowsCount * colsCount;

    if (selectionMode === 'row') {
      requestConfirm(
        'Удалить строки?',
        `Будет удалено строк: ${rowsCount}.`,
        () => {
          setUndoSnapshot(`Удаление строк (${rowsCount})`);
          removeSelectedRows();
          setLastAction({ message: `Удалено строк: ${rowsCount}`, time: Date.now() });
        },
        'Удалить',
      );
      return;
    }

    if (selectionMode === 'col') {
      requestConfirm(
        'Удалить колонки?',
        `Будет удалено колонок: ${colsCount}.`,
        () => {
          setUndoSnapshot(`Удаление колонок (${colsCount})`);
          removeSelectedColumns();
          setLastAction({ message: `Удалено колонок: ${colsCount}`, time: Date.now() });
        },
        'Удалить',
      );
      return;
    }

    if (cellCount <= 1) {
      setUndoSnapshot('Очистка ячейки');
      clearSelectedCells();
      setLastAction({ message: 'Очищена ячейка', time: Date.now() });
      return;
    }

    requestConfirm(
      'Очистить ячейки?',
      `Будет очищено ячеек: ${cellCount}.`,
      () => {
        setUndoSnapshot(`Очистка ячеек (${cellCount})`);
        clearSelectedCells();
        setLastAction({ message: `Очищено ячеек: ${cellCount}`, time: Date.now() });
      },
      'Очистить',
    );
  };

  const confirmClearSelection = () => {
    if (!activeTab) return;
    const rowsCount = normalizedSelection.endRow - normalizedSelection.startRow + 1;
    const colsCount = normalizedSelection.endCol - normalizedSelection.startCol + 1;
    const cellCount = rowsCount * colsCount;

    if (cellCount <= 1) {
      setUndoSnapshot('Очистка ячейки');
      clearSelectedCells();
      setLastAction({ message: 'Очищена ячейка', time: Date.now() });
      return;
    }

    requestConfirm(
      'Очистить выбранные ячейки?',
      `Будет очищено ячеек: ${cellCount}.`,
      () => {
        setUndoSnapshot(`Очистка ячеек (${cellCount})`);
        clearSelectedCells();
        setLastAction({ message: `Очищено ячеек: ${cellCount}`, time: Date.now() });
      },
      'Очистить',
    );
  };

  const handleGridKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const isSelectAll =
      (event.ctrlKey || event.metaKey) && (event.key.toLowerCase() === 'a' || event.nativeEvent.code === 'KeyA');
    if (isSelectAll) {
      event.preventDefault();
      if (!activeTab) return;
      const lastRow = activeTab.data.length - 1;
      const lastCol = (activeTab.data[0]?.length ?? 0) - 1;
      if (lastRow < 0 || lastCol < 0) return;
      setSelection({ startRow: 0, startCol: 0, endRow: lastRow, endCol: lastCol });
      setSelectionAnchor({ row: 0, col: 0 });
      setActiveCell({ row: 0, col: 0 });
      setSelectionMode('cell');
      return;
    }
    const isDelete = event.key === 'Delete' || event.key === 'Backspace';
    if (!isDelete) return;
    if (selectionMode === 'row' || selectionMode === 'col') {
      event.preventDefault();
      confirmDeleteSelection();
      return;
    }
    const isSingleCell =
      normalizedSelection.startRow === normalizedSelection.endRow &&
      normalizedSelection.startCol === normalizedSelection.endCol;
    if (!isSingleCell) {
      event.preventDefault();
      confirmDeleteSelection();
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const isCopy =
      (event.ctrlKey || event.metaKey) && (event.key.toLowerCase() === 'c' || event.nativeEvent.code === 'KeyC');
    if (isCopy) {
      event.preventDefault();
      void copySelection();
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLInputElement | HTMLTextAreaElement | HTMLDivElement>) => {
    const plain = event.clipboardData.getData('text/plain') || event.clipboardData.getData('text');
    const html = event.clipboardData.getData('text/html');
    if (!plain && !html) return;
    event.preventDefault();
    const values = parseBestClipboard(plain ?? '', html ?? '');
    applyPaste(values);
  };

  const rowCount = activeTab?.data.length ?? 0;
  const colCount = activeTab?.data[0]?.length ?? 0;
  const estimatedTableScrollWidth = useMemo(() => {
    if (colCount <= 0) return 0;
    const columnsWidth = Array.from({ length: colCount }, (_, index) => {
      return columnWidths[index] ?? DEFAULT_COLUMN_WIDTH;
    }).reduce((sum, width) => sum + width, 0);
    return columnsWidth + 32 + 28 + 20;
  }, [colCount, columnWidths]);
  const showBottomHorizontalScrollbar = colCount > 0;
  const bottomScrollbarContentWidth = Math.max(
    estimatedTableScrollWidth,
    horizontalScrollbarMetrics.scrollWidth,
    horizontalScrollbarMetrics.clientWidth + 1,
  );
  const horizontalScrollMax = Math.max(
    0,
    bottomScrollbarContentWidth - horizontalScrollbarMetrics.clientWidth,
  );
  const horizontalSliderMax = Math.max(1, Math.round(horizontalScrollMax));
  const horizontalSliderValue = Math.max(
    0,
    Math.min(horizontalSliderMax, Math.round(horizontalScrollLeft)),
  );
  const filterSearch = debouncedFilterMenuSearch.trim().toLowerCase();
  const filteredFilterOptions = filterMenu
    ? filterMenu.options.filter((option) =>
        option.label.toLowerCase().includes(filterSearch),
      )
    : [];
  const selectedFilterKeys = filterMenu
    ? getSelectedKeys(filterMenu.col, filterMenu.options)
    : new Set<string>();

  const headerLabels = useMemo(() => {
    if (!activeTab) return [];
    const headerRow = activeTab.data[0] ?? [];
    const headerHasHints = headerRow.some((cell) => {
      const value = cell?.trim();
      return value ? HEADER_LABEL_HINT_REGEX.test(value) : false;
    });
    return Array.from({ length: colCount }, (_, index) => {
      const label = headerRow[index]?.trim();
      if (!headerHasHints) return toColumnLabel(index);
      return label && label.length > 0 ? label : toColumnLabel(index);
    });
  }, [activeTab, colCount]);

  const enrichmentHeaderLabel = useMemo(() => {
    const baseLabel = headerLabels[websiteEnrichment.sourceCol] || toColumnLabel(websiteEnrichment.sourceCol);
    return `Обогащение (${baseLabel})`;
  }, [headerLabels, websiteEnrichment.sourceCol]);

  const enrichmentColumnStats = useMemo(() => {
    if (!activeTab) return [];
    const headerRow = activeTab.data[0] ?? [];
    const stats = Array.from({ length: colCount }, (_, col) => {
      const headerValue = String(headerRow[col] ?? '').trim();
      const label = headerLabels[col] || toColumnLabel(col);
      return {
        col,
        label,
        headerValue,
        filled: 0,
        missing: 0,
        isEnrichment: headerValue.toLowerCase().startsWith('обогащение'),
        matchesSourceLabel: headerValue === enrichmentHeaderLabel,
      };
    });

    const rowLimit = Math.min(activeTab.data.length, 5001);
    for (let rowIndex = 1; rowIndex < rowLimit; rowIndex += 1) {
      const row = activeTab.data[rowIndex];
      const sourceValue = String(row?.[websiteEnrichment.sourceCol] ?? '').trim();
      if (!sourceValue) continue;
      for (const entry of stats) {
        const existingValue = String(row?.[entry.col] ?? '').trim();
        if (existingValue) entry.filled += 1;
        else entry.missing += 1;
      }
    }

    return stats;
  }, [activeTab, colCount, headerLabels, enrichmentHeaderLabel, websiteEnrichment.sourceCol]);

  const enrichmentOptions = useMemo(() => {
    if (enrichmentColumnStats.length === 0) return [];
    const primary = enrichmentColumnStats.filter((entry) => entry.isEnrichment);
    const secondary = enrichmentColumnStats.filter((entry) => !entry.isEnrichment);
    const sortBy = (a: typeof enrichmentColumnStats[number], b: typeof enrichmentColumnStats[number]) =>
      b.filled - a.filled || a.missing - b.missing || a.col - b.col;
    primary.sort(sortBy);
    secondary.sort(sortBy);
    return [...primary, ...secondary];
  }, [enrichmentColumnStats]);

  const defaultEnrichmentTarget = useMemo(() => {
    if (enrichmentColumnStats.length === 0) return null;
    const matching = enrichmentColumnStats.filter((candidate) => candidate.matchesSourceLabel);
    const pool = matching.length > 0 ? matching : enrichmentColumnStats;
    let best = pool[0];
    for (const candidate of pool.slice(1)) {
      if (candidate.filled > best.filled || (candidate.filled === best.filled && candidate.col > best.col)) {
        best = candidate;
      }
    }
    return best.col;
  }, [enrichmentColumnStats]);

  const enrichmentTargetCol = enrichmentTargetOverride ?? defaultEnrichmentTarget;
  const selectedEnrichmentCandidate = useMemo(
    () => enrichmentColumnStats.find((candidate) => candidate.col === enrichmentTargetCol) ?? null,
    [enrichmentColumnStats, enrichmentTargetCol],
  );
  const missingEnrichmentCount = selectedEnrichmentCandidate?.missing ?? 0;

  const [groupSummary, setGroupSummary] = useState<Array<{ key: string; label: string; count: number }>>([]);
  const groupSummaryGenRef = useRef(0);

  useEffect(() => {
    if (!activeTab || groupByCol === null) {
      setGroupSummary([]);
      return;
    }

    const data = activeTab.data;
    const col = groupByCol;
    const matchFn = rowMatchesFilters;

    if (data.length <= VIRTUALIZATION_THRESHOLD) {
      const map = new Map<string, { label: string; count: number }>();
      for (let i = 1; i < data.length; i += 1) {
        const row = data[i];
        if (!matchFn(i, row, col)) continue;
        const raw = row[col] ?? '';
        const key = normalizeCellKey(raw);
        const label = raw.trim().length > 0 ? raw.trim() : BLANK_FILTER_LABEL;
        const entry = map.get(key) ?? { label, count: 0 };
        entry.count += 1;
        map.set(key, entry);
      }
      setGroupSummary(
        [...map.entries()]
          .map(([key, value]) => ({ key, label: value.label, count: value.count }))
          .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'ru')),
      );
      return;
    }

    const gen = ++groupSummaryGenRef.current;
    const ref = groupSummaryGenRef;
    const map = new Map<string, { label: string; count: number }>();
    let cursor = 1;
    const CHUNK = 5000;

    const processChunk = () => {
      if (ref.current !== gen) return;
      const end = Math.min(cursor + CHUNK, data.length);
      for (let i = cursor; i < end; i += 1) {
        const row = data[i];
        if (!matchFn(i, row, col)) continue;
        const raw = row[col] ?? '';
        const key = normalizeCellKey(raw);
        const label = raw.trim().length > 0 ? raw.trim() : BLANK_FILTER_LABEL;
        const entry = map.get(key) ?? { label, count: 0 };
        entry.count += 1;
        map.set(key, entry);
      }
      cursor = end;
      if (cursor < data.length) {
        requestAnimationFrame(processChunk);
        return;
      }
      if (ref.current !== gen) return;
      setGroupSummary(
        [...map.entries()]
          .map(([key, value]) => ({ key, label: value.label, count: value.count }))
          .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'ru')),
      );
    };

    setGroupSummary([]);
    requestAnimationFrame(processChunk);
    return () => { ref.current++; };
  }, [activeTabId, activeTab, groupByCol, rowMatchesFilters]);

  const normalizedGroupSearch = normalizeText(debouncedGroupSearch, normalizeOptions);
  const filteredGroupSummary = useMemo(() => {
    if (normalizedGroupSearch.length === 0) return groupSummary;
    return groupSummary.filter((item) =>
      normalizeText(item.label, normalizeOptions).includes(normalizedGroupSearch),
    );
  }, [groupSummary, normalizedGroupSearch, normalizeOptions]);

  const hasActiveFilters = filterEntries.length > 0 || (searchOnlyMatches && searchTerms.length > 0);

  const visibleRowIndices = useMemo(() => {
    if (!activeTab) return [];
    if (!hasActiveFilters) {
      const len = activeTab.data.length - 1;
      const indices = new Array<number>(len);
      for (let i = 0; i < len; i += 1) indices[i] = i + 1;
      return indices;
    }
    const indices: number[] = [];
    for (let i = 1; i < activeTab.data.length; i += 1) {
      const row = activeTab.data[i];
      if (rowMatchesFilters(i, row)) {
        indices.push(i);
      }
    }
    return indices;
  }, [activeTab, hasActiveFilters, rowMatchesFilters]);

  const allRowIndices = useMemo(() => {
    if (!activeTab) return [];
    return [0, ...visibleRowIndices];
  }, [activeTab, visibleRowIndices]);

  const isLargeTable = allRowIndices.length > VIRTUALIZATION_THRESHOLD;
  const shouldVirtualize = isLargeTable && !forceWrapLarge;
  const effectiveWrapCells = shouldVirtualize ? false : wrapCells;
  const wrapLabel = isLargeTable
    ? forceWrapLarge
      ? 'вкл (медленно)'
      : 'выкл (большая таблица)'
    : wrapCells
      ? 'вкл'
      : 'выкл';

  const virtualRange = useMemo(() => {
    if (allRowIndices.length <= VIRTUALIZATION_THRESHOLD) {
      return { start: 0, end: Math.max(0, allRowIndices.length - 1), top: 0, bottom: 0 };
    }
    const { scrollTop, height } = scrollMetrics;
    const viewportH = Math.min(Math.max(height, 600), 4000);
    const start = Math.max(0, Math.floor(scrollTop / VIRTUAL_ROW_HEIGHT) - VIRTUAL_OVERSCAN);
    const end = Math.min(
      allRowIndices.length - 1,
      start + Math.ceil(viewportH / VIRTUAL_ROW_HEIGHT) + VIRTUAL_OVERSCAN * 2,
    );
    const top = start * VIRTUAL_ROW_HEIGHT;
    const bottom = Math.max(0, (allRowIndices.length - end - 1) * VIRTUAL_ROW_HEIGHT);
    return { start, end, top, bottom };
  }, [allRowIndices.length, scrollMetrics]);

  const rowIndicesToRender = isLargeTable
    ? allRowIndices.slice(virtualRange.start, virtualRange.end + 1)
    : allRowIndices;

  const allVisibleSelected =
    visibleRowIndices.length > 0 &&
    visibleRowIndices.every((index) => selectedRows.has(index));
  const someVisibleSelected =
    visibleRowIndices.some((index) => selectedRows.has(index)) && !allVisibleSelected;

  const requestConfirm = (title: string, message: string, onConfirm: () => void, label = 'Удалить') => {
    confirmActionRef.current = onConfirm;
    setConfirmState({ title, message, confirmLabel: label });
  };

  const handleConfirm = () => {
    confirmActionRef.current?.();
    confirmActionRef.current = null;
    setConfirmState(null);
  };

  const handleCancelConfirm = () => {
    confirmActionRef.current = null;
    setConfirmState(null);
  };

  const setUndoSnapshot = (message: string) => {
    if (!activeTab) return;
    setLastUndo({
      tabId: activeTab.id,
      data: cloneData(activeTab.data),
      message,
      time: Date.now(),
    });
  };

  const openPersonalizationModal = () => {
    setPersonalization((prev) => ({
      ...prev,
      isOpen: true,
      sourceCol: 0,
      prompt: '',
      activePreset: null,
      briefText: '',
      briefFileName: '',
      isBriefUploading: false,
      isGenerating: false,
      progress: 0,
      totalRows: 0,
      currentRow: 0,
      error: null,
    }));
  };

  const closePersonalizationModal = () => {
    if (personalizationAbortRef.current) {
      personalizationAbortRef.current.abort();
      personalizationAbortRef.current = null;
    }
    setPersonalization((prev) => ({
      ...prev,
      isOpen: false,
      isGenerating: false,
      error: null,
    }));
  };

  const handlePersonalizationBriefUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    event.target.value = '';

    setPersonalization((prev) => ({ ...prev, isBriefUploading: true, briefFileName: file.name, briefText: '', error: null }));

    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      const userId = session?.user?.id;
      if (!token || !userId) {
        setPersonalization((prev) => ({ ...prev, isBriefUploading: false, error: 'Необходима авторизация' }));
        return;
      }

      const isPdf = file.type.includes('pdf') || file.name.toLowerCase().endsWith('.pdf');
      if (!isPdf) {
        setPersonalization((prev) => ({ ...prev, isBriefUploading: false, error: 'Файл должен быть PDF' }));
        return;
      }
      if (file.size > MAX_BRIEF_FILE_BYTES) {
        setPersonalization((prev) => ({ ...prev, isBriefUploading: false, error: 'Файл слишком большой (макс. 20MB)' }));
        return;
      }

      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const uploadPath = `${BRIEF_STORAGE_PREFIX}/${userId}/${Date.now()}-${safeName}`;
      const { error: uploadError } = await supabase.storage
        .from(BRIEF_STORAGE_BUCKET)
        .upload(uploadPath, file, { cacheControl: '3600', upsert: false, contentType: file.type || 'application/pdf' });

      if (uploadError) {
        setPersonalization((prev) => ({ ...prev, isBriefUploading: false, error: `Не удалось загрузить PDF: ${uploadError.message}` }));
        return;
      }

      const res = await fetch('/api/brief-scoring/parse-pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ bucket: BRIEF_STORAGE_BUCKET, path: uploadPath, fileName: file.name }),
      });

      let resData: { text?: string; error?: string } | null = null;
      try {
        const text = await res.text();
        if (text) resData = JSON.parse(text) as { text?: string; error?: string };
      } catch { resData = null; }

      if (!res.ok || !resData || resData.error) {
        setPersonalization((prev) => ({ ...prev, isBriefUploading: false, error: resData?.error || `Ошибка при обработке PDF (${res.status})` }));
        return;
      }

      setPersonalization((prev) => ({ ...prev, isBriefUploading: false, briefText: resData!.text ?? '' }));
    } catch (err) {
      setPersonalization((prev) => ({ ...prev, isBriefUploading: false, error: err instanceof Error ? err.message : 'Ошибка при загрузке файла' }));
    }
  };

  const generatePersonalizedProposals = async (
    sourceData: string,
    userPrompt: string,
    accessToken: string,
  ): Promise<string> => {
    const requestBody = {
      sourceData,
      userPrompt,
    };

    for (let attempt = 0; attempt <= PERSONALIZATION_MAX_RETRIES; attempt += 1) {
      let response: Response;
      let parsed: { proposal?: string; error?: string } | null = null;

      try {
        response = await fetch('/api/personalization/generate', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify(requestBody),
          signal: personalizationAbortRef.current?.signal,
        });
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          throw error;
        }
        if (attempt < PERSONALIZATION_MAX_RETRIES) {
          const retryDelay =
            PERSONALIZATION_RETRY_BASE_DELAY * Math.pow(2, attempt) +
            Math.floor(Math.random() * 300);
          await sleep(retryDelay);
          continue;
        }
        throw new Error('Не удалось отправить запрос к API');
      }

      try {
        parsed = (await response.json()) as { proposal?: string; error?: string };
      } catch {
        parsed = null;
      }

      if (response.ok) {
        const proposal = typeof parsed?.proposal === 'string' ? parsed.proposal.trim() : '';
        if (proposal) return proposal;
        throw new Error(parsed?.error || 'Пустой ответ от API');
      }

      const shouldRetry = [429, 500, 502, 503, 504].includes(response.status);
      const errorMessage = parsed?.error || `API ошибка: ${response.status}`;

      if (shouldRetry && attempt < PERSONALIZATION_MAX_RETRIES) {
        const retryDelay =
          PERSONALIZATION_RETRY_BASE_DELAY * Math.pow(2, attempt) +
          Math.floor(Math.random() * 300);
        await sleep(retryDelay);
        continue;
      }

      throw new Error(errorMessage);
    }

    throw new Error('Не удалось получить ответ от API');
  };

  const handleStartPersonalization = async () => {
    if (!activeTab || personalization.isGenerating) return;

    const dataRows = activeTab.data.slice(1).filter((row) => {
      const sourceValue = row[personalization.sourceCol]?.trim();
      return sourceValue && sourceValue.length > 0;
    });

    if (dataRows.length === 0) {
      setPersonalization((prev) => ({
        ...prev,
        error: 'Нет данных для персонализации в выбранной колонке',
      }));
      return;
    }

    const hasPresetWithBrief = personalization.activePreset && personalization.briefText.trim();
    const effectivePrompt = hasPresetWithBrief
      ? `${personalization.prompt.trim()}\n\nБриф компании-отправителя:\n${personalization.briefText.trim()}`
      : personalization.prompt.trim();

    if (!effectivePrompt) {
      setPersonalization((prev) => ({
        ...prev,
        error: personalization.activePreset ? 'Загрузите бриф для пресета' : 'Введите промпт для генерации',
      }));
      return;
    }

    const { data: { session } } = await supabase.auth.getSession();
    let token = session?.access_token ?? null;
    if (!token) {
      const refreshedToken = await getFreshToken();
      token = refreshedToken;
    }
    if (!token) {
      setPersonalization((prev) => ({
        ...prev,
        error: 'Необходима авторизация',
      }));
      return;
    }

    personalizationAbortRef.current = new AbortController();

    setPersonalization((prev) => ({
      ...prev,
      isGenerating: true,
      progress: 0,
      totalRows: dataRows.length,
      currentRow: 0,
      error: null,
    }));

    setUndoSnapshot('Персонализация');

    const newColIndex = activeTab.data[0].length;
    const newHeaderName = `Персонализация (${headerLabels[personalization.sourceCol] || toColumnLabel(personalization.sourceCol)})`;

    const baseData = activeTab.data.map((row, rowIndex) => {
      if (rowIndex === 0) {
        return [...row, newHeaderName];
      }
      return [...row, ''];
    });

    setTabs((prev) =>
      prev.map((tab) => (tab.id === activeTabId ? { ...tab, data: baseData } : tab)),
    );

    if (highlightTimeoutRef.current) {
      clearTimeout(highlightTimeoutRef.current);
    }
    setHighlightedCol(newColIndex);
    highlightTimeoutRef.current = setTimeout(() => {
      setHighlightedCol(null);
    }, PERSONALIZATION_HIGHLIGHT_DURATION);

    if (tableWrapperRef.current) {
      const wrapper = tableWrapperRef.current;
      requestAnimationFrame(() => {
        wrapper.scrollTo({ left: wrapper.scrollWidth, behavior: 'smooth' });
      });
    }

    let processedCount = 0;
    let errorCount = 0;
    const batchSize = PERSONALIZATION_BATCH_SIZE;
    const rowsToProcess: { rowIndex: number; sourceValue: string }[] = [];

    for (let i = 1; i < activeTab.data.length; i++) {
      const sourceValue = activeTab.data[i][personalization.sourceCol]?.trim();
      if (sourceValue && sourceValue.length > 0) {
        rowsToProcess.push({ rowIndex: i, sourceValue });
      }
    }

    try {
      for (let batchStart = 0; batchStart < rowsToProcess.length; batchStart += batchSize) {
        if (personalizationAbortRef.current?.signal.aborted) {
          throw new Error('Отменено пользователем');
        }

        const batch = rowsToProcess.slice(batchStart, batchStart + batchSize);
        
        const results = await Promise.all(
          batch.map(async ({ rowIndex, sourceValue }) => {
            try {
              const proposal = await generatePersonalizedProposals(
                sourceValue,
                effectivePrompt,
                token,
              );
              return { rowIndex, proposal, error: null };
            } catch (err) {
              if (err instanceof Error && err.name === 'AbortError') {
                throw err;
              }
              return { rowIndex, proposal: '', error: err instanceof Error ? err.message : 'Ошибка' };
            }
          }),
        );

        // Подсчитываем ошибки
        for (const result of results) {
          if (result.error) errorCount++;
        }

        setTabs((prev) =>
          prev.map((tab) => {
            if (tab.id !== activeTabId) return tab;
            const nextData = tab.data.map((row, idx) => {
              const result = results.find((r) => r.rowIndex === idx);
              if (!result) return row;
              const newRow = [...row];
              while (newRow.length <= newColIndex) {
                newRow.push('');
              }
              newRow[newColIndex] = result.error
                ? `[Ошибка: ${result.error}]`
                : result.proposal;
              return newRow;
            });
            return { ...tab, data: nextData };
          }),
        );

        processedCount += batch.length;

        setPersonalization((prev) => ({
          ...prev,
          currentRow: processedCount,
          progress: Math.round((processedCount / rowsToProcess.length) * 100),
        }));

        if (batchStart + batchSize < rowsToProcess.length) {
          await sleep(200);
        }
      }

      const successCount = processedCount - errorCount;

      setLastAction({
        message: errorCount > 0 
          ? `Персонализация: ${successCount} успешно, ${errorCount} с ошибками`
          : `Персонализация завершена: ${processedCount} строк`,
        time: Date.now(),
      });

      setPersonalization((prev) => ({
        ...prev,
        isGenerating: false,
        isOpen: false,
      }));
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        setLastAction({
          message: `Персонализация отменена (обработано: ${processedCount})`,
          time: Date.now(),
        });
        setPersonalization((prev) => ({
          ...prev,
          isGenerating: false,
          isOpen: false,
        }));
      } else {
        setPersonalization((prev) => ({
          ...prev,
          error: err instanceof Error ? err.message : 'Произошла ошибка',
          isGenerating: false,
        }));
      }
    } finally {
      personalizationAbortRef.current = null;
    }
  };

  // --- Website Enrichment ---

  const openWebsiteEnrichmentModal = () => {
    setWebsiteEnrichment({
      isOpen: true,
      sourceCol: 0,
      isGenerating: false,
      progress: 0,
      totalRows: 0,
      currentRow: 0,
      retryCount: 0,
      error: null,
      jobId: null,
    });
  };

  const closeWebsiteEnrichmentModal = () => {
    setWebsiteEnrichment((prev) => ({ ...prev, isOpen: false }));
  };

  const ensureEnrichmentColumn = useCallback((tabId: string, targetColIndex: number, headerLabel: string) => {
    if (!headerLabel) return;
    setTabs((prev) =>
      prev.map((tab) => {
        if (tab.id !== tabId) return tab;
        const nextData = tab.data.map((row, rowIndex) => {
          const nextRow = [...row];
          while (nextRow.length <= targetColIndex) {
            nextRow.push('');
          }
          if (rowIndex === 0) {
            const existingHeader = String(nextRow[targetColIndex] ?? '').trim();
            if (!existingHeader) {
              nextRow[targetColIndex] = headerLabel;
            }
          }
          return nextRow;
        });
        return { ...tab, data: nextData };
      }),
    );
  }, [setTabs]);

  const runWebsiteEnrichmentPolling = useCallback(async (params: {
    jobId: string;
    tabId: string;
    sourceCol: number;
    targetColIndex: number;
    totalRowsFallback: number;
    headerLabel: string;
    applyOnlyEmpty: boolean;
    initialToken?: string | null;
  }) => {
    const {
      jobId,
      tabId,
      sourceCol,
      targetColIndex,
      totalRowsFallback,
      headerLabel,
      applyOnlyEmpty,
      initialToken,
    } = params;

    const token = initialToken ?? (await getFreshToken());
    if (!token) {
      setWebsiteEnrichment((prev) => ({
        ...prev,
        isGenerating: false,
        error: 'Необходима авторизация',
        jobId: null,
      }));
      return;
    }

    const controller = enrichmentAbortRef.current ?? new AbortController();
    enrichmentAbortRef.current = controller;
    const signal = controller.signal;
    if (signal.aborted) {
      setWebsiteEnrichment((prev) => ({ ...prev, isGenerating: false, jobId: null }));
      return;
    }

    ensureEnrichmentColumn(tabId, targetColIndex, headerLabel);
    setEnrichmentTargetOverride(targetColIndex);
    setWebsiteEnrichment((prev) => ({
      ...prev,
      sourceCol,
      isGenerating: true,
      totalRows: totalRowsFallback,
      currentRow: Math.min(prev.currentRow, totalRowsFallback),
      progress: totalRowsFallback > 0 ? Math.round((Math.min(prev.currentRow, totalRowsFallback) / totalRowsFallback) * 100) : 0,
      retryCount: 0,
      error: null,
      jobId,
    }));

    let processedCount = 0;
    let errorCount = 0;
    let cursor: string | null = null;
    let pollDelayMs = 1000;
    const maxPollDelayMs = 5000;
    const pendingUpdates = new Map<number, string>();
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let lastProgressAt = 0;
    let lastObservedProgressAt = Date.now();
    let lastObservedProcessed = 0;
    let consecutivePollingErrors = 0;
    let currentToken = token;

    const flushUpdates = () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (pendingUpdates.size === 0) return;
      const updates = new Map(pendingUpdates);
      pendingUpdates.clear();
      setTabs((prev) =>
        prev.map((tab) => {
          if (tab.id !== tabId) return tab;
          const nextData = [...tab.data];
          if (headerLabel) {
            const headerRow = nextData[0];
            if (headerRow) {
              const nextHeader = [...headerRow];
              while (nextHeader.length <= targetColIndex) {
                nextHeader.push('');
              }
              const existingHeader = String(nextHeader[targetColIndex] ?? '').trim();
              if (!existingHeader) {
                nextHeader[targetColIndex] = headerLabel;
                nextData[0] = nextHeader;
              }
            }
          }
          updates.forEach((text, rowIndex) => {
            const existingRow = nextData[rowIndex];
            if (!existingRow) return;
            const newRow = [...existingRow];
            while (newRow.length <= targetColIndex) {
              newRow.push('');
            }
            if (applyOnlyEmpty) {
              const existingValue = String(newRow[targetColIndex] ?? '').trim();
              if (existingValue) return;
            }
            newRow[targetColIndex] = text;
            nextData[rowIndex] = newRow;
          });
          return { ...tab, data: nextData };
        }),
      );
    };

    const scheduleFlush = () => {
      if (pendingUpdates.size >= ENRICHMENT_UPDATE_BATCH) {
        flushUpdates();
        return;
      }
      if (!flushTimer) {
        flushTimer = setTimeout(() => flushUpdates(), ENRICHMENT_UPDATE_FLUSH_MS);
      }
    };

    const reportProgress = (total: number, force = false) => {
      const now = Date.now();
      if (!force && now - lastProgressAt < ENRICHMENT_PROGRESS_INTERVAL_MS) return;
      lastProgressAt = now;
      const safeTotal = Math.max(0, total);
      const safeProcessed = Math.min(processedCount, safeTotal);
      const retryCount = Math.max(0, processedCount - safeTotal);
      setWebsiteEnrichment((prev) => ({
        ...prev,
        totalRows: safeTotal,
        currentRow: safeProcessed,
        progress: safeTotal > 0 ? Math.round((safeProcessed / safeTotal) * 100) : 0,
        retryCount,
      }));
    };

    try {
      while (!signal?.aborted) {
        const fetchResults = async (tkn: string) =>
          fetch(
            `/api/enrich/website/jobs/${jobId}/results?${cursor ? `cursor=${encodeURIComponent(cursor)}&` : ''}limit=500`,
            {
              headers: {
                Authorization: `Bearer ${tkn}`,
              },
              signal,
            },
          );

        const reqStartedAt = Date.now();
        let res = await fetchResults(currentToken);
        if (res.status === 401) {
          const refreshed = await getFreshToken();
          if (refreshed) {
            currentToken = refreshed;
            res = await fetchResults(currentToken);
          } else {
            throw new Error('Сессия истекла во время обогащения. Войдите заново и перезапустите процесс.');
          }
        }

        if (!res.ok) {
          consecutivePollingErrors += 1;
          let responseError = `Ошибка API (${res.status})`;
          try {
            const errorData = await parseJsonResponse<{ error?: string }>(res, 'website_enrichment.poll.error');
            if (errorData.error) responseError = errorData.error;
          } catch {
            // ignore parse error
          }
          if (consecutivePollingErrors >= ENRICHMENT_MAX_CONSECUTIVE_FAILURES) {
            throw new Error(`Обогащение остановлено: ${responseError}`);
          }
          await sleep(1000);
          continue;
        }
        consecutivePollingErrors = 0;

        const data = await parseJsonResponse<{
          job?: {
            status?: string;
            total?: number;
            processed?: number;
            success_count?: number;
            error_count?: number;
            error_message?: string | null;
          };
          results?: Array<{
            id: string;
            row_index: number;
            result_text: string | null;
            status: string;
            last_error: string | null;
            updated_at: string;
          }>;
          next_cursor?: string | null;
        }>(res, 'website_enrichment.results');

        const resultsCount = data.results?.length ?? 0;
        if (data.results && data.results.length > 0) {
          for (const result of data.results) {
            if (result.status === 'completed') {
              pendingUpdates.set(result.row_index, result.result_text ?? '');
            }
          }
          scheduleFlush();
        }

        if (data.next_cursor) {
          cursor = data.next_cursor;
        }

        if (data.job) {
          const total = data.job.total ?? totalRowsFallback;
          processedCount = data.job.processed ?? processedCount;
          errorCount = data.job.error_count ?? errorCount;
          if (processedCount > lastObservedProcessed) {
            lastObservedProcessed = processedCount;
            lastObservedProgressAt = Date.now();
          }
          reportProgress(total);
        }

        const status = data.job?.status;
        if (status && ['completed', 'failed', 'cancelled'].includes(status)) {
          flushUpdates();
          const total = data.job?.total ?? totalRowsFallback;
          const successCount = total - (data.job?.error_count ?? errorCount);
          reportProgress(total, true);
          setLastAction({
            message:
              status === 'cancelled'
                ? `Обогащение отменено (обработано: ${processedCount})`
                : data.job?.error_count
                  ? `Обогащение: ${successCount} успешно, ${data.job.error_count} с ошибками`
                  : `Обогащение завершено: ${processedCount} строк`,
            time: Date.now(),
          });
          setWebsiteEnrichment((prev) => ({
            ...prev,
            isGenerating: false,
            isOpen: status === 'failed' ? prev.isOpen : false,
            error: status === 'failed' ? data.job?.error_message ?? 'Произошла ошибка' : null,
            jobId: null,
          }));
          removeEnrichmentRun(jobId);
          break;
        }

        if (
          status === 'running' &&
          processedCount < (data.job?.total ?? totalRowsFallback) &&
          Date.now() - lastObservedProgressAt > ENRICHMENT_STALL_TIMEOUT_MS
        ) {
          throw new Error('Обогащение не продвигается более 3 минут. Проверьте серверные логи и перезапустите процесс.');
        }

        if (resultsCount === 0 && status === 'running') {
          const elapsed = Date.now() - reqStartedAt;
          pollDelayMs = Math.min(maxPollDelayMs, Math.max(pollDelayMs * 1.5, elapsed));
        } else {
          pollDelayMs = 1000;
        }

        await sleep(pollDelayMs);
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        setLastAction({
          message: `Обогащение отменено (обработано: ${processedCount})`,
          time: Date.now(),
        });
        setWebsiteEnrichment((prev) => ({
          ...prev,
          isGenerating: false,
          isOpen: false,
          jobId: null,
        }));
        removeEnrichmentRun(jobId);
      } else {
        setWebsiteEnrichment((prev) => ({
          ...prev,
          error: err instanceof Error ? err.message : 'Произошла ошибка',
          isGenerating: false,
          isOpen: true,
          jobId: null,
        }));
      }
    } finally {
      if (flushTimer) {
        clearTimeout(flushTimer);
      }
      enrichmentAbortRef.current = null;
    }
  }, [
    ensureEnrichmentColumn,
    getFreshToken,
    removeEnrichmentRun,
    setEnrichmentTargetOverride,
    setLastAction,
    setTabs,
    setWebsiteEnrichment,
  ]);

  const handleStopWebsiteEnrichment = async () => {
    if (!websiteEnrichment.isGenerating || !websiteEnrichment.jobId) return;
    if (
      !window.confirm(
        'Остановить обогащение? После отмены прогресс не сохранится и запустить придётся заново.',
      )
    ) {
      return;
    }
    const jobId = websiteEnrichment.jobId;
    if (enrichmentAbortRef.current) {
      enrichmentAbortRef.current.abort();
    }
    removeEnrichmentRun(jobId);

    const token = await getFreshToken();
    if (!token) {
      setLastAction({
        message: 'Остановка отправлена локально, но сервер не подтвердил отмену (нужна авторизация)',
        time: Date.now(),
      });
      return;
    }

    const cancelOnce = async () =>
      fetch(`/api/enrich/website/jobs/${jobId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ status: 'cancelled' }),
      });

    try {
      let response = await cancelOnce();
      if (!response.ok && [401, 502, 503, 504].includes(response.status)) {
        await sleep(350);
        response = await cancelOnce();
      }
      if (!response.ok) {
        setLastAction({
          message: `Отмена не подтверждена сервером (HTTP ${response.status})`,
          time: Date.now(),
        });
      }
    } catch (error) {
      setLastAction({
        message: `Отмена не подтверждена сервером: ${error instanceof Error ? error.message : 'network error'}`,
        time: Date.now(),
      });
    }
  };

  const handleStartWebsiteEnrichment = async (options?: { targetColIndex?: number; onlyEmpty?: boolean }) => {
    if (!activeTab || websiteEnrichment.isGenerating) return;

    const targetColIndex = typeof options?.targetColIndex === 'number' ? options.targetColIndex : null;
    const onlyEmpty = Boolean(options?.onlyEmpty && targetColIndex !== null);
    const rowsToProcess: { rowIndex: number; sourceValue: string }[] = [];

    for (let i = 1; i < activeTab.data.length; i++) {
      const row = activeTab.data[i];
      const sourceValue = String(row?.[websiteEnrichment.sourceCol] ?? '').trim();
      if (!sourceValue) continue;
      if (onlyEmpty && targetColIndex !== null) {
        const existingValue = String(row?.[targetColIndex] ?? '').trim();
        if (existingValue.length > 0) continue;
      }
      rowsToProcess.push({ rowIndex: i, sourceValue });
    }

    if (rowsToProcess.length === 0) {
      setWebsiteEnrichment((prev) => ({
        ...prev,
        error: onlyEmpty ? 'Нет пустых ячеек для дозаполнения' : 'Нет данных в выбранной колонке',
      }));
      return;
    }

    const currentToken = await getFreshToken();
    if (!currentToken) {
      setWebsiteEnrichment((prev) => ({
        ...prev,
        error: 'Необходима авторизация',
      }));
      return;
    }

    enrichmentAbortRef.current = new AbortController();

    setWebsiteEnrichment((prev) => ({
      ...prev,
      isGenerating: true,
      progress: 0,
      totalRows: rowsToProcess.length,
      currentRow: 0,
      error: null,
    }));

    setUndoSnapshot('Обогащение с сайта');

    const newHeaderName = enrichmentHeaderLabel;
    const startCol = websiteEnrichment.sourceCol + 1;
    const isColumnEmpty = (colIndex: number) =>
      activeTab.data.every((row) => {
        const value = row[colIndex] ?? '';
        return value.trim().length === 0;
      });

    let newColIndex = targetColIndex ?? startCol;
    let baseData: string[][];

    if (targetColIndex === null) {
      while (!isColumnEmpty(newColIndex)) {
        newColIndex += 1;
      }

      baseData = activeTab.data.map((row, rowIndex) => {
        const nextRow = [...row];
        while (nextRow.length <= newColIndex) {
          nextRow.push('');
        }
        if (rowIndex === 0) {
          nextRow[newColIndex] = newHeaderName;
        }
        return nextRow;
      });
    } else {
      baseData = activeTab.data.map((row) => {
        const nextRow = [...row];
        while (nextRow.length <= newColIndex) {
          nextRow.push('');
        }
        return nextRow;
      });
    }

    setTabs((prev) =>
      prev.map((tab) => (tab.id === activeTabId ? { ...tab, data: baseData } : tab)),
    );

    if (highlightTimeoutRef.current) {
      clearTimeout(highlightTimeoutRef.current);
    }
    setHighlightedCol(newColIndex);
    highlightTimeoutRef.current = setTimeout(() => {
      setHighlightedCol(null);
    }, ENRICHMENT_HIGHLIGHT_DURATION);

    if (tableWrapperRef.current) {
      const wrapper = tableWrapperRef.current;
      requestAnimationFrame(() => {
        wrapper.scrollTo({ left: wrapper.scrollWidth, behavior: 'smooth' });
      });
    }

    try {
      const startRes = await fetch('/api/enrich/website/jobs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${currentToken}`,
        },
        body: JSON.stringify({
          rows: rowsToProcess.map((row) => ({
            rowIndex: row.rowIndex,
            url: row.sourceValue,
          })),
        }),
        signal: enrichmentAbortRef.current?.signal,
      });

      const startData = await parseJsonResponse<{
        job_id?: string;
        total?: number;
        processed?: number;
        error_count?: number;
        error?: string;
      }>(startRes, 'website_enrichment.start');

      if (!startRes.ok || !startData.job_id) {
        throw new Error(startData.error ?? 'Не удалось создать задачу');
      }

      const jobId = startData.job_id;
      const total = startData.total ?? rowsToProcess.length;
      const processedCount = startData.processed ?? 0;

      const safeProcessed = Math.min(processedCount, total);
      const retryCount = Math.max(0, processedCount - total);
      setWebsiteEnrichment((prev) => ({
        ...prev,
        isOpen: false,
        isGenerating: true,
        totalRows: total,
        currentRow: safeProcessed,
        progress: total > 0 ? Math.round((safeProcessed / total) * 100) : 0,
        retryCount,
        jobId,
        error: null,
      }));
      setEnrichmentTargetOverride(newColIndex);
      upsertEnrichmentRun({
        jobId,
        tabId: activeTabId,
        sourceCol: websiteEnrichment.sourceCol,
        targetCol: newColIndex,
        headerLabel: newHeaderName,
        totalRows: total,
        startedAt: new Date().toISOString(),
      });
      await runWebsiteEnrichmentPolling({
        jobId,
        tabId: activeTabId,
        sourceCol: websiteEnrichment.sourceCol,
        targetColIndex: newColIndex,
        totalRowsFallback: total,
        headerLabel: newHeaderName,
        applyOnlyEmpty: onlyEmpty,
        initialToken: currentToken,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        setLastAction({
          message: 'Обогащение отменено',
          time: Date.now(),
        });
        setWebsiteEnrichment((prev) => ({
          ...prev,
          isGenerating: false,
          isOpen: false,
          jobId: null,
        }));
      } else {
        setWebsiteEnrichment((prev) => ({
          ...prev,
          error: err instanceof Error ? err.message : 'Произошла ошибка',
          isGenerating: false,
          jobId: null,
        }));
      }
    } finally {
      enrichmentAbortRef.current = null;
    }
  };

  // ── Brief Scoring (ЦА по брифу) ──────────────────────────────
  const hasEnrichmentColumns = useMemo(() => {
    if (!activeTab) return false;
    const headers = activeTab.data[0] ?? [];
    return headers.some((h) => {
      const v = h?.trim();
      return v ? ENRICHMENT_COLUMN_REGEX.test(v) : false;
    });
  }, [activeTab]);

  const openBriefScoringModal = () => {
    setBriefScoring((prev) => {
      if (prev.isScoring) {
        return { ...prev, isOpen: true, error: null };
      }
      return {
        showPreCheck: true,
        isOpen: false,
        inputMode: 'pdf',
        briefText: '',
        briefFileName: '',
        manualText: '',
        isUploading: false,
        isScoring: false,
        progress: 0,
        totalRows: 0,
        currentRow: 0,
        error: null,
        jobId: null,
      };
    });
  };

  const confirmPreCheckAndProceed = () => {
    setBriefScoring((prev) => ({ ...prev, showPreCheck: false, isOpen: true }));
  };

  const closePreCheckAndEnrich = () => {
    setBriefScoring((prev) => ({ ...prev, showPreCheck: false }));
    openWebsiteEnrichmentModal();
  };

  const closeBriefScoringModal = () => {
    setBriefScoring((prev) => ({ ...prev, isOpen: false, showPreCheck: false, error: null }));
  };

  const handleBriefFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    event.target.value = '';

    setBriefScoring((prev) => ({
      ...prev,
      isUploading: true,
      briefFileName: file.name,
      briefText: '',
      error: null,
    }));

    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      const userId = session?.user?.id;
      if (!token || !userId) {
        setBriefScoring((prev) => ({ ...prev, isUploading: false, error: 'Необходима авторизация' }));
        return;
      }

      const isPdf = file.type.includes('pdf') || file.name.toLowerCase().endsWith('.pdf');
      if (!isPdf) {
        setBriefScoring((prev) => ({ ...prev, isUploading: false, error: 'Файл должен быть PDF' }));
        return;
      }

      if (file.size > MAX_BRIEF_FILE_BYTES) {
        setBriefScoring((prev) => ({
          ...prev,
          isUploading: false,
          error: 'Файл слишком большой (макс. 20MB)',
        }));
        return;
      }

      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const uploadPath = `${BRIEF_STORAGE_PREFIX}/${userId}/${Date.now()}-${safeName}`;
      const { error: uploadError } = await supabase.storage
        .from(BRIEF_STORAGE_BUCKET)
        .upload(uploadPath, file, {
          cacheControl: '3600',
          upsert: false,
          contentType: file.type || 'application/pdf',
        });

      if (uploadError) {
        setBriefScoring((prev) => ({
          ...prev,
          isUploading: false,
          error: `Не удалось загрузить PDF в хранилище: ${uploadError.message}`,
        }));
        return;
      }

      const res = await fetch('/api/brief-scoring/parse-pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ bucket: BRIEF_STORAGE_BUCKET, path: uploadPath, fileName: file.name }),
      });

      let resData: { text?: string; pages?: number; error?: string } | null = null;
      let responseText = '';
      try {
        responseText = await res.text();
        if (responseText) {
          resData = JSON.parse(responseText) as { text?: string; pages?: number; error?: string };
        }
      } catch {
        resData = null;
      }

      if (!res.ok || !resData || resData.error) {
        const plainText = responseText
          ? responseText.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
          : '';
        const textSnippet = plainText ? plainText.slice(0, 200) : '';
        const fallbackError = res.redirected
          ? 'Сессия истекла, войдите заново'
          : textSnippet
            ? `Ошибка при загрузке PDF (${res.status}): ${textSnippet}`
            : res.ok
              ? 'Сервер вернул некорректный ответ'
              : `Ошибка при загрузке PDF (${res.status})`;
        setBriefScoring((prev) => ({
          ...prev,
          isUploading: false,
          error: resData?.error || fallbackError,
        }));
        return;
      }

      setBriefScoring((prev) => ({ ...prev, isUploading: false, briefText: resData.text ?? '' }));
    } catch (err) {
      setBriefScoring((prev) => ({
        ...prev,
        isUploading: false,
        error: err instanceof Error ? err.message : 'Ошибка при загрузке файла',
      }));
    }
  };

  const ensureBriefScoringColumns = useCallback((tabId: string, scoreColIndex: number, reasonColIndex: number) => {
    setTabs((prev) =>
      prev.map((tab) => {
        if (tab.id !== tabId) return tab;
        const nextData = tab.data.map((row, rowIndex) => {
          const nextRow = [...row];
          while (nextRow.length <= reasonColIndex) {
            nextRow.push('');
          }
          if (rowIndex === 0) {
            if (!String(nextRow[scoreColIndex] ?? '').trim()) nextRow[scoreColIndex] = 'ЦА Балл';
            if (!String(nextRow[reasonColIndex] ?? '').trim()) nextRow[reasonColIndex] = 'ЦА Причина';
          }
          return nextRow;
        });
        return { ...tab, data: nextData };
      }),
    );
  }, [setTabs]);

  const runBriefScoringPolling = useCallback(async (params: {
    jobId: string;
    tabId: string;
    scoreColIndex: number;
    reasonColIndex: number;
    totalRowsFallback: number;
    initialToken?: string | null;
  }) => {
    const {
      jobId,
      tabId,
      scoreColIndex,
      reasonColIndex,
      totalRowsFallback,
      initialToken,
    } = params;

    const token = initialToken ?? (await getFreshToken());
    if (!token) {
      setBriefScoring((prev) => ({
        ...prev,
        isScoring: false,
        error: 'Необходима авторизация',
        jobId: null,
      }));
      removeBriefScoringRun(jobId);
      return;
    }

    const controller = briefScoringAbortRef.current ?? new AbortController();
    briefScoringAbortRef.current = controller;
    const signal = controller.signal;

    if (signal.aborted) {
      setBriefScoring((prev) => ({ ...prev, isScoring: false, jobId: null }));
      removeBriefScoringRun(jobId);
      return;
    }

    ensureBriefScoringColumns(tabId, scoreColIndex, reasonColIndex);
    setBriefScoring((prev) => ({
      ...prev,
      isScoring: true,
      totalRows: totalRowsFallback,
      currentRow: Math.min(prev.currentRow, totalRowsFallback),
      progress:
        totalRowsFallback > 0
          ? Math.round((Math.min(prev.currentRow, totalRowsFallback) / totalRowsFallback) * 100)
          : 0,
      error: null,
      jobId,
    }));

    let cursor: string | null = null;
    let pollDelayMs = BRIEF_SCORING_POLL_INTERVAL_MS;
    let processedCount = 0;
    let errorCount = 0;
    let consecutivePollingErrors = 0;
    let currentToken = token;
    const pendingUpdates = new Map<number, { score: string; reason: string }>();

    const flushUpdates = () => {
      if (pendingUpdates.size === 0) return;
      const updates = new Map(pendingUpdates);
      pendingUpdates.clear();
      setTabs((prev) =>
        prev.map((tab) => {
          if (tab.id !== tabId) return tab;
          const nextData = [...tab.data];
          updates.forEach((update, rowIndex) => {
            const existingRow = nextData[rowIndex];
            if (!existingRow) return;
            const newRow = [...existingRow];
            while (newRow.length <= reasonColIndex) {
              newRow.push('');
            }
            newRow[scoreColIndex] = update.score;
            newRow[reasonColIndex] = update.reason;
            nextData[rowIndex] = newRow;
          });
          return { ...tab, data: nextData };
        }),
      );
    };

    try {
      while (!signal.aborted) {
        const fetchResults = async (tkn: string) =>
          fetch(
            `/api/brief-scoring/jobs/${jobId}/results?${cursor ? `cursor=${encodeURIComponent(cursor)}&` : ''}limit=500`,
            {
              headers: { Authorization: `Bearer ${tkn}` },
              signal,
            },
          );

        const reqStartedAt = Date.now();
        let res = await fetchResults(currentToken);
        if (res.status === 401) {
          const refreshed = await getFreshToken();
          if (refreshed) {
            currentToken = refreshed;
            res = await fetchResults(currentToken);
          } else {
            throw new Error('Сессия истекла во время оценки ЦА. Войдите заново и перезапустите процесс.');
          }
        }

        if (!res.ok) {
          consecutivePollingErrors += 1;
          let responseError = `Ошибка API (${res.status})`;
          try {
            const errorData = await parseJsonResponse<{ error?: string }>(res, 'brief_scoring.poll.error');
            if (errorData.error) responseError = errorData.error;
          } catch {
            // ignore parse error
          }
          if (consecutivePollingErrors >= BRIEF_SCORING_MAX_CONSECUTIVE_FAILURES) {
            throw new Error(`Оценка ЦА остановлена: ${responseError}`);
          }
          await sleep(1000);
          continue;
        }
        consecutivePollingErrors = 0;

        const data = await parseJsonResponse<{
          job?: {
            status?: string;
            total?: number;
            processed?: number;
            success_count?: number;
            error_count?: number;
            error_message?: string | null;
          };
          results?: Array<{
            id: string;
            row_index: number;
            score: number | null;
            reason: string | null;
            status: string;
            last_error: string | null;
            updated_at: string;
          }>;
          next_cursor?: string | null;
        }>(res, 'brief_scoring.results');

        const resultsCount = data.results?.length ?? 0;
        if (data.results && data.results.length > 0) {
          for (const result of data.results) {
            if (result.status === 'completed') {
              pendingUpdates.set(result.row_index, {
                score: result.score == null ? '?' : String(result.score),
                reason: result.reason ?? '',
              });
            } else if (result.status === 'failed') {
              pendingUpdates.set(result.row_index, {
                score: '⚠',
                reason: result.last_error ?? 'Ошибка AI',
              });
            }
          }
          if (pendingUpdates.size >= 50) {
            flushUpdates();
          }
        }

        if (data.next_cursor) {
          cursor = data.next_cursor;
        }

        if (data.job) {
          const total = data.job.total ?? totalRowsFallback;
          processedCount = data.job.processed ?? processedCount;
          errorCount = data.job.error_count ?? errorCount;
          const safeProcessed = Math.min(processedCount, total);
          setBriefScoring((prev) => ({
            ...prev,
            totalRows: total,
            currentRow: safeProcessed,
            progress: total > 0 ? Math.round((safeProcessed / total) * 100) : 0,
          }));
        }

        const status = data.job?.status;
        if (status && ['completed', 'failed', 'cancelled'].includes(status)) {
          flushUpdates();
          const total = data.job?.total ?? totalRowsFallback;
          const safeProcessed = Math.min(processedCount, total);
          const finalErrorCount = data.job?.error_count ?? errorCount;
          const successCount =
            data.job?.success_count ?? Math.max(0, safeProcessed - finalErrorCount);

          setLastAction({
            message:
              status === 'cancelled'
                ? `Оценка ЦА отменена (обработано: ${safeProcessed})`
                : finalErrorCount > 0
                  ? `Оценка ЦА: ${successCount} успешно, ${finalErrorCount} с ошибками`
                  : `Оценка ЦА завершена: ${safeProcessed} строк`,
            time: Date.now(),
          });

          setBriefScoring((prev) => ({
            ...prev,
            isScoring: false,
            isOpen: status === 'failed',
            totalRows: total,
            currentRow: safeProcessed,
            progress: total > 0 ? Math.round((safeProcessed / total) * 100) : 0,
            error: status === 'failed' ? data.job?.error_message ?? 'Произошла ошибка' : null,
            jobId: null,
          }));
          removeBriefScoringRun(jobId);
          break;
        }

        if (resultsCount === 0 && status === 'running') {
          const elapsed = Date.now() - reqStartedAt;
          pollDelayMs = Math.min(
            BRIEF_SCORING_MAX_POLL_DELAY_MS,
            Math.max(Math.floor(pollDelayMs * 1.5), elapsed),
          );
        } else {
          pollDelayMs = BRIEF_SCORING_POLL_INTERVAL_MS;
        }

        await sleep(pollDelayMs);
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        setBriefScoring((prev) => ({ ...prev, isScoring: false, isOpen: false, jobId: null }));
        removeBriefScoringRun(jobId);
      } else {
        setBriefScoring((prev) => ({
          ...prev,
          isScoring: false,
          isOpen: true,
          error: err instanceof Error ? err.message : 'Произошла ошибка',
          jobId: null,
        }));
        removeBriefScoringRun(jobId);
      }
    } finally {
      flushUpdates();
      briefScoringAbortRef.current = null;
    }
  }, [
    ensureBriefScoringColumns,
    getFreshToken,
    removeBriefScoringRun,
    setLastAction,
    setTabs,
  ]);

  const handleStopBriefScoring = async () => {
    const jobId = briefScoring.jobId;
    if (!briefScoring.isScoring || !jobId) return;
    if (!window.confirm('Остановить оценку ЦА? Уже полученные результаты сохранятся.')) return;

    const token = await getFreshToken();
    if (!token) {
      setLastAction({
        message: 'Не удалось отправить остановку: нужна авторизация',
        time: Date.now(),
      });
      return;
    }

    try {
      const response = await fetch(`/api/brief-scoring/jobs/${jobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'cancel' }),
      });
      if (!response.ok) {
        const data = await parseJsonResponse<{ error?: string }>(response, 'brief_scoring.cancel');
        setLastAction({
          message: data.error ?? `Отмена не подтверждена сервером (HTTP ${response.status})`,
          time: Date.now(),
        });
        return;
      }
      setLastAction({
        message: 'Остановка оценки ЦА отправлена',
        time: Date.now(),
      });
      removeBriefScoringRun(jobId);
    } catch (err) {
      setLastAction({
        message: `Отмена не подтверждена сервером: ${err instanceof Error ? err.message : 'network error'}`,
        time: Date.now(),
      });
    }
  };

  const handleStartBriefScoring = async () => {
    if (!activeTab || briefScoring.isScoring) return;
    flushSave();

    const effectiveBriefText = briefScoring.inputMode === 'text'
      ? briefScoring.manualText.trim()
      : briefScoring.briefText.trim();

    if (!effectiveBriefText) {
      setBriefScoring((prev) => ({
        ...prev,
        error: briefScoring.inputMode === 'text'
          ? 'Введите описание целевой аудитории'
          : 'Загрузите PDF бриф',
      }));
      return;
    }

    const tabSnapshot = activeTab;
    const rowsToProcess: { rowIndex: number; data: Record<string, string> }[] = [];
    for (let i = 1; i < tabSnapshot.data.length; i += 1) {
      const row = tabSnapshot.data[i];
      if (isRowEmpty(row)) continue;

      const rowData: Record<string, string> = {};
      let fieldsAdded = 0;
      const addField = (header: string, rawValue: string) => {
        if (fieldsAdded >= BRIEF_SCORING_MAX_FIELDS_PER_ROW) return;
        const value = rawValue.trim();
        if (!value) return;
        if (rowData[header]) return;
        rowData[header] = value.length > BRIEF_SCORING_MAX_CELL_CHARS
          ? value.slice(0, BRIEF_SCORING_MAX_CELL_CHARS)
          : value;
        fieldsAdded += 1;
      };

      for (let c = 0; c < tabSnapshot.data[0].length; c += 1) {
        const header = (headerLabels[c] || toColumnLabel(c)).trim();
        if (!header) continue;
        const headerLower = header.toLowerCase();
        const isHinted = HEADER_LABEL_HINT_REGEX.test(headerLower) || COMPANY_HEADER_REGEX.test(headerLower);
        if (!isHinted) continue;
        addField(header, row[c] ?? '');
      }

      if (Object.keys(rowData).length === 0) {
        for (let c = 0; c < tabSnapshot.data[0].length; c += 1) {
          const header = (headerLabels[c] || toColumnLabel(c)).trim();
          if (!header) continue;
          addField(header, row[c] ?? '');
        }
      }

      if (Object.keys(rowData).length === 0) continue;
      rowsToProcess.push({ rowIndex: i, data: rowData });
    }

    if (rowsToProcess.length === 0) {
      setBriefScoring((prev) => ({ ...prev, error: 'Нет данных для оценки' }));
      return;
    }

    const currentToken = await getFreshToken();
    if (!currentToken) {
      setBriefScoring((prev) => ({ ...prev, error: 'Необходима авторизация' }));
      return;
    }

    const scoreColIndex = tabSnapshot.data[0].length;
    const reasonColIndex = scoreColIndex + 1;
    const throwIfPayloadTooLarge = (status: number, stage: string) => {
      if (status !== 413) return;
      throw new Error(
        `Слишком большой объем данных при ${stage}. Попробуйте уменьшить число столбцов/длину текста и повторить.`,
      );
    };

    let stagedJobId: string | null = null;
    try {
      setBriefScoring((prev) => ({
        ...prev,
        isOpen: false,
        isScoring: true,
        totalRows: rowsToProcess.length,
        currentRow: 0,
        progress: 0,
        error: null,
        jobId: null,
      }));

      const startRes = await fetch('/api/brief-scoring/jobs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${currentToken}`,
        },
        body: JSON.stringify({
          briefText: effectiveBriefText,
          total: rowsToProcess.length,
          mode: 'staged',
        }),
      });
      throwIfPayloadTooLarge(startRes.status, 'создании задачи');

      const startData = await parseJsonResponse<{
        job_id?: string;
        total?: number;
        processed?: number;
        error?: string;
      }>(startRes, 'brief_scoring.start');

      if (!startRes.ok || !startData.job_id) {
        throw new Error(startData.error ?? 'Не удалось создать задачу');
      }
      stagedJobId = startData.job_id;
      setBriefScoring((prev) => ({
        ...prev,
        isOpen: false,
        jobId: stagedJobId,
      }));

      let uploaded = 0;
      for (let i = 0; i < rowsToProcess.length; i += BRIEF_SCORING_ENQUEUE_CHUNK_SIZE) {
        const chunk = rowsToProcess.slice(i, i + BRIEF_SCORING_ENQUEUE_CHUNK_SIZE);
        const appendRes = await fetch('/api/brief-scoring/jobs', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${currentToken}`,
          },
          body: JSON.stringify({
            job_id: stagedJobId,
            companies: chunk.map((row) => ({ idx: row.rowIndex, data: row.data })),
          }),
        });
        throwIfPayloadTooLarge(appendRes.status, 'загрузке данных');
        const appendData = await parseJsonResponse<{ error?: string }>(appendRes, 'brief_scoring.enqueue');
        if (!appendRes.ok) {
          throw new Error(appendData.error ?? 'Не удалось загрузить часть данных для оценки');
        }

        uploaded += chunk.length;
        setBriefScoring((prev) => ({
          ...prev,
          currentRow: uploaded,
          totalRows: rowsToProcess.length,
          progress: rowsToProcess.length > 0 ? Math.round((uploaded / rowsToProcess.length) * 100) : 0,
        }));
      }

      const finalizeRes = await fetch('/api/brief-scoring/jobs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${currentToken}`,
        },
        body: JSON.stringify({
          job_id: stagedJobId,
          finalize: true,
          total: rowsToProcess.length,
        }),
      });
      throwIfPayloadTooLarge(finalizeRes.status, 'финализации задачи');

      const finalizeData = await parseJsonResponse<{
        job_id?: string;
        total?: number;
        processed?: number;
        error?: string;
      }>(finalizeRes, 'brief_scoring.finalize');
      if (!finalizeRes.ok || !finalizeData.job_id) {
        throw new Error(finalizeData.error ?? 'Не удалось подготовить задачу к запуску');
      }

      const jobId = finalizeData.job_id;
      const total = finalizeData.total ?? rowsToProcess.length;
      const processed = finalizeData.processed ?? 0;
      const safeProcessed = Math.min(processed, total);

      setUndoSnapshot('Оценка ЦА');

      const baseData = tabSnapshot.data.map((row, rowIndex) => {
        const nextRow = [...row];
        while (nextRow.length <= reasonColIndex) nextRow.push('');
        if (rowIndex === 0) {
          nextRow[scoreColIndex] = 'ЦА Балл';
          nextRow[reasonColIndex] = 'ЦА Причина';
        }
        return nextRow;
      });

      setTabs((prev) =>
        prev.map((tab) => (tab.id === activeTabId ? { ...tab, data: baseData } : tab)),
      );

      if (highlightTimeoutRef.current) clearTimeout(highlightTimeoutRef.current);
      setHighlightedCol(scoreColIndex);
      highlightTimeoutRef.current = setTimeout(
        () => setHighlightedCol(null),
        BRIEF_SCORING_HIGHLIGHT_DURATION,
      );

      if (tableWrapperRef.current) {
        const wrapper = tableWrapperRef.current;
        requestAnimationFrame(() => wrapper.scrollTo({ left: wrapper.scrollWidth, behavior: 'smooth' }));
      }

      setBriefScoring((prev) => ({
        ...prev,
        isScoring: true,
        isOpen: false,
        totalRows: total,
        currentRow: safeProcessed,
        progress: total > 0 ? Math.round((safeProcessed / total) * 100) : 0,
        error: null,
        jobId,
      }));
      upsertBriefScoringRun({
        jobId,
        tabId: activeTabId,
        scoreCol: scoreColIndex,
        reasonCol: reasonColIndex,
        totalRows: total,
        startedAt: new Date().toISOString(),
      });

      await runBriefScoringPolling({
        jobId,
        tabId: activeTabId,
        scoreColIndex,
        reasonColIndex,
        totalRowsFallback: total,
        initialToken: currentToken,
      });
    } catch (err) {
      if (stagedJobId) {
        try {
          await fetch(`/api/brief-scoring/jobs/${stagedJobId}`, {
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${currentToken}`,
            },
            body: JSON.stringify({ action: 'cancel' }),
          });
        } catch {
          // best-effort cleanup
        }
      }
      if (stagedJobId) {
        removeBriefScoringRun(stagedJobId);
      }
      setBriefScoring((prev) => ({
        ...prev,
        error: err instanceof Error ? err.message : 'Произошла ошибка',
        isScoring: false,
        isOpen: true,
        jobId: null,
      }));
    }
  };

  // ── Site Availability (Проверка сайтов) ──────────────────────────────

  const openSiteAvailabilityModal = () => {
    setSiteAvailability({
      isOpen: true,
      sourceCol: 0,
      isChecking: false,
      progress: 0,
      totalRows: 0,
      currentRow: 0,
      error: null,
    });
  };

  const closeSiteAvailabilityModal = () => {
    if (siteAvailabilityAbortRef.current) {
      siteAvailabilityAbortRef.current.abort();
      siteAvailabilityAbortRef.current = null;
    }
    setSiteAvailability((prev) => ({
      ...prev,
      isOpen: false,
      isChecking: false,
      error: null,
    }));
  };

  const handleStartSiteAvailability = async () => {
    if (!activeTab || siteAvailability.isChecking) return;
    flushSave();

    const rowsToProcess: { rowIndex: number; url: string }[] = [];
    for (let i = 1; i < activeTab.data.length; i++) {
      const rawUrl = activeTab.data[i][siteAvailability.sourceCol]?.trim();
      if (rawUrl) rowsToProcess.push({ rowIndex: i, url: rawUrl });
    }

    if (rowsToProcess.length === 0) {
      setSiteAvailability((prev) => ({
        ...prev,
        error: 'Нет данных для проверки в выбранной колонке',
      }));
      return;
    }

    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    if (!token) {
      setSiteAvailability((prev) => ({
        ...prev,
        error: 'Необходима авторизация',
      }));
      return;
    }

    siteAvailabilityAbortRef.current = new AbortController();

    setSiteAvailability((prev) => ({
      ...prev,
      isChecking: true,
      progress: 0,
      totalRows: rowsToProcess.length,
      currentRow: 0,
      error: null,
    }));

    setUndoSnapshot('Проверка сайтов');

    const statusColIndex = activeTab.data[0].length;
    const detailsColIndex = statusColIndex + 1;

    const baseData = activeTab.data.map((row, rowIndex) => {
      const nextRow = [...row];
      while (nextRow.length <= detailsColIndex) nextRow.push('');
      if (rowIndex === 0) {
        nextRow[statusColIndex] = 'Сайт Статус';
        nextRow[detailsColIndex] = 'Сайт Детали';
      }
      return nextRow;
    });

    setTabs((prev) =>
      prev.map((tab) => (tab.id === activeTabId ? { ...tab, data: baseData } : tab)),
    );

    if (highlightTimeoutRef.current) clearTimeout(highlightTimeoutRef.current);
    setHighlightedCol(statusColIndex);
    highlightTimeoutRef.current = setTimeout(
      () => setHighlightedCol(null),
      SITE_AVAILABILITY_HIGHLIGHT_DURATION,
    );

    if (tableWrapperRef.current) {
      const wrapper = tableWrapperRef.current;
      requestAnimationFrame(() => wrapper.scrollTo({ left: wrapper.scrollWidth, behavior: 'smooth' }));
    }

    let processedCount = 0;
    let errorCount = 0;
    let lastBatchError: string | null = null;

    try {
      for (let batchStart = 0; batchStart < rowsToProcess.length; batchStart += SITE_AVAILABILITY_BATCH_SIZE) {
        if (siteAvailabilityAbortRef.current?.signal.aborted) throw new Error('Отменено пользователем');

        const batch = rowsToProcess.slice(batchStart, batchStart + SITE_AVAILABILITY_BATCH_SIZE);
        const sites = batch.map((item) => ({ idx: item.rowIndex, url: item.url }));

        type SiteCheck = {
          idx: number;
          status: string;
          code: number;
          finalUrl: string;
          durationMs: number;
          error: string | null;
        };

        let resData: { results?: SiteCheck[]; error?: string } | null = null;

        for (let attempt = 0; attempt <= SITE_AVAILABILITY_MAX_RETRIES; attempt += 1) {
          if (siteAvailabilityAbortRef.current?.signal.aborted) {
            throw new Error('Отменено пользователем');
          }

          let response: Response;
          try {
            response = await fetch('/api/site-availability/check', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
              body: JSON.stringify({ sites }),
              signal: siteAvailabilityAbortRef.current?.signal,
            });
          } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
              throw error;
            }
            if (attempt < SITE_AVAILABILITY_MAX_RETRIES) {
              const retryDelay =
                SITE_AVAILABILITY_RETRY_BASE_DELAY * Math.pow(2, attempt) +
                Math.floor(Math.random() * 300);
              await sleep(retryDelay);
              continue;
            }
            throw new Error('Не удалось отправить запрос к API');
          }

          let parsed: { results?: SiteCheck[]; error?: string } | null = null;
          try {
            parsed = (await response.json()) as { results?: SiteCheck[]; error?: string };
          } catch {
            parsed = null;
          }

          if (response.ok && parsed && Array.isArray(parsed.results)) {
            resData = parsed;
            break;
          }

          const shouldRetry = [429, 500, 502, 503, 504].includes(response.status);
          const errorMessage = parsed?.error || `Ошибка API (${response.status})`;

          if (shouldRetry && attempt < SITE_AVAILABILITY_MAX_RETRIES) {
            const retryDelay =
              SITE_AVAILABILITY_RETRY_BASE_DELAY * Math.pow(2, attempt) +
              Math.floor(Math.random() * 300);
            await sleep(retryDelay);
            continue;
          }

          resData = { error: errorMessage };
          break;
        }

        if (!resData) {
          throw new Error('Не удалось получить ответ от API');
        }

        if (resData.error) {
          lastBatchError = resData.error;
          errorCount += batch.length;
          setTabs((prev) =>
            prev.map((tab) => {
              if (tab.id !== activeTabId) return tab;
              const nextData = tab.data.map((row, idx) => {
                if (!batch.find((b) => b.rowIndex === idx)) return row;
                const nextRow = [...row];
                while (nextRow.length <= detailsColIndex) nextRow.push('');
                nextRow[statusColIndex] = '⚠';
                nextRow[detailsColIndex] = resData?.error || 'Ошибка API';
                return nextRow;
              });
              return { ...tab, data: nextData };
            }),
          );
        } else if (resData.results) {
          const resultMap = new Map<number, SiteCheck>();
          for (const result of resData.results) resultMap.set(result.idx, result);

          setTabs((prev) =>
            prev.map((tab) => {
              if (tab.id !== activeTabId) return tab;
              const nextData = tab.data.map((row, idx) => {
                const result = resultMap.get(idx);
                if (!result) {
                  if (batch.find((b) => b.rowIndex === idx)) {
                    errorCount += 1;
                    const nextRow = [...row];
                    while (nextRow.length <= detailsColIndex) nextRow.push('');
                    nextRow[statusColIndex] = '?';
                    nextRow[detailsColIndex] = 'Нет данных от API';
                    return nextRow;
                  }
                  return row;
                }

                const nextRow = [...row];
                while (nextRow.length <= detailsColIndex) nextRow.push('');
                const details: string[] = [];
                if (result.code > 0) details.push(`Код ${result.code}`);
                if (result.durationMs > 0) details.push(`${result.durationMs} мс`);
                if (result.finalUrl) details.push(result.finalUrl);
                if (result.error) details.push(`Ошибка: ${result.error}`);
                nextRow[statusColIndex] = result.status;
                nextRow[detailsColIndex] = details.join(' | ');
                return nextRow;
              });
              return { ...tab, data: nextData };
            }),
          );
        }

        processedCount += batch.length;
        setSiteAvailability((prev) => ({
          ...prev,
          currentRow: processedCount,
          progress: Math.round((processedCount / rowsToProcess.length) * 100),
        }));

        if (batchStart + SITE_AVAILABILITY_BATCH_SIZE < rowsToProcess.length) await sleep(350);
      }

      const successCount = processedCount - errorCount;
      setLastAction({
        message: errorCount > 0
          ? `Проверка сайтов: ${successCount} успешно, ${errorCount} с ошибками`
          : `Проверка сайтов завершена: ${processedCount} строк`,
        time: Date.now(),
      });

      if (errorCount > 0 && successCount === 0) {
        setSiteAvailability((prev) => ({
          ...prev,
          isChecking: false,
          error: lastBatchError
            ? `Проверка не выполнена: ${lastBatchError}`
            : 'Проверка не выполнена: произошла ошибка на стороне API',
        }));
      } else {
        setSiteAvailability((prev) => ({ ...prev, isChecking: false, isOpen: false }));
      }
    } catch (err) {
      if (err instanceof Error && (err.name === 'AbortError' || err.message === 'Отменено пользователем')) {
        setLastAction({
          message: `Проверка сайтов отменена (обработано: ${processedCount})`,
          time: Date.now(),
        });
        setSiteAvailability((prev) => ({ ...prev, isChecking: false, isOpen: false }));
      } else {
        setSiteAvailability((prev) => ({
          ...prev,
          isChecking: false,
          error: err instanceof Error ? err.message : 'Произошла ошибка',
        }));
      }
    } finally {
      siteAvailabilityAbortRef.current = null;
    }
  };

  // ── Email Split (Разделение почт) ──────────────────────────────

  const openEmailSplitModal = () => {
    setEmailSplit({ isOpen: true, sourceCol: 0 });
  };

  const closeEmailSplitModal = () => {
    setEmailSplit((prev) => ({ ...prev, isOpen: false }));
  };

  const handleSplitEmails = () => {
    if (!activeTab) return;
    const data = activeTab.data;
    const header = hasHeaderRow(data) ? data[0] : null;
    const body = header ? data.slice(1) : data;
    const col = emailSplit.sourceCol;

    const newRows: string[][] = [];
    let splitCount = 0;

    for (const row of body) {
      const cellValue = (row[col] ?? '').trim();
      if (!cellValue) {
        newRows.push(row);
        continue;
      }

      const emails = cellValue
        .split(/[,;\s]+/)
        .map((e) => e.trim())
        .filter((e) => e.length > 0);

      if (emails.length <= 1) {
        newRows.push(row);
        continue;
      }

      splitCount += 1;
      for (const email of emails) {
        const newRow = [...row];
        newRow[col] = email;
        newRows.push(newRow);
      }
    }

    if (splitCount === 0) {
      setLastAction({ message: 'Нет строк с несколькими почтами для разделения', time: Date.now() });
      closeEmailSplitModal();
      return;
    }

    const totalNewRows = newRows.length - body.length;
    setUndoSnapshot(`Разделение почт (${splitCount} строк → +${totalNewRows} новых)`);
    applyRows(header ? [header, ...newRows] : newRows);
    setLastAction({
      message: `Разделено ${splitCount} строк, добавлено ${totalNewRows} новых строк`,
      time: Date.now(),
    });
    closeEmailSplitModal();
  };

  // ── Phone Split (Разделение телефонов) ──────────────────────────────

  const openPhoneSplitModal = () => {
    setPhoneSplit({ isOpen: true, sourceCol: 0 });
  };

  const closePhoneSplitModal = () => {
    setPhoneSplit((prev) => ({ ...prev, isOpen: false }));
  };

  const splitPhoneCell = (cell: string): string[] => {
    const trimmed = cell.trim();
    if (!trimmed) return [];

    const parts = trimmed
      .split(/[,;]\s*/)
      .flatMap((part) => {
        const inner = part.trim();
        if (!inner) return [];
        const multiPlus = inner.split(/(?<=\d)\s+(?=\+)/).map((s) => s.trim()).filter(Boolean);
        if (multiPlus.length > 1) return multiPlus;
        return [inner];
      })
      .filter((p) => p.length > 0);

    return parts;
  };

  const handleSplitPhones = () => {
    if (!activeTab) return;
    const data = activeTab.data;
    const header = hasHeaderRow(data) ? data[0] : null;
    const body = header ? data.slice(1) : data;
    const col = phoneSplit.sourceCol;

    const newRows: string[][] = [];
    let splitCount = 0;

    for (const row of body) {
      const cellValue = (row[col] ?? '').trim();
      if (!cellValue) {
        newRows.push(row);
        continue;
      }

      const phones = splitPhoneCell(cellValue);

      if (phones.length <= 1) {
        newRows.push(row);
        continue;
      }

      splitCount += 1;
      for (const phone of phones) {
        const newRow = [...row];
        newRow[col] = phone;
        newRows.push(newRow);
      }
    }

    if (splitCount === 0) {
      setLastAction({ message: 'Нет строк с несколькими телефонами для разделения', time: Date.now() });
      closePhoneSplitModal();
      return;
    }

    const totalNewRows = newRows.length - body.length;
    setUndoSnapshot(`Разделение телефонов (${splitCount} строк → +${totalNewRows} новых)`);
    applyRows(header ? [header, ...newRows] : newRows);
    setLastAction({
      message: `Разделено ${splitCount} строк, добавлено ${totalNewRows} новых строк`,
      time: Date.now(),
    });
    closePhoneSplitModal();
  };

  // ── Email Scraping (Найти почты) ──────────────────────────────

  const openEmailScrapingModal = () => {
    setEmailScraping((prev) => ({ ...prev, isOpen: true, sourceCol: 0, error: null }));
  };

  const closeEmailScrapingModal = () => {
    setEmailScraping((prev) => ({ ...prev, isOpen: false }));
  };

  const handleStopEmailScraping = async () => {
    if (!emailScraping.isGenerating || !emailScraping.jobId) return;
    if (!window.confirm('Остановить поиск почт? Прогресс не сохранится.')) return;
    const jobId = emailScraping.jobId;
    if (emailScrapingAbortRef.current) emailScrapingAbortRef.current.abort();

    const token = await getFreshToken();
    if (token) {
      try {
        await fetch(`/api/enrich/website/jobs/${jobId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ status: 'cancelled' }),
        });
      } catch { /* ignore */ }
    }
    setEmailScraping((prev) => ({ ...prev, isGenerating: false, isOpen: false, jobId: null }));
    setLastAction({ message: 'Поиск почт остановлен', time: Date.now() });
  };

  const handleStartEmailScraping = async () => {
    if (!activeTab || emailScraping.isGenerating) return;

    const rowsToProcess: { rowIndex: number; sourceValue: string }[] = [];
    for (let i = 1; i < activeTab.data.length; i++) {
      const row = activeTab.data[i];
      const sourceValue = String(row?.[emailScraping.sourceCol] ?? '').trim();
      if (!sourceValue) continue;
      rowsToProcess.push({ rowIndex: i, sourceValue });
    }

    if (rowsToProcess.length === 0) {
      setEmailScraping((prev) => ({ ...prev, error: 'Нет данных в выбранной колонке' }));
      return;
    }

    const currentToken = await getFreshToken();
    if (!currentToken) {
      setEmailScraping((prev) => ({ ...prev, error: 'Необходима авторизация' }));
      return;
    }

    emailScrapingAbortRef.current = new AbortController();

    setEmailScraping((prev) => ({
      ...prev,
      isGenerating: true,
      progress: 0,
      totalRows: rowsToProcess.length,
      currentRow: 0,
      error: null,
    }));

    setUndoSnapshot('Поиск почт с сайтов');

    // Create the "Email" column
    const sourceLabel = headerLabels[emailScraping.sourceCol] || toColumnLabel(emailScraping.sourceCol);
    const newHeaderName = `Email (${sourceLabel})`;
    const startCol = emailScraping.sourceCol + 1;
    const isColumnEmpty = (colIndex: number) =>
      activeTab.data.every((row) => (row[colIndex] ?? '').trim().length === 0);

    let newColIndex = startCol;
    while (!isColumnEmpty(newColIndex)) newColIndex += 1;

    const baseData = activeTab.data.map((row, rowIndex) => {
      const nextRow = [...row];
      while (nextRow.length <= newColIndex) nextRow.push('');
      if (rowIndex === 0) nextRow[newColIndex] = newHeaderName;
      return nextRow;
    });

    setTabs((prev) => prev.map((tab) => (tab.id === activeTabId ? { ...tab, data: baseData } : tab)));

    if (highlightTimeoutRef.current) clearTimeout(highlightTimeoutRef.current);
    setHighlightedCol(newColIndex);
    highlightTimeoutRef.current = setTimeout(() => setHighlightedCol(null), ENRICHMENT_HIGHLIGHT_DURATION);

    if (tableWrapperRef.current) {
      const wrapper = tableWrapperRef.current;
      requestAnimationFrame(() => wrapper.scrollTo({ left: wrapper.scrollWidth, behavior: 'smooth' }));
    }

    try {
      const startRes = await fetch('/api/enrich/website/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${currentToken}` },
        body: JSON.stringify({
          rows: rowsToProcess.map((row) => ({ rowIndex: row.rowIndex, url: row.sourceValue })),
          extraction_type: 'email',
        }),
        signal: emailScrapingAbortRef.current?.signal,
      });

      const startData = await parseJsonResponse<{
        job_id?: string; total?: number; processed?: number; error_count?: number; error?: string;
      }>(startRes, 'email_scraping.start');

      if (!startRes.ok || !startData.job_id) {
        throw new Error(startData.error ?? 'Не удалось создать задачу');
      }

      const jobId = startData.job_id;
      const total = startData.total ?? rowsToProcess.length;
      const processedCount = startData.processed ?? 0;

      setEmailScraping((prev) => ({
        ...prev,
        isOpen: false,
        isGenerating: true,
        totalRows: total,
        currentRow: Math.min(processedCount, total),
        progress: total > 0 ? Math.round((Math.min(processedCount, total) / total) * 100) : 0,
        jobId,
        error: null,
      }));

      // Poll for results — reuse the same enrichment polling pattern
      let cursor: string | null = null;
      let consecutiveErrors = 0;
      let lastProgressTime = Date.now();
      let token = currentToken;
      let lastProcessed = processedCount;
      const signal = emailScrapingAbortRef.current?.signal;
      const pendingUpdates: Map<number, string> = new Map();
      let flushTimer: ReturnType<typeof setTimeout> | null = null;

      const flushUpdates = () => {
        if (pendingUpdates.size === 0) return;
        const batch = new Map(pendingUpdates);
        pendingUpdates.clear();
        setTabs((prev) => prev.map((tab) => {
          if (tab.id !== activeTabId) return tab;
          const data = tab.data.map((row, ri) => {
            const value = batch.get(ri);
            if (value === undefined) return row;
            const nextRow = [...row];
            while (nextRow.length <= newColIndex) nextRow.push('');
            nextRow[newColIndex] = value;
            return nextRow;
          });
          return { ...tab, data };
        }));
      };

      const scheduleFlush = () => {
        if (flushTimer) return;
        flushTimer = setTimeout(() => { flushTimer = null; flushUpdates(); }, ENRICHMENT_UPDATE_FLUSH_MS);
      };

      try {
        while (!signal?.aborted) {
          const fetchResults = async (tkn: string) =>
            fetch(
              `/api/enrich/website/jobs/${jobId}/results?${cursor ? `cursor=${encodeURIComponent(cursor)}&` : ''}limit=500`,
              { headers: { Authorization: `Bearer ${tkn}` }, signal },
            );

          let res = await fetchResults(token);
          if (res.status === 401) {
            const refreshed = await getFreshToken();
            if (refreshed) { token = refreshed; res = await fetchResults(token); }
            else throw new Error('Сессия истекла. Войдите заново.');
          }

          if (!res.ok) {
            consecutiveErrors += 1;
            if (consecutiveErrors >= ENRICHMENT_MAX_CONSECUTIVE_FAILURES) {
              throw new Error(`Слишком много ошибок API (${consecutiveErrors})`);
            }
            await new Promise((r) => setTimeout(r, 1500));
            continue;
          }
          consecutiveErrors = 0;

          const data = await parseJsonResponse<{
            job: { status: string; processed: number; total: number; success_count: number; error_count: number };
            results: Array<{ row_index: number; result_text: string | null; status: string }>;
            next_cursor?: string | null;
          }>(res, 'email_scraping.results');

          if (data.results?.length) {
            for (const result of data.results) {
              if (result.status === 'completed' && result.result_text) {
                pendingUpdates.set(result.row_index, result.result_text);
              }
            }
            scheduleFlush();
            if (pendingUpdates.size >= ENRICHMENT_UPDATE_BATCH) flushUpdates();
            lastProgressTime = Date.now();
          }

          if (data.next_cursor) cursor = data.next_cursor;

          const processed = data.job?.processed ?? 0;
          const jobTotal = data.job?.total ?? total;
          if (processed > lastProcessed) {
            lastProcessed = processed;
            lastProgressTime = Date.now();
          }
          setEmailScraping((prev) => ({
            ...prev,
            currentRow: Math.min(processed, jobTotal),
            progress: jobTotal > 0 ? Math.round((Math.min(processed, jobTotal) / jobTotal) * 100) : 0,
          }));

          if (['completed', 'failed', 'cancelled'].includes(data.job?.status)) {
            flushUpdates();
            break;
          }

          if (Date.now() - lastProgressTime > EMAIL_SCRAPING_STALL_TIMEOUT_MS) {
            throw new Error('Поиск почт не продвигается более 10 минут');
          }

          await new Promise((r) => setTimeout(r, ENRICHMENT_PROGRESS_INTERVAL_MS));
        }
      } finally {
        if (flushTimer) clearTimeout(flushTimer);
        flushUpdates();
      }

      setEmailScraping((prev) => ({ ...prev, isGenerating: false, jobId: null }));
      setLastAction({ message: `Поиск почт завершён`, time: Date.now() });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        setLastAction({ message: 'Поиск почт отменён', time: Date.now() });
        setEmailScraping((prev) => ({ ...prev, isGenerating: false, isOpen: false, jobId: null }));
      } else {
        setEmailScraping((prev) => ({
          ...prev,
          error: err instanceof Error ? err.message : 'Произошла ошибка',
          isGenerating: false,
          jobId: null,
        }));
      }
    } finally {
      emailScrapingAbortRef.current = null;
    }
  };

  // ── Email Validation (Валидация почт) ──────────────────────────────

  const openEmailValidationModal = async () => {
    setEmailValidation((prev) => ({ ...prev, isOpen: true, sourceCol: 0, error: null, detectedJob: null }));
    const token = await getFreshToken();
    if (!token) return;
    try {
      const res = await fetch('/api/email-validation/jobs', { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) {
        const data = await res.json() as { active_job?: { id: string; total: number; processed: number; progress: number } | null };
        if (data.active_job) {
          setEmailValidation((prev) => ({ ...prev, detectedJob: data.active_job! }));
        }
      }
    } catch { /* ignore */ }
  };

  const closeEmailValidationModal = () => {
    setEmailValidation((prev) => ({ ...prev, isOpen: false }));
  };

  const handleStopEmailValidation = async () => {
    if (!emailValidation.isValidating || !emailValidation.jobId) return;
    if (!window.confirm('Остановить валидацию почт? Уже проверенные результаты сохранятся.')) return;
    const jobId = emailValidation.jobId;
    if (emailValidationAbortRef.current) emailValidationAbortRef.current.abort();

    const token = await getFreshToken();
    if (token) {
      try {
        await fetch(`/api/email-validation/jobs/${jobId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ action: 'cancel' }),
        });
      } catch { /* ignore */ }
    }
    setEmailValidation((prev) => ({ ...prev, isValidating: false, isOpen: false, jobId: null }));
    setLastAction({ message: 'Валидация почт остановлена', time: Date.now() });
  };

  const handleResumeEmailValidation = async () => {
    if (!activeTab || emailValidation.isValidating || !emailValidation.detectedJob) return;

    const detected = emailValidation.detectedJob;
    const currentToken = await getFreshToken();
    if (!currentToken) {
      setEmailValidation((prev) => ({ ...prev, error: 'Необходима авторизация' }));
      return;
    }

    emailValidationAbortRef.current = new AbortController();
    const signal = emailValidationAbortRef.current.signal;

    const headerRow = activeTab.data[0] ?? [];
    let resultColIndex = headerRow.findIndex((h) => String(h).startsWith('Результат ('));
    if (resultColIndex < 0) resultColIndex = headerRow.length;
    const qualityColIndex = resultColIndex + 1;
    const detailsColIndex = resultColIndex + 2;

    const baseData = activeTab.data.map((row, rowIdx) => {
      const extended = [...row];
      while (extended.length <= detailsColIndex) extended.push('');
      if (rowIdx === 0 && !String(extended[resultColIndex]).startsWith('Результат')) {
        extended[resultColIndex] = 'Результат (email)';
        extended[qualityColIndex] = 'Качество';
        extended[detailsColIndex] = 'Детали';
      }
      return extended;
    });

    setTabs((prev) => prev.map((t) => (t.id === activeTab.id ? { ...t, data: baseData } : t)));
    setEmailValidation((prev) => ({
      ...prev,
      isOpen: false,
      isValidating: true,
      jobId: detected.id,
      totalRows: detected.total,
      currentRow: detected.processed,
      progress: detected.progress,
      error: null,
      detectedJob: null,
    }));

    const RESULT_LABELS: Record<string, string> = {
      ok: 'OK', invalid: 'Невалидный', disposable: 'Одноразовый',
      catch_all: 'Catch-All', unknown: 'Неизвестно',
    };
    const QUALITY_LABELS: Record<string, string> = {
      good: 'Хороший', bad: 'Плохой', risky: 'Рискованный',
    };

    try {
      let resultCursor: string | null = null;
      let consecutiveErrors = 0;
      let lastProgressTime = Date.now();
      let token = currentToken;

      while (true) {
        if (signal?.aborted) throw new Error('AbortError');
        await new Promise((r) => setTimeout(r, EMAIL_VALIDATION_PROGRESS_INTERVAL_MS));

        const fetchResults = (tkn: string) =>
          fetch(
            `/api/email-validation/jobs/${detected.id}/results?cursor=${encodeURIComponent(resultCursor ?? '')}&limit=500`,
            { headers: { Authorization: `Bearer ${tkn}` }, signal },
          );

        let res = await fetchResults(token);
        if (res.status === 401) {
          const refreshed = await getFreshToken();
          if (refreshed) { token = refreshed; res = await fetchResults(token); }
          else throw new Error('Сессия истекла. Войдите заново.');
        }

        if (!res.ok) {
          consecutiveErrors += 1;
          if (consecutiveErrors >= EMAIL_VALIDATION_MAX_CONSECUTIVE_FAILURES) throw new Error('Слишком много ошибок API подряд');
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }
        consecutiveErrors = 0;

        const data = await parseJsonResponse<{
          job: { status: string; processed: number; total: number; success_count: number; error_count: number };
          results: Array<{
            row_index: number; result: string | null; quality: string | null;
            is_free: boolean; is_role: boolean; is_disposable: boolean; is_catch_all: boolean;
            did_you_mean: string | null; status: string; last_error: string | null;
          }>;
          next_cursor?: string | null;
        }>(res, 'email_validation.results');

        if (data.results && data.results.length > 0) {
          lastProgressTime = Date.now();
          setTabs((prev) =>
            prev.map((t) => {
              if (t.id !== activeTab.id) return t;
              const newData = t.data.map((row) => [...row]);
              for (const r of data.results) {
                if (r.row_index >= 0 && r.row_index < newData.length) {
                  while (newData[r.row_index].length <= detailsColIndex) newData[r.row_index].push('');
                  newData[r.row_index][resultColIndex] = r.result ? (RESULT_LABELS[r.result] || r.result) : (r.last_error ?? 'Ошибка');
                  newData[r.row_index][qualityColIndex] = r.quality ? (QUALITY_LABELS[r.quality] || r.quality) : '';
                  const detailParts: string[] = [];
                  if (r.is_free) detailParts.push('Free');
                  if (r.is_role) detailParts.push('Role');
                  if (r.is_disposable) detailParts.push('Disposable');
                  if (r.is_catch_all) detailParts.push('Catch-All');
                  if (r.did_you_mean) detailParts.push(`→ ${r.did_you_mean}`);
                  if (r.last_error && (r.status === 'failed' || r.result === 'unknown')) detailParts.push(r.last_error);
                  newData[r.row_index][detailsColIndex] = detailParts.join('; ');
                }
              }
              return { ...t, data: newData };
            }),
          );
        }

        if (data.next_cursor) resultCursor = data.next_cursor;

        const processed = data.job?.processed ?? 0;
        const jobTotal = data.job?.total ?? detected.total;
        setEmailValidation((prev) => ({
          ...prev,
          currentRow: Math.min(processed, jobTotal),
          progress: jobTotal > 0 ? Math.round((Math.min(processed, jobTotal) / jobTotal) * 100) : 0,
        }));

        const jobStatus = data.job?.status;
        if (jobStatus === 'completed' || jobStatus === 'failed' || jobStatus === 'cancelled') break;

        if (Date.now() - lastProgressTime > EMAIL_VALIDATION_STALL_TIMEOUT_MS) throw new Error('Валидация зависла: нет прогресса');
      }

      setEmailValidation((prev) => ({ ...prev, isValidating: false, jobId: null }));
      setLastAction({ message: 'Валидация почт завершена', time: Date.now() });
    } catch (err) {
      if (err instanceof Error && (err.name === 'AbortError' || err.message === 'AbortError')) {
        setLastAction({ message: 'Валидация почт отменена', time: Date.now() });
        setEmailValidation((prev) => ({ ...prev, isValidating: false, isOpen: false, jobId: null }));
      } else {
        const errorMsg = err instanceof Error ? err.message : 'Произошла ошибка';
        setEmailValidation((prev) => ({ ...prev, error: errorMsg, isValidating: false, isOpen: true, jobId: null }));
      }
    }
  };

  const handleStartEmailValidation = async () => {
    if (!activeTab || emailValidation.isValidating) return;

    const rowsToProcess: { rowIndex: number; email: string }[] = [];
    for (let i = 1; i < activeTab.data.length; i++) {
      const email = String(activeTab.data[i]?.[emailValidation.sourceCol] ?? '').trim();
      if (!email) continue;
      rowsToProcess.push({ rowIndex: i, email });
    }

    if (rowsToProcess.length === 0) {
      setEmailValidation((prev) => ({ ...prev, error: 'Нет данных в выбранной колонке' }));
      return;
    }

    const currentToken = await getFreshToken();
    if (!currentToken) {
      setEmailValidation((prev) => ({ ...prev, error: 'Необходима авторизация' }));
      return;
    }

    emailValidationAbortRef.current = new AbortController();

    setEmailValidation((prev) => ({
      ...prev,
      isValidating: true,
      progress: 0,
      totalRows: rowsToProcess.length,
      currentRow: 0,
      error: null,
    }));

    setUndoSnapshot('Валидация почт');

    const sourceLabel = headerLabels[emailValidation.sourceCol] || toColumnLabel(emailValidation.sourceCol);
    const headerRow = activeTab.data[0] ?? [];
    let resultColIndex = headerRow.findIndex((h) => String(h).startsWith('Результат ('));
    if (resultColIndex < 0) resultColIndex = headerRow.length;
    const qualityColIndex = resultColIndex + 1;
    const detailsColIndex = resultColIndex + 2;

    const baseData = activeTab.data.map((row, rowIdx) => {
      const extended = [...row];
      while (extended.length <= detailsColIndex) extended.push('');
      if (rowIdx === 0) {
        extended[resultColIndex] = `Результат (${sourceLabel})`;
        extended[qualityColIndex] = `Качество`;
        extended[detailsColIndex] = `Детали`;
      } else {
        extended[resultColIndex] = '';
        extended[qualityColIndex] = '';
        extended[detailsColIndex] = '';
      }
      return extended;
    });

    setTabs((prev) =>
      prev.map((t) => (t.id === activeTab.id ? { ...t, data: baseData } : t)),
    );

    try {
      const CHUNK_SIZE = 5000;
      const signal = emailValidationAbortRef.current?.signal;
      let jobId: string | undefined;
      let totalFromServer = 0;

      for (let chunkStart = 0; chunkStart < rowsToProcess.length; chunkStart += CHUNK_SIZE) {
        if (signal?.aborted) throw new Error('AbortError');

        const chunk = rowsToProcess.slice(chunkStart, chunkStart + CHUNK_SIZE);
        const payload: { rows: typeof chunk; job_id?: string } = { rows: chunk };
        if (jobId) payload.job_id = jobId;

        const chunkRes = await fetch('/api/email-validation/jobs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${currentToken}` },
          body: JSON.stringify(payload),
          signal,
        });

        const chunkData = await parseJsonResponse<{
          job_id?: string; total?: number; processed?: number; error_count?: number; error?: string;
        }>(chunkRes, 'email_validation.start');

        if (!chunkRes.ok || !chunkData.job_id) {
          throw new Error(chunkData.error ?? 'Не удалось создать задачу валидации');
        }

        jobId = chunkData.job_id;
        totalFromServer = chunkData.total ?? rowsToProcess.length;

        setEmailValidation((prev) => ({
          ...prev,
          isOpen: false,
          isValidating: true,
          jobId: jobId!,
          totalRows: totalFromServer,
          currentRow: chunkData.processed ?? 0,
          progress: 0,
        }));
      }

      const total = totalFromServer;

      // Poll for results
      let resultCursor: string | null = null;
      let consecutiveErrors = 0;
      let lastProgressTime = Date.now();
      let token = currentToken;

      const RESULT_LABELS: Record<string, string> = {
        ok: 'OK', invalid: 'Невалидный', disposable: 'Одноразовый',
        catch_all: 'Catch-All', unknown: 'Неизвестно',
      };
      const QUALITY_LABELS: Record<string, string> = {
        good: 'Хороший', bad: 'Плохой', risky: 'Рискованный',
      };

      while (true) {
        if (signal?.aborted) throw new Error('AbortError');
        await new Promise((r) => setTimeout(r, EMAIL_VALIDATION_PROGRESS_INTERVAL_MS));

        const fetchResults = (tkn: string) =>
          fetch(
            `/api/email-validation/jobs/${jobId}/results?cursor=${encodeURIComponent(resultCursor ?? '')}&limit=500`,
            { headers: { Authorization: `Bearer ${tkn}` }, signal },
          );

        let res = await fetchResults(token);
        if (res.status === 401) {
          const refreshed = await getFreshToken();
          if (refreshed) { token = refreshed; res = await fetchResults(token); }
          else throw new Error('Сессия истекла. Войдите заново.');
        }

        if (!res.ok) {
          consecutiveErrors += 1;
          if (consecutiveErrors >= EMAIL_VALIDATION_MAX_CONSECUTIVE_FAILURES) {
            throw new Error('Слишком много ошибок API подряд');
          }
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }
        consecutiveErrors = 0;

        const data = await parseJsonResponse<{
          job: { status: string; processed: number; total: number; success_count: number; error_count: number };
          results: Array<{
            row_index: number; result: string | null; quality: string | null;
            is_free: boolean; is_role: boolean; is_disposable: boolean; is_catch_all: boolean;
            did_you_mean: string | null; status: string; last_error: string | null;
          }>;
          next_cursor?: string | null;
        }>(res, 'email_validation.results');

        if (data.results && data.results.length > 0) {
          lastProgressTime = Date.now();
          setTabs((prev) =>
            prev.map((t) => {
              if (t.id !== activeTab.id) return t;
              const newData = t.data.map((row) => [...row]);
              for (const r of data.results) {
                if (r.row_index >= 0 && r.row_index < newData.length) {
                  while (newData[r.row_index].length <= detailsColIndex) newData[r.row_index].push('');

                  const resultText = r.result ? (RESULT_LABELS[r.result] || r.result) : (r.last_error ?? 'Ошибка');
                  const qualityText = r.quality ? (QUALITY_LABELS[r.quality] || r.quality) : '';

                  const detailParts: string[] = [];
                  if (r.is_free) detailParts.push('Free');
                  if (r.is_role) detailParts.push('Role');
                  if (r.is_disposable) detailParts.push('Disposable');
                  if (r.is_catch_all) detailParts.push('Catch-All');
                  if (r.did_you_mean) detailParts.push(`→ ${r.did_you_mean}`);
                  if (r.last_error && (r.status === 'failed' || r.result === 'unknown')) detailParts.push(r.last_error);

                  newData[r.row_index][resultColIndex] = resultText;
                  newData[r.row_index][qualityColIndex] = qualityText;
                  newData[r.row_index][detailsColIndex] = detailParts.join('; ');
                }
              }
              return { ...t, data: newData };
            }),
          );
        }

        if (data.next_cursor) resultCursor = data.next_cursor;

        const processed = data.job?.processed ?? 0;
        const jobTotal = data.job?.total ?? total;
        setEmailValidation((prev) => ({
          ...prev,
          currentRow: Math.min(processed, jobTotal),
          progress: jobTotal > 0 ? Math.round((Math.min(processed, jobTotal) / jobTotal) * 100) : 0,
        }));

        const jobStatus = data.job?.status;
        if (jobStatus === 'completed' || jobStatus === 'failed' || jobStatus === 'cancelled') break;

        if (Date.now() - lastProgressTime > EMAIL_VALIDATION_STALL_TIMEOUT_MS) {
          throw new Error('Валидация зависла: нет прогресса');
        }
      }

      setEmailValidation((prev) => ({ ...prev, isValidating: false, jobId: null }));
      setLastAction({ message: `Валидация почт завершена`, time: Date.now() });
    } catch (err) {
      if (err instanceof Error && (err.name === 'AbortError' || err.message === 'AbortError')) {
        setLastAction({ message: 'Валидация почт отменена', time: Date.now() });
        setEmailValidation((prev) => ({ ...prev, isValidating: false, isOpen: false, jobId: null }));
      } else {
        const errorMsg = err instanceof Error ? err.message : 'Произошла ошибка';
        setEmailValidation((prev) => ({
          ...prev,
          error: errorMsg,
          isValidating: false,
          isOpen: true,
          jobId: null,
        }));
        setLastAction({ message: `Валидация почт: ошибка — ${errorMsg}`, time: Date.now() });
      }
    } finally {
      emailValidationAbortRef.current = null;
    }
  };

  // ── Name Cleanup (Очистка названий) ──────────────────────────────

  const handleSubmitForReview = async () => {
    if (!activeTab) return;
    setReviewSubmit((s) => ({ ...s, submitting: true }));
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) { setReviewSubmitToast('Не авторизован'); return; }
      flushSave();
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
      const existingReq = activeReviewReq && reworkStatuses.has(activeReviewReq.status) ? activeReviewReq : null;

      let res: Response;
      if (existingReq) {
        res = await fetch(`/api/database-review/submit`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            tabId: activeTab.id,
            tabName: activeTab.name,
            projectId: reviewSubmit.projectId || undefined,
            comment: reviewSubmit.comment || undefined,
            existingRequestId: existingReq.id,
          }),
        });
      } else {
        res = await fetch('/api/database-review/submit', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            tabId: activeTab.id,
            tabName: activeTab.name,
            projectId: reviewSubmit.projectId || undefined,
            comment: reviewSubmit.comment || undefined,
          }),
        });
      }
      const d = await res.json();
      if (!res.ok) { setReviewSubmitToast(d.error || 'Ошибка отправки'); return; }
      setReviewSubmitToast(existingReq ? 'Переотправлено на проверку!' : 'Отправлено на проверку!');
      setReviewSubmit({ isOpen: false, comment: '', projectId: '', submitting: false });
      setMyReviewRequests((prev) => {
        if (existingReq) {
          return prev.map((r) => r.id === existingReq.id ? { ...r, status: 'submitted', reviewer_comment: '' } : r);
        }
        return [...prev, {
          id: d.request?.id || '',
          tab_id: activeTab.id,
          tab_name: activeTab.name,
          status: 'submitted',
        }];
      });
      setReviewMarks([]);
    } catch {
      setReviewSubmitToast('Ошибка сети');
    } finally {
      setReviewSubmit((s) => ({ ...s, submitting: false }));
    }
  };

  useEffect(() => {
    if (!reviewSubmitToast) return;
    const t = setTimeout(() => setReviewSubmitToast(''), 3000);
    return () => clearTimeout(t);
  }, [reviewSubmitToast]);

  useEffect(() => {
    if (!reviewMarksPopup) return;
    const handler = (e: Event) => {
      const el = document.getElementById('review-marks-popup');
      if (el && !el.contains(e.target as Node)) setReviewMarksPopup(null);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [reviewMarksPopup]);

  const openPublishModal = async (requestId: string) => {
    setReviewPublish({ isOpen: true, requestId, chatId: null, message: '', publishing: false });
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    if (!token) return;
    const res = await fetch('/api/ai-caller/telegram/chats', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const d = await res.json();
    setTgChats((d.chats ?? []).map((c: { id: number; title: string }) => ({ id: c.id, title: c.title })));
  };

  const handlePublishToTelegram = async () => {
    if (!reviewPublish.requestId || !reviewPublish.chatId) return;
    setReviewPublish((s) => ({ ...s, publishing: true }));
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) { setReviewSubmitToast('Не авторизован'); return; }
      const res = await fetch(`/api/database-review/requests/${reviewPublish.requestId}/publish`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: reviewPublish.chatId, message: reviewPublish.message }),
      });
      const d = await res.json();
      if (!res.ok) { setReviewSubmitToast(d.error || 'Ошибка отправки'); return; }
      setReviewSubmitToast('Отправлено клиенту в Telegram!');
      setReviewPublish({ isOpen: false, requestId: '', chatId: null, message: '', publishing: false });
      setMyReviewRequests((prev) =>
        prev.map((r) => r.id === reviewPublish.requestId ? { ...r, status: 'sent_to_client' } : r),
      );
    } catch {
      setReviewSubmitToast('Ошибка сети');
    } finally {
      setReviewPublish((s) => ({ ...s, publishing: false }));
    }
  };

  const openNameCleanupModal = () => {
    setNameCleanup({
      isOpen: true,
      nameCol: 0,
      domainCol: null,
      useDomain: false,
      isProcessing: false,
      progress: 0,
      totalRows: 0,
      currentRow: 0,
      error: null,
    });
  };

  const closeNameCleanupModal = () => {
    if (nameCleanupAbortRef.current) {
      nameCleanupAbortRef.current.abort();
      nameCleanupAbortRef.current = null;
    }
    setNameCleanup((prev) => ({ ...prev, isOpen: false, isProcessing: false }));
  };

  const handleStartNameCleanup = async () => {
    if (!activeTab || nameCleanup.isProcessing) return;
    flushSave();

    let token = '';
    let tokenExpiresAt = 0;
    const TOKEN_REFRESH_SAFETY_MS = 2 * 60 * 1000;

    const loadSessionToken = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) return null;
      token = session.access_token;
      tokenExpiresAt = session.expires_at ? session.expires_at * 1000 : 0;
      return token;
    };

    const refreshAuthToken = async () => {
      const { data: refreshed, error } = await supabase.auth.refreshSession();
      if (error || !refreshed.session?.access_token) return null;
      token = refreshed.session.access_token;
      tokenExpiresAt = refreshed.session.expires_at ? refreshed.session.expires_at * 1000 : 0;
      return token;
    };

    const ensureValidToken = async () => {
      if (!token) {
        const loaded = await loadSessionToken();
        if (!loaded) return null;
      }
      if (tokenExpiresAt && Date.now() > tokenExpiresAt - TOKEN_REFRESH_SAFETY_MS) {
        const refreshed = await refreshAuthToken();
        if (!refreshed) return null;
      }
      return token;
    };

    const dataRows = activeTab.data.slice(1).filter((row) => {
      const nameValue = row[nameCleanup.nameCol]?.trim();
      return nameValue && nameValue.length > 0;
    });

    if (dataRows.length === 0) {
      setNameCleanup((prev) => ({
        ...prev,
        error: 'Нет данных для очистки в выбранной колонке',
      }));
      return;
    }

    // Get a fresh auth token
    const initialToken = await ensureValidToken();
    if (!initialToken) {
      setNameCleanup((prev) => ({ ...prev, error: 'Необходима авторизация' }));
      return;
    }

    nameCleanupAbortRef.current = new AbortController();

    setNameCleanup((prev) => ({
      ...prev,
      isProcessing: true,
      progress: 0,
      totalRows: dataRows.length,
      currentRow: 0,
      error: null,
    }));

    setUndoSnapshot('Очистка названий');

    // Overwrite in the same column instead of creating a new one
    const targetCol = nameCleanup.nameCol;

    // Build the list of rows to process
    const rowsToProcess: { rowIndex: number; name: string; domain?: string }[] = [];
    for (let i = 1; i < activeTab.data.length; i++) {
      const nameValue = activeTab.data[i][nameCleanup.nameCol]?.trim();
      if (nameValue && nameValue.length > 0) {
        const domain = nameCleanup.useDomain && nameCleanup.domainCol !== null
          ? activeTab.data[i][nameCleanup.domainCol]?.trim() || undefined
          : undefined;
        rowsToProcess.push({ rowIndex: i, name: nameValue, domain });
      }
    }

    let processedCount = 0;
    let errorCount = 0;
    let lastBatchError: string | null = null;
    let usedLocalCleanupFallback = false;

    try {
      const batches: typeof rowsToProcess[] = [];
      for (let batchStart = 0; batchStart < rowsToProcess.length; batchStart += NAME_CLEANUP_BATCH_SIZE) {
        batches.push(rowsToProcess.slice(batchStart, batchStart + NAME_CLEANUP_BATCH_SIZE));
      }

      let nextBatchIndex = 0;

      const processBatch = async (batch: typeof rowsToProcess) => {
        if (nameCleanupAbortRef.current?.signal.aborted) {
          throw new Error('Отменено пользователем');
        }

        const companies = batch.map((item) => ({
          idx: item.rowIndex,
          name: item.name,
          domain: item.domain,
        }));

        try {
          const validToken = await ensureValidToken();
          if (!validToken) {
            throw new Error('Необходима авторизация');
          }

          let response = await fetch('/api/cleanup-names', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${validToken}`,
            },
            body: JSON.stringify({ companies }),
            signal: nameCleanupAbortRef.current?.signal,
          });

          if (response.status === 401) {
            const refreshedToken = await refreshAuthToken();
            if (!refreshedToken) {
              throw new Error('Необходима авторизация');
            }
            response = await fetch('/api/cleanup-names', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${refreshedToken}`,
              },
              body: JSON.stringify({ companies }),
              signal: nameCleanupAbortRef.current?.signal,
            });
          }

          if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            const fallbackMessage = response.status === 401
              ? 'Необходима авторизация'
              : `Ошибка API: ${response.status}`;
            throw new Error(errorData.error || fallbackMessage);
          }

          const data = await response.json();
          if (typeof data.warning === 'string' && data.warning.trim()) {
            usedLocalCleanupFallback = true;
            lastBatchError = data.warning.trim();
          }
          const results: { idx: number; cleanedName: string }[] = data.results;

          // Update the spreadsheet data
          setTabs((prev) =>
            prev.map((tab) => {
              if (tab.id !== activeTabId) return tab;
              const nextData = tab.data.map((row, idx) => {
                const result = results.find((r) => r.idx === idx);
                if (!result) return row;
                const newRow = [...row];
                newRow[targetCol] = result.cleanedName;
                return newRow;
              });
              return { ...tab, data: nextData };
            }),
          );
        } catch (err) {
          if (err instanceof Error && (err.name === 'AbortError' || err.message === 'Отменено пользователем')) throw err;
          if (err instanceof Error && err.message === 'Необходима авторизация') throw err;
          lastBatchError = err instanceof Error ? err.message : 'Ошибка';
          errorCount += batch.length;
        }

        processedCount += batch.length;
        setNameCleanup((prev) => ({
          ...prev,
          currentRow: processedCount,
          progress: Math.round((processedCount / rowsToProcess.length) * 100),
        }));
      };

      const runWorker = async () => {
        while (true) {
          if (nameCleanupAbortRef.current?.signal.aborted) {
            throw new Error('Отменено пользователем');
          }
          const batchIndex = nextBatchIndex;
          if (batchIndex >= batches.length) return;
          nextBatchIndex += 1;
          await processBatch(batches[batchIndex]);
        }
      };

      const workerCount = Math.min(NAME_CLEANUP_CONCURRENCY, batches.length);
      const workers = Array.from({ length: workerCount }, () => runWorker());
      await Promise.all(workers);

      // Highlight the column
      setHighlightedCol(targetCol);
      if (highlightTimeoutRef.current) clearTimeout(highlightTimeoutRef.current);
      highlightTimeoutRef.current = setTimeout(() => {
        setHighlightedCol(null);
      }, NAME_CLEANUP_HIGHLIGHT_DURATION);

      const successCount = processedCount - errorCount;
      setLastAction({
        message: errorCount > 0
          ? `Очистка названий: ${successCount} успешно, ${errorCount} с ошибками`
          : usedLocalCleanupFallback
            ? `Очистка названий завершена локально: ${processedCount} строк`
          : `Очистка названий завершена: ${processedCount} строк`,
        time: Date.now(),
      });
      if (errorCount > 0 && successCount === 0) {
        const errorMessage = lastBatchError
          ? `Очистка не выполнена: ${lastBatchError}`
          : 'Очистка не выполнена: произошла ошибка на стороне API';
        setNameCleanup((prev) => ({
          ...prev,
          isProcessing: false,
          error: errorMessage,
        }));
      } else {
        setNameCleanup((prev) => ({ ...prev, isProcessing: false, isOpen: false }));
      }
    } catch (err) {
      if (err instanceof Error && (err.name === 'AbortError' || err.message === 'Отменено пользователем')) {
        setLastAction({ message: `Очистка названий отменена (обработано: ${processedCount})`, time: Date.now() });
        setNameCleanup((prev) => ({ ...prev, isProcessing: false, isOpen: false }));
      } else {
        setNameCleanup((prev) => ({
          ...prev,
          error: err instanceof Error ? err.message : 'Произошла ошибка',
          isProcessing: false,
        }));
      }
    } finally {
      nameCleanupAbortRef.current = null;
    }
  };

  // --- DaData Enrichment ---

  const openDadataModal = () => {
    setDadataEnrichment({
      isOpen: true,
      sourceCol: 0,
      mode: 'inn',
      selectedFields: DADATA_DEFAULT_FIELDS,
      isProcessing: false,
      progress: 0,
      totalRows: 0,
      currentRow: 0,
      error: null,
    });
  };

  const closeDadataModal = () => {
    if (dadataAbortRef.current) {
      dadataAbortRef.current.abort();
      dadataAbortRef.current = null;
    }
    setDadataEnrichment((prev) => ({ ...prev, isOpen: false, isProcessing: false }));
  };

  const handleStartDadataEnrichment = async () => {
    if (!activeTab || dadataEnrichment.isProcessing) return;
    flushSave();

    const selectedFields = dadataEnrichment.selectedFields;
    if (selectedFields.length === 0) {
      setDadataEnrichment((prev) => ({ ...prev, error: 'Выберите хотя бы одно поле' }));
      return;
    }

    const rowsToProcess: { rowIndex: number; query: string }[] = [];
    for (let i = 1; i < activeTab.data.length; i++) {
      const row = activeTab.data[i];
      const sourceValue = String(row?.[dadataEnrichment.sourceCol] ?? '').trim();
      if (!sourceValue) continue;
      rowsToProcess.push({ rowIndex: i, query: sourceValue });
    }

    if (rowsToProcess.length === 0) {
      setDadataEnrichment((prev) => ({ ...prev, error: 'Нет данных в выбранной колонке' }));
      return;
    }

    const currentToken = await getFreshToken();
    if (!currentToken) {
      setDadataEnrichment((prev) => ({ ...prev, error: 'Необходима авторизация' }));
      return;
    }

    dadataAbortRef.current = new AbortController();

    setDadataEnrichment((prev) => ({
      ...prev,
      isProcessing: true,
      progress: 0,
      totalRows: rowsToProcess.length,
      currentRow: 0,
      error: null,
    }));

    setUndoSnapshot('DaData обогащение');

    const fieldLabels = DADATA_FIELDS.filter((f) => selectedFields.includes(f.key));
    const startCol = dadataEnrichment.sourceCol + 1;

    const isColumnEmpty = (colIndex: number) =>
      activeTab.data.every((row) => (row[colIndex] ?? '').trim().length === 0);

    let firstNewCol = startCol;
    while (!isColumnEmpty(firstNewCol)) {
      firstNewCol += 1;
    }

    const colMap: Record<string, number> = {};
    fieldLabels.forEach((field, idx) => {
      colMap[field.key] = firstNewCol + idx;
    });

    const baseData = activeTab.data.map((row, rowIndex) => {
      const nextRow = [...row];
      const maxCol = firstNewCol + fieldLabels.length - 1;
      while (nextRow.length <= maxCol) nextRow.push('');
      if (rowIndex === 0) {
        fieldLabels.forEach((field, idx) => {
          nextRow[firstNewCol + idx] = field.label;
        });
      }
      return nextRow;
    });

    setTabs((prev) =>
      prev.map((tab) => (tab.id === activeTabId ? { ...tab, data: baseData } : tab)),
    );

    if (highlightTimeoutRef.current) clearTimeout(highlightTimeoutRef.current);
    setHighlightedCol(firstNewCol);
    highlightTimeoutRef.current = setTimeout(() => setHighlightedCol(null), ENRICHMENT_HIGHLIGHT_DURATION);

    if (tableWrapperRef.current) {
      const wrapper = tableWrapperRef.current;
      requestAnimationFrame(() => {
        wrapper.scrollTo({ left: wrapper.scrollWidth, behavior: 'smooth' });
      });
    }

    let processedCount = 0;
    let errorCount = 0;

    try {
      for (let batchStart = 0; batchStart < rowsToProcess.length; batchStart += DADATA_BATCH_SIZE) {
        if (dadataAbortRef.current?.signal.aborted) {
          throw new Error('Отменено пользователем');
        }

        const batch = rowsToProcess.slice(batchStart, batchStart + DADATA_BATCH_SIZE);

        let token = currentToken;
        try {
          const refreshed = await getFreshToken();
          if (refreshed) token = refreshed;
        } catch { /* use current */ }

        const res = await fetch('/api/enrich/dadata', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ rows: batch }),
          signal: dadataAbortRef.current?.signal,
        });

        const data = await parseJsonResponse<{
          results?: Array<{
            rowIndex: number;
            found: boolean;
            data: Record<string, string | number | null> | null;
            error?: string;
          }>;
          error?: string;
        }>(res, 'dadata_enrichment');

        if (!res.ok) {
          throw new Error(data.error ?? `HTTP ${res.status}`);
        }

        const batchResults = data.results ?? [];

        setTabs((prev) =>
          prev.map((tab) => {
            if (tab.id !== activeTabId) return tab;
            const nextData = tab.data.map((row) => [...row]);
            for (const result of batchResults) {
              if (!result.found || !result.data) {
                errorCount += 1;
                continue;
              }
              const ri = result.rowIndex;
              if (ri < 1 || ri >= nextData.length) continue;
              for (const field of fieldLabels) {
                const colIdx = colMap[field.key];
                const val = result.data[field.key];
                if (val !== null && val !== undefined) {
                  nextData[ri][colIdx] = String(val);
                }
              }
            }
            return { ...tab, data: nextData };
          }),
        );

        processedCount += batch.length;
        setDadataEnrichment((prev) => ({
          ...prev,
          currentRow: processedCount,
          progress: Math.round((processedCount / rowsToProcess.length) * 100),
        }));
      }

      const successCount = processedCount - errorCount;
      setLastAction({
        message: errorCount > 0
          ? `DaData: ${successCount} найдено, ${errorCount} не найдено`
          : `DaData обогащение завершено: ${processedCount} строк`,
        time: Date.now(),
      });
      setDadataEnrichment((prev) => ({ ...prev, isProcessing: false, isOpen: false }));
    } catch (err) {
      if (err instanceof Error && (err.name === 'AbortError' || err.message === 'Отменено пользователем')) {
        setLastAction({ message: `DaData отменено (обработано: ${processedCount})`, time: Date.now() });
        setDadataEnrichment((prev) => ({ ...prev, isProcessing: false, isOpen: false }));
      } else {
        setDadataEnrichment((prev) => ({
          ...prev,
          error: err instanceof Error ? err.message : 'Произошла ошибка',
          isProcessing: false,
        }));
      }
    } finally {
      dadataAbortRef.current = null;
    }
  };

  const openFnsModal = () => {
    setFnsEnrichment({ isOpen: true, sourceCol: 0, isProcessing: false, progress: 0, totalRows: 0, currentRow: 0, found: 0 });
  };
  const closeFnsModal = () => {
    if (fnsAbortRef.current) { fnsAbortRef.current.abort(); fnsAbortRef.current = null; }
    setFnsEnrichment((prev) => ({ ...prev, isOpen: false, isProcessing: false }));
  };

  const handleStartFnsEnrichment = async () => {
    if (!activeTab || fnsEnrichment.isProcessing) return;
    flushSave();

    const sourceCol = fnsEnrichment.sourceCol;
    const headerRow = activeTab.data[0];
    if (!headerRow) return;

    const innColHeader = headerRow[sourceCol]?.toLowerCase().trim() ?? '';
    if (!innColHeader) return;

    const incomeLabel = 'Доход (ФНС)';
    const expenseLabel = 'Расход (ФНС)';
    const fields = [incomeLabel, expenseLabel];

    const existingHeaders = headerRow.map((h) => String(h ?? '').trim());
    const colMap: Record<string, number> = {};
    for (const f of fields) {
      const idx = existingHeaders.indexOf(f);
      if (idx !== -1) {
        colMap[f] = idx;
      }
    }
    const missingFields = fields.filter((f) => !(f in colMap));

    const rowsToProcess = visibleRowIndices.filter((ri) => {
      const val = String(activeTab.data[ri]?.[sourceCol] ?? '').trim();
      return /^\d{10,12}$/.test(val);
    });

    if (rowsToProcess.length === 0) {
      setLastAction({ message: 'ФНС: не найдены строки с ИНН', time: Date.now() });
      return;
    }

    const abortCtrl = new AbortController();
    fnsAbortRef.current = abortCtrl;
    setFnsEnrichment((prev) => ({ ...prev, isProcessing: true, progress: 0, totalRows: rowsToProcess.length, currentRow: 0, found: 0 }));

    let processedCount = 0;
    let foundCount = 0;
    const BATCH = 500;

    try {
      if (missingFields.length > 0) {
        setTabs((prev) => prev.map((tab) => {
          if (tab.id !== activeTab.id) return tab;
          const nextData = tab.data.map((row) => [...row]);
          let nextCols = nextData[0].length;
          for (const f of missingFields) {
            nextData[0][nextCols] = f;
            colMap[f] = nextCols;
            nextCols++;
          }
          for (let r = 1; r < nextData.length; r++) {
            while (nextData[r].length < nextCols) nextData[r].push('');
          }
          return { ...tab, data: nextData };
        }));
      }

      for (let i = 0; i < rowsToProcess.length; i += BATCH) {
        if (abortCtrl.signal.aborted) throw new Error('Отменено пользователем');

        const batchIndices = rowsToProcess.slice(i, i + BATCH);
        const inns = batchIndices.map((ri) => String(activeTab.data[ri]?.[sourceCol] ?? '').trim());

        const res = await fetch('/api/enrich/fns-revenue', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${(await supabase.auth.getSession()).data.session?.access_token}`,
          },
          body: JSON.stringify({ inns }),
          signal: abortCtrl.signal,
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { results: Record<string, { income: number; expense: number }> };
        const results = json.results;

        setTabs((prev) => prev.map((tab) => {
          if (tab.id !== activeTab.id) return tab;
          const nextData = tab.data.map((row) => [...row]);
          for (const ri of batchIndices) {
            const inn = String(nextData[ri]?.[sourceCol] ?? '').trim();
            const match = results[inn];
            if (match) {
              const incCol = colMap[incomeLabel];
              const expCol = colMap[expenseLabel];
              if (incCol !== undefined) nextData[ri][incCol] = match.income > 0 ? String(match.income) : '0';
              if (expCol !== undefined) nextData[ri][expCol] = match.expense > 0 ? String(match.expense) : '0';
              foundCount++;
            }
          }
          return { ...tab, data: nextData };
        }));

        processedCount += batchIndices.length;
        setFnsEnrichment((prev) => ({
          ...prev,
          currentRow: processedCount,
          progress: Math.round((processedCount / rowsToProcess.length) * 100),
          found: foundCount,
        }));
      }

      setLastAction({
        message: `ФНС: ${foundCount} найдено из ${processedCount} строк`,
        time: Date.now(),
      });
      setFnsEnrichment((prev) => ({ ...prev, isProcessing: false, isOpen: false }));
    } catch (err) {
      if (err instanceof Error && (err.name === 'AbortError' || err.message === 'Отменено пользователем')) {
        setLastAction({ message: `ФНС отменено (обработано: ${processedCount})`, time: Date.now() });
      }
      setFnsEnrichment((prev) => ({ ...prev, isProcessing: false, isOpen: false }));
    } finally {
      fnsAbortRef.current = null;
    }
  };

  const openInnLookupModal = () => {
    setInnLookup({
      isOpen: true,
      urlCol: 0,
      isProcessing: false,
      progress: 0,
      totalRows: 0,
      currentRow: 0,
      found: 0,
    });
  };
  const closeInnLookupModal = () => {
    if (innLookupAbortRef.current) {
      innLookupAbortRef.current.abort();
      innLookupAbortRef.current = null;
    }
    setInnLookup((prev) => ({ ...prev, isOpen: false, isProcessing: false }));
  };

  const handleStartInnLookup = async () => {
    if (!activeTab || innLookup.isProcessing) return;
    flushSave();

    const { urlCol } = innLookup;
    if (urlCol < 0) return;
    const headerRow = activeTab.data[0];
    if (!headerRow) return;

    const innLabel = 'ИНН (найден)';
    const companyLabel = 'Компания (найдена)';
    const targetLabels = [innLabel, companyLabel];

    const existingHeaders = headerRow.map((h) => String(h ?? '').trim());
    const colMap: Record<string, number> = {};
    for (const label of targetLabels) {
      const idx = existingHeaders.indexOf(label);
      if (idx !== -1) colMap[label] = idx;
    }
    const missingLabels = targetLabels.filter((l) => !(l in colMap));

    const looksLikeUrl = (s: string) => /\./.test(s) || /^https?:\/\//i.test(s);
    const rowsToProcess = visibleRowIndices.filter((ri) => {
      const url = String(activeTab.data[ri]?.[urlCol] ?? '').trim();
      return url && looksLikeUrl(url);
    });

    if (rowsToProcess.length === 0) {
      setLastAction({ message: 'Найти ИНН: нет строк с URL для обработки', time: Date.now() });
      return;
    }

    const abortCtrl = new AbortController();
    innLookupAbortRef.current = abortCtrl;
    setInnLookup((prev) => ({
      ...prev,
      isProcessing: true,
      progress: 0,
      totalRows: rowsToProcess.length,
      currentRow: 0,
      found: 0,
    }));

    let processedCount = 0;
    let found = 0;
    const BATCH = 5;

    try {
      if (missingLabels.length > 0) {
        setTabs((prev) =>
          prev.map((tab) => {
            if (tab.id !== activeTab.id) return tab;
            const nextData = tab.data.map((row) => [...row]);
            let nextCols = nextData[0].length;
            for (const label of missingLabels) {
              nextData[0][nextCols] = label;
              colMap[label] = nextCols;
              nextCols++;
            }
            for (let r = 1; r < nextData.length; r++) {
              while (nextData[r].length < nextCols) nextData[r].push('');
            }
            return { ...tab, data: nextData };
          }),
        );
      }

      const innCol = colMap[innLabel]!;
      const compCol = colMap[companyLabel]!;

      for (let i = 0; i < rowsToProcess.length; i += BATCH) {
        if (abortCtrl.signal.aborted) throw new Error('Отменено пользователем');

        const batchIndices = rowsToProcess.slice(i, i + BATCH);
        const items = batchIndices.map((ri) => ({
          url: String(activeTab.data[ri]?.[urlCol] ?? '').trim(),
        }));

        const res = await fetch('/api/enrich/inn-lookup', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${(await supabase.auth.getSession()).data.session?.access_token}`,
          },
          body: JSON.stringify({ items }),
          signal: abortCtrl.signal,
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as {
          results: Array<{ inn: string | null; companyName: string | null }>;
        };

        setTabs((prev) =>
          prev.map((tab) => {
            if (tab.id !== activeTab.id) return tab;
            const nextData = tab.data.map((row) => [...row]);
            for (let j = 0; j < batchIndices.length; j++) {
              const ri = batchIndices[j];
              const r = json.results[j];
              if (!r?.inn) continue;
              while (nextData[ri].length <= Math.max(innCol, compCol)) nextData[ri].push('');
              nextData[ri][innCol] = r.inn;
              nextData[ri][compCol] = r.companyName ?? '';
              found++;
            }
            return { ...tab, data: nextData };
          }),
        );

        processedCount += batchIndices.length;
        setInnLookup((prev) => ({
          ...prev,
          currentRow: processedCount,
          progress: Math.round((processedCount / rowsToProcess.length) * 100),
          found,
        }));
      }

      setLastAction({
        message: `ИНН: найдено ${found} из ${processedCount} (парсинг сайтов)`,
        time: Date.now(),
      });
      setInnLookup((prev) => ({ ...prev, isProcessing: false, isOpen: false }));
    } catch (err) {
      if (err instanceof Error && (err.name === 'AbortError' || err.message === 'Отменено пользователем')) {
        setLastAction({ message: `ИНН отменено (обработано: ${processedCount})`, time: Date.now() });
      }
      setInnLookup((prev) => ({ ...prev, isProcessing: false, isOpen: false }));
    } finally {
      innLookupAbortRef.current = null;
    }
  };

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someVisibleSelected;
    }
  }, [someVisibleSelected]);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(WRAP_STORAGE_KEY);
      if (stored !== null) {
        setWrapCells(stored === 'true');
      }
    } catch (error) {
      void logError('spreadsheet.wrap.load.failed', error);
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(WRAP_STORAGE_KEY, String(wrapCells));
    } catch (error) {
      void logError('spreadsheet.wrap.save.failed', error, { value: wrapCells });
    }
  }, [wrapCells]);

  useEffect(() => {
    if (!activeTab || colCount === 0) {
      setGroupByCol(null);
      return;
    }
    const detected = headerLabels.findIndex((label) => COMPANY_HEADER_REGEX.test(label));
    setGroupByCol(detected >= 0 ? detected : 0);
    setGroupSearch('');
    setGroupSummaryLimit(GROUP_SUMMARY_PAGE_SIZE);
  }, [activeTabId, headerLabels, colCount, activeTab]);

  useEffect(() => {
    setColumnWidths((prev) => {
      if (colCount === prev.length) return prev;
      if (colCount < prev.length) return prev.slice(0, colCount);
      return [
        ...prev,
        ...Array.from({ length: colCount - prev.length }, () => DEFAULT_COLUMN_WIDTH),
      ];
    });
  }, [colCount]);

  useEffect(() => {
    setSelectedRows((prev) => {
      if (!activeTab || prev.size === 0) return prev;
      if (visibleRowIndices.length > VIRTUALIZATION_THRESHOLD) {
        return new Set();
      }
      const visibleSet = new Set(visibleRowIndices);
      const next = new Set<number>();
      prev.forEach((index) => {
        if (visibleSet.has(index)) next.add(index);
      });
      return next;
    });
  }, [activeTab, visibleRowIndices]);

  useEffect(() => {
    setSelectedRows(new Set());
  }, [rowCount]);

  useEffect(() => {
    let isMounted = true;
    const applySession = (session: { user: { id: string }; access_token?: string } | null) => {
      if (!isMounted) return;
      const userId = session?.user?.id ?? null;
      setUserId(userId);
      setStorageKey(buildStorageKey(userId));
      accessTokenRef.current = (session as { access_token?: string } | null)?.access_token ?? null;
    };

    void (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      applySession(session);
    })();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_, session) => {
      applySession(session);
    });

    return () => {
      isMounted = false;
      subscription?.unsubscribe();
      cancelBackgroundSave();
    };
  }, []);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    void (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token || cancelled) return;
      const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

      const [projRes, reqRes] = await Promise.all([
        supabase.from('projects').select('id, name').order('name'),
        fetch('/api/database-review/requests', { headers: h }).then((r) => r.json()).catch(() => ({ requests: [] })),
      ]);
      if (cancelled) return;
      setProjectsList((projRes.data ?? []) as Array<{ id: string; name: string }>);
      setMyReviewRequests(
        (reqRes.requests ?? []).map((r: Record<string, unknown>) => ({
          id: r.id as string,
          tab_id: r.tab_id as string,
          tab_name: (r.tab_name as string) || '',
          status: r.status as string,
          project_name: (r.project_name as string) || '',
          reviewer_comment: (r.reviewer_comment as string) || '',
        })),
      );
    })();
    return () => { cancelled = true; };
  }, [userId]);

  const activeReviewReq = activeTab ? myReviewRequests.find((r) => r.tab_id === activeTab.id) : null;
  const reworkStatuses = new Set(['needs_rework', 'client_requested_changes']);
  const hasRework = activeReviewReq && reworkStatuses.has(activeReviewReq.status);
  const reviewMarksMap = useMemo(() => {
    const map = new Map<number, typeof reviewMarks>();
    for (const m of reviewMarks) {
      const arr = map.get(m.row_index) ?? [];
      arr.push(m);
      map.set(m.row_index, arr);
    }
    return map;
  }, [reviewMarks]);

  useEffect(() => {
    if (!hasRework || !activeReviewReq) { setReviewMarks([]); return; }
    let cancelled = false;
    void (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token || cancelled) return;
      const res = await fetch(`/api/database-review/requests/${activeReviewReq.id}/marks`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const d = await res.json();
      if (cancelled) return;
      setReviewMarks(
        (d.marks ?? []).map((m: Record<string, unknown>) => ({
          row_index: m.row_index as number,
          color: (m.color as string) || '',
          comment: (m.comment as string) || '',
          author_type: (m.author_type as string) || 'reviewer',
        })),
      );
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasRework, activeReviewReq?.id]);

  useEffect(() => {
    if (!storageKey) return;
    let isMounted = true;
    hydratedStateRef.current = '__pending__';
    setIsHydrated(false);
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }
    cancelBackgroundSave();

    const applyState = (state: PersistedSpreadsheetState | null) => {
      if (!isMounted) return;
      startTransition(() => {
        if (state) {
          setTabs(state.tabs);
          setActiveTabId(state.activeTabId);
          setTabCounter(state.tabCounter);
          setColumnWidths(state.columnWidths ?? []);
        } else {
          const fallbackTab = createSheet('Вкладка 1');
          setTabs([fallbackTab]);
          setActiveTabId(fallbackTab.id);
          setTabCounter(1);
          setColumnWidths([]);
        }
        hydratedStateRef.current = '__hydrated__';
        setIsHydrated(true);
      });
    };

    if (!userId) {
      const localState = readPersistedState(window.localStorage.getItem(storageKey));
      applyState(localState);
      return () => {
        isMounted = false;
      };
    }

    void (async () => {
      let remoteState: PersistedSpreadsheetState | null = null;

      const token = accessTokenRef.current;
      if (token) {
        try {
          const raw = await loadStateViaWorker(userId, token);
          if (raw) remoteState = readPersistedState(raw);
        } catch {
          /* worker failed, try supabase client below */
        }
      }

      if (!remoteState) {
        try {
          const { data, error } = await supabase
            .from('database_spreadsheet_states')
            .select('state')
            .eq('user_id', userId)
            .limit(1);
          if (!error && data?.[0]?.state) {
            remoteState = readPersistedState(data[0].state);
          }
        } catch (error) {
          void logError('spreadsheet.state.load.failed', error);
        }
      }

      const localState = readPersistedState(window.localStorage.getItem(storageKey));
      const localIsNewer = localState && (localState.savedAt ?? 0) > (remoteState?.savedAt ?? 0);
      const bestState = localIsNewer ? localState : (remoteState ?? localState);

      if (isMounted) applyState(bestState);

      if (bestState && bestState !== remoteState) {
        try {
          await supabase.from('database_spreadsheet_states').upsert({
            user_id: userId,
            state: bestState,
            updated_at: new Date().toISOString(),
          });
        } catch (error) {
          void logError('spreadsheet.state.remote_save.failed', error);
        }
      }
    })();

    return () => {
      isMounted = false;
    };
  }, [storageKey, userId]);

  useEffect(() => {
    if (tabs.length === 0) return;
    if (tabs.some((tab) => tab.id === activeTabId)) return;
    setActiveTabId(tabs[0].id);
  }, [tabs, activeTabId]);

  useEffect(() => {
    if (!storageKey || !isHydrated) return;

    if (hydratedStateRef.current === '__pending__') return;
    if (hydratedStateRef.current === '__hydrated__') {
      hydratedStateRef.current = null;
      return;
    }

    const safeActiveTabId = resolveActiveTabId(tabs, activeTabId);
    const now = Date.now();
    const payload: PersistedSpreadsheetState = {
      version: STORAGE_VERSION,
      tabs,
      activeTabId: safeActiveTabId,
      tabCounter: deriveTabCounter(tabs, tabCounter),
      columnWidths,
      savedAt: now,
    };
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    const userIdSnapshot = userId;
    const storageKeySnapshot = storageKey;
    const totalRows = tabs.reduce((sum, tab) => sum + tab.data.length, 0);
    const isLargeDataset = totalRows > LARGE_DATASET_ROW_THRESHOLD;
    const delay = isLargeDataset ? STORAGE_SAVE_DELAY_LARGE : STORAGE_SAVE_DELAY;

    try {
      window.localStorage.setItem(storageKeySnapshot, JSON.stringify(payload));
    } catch {
      /* quota exceeded — acceptable for very large datasets */
    }

    saveTimeoutRef.current = setTimeout(() => {
      if (!userIdSnapshot) return;
      if (isLargeDataset) {
        if (accessTokenRef.current) {
          void backgroundSave(
            { user_id: userIdSnapshot, state: payload, updated_at: new Date().toISOString() },
            accessTokenRef.current,
            (msg) => void logError('spreadsheet.state.remote_save.chunked_failed', msg),
          );
        }
        return;
      }
      void supabase
        .from('database_spreadsheet_states')
        .upsert({
          user_id: userIdSnapshot,
          state: payload,
          updated_at: new Date().toISOString(),
        })
        .then(({ error }) => {
          if (error) {
          void logError('spreadsheet.state.remote_save.failed', error);
          }
        });
    }, delay);
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }
      cancelBackgroundSave();
    };
  }, [tabs, activeTabId, tabCounter, columnWidths, storageKey, isHydrated, userId]);

  useEffect(() => {
    const handleBeforeUnload = () => {
      flushSave();
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  });

  useEffect(() => {
    if (!isHydrated || !activeTab || websiteEnrichment.isGenerating) return;
    const run = getEnrichmentRunForTab(activeTabId);
    if (!run) return;
    if (resumeEnrichmentRef.current === run.jobId) return;
    const tabExists = tabs.some((tab) => tab.id === run.tabId);
    if (!tabExists) {
      removeEnrichmentRun(run.jobId);
      return;
    }
    const totalFallback = run.totalRows > 0 ? run.totalRows : Math.max(0, activeTab.data.length - 1);
    const headerLabel = run.headerLabel || enrichmentHeaderLabel;
    resumeEnrichmentRef.current = run.jobId;
    setEnrichmentTargetOverride(run.targetCol);
    void runWebsiteEnrichmentPolling({
      jobId: run.jobId,
      tabId: run.tabId,
      sourceCol: run.sourceCol,
      targetColIndex: run.targetCol,
      totalRowsFallback: totalFallback,
      headerLabel,
      applyOnlyEmpty: true,
    }).finally(() => {
      resumeEnrichmentRef.current = null;
    });
  }, [
    activeTab,
    activeTabId,
    enrichmentHeaderLabel,
    getEnrichmentRunForTab,
    isHydrated,
    removeEnrichmentRun,
    runWebsiteEnrichmentPolling,
    setEnrichmentTargetOverride,
    tabs,
    websiteEnrichment.isGenerating,
  ]);

  useEffect(() => {
    if (!isHydrated || !activeTab || briefScoring.isScoring) return;
    const run = getBriefScoringRunForTab(activeTabId);
    if (!run) return;
    if (resumeBriefScoringRef.current === run.jobId) return;

    const tabExists = tabs.some((tab) => tab.id === run.tabId);
    if (!tabExists) {
      removeBriefScoringRun(run.jobId);
      return;
    }

    const totalFallback = run.totalRows > 0 ? run.totalRows : Math.max(0, activeTab.data.length - 1);
    resumeBriefScoringRef.current = run.jobId;
    ensureBriefScoringColumns(run.tabId, run.scoreCol, run.reasonCol);
    setBriefScoring((prev) => ({
      ...prev,
      isOpen: false,
      isScoring: true,
      error: null,
      jobId: run.jobId,
      totalRows: totalFallback,
      currentRow: Math.min(prev.currentRow, totalFallback),
      progress:
        totalFallback > 0
          ? Math.round((Math.min(prev.currentRow, totalFallback) / totalFallback) * 100)
          : 0,
    }));

    void runBriefScoringPolling({
      jobId: run.jobId,
      tabId: run.tabId,
      scoreColIndex: run.scoreCol,
      reasonColIndex: run.reasonCol,
      totalRowsFallback: totalFallback,
    }).finally(() => {
      resumeBriefScoringRef.current = null;
    });
  }, [
    activeTab,
    activeTabId,
    briefScoring.isScoring,
    ensureBriefScoringColumns,
    getBriefScoringRunForTab,
    isHydrated,
    removeBriefScoringRun,
    runBriefScoringPolling,
    tabs,
  ]);

  const toolbarMonochromeButtonClass =
    'inline-flex items-center rounded border border-gray-300 bg-white px-2.5 py-1 text-[11px] font-medium text-gray-900 transition hover:bg-gray-100 disabled:cursor-not-allowed disabled:border-gray-200 disabled:bg-gray-100 disabled:text-gray-400';
  const toolbarMonochromeButtonCompactClass =
    'inline-flex items-center gap-1 rounded border border-gray-300 bg-white px-2 py-1 text-[11px] font-medium text-gray-900 transition hover:bg-gray-100 disabled:cursor-not-allowed disabled:border-gray-200 disabled:bg-gray-100 disabled:text-gray-400';

  return (
    <div className="flex-1 min-h-0 space-y-0.5 flex flex-col">
      <div className="flex flex-wrap items-center gap-1.5 pb-1 flex-shrink-0">
        <Link
          href="/tools"
          className="inline-flex items-center gap-1 rounded-md bg-black px-2.5 py-1 text-[11px] font-semibold text-white transition hover:bg-gray-800"
        >
          <span aria-hidden>←</span>
          <span>К инструментам</span>
        </Link>
        <span className="text-xs font-semibold text-gray-500 mr-1">Базы</span>

        {selectedRows.size > 0 && (
          <button
            type="button"
            onClick={confirmRemoveSelectedRows}
            className={toolbarMonochromeButtonCompactClass}
          >
            Удалить ({selectedRows.size})
          </button>
        )}

        <button
          type="button"
          onClick={confirmClearSelection}
          disabled={!activeTab || rowCount === 0 || colCount === 0}
          className="inline-flex items-center rounded border border-gray-200 bg-white px-2 py-1 text-[11px] font-medium text-gray-600 transition hover:bg-gray-50 disabled:opacity-50"
        >
          Очистить
        </button>

        <button
          type="button"
          onClick={() => importInputRef.current?.click()}
          className="inline-flex items-center gap-1 rounded border border-gray-200 bg-white px-2 py-1 text-[11px] font-medium text-gray-600 transition hover:bg-gray-50"
        >
          ↑ Импорт
        </button>

        <div className="flex items-center rounded bg-gray-100 p-0.5">
          <span className="px-1.5 py-1 text-[11px] text-gray-400">↓</span>
          <button
            type="button"
            onClick={handleExportCsv}
            className="rounded px-1.5 py-1 text-[11px] font-medium text-gray-600 transition hover:bg-white hover:text-gray-900"
          >
            CSV
          </button>
          <button
            type="button"
            onClick={handleExportXlsx}
            className="rounded px-1.5 py-1 text-[11px] font-medium text-gray-600 transition hover:bg-white hover:text-gray-900"
          >
            Excel
          </button>
        </div>

        <button
          type="button"
          onClick={() => void copyEntireTable()}
          disabled={!activeTab || rowCount === 0}
          className="inline-flex items-center gap-1 rounded border border-gray-200 bg-white px-2 py-1 text-[11px] font-medium text-gray-600 transition hover:bg-gray-50 disabled:opacity-50"
          title="Копировать всю таблицу в буфер обмена"
        >
          📋 Копировать
        </button>
        {copyNotice && (
          <span
            className={`inline-flex items-center rounded border px-2 py-1 text-[10px] font-medium ${
              copyNotice.tone === 'success'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                : 'border-red-200 bg-red-50 text-red-700'
            }`}
          >
            {copyNotice.message}
          </span>
        )}

        <div className="h-4 w-px bg-gray-200 mx-0.5" />

        <button
          type="button"
          onClick={openPersonalizationModal}
          disabled={colCount === 0}
          className={toolbarMonochromeButtonClass}
        >
          Персонализация
        </button>

        <button
          type="button"
          onClick={openWebsiteEnrichmentModal}
          disabled={colCount === 0}
          className={toolbarMonochromeButtonClass}
        >
          Обогатить
        </button>

        {emailScraping.isGenerating ? (
          <button
            type="button"
            onClick={() => void handleStopEmailScraping()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white shadow transition hover:bg-red-700"
          >
            Почты... {emailScraping.progress}% — Стоп
          </button>
        ) : (
          <button
            type="button"
            onClick={openEmailScrapingModal}
            disabled={colCount === 0}
            className={toolbarMonochromeButtonClass}
          >
            Найти почты
          </button>
        )}

        {emailValidation.isValidating ? (
          <button
            type="button"
            onClick={() => void handleStopEmailValidation()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white shadow transition hover:bg-red-700"
          >
            Валидация... {emailValidation.progress}% — Стоп
          </button>
        ) : (
          <button
            type="button"
            onClick={openEmailValidationModal}
            disabled={colCount === 0}
            className={toolbarMonochromeButtonClass}
          >
            Валидация почт
          </button>
        )}

        <button
          type="button"
          onClick={openSiteAvailabilityModal}
          disabled={colCount === 0}
          className={toolbarMonochromeButtonClass}
        >
          Проверка сайтов
        </button>

        {briefScoring.isScoring ? (
          <button
            type="button"
            onClick={() => void handleStopBriefScoring()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white shadow transition hover:bg-red-700"
          >
            Оценка ЦА: {briefScoring.progress}% — Стоп
          </button>
        ) : (
          <button
            type="button"
            onClick={openBriefScoringModal}
            disabled={colCount === 0}
            className={toolbarMonochromeButtonClass}
          >
            Оценка ЦА
          </button>
        )}

        <button
          type="button"
          onClick={openNameCleanupModal}
          disabled={colCount === 0}
          className={toolbarMonochromeButtonClass}
        >
          Чистка названий
        </button>

        {dadataEnrichment.isProcessing ? (
          <button
            type="button"
            onClick={closeDadataModal}
            className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white shadow transition hover:bg-red-700"
          >
            DaData... {dadataEnrichment.progress}% — Стоп
          </button>
        ) : (
          <button
            type="button"
            onClick={openDadataModal}
            disabled={colCount === 0}
            className={toolbarMonochromeButtonClass}
          >
            DaData
          </button>
        )}

        {fnsEnrichment.isProcessing ? (
          <button
            type="button"
            onClick={closeFnsModal}
            className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white shadow transition hover:bg-red-700"
          >
            ФНС... {fnsEnrichment.progress}% — Стоп
          </button>
        ) : (
          <button
            type="button"
            onClick={openFnsModal}
            disabled={colCount === 0}
            className={toolbarMonochromeButtonClass}
          >
            Доходы ФНС
          </button>
        )}

        {innLookup.isProcessing ? (
          <button
            type="button"
            onClick={closeInnLookupModal}
            className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white shadow transition hover:bg-red-700"
          >
            ИНН... {innLookup.progress}% — Стоп
          </button>
        ) : (
          <button
            type="button"
            onClick={openInnLookupModal}
            disabled={colCount === 0}
            className={toolbarMonochromeButtonClass}
          >
            Найти ИНН
          </button>
        )}

        <button
          type="button"
          onClick={handleCleanInvisibleWhitespace}
          disabled={colCount === 0}
          className={toolbarMonochromeButtonClass}
          title="Очистка невидимых символов и проблемных пробелов для экспорта в Instantly"
        >
          Whitespace Fix
        </button>

        <div className="h-4 w-px bg-gray-200 mx-0.5" />

        {activeReviewReq && (() => {
          const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
            submitted: { label: 'На проверке', cls: 'border-gray-300 bg-gray-50 text-gray-600' },
            needs_rework: { label: 'На доработке', cls: 'border-orange-300 bg-orange-50 text-orange-700' },
            review_approved: { label: 'Одобрено', cls: 'border-green-300 bg-green-50 text-green-700' },
            sent_to_client: { label: 'У клиента', cls: 'border-blue-300 bg-blue-50 text-blue-700' },
            client_approved: { label: 'Клиент согласовал', cls: 'border-green-300 bg-green-50 text-green-700' },
            client_requested_changes: { label: 'Клиент: правки', cls: 'border-red-300 bg-red-50 text-red-700' },
          };
          const badge = STATUS_BADGE[activeReviewReq.status];
          return badge ? (
            <span className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-[10px] font-medium ${badge.cls}`}>
              {badge.label}
              {activeReviewReq.reviewer_comment && reworkStatuses.has(activeReviewReq.status) && (
                <span
                  className="cursor-help underline decoration-dotted"
                  title={activeReviewReq.reviewer_comment}
                >
                  💬
                </span>
              )}
            </span>
          ) : null;
        })()}

        {(!activeReviewReq || reworkStatuses.has(activeReviewReq.status)) && (
          <button
            type="button"
            onClick={() => setReviewSubmit({ isOpen: true, comment: '', projectId: '', submitting: false })}
            disabled={!activeTab || rowCount === 0}
            className="inline-flex items-center gap-1 rounded border border-emerald-300 bg-emerald-50 px-2 py-1 text-[11px] font-medium text-emerald-700 transition hover:bg-emerald-100 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {activeReviewReq ? '↻ Переотправить' : '✓ На проверку'}
          </button>
        )}

        <button
          type="button"
          onClick={async () => {
            const hdrs = activeTab?.data[0] ?? [];
            const initialMapping = hdrs.map((h) => autoDetectInstantlyField(String(h ?? '')));
            setInstantlyPush({ isOpen: true, campaignId: '', leadListId: '', pushing: false, result: '', loadingLists: true, columnMapping: initialMapping, mappingStep: false });
            setInstantlyCampaigns([]);
            setInstantlyLeadLists([]);
            setInstantlyCampaignSearch('');
            setInstantlyCreateMode(false);
            setInstantlyNewName('');
            try {
              const token = (await (await import('@/lib/supabaseClient')).supabase.auth.getSession()).data.session?.access_token ?? '';
              const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
              const errors: string[] = [];
              const [cRes, lRes] = await Promise.all([
                fetch('/api/instantly/campaigns?limit=500', { headers }),
                fetch('/api/instantly/lead-lists?limit=all', { headers }),
              ]);
              if (cRes.ok) {
                const cd = await cRes.json();
                const raw = (cd.items ?? cd.data ?? (Array.isArray(cd) ? cd : [])) as Array<{ id: string; name: string; timestamp_created?: string }>;
                const sorted = raw
                  .map((c) => ({ id: c.id, name: c.name, ts: c.timestamp_created ?? '' }))
                  .sort((a, b) => (b.ts > a.ts ? 1 : b.ts < a.ts ? -1 : 0));
                setInstantlyCampaigns(sorted);
              } else {
                const errBody = await cRes.json().catch(() => ({ error: cRes.statusText }));
                errors.push(`Кампании: ${errBody?.error ?? cRes.statusText}`);
              }
              if (lRes.ok) {
                const ld = await lRes.json();
                setInstantlyLeadLists((ld.items ?? ld.data ?? (Array.isArray(ld) ? ld : [])).map((l: { id: string; name: string }) => ({ id: l.id, name: l.name })));
              } else {
                const errBody = await lRes.json().catch(() => ({ error: lRes.statusText }));
                errors.push(`Lead-списки: ${errBody?.error ?? lRes.statusText}`);
              }
              if (errors.length) {
                setInstantlyPush((s) => ({ ...s, result: `Ошибка загрузки: ${errors.join('; ')}` }));
              }
            } catch (err) {
              setInstantlyPush((s) => ({ ...s, result: `Ошибка: ${err instanceof Error ? err.message : 'не удалось загрузить данные'}` }));
            } finally {
              setInstantlyPush((s) => ({ ...s, loadingLists: false }));
            }
          }}
          disabled={!activeTab || rowCount === 0}
          className="inline-flex items-center gap-1 rounded border border-blue-300 bg-blue-50 px-2 py-1 text-[11px] font-medium text-blue-700 transition hover:bg-blue-100 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Push to Instantly
        </button>

        {importStatus.status !== 'idle' && (
          <>
            <div className="h-4 w-px bg-gray-200 mx-0.5" />
            <span className="text-[10px] text-gray-500">{formatProgressLabel(importStatus)} {importStatus.progress}%</span>
          </>
        )}
        {websiteEnrichment.isGenerating && (
          <>
            <div className="h-4 w-px bg-gray-200 mx-0.5" />
            <span className="text-[10px] text-gray-500">
              Обогащение: {websiteEnrichment.currentRow}/{websiteEnrichment.totalRows}
            </span>
            {websiteEnrichment.retryCount > 0 && (
              <span className="text-[10px] text-amber-600">
                Ретраи: {websiteEnrichment.retryCount}
              </span>
            )}
            <div className="h-1 w-20 overflow-hidden rounded-full bg-gray-200">
              <div
                className="h-full bg-blue-600 transition-all duration-300 ease-out"
                style={{ width: `${websiteEnrichment.progress}%` }}
              />
            </div>
            <button
              type="button"
              onClick={handleStopWebsiteEnrichment}
              className="rounded border border-gray-300 bg-white px-1.5 py-0.5 text-[10px] font-medium text-gray-900 transition hover:bg-gray-100"
            >
              Стоп
            </button>
          </>
        )}
      </div>

      <div className="flex items-center gap-1.5 bg-white rounded border border-gray-200 px-1.5 py-1 flex-shrink-0">
        <div className="relative flex-1 max-w-xs">
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Поиск..."
            className="w-full rounded border border-gray-200 bg-gray-50 py-1 px-2 text-[11px] text-gray-900 outline-none transition focus:border-gray-400 focus:bg-white placeholder:text-gray-400"
          />
          {searchQuery.length > 0 && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 text-gray-400 hover:bg-gray-200 hover:text-gray-600 text-xs leading-none"
              aria-label="Очистить поиск"
            >
              &times;
            </button>
          )}
        </div>
        
        <label className="flex items-center gap-1 cursor-pointer select-none text-[11px] text-gray-600 whitespace-nowrap">
          <input
            type="checkbox"
            checked={searchOnlyMatches}
            onChange={(event) => setSearchOnlyMatches(event.target.checked)}
            className="h-3 w-3 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
          />
          Совпадения
        </label>

        <button
          type="button"
          onClick={handleToggleWrapCells}
          aria-pressed={effectiveWrapCells}
          className={`rounded border px-2 py-1 text-[11px] font-medium transition whitespace-nowrap ${
            effectiveWrapCells
              ? 'border-gray-900 bg-gray-900 text-white'
              : 'border-gray-200 bg-gray-50 text-gray-600 hover:bg-gray-100'
          }`}
          title={
            isLargeTable && !forceWrapLarge
              ? 'Нажмите, чтобы включить перенос (может замедлить)'
              : undefined
          }
        >
          Перенос: {wrapLabel}
        </button>

        <button
          type="button"
          onClick={() => setRightPanelOpen((v) => !v)}
          className={`rounded border px-2 py-1 text-[11px] font-medium transition whitespace-nowrap ${
            rightPanelOpen
              ? 'border-gray-900 bg-gray-900 text-white'
              : 'border-gray-200 bg-gray-50 text-gray-600 hover:bg-gray-100'
          }`}
          title={rightPanelOpen ? 'Скрыть панель' : 'Показать панель'}
        >
          {rightPanelOpen ? '◨ Панель' : '◧ Панель'}
        </button>

        <div className="h-4 w-px bg-gray-200 mx-0.5" />

        <div className="flex items-center gap-1 overflow-x-auto">
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            const isEditing = editingTabId === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTabId(tab.id)}
                className={`group flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium transition-all whitespace-nowrap ${
                  isActive
                    ? 'bg-gray-100 text-gray-900'
                    : 'text-gray-500 hover:text-gray-900 hover:bg-gray-50'
                }`}
              >
                {isEditing ? (
                  <input
                    value={editingTabName}
                    onChange={(event) => setEditingTabName(event.target.value)}
                    onBlur={commitTabName}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        commitTabName();
                      }
                      if (event.key === 'Escape') {
                        event.preventDefault();
                        cancelTabEdit();
                      }
                    }}
                    onClick={(event) => event.stopPropagation()}
                    className="w-20 bg-transparent border-b border-blue-500 text-gray-900 text-[11px] outline-none p-0"
                    autoFocus
                  />
                ) : (
                  <span
                    onDoubleClick={(event) => {
                      event.stopPropagation();
                      startEditingTab(tab);
                    }}
                  >
                    {tab.name}
                  </span>
                )}
                {tabs.length > 1 && !isEditing && (
                  <span
                    onClick={(event) => {
                      event.stopPropagation();
                      handleRemoveTab(tab.id);
                    }}
                    className="flex h-3.5 w-3.5 items-center justify-center rounded-full text-[10px] leading-none opacity-0 group-hover:opacity-100 transition-opacity hover:bg-gray-200 hover:text-red-600"
                  >
                    &times;
                  </span>
                )}
              </button>
            );
          })}
          <button
            type="button"
            onClick={handleAddTab}
            className="flex items-center justify-center h-6 w-6 rounded border border-dashed border-gray-300 text-gray-400 text-xs hover:border-gray-400 hover:text-gray-600 hover:bg-gray-50 transition-all"
            title="Новая вкладка"
          >
            +
          </button>
        </div>
      </div>

      <input
        ref={importInputRef}
        type="file"
        accept=".csv,.xlsx,.xls"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          void handleImportFile(file);
          event.currentTarget.value = '';
        }}
      />
      <input
        ref={briefFileInputRef}
        type="file"
        accept=".pdf"
        className="hidden"
        onChange={(e) => void handleBriefFileUpload(e)}
      />

      <div className={`grid gap-1 ${rightPanelOpen ? 'lg:grid-cols-[minmax(0,1fr)_220px]' : 'grid-cols-1'} flex-1 min-h-0`} style={{ gridTemplateRows: 'minmax(0,1fr)' }}>
        <div className="relative rounded border border-gray-200 bg-white overflow-hidden flex min-h-0 flex-col">
          {activeReviewReq && (() => {
            const cfg: Record<string, { bg: string; border: string; text: string; icon: string; label: string }> = {
              submitted: { bg: 'bg-gray-50', border: 'border-gray-200', text: 'text-gray-700', icon: '⏳', label: 'База на проверке у ревьюера' },
              needs_rework: { bg: 'bg-orange-50', border: 'border-orange-200', text: 'text-orange-800', icon: '🔄', label: 'Ревьюер отправил на доработку' },
              review_approved: { bg: 'bg-green-50', border: 'border-green-200', text: 'text-green-800', icon: '✅', label: 'Ревьюер одобрил базу — отправьте клиенту на согласование' },
              sent_to_client: { bg: 'bg-blue-50', border: 'border-blue-200', text: 'text-blue-800', icon: '📨', label: 'Отправлено клиенту, ожидаем ответ' },
              client_approved: { bg: 'bg-emerald-50', border: 'border-emerald-200', text: 'text-emerald-800', icon: '🎉', label: 'Клиент согласовал базу' },
              client_requested_changes: { bg: 'bg-red-50', border: 'border-red-200', text: 'text-red-800', icon: '✏️', label: 'Клиент запросил правки' },
            };
            const s = cfg[activeReviewReq.status];
            if (!s) return null;
            return (
              <div className={`flex items-center gap-2 px-3 py-2 ${s.bg} ${s.border} border-b text-xs ${s.text}`}>
                <span>{s.icon}</span>
                <span className="font-medium">{s.label}</span>
                {activeReviewReq.reviewer_comment && reworkStatuses.has(activeReviewReq.status) && (
                  <span className="ml-2 text-[11px] opacity-80">
                    — «{activeReviewReq.reviewer_comment}»
                  </span>
                )}
              </div>
            );
          })()}
          <div
            ref={tableWrapperRef}
            className="overflow-y-auto overflow-x-hidden flex-1 min-h-0 pb-6 dark-scrollbar"
            style={{ maxHeight: 'calc(100vh - 130px)' }}
            tabIndex={-1}
            onKeyDownCapture={handleGridKeyDown}
            onPaste={handlePaste as unknown as React.ClipboardEventHandler<HTMLDivElement>}
            onScroll={handleTableScroll}
            onContextMenu={(event) => {
              event.preventDefault();
              setFilterMenu(null);
              setContextMenu({ x: event.clientX, y: event.clientY });
            }}
          >
            {!isHydrated ? (
              <div className="px-6 py-14 text-center text-gray-500">
                <div className="mx-auto mb-3 h-8 w-8 rounded-full border-2 border-gray-300 border-t-transparent animate-spin" />
                <div className="text-sm font-medium text-gray-700">Загружаем вашу базу…</div>
                <div className="mt-1 text-xs text-gray-500">Это может занять несколько секунд.</div>
              </div>
            ) : (
            <table ref={tableElementRef} className="min-w-max border-separate border-spacing-0">
              <thead>
                <tr>
                  <th className="sticky top-0 left-0 z-20 border-b border-r border-gray-200 bg-gray-50 px-0.5 py-px text-[10px] font-semibold text-gray-500 w-8 min-w-[32px]">
                    <div className="flex items-center justify-center h-full">
                      <input
                        ref={selectAllRef}
                        type="checkbox"
                        checked={allVisibleSelected}
                        onChange={toggleSelectAllVisible}
                        onClick={(event) => event.stopPropagation()}
                        className="h-2.5 w-2.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                        aria-label="Выбрать все видимые строки"
                      />
                    </div>
                  </th>
                  {Array.from({ length: colCount }, (_, colIndex) => {
                    const isFiltered = columnFilters[colIndex] !== undefined;
                    const isHighlighted = highlightedCol === colIndex;
                    return (
                      <th
                        key={`col-${colIndex}`}
                        draggable
                        onDragStart={(e) => handleColDragStart(e, colIndex)}
                        onDragOver={(e) => handleColDragOver(e, colIndex)}
                        onDrop={(e) => handleColDrop(e, colIndex)}
                        onDragEnd={handleColDragEnd}
                        onClick={(event) => handleColumnHeaderClick(colIndex, event.shiftKey, event.ctrlKey || event.metaKey)}
                        onContextMenu={(event) => {
                          if (
                            !(
                              selectionMode === 'col' &&
                              colIndex >= normalizedSelection.startCol &&
                              colIndex <= normalizedSelection.endCol
                            )
                          ) {
                            handleColumnHeaderClick(colIndex, false);
                          }
                          openContextMenu(event, 'col');
                        }}
                        style={{ width: getColumnWidth(colIndex), minWidth: getColumnWidth(colIndex), maxWidth: getColumnWidth(colIndex) }}
                        className={`sticky top-0 z-10 relative cursor-grab border-b border-r border-gray-200 px-1 py-px text-[10px] font-semibold text-gray-700 transition select-none overflow-hidden ${
                          dragOverCol === colIndex
                            ? 'bg-blue-200 border-l-2 border-l-blue-500'
                            : selectionMode === 'col' &&
                              colIndex >= normalizedSelection.startCol &&
                              colIndex <= normalizedSelection.endCol
                              ? 'bg-blue-100 text-blue-900'
                              : isHighlighted
                                ? 'bg-purple-100 text-purple-900'
                                : 'bg-gray-50 hover:bg-gray-100'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-1">
                          <span className="truncate">{toColumnLabel(colIndex)}</span>
                          <button
                            type="button"
                            onClick={(event) => openFilterMenu(event, colIndex)}
                            className={`flex h-5 w-5 items-center justify-center rounded text-gray-400 hover:bg-gray-200 hover:text-gray-600 ${isFiltered ? 'text-blue-600 font-bold' : ''}`}
                            aria-label="Фильтр колонки"
                          >
                             ▼
                          </button>
                        </div>
                        <div
                          onMouseDown={(event) => startColumnResize(event, colIndex)}
                          className="absolute -right-1 top-0 h-full w-3 cursor-col-resize z-20 hover:bg-blue-400/50 active:bg-blue-500/50"
                        />
                      </th>
                    );
                  })}
                  <th className="sticky top-0 z-10 border-b border-gray-200 bg-gray-50 px-1 py-0.5 w-8">
                    <button
                      type="button"
                      onClick={handleAddColumn}
                      className="flex h-4 w-4 items-center justify-center rounded text-gray-400 hover:bg-gray-200 hover:text-gray-600 transition-colors text-xs"
                      aria-label="Добавить колонку"
                    >
                      +
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {isLargeTable && virtualRange.top > 0 && (
                  <tr aria-hidden>
                    <td colSpan={colCount + 2} style={{ height: virtualRange.top }} />
                  </tr>
                )}
                {rowIndicesToRender.map((rowIndex) => {
                  const row = activeTab?.data[rowIndex];
                  if (!row) return null;
                  const isChecked = selectedRows.has(rowIndex);
                  const isHeaderRow = rowIndex === 0;
                  const rowMarks = reviewMarksMap.get(rowIndex);
                  const rowMarkColor = rowMarks?.[0]?.color || '';
                  const rowHasComment = rowMarks?.some((m) => m.comment);
                  return (
                    <tr
                      key={`row-${rowIndex}`}
                      className="group"
                      style={{
                        ...(isLargeTable ? { height: VIRTUAL_ROW_HEIGHT } : {}),
                        ...(rowMarkColor ? { backgroundColor: rowMarkColor } : {}),
                      }}
                    >
                      <th
                        draggable={!isHeaderRow}
                        onDragStart={(e) => handleRowDragStart(e, rowIndex)}
                        onDragOver={(e) => handleRowDragOver(e, rowIndex)}
                        onDrop={(e) => handleRowDrop(e, rowIndex)}
                        onDragEnd={handleRowDragEnd}
                        onClick={(event) => handleRowHeaderClick(rowIndex, event.shiftKey, event.ctrlKey || event.metaKey)}
                        onContextMenu={(event) => {
                          if (
                            !(
                              selectionMode === 'row' &&
                              rowIndex >= normalizedSelection.startRow &&
                              rowIndex <= normalizedSelection.endRow
                            )
                          ) {
                            handleRowHeaderClick(rowIndex, false);
                          }
                          openContextMenu(event, 'row');
                        }}
                        className={`sticky left-0 z-10 border-b border-r border-gray-200 px-0.5 py-px text-[10px] font-medium transition-colors select-none ${
                          isHeaderRow ? 'cursor-default' : 'cursor-grab'
                        } ${
                          dragOverRow === rowIndex
                            ? 'bg-blue-200 border-t-2 border-t-blue-500'
                            : selectionMode === 'row' &&
                              rowIndex >= normalizedSelection.startRow &&
                              rowIndex <= normalizedSelection.endRow
                              ? 'bg-blue-100 text-blue-900'
                              : isChecked 
                                ? 'bg-blue-50 text-blue-800'
                                : rowMarkColor
                                  ? 'text-gray-600'
                                  : 'bg-gray-50 text-gray-500 group-hover:bg-gray-100'
                        }`}
                      >
                        <div className="flex items-center justify-center gap-0.5 h-full">
                          <input
                            type="checkbox"
                            checked={isChecked}
                            disabled={isHeaderRow}
                            onChange={() => toggleRowSelection(rowIndex)}
                            onClick={(event) => event.stopPropagation()}
                            className="h-2.5 w-2.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-40"
                            aria-label={`Выбрать строку ${rowIndex + 1}`}
                          />
                          <span className="min-w-[1.2rem] text-center">{rowIndex + 1}</span>
                          {rowHasComment && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                                setReviewMarksPopup({
                                  rowIndex,
                                  marks: rowMarks!.filter((m) => m.comment),
                                  top: rect.bottom + 4,
                                  left: rect.right + 4,
                                });
                              }}
                              className="text-[9px] leading-none opacity-70 hover:opacity-100"
                              title="Комментарии к строке"
                            >
                              💬
                            </button>
                          )}
                        </div>
                      </th>
                      {row.map((value, colIndex) => {
                        const isSelected =
                          rowIndex >= normalizedSelection.startRow &&
                          rowIndex <= normalizedSelection.endRow &&
                          colIndex >= normalizedSelection.startCol &&
                          colIndex <= normalizedSelection.endCol;
                        const isActive =
                          activeCell.row === rowIndex && activeCell.col === colIndex;
                        const cellMatchesSearch =
                          searchTerms.length > 0 &&
                          searchTerms.some((term) =>
                            getNormalizedCell(rowIndex, colIndex, value ?? '').includes(term),
                          );
                        const isHighlighted = highlightedCol === colIndex;
                        const cellBackground = isSelected
                          ? 'bg-blue-50 shadow-[inset_0_0_0_1px_rgba(59,130,246,0.6)]'
                          : cellMatchesSearch
                            ? 'bg-amber-50'
                            : isHighlighted
                              ? 'bg-purple-50'
                              : rowMarkColor ? '' : 'bg-white';

                        return (
                          <td
                            key={`cell-${rowIndex}-${colIndex}`}
                            onMouseDown={(event) => handleCellMouseDown(rowIndex, colIndex, event)}
                            onMouseOver={() => handleCellMouseOver(rowIndex, colIndex)}
                            onContextMenu={(event) => {
                              const isRowSelected =
                                selectionMode === 'row' &&
                                rowIndex >= normalizedSelection.startRow &&
                                rowIndex <= normalizedSelection.endRow;
                              const isColSelected =
                                selectionMode === 'col' &&
                                colIndex >= normalizedSelection.startCol &&
                                colIndex <= normalizedSelection.endCol;

                              if (!isSelected && !isRowSelected && !isColSelected) {
                                setSelection({
                                  startRow: rowIndex,
                                  startCol: colIndex,
                                  endRow: rowIndex,
                                  endCol: colIndex,
                                });
                                setActiveCell({ row: rowIndex, col: colIndex });
                                openContextMenu(event, 'cell');
                                return;
                              }

                              if (isRowSelected) {
                                openContextMenu(event, 'row');
                                return;
                              }

                              if (isColSelected) {
                                openContextMenu(event, 'col');
                                return;
                              }

                              openContextMenu(event, 'cell');
                            }}
                            style={{
                              width: getColumnWidth(colIndex),
                              minWidth: getColumnWidth(colIndex),
                              maxWidth: getColumnWidth(colIndex),
                            }}
                            className={`border-b border-r border-gray-200 p-0 align-top overflow-hidden ${cellBackground}`}
                          >
                            {isActive ? (
                              <textarea
                                value={value}
                                onChange={(event) => {
                                  handleValueChange(rowIndex, colIndex, event.target.value);
                                  if (!isLargeTable) {
                                    event.target.style.height = 'auto';
                                    event.target.style.height = `${event.target.scrollHeight}px`;
                                  }
                                }}
                                onFocus={(e) => {
                                  handleCellFocus(rowIndex, colIndex);
                                  if (!isLargeTable) {
                                    e.target.style.height = 'auto';
                                    e.target.style.height = `${e.target.scrollHeight}px`;
                                  }
                                }}
                                onKeyDown={handleKeyDown}
                                onPaste={handlePaste}
                                rows={1}
                              wrap={effectiveWrapCells ? 'soft' : 'off'}
                                autoFocus
                                suppressHydrationWarning
                                spellCheck={false}
                                data-gramm="false"
                                data-gramm_editor="false"
                                data-enable-grammarly="false"
                                data-lt-active="false"
                              className={`w-full bg-transparent px-1 py-px text-[11px] text-gray-900 outline-none resize-none min-h-[18px] leading-tight ring-2 ring-blue-500 ring-inset z-10 relative ${
                                effectiveWrapCells
                                  ? 'whitespace-pre-wrap break-words overflow-hidden'
                                  : 'whitespace-nowrap overflow-x-auto overflow-y-hidden no-scrollbar'
                              }`}
                              />
                            ) : (
                              <div
                                className={`w-full h-full min-h-[18px] px-1 py-px text-[11px] text-gray-900 leading-tight ${
                                  effectiveWrapCells ? 'whitespace-pre-wrap break-words' : 'truncate'
                                } ${cellMatchesSearch ? 'ring-1 ring-amber-300 ring-inset' : ''}`}
                                title={!effectiveWrapCells ? value : undefined}
                              >
                                {value}
                              </div>
                            )}
                          </td>
                        );
                      })}
                      <td className="border-b border-gray-200 bg-gray-50" />
                    </tr>
                  );
                })}
                {isLargeTable && virtualRange.bottom > 0 && (
                  <tr aria-hidden>
                    <td colSpan={colCount + 2} style={{ height: virtualRange.bottom }} />
                  </tr>
                )}
                {rowCount > 0 && (
                  <tr>
                    <th className="sticky left-0 z-10 border-r border-gray-200 bg-gray-50 px-1 py-0.5">
                      <div className="flex items-center justify-center h-full">
                        <button
                          type="button"
                          onClick={handleAddRow}
                          className="flex h-4 w-4 items-center justify-center rounded text-gray-400 hover:bg-gray-200 hover:text-gray-600 transition-colors text-xs"
                          aria-label="Добавить строку"
                        >
                          +
                        </button>
                      </div>
                    </th>
                    {Array.from({ length: colCount }, (_, colIndex) => (
                      <td key={`add-row-${colIndex}`} className="border-b border-r border-gray-200 bg-gray-50" />
                    ))}
                    <td className="border-b border-gray-200 bg-gray-50" />
                  </tr>
                )}
                {rowCount === 0 && (
                  <tr>
                    <td className="px-4 py-8 text-center text-sm text-gray-500" colSpan={colCount + 2}>
                      Таблица пуста. Добавьте строки или вкладку.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            )}
          </div>
        </div>

        {rightPanelOpen && (
        <aside className="rounded border border-gray-200 bg-white p-2 h-fit text-xs overflow-y-auto">
          <div className="flex items-center gap-1 rounded bg-gray-50 p-0.5 text-[10px] mb-2">
            <button
              type="button"
              onClick={() => setRightPanelTab('summary')}
              className={`flex-1 rounded px-2 py-1 font-medium transition-all ${
                rightPanelTab === 'summary'
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              Сводка
            </button>
            <button
              type="button"
              onClick={() => setRightPanelTab('cleanup')}
              className={`flex-1 rounded px-2 py-1 font-medium transition-all ${
                rightPanelTab === 'cleanup'
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              Очистка
            </button>
          </div>
          {rightPanelTab === 'summary' ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-gray-900">Сводка по компаниям</h3>
                {groupByCol !== null && columnFilters[groupByCol] && (
                  <button
                    type="button"
                    onClick={() => resetFilter(groupByCol)}
                    className="text-xs font-medium text-blue-600 hover:text-blue-700"
                  >
                    Сбросить
                  </button>
                )}
              </div>
              {colCount === 0 ? (
                <div className="rounded-lg border border-dashed border-gray-200 bg-gray-50 p-6 text-center text-xs text-gray-400">
                  Нет колонок для группировки
                </div>
              ) : (
                <>
                  <div className="space-y-2">
                    <select
                      value={groupByCol ?? ''}
                      onChange={(event) => setGroupByCol(Number(event.target.value))}
                      className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-gray-700 outline-none focus:border-gray-400 transition-all"
                    >
                      {headerLabels.map((label, index) => (
                        <option key={`group-col-${index}`} value={index}>
                          {label}
                        </option>
                      ))}
                    </select>
                    <input
                      value={groupSearch}
                      onChange={(event) => setGroupSearch(event.target.value)}
                      placeholder="Поиск..."
                      className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-gray-700 outline-none focus:border-gray-400 transition-all"
                    />
                  </div>
                  <div className="flex items-center justify-between text-[10px] uppercase font-semibold text-gray-400 tracking-wider px-1">
                    <span>Всего: {groupSummary.length}</span>
                    <span>Строк: {visibleRowIndices.length}</span>
                  </div>
                  <div className="max-h-[360px] space-y-1 overflow-auto pr-1">
                    {filteredGroupSummary.length === 0 && (
                      <div className="rounded-lg border border-dashed border-gray-200 bg-gray-50 p-4 text-center text-xs text-gray-400">
                        Нет данных
                      </div>
                    )}
                    {filteredGroupSummary.slice(0, groupSummaryLimit).map((item) => {
                      const activeKeys =
                        groupByCol !== null ? columnFilters[groupByCol] : undefined;
                      const isActive = activeKeys?.length === 1 && activeKeys[0] === item.key;
                      return (
                        <button
                          key={`group-${item.key}`}
                          type="button"
                          onClick={() => applyGroupFilter(item.key)}
                          className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-xs transition-all ${
                            isActive
                              ? 'bg-gray-100 text-gray-900 font-medium'
                              : 'text-gray-600 hover:bg-gray-50'
                          }`}
                        >
                          <span className="truncate mr-2">{item.label}</span>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${isActive ? 'bg-white text-gray-900 border border-gray-200' : 'bg-gray-100 text-gray-500'}`}>{item.count}</span>
                        </button>
                      );
                    })}
                    {filteredGroupSummary.length > groupSummaryLimit && (
                      <button
                        type="button"
                        onClick={() => setGroupSummaryLimit((prev) => prev + GROUP_SUMMARY_PAGE_SIZE)}
                        className="w-full rounded-md px-3 py-2 text-[11px] text-gray-400 hover:bg-gray-50 hover:text-gray-600 transition-all"
                      >
                        Показать ещё ({filteredGroupSummary.length - groupSummaryLimit})
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="space-y-6 text-xs text-gray-600">
              <div className="rounded-lg border border-amber-100 bg-amber-50 p-3 text-amber-800 leading-relaxed">
                Действия ниже необратимы для данных (кроме отмены последнего шага).
              </div>
              
              {lastAction && (
                <div className="rounded-lg border border-blue-100 bg-blue-50 p-3">
                  <div className="flex flex-col gap-2">
                    <span className="text-blue-900 font-medium">
                      {lastAction.message}
                    </span>
                    <div className="flex items-center justify-between">
                        <span className="text-blue-400 text-[10px]">{formatTime(lastAction.time)}</span>
                        {lastUndo && (
                        <button
                            type="button"
                            onClick={handleUndo}
                            className="rounded bg-white px-2 py-1 text-[10px] font-semibold text-blue-700 shadow-sm border border-blue-100 hover:bg-blue-50 transition-colors"
                        >
                            Отменить
                        </button>
                        )}
                    </div>
                  </div>
                </div>
              )}

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-gray-900">Дубликаты</span>
                </div>
                <div className="space-y-2">
                  <button
                    type="button"
                    onClick={handleRemoveDuplicates}
                    className="w-full text-left rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-700 transition hover:bg-gray-50 hover:border-gray-300"
                  >
                    Убрать полные дубликаты
                  </button>
                  <button
                    type="button"
                    onClick={() => setDedupModal({ isOpen: true, mode: 'email', col: 0 })}
                    className="w-full text-left rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-700 transition hover:bg-gray-50 hover:border-gray-300"
                  >
                    Убрать дубликаты по Email
                  </button>
                  <button
                    type="button"
                    onClick={() => setDedupModal({ isOpen: true, mode: 'company', col: 0 })}
                    className="w-full text-left rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-700 transition hover:bg-gray-50 hover:border-gray-300"
                  >
                    Убрать дубликаты по компании
                  </button>
                </div>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-gray-900">Разделение</span>
                </div>
                <div className="space-y-2">
                  <button
                    type="button"
                    onClick={openEmailSplitModal}
                    className="w-full text-left rounded-lg border border-violet-200 bg-violet-50/40 px-3 py-2 text-xs font-medium text-violet-800 transition hover:bg-violet-50 hover:border-violet-300"
                  >
                    Разделить почты по строкам
                  </button>
                  <button
                    type="button"
                    onClick={openPhoneSplitModal}
                    className="w-full text-left rounded-lg border border-violet-200 bg-violet-50/40 px-3 py-2 text-xs font-medium text-violet-800 transition hover:bg-violet-50 hover:border-violet-300"
                  >
                    Разделить телефоны по строкам
                  </button>
                </div>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-gray-900">Очистка</span>
                </div>
                <div className="space-y-2">
                  <button
                    type="button"
                    onClick={handleRemoveEmptyRows}
                    className="w-full text-left rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-700 transition hover:bg-gray-50 hover:border-gray-300"
                  >
                    Удалить пустые строки
                  </button>
                  <button
                    type="button"
                    onClick={handleRemoveEmptyColumns}
                    className="w-full text-left rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-700 transition hover:bg-gray-50 hover:border-gray-300"
                  >
                    Удалить пустые колонки
                  </button>
                  <button
                    type="button"
                    onClick={handleCleanInvisibleWhitespace}
                    className="w-full text-left rounded-lg border border-cyan-200 bg-cyan-50/40 px-3 py-2 text-xs font-medium text-cyan-800 transition hover:bg-cyan-50 hover:border-cyan-300"
                  >
                    Очистить невидимые символы (Instantly)
                  </button>
                </div>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-gray-900">Нормализация</span>
                </div>
                <div className="space-y-2 rounded-lg border border-gray-100 bg-gray-50 p-3">
                  <label className="flex cursor-pointer items-center justify-between group">
                    <span className="text-gray-600 group-hover:text-gray-900 transition-colors">Нижний регистр</span>
                    <input
                        type="checkbox"
                        checked={normalizeLowercase}
                        onChange={(event) => setNormalizeLowercase(event.target.checked)}
                        className="h-3.5 w-3.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                      />
                  </label>
                  <label className="flex cursor-pointer items-center justify-between group">
                    <span className="text-gray-600 group-hover:text-gray-900 transition-colors">Убрать лишние пробелы</span>
                    <input
                        type="checkbox"
                        checked={normalizeSpaces}
                        onChange={(event) => setNormalizeSpaces(event.target.checked)}
                        className="h-3.5 w-3.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                      />
                  </label>
                  <label className="flex cursor-pointer items-center justify-between group">
                    <span className="text-gray-600 group-hover:text-gray-900 transition-colors">Убрать эмодзи</span>
                    <input
                        type="checkbox"
                        checked={normalizeEmoji}
                        onChange={(event) => setNormalizeEmoji(event.target.checked)}
                        className="h-3.5 w-3.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                      />
                  </label>
                  <button
                    type="button"
                    onClick={applyNormalizationToData}
                    className="mt-2 w-full rounded-md bg-white border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 shadow-sm hover:bg-gray-50 hover:border-gray-300 transition-all"
                  >
                    Применить
                  </button>
                </div>
              </div>
            </div>
          )}
        </aside>
        )}
      </div>
      {showBottomHorizontalScrollbar && fixedScrollbarViewport.width > 0 && (
        <div
          className="pointer-events-none fixed bottom-2 z-40"
          style={{ left: fixedScrollbarViewport.left, width: fixedScrollbarViewport.width }}
        >
          <div className="rounded border border-gray-300 bg-white/90 px-1 py-0.5 shadow-md backdrop-blur">
            <input
              type="range"
              min={0}
              max={horizontalSliderMax}
              value={horizontalSliderValue}
              onChange={(event) => {
                const wrapper = tableWrapperRef.current;
                const next = Number(event.target.value);
                if (wrapper) {
                  wrapper.scrollLeft = next;
                }
                setHorizontalScrollLeft(next);
              }}
              disabled={horizontalScrollMax <= 0}
              className="pointer-events-auto block h-2 w-full cursor-ew-resize accent-gray-700 disabled:cursor-default"
              aria-label="Горизонтальный скролл таблицы"
            />
          </div>
        </div>
      )}
      {filterMenu && (
        <div
          ref={filterMenuRef}
          className="fixed z-50 w-72 rounded-lg border border-gray-200 bg-white shadow-xl"
          style={{ top: filterMenu.y, left: filterMenu.x }}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div className="border-b border-gray-100 px-3 py-2 text-xs font-semibold text-gray-500 bg-gray-50 rounded-t-lg">
            Фильтр {toColumnLabel(filterMenu.col)}
          </div>
          <div className="px-3 pt-2">
            <input
              value={filterMenu.search}
              onChange={(event) =>
                setFilterMenu((prev) =>
                  prev ? { ...prev, search: event.target.value } : prev,
                )
              }
              placeholder="Поиск значения..."
              className="w-full rounded-md border border-gray-200 px-2 py-1.5 text-xs text-gray-700 outline-none focus:border-gray-400"
            />
          </div>
          <div className="flex items-center justify-between px-3 py-2 text-[11px] text-gray-500">
            <span>
              Выбрано: {selectedFilterKeys.size}/{filterMenu.options.length}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => resetFilter(filterMenu.col)}
                className="text-gray-600 hover:text-gray-900"
              >
                Сбросить
              </button>
              <button
                type="button"
                onClick={() => clearFilter(filterMenu.col)}
                className="text-gray-600 hover:text-gray-900"
              >
                Очистить
              </button>
            </div>
          </div>
          <div className="max-h-56 overflow-auto px-2 pb-2">
            {filteredFilterOptions.length === 0 && (
              <div className="px-2 py-3 text-xs text-gray-500">Нет значений</div>
            )}
            {filteredFilterOptions.map((option) => (
              <label
                key={option.key || '__blank__'}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
              >
                <input
                  type="checkbox"
                  checked={selectedFilterKeys.has(option.key)}
                  onChange={() => toggleFilterOption(filterMenu.col, option.key, filterMenu.options)}
                  className="h-3.5 w-3.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="truncate">{option.label}</span>
              </label>
            ))}
          </div>
          {filterMenu.overflow && (
            <div className="border-t border-gray-100 px-3 py-2 text-[11px] text-gray-400">
              Показаны первые {MAX_FILTER_OPTIONS} значений.
            </div>
          )}
        </div>
      )}
      {confirmState && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4">
          <div className="w-full max-w-sm rounded-xl border border-gray-200 bg-white p-6 shadow-2xl">
            <h4 className="text-base font-semibold text-gray-900">{confirmState.title}</h4>
            <p className="mt-2 text-sm text-gray-600">{confirmState.message}</p>
            <div className="mt-6 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={handleCancelConfirm}
                className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={handleConfirm}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 transition-colors shadow-sm"
              >
                {confirmState.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-50 w-44 rounded border border-gray-200 bg-white py-0.5 shadow-xl"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button
            type="button"
            onClick={() => {
              void copySelection();
              setContextMenu(null);
            }}
            className="w-full px-2.5 py-1.5 text-left text-[11px] text-gray-700 hover:bg-gray-50 transition-colors"
          >
            Копировать
          </button>
          <div className="my-0.5 border-t border-gray-100" />
          <button
            type="button"
            onClick={() => {
              handleInsertRowAbove(normalizedSelection.startRow);
              setContextMenu(null);
            }}
            className="w-full px-2.5 py-1.5 text-left text-[11px] text-gray-700 hover:bg-gray-50 transition-colors"
          >
            Вставить строку выше
          </button>
          <button
            type="button"
            onClick={() => {
              handleInsertRowBelow(normalizedSelection.endRow);
              setContextMenu(null);
            }}
            className="w-full px-2.5 py-1.5 text-left text-[11px] text-gray-700 hover:bg-gray-50 transition-colors"
          >
            Вставить строку ниже
          </button>
          <div className="my-0.5 border-t border-gray-100" />
          <button
            type="button"
            onClick={() => {
              confirmDeleteSelection();
              setContextMenu(null);
            }}
            className="w-full px-2.5 py-1.5 text-left text-[11px] text-red-600 hover:bg-red-50 transition-colors"
          >
            Удалить
          </button>
        </div>
      )}
      {personalization.isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 backdrop-blur-sm transition-all">
          <div className="w-full max-w-lg rounded-2xl border border-gray-200 bg-white shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4 bg-gray-50/50">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gray-900 text-white shadow-sm font-bold">
                  AI
                </div>
                <div>
                  <h3 className="text-lg font-bold text-gray-900">Персонализация</h3>
                  <p className="text-xs text-gray-500 font-medium">Генерация предложений на основе данных</p>
                </div>
              </div>
              <button
                type="button"
                onClick={closePersonalizationModal}
                disabled={personalization.isGenerating}
                className="rounded-lg p-2 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 disabled:opacity-50 text-xl leading-none"
              >
                &times;
              </button>
            </div>

            <div className="space-y-5 px-6 py-5 max-h-[65vh] overflow-y-auto">
              {personalization.error && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 font-medium">
                  {personalization.error}
                </div>
              )}

              <div className="space-y-2">
                <label className="block text-sm font-semibold text-gray-700">
                  Столбец с данными
                </label>
                <div className="relative">
                  <select
                    value={personalization.sourceCol}
                    onChange={(e) =>
                      setPersonalization((prev) => ({
                        ...prev,
                        sourceCol: Number(e.target.value),
                        error: null,
                      }))
                    }
                    disabled={personalization.isGenerating}
                    className="w-full appearance-none rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-900 outline-none transition-all hover:bg-gray-100 focus:border-gray-400 focus:bg-white disabled:opacity-60"
                  >
                    {headerLabels.map((label, index) => (
                      <option key={`pers-col-${index}`} value={index}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <div className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 text-xs">
                    ▼
                  </div>
                </div>
                <p className="text-xs text-gray-500 px-1">
                  Источник данных: вакансии, описание компании или сфера деятельности
                </p>
              </div>

              <div className="space-y-2">
                <label className="block text-sm font-semibold text-gray-700">Пресеты</label>
                <div className="flex flex-wrap gap-2">
                  {PERSONALIZATION_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() =>
                        setPersonalization((prev) => {
                          const deselect = prev.activePreset === preset.id;
                          return {
                            ...prev,
                            activePreset: deselect ? null : preset.id,
                            prompt: deselect ? '' : preset.prompt,
                            error: null,
                            ...(deselect ? { briefText: '', briefFileName: '' } : {}),
                          };
                        })
                      }
                      disabled={personalization.isGenerating}
                      className={`rounded-lg border px-3 py-2 text-xs font-medium transition-all ${
                        personalization.activePreset === preset.id
                          ? 'border-gray-900 bg-gray-900 text-white shadow-sm'
                          : 'border-gray-200 bg-gray-50 text-gray-700 hover:border-gray-300 hover:bg-gray-100'
                      } disabled:opacity-50`}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-gray-400">Пресет заполнит промпт автоматически. Или напишите свой промпт вручную.</p>
              </div>

              {personalization.activePreset != null && PERSONALIZATION_PRESETS.find((p) => p.id === personalization.activePreset)?.needsBrief && (
                <div className="space-y-2">
                  <label className="block text-sm font-semibold text-gray-700">Бриф вашей компании (PDF)</label>
                  <input
                    ref={personalizationBriefInputRef}
                    type="file"
                    accept=".pdf"
                    onChange={(e) => void handlePersonalizationBriefUpload(e)}
                    className="hidden"
                  />
                  {!personalization.briefText ? (
                    <button
                      type="button"
                      onClick={() => personalizationBriefInputRef.current?.click()}
                      disabled={personalization.isBriefUploading || personalization.isGenerating}
                      className="w-full rounded-xl border-2 border-dashed border-gray-300 bg-gray-50 p-5 text-center transition hover:border-gray-400 hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {personalization.isBriefUploading ? (
                        <div className="flex flex-col items-center gap-1.5">
                          <span className="animate-spin text-xl">⟳</span>
                          <span className="text-xs text-gray-500">Загрузка {personalization.briefFileName}...</span>
                        </div>
                      ) : (
                        <div className="flex flex-col items-center gap-1.5">
                          <span className="text-2xl">📄</span>
                          <span className="text-xs font-medium text-gray-600">Загрузите PDF бриф</span>
                          <span className="text-[10px] text-gray-400">AI будет определять боли клиентов через призму вашего продукта</span>
                        </div>
                      )}
                    </button>
                  ) : (
                    <div className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="text-base">✅</span>
                          <span className="text-xs font-medium text-emerald-800">{personalization.briefFileName}</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => setPersonalization((prev) => ({ ...prev, briefText: '', briefFileName: '', error: null }))}
                          disabled={personalization.isGenerating}
                          className="text-[10px] text-gray-500 hover:text-gray-700 disabled:opacity-50"
                        >
                          Заменить
                        </button>
                      </div>
                      <p className="mt-1.5 text-[10px] text-gray-500 line-clamp-2">{personalization.briefText.slice(0, 200)}...</p>
                    </div>
                  )}
                </div>
              )}

              <div className="space-y-2">
                <label className="block text-sm font-semibold text-gray-700">
                  {personalization.activePreset ? 'Промпт (заполнен пресетом)' : 'Промпт для генерации'}
                </label>
                <div className="relative">
                  <textarea
                    value={personalization.prompt}
                    onChange={(e) =>
                      setPersonalization((prev) => ({
                        ...prev,
                        prompt: e.target.value,
                        activePreset: null,
                        error: null,
                      }))
                    }
                    disabled={personalization.isGenerating}
                    placeholder="Например: Напиши короткое предложение о том, как наши услуги помогут компании..."
                    rows={personalization.activePreset ? 4 : 6}
                    className="w-full resize-y rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-900 outline-none transition-all placeholder:text-gray-400 focus:border-gray-400 disabled:opacity-60"
                  />
                </div>
                {personalization.activePreset && (
                  <p className="text-[10px] text-gray-400">Промпт заполнен пресетом. Редактирование вручную отвяжет пресет.</p>
                )}
              </div>

              {personalization.isGenerating && (
                <div className="rounded-xl border border-gray-100 bg-gray-50 px-4 py-4">
                  <div className="mb-3 flex items-center justify-between text-sm">
                    <span className="flex items-center gap-2 font-medium text-gray-900">
                      <span className="animate-pulse">●</span>
                      Генерация...
                    </span>
                    <span className="font-mono text-xs font-medium text-gray-500 bg-white px-2 py-1 rounded border border-gray-200">
                      {personalization.currentRow} / {personalization.totalRows}
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-gray-200">
                    <div
                      className="h-full bg-gray-900 transition-all duration-300 ease-out"
                      style={{ width: `${personalization.progress}%` }}
                    />
                  </div>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between border-t border-gray-100 px-6 py-4 bg-gray-50/50">
              <div className="text-xs font-medium text-gray-500">
                Будет обработано: <span className="text-gray-900">{visibleRowIndices.length} строк</span>
              </div>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={closePersonalizationModal}
                  disabled={personalization.isGenerating}
                  className="rounded-lg px-4 py-2.5 text-sm font-medium text-gray-600 transition hover:bg-gray-200 hover:text-gray-900 disabled:opacity-50"
                >
                  {personalization.isGenerating ? 'Отменить' : 'Закрыть'}
                </button>
                <button
                  type="button"
                  onClick={() => void handleStartPersonalization()}
                  disabled={personalization.isGenerating || !personalization.prompt.trim() || personalization.isBriefUploading || (!!personalization.activePreset && PERSONALIZATION_PRESETS.find((p) => p.id === personalization.activePreset)?.needsBrief === true && !personalization.briefText.trim())}
                  className="inline-flex items-center gap-2 rounded-lg bg-gray-900 px-5 py-2.5 text-sm font-medium text-white shadow-lg shadow-gray-900/20 transition-all hover:bg-gray-800 hover:shadow-xl hover:-translate-y-0.5 active:translate-y-0 disabled:bg-gray-300 disabled:shadow-none disabled:translate-y-0 disabled:cursor-not-allowed"
                >
                  {personalization.isGenerating ? (
                    <>
                      <span className="animate-spin">⟳</span>
                      Обработка...
                    </>
                  ) : (
                    <>
                      <span>AI</span>
                      Сгенерировать
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {websiteEnrichment.isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 backdrop-blur-sm transition-all">
          <div className="w-full max-w-lg rounded-2xl border border-gray-200 bg-white shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4 bg-gray-50/50">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-600 text-white shadow-sm font-bold text-lg">
                  W
                </div>
                <div>
                  <h3 className="text-lg font-bold text-gray-900">Обогатить с сайта</h3>
                  <p className="text-xs text-gray-500 font-medium">Парсинг информации о компании с сайта</p>
                </div>
              </div>
              <button
                type="button"
                onClick={closeWebsiteEnrichmentModal}
                className="rounded-lg p-2 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 text-xl leading-none"
              >
                &times;
              </button>
            </div>

            <div className="space-y-6 px-6 py-6">
              {websiteEnrichment.error && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 font-medium">
                  {websiteEnrichment.error}
                </div>
              )}

              <div className="space-y-2">
                <label className="block text-sm font-semibold text-gray-700">
                  Столбец с сайтами
                </label>
                <div className="relative">
                  <select
                    value={websiteEnrichment.sourceCol}
                    onChange={(e) =>
                      setWebsiteEnrichment((prev) => ({
                        ...prev,
                        sourceCol: Number(e.target.value),
                        error: null,
                      }))
                    }
                    disabled={websiteEnrichment.isGenerating}
                    className="w-full appearance-none rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-900 outline-none transition-all hover:bg-gray-100 focus:border-gray-400 focus:bg-white disabled:opacity-60"
                  >
                    {headerLabels.map((label, index) => (
                      <option key={`enrich-col-${index}`} value={index}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <div className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 text-xs">
                    ▼
                  </div>
                </div>
                <p className="text-xs text-gray-500 px-1">
                  В ячейках должны быть URL компаний (example.com или https://...)
                </p>
              </div>

              {enrichmentOptions.length > 0 && (
                <div className="space-y-2">
                  <label className="block text-sm font-semibold text-gray-700">
                    Колонка для дозаполнения
                  </label>
                  <div className="relative">
                    <select
                      value={enrichmentTargetCol ?? ''}
                      onChange={(e) => {
                        const nextValue = Number(e.target.value);
                        setEnrichmentTargetOverride(Number.isNaN(nextValue) ? null : nextValue);
                      }}
                      disabled={websiteEnrichment.isGenerating}
                      className="w-full appearance-none rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-900 outline-none transition-all hover:bg-gray-100 focus:border-gray-400 focus:bg-white disabled:opacity-60"
                    >
                      {enrichmentOptions.map((candidate) => (
                        <option key={`enrich-target-${candidate.col}`} value={candidate.col}>
                          {toColumnLabel(candidate.col)} — {candidate.label}
                          {candidate.isEnrichment ? ' [Обогащение]' : ''} (пустых {candidate.missing})
                        </option>
                      ))}
                    </select>
                    <div className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 text-xs">
                      ▼
                    </div>
                  </div>
                  <p className="text-xs text-gray-500 px-1">
                    Дозаполнит только пустые ячейки в выбранной колонке.
                  </p>
                  {enrichmentTargetCol !== null && (
                    <p className="text-xs text-gray-500 px-1">
                      Пустых в колонке обогащения:{' '}
                      <span className="font-semibold text-gray-700">{missingEnrichmentCount}</span>
                    </p>
                  )}
                </div>
              )}

              {websiteEnrichment.isGenerating ? (
                <div className="rounded-lg border border-blue-100 bg-blue-50 px-4 py-3">
                  <p className="text-xs text-blue-700 leading-relaxed">
                    Обогащение выполняется в фоне. Прогресс отображается справа сверху. Можно закрыть окно и продолжать работу.
                  </p>
                </div>
              ) : (
                <div className="rounded-lg border border-blue-100 bg-blue-50 px-4 py-3">
                  <p className="text-xs text-blue-700 leading-relaxed">
                    Для каждого URL будет загружена главная страница и страница «О компании» (/about).
                    Извлечённый текст будет добавлен в новую колонку.
                  </p>
                </div>
              )}

              {websiteEnrichment.isGenerating && (
                <div className="rounded-xl border border-gray-100 bg-gray-50 px-4 py-4">
                  <div className="mb-3 flex items-center justify-between text-sm">
                    <span className="flex items-center gap-2 font-medium text-gray-900">
                      <span className="animate-pulse">●</span>
                      Обогащение...
                    </span>
                    <span className="font-mono text-xs font-medium text-gray-500 bg-white px-2 py-1 rounded border border-gray-200">
                      {websiteEnrichment.currentRow} / {websiteEnrichment.totalRows}
                    </span>
                  </div>
                  {websiteEnrichment.retryCount > 0 && (
                    <div className="mb-2 text-xs text-amber-600">
                      Ретраи: {websiteEnrichment.retryCount}
                    </div>
                  )}
                  <div className="h-2 w-full overflow-hidden rounded-full bg-gray-200">
                    <div
                      className="h-full bg-blue-600 transition-all duration-300 ease-out"
                      style={{ width: `${websiteEnrichment.progress}%` }}
                    />
                  </div>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between border-t border-gray-100 px-6 py-4 bg-gray-50/50">
              <div className="text-xs font-medium text-gray-500">
                {websiteEnrichment.isGenerating ? (
                  <>Обработано: {websiteEnrichment.currentRow} / {websiteEnrichment.totalRows}</>
                ) : (
                  <>Будет обработано: <span className="text-gray-900">{visibleRowIndices.length} строк</span></>
                )}
              </div>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={closeWebsiteEnrichmentModal}
                  className="rounded-lg px-4 py-2.5 text-sm font-medium text-gray-600 transition hover:bg-gray-200 hover:text-gray-900"
                >
                  Закрыть
                </button>
                {websiteEnrichment.isGenerating ? (
                  <button
                    type="button"
                    onClick={handleStopWebsiteEnrichment}
                    className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-5 py-2.5 text-sm font-medium text-white shadow transition hover:bg-red-700"
                  >
                    Остановить
                  </button>
                ) : (
                  <>
                    {enrichmentTargetCol !== null && (
                      <button
                        type="button"
                        onClick={() =>
                          void handleStartWebsiteEnrichment({ targetColIndex: enrichmentTargetCol, onlyEmpty: true })
                        }
                        disabled={missingEnrichmentCount === 0}
                        className="inline-flex items-center gap-2 rounded-lg border border-blue-200 bg-white px-4 py-2.5 text-sm font-medium text-blue-600 transition hover:bg-blue-50 disabled:opacity-50 disabled:hover:bg-white"
                        title={missingEnrichmentCount === 0 ? 'Пустых ячеек нет' : 'Заполнить пустые ячейки'}
                      >
                        Дозаполнить пустые
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void handleStartWebsiteEnrichment()}
                      className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white shadow-lg shadow-blue-600/20 transition-all hover:bg-blue-700 hover:shadow-xl hover:-translate-y-0.5 active:translate-y-0"
                    >
                      <span>W</span>
                      Запустить обогащение
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Email Scraping Modal ─────────────────────────────── */}
      {emailScraping.isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 backdrop-blur-sm transition-all">
          <div className="w-full max-w-lg rounded-2xl border border-gray-200 bg-white shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4 bg-gray-50/50">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-rose-600 text-white shadow-sm font-bold text-lg">
                  @
                </div>
                <div>
                  <h3 className="text-lg font-bold text-gray-900">Найти почты</h3>
                  <p className="text-xs text-gray-500 font-medium">Извлечение email-адресов с сайтов компаний</p>
                </div>
              </div>
              <button
                type="button"
                onClick={closeEmailScrapingModal}
                className="rounded-lg p-2 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 text-xl leading-none"
              >
                &times;
              </button>
            </div>

            <div className="space-y-6 px-6 py-6">
              {emailScraping.error && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 font-medium">
                  {emailScraping.error}
                </div>
              )}

              <div className="space-y-2">
                <label className="block text-sm font-semibold text-gray-700">
                  Столбец с сайтами
                </label>
                <div className="relative">
                  <select
                    value={emailScraping.sourceCol}
                    onChange={(e) =>
                      setEmailScraping((prev) => ({ ...prev, sourceCol: Number(e.target.value), error: null }))
                    }
                    disabled={emailScraping.isGenerating}
                    className="w-full appearance-none rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-900 outline-none transition-all hover:bg-gray-100 focus:border-gray-400 focus:bg-white disabled:opacity-60"
                  >
                    {headerLabels.map((label, index) => (
                      <option key={`email-scrape-col-${index}`} value={index}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <div className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 text-xs">
                    ▼
                  </div>
                </div>
                <p className="text-xs text-gray-500 px-1">
                  В ячейках могут быть один или несколько URL компаний: через запятую, точку с запятой или перенос строки
                </p>
              </div>

              {emailScraping.isGenerating ? (
                <div className="rounded-lg border border-rose-100 bg-rose-50 px-4 py-3">
                  <p className="text-xs text-rose-700 leading-relaxed">
                    Поиск почт выполняется в фоне. Можно закрыть окно и продолжать работу.
                  </p>
                </div>
              ) : (
                <div className="rounded-lg border border-rose-100 bg-rose-50 px-4 py-3 space-y-1.5">
                  <p className="text-xs text-rose-700 leading-relaxed font-semibold">
                    Глубокий поиск email-адресов:
                  </p>
                  <ul className="text-xs text-rose-700 leading-relaxed list-disc pl-4 space-y-0.5">
                    <li>Главная страница + страницы контактов, о нас, команда</li>
                    <li>mailto-ссылки, JSON-LD (Schema.org), data-атрибуты</li>
                    <li>Деобфускация: [at], (at), &#64; и другие паттерны</li>
                    <li>Фильтрация мусорных email (noreply, system и т.д.)</li>
                  </ul>
                </div>
              )}

              {emailScraping.isGenerating && (
                <div className="rounded-xl border border-gray-100 bg-gray-50 px-4 py-4">
                  <div className="mb-3 flex items-center justify-between text-sm">
                    <span className="flex items-center gap-2 font-medium text-gray-900">
                      <span className="animate-pulse">●</span>
                      Поиск почт...
                    </span>
                    <span className="font-mono text-xs font-medium text-gray-500 bg-white px-2 py-1 rounded border border-gray-200">
                      {emailScraping.currentRow} / {emailScraping.totalRows}
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-gray-200">
                    <div
                      className="h-full bg-rose-600 transition-all duration-300 ease-out"
                      style={{ width: `${emailScraping.progress}%` }}
                    />
                  </div>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between border-t border-gray-100 px-6 py-4 bg-gray-50/50">
              <div className="text-xs font-medium text-gray-500">
                {emailScraping.isGenerating ? (
                  <>Обработано: {emailScraping.currentRow} / {emailScraping.totalRows}</>
                ) : (
                  <>Будет обработано: <span className="text-gray-900">{visibleRowIndices.length} строк</span></>
                )}
              </div>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={closeEmailScrapingModal}
                  className="rounded-lg px-4 py-2.5 text-sm font-medium text-gray-600 transition hover:bg-gray-200 hover:text-gray-900"
                >
                  Закрыть
                </button>
                {emailScraping.isGenerating ? (
                  <button
                    type="button"
                    onClick={() => void handleStopEmailScraping()}
                    className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-5 py-2.5 text-sm font-medium text-white shadow transition hover:bg-red-700"
                  >
                    Остановить
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void handleStartEmailScraping()}
                    className="inline-flex items-center gap-2 rounded-lg bg-rose-600 px-5 py-2.5 text-sm font-medium text-white shadow-lg shadow-rose-600/20 transition-all hover:bg-rose-700 hover:shadow-xl hover:-translate-y-0.5 active:translate-y-0"
                  >
                    <span>@</span>
                    Найти почты
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Email Validation Modal ─────────────────────────────── */}
      {emailValidation.isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 backdrop-blur-sm transition-all">
          <div className="w-full max-w-lg rounded-2xl border border-gray-200 bg-white shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4 bg-gray-50/50">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-600 text-white shadow-sm font-bold text-lg">
                  ✓
                </div>
                <div>
                  <h3 className="text-lg font-bold text-gray-900">Валидация почт</h3>
                  <p className="text-xs text-gray-500 font-medium">Проверка существования и качества email-адресов</p>
                </div>
              </div>
              <button
                type="button"
                onClick={closeEmailValidationModal}
                className="rounded-lg p-2 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 text-xl leading-none"
              >
                &times;
              </button>
            </div>

            <div className="space-y-6 px-6 py-6">
              {emailValidation.detectedJob && !emailValidation.isValidating && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 font-medium space-y-2">
                  <p>Найдена незавершённая валидация ({emailValidation.detectedJob.progress}% — {emailValidation.detectedJob.processed}/{emailValidation.detectedJob.total}).</p>
                  <button
                    type="button"
                    onClick={() => void handleResumeEmailValidation()}
                    className="inline-flex items-center gap-2 rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white shadow transition hover:bg-amber-700"
                  >
                    Продолжить валидацию
                  </button>
                </div>
              )}

              {emailValidation.error && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 font-medium">
                  {emailValidation.error}
                </div>
              )}

              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-2">
                  Столбец с email-адресами
                </label>
                <div className="relative">
                  <select
                    value={emailValidation.sourceCol}
                    onChange={(e) =>
                      setEmailValidation((prev) => ({ ...prev, sourceCol: Number(e.target.value), error: null }))
                    }
                    disabled={emailValidation.isValidating}
                    className="w-full appearance-none rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-900 outline-none transition-all hover:bg-gray-100 focus:border-gray-400 focus:bg-white disabled:opacity-60"
                  >
                    {headerLabels.map((label, index) => (
                      <option key={index} value={index}>{label || toColumnLabel(index)}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="rounded-lg border border-emerald-100 bg-emerald-50 px-4 py-3 text-xs text-emerald-800 leading-relaxed space-y-1.5">
                <p className="font-semibold">Проверки:</p>
                <p>Синтаксис, DNS/MX-записи домена, SMTP-верификация, catch-all детекция, одноразовые провайдеры, ролевые аккаунты, бесплатные провайдеры, коррекция опечаток, greylisting.</p>
                <p>Результат: 3 новых столбца — <span className="font-semibold">Результат</span>, <span className="font-semibold">Качество</span>, <span className="font-semibold">Детали</span>.</p>
                <p>
                  Строк для обработки: <span className="font-semibold text-gray-900">{
                    activeTab ? activeTab.data.slice(1).filter((row) => {
                      const v = row[emailValidation.sourceCol]?.trim();
                      return v && v.length > 0;
                    }).length : 0
                  }</span>
                </p>
              </div>

              {emailValidation.isValidating ? (
                <div className="rounded-lg border border-emerald-100 bg-emerald-50 px-4 py-3">
                  <p className="text-xs text-emerald-700 leading-relaxed">
                    Валидация выполняется в фоне. Можно закрыть окно и продолжать работу.
                  </p>
                </div>
              ) : (
                <div className="rounded-lg border border-amber-100 bg-amber-50 px-4 py-3">
                  <p className="text-xs text-amber-800 leading-relaxed">
                    SMTP-проверка может занять время (до 10 сек на email). Для больших списков процесс может выполняться несколько минут.
                  </p>
                </div>
              )}

              {emailValidation.isValidating && (
                <div className="rounded-xl border border-gray-100 bg-gray-50 px-4 py-4">
                  <div className="mb-3 flex items-center justify-between text-sm">
                    <span className="flex items-center gap-2 font-medium text-gray-900">
                      <span className="animate-spin text-emerald-600">⟳</span>
                      Валидация...
                    </span>
                    <span className="font-mono text-xs font-medium text-gray-500 bg-white px-2 py-1 rounded border border-gray-200">
                      {emailValidation.currentRow} / {emailValidation.totalRows}
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-gray-200">
                    <div
                      className="h-full bg-emerald-600 transition-all duration-300 ease-out"
                      style={{ width: `${emailValidation.progress}%` }}
                    />
                  </div>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between border-t border-gray-100 px-6 py-4 bg-gray-50/50">
              <div className="text-xs font-medium text-gray-500">
                {emailValidation.isValidating ? (
                  <>Обработано: {emailValidation.currentRow} / {emailValidation.totalRows}</>
                ) : (
                  <>Будет обработано: <span className="text-gray-900">{
                    activeTab ? activeTab.data.slice(1).filter((row) => {
                      const v = row[emailValidation.sourceCol]?.trim();
                      return v && v.length > 0;
                    }).length : 0
                  } строк</span></>
                )}
              </div>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={closeEmailValidationModal}
                  className="rounded-lg px-4 py-2.5 text-sm font-medium text-gray-600 transition hover:bg-gray-200 hover:text-gray-900"
                >
                  Закрыть
                </button>
                {emailValidation.isValidating ? (
                  <button
                    type="button"
                    onClick={() => void handleStopEmailValidation()}
                    className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-5 py-2.5 text-sm font-medium text-white shadow transition hover:bg-red-700"
                  >
                    Остановить
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void handleStartEmailValidation()}
                    className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white shadow-lg shadow-emerald-600/20 transition-all hover:bg-emerald-700 hover:shadow-xl hover:-translate-y-0.5 active:translate-y-0"
                  >
                    <span>✓</span>
                    Начать валидацию
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Brief Scoring Pre-Check ─────────────────────────── */}
      {briefScoring.showPreCheck && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 backdrop-blur-sm transition-all">
          <div className="w-full max-w-md rounded-2xl border border-gray-200 bg-white shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4 bg-gray-50/50">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-500 text-white shadow-sm text-lg">
                  💡
                </div>
                <div>
                  <h3 className="text-lg font-bold text-gray-900">Перед оценкой ЦА</h3>
                  <p className="text-xs text-gray-500 font-medium">Проверка готовности базы</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setBriefScoring((prev) => ({ ...prev, showPreCheck: false }))}
                className="rounded-lg p-2 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 text-xl leading-none"
              >
                &times;
              </button>
            </div>

            <div className="px-6 py-5 space-y-4">
              <div className="rounded-xl border border-amber-100 bg-amber-50/60 p-4 text-sm text-gray-700 space-y-2.5">
                <p className="font-semibold text-gray-900">Как работает оценка ЦА?</p>
                <p>
                  AI анализирует <span className="font-medium">данные о каждой компании</span> в таблице
                  и сравнивает их с вашим брифом/описанием ЦА. Чем больше информации о компании — тем точнее оценка.
                </p>
                <p>
                  Если в таблице только названия и сайты — AI не сможет качественно оценить релевантность.
                </p>
              </div>

              <div className="rounded-xl border border-blue-100 bg-blue-50/60 p-4 text-sm text-gray-700 space-y-2">
                <p className="font-semibold text-gray-900">Какие данные улучшают оценку?</p>
                <ul className="list-disc pl-5 space-y-1 text-gray-600">
                  <li>Описание компании (с сайта или из DaData)</li>
                  <li>Сфера деятельности / отрасль</li>
                  <li>Количество сотрудников</li>
                  <li>Город / регион</li>
                  <li>ИНН, оборот и другие данные</li>
                </ul>
                <p className="text-xs text-gray-500 mt-1">
                  Используйте кнопки <span className="font-medium">&laquo;Обогатить&raquo;</span> или{' '}
                  <span className="font-medium">&laquo;DaData&raquo;</span> для автоматического получения этих данных.
                </p>
              </div>

              {hasEnrichmentColumns ? (
                <div className="flex items-center gap-2 rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2 text-sm text-emerald-800">
                  <span>✅</span>
                  <span>В таблице обнаружены колонки с обогащающими данными</span>
                </div>
              ) : (
                <div className="flex items-center gap-2 rounded-lg bg-orange-50 border border-orange-200 px-3 py-2 text-sm text-orange-800">
                  <span>⚠️</span>
                  <span>Колонки с обогащёнными данными не найдены — результат может быть неточным</span>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between border-t border-gray-100 px-6 py-4 bg-gray-50/50">
              <button
                type="button"
                onClick={closePreCheckAndEnrich}
                className="inline-flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2.5 text-sm font-medium text-blue-700 transition hover:bg-blue-100"
              >
                Сначала обогатить
              </button>
              <button
                type="button"
                onClick={confirmPreCheckAndProceed}
                className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white shadow-lg shadow-emerald-600/20 transition-all hover:bg-emerald-700 hover:shadow-xl hover:-translate-y-0.5 active:translate-y-0"
              >
                Данные есть, продолжить
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Brief Scoring Modal ─────────────────────────────── */}
      {briefScoring.isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 backdrop-blur-sm transition-all">
          <div className="w-full max-w-lg rounded-2xl border border-gray-200 bg-white shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4 bg-gray-50/50">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-600 text-white shadow-sm font-bold text-lg">
                  🎯
                </div>
                <div>
                  <h3 className="text-lg font-bold text-gray-900">Оценка ЦА</h3>
                  <p className="text-xs text-gray-500 font-medium">Оценка релевантности компаний по брифу или описанию ЦА</p>
                </div>
              </div>
              <button
                type="button"
                onClick={closeBriefScoringModal}
                className="rounded-lg p-2 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 text-xl leading-none"
              >
                &times;
              </button>
            </div>

            <div className="px-6 py-5 space-y-4">
              {/* Mode switcher */}
              <div className="flex rounded-lg bg-gray-100 p-1">
                <button
                  type="button"
                  onClick={() => setBriefScoring((prev) => ({ ...prev, inputMode: 'pdf', error: null }))}
                  disabled={briefScoring.isScoring}
                  className={`flex-1 rounded-md px-3 py-2 text-sm font-medium transition-all ${
                    briefScoring.inputMode === 'pdf'
                      ? 'bg-white text-gray-900 shadow-sm'
                      : 'text-gray-500 hover:text-gray-700'
                  } disabled:opacity-50`}
                >
                  📄 PDF бриф
                </button>
                <button
                  type="button"
                  onClick={() => setBriefScoring((prev) => ({ ...prev, inputMode: 'text', error: null }))}
                  disabled={briefScoring.isScoring}
                  className={`flex-1 rounded-md px-3 py-2 text-sm font-medium transition-all ${
                    briefScoring.inputMode === 'text'
                      ? 'bg-white text-gray-900 shadow-sm'
                      : 'text-gray-500 hover:text-gray-700'
                  } disabled:opacity-50`}
                >
                  ✏️ Текстом
                </button>
              </div>

              {/* Input area */}
              <div>
                {briefScoring.inputMode === 'pdf' ? (
                  <>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      PDF бриф от клиента
                    </label>
                    {!briefScoring.briefText ? (
                      <button
                        type="button"
                        onClick={() => briefFileInputRef.current?.click()}
                        disabled={briefScoring.isUploading || briefScoring.isScoring}
                        className="w-full rounded-xl border-2 border-dashed border-gray-300 bg-gray-50 p-8 text-center transition hover:border-emerald-400 hover:bg-emerald-50/30 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {briefScoring.isUploading ? (
                          <div className="flex flex-col items-center gap-2">
                            <span className="animate-spin text-2xl">⟳</span>
                            <span className="text-sm text-gray-500">Загрузка {briefScoring.briefFileName}...</span>
                          </div>
                        ) : (
                          <div className="flex flex-col items-center gap-2">
                            <span className="text-3xl">📄</span>
                            <span className="text-sm font-medium text-gray-600">Нажмите для загрузки PDF</span>
                            <span className="text-xs text-gray-400">Макс. размер: 20 МБ</span>
                          </div>
                        )}
                      </button>
                    ) : (
                      <div className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-4">
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <span className="text-lg">✅</span>
                            <span className="text-sm font-medium text-emerald-800">{briefScoring.briefFileName}</span>
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              setBriefScoring((prev) => ({ ...prev, briefText: '', briefFileName: '', error: null }));
                            }}
                            disabled={briefScoring.isScoring}
                            className="text-xs text-gray-500 hover:text-gray-700 disabled:opacity-50"
                          >
                            Заменить
                          </button>
                        </div>
                        <p className="text-xs text-gray-500 line-clamp-3">{briefScoring.briefText.slice(0, 300)}...</p>
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Опишите вашу идеальную целевую аудиторию
                    </label>
                    <textarea
                      value={briefScoring.manualText}
                      onChange={(e) =>
                        setBriefScoring((prev) => ({ ...prev, manualText: e.target.value, error: null }))
                      }
                      disabled={briefScoring.isScoring}
                      placeholder="Например: IT-компании от 50 сотрудников, работающие в сфере финтеха, с офисами в Москве и Санкт-Петербурге. Ищем компании с потребностью в автоматизации процессов..."
                      className="w-full rounded-xl border border-gray-300 bg-white p-4 text-sm text-gray-800 placeholder:text-gray-400 transition focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed resize-none"
                      rows={5}
                    />
                    <p className="mt-1.5 text-xs text-gray-400">
                      Чем подробнее описание, тем точнее будет оценка
                    </p>
                  </>
                )}
              </div>

              {/* Info */}
              <div className="rounded-lg bg-gray-50 p-3 text-xs text-gray-600 space-y-1">
                <p>
                  AI оценит каждую компанию в базе по шкале 0-10 на основе{' '}
                  {briefScoring.inputMode === 'pdf' ? 'брифа' : 'описания ЦА'}.
                </p>
                <p>
                  Будут добавлены колонки: <span className="font-medium">ЦА Балл</span> и{' '}
                  <span className="font-medium">ЦА Причина</span>.
                </p>
                <p>
                  Строк для обработки: <span className="font-semibold text-gray-900">{visibleRowIndices.length}</span>
                </p>
              </div>

              {/* Progress */}
              {briefScoring.isScoring && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs text-gray-600">
                    <span>Обработка...</span>
                    <span>{briefScoring.currentRow} / {briefScoring.totalRows}</span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-gray-100">
                    <div
                      className="h-full rounded-full bg-emerald-500 transition-all duration-300"
                      style={{ width: `${briefScoring.progress}%` }}
                    />
                  </div>
                </div>
              )}

              {/* Error */}
              {briefScoring.error && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  {briefScoring.error}
                </div>
              )}
            </div>

            <div className="flex items-center justify-between border-t border-gray-100 px-6 py-4 bg-gray-50/50">
              <div className="text-xs text-gray-500">
                {briefScoring.isScoring
                  ? `Задача выполняется на сервере${briefScoring.jobId ? ` • ${briefScoring.jobId.slice(0, 8)}` : ''}`
                  : 'Режим: серверная очередь (можно свернуть окно)'}
              </div>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={closeBriefScoringModal}
                  className="rounded-lg px-4 py-2.5 text-sm font-medium text-gray-600 transition hover:bg-gray-200 hover:text-gray-900"
                >
                  {briefScoring.isScoring ? 'Свернуть' : 'Закрыть'}
                </button>
                {briefScoring.isScoring ? (
                  <button
                    type="button"
                    onClick={() => void handleStopBriefScoring()}
                    className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-5 py-2.5 text-sm font-medium text-white shadow transition hover:bg-red-700"
                  >
                    Остановить
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void handleStartBriefScoring()}
                    disabled={briefScoring.inputMode === 'pdf' ? !briefScoring.briefText : !briefScoring.manualText.trim()}
                    className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white shadow-lg shadow-emerald-600/20 transition-all hover:bg-emerald-700 hover:shadow-xl hover:-translate-y-0.5 active:translate-y-0 disabled:bg-gray-300 disabled:shadow-none disabled:translate-y-0 disabled:cursor-not-allowed"
                  >
                    <span>🎯</span>
                    Запустить оценку
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Site Availability Modal ─────────────────────────────── */}
      {siteAvailability.isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 backdrop-blur-sm transition-all">
          <div className="w-full max-w-lg rounded-2xl border border-gray-200 bg-white shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4 bg-gray-50/50">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-600 text-white shadow-sm font-bold text-lg">
                  🌐
                </div>
                <div>
                  <h3 className="text-lg font-bold text-gray-900">Проверка сайтов</h3>
                  <p className="text-xs text-gray-500 font-medium">Проверка доступности и отклика сайтов</p>
                </div>
              </div>
              <button
                type="button"
                onClick={closeSiteAvailabilityModal}
                className="rounded-lg p-2 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 text-xl leading-none"
              >
                &times;
              </button>
            </div>

            <div className="px-6 py-5 space-y-4">
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-2">
                  Столбец с сайтами
                </label>
                <select
                  value={siteAvailability.sourceCol}
                  onChange={(e) =>
                    setSiteAvailability((prev) => ({ ...prev, sourceCol: Number(e.target.value), error: null }))
                  }
                  disabled={siteAvailability.isChecking}
                  className="w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm font-medium text-gray-900 shadow-sm transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 focus:outline-none disabled:bg-gray-50 disabled:text-gray-400"
                >
                  {headerLabels.map((label, i) => (
                    <option key={i} value={i}>
                      {label || toColumnLabel(i)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="rounded-lg bg-indigo-50 border border-indigo-100 p-3 text-xs text-indigo-900 space-y-1">
                <p>
                  Система проверит доступность каждого сайта и добавит колонки:{' '}
                  <span className="font-semibold">Сайт Статус</span> и{' '}
                  <span className="font-semibold">Сайт Детали</span>.
                </p>
                <p>
                  Строк для обработки: <span className="font-semibold text-gray-900">{
                    activeTab ? activeTab.data.slice(1).filter((row) => {
                      const v = row[siteAvailability.sourceCol]?.trim();
                      return v && v.length > 0;
                    }).length : 0
                  }</span>
                </p>
              </div>

              {siteAvailability.isChecking && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs text-gray-600">
                    <span>Проверка...</span>
                    <span>{siteAvailability.currentRow} / {siteAvailability.totalRows}</span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-gray-100">
                    <div
                      className="h-full rounded-full bg-indigo-500 transition-all duration-300"
                      style={{ width: `${siteAvailability.progress}%` }}
                    />
                  </div>
                </div>
              )}

              {siteAvailability.error && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  {siteAvailability.error}
                </div>
              )}
            </div>

            <div className="flex items-center justify-between border-t border-gray-100 px-6 py-4 bg-gray-50/50">
              <div className="text-xs text-gray-500">
                Batch: {SITE_AVAILABILITY_BATCH_SIZE} строк
              </div>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={closeSiteAvailabilityModal}
                  className="rounded-lg px-4 py-2.5 text-sm font-medium text-gray-600 transition hover:bg-gray-200 hover:text-gray-900"
                >
                  {siteAvailability.isChecking ? 'Отменить' : 'Закрыть'}
                </button>
                <button
                  type="button"
                  onClick={() => void handleStartSiteAvailability()}
                  disabled={siteAvailability.isChecking}
                  className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white shadow-lg shadow-indigo-600/20 transition-all hover:bg-indigo-700 hover:shadow-xl hover:-translate-y-0.5 active:translate-y-0 disabled:bg-gray-300 disabled:shadow-none disabled:translate-y-0 disabled:cursor-not-allowed"
                >
                  {siteAvailability.isChecking ? (
                    <>
                      <span className="animate-spin">⟳</span>
                      Проверка...
                    </>
                  ) : (
                    <>
                      <span>🌐</span>
                      Проверить сайты
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Email Split Modal ─────────────────────────────── */}
      {emailSplit.isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 backdrop-blur-sm transition-all">
          <div className="w-full max-w-lg rounded-2xl border border-gray-200 bg-white shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4 bg-gray-50/50">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-600 text-white shadow-sm font-bold text-lg">
                  ✉
                </div>
                <div>
                  <h3 className="text-lg font-bold text-gray-900">Разделить почты</h3>
                  <p className="text-xs text-gray-500 font-medium">Дублирование строк при нескольких email</p>
                </div>
              </div>
              <button
                type="button"
                onClick={closeEmailSplitModal}
                className="rounded-lg p-2 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 text-xl leading-none"
              >
                &times;
              </button>
            </div>

            <div className="px-6 py-5 space-y-4">
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-2">
                  Столбец с почтами
                </label>
                <select
                  value={emailSplit.sourceCol}
                  onChange={(e) =>
                    setEmailSplit((prev) => ({ ...prev, sourceCol: Number(e.target.value) }))
                  }
                  className="w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm font-medium text-gray-900 shadow-sm transition focus:border-violet-400 focus:ring-2 focus:ring-violet-100 focus:outline-none"
                >
                  {headerLabels.map((label, i) => (
                    <option key={i} value={i}>
                      {label || toColumnLabel(i)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="rounded-lg bg-violet-50 border border-violet-100 p-3 text-xs text-violet-900 space-y-1">
                <p>
                  Если в ячейке несколько email (через запятую, точку с запятой или перенос строки),
                  строка будет продублирована для каждого email.
                </p>
                <p>
                  Строк с несколькими почтами:{' '}
                  <span className="font-semibold text-gray-900">
                    {activeTab
                      ? (() => {
                          const body = hasHeaderRow(activeTab.data)
                            ? activeTab.data.slice(1)
                            : activeTab.data;
                          return body.filter((row) => {
                            const cell = (row[emailSplit.sourceCol] ?? '').trim();
                            if (!cell) return false;
                            const parts = cell
                              .split(/[,;\n]+/)
                              .map((e) => e.trim())
                              .filter((e) => e.length > 0);
                            return parts.length > 1;
                          }).length;
                        })()
                      : 0}
                  </span>
                </p>
              </div>
            </div>

            <div className="flex items-center justify-end border-t border-gray-100 px-6 py-4 bg-gray-50/50 gap-3">
              <button
                type="button"
                onClick={closeEmailSplitModal}
                className="rounded-lg px-4 py-2.5 text-sm font-medium text-gray-600 transition hover:bg-gray-200 hover:text-gray-900"
              >
                Закрыть
              </button>
              <button
                type="button"
                onClick={handleSplitEmails}
                className="inline-flex items-center gap-2 rounded-lg bg-violet-600 px-5 py-2.5 text-sm font-medium text-white shadow-lg shadow-violet-600/20 transition-all hover:bg-violet-700 hover:shadow-xl hover:-translate-y-0.5 active:translate-y-0"
              >
                <span>✂</span>
                Разделить
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Phone Split Modal ─────────────────────────────── */}
      {phoneSplit.isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 backdrop-blur-sm transition-all">
          <div className="w-full max-w-lg rounded-2xl border border-gray-200 bg-white shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4 bg-gray-50/50">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-600 text-white shadow-sm font-bold text-lg">
                  ☎
                </div>
                <div>
                  <h3 className="text-lg font-bold text-gray-900">Разделить телефоны</h3>
                  <p className="text-xs text-gray-500 font-medium">Дублирование строк при нескольких номерах</p>
                </div>
              </div>
              <button
                type="button"
                onClick={closePhoneSplitModal}
                className="rounded-lg p-2 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 text-xl leading-none"
              >
                &times;
              </button>
            </div>

            <div className="px-6 py-5 space-y-4">
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-2">
                  Столбец с телефонами
                </label>
                <select
                  value={phoneSplit.sourceCol}
                  onChange={(e) =>
                    setPhoneSplit((prev) => ({ ...prev, sourceCol: Number(e.target.value) }))
                  }
                  className="w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm font-medium text-gray-900 shadow-sm transition focus:border-violet-400 focus:ring-2 focus:ring-violet-100 focus:outline-none"
                >
                  {headerLabels.map((label, i) => (
                    <option key={i} value={i}>
                      {label || toColumnLabel(i)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="rounded-lg bg-violet-50 border border-violet-100 p-3 text-xs text-violet-900 space-y-1">
                <p>
                  Если в ячейке несколько телефонов (через запятую, точку с запятой или пробел между номерами),
                  строка будет продублирована для каждого номера.
                </p>
                <p>
                  Строк с несколькими телефонами:{' '}
                  <span className="font-semibold text-gray-900">
                    {activeTab
                      ? (() => {
                          const body = hasHeaderRow(activeTab.data)
                            ? activeTab.data.slice(1)
                            : activeTab.data;
                          return body.filter((row) => {
                            const cell = (row[phoneSplit.sourceCol] ?? '').trim();
                            if (!cell) return false;
                            return splitPhoneCell(cell).length > 1;
                          }).length;
                        })()
                      : 0}
                  </span>
                </p>
              </div>
            </div>

            <div className="flex items-center justify-end border-t border-gray-100 px-6 py-4 bg-gray-50/50 gap-3">
              <button
                type="button"
                onClick={closePhoneSplitModal}
                className="rounded-lg px-4 py-2.5 text-sm font-medium text-gray-600 transition hover:bg-gray-200 hover:text-gray-900"
              >
                Закрыть
              </button>
              <button
                type="button"
                onClick={handleSplitPhones}
                className="inline-flex items-center gap-2 rounded-lg bg-violet-600 px-5 py-2.5 text-sm font-medium text-white shadow-lg shadow-violet-600/20 transition-all hover:bg-violet-700 hover:shadow-xl hover:-translate-y-0.5 active:translate-y-0"
              >
                <span>✂</span>
                Разделить
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Dedup Column Selector Modal ──────────────────────── */}
      {dedupModal.isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 backdrop-blur-sm transition-all">
          <div className="relative w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl">
            <button
              type="button"
              onClick={() => setDedupModal((prev) => ({ ...prev, isOpen: false }))}
              className="absolute right-4 top-4 text-gray-400 hover:text-gray-600 transition"
              aria-label="Закрыть"
            >✕</button>
            <h3 className="text-base font-bold text-gray-900 mb-4">
              {dedupModal.mode === 'email' ? 'Убрать дубликаты по Email' : 'Убрать дубликаты по компании'}
            </h3>
            <label className="block text-sm font-semibold text-gray-700 mb-2">
              {dedupModal.mode === 'email' ? 'Столбец с Email' : 'Столбец с названиями компаний'}
            </label>
            <select
              value={dedupModal.col}
              onChange={(e) => setDedupModal((prev) => ({ ...prev, col: Number(e.target.value) }))}
              className="w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm font-medium text-gray-900 shadow-sm transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100 focus:outline-none"
            >
              {headerLabels.map((label, i) => (
                <option key={i} value={i}>
                  {label || toColumnLabel(i)}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => {
                setDedupModal((prev) => ({ ...prev, isOpen: false }));
                if (dedupModal.mode === 'email') {
                  handleRemoveDuplicatesByEmail(dedupModal.col);
                } else {
                  handleRemoveDuplicatesByCompanyName(dedupModal.col);
                }
              }}
              className="mt-4 w-full rounded-xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-700 focus:ring-2 focus:ring-blue-300"
            >
              Найти и удалить дубликаты
            </button>
          </div>
        </div>
      )}

      {/* ── Name Cleanup Modal ─────────────────────────────── */}
      {nameCleanup.isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 backdrop-blur-sm transition-all">
          <div className="w-full max-w-lg rounded-2xl border border-gray-200 bg-white shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4 bg-gray-50/50">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-600 text-white shadow-sm font-bold text-lg">
                  ✨
                </div>
                <div>
                  <h3 className="text-lg font-bold text-gray-900">Очистка названий</h3>
                  <p className="text-xs text-gray-500 font-medium">Очистка и форматирование названий компаний</p>
                </div>
              </div>
                <button
                  type="button"
                  onClick={closeNameCleanupModal}
                  className="rounded-lg p-2 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 text-xl leading-none"
                >
                  &times;
                </button>
            </div>

            <div className="px-6 py-5 space-y-4">
              {/* Name column selector */}
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-2">
                  Столбец с названиями компаний
                </label>
                <select
                  value={nameCleanup.nameCol}
                  onChange={(e) => setNameCleanup((prev) => ({ ...prev, nameCol: Number(e.target.value), error: null }))}
                  disabled={nameCleanup.isProcessing}
                  className="w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm font-medium text-gray-900 shadow-sm transition focus:border-amber-400 focus:ring-2 focus:ring-amber-100 focus:outline-none disabled:bg-gray-50 disabled:text-gray-400"
                >
                  {headerLabels.map((label, i) => (
                    <option key={i} value={i}>
                      {label || toColumnLabel(i)}
                    </option>
                  ))}
                </select>
              </div>

              {/* Domain toggle */}
              <div className="rounded-xl border border-gray-200 bg-gray-50/50 p-4">
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={nameCleanup.useDomain}
                    onChange={(e) =>
                      setNameCleanup((prev) => ({
                        ...prev,
                        useDomain: e.target.checked,
                        domainCol: e.target.checked ? (prev.domainCol ?? 0) : null,
                        error: null,
                      }))
                    }
                    disabled={nameCleanup.isProcessing}
                    className="h-4 w-4 rounded border-gray-300 text-amber-600 focus:ring-amber-500"
                  />
                  <div>
                    <span className="text-sm font-medium text-gray-700">Использовать домены</span>
                    <p className="text-xs text-gray-500 mt-0.5">Домены помогут точнее определить правильное название</p>
                  </div>
                </label>
              </div>

              {/* Domain column selector */}
              {nameCleanup.useDomain && (
                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-2">
                    Столбец с доменами
                  </label>
                  <select
                    value={nameCleanup.domainCol ?? 0}
                    onChange={(e) => setNameCleanup((prev) => ({ ...prev, domainCol: Number(e.target.value), error: null }))}
                    disabled={nameCleanup.isProcessing}
                    className="w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm font-medium text-gray-900 shadow-sm transition focus:border-amber-400 focus:ring-2 focus:ring-amber-100 focus:outline-none disabled:bg-gray-50 disabled:text-gray-400"
                  >
                    {headerLabels.map((label, i) => (
                      <option key={i} value={i}>
                        {label || toColumnLabel(i)}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Info */}
              <div className="rounded-lg bg-amber-50 border border-amber-100 p-3 text-xs text-amber-800 space-y-1">
                <p>
                  AI очистит названия компаний: уберёт юр. формы (Inc, Ltd, LLC), лишние описания, 
                  символы и приведёт к красивому короткому виду для персонализации писем.
                </p>
                <p>
                  Результат <span className="font-semibold">заменит</span> текущие значения в выбранном столбце.
                </p>
                <p>
                  Строк для обработки: <span className="font-semibold text-gray-900">{
                    activeTab ? activeTab.data.slice(1).filter((row) => {
                      const v = row[nameCleanup.nameCol]?.trim();
                      return v && v.length > 0;
                    }).length : 0
                  }</span>
                </p>
              </div>

              {/* Progress */}
              {nameCleanup.isProcessing && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs text-gray-600">
                    <span className="flex items-center gap-2">
                      <span className="animate-pulse">●</span>
                      Очистка...
                    </span>
                    <span className="font-mono text-xs font-medium text-gray-500 bg-white px-2 py-1 rounded border border-gray-200">
                      {nameCleanup.currentRow} / {nameCleanup.totalRows}
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-gray-100">
                    <div
                      className="h-full rounded-full bg-amber-500 transition-all duration-300"
                      style={{ width: `${nameCleanup.progress}%` }}
                    />
                  </div>
                </div>
              )}

              {/* Error */}
              {nameCleanup.error && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  {nameCleanup.error}
                </div>
              )}
            </div>

            <div className="flex items-center justify-between border-t border-gray-100 px-6 py-4 bg-gray-50/50">
              <div className="text-xs text-gray-500">
                Batch: {NAME_CLEANUP_BATCH_SIZE} строк
              </div>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={closeNameCleanupModal}
                  className="rounded-lg px-4 py-2.5 text-sm font-medium text-gray-600 transition hover:bg-gray-200 hover:text-gray-900"
                >
                  {nameCleanup.isProcessing ? 'Отменить' : 'Закрыть'}
                </button>
                <button
                  type="button"
                  onClick={() => void handleStartNameCleanup()}
                  disabled={nameCleanup.isProcessing}
                  className="inline-flex items-center gap-2 rounded-lg bg-amber-600 px-5 py-2.5 text-sm font-medium text-white shadow-lg shadow-amber-600/20 transition-all hover:bg-amber-700 hover:shadow-xl hover:-translate-y-0.5 active:translate-y-0 disabled:bg-gray-300 disabled:shadow-none disabled:translate-y-0 disabled:cursor-not-allowed"
                >
                  {nameCleanup.isProcessing ? (
                    <>
                      <span className="animate-spin">⟳</span>
                      Очистка...
                    </>
                  ) : (
                    <>
                      <span>✨</span>
                      Запустить очистку
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Review submit modal */}
      {reviewSubmit.isOpen && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={() => setReviewSubmit((s) => ({ ...s, isOpen: false }))}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md mx-4 p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Отправить на проверку</h3>
            <p className="text-sm text-gray-500 mb-4">
              Вкладка <strong>{activeTab?.name}</strong> будет отправлена ревьюеру.
            </p>
            <label className="text-sm font-medium text-gray-700 mb-1 block">Проект (необязательно)</label>
            <select
              value={reviewSubmit.projectId}
              onChange={(e) => setReviewSubmit((s) => ({ ...s, projectId: e.target.value }))}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 bg-white mb-3 focus:outline-none focus:ring-2 focus:ring-emerald-500"
            >
              <option value="">— Без проекта —</option>
              {projectsList.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <label className="text-sm font-medium text-gray-700 mb-1 block">Комментарий (необязательно)</label>
            <textarea
              value={reviewSubmit.comment}
              onChange={(e) => setReviewSubmit((s) => ({ ...s, comment: e.target.value }))}
              placeholder="Описание базы, особенности…"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 resize-none focus:outline-none focus:ring-2 focus:ring-emerald-500 mb-4"
              rows={3}
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setReviewSubmit((s) => ({ ...s, isOpen: false }))}
                className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 transition-colors"
              >
                Отмена
              </button>
              <button
                type="button"
                disabled={reviewSubmit.submitting}
                onClick={() => void handleSubmitForReview()}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg disabled:opacity-50 transition-colors"
              >
                {reviewSubmit.submitting ? '⟳ Отправка…' : '✓ Отправить'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Instantly push modal */}
      {instantlyPush.isOpen && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={() => { if (!instantlyPush.pushing) setInstantlyPush((s) => ({ ...s, isOpen: false, result: '' })); }}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4 bg-gray-50/50">
              <div>
                <h3 className="text-lg font-bold text-gray-900">Push to Instantly</h3>
                <p className="text-xs text-gray-500">
                  {instantlyPush.mappingStep
                    ? 'Шаг 2: Маппинг колонок'
                    : 'Шаг 1: Выбор кампании'}
                  {' · '}<strong>{rowCount}</strong> строк
                </p>
              </div>
              <button type="button" onClick={() => { if (!instantlyPush.pushing) setInstantlyPush((s) => ({ ...s, isOpen: false, result: '' })); }} className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600 text-xl leading-none">&times;</button>
            </div>

            <div className="px-6 py-5 max-h-[65vh] overflow-y-auto space-y-4">
              {instantlyPush.result && (
                <div className={`rounded-lg p-3 text-sm ${instantlyPush.result.startsWith('Ошибка') ? 'bg-red-50 text-red-700 border border-red-200' : 'bg-emerald-50 text-emerald-700 border border-emerald-200'}`}>
                  {instantlyPush.result}
                </div>
              )}

              {!instantlyPush.mappingStep ? (
                <>
                  {instantlyPush.loadingLists ? (
                    <div className="flex items-center gap-2 py-6 justify-center text-sm text-gray-400">
                      <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                      Загрузка кампаний и списков…
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center gap-1 rounded-lg border border-gray-200 bg-gray-50 p-0.5">
                        <button type="button" onClick={() => { setInstantlyCreateMode(false); setInstantlyNewName(''); }}
                          className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${!instantlyCreateMode ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>
                          Выбрать существующую
                        </button>
                        <button type="button" onClick={() => { setInstantlyCreateMode(true); setInstantlyPush((s) => ({ ...s, campaignId: '', leadListId: '' })); setInstantlyCampaignSearch(''); }}
                          className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${instantlyCreateMode ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>
                          Создать новую
                        </button>
                      </div>

                      {instantlyCreateMode ? (
                        <div className="space-y-1.5">
                          <label className="text-sm font-semibold text-gray-700 block">Название кампании</label>
                          <input
                            type="text"
                            placeholder="Например: Outreach Q1 2026"
                            value={instantlyNewName}
                            onChange={(e) => setInstantlyNewName(e.target.value)}
                            className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-900 bg-gray-50 focus:outline-none focus:border-gray-400 focus:bg-white"
                          />
                          <p className="text-[11px] text-gray-400">Кампания будет создана с расписанием по умолчанию (Пн–Пт, 9:00–18:00). Настроить можно позже.</p>
                        </div>
                      ) : (
                        <>
                          <div className="space-y-1.5">
                            <label className="text-sm font-semibold text-gray-700 block">Кампания</label>
                            <div className="relative">
                              <input
                                type="text"
                                placeholder={instantlyPush.campaignId
                                  ? instantlyCampaigns.find((c) => c.id === instantlyPush.campaignId)?.name ?? 'Поиск кампании…'
                                  : 'Поиск кампании…'}
                                value={instantlyCampaignSearch}
                                onChange={(e) => {
                                  setInstantlyCampaignSearch(e.target.value);
                                  if (instantlyPush.campaignId) setInstantlyPush((s) => ({ ...s, campaignId: '' }));
                                }}
                                className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-900 bg-gray-50 focus:outline-none focus:border-gray-400 focus:bg-white"
                              />
                              {instantlyPush.campaignId && !instantlyCampaignSearch && (
                                <div className="absolute inset-y-0 left-3 flex items-center pointer-events-none">
                                  <span className="text-sm text-gray-900 truncate max-w-[calc(100%-3rem)]">
                                    {instantlyCampaigns.find((c) => c.id === instantlyPush.campaignId)?.name}
                                  </span>
                                </div>
                              )}
                              {instantlyPush.campaignId && (
                                <button type="button" onClick={() => { setInstantlyPush((s) => ({ ...s, campaignId: '' })); setInstantlyCampaignSearch(''); }} className="absolute inset-y-0 right-2 flex items-center text-gray-400 hover:text-gray-600">
                                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                                </button>
                              )}
                            </div>
                          </div>
                          {!instantlyPush.campaignId && (() => {
                            const q = instantlyCampaignSearch.toLowerCase().trim();
                            const filtered = q ? instantlyCampaigns.filter((c) => c.name.toLowerCase().includes(q)) : instantlyCampaigns;
                            return (
                              <div className="max-h-44 overflow-y-auto rounded-lg border border-gray-200 bg-white">
                                {filtered.length === 0 ? (
                                  <p className="px-3 py-3 text-sm text-gray-400 text-center">{q ? 'Ничего не найдено' : 'Нет кампаний'}</p>
                                ) : (
                                  filtered.map((c) => (
                                    <button key={c.id} type="button" onClick={() => { setInstantlyPush((s) => ({ ...s, campaignId: c.id, leadListId: '' })); setInstantlyCampaignSearch(''); }}
                                      className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-blue-50 hover:text-blue-700 transition-colors border-b border-gray-50 last:border-0 flex items-center justify-between gap-2">
                                      <span className="truncate">{c.name}</span>
                                      {c.ts && <span className="shrink-0 text-[10px] text-gray-400">{new Date(c.ts).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' })}</span>}
                                    </button>
                                  ))
                                )}
                              </div>
                            );
                          })()}
                          <div className="space-y-1.5">
                            <label className="text-sm font-semibold text-gray-700 block">Или lead-список</label>
                            <select
                              value={instantlyPush.leadListId}
                              onChange={(e) => setInstantlyPush((s) => ({ ...s, leadListId: e.target.value, campaignId: '' }))}
                              className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-900 bg-gray-50 focus:outline-none focus:border-gray-400 focus:bg-white"
                            >
                              <option value="">— Выберите lead-список —</option>
                              {instantlyLeadLists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                            </select>
                          </div>
                        </>
                      )}
                    </>
                  )}
                </>
              ) : (
                <>
                  <p className="text-xs text-gray-500">
                    Укажите, какому полю в Instantly соответствует каждая колонка. Автоматически определённые поля уже выбраны.
                    Колонки с типом <span className="font-medium">{'{{Переменная}}'}</span> будут доступны как динамические переменные в шаблонах писем.
                  </p>
                  <div className="rounded-xl border border-gray-200 overflow-hidden">
                    <div className="grid grid-cols-[1fr_1fr] gap-0 text-xs font-semibold text-gray-500 uppercase bg-gray-50 px-3 py-2 border-b border-gray-200">
                      <span>Колонка</span>
                      <span>Поле Instantly</span>
                    </div>
                    <div className="divide-y divide-gray-100 max-h-[40vh] overflow-y-auto">
                      {(activeTab?.data[0] ?? []).map((header, colIdx) => {
                        const label = String(header ?? '').trim();
                        if (!label) return null;
                        const mapping = instantlyPush.columnMapping[colIdx] ?? 'skip';
                        const isEmail = mapping === 'email';
                        const isDuplicate = mapping !== 'skip' && mapping !== 'custom_variable'
                          && instantlyPush.columnMapping.filter((m) => m === mapping).length > 1;
                        return (
                          <div key={colIdx} className={`grid grid-cols-[1fr_1fr] gap-2 items-center px-3 py-2 ${isEmail ? 'bg-blue-50/40' : ''} ${isDuplicate ? 'bg-amber-50/60' : ''}`}>
                            <div className="flex items-center gap-1.5 min-w-0">
                              <span className="text-[10px] text-gray-400 font-mono shrink-0">{toColumnLabel(colIdx)}</span>
                              <span className="text-sm text-gray-800 truncate" title={label}>{label}</span>
                            </div>
                            <select
                              value={mapping}
                              onChange={(e) => {
                                const newMapping = [...instantlyPush.columnMapping];
                                newMapping[colIdx] = e.target.value as InstantlyFieldValue;
                                setInstantlyPush((s) => ({ ...s, columnMapping: newMapping, result: '' }));
                              }}
                              className={`w-full border rounded-lg px-2 py-1.5 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-blue-400 ${
                                mapping === 'skip' ? 'border-gray-200 text-gray-400' : isEmail ? 'border-blue-300 text-blue-700 font-medium' : 'border-gray-200 text-gray-700'
                              }`}
                            >
                              {INSTANTLY_FIELD_OPTIONS.map((opt) => (
                                <option key={opt.value} value={opt.value}>{opt.label}</option>
                              ))}
                            </select>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                  {!instantlyPush.columnMapping.includes('email') && (
                    <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                      Не выбрана колонка с Email — это обязательное поле для загрузки лидов.
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="flex items-center justify-between border-t border-gray-100 px-6 py-4 bg-gray-50/50">
              <button type="button" onClick={() => {
                if (instantlyPush.mappingStep) {
                  setInstantlyPush((s) => ({ ...s, mappingStep: false, result: '' }));
                } else {
                  setInstantlyPush((s) => ({ ...s, isOpen: false, result: '' }));
                }
              }} className="text-sm text-gray-500 hover:text-gray-700 transition-colors">
                {instantlyPush.mappingStep ? '← Назад' : 'Отмена'}
              </button>

              {!instantlyPush.mappingStep ? (
                <button
                  type="button"
                  disabled={
                    instantlyPush.loadingLists
                    || instantlyPush.pushing
                    || (instantlyCreateMode ? !instantlyNewName.trim() : (!instantlyPush.campaignId && !instantlyPush.leadListId))
                  }
                  onClick={async () => {
                    if (instantlyCreateMode && instantlyNewName.trim()) {
                      setInstantlyPush((s) => ({ ...s, pushing: true, result: '' }));
                      try {
                        const token = (await (await import('@/lib/supabaseClient')).supabase.auth.getSession()).data.session?.access_token ?? '';
                        const res = await fetch('/api/instantly/campaigns', {
                          method: 'POST',
                          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            name: instantlyNewName.trim(),
                            campaign_schedule: {
                              schedules: [{
                                name: 'Default',
                                timing: { from: '09:00', to: '18:00' },
                                days: { 1: true, 2: true, 3: true, 4: true, 5: true },
                                timezone: 'Europe/Kirov',
                              }],
                            },
                          }),
                        });
                        if (!res.ok) {
                          const e = await res.json().catch(() => ({}));
                          throw new Error((e as { error?: string }).error || `HTTP ${res.status}`);
                        }
                        const campaign = await res.json() as { id: string };
                        setInstantlyPush((s) => ({ ...s, campaignId: campaign.id, pushing: false, mappingStep: true, result: '' }));
                        setInstantlyCreateMode(false);
                      } catch (err) {
                        setInstantlyPush((s) => ({ ...s, pushing: false, result: `Ошибка создания кампании: ${err instanceof Error ? err.message : 'Неизвестная ошибка'}` }));
                      }
                    } else {
                      setInstantlyPush((s) => ({ ...s, mappingStep: true, result: '' }));
                    }
                  }}
                  className="inline-flex items-center gap-1.5 px-5 py-2.5 text-sm font-medium bg-gray-900 text-white rounded-lg hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  {instantlyPush.pushing ? '⟳ Создаём кампанию…' : 'Далее: маппинг колонок →'}
                </button>
              ) : (
                <button
                  type="button"
                  disabled={instantlyPush.pushing || !instantlyPush.columnMapping.includes('email')}
                  onClick={async () => {
                    if (!activeTab) return;
                    setInstantlyPush((s) => ({ ...s, pushing: true, result: '' }));
                    try {
                      const headers = activeTab.data[0] ?? [];
                      const mapping = instantlyPush.columnMapping;
                      const emailColIdx = mapping.indexOf('email');
                      if (emailColIdx < 0) { setInstantlyPush((s) => ({ ...s, pushing: false, result: 'Ошибка: не назначена колонка Email' })); return; }

                      const standardFields = ['first_name', 'last_name', 'company_name', 'phone', 'website', 'linkedin_url', 'personalization'] as const;
                      const fieldColMap: Partial<Record<string, number>> = {};
                      for (const f of standardFields) {
                        const idx = mapping.indexOf(f);
                        if (idx >= 0) fieldColMap[f] = idx;
                      }

                      const customVarCols: Array<{ colIdx: number; name: string }> = [];
                      mapping.forEach((m, i) => {
                        if (m === 'custom_variable') {
                          customVarCols.push({ colIdx: i, name: String(headers[i] ?? '').trim() || `col_${i}` });
                        }
                      });

                      const leads = activeTab.data.slice(1).filter((row) => {
                        const email = String(row[emailColIdx] ?? '').trim();
                        return email && email.includes('@');
                      }).map((row) => {
                        const lead: Record<string, unknown> = { email: String(row[emailColIdx]).trim() };
                        for (const [field, colIdx] of Object.entries(fieldColMap)) {
                          const v = String(row[colIdx!] ?? '').trim();
                          if (v) lead[field] = v;
                        }
                        const cv: Record<string, string> = {};
                        for (const { colIdx, name } of customVarCols) {
                          const v = String(row[colIdx] ?? '').trim();
                          if (v) cv[name] = v;
                        }
                        if (Object.keys(cv).length > 0) lead.custom_variables = cv;
                        return lead;
                      });

                      if (leads.length === 0) { setInstantlyPush((s) => ({ ...s, pushing: false, result: 'Ошибка: нет валидных email в данных' })); return; }
                      const token = (await (await import('@/lib/supabaseClient')).supabase.auth.getSession()).data.session?.access_token ?? '';
                      const BATCH = 500;
                      let pushed = 0;
                      for (let i = 0; i < leads.length; i += BATCH) {
                        const batch = leads.slice(i, i + BATCH);
                        const payload: Record<string, unknown> = { leads: batch, skip_if_in_workspace: true };
                        if (instantlyPush.campaignId) payload.campaign_id = instantlyPush.campaignId;
                        if (instantlyPush.leadListId) payload.list_id = instantlyPush.leadListId;
                        const res = await fetch('/api/instantly/leads', {
                          method: 'POST',
                          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                          body: JSON.stringify(payload),
                        });
                        if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error((e as { error?: string }).error || `HTTP ${res.status}`); }
                        pushed += batch.length;
                      }
                      setInstantlyPush((s) => ({ ...s, pushing: false, result: `Загружено ${pushed} лидов в Instantly` }));
                    } catch (err) {
                      setInstantlyPush((s) => ({ ...s, pushing: false, result: `Ошибка: ${err instanceof Error ? err.message : 'Неизвестная ошибка'}` }));
                    }
                  }}
                  className="inline-flex items-center gap-1.5 px-5 py-2.5 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  {instantlyPush.pushing ? '⟳ Загрузка…' : `Push ${rowCount} лидов`}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* "Согласовать с клиентом" button — shown for approved requests matching current tab */}
      {(() => {
        const approvedReq = activeTab && myReviewRequests.find(
          (r) => r.tab_id === activeTab.id && r.status === 'review_approved',
        );
        if (!approvedReq) return null;
        return (
          <div className="fixed bottom-4 right-4 z-[9998]">
            <button
              type="button"
              onClick={() => void openPublishModal(approvedReq.id)}
              className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-xl shadow-lg transition-all hover:shadow-xl"
            >
              📨 Согласовать с клиентом
            </button>
          </div>
        );
      })()}

      {/* Telegram publish modal */}
      {reviewPublish.isOpen && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={() => setReviewPublish((s) => ({ ...s, isOpen: false }))}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md mx-4 p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Согласовать с клиентом</h3>
            <label className="text-sm font-medium text-gray-700 mb-1 block">Чат Telegram</label>
            <select
              value={reviewPublish.chatId ?? ''}
              onChange={(e) => setReviewPublish((s) => ({ ...s, chatId: Number(e.target.value) || null }))}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 bg-white mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">Выберите чат…</option>
              {tgChats.map((c) => (
                <option key={c.id} value={c.id}>{c.title}</option>
              ))}
            </select>
            <label className="text-sm font-medium text-gray-700 mb-1 block">Сообщение (необязательно)</label>
            <textarea
              value={reviewPublish.message}
              onChange={(e) => setReviewPublish((s) => ({ ...s, message: e.target.value }))}
              placeholder="Дополнительное сообщение для клиента…"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 mb-4"
              rows={3}
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setReviewPublish((s) => ({ ...s, isOpen: false }))}
                className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 transition-colors"
              >
                Отмена
              </button>
              <button
                type="button"
                disabled={reviewPublish.publishing || !reviewPublish.chatId}
                onClick={() => void handlePublishToTelegram()}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg disabled:opacity-50 transition-colors"
              >
                {reviewPublish.publishing ? '⟳ Отправка…' : '📨 Отправить'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Review marks popup */}
      {reviewMarksPopup && (
        <div
          id="review-marks-popup"
          className="fixed z-[9999] bg-white border border-gray-200 rounded-xl shadow-2xl p-3 max-w-xs"
          style={{ top: reviewMarksPopup.top, left: reviewMarksPopup.left }}
        >
          <div className="text-[10px] font-medium text-gray-400 mb-2">Строка {reviewMarksPopup.rowIndex + 1}</div>
          {reviewMarksPopup.marks.map((m, i) => (
            <div key={i} className="mb-2 last:mb-0">
              <span className="text-[9px] font-medium text-gray-400 uppercase">
                {m.author_type === 'client' ? 'Клиент' : 'Ревьюер'}
              </span>
              <p className="text-xs text-gray-800 mt-0.5">{m.comment}</p>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setReviewMarksPopup(null)}
            className="absolute top-1 right-2 text-gray-400 hover:text-gray-600 text-xs"
          >
            ✕
          </button>
        </div>
      )}

      {/* DaData enrichment modal */}
      {dadataEnrichment.isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 backdrop-blur-sm transition-all">
          <div className="w-full max-w-lg rounded-2xl border border-gray-200 bg-white shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4 bg-gray-50/50">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-600 text-white shadow-sm font-bold text-lg">
                  D
                </div>
                <div>
                  <h3 className="text-lg font-bold text-gray-900">DaData — обогащение</h3>
                  <p className="text-xs text-gray-500 font-medium">Поиск компаний по ИНН</p>
                </div>
              </div>
              <button
                type="button"
                onClick={closeDadataModal}
                className="rounded-lg p-2 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 text-xl leading-none"
              >
                &times;
              </button>
            </div>

            <div className="space-y-5 px-6 py-5 max-h-[70vh] overflow-y-auto">
              {dadataEnrichment.error && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 font-medium">
                  {dadataEnrichment.error}
                </div>
              )}

              <div className="space-y-2">
                <label className="block text-sm font-semibold text-gray-700">
                  Столбец с ИНН
                </label>
                <div className="relative">
                  <select
                    value={dadataEnrichment.sourceCol}
                    onChange={(e) =>
                      setDadataEnrichment((prev) => ({
                        ...prev,
                        sourceCol: Number(e.target.value),
                        error: null,
                      }))
                    }
                    disabled={dadataEnrichment.isProcessing}
                    className="w-full appearance-none rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-900 outline-none transition-all hover:bg-gray-100 focus:border-gray-400 focus:bg-white disabled:opacity-60"
                  >
                    {headerLabels.map((label, index) => (
                      <option key={`dadata-col-${index}`} value={index}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <div className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 text-xs">
                    ▼
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="block text-sm font-semibold text-gray-700">Поля для обогащения</label>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setDadataEnrichment((prev) => ({ ...prev, selectedFields: DADATA_FIELDS.map((f) => f.key) }))}
                      disabled={dadataEnrichment.isProcessing}
                      className="text-[10px] font-medium text-emerald-600 hover:text-emerald-800 disabled:opacity-60"
                    >
                      Все
                    </button>
                    <button
                      type="button"
                      onClick={() => setDadataEnrichment((prev) => ({ ...prev, selectedFields: [] }))}
                      disabled={dadataEnrichment.isProcessing}
                      className="text-[10px] font-medium text-gray-500 hover:text-gray-700 disabled:opacity-60"
                    >
                      Сбросить
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-1.5 rounded-xl border border-gray-200 bg-gray-50 p-3">
                  {DADATA_FIELDS.map((field) => (
                    <label
                      key={field.key}
                      className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-gray-700 hover:bg-white transition cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={dadataEnrichment.selectedFields.includes(field.key)}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          setDadataEnrichment((prev) => ({
                            ...prev,
                            selectedFields: checked
                              ? [...prev.selectedFields, field.key]
                              : prev.selectedFields.filter((k) => k !== field.key),
                          }));
                        }}
                        disabled={dadataEnrichment.isProcessing}
                        className="rounded border-gray-300 text-emerald-600 focus:ring-emerald-500 disabled:opacity-60"
                      />
                      {field.label}
                    </label>
                  ))}
                </div>
              </div>

              {!dadataEnrichment.isProcessing && (
                <div className="rounded-lg border border-blue-100 bg-blue-50 px-4 py-3">
                  <p className="text-xs text-blue-700 leading-relaxed">
                    Лимит: 10 000 запросов в день. Если запросы закончились — попробуйте завтра, лимит обновляется в полночь.
                  </p>
                </div>
              )}

              {dadataEnrichment.isProcessing && (
                <div className="rounded-xl border border-gray-100 bg-gray-50 px-4 py-4">
                  <div className="mb-3 flex items-center justify-between text-sm">
                    <span className="flex items-center gap-2 font-medium text-gray-900">
                      <span className="animate-pulse">●</span>
                      Обогащение...
                    </span>
                    <span className="font-mono text-xs font-medium text-gray-500 bg-white px-2 py-1 rounded border border-gray-200">
                      {dadataEnrichment.currentRow} / {dadataEnrichment.totalRows}
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-gray-200">
                    <div
                      className="h-full bg-emerald-600 transition-all duration-300 ease-out"
                      style={{ width: `${dadataEnrichment.progress}%` }}
                    />
                  </div>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between border-t border-gray-100 px-6 py-4 bg-gray-50/50">
              <div className="text-xs font-medium text-gray-500">
                {dadataEnrichment.isProcessing ? (
                  <>Обработано: {dadataEnrichment.currentRow} / {dadataEnrichment.totalRows}</>
                ) : (
                  <>Полей: <span className="text-gray-900">{dadataEnrichment.selectedFields.length}</span> · Строк: <span className="text-gray-900">{visibleRowIndices.length}</span></>
                )}
              </div>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={closeDadataModal}
                  className="rounded-lg px-4 py-2.5 text-sm font-medium text-gray-600 transition hover:bg-gray-200 hover:text-gray-900"
                >
                  {dadataEnrichment.isProcessing ? 'Стоп' : 'Закрыть'}
                </button>
                {!dadataEnrichment.isProcessing && (
                  <button
                    type="button"
                    onClick={() => void handleStartDadataEnrichment()}
                    disabled={dadataEnrichment.selectedFields.length === 0}
                    className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white shadow transition hover:bg-emerald-700 disabled:opacity-50"
                  >
                    Запустить
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* FNS Revenue modal */}
      {fnsEnrichment.isOpen && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl border border-gray-200 overflow-hidden">
            <div className="border-b border-gray-100 px-6 py-4">
              <h3 className="text-base font-semibold text-gray-900">Доходы и расходы (ФНС)</h3>
              <p className="text-xs text-gray-500 mt-0.5">Данные из открытой бухгалтерской отчётности ФНС за 2024 год</p>
            </div>

            <div className="px-6 py-5 space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1.5">Колонка с ИНН</label>
                <select
                  value={fnsEnrichment.sourceCol}
                  onChange={(e) => setFnsEnrichment((prev) => ({ ...prev, sourceCol: Number(e.target.value) }))}
                  disabled={fnsEnrichment.isProcessing}
                  className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm focus:border-blue-400 focus:ring-2 focus:ring-blue-100 disabled:opacity-60"
                >
                  {(activeTab?.data[0] ?? []).map((h, i) => (
                    <option key={i} value={i}>{String(h || `Колонка ${i + 1}`)}</option>
                  ))}
                </select>
              </div>

              <div className="rounded-lg border border-emerald-100 bg-emerald-50 px-4 py-3">
                <p className="text-xs text-emerald-700 leading-relaxed">
                  Будут добавлены колонки «Доход (ФНС)» и «Расход (ФНС)». Данные из ~2 млн организаций. Без лимитов, мгновенно.
                </p>
              </div>

              {fnsEnrichment.isProcessing && (
                <div className="rounded-xl border border-gray-100 bg-gray-50 px-4 py-4">
                  <div className="mb-3 flex items-center justify-between text-sm">
                    <span className="flex items-center gap-2 font-medium text-gray-900">
                      <span className="animate-pulse">●</span>
                      Обогащение...
                    </span>
                    <span className="font-mono text-xs font-medium text-gray-500 bg-white px-2 py-1 rounded border border-gray-200">
                      {fnsEnrichment.currentRow} / {fnsEnrichment.totalRows} (найдено: {fnsEnrichment.found})
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-gray-200">
                    <div
                      className="h-full bg-blue-600 transition-all duration-300 ease-out"
                      style={{ width: `${fnsEnrichment.progress}%` }}
                    />
                  </div>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between border-t border-gray-100 px-6 py-4 bg-gray-50/50">
              <div className="text-xs font-medium text-gray-500">
                {fnsEnrichment.isProcessing ? (
                  <>Обработано: {fnsEnrichment.currentRow} / {fnsEnrichment.totalRows}</>
                ) : (
                  <>Строк с ИНН: <span className="text-gray-900">{visibleRowIndices.filter((ri) => /^\d{10,12}$/.test(String(activeTab?.data[ri]?.[fnsEnrichment.sourceCol] ?? '').trim())).length}</span></>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={closeFnsModal}
                  className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50 transition"
                >
                  {fnsEnrichment.isProcessing ? 'Стоп' : 'Закрыть'}
                </button>
                {!fnsEnrichment.isProcessing && (
                  <button
                    type="button"
                    onClick={() => void handleStartFnsEnrichment()}
                    className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white shadow hover:bg-blue-700 transition"
                  >
                    Запустить
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* INN lookup modal */}
      {innLookup.isOpen && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl border border-gray-200 overflow-hidden">
            <div className="border-b border-gray-100 px-6 py-4">
              <h3 className="text-base font-semibold text-gray-900">Найти ИНН по сайту</h3>
              <p className="text-xs text-gray-500 mt-0.5">Парсинг ИНН с сайтов компаний (реквизиты, оферта, контакты)</p>
            </div>

            <div className="px-6 py-5 space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1.5">Колонка с сайтами (URL)</label>
                <select
                  value={innLookup.urlCol}
                  onChange={(e) => setInnLookup((prev) => ({ ...prev, urlCol: Number(e.target.value) }))}
                  disabled={innLookup.isProcessing}
                  className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm focus:border-blue-400 focus:ring-2 focus:ring-blue-100 disabled:opacity-60"
                >
                  <option value={-1}>— Выберите колонку —</option>
                  {(activeTab?.data[0] ?? []).map((h, i) => (
                    <option key={i} value={i}>{String(h || `Колонка ${i + 1}`)}</option>
                  ))}
                </select>
              </div>

              <div className="rounded-lg border border-blue-100 bg-blue-50 px-4 py-3">
                <p className="text-xs text-blue-700 leading-relaxed">
                  Ищет ИНН на страницах сайта: главная, /contacts, /requisites, /oferta, /policy и др. Найденный ИНН проверяется через DaData. Результаты: «ИНН (найден)», «Компания (найдена)».
                </p>
              </div>

              {innLookup.isProcessing && (
                <div className="rounded-xl border border-gray-100 bg-gray-50 px-4 py-4">
                  <div className="mb-3 flex items-center justify-between text-sm">
                    <span className="flex items-center gap-2 font-medium text-gray-900">
                      <span className="animate-pulse">●</span>
                      Парсинг сайтов...
                    </span>
                    <span className="font-mono text-xs font-medium text-gray-500 bg-white px-2 py-1 rounded border border-gray-200">
                      {innLookup.currentRow} / {innLookup.totalRows}
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-gray-200">
                    <div
                      className="h-full bg-blue-600 transition-all duration-300 ease-out"
                      style={{ width: `${innLookup.progress}%` }}
                    />
                  </div>
                  <div className="mt-2 text-[11px] text-gray-500">
                    Найдено ИНН: <span className="font-medium text-gray-700">{innLookup.found}</span>
                  </div>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between border-t border-gray-100 px-6 py-4 bg-gray-50/50">
              <div className="text-xs font-medium text-gray-500">
                {innLookup.isProcessing ? (
                  <>Обработано: {innLookup.currentRow} / {innLookup.totalRows}</>
                ) : (
                  <>Строк с URL: <span className="text-gray-900">{visibleRowIndices.filter((ri) => {
                    const url = innLookup.urlCol >= 0 ? String(activeTab?.data[ri]?.[innLookup.urlCol] ?? '').trim() : '';
                    return url && (/\./.test(url) || /^https?:\/\//i.test(url));
                  }).length}</span></>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={closeInnLookupModal}
                  className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50 transition"
                >
                  {innLookup.isProcessing ? 'Стоп' : 'Закрыть'}
                </button>
                {!innLookup.isProcessing && (
                  <button
                    type="button"
                    onClick={() => void handleStartInnLookup()}
                    disabled={innLookup.urlCol < 0}
                    className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white shadow hover:bg-blue-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Запустить
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Review toast */}
      {reviewSubmitToast && (
        <div className="fixed top-4 right-4 z-[9999] bg-emerald-50 border border-emerald-200 text-sm px-4 py-2 rounded-lg text-emerald-700 shadow-lg">
          {reviewSubmitToast}
        </div>
      )}
    </div>
  );
}
