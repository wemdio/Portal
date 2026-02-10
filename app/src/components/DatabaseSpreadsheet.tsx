'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ClipboardEvent, DragEvent, KeyboardEvent, MouseEvent } from 'react';
import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { supabase } from '@/lib/supabaseClient';
import { logError } from '@/lib/loggerClient';

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

type PersistedSpreadsheetState = {
  version: number;
  tabs: Sheet[];
  activeTabId: string;
  tabCounter: number;
  columnWidths?: number[];
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

type PersonalizationState = {
  isOpen: boolean;
  sourceCol: number;
  prompt: string;
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

const PERSONALIZATION_BATCH_SIZE = 2;
const PERSONALIZATION_MAX_RETRIES = 3;
const PERSONALIZATION_RETRY_BASE_DELAY = 1200;
const PERSONALIZATION_HIGHLIGHT_DURATION = 2500;
const ENRICHMENT_PROGRESS_INTERVAL_MS = 200;
const ENRICHMENT_UPDATE_FLUSH_MS = 250;
const ENRICHMENT_UPDATE_BATCH = 20;
const ENRICHMENT_HIGHLIGHT_DURATION = 2500;
const BRIEF_SCORING_BATCH_SIZE = 10;
const BRIEF_SCORING_MAX_RETRIES = 2;
const BRIEF_SCORING_RETRY_BASE_DELAY = 1200;
const BRIEF_SCORING_HIGHLIGHT_DURATION = 2500;
const BRIEF_STORAGE_BUCKET = process.env.NEXT_PUBLIC_BRIEF_STORAGE_BUCKET ?? 'briefs';
const BRIEF_STORAGE_PREFIX = 'brief-scoring';
const MAX_BRIEF_FILE_BYTES = 20 * 1024 * 1024;
const NAME_CLEANUP_BATCH_SIZE = 100;
const NAME_CLEANUP_CONCURRENCY = 2;
const NAME_CLEANUP_HIGHLIGHT_DURATION = 2500;
const VIRTUALIZATION_THRESHOLD = 1500;
const VIRTUAL_ROW_HEIGHT = 32;
const VIRTUAL_OVERSCAN = 10;
const WRAP_STORAGE_KEY = 'portal:db-wrap-cells';

const EMAIL_HEADER_REGEX = /(e-?mail|email|почта|mail)/i;
const EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const MAX_FILTER_OPTIONS = 1000;
const BLANK_FILTER_LABEL = '(пусто)';
const EMOJI_REGEX = /[\u{1F300}-\u{1FAFF}]/gu;
const DEFAULT_COLUMN_WIDTH = 160;
const MIN_COLUMN_WIDTH = 80;
const COMPANY_HEADER_REGEX = /(компан|company|организац)/i;
const HEADER_LABEL_HINT_REGEX =
  /(названи|компан|company|сайт|website|url|домен|email|почта|контакт|телефон|phone|industry|сфера|описан|about|адрес|address)/i;

const DEFAULT_ROWS = 20;
const DEFAULT_COLS = 10;
const STORAGE_KEY_PREFIX = 'portal:database-spreadsheet';
const STORAGE_VERSION = 1;
const STORAGE_SAVE_DELAY = 700;
const ENRICHMENT_STORAGE_KEY_PREFIX = 'portal:website-enrichment';
const ENRICHMENT_STORAGE_VERSION = 1;

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

const normalizeRows = (rows: string[][]) => {
  const maxCols = Math.max(1, ...rows.map((row) => row.length));
  return rows.map((row) => {
    if (row.length >= maxCols) return row;
    return [...row, ...Array.from({ length: maxCols - row.length }, () => '')];
  });
};

const buildStorageKey = (userId: string | null) =>
  `${STORAGE_KEY_PREFIX}:${userId ?? 'anonymous'}`;

const buildEnrichmentStorageKey = (userId: string | null) =>
  `${ENRICHMENT_STORAGE_KEY_PREFIX}:${userId ?? 'anonymous'}`;

const coerceRows = (rows: unknown) => {
  if (!Array.isArray(rows)) return [];
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
      const normalized =
        rows.length > 0
          ? normalizeRows(rows)
          : [Array.from({ length: DEFAULT_COLS }, () => '')];
      return { id: safeId, name: safeName, data: normalized };
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
  return { version: STORAGE_VERSION, tabs, activeTabId, tabCounter, columnWidths };
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

  const colCount = Math.max(...data.map((row) => row.length));
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
  const maxCount = Math.max(0, ...emailCounts);
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
  const [tabs, setTabs] = useState<Sheet[]>(() => [createSheet('Вкладка 1')]);
  const [activeTabId, setActiveTabId] = useState<string>(() => tabs[0].id);
  const [tabCounter, setTabCounter] = useState(1);
  const [storageKey, setStorageKey] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const enrichmentStorageKey = useMemo(() => buildEnrichmentStorageKey(userId), [userId]);
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
  const [rightPanelTab, setRightPanelTab] = useState<'summary' | 'cleanup'>('summary');
  const debouncedSearchQuery = useDebouncedValue(searchQuery, 300);
  const debouncedGroupSearch = useDebouncedValue(groupSearch, 300);
  const debouncedFilterMenuSearch = useDebouncedValue(filterMenu?.search ?? '', 300);
  const [lastAction, setLastAction] = useState<ActionSummary | null>(null);
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
  const scrollRafRef = useRef<number | null>(null);
  const [scrollMetrics, setScrollMetrics] = useState({ scrollTop: 0, height: 0 });
  const confirmActionRef = useRef<(() => void) | null>(null);
  const [columnWidths, setColumnWidths] = useState<number[]>([]);
  const [highlightedCol, setHighlightedCol] = useState<number | null>(null);
  const highlightTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resizingRef = useRef<{ col: number; startX: number; startWidth: number } | null>(
    null,
  );
  const [isResizing, setIsResizing] = useState(false);
  const importTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastProgressRef = useRef(0);
  const [importStatus, setImportStatus] = useState<ImportStatus>({
    status: 'idle',
    progress: 0,
  });
  const [isHydrated, setIsHydrated] = useState(false);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [personalization, setPersonalization] = useState<PersonalizationState>({
    isOpen: false,
    sourceCol: 0,
    prompt: '',
    isGenerating: false,
    progress: 0,
    totalRows: 0,
    currentRow: 0,
    error: null,
  });
  const personalizationAbortRef = useRef<AbortController | null>(null);
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
  const [briefScoring, setBriefScoring] = useState<BriefScoringState>({
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
    const observer = new ResizeObserver(() => updateScrollMetrics());
    observer.observe(wrapper);
    return () => {
      observer.disconnect();
      if (scrollRafRef.current !== null) {
        cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
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
      // Поддержка Ctrl+Z / Cmd+Z
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        handleUndo();
        return;
      }

      // Игнорируем если фокус в инпуте/текстареа (кроме нашей таблицы)
      if (
        document.activeElement instanceof HTMLInputElement ||
        document.activeElement instanceof HTMLTextAreaElement
      ) {
        // Разрешаем навигацию если это инпут внутри ячейки
        if (!document.activeElement.closest('td')) return;
      }

      if (!activeTab) return;

      const { row, col } = activeCell;
      const maxRow = activeTab.data.length - 1;
      const maxCol = (activeTab.data[0]?.length ?? 1) - 1;

      let nextRow = row;
      let nextCol = col;
      let handled = false;

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
    const handleClose = () => {
      setContextMenu(null);
      setFilterMenu(null);
    };
    window.addEventListener('click', handleClose);
    window.addEventListener('scroll', handleClose, true);
    window.addEventListener('resize', handleClose);
    return () => {
      window.removeEventListener('click', handleClose);
      window.removeEventListener('scroll', handleClose, true);
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
    const text = activeTab.data.map((row) => row.join('\t')).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setLastAction({ message: 'Таблица скопирована в буфер обмена', time: Date.now() });
    } catch (error) {
      void logError('spreadsheet.copy_all.failed', error);
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

  const handleRowHeaderClick = (rowIndex: number, isRange: boolean) => {
    const lastCol = Math.max((activeTab?.data[0]?.length ?? 0) - 1, 0);
    const anchorRow = isRange ? selectionAnchor.row : rowIndex;
    setSelection({
      startRow: anchorRow,
      endRow: rowIndex,
      startCol: 0,
      endCol: lastCol,
    });
    setActiveCell({ row: rowIndex, col: 0 });
    setSelectionMode('row');
    if (!isRange) {
      setSelectionAnchor({ row: rowIndex, col: 0 });
    }
  };

  const handleColumnHeaderClick = (colIndex: number, isRange: boolean) => {
    const lastRow = Math.max((activeTab?.data.length ?? 0) - 1, 0);
    const anchorCol = isRange ? selectionAnchor.col : colIndex;
    setSelection({
      startRow: 0,
      endRow: lastRow,
      startCol: anchorCol,
      endCol: colIndex,
    });
    setActiveCell({ row: 0, col: colIndex });
    setSelectionMode('col');
    if (!isRange) {
      setSelectionAnchor({ row: 0, col: colIndex });
    }
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
    const lines: string[] = [];
    for (let r = startRow; r <= endRow; r += 1) {
      const row = activeTab.data[r] ?? [];
      const cells: string[] = [];
      for (let c = startCol; c <= endCol; c += 1) {
        cells.push(row[c] ?? '');
      }
      lines.push(cells.join('\t'));
    }
    const text = lines.join('\n');
    try {
      await navigator.clipboard.writeText(text);
    } catch (error) {
      void logError('spreadsheet.copy.failed', error);
    }
  };

  const applyPaste = (text: string) => {
    if (!activeTab) return;
    const rows = text.replace(/\r/g, '').split('\n');
    if (rows.length === 0) return;
    if (rows[rows.length - 1] === '') rows.pop();
    const values = rows.map((row) => row.split('\t'));
    if (values.length === 0) return;
    const maxCols = Math.max(1, ...values.map((row) => row.length));

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

  const applyRowsToNewTab = (nextRows: string[][], filename?: string) => {
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
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newTab.id);
  };

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

  const handleRemoveDuplicatesByEmail = () => {
    if (!activeTab) return;
    const data = activeTab.data;
    const header = hasHeaderRow(data) ? data[0] : null;
    const body = header ? data.slice(1) : data;
    const emailColumns = detectEmailColumns(data);

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

    const afterEmailDedup = [...emailMap.values().map((item) => item.row), ...rowsWithoutEmail];
    if (emailColumns.length === 0) {
      applyRows(header ? [header, ...afterEmailDedup] : afterEmailDedup);
      return;
    }

    const ignoreSet = new Set(emailColumns);
    const rowMap = new Map<string, { row: string[]; score: number }>();

    for (const row of afterEmailDedup) {
      const keyParts = row
        .filter((_, index) => !ignoreSet.has(index))
        .map((cell) => cell.trim());
      const hasNonEmail = keyParts.some((value) => value.length > 0);
      const key = hasNonEmail ? keyParts.join('\u0001') : row.join('\u0001');
      const score = countFilledCells(row);
      const existing = rowMap.get(key);
      if (!existing || score > existing.score) {
        rowMap.set(key, { row, score });
      }
    }

    const nextRows = [...rowMap.values()].map((item) => item.row);
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

  const handleRemoveEmptyRows = () => {
    if (!activeTab) return;
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
    const maxCols = Math.max(1, ...data.map((row) => row.length));
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
    updateActiveSheet((sheet) => {
      const nextData = sheet.data.map((row) => {
        const filtered = row.filter((_, idx) => idx < startCol || idx > endCol);
        return filtered.length > 0 ? filtered : [''];
      });
      return { ...sheet, data: nextData };
    });
    setSelection({ startRow: 0, startCol: 0, endRow: 0, endCol: 0 });
    setSelectionAnchor({ row: 0, col: 0 });
    setActiveCell({ row: 0, col: 0 });
    setSelectionMode('cell');
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
      (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a';
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
      (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c';
    if (isCopy) {
      event.preventDefault();
      void copySelection();
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const text = event.clipboardData.getData('text');
    if (!text) return;
    event.preventDefault();
    applyPaste(text);
  };

  const rowCount = activeTab?.data.length ?? 0;
  const colCount = activeTab?.data[0]?.length ?? 0;
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

    for (let rowIndex = 1; rowIndex < activeTab.data.length; rowIndex += 1) {
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

  const groupSummary = useMemo(() => {
    if (!activeTab || groupByCol === null) return [];
    const map = new Map<string, { label: string; count: number }>();
    for (let i = 1; i < activeTab.data.length; i += 1) {
      const row = activeTab.data[i];
      if (!rowMatchesFilters(i, row, groupByCol)) continue;
      const raw = row[groupByCol] ?? '';
      const key = normalizeCellKey(raw);
      const label = raw.trim().length > 0 ? raw.trim() : BLANK_FILTER_LABEL;
      const entry = map.get(key) ?? { label, count: 0 };
      entry.count += 1;
      map.set(key, entry);
    }
    return [...map.entries()]
      .map(([key, value]) => ({ key, label: value.label, count: value.count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'ru'));
  }, [activeTab, groupByCol, rowMatchesFilters]);

  const normalizedGroupSearch = normalizeText(debouncedGroupSearch, normalizeOptions);
  const filteredGroupSummary = useMemo(() => {
    if (normalizedGroupSearch.length === 0) return groupSummary;
    return groupSummary.filter((item) =>
      normalizeText(item.label, normalizeOptions).includes(normalizedGroupSearch),
    );
  }, [groupSummary, normalizedGroupSearch, normalizeOptions]);

  const visibleRowIndices = useMemo(() => {
    if (!activeTab) return [];
    const indices: number[] = [];
    for (let i = 1; i < activeTab.data.length; i += 1) {
      const row = activeTab.data[i];
      if (rowMatchesFilters(i, row)) {
        indices.push(i);
      }
    }
    return indices;
  }, [activeTab, rowMatchesFilters]);

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
    if (!shouldVirtualize || allRowIndices.length === 0) {
      return { start: 0, end: Math.max(0, allRowIndices.length - 1), top: 0, bottom: 0 };
    }
    const { scrollTop, height } = scrollMetrics;
    const start = Math.max(0, Math.floor(scrollTop / VIRTUAL_ROW_HEIGHT) - VIRTUAL_OVERSCAN);
    const end = Math.min(
      allRowIndices.length - 1,
      Math.ceil((scrollTop + height) / VIRTUAL_ROW_HEIGHT) + VIRTUAL_OVERSCAN,
    );
    const top = start * VIRTUAL_ROW_HEIGHT;
    const bottom = Math.max(0, (allRowIndices.length - end - 1) * VIRTUAL_ROW_HEIGHT);
    return { start, end, top, bottom };
  }, [shouldVirtualize, allRowIndices.length, scrollMetrics]);

  const rowIndicesToRender = shouldVirtualize
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

    if (!personalization.prompt.trim()) {
      setPersonalization((prev) => ({
        ...prev,
        error: 'Введите промпт для генерации',
      }));
      return;
    }

    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
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
    let lastBatchError: string | null = null;
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
                personalization.prompt,
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
          }
        }

        if (!res.ok) {
          await sleep(1000);
          continue;
        }

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
            pendingUpdates.set(result.row_index, result.result_text ?? '');
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

  const handleStopWebsiteEnrichment = () => {
    if (!websiteEnrichment.isGenerating || !websiteEnrichment.jobId) return;
    if (
      !window.confirm(
        'Остановить обогащение? После отмены прогресс не сохранится и запустить придётся заново.',
      )
    ) {
      return;
    }
    if (enrichmentAbortRef.current) {
      enrichmentAbortRef.current.abort();
    }
    removeEnrichmentRun(websiteEnrichment.jobId);
    void (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      let token = session?.access_token;
      if (!token) {
        const { data: refreshed } = await supabase.auth.refreshSession();
        token = refreshed.session?.access_token;
      }
      if (token) {
        await fetch(`/api/enrich/website/jobs/${websiteEnrichment.jobId}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ status: 'cancelled' }),
        });
      }
    })();
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
  const openBriefScoringModal = () => {
    setBriefScoring({
      isOpen: true,
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
    });
  };

  const closeBriefScoringModal = () => {
    if (briefScoringAbortRef.current) {
      briefScoringAbortRef.current.abort();
      briefScoringAbortRef.current = null;
    }
    setBriefScoring((prev) => ({
      ...prev,
      isOpen: false,
      isScoring: false,
      isUploading: false,
      error: null,
    }));
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

  const handleStartBriefScoring = async () => {
    if (!activeTab || briefScoring.isScoring) return;

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

    const dataRows = activeTab.data.slice(1).filter((row) => !isRowEmpty(row));
    if (dataRows.length === 0) {
      setBriefScoring((prev) => ({ ...prev, error: 'Нет данных для оценки' }));
      return;
    }

    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    if (!token) {
      setBriefScoring((prev) => ({ ...prev, error: 'Необходима авторизация' }));
      return;
    }

    briefScoringAbortRef.current = new AbortController();

    setBriefScoring((prev) => ({
      ...prev,
      isScoring: true,
      progress: 0,
      totalRows: dataRows.length,
      currentRow: 0,
      error: null,
    }));

    setUndoSnapshot('Оценка ЦА');

    // Add two new columns: Score and Reason
    const scoreColIndex = activeTab.data[0].length;
    const reasonColIndex = scoreColIndex + 1;

    const baseData = activeTab.data.map((row, rowIndex) => {
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
    highlightTimeoutRef.current = setTimeout(() => setHighlightedCol(null), BRIEF_SCORING_HIGHLIGHT_DURATION);

    if (tableWrapperRef.current) {
      const wrapper = tableWrapperRef.current;
      requestAnimationFrame(() => wrapper.scrollTo({ left: wrapper.scrollWidth, behavior: 'smooth' }));
    }

    // Build list of rows to process with all their column data
    const rowsToProcess: { rowIndex: number; data: Record<string, string> }[] = [];
    for (let i = 1; i < activeTab.data.length; i++) {
      const row = activeTab.data[i];
      if (isRowEmpty(row)) continue;
      const rowData: Record<string, string> = {};
      for (let c = 0; c < activeTab.data[0].length; c++) {
        const header = headerLabels[c] || toColumnLabel(c);
        const value = row[c]?.trim() ?? '';
        if (value.length > 0) rowData[header] = value;
      }
      rowsToProcess.push({ rowIndex: i, data: rowData });
    }

    let processedCount = 0;
    let errorCount = 0;

    try {
      for (let batchStart = 0; batchStart < rowsToProcess.length; batchStart += BRIEF_SCORING_BATCH_SIZE) {
        if (briefScoringAbortRef.current?.signal.aborted) throw new Error('Отменено пользователем');

        const batch = rowsToProcess.slice(batchStart, batchStart + BRIEF_SCORING_BATCH_SIZE);
        const companies = batch.map((item) => ({ idx: item.rowIndex, data: item.data }));

        try {
          let resData: { scores?: { idx: number; score: number; reason: string }[]; error?: string } | null = null;

          for (let attempt = 0; attempt <= BRIEF_SCORING_MAX_RETRIES; attempt += 1) {
            if (briefScoringAbortRef.current?.signal.aborted) {
              throw new Error('Отменено пользователем');
            }

            let res: Response;
            try {
              res = await fetch('/api/brief-scoring/score', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ briefText: effectiveBriefText, companies }),
                signal: briefScoringAbortRef.current?.signal,
              });
            } catch (error) {
              if (error instanceof Error && error.name === 'AbortError') {
                throw error;
              }
              if (attempt < BRIEF_SCORING_MAX_RETRIES) {
                const retryDelay =
                  BRIEF_SCORING_RETRY_BASE_DELAY * Math.pow(2, attempt) +
                  Math.floor(Math.random() * 300);
                await sleep(retryDelay);
                continue;
              }
              throw new Error('Не удалось отправить запрос к AI');
            }

            let parsed: { scores?: { idx: number; score: number; reason: string }[]; error?: string } | null = null;
            try {
              parsed = (await res.json()) as { scores?: { idx: number; score: number; reason: string }[]; error?: string };
            } catch {
              parsed = null;
            }

            if (res.ok && parsed && !parsed.error) {
              resData = parsed;
              break;
            }

            const shouldRetry = [429, 500, 502, 503, 504].includes(res.status);
            const errorMessage = parsed?.error || `Ошибка AI (${res.status})`;

            if (shouldRetry && attempt < BRIEF_SCORING_MAX_RETRIES) {
              const retryDelay =
                BRIEF_SCORING_RETRY_BASE_DELAY * Math.pow(2, attempt) +
                Math.floor(Math.random() * 300);
              await sleep(retryDelay);
              continue;
            }

            resData = { error: errorMessage };
            break;
          }

          if (!resData) {
            throw new Error('Не удалось получить ответ от AI');
          }

          if (resData.error) {
            errorCount += batch.length;
            setTabs((prev) =>
              prev.map((tab) => {
                if (tab.id !== activeTabId) return tab;
                const nextData = tab.data.map((row, idx) => {
                  if (!batch.find((b) => b.rowIndex === idx)) return row;
                  const newRow = [...row];
                  while (newRow.length <= reasonColIndex) newRow.push('');
                  newRow[scoreColIndex] = '⚠';
                  newRow[reasonColIndex] = resData.error || 'Ошибка AI';
                  return newRow;
                });
                return { ...tab, data: nextData };
              }),
            );
          } else if (resData.scores) {
            const scoresMap = new Map<number, { score: number; reason: string }>();
            for (const s of resData.scores) scoresMap.set(s.idx, { score: s.score, reason: s.reason });

            // Count missing scores
            for (const item of batch) {
              if (!scoresMap.has(item.rowIndex)) errorCount++;
            }

            setTabs((prev) =>
              prev.map((tab) => {
                if (tab.id !== activeTabId) return tab;
                const nextData = tab.data.map((row, idx) => {
                  const score = scoresMap.get(idx);
                  if (!score) {
                    if (batch.find((b) => b.rowIndex === idx)) {
                      const newRow = [...row];
                      while (newRow.length <= reasonColIndex) newRow.push('');
                      newRow[scoreColIndex] = '?';
                      newRow[reasonColIndex] = 'Нет оценки от AI';
                      return newRow;
                    }
                    return row;
                  }
                  const newRow = [...row];
                  while (newRow.length <= reasonColIndex) newRow.push('');
                  newRow[scoreColIndex] = String(score.score);
                  newRow[reasonColIndex] = score.reason;
                  return newRow;
                });
                return { ...tab, data: nextData };
              }),
            );
          }
        } catch (err) {
          if (err instanceof Error && err.name === 'AbortError') throw err;
          errorCount += batch.length;
          setTabs((prev) =>
            prev.map((tab) => {
              if (tab.id !== activeTabId) return tab;
              const nextData = tab.data.map((row, idx) => {
                if (!batch.find((b) => b.rowIndex === idx)) return row;
                const newRow = [...row];
                while (newRow.length <= reasonColIndex) newRow.push('');
                newRow[scoreColIndex] = '⚠';
                newRow[reasonColIndex] = err instanceof Error ? err.message : 'Ошибка';
                return newRow;
              });
              return { ...tab, data: nextData };
            }),
          );
        }

        processedCount += batch.length;
        setBriefScoring((prev) => ({
          ...prev,
          currentRow: processedCount,
          progress: Math.round((processedCount / rowsToProcess.length) * 100),
        }));

        if (batchStart + BRIEF_SCORING_BATCH_SIZE < rowsToProcess.length) await sleep(500);
      }

      const successCount = processedCount - errorCount;
      setLastAction({
        message: errorCount > 0
          ? `Оценка ЦА: ${successCount} успешно, ${errorCount} с ошибками`
          : `Оценка ЦА завершено: ${processedCount} строк`,
        time: Date.now(),
      });
      setBriefScoring((prev) => ({ ...prev, isScoring: false, isOpen: false }));
    } catch (err) {
      if (err instanceof Error && (err.name === 'AbortError' || err.message === 'Отменено пользователем')) {
        setLastAction({ message: `Оценка ЦА отменено (обработано: ${processedCount})`, time: Date.now() });
        setBriefScoring((prev) => ({ ...prev, isScoring: false, isOpen: false }));
      } else {
        setBriefScoring((prev) => ({
          ...prev,
          error: err instanceof Error ? err.message : 'Произошла ошибка',
          isScoring: false,
        }));
      }
    } finally {
      briefScoringAbortRef.current = null;
    }
  };

  // ── Name Cleanup (Очистка названий) ──────────────────────────────

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
      if (!activeTab) return new Set();
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
    const applySession = (session: { user: { id: string } } | null) => {
      if (!isMounted) return;
      const userId = session?.user?.id ?? null;
      setUserId(userId);
      setStorageKey(buildStorageKey(userId));
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
    };
  }, []);

  useEffect(() => {
    if (!storageKey) return;
    let isMounted = true;
    setIsHydrated(false);
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }

    const applyState = (state: PersistedSpreadsheetState | null) => {
      if (!isMounted) return;
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
      setIsHydrated(true);
    };

    const localState = readPersistedState(window.localStorage.getItem(storageKey));

    if (!userId) {
      applyState(localState);
      return () => {
        isMounted = false;
      };
    }

    void (async () => {
      let remoteState: PersistedSpreadsheetState | null = null;
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

      const nextState = remoteState ?? localState;
      if (nextState) {
        try {
          window.localStorage.setItem(storageKey, JSON.stringify(nextState));
        } catch (error) {
          void logError('spreadsheet.state.local_save.failed', error);
        }
      }
      applyState(nextState);

      if (!remoteState && localState) {
        try {
          await supabase.from('database_spreadsheet_states').upsert({
            user_id: userId,
            state: localState,
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
    const safeActiveTabId = resolveActiveTabId(tabs, activeTabId);
    const payload: PersistedSpreadsheetState = {
      version: STORAGE_VERSION,
      tabs,
      activeTabId: safeActiveTabId,
      tabCounter: deriveTabCounter(tabs, tabCounter),
      columnWidths,
    };
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    const userIdSnapshot = userId;
    const storageKeySnapshot = storageKey;
    saveTimeoutRef.current = setTimeout(() => {
      try {
        window.localStorage.setItem(storageKeySnapshot, JSON.stringify(payload));
      } catch (error) {
        void logError('spreadsheet.state.local_save.failed', error);
      }
      if (!userIdSnapshot) return;
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
    }, STORAGE_SAVE_DELAY);
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }
    };
  }, [tabs, activeTabId, tabCounter, columnWidths, storageKey, isHydrated, userId]);

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

  return (
    <div className="space-y-0.5 h-[calc(100vh-0.75rem)] flex flex-col">
      <div className="flex flex-wrap items-center gap-1.5 pb-1 flex-shrink-0">
        <span className="text-xs font-semibold text-gray-500 mr-1">Базы</span>

        {selectedRows.size > 0 && (
          <button
            type="button"
            onClick={confirmRemoveSelectedRows}
            className="inline-flex items-center gap-1 rounded bg-red-50 px-2 py-1 text-[11px] font-medium text-red-700 transition hover:bg-red-100"
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

        <div className="flex items-center rounded bg-gray-100 p-0.5">
          <button
            type="button"
            onClick={() => importInputRef.current?.click()}
            className="rounded px-2 py-1 text-[11px] font-medium text-gray-600 transition hover:bg-white hover:text-gray-900"
          >
            Импорт
          </button>
          <div className="h-3 w-px bg-gray-300 mx-0.5" />
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

        <div className="h-4 w-px bg-gray-200 mx-0.5" />

        <button
          type="button"
          onClick={openPersonalizationModal}
          disabled={colCount === 0}
          className="inline-flex items-center rounded bg-gray-900 px-2.5 py-1 text-[11px] font-medium text-white transition hover:bg-gray-800 disabled:bg-gray-300"
        >
          Персонализация
        </button>

        <button
          type="button"
          onClick={openWebsiteEnrichmentModal}
          disabled={colCount === 0}
          className="inline-flex items-center rounded bg-blue-600 px-2.5 py-1 text-[11px] font-medium text-white transition hover:bg-blue-700 disabled:bg-gray-300"
        >
          Обогатить
        </button>

        <button
          type="button"
          onClick={openBriefScoringModal}
          disabled={colCount === 0}
          className="inline-flex items-center rounded bg-emerald-600 px-2.5 py-1 text-[11px] font-medium text-white transition hover:bg-emerald-700 disabled:bg-gray-300"
        >
          Оценка ЦА
        </button>

        <button
          type="button"
          onClick={openNameCleanupModal}
          disabled={colCount === 0}
          className="inline-flex items-center rounded bg-amber-600 px-2.5 py-1 text-[11px] font-medium text-white transition hover:bg-amber-700 disabled:bg-gray-300"
        >
          Чистка названий
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
              className="rounded border border-red-200 bg-red-50 px-1.5 py-0.5 text-[10px] font-medium text-red-600 hover:bg-red-100"
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

      <div className="grid gap-1 lg:grid-cols-[minmax(0,1fr)_220px] flex-1 min-h-0">
        <div className="rounded border border-gray-200 bg-white overflow-hidden">
          <div
            ref={tableWrapperRef}
            className="overflow-auto h-full"
            onKeyDownCapture={handleGridKeyDown}
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
            <table className="min-w-max border-separate border-spacing-0">
              <thead>
                <tr>
                  <th className="sticky top-0 left-0 z-20 border-b border-r border-gray-200 bg-gray-50 px-1 py-0.5 text-[10px] font-semibold text-gray-500 w-9 min-w-[36px]">
                    <div className="flex items-center justify-center h-full">
                      <input
                        ref={selectAllRef}
                        type="checkbox"
                        checked={allVisibleSelected}
                        onChange={toggleSelectAllVisible}
                        onClick={(event) => event.stopPropagation()}
                        className="h-3 w-3 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
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
                        onClick={(event) => handleColumnHeaderClick(colIndex, event.shiftKey)}
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
                        style={{ width: getColumnWidth(colIndex), minWidth: getColumnWidth(colIndex) }}
                        className={`sticky top-0 z-10 relative cursor-grab border-b border-r border-gray-200 px-1.5 py-1 text-[10px] font-semibold text-gray-700 transition select-none ${
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
                          className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-blue-400"
                        />
                      </th>
                    );
                  })}
                  <th className="sticky top-0 z-10 border-b border-gray-200 bg-gray-50 px-1 py-1 w-8">
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
                {shouldVirtualize && virtualRange.top > 0 && (
                  <tr aria-hidden>
                    <td colSpan={colCount + 2} style={{ height: virtualRange.top }} />
                  </tr>
                )}
                {rowIndicesToRender.map((rowIndex) => {
                  const row = activeTab?.data[rowIndex];
                  if (!row) return null;
                  const isChecked = selectedRows.has(rowIndex);
                  const isHeaderRow = rowIndex === 0;
                  return (
                    <tr
                      key={`row-${rowIndex}`}
                      className="group"
                      style={shouldVirtualize ? { height: VIRTUAL_ROW_HEIGHT } : undefined}
                    >
                      <th
                        draggable={!isHeaderRow}
                        onDragStart={(e) => handleRowDragStart(e, rowIndex)}
                        onDragOver={(e) => handleRowDragOver(e, rowIndex)}
                        onDrop={(e) => handleRowDrop(e, rowIndex)}
                        onDragEnd={handleRowDragEnd}
                        onClick={(event) => handleRowHeaderClick(rowIndex, event.shiftKey)}
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
                        className={`sticky left-0 z-10 border-b border-r border-gray-200 px-1 py-0.5 text-[10px] font-medium transition-colors select-none ${
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
                                : 'bg-gray-50 text-gray-500 group-hover:bg-gray-100'
                        }`}
                      >
                        <div className="flex items-center justify-center gap-1 h-full">
                          <input
                            type="checkbox"
                            checked={isChecked}
                            disabled={isHeaderRow}
                            onChange={() => toggleRowSelection(rowIndex)}
                            onClick={(event) => event.stopPropagation()}
                            className="h-3 w-3 rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-40"
                            aria-label={`Выбрать строку ${rowIndex + 1}`}
                          />
                          <span className="min-w-[1.5rem] text-center">{rowIndex + 1}</span>
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
                              : 'bg-white';

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
                            }}
                            className={`border-b border-r border-gray-100 p-0 align-top ${cellBackground}`}
                          >
                            {isActive ? (
                              <textarea
                                value={value}
                                onChange={(event) => {
                                  handleValueChange(rowIndex, colIndex, event.target.value);
                                  if (!shouldVirtualize) {
                                    event.target.style.height = 'auto';
                                    event.target.style.height = `${event.target.scrollHeight}px`;
                                  }
                                }}
                                onFocus={(e) => {
                                  handleCellFocus(rowIndex, colIndex);
                                  if (!shouldVirtualize) {
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
                              className={`w-full bg-transparent px-1.5 py-0.5 text-[11px] text-gray-900 outline-none resize-none min-h-[24px] leading-snug ring-2 ring-blue-500 ring-inset z-10 relative ${
                                effectiveWrapCells
                                  ? 'whitespace-pre-wrap break-words overflow-hidden'
                                  : 'whitespace-nowrap overflow-x-auto overflow-y-hidden'
                              }`}
                              />
                            ) : (
                              <div
                                className={`w-full h-full min-h-[24px] px-1.5 py-0.5 text-[11px] text-gray-900 leading-snug ${
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
                      <td className="border-b border-gray-100 bg-gray-50" />
                    </tr>
                  );
                })}
                {shouldVirtualize && virtualRange.bottom > 0 && (
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
                      <td key={`add-row-${colIndex}`} className="border-b border-r border-gray-100 bg-gray-50" />
                    ))}
                    <td className="border-b border-gray-100 bg-gray-50" />
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

        <aside className="rounded border border-gray-200 bg-white p-2 h-fit text-xs">
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
                    {filteredGroupSummary.map((item) => {
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
                    onClick={handleRemoveDuplicatesByEmail}
                    className="w-full text-left rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-700 transition hover:bg-gray-50 hover:border-gray-300"
                  >
                    Убрать дубликаты по Email
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
      </div>
      {filterMenu && (
        <div
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

            <div className="space-y-6 px-6 py-6">
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
                <label className="block text-sm font-semibold text-gray-700">
                  Промпт для генерации
                </label>
                <div className="relative">
                  <textarea
                    value={personalization.prompt}
                    onChange={(e) =>
                      setPersonalization((prev) => ({
                        ...prev,
                        prompt: e.target.value,
                        error: null,
                      }))
                    }
                    disabled={personalization.isGenerating}
                    placeholder="Например: Напиши короткое предложение о том, как наши услуги помогут компании..."
                    rows={4}
                    className="w-full resize-none rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-900 outline-none transition-all placeholder:text-gray-400 focus:border-gray-400 disabled:opacity-60"
                  />
                </div>
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
                  disabled={personalization.isGenerating || !personalization.prompt.trim()}
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
                disabled={briefScoring.isScoring}
                className="rounded-lg p-2 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 disabled:opacity-50 text-xl leading-none"
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
                Batch: {BRIEF_SCORING_BATCH_SIZE} строк
              </div>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={closeBriefScoringModal}
                  disabled={briefScoring.isScoring}
                  className="rounded-lg px-4 py-2.5 text-sm font-medium text-gray-600 transition hover:bg-gray-200 hover:text-gray-900 disabled:opacity-50"
                >
                  {briefScoring.isScoring ? 'Отменить' : 'Закрыть'}
                </button>
                <button
                  type="button"
                  onClick={() => void handleStartBriefScoring()}
                  disabled={
                    briefScoring.isScoring ||
                    (briefScoring.inputMode === 'pdf' ? !briefScoring.briefText : !briefScoring.manualText.trim())
                  }
                  className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white shadow-lg shadow-emerald-600/20 transition-all hover:bg-emerald-700 hover:shadow-xl hover:-translate-y-0.5 active:translate-y-0 disabled:bg-gray-300 disabled:shadow-none disabled:translate-y-0 disabled:cursor-not-allowed"
                >
                  {briefScoring.isScoring ? (
                    <>
                      <span className="animate-spin">⟳</span>
                      Оценка...
                    </>
                  ) : (
                    <>
                      <span>🎯</span>
                      Запустить оценку
                    </>
                  )}
                </button>
              </div>
            </div>
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
    </div>
  );
}
