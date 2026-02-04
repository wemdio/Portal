'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ClipboardEvent, KeyboardEvent, MouseEvent } from 'react';
import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { supabase } from '@/lib/supabaseClient';

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

const OPENROUTER_API_KEY = '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';
const OPENROUTER_MODEL = 'google/gemini-3-flash-preview';
const PERSONALIZATION_BATCH_SIZE = 2;
const PERSONALIZATION_MAX_RETRIES = 3;
const PERSONALIZATION_RETRY_BASE_DELAY = 1200;
const PERSONALIZATION_HIGHLIGHT_DURATION = 2500;
const WRAP_STORAGE_KEY = 'portal:db-wrap-cells';

const SYSTEM_PROMPT = `Ты - помощник для персонализации холодного email-аутрича в B2B.

КЛЮЧЕВАЯ ЗАДАЧА:
- Генерируй короткие персонализированные фразы для email-аутрича на основе ДАННЫХ ИЗ СТОЛБЦА и промпта пользователя.

КРИТИЧЕСКИ ВАЖНО:
1. Используй ТОЛЬКО факты из входных данных. НИЧЕГО не выдумывай.
2. Не добавляй названия компаний, имена, цифры, кейсы, сроки, технологии, если их нет в данных.
3. Если данных мало - пиши нейтрально и обобщенно, без уточнений.
4. Не добавляй приветствия, подписи, темы письма и служебные фразы.

СТИЛЬ:
- Пиши как живой человек, без канцелярита и шаблонов
- СТРОГО соблюдай русскую грамматику, падежи и склонения
- Используй ТОЛЬКО дефис "-", НИКОГДА не используй длинное тире "—"
- 1-3 коротких предложения, конкретно по делу
- Не используй восклицательные знаки в избытке
- Избегай слов: "уникальный", "эксклюзивный", "лучший", "инновационный"
- Фокусируйся на выгоде/ценности для клиента

Ответ: только текст персонализации, без пояснений и нумерации.`;

const EMAIL_HEADER_REGEX = /(e-?mail|email|почта|mail)/i;
const EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const MAX_FILTER_OPTIONS = 1000;
const BLANK_FILTER_LABEL = '(пусто)';
const EMOJI_REGEX = /[\u{1F300}-\u{1FAFF}]/gu;
const DEFAULT_COLUMN_WIDTH = 160;
const MIN_COLUMN_WIDTH = 80;
const COMPANY_HEADER_REGEX = /(компан|company|организац)/i;

const DEFAULT_ROWS = 20;
const DEFAULT_COLS = 10;
const STORAGE_KEY_PREFIX = 'portal:database-spreadsheet';
const STORAGE_VERSION = 1;
const STORAGE_SAVE_DELAY = 700;

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
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingTabName, setEditingTabName] = useState('');
  const [selectionMode, setSelectionMode] = useState<SelectionMode>('cell');
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [filterMenu, setFilterMenu] = useState<FilterMenuState | null>(null);
  const [columnFilters, setColumnFilters] = useState<Record<number, string[]>>({});
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOnlyMatches, setSearchOnlyMatches] = useState(false);
  const [wrapCells, setWrapCells] = useState(true);
  const [normalizeLowercase, setNormalizeLowercase] = useState(true);
  const [normalizeSpaces, setNormalizeSpaces] = useState(true);
  const [normalizeEmoji, setNormalizeEmoji] = useState(true);
  const [groupByCol, setGroupByCol] = useState<number | null>(null);
  const [groupSearch, setGroupSearch] = useState('');
  const [rightPanelTab, setRightPanelTab] = useState<'summary' | 'cleanup'>('summary');
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

  const normalizeOptions = useMemo(
    () => ({
      lower: normalizeLowercase,
      trim: normalizeSpaces,
      removeEmoji: normalizeEmoji,
    }),
    [normalizeLowercase, normalizeSpaces, normalizeEmoji],
  );

  const searchTerms = useMemo(() => {
    const baseTerms = parseTerms(searchQuery);
    if (baseTerms.length === 0) return [];
    const normalizedBase = baseTerms
      .map((term) => normalizeText(term, normalizeOptions))
      .filter((term) => term.length > 0);
    return Array.from(new Set(normalizedBase));
  }, [searchQuery, normalizeOptions]);


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
      console.error('Copy failed:', error);
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
      console.error('Import failed:', error);
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
        const normalizedRow = normalizeText(row.join(' '), normalizeOptions);
        const matches = searchTerms.some((term) => normalizedRow.includes(term));
        if (!matches) return false;
      }
      return true;
    },
    [filterEntries, normalizeOptions, searchOnlyMatches, searchTerms],
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
  const filterSearch = filterMenu?.search.trim().toLowerCase() ?? '';
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
    return Array.from({ length: colCount }, (_, index) => {
      const label = headerRow[index]?.trim();
      return label && label.length > 0 ? label : toColumnLabel(index);
    });
  }, [activeTab, colCount]);

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

  const normalizedGroupSearch = normalizeText(groupSearch, normalizeOptions);
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

  const handleUndo = useCallback(() => {
    if (!lastUndo) return;
    setTabs((prev) =>
      prev.map((tab) => (tab.id === lastUndo.tabId ? { ...tab, data: lastUndo.data } : tab)),
    );
    setLastAction({ message: `Вернули: ${lastUndo.message}`, time: Date.now() });
    setLastUndo(null);
  }, [lastUndo]);

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
  ): Promise<string> => {
    const requestBody = {
      model: OPENROUTER_MODEL,
      messages: [
        {
          role: 'system',
          content: SYSTEM_PROMPT,
        },
        {
          role: 'user',
          content: `Данные для персонализации: "${sourceData}"

Задача от пользователя: ${userPrompt}

Сгенерируй 1 персонализированное предложение.
Не нумеруй варианты. Пиши только сами предложения без пояснений.`,
        },
      ],
      temperature: 0.7,
      max_tokens: 500,
    };

    for (let attempt = 0; attempt <= PERSONALIZATION_MAX_RETRIES; attempt += 1) {
      let response: Response;

      try {
        response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
            'HTTP-Referer': typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000',
            'X-Title': 'Portal - Database Personalization',
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

      if (response.ok) {
        const data = await response.json();
        const content = data.choices?.[0]?.message?.content?.trim() || '';
        if (!content) {
          throw new Error('Пустой ответ от API');
        }
        return content;
      }

      const shouldRetry = [429, 502, 503, 504].includes(response.status);
      let errorMessage = `API ошибка: ${response.status}`;
      try {
        const errorData = await response.json();
        errorMessage = errorData.error?.message || errorMessage;
      } catch {
        // ignore parse error
      }

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
                personalization.prompt,
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
          await sleep(700);
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
      console.error('Не удалось загрузить настройку переноса строк:', error);
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(WRAP_STORAGE_KEY, String(wrapCells));
    } catch (error) {
      console.error('Не удалось сохранить настройку переноса строк:', error);
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
        console.error('Не удалось загрузить таблицу из Supabase:', error);
      }

      const nextState = remoteState ?? localState;
      if (nextState) {
        try {
          window.localStorage.setItem(storageKey, JSON.stringify(nextState));
        } catch (error) {
          console.error('Не удалось обновить локальное сохранение:', error);
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
          console.error('Не удалось сохранить таблицу в Supabase:', error);
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
        console.error('Не удалось сохранить таблицу:', error);
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
            console.error('Не удалось сохранить таблицу в Supabase:', error);
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

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between border-b border-gray-100 pb-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight text-gray-900">Работа с базами</h1>
          <p className="text-sm text-gray-500 max-w-2xl">
            Табличный редактор. Поддерживает Ctrl/Cmd+C/V и Ctrl/Cmd+Z.
          </p>
        </div>
        
        <div className="flex flex-col items-end gap-2">
          <div className="flex flex-wrap items-center gap-3">
            {selectedRows.size > 0 && (
              <button
                type="button"
                onClick={confirmRemoveSelectedRows}
                className="inline-flex items-center gap-2 rounded-lg bg-red-50 px-4 py-2 text-sm font-medium text-red-700 transition hover:bg-red-100"
              >
                Удалить ({selectedRows.size})
              </button>
            )}

            <div className="flex items-center rounded-lg bg-gray-100 p-1">
              <button
                type="button"
                onClick={() => importInputRef.current?.click()}
                className="rounded-md px-3 py-1.5 text-sm font-medium text-gray-600 transition hover:bg-white hover:text-gray-900 hover:shadow-sm"
              >
                Импорт
              </button>
              <div className="h-4 w-px bg-gray-300 mx-1" />
              <button
                type="button"
                onClick={handleExportCsv}
                className="rounded-md px-3 py-1.5 text-sm font-medium text-gray-600 transition hover:bg-white hover:text-gray-900 hover:shadow-sm"
              >
                CSV
              </button>
              <button
                type="button"
                onClick={handleExportXlsx}
                className="rounded-md px-3 py-1.5 text-sm font-medium text-gray-600 transition hover:bg-white hover:text-gray-900 hover:shadow-sm"
              >
                Excel
              </button>
            </div>

            <button
              type="button"
              onClick={openPersonalizationModal}
              disabled={colCount === 0}
              className="inline-flex items-center gap-2 rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-gray-800 disabled:bg-gray-300"
            >
              <span>Персонализация</span>
            </button>
          </div>
          {importStatus.status !== 'idle' && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
              <span>{formatProgressLabel(importStatus)}</span>
              {importStatus.filename ? (
                <span className="max-w-[200px] truncate">· {importStatus.filename}</span>
              ) : null}
              {importStatus.status !== 'error' ? <span>{importStatus.progress}%</span> : null}
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-col lg:flex-row gap-4 items-start lg:items-center justify-between bg-white rounded-xl p-4 border border-gray-200">
        <div className="flex items-center gap-2 flex-1 w-full lg:w-auto">
          <div className="relative flex-1 lg:max-w-md">
            <input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Поиск по всем колонкам..."
              className="w-full rounded-lg border border-gray-200 bg-gray-50 py-2 px-3 text-sm text-gray-900 outline-none transition focus:border-gray-400 focus:bg-white placeholder:text-gray-400"
            />
            {searchQuery.length > 0 && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-gray-400 hover:bg-gray-200 hover:text-gray-600 text-lg leading-none"
                aria-label="Очистить поиск"
              >
                &times;
              </button>
            )}
          </div>
          
          <label className="flex items-center gap-2 cursor-pointer select-none rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 transition-all">
            <input
              type="checkbox"
              checked={searchOnlyMatches}
              onChange={(event) => setSearchOnlyMatches(event.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            <span>Только совпадения</span>
          </label>

          <button
            type="button"
            onClick={() => setWrapCells((prev) => !prev)}
            aria-pressed={wrapCells}
            className={`rounded-lg border px-3 py-2 text-sm font-medium transition ${
              wrapCells
                ? 'border-gray-900 bg-gray-900 text-white'
                : 'border-gray-200 bg-gray-50 text-gray-600 hover:bg-gray-100'
            }`}
          >
            Перенос строк: {wrapCells ? 'вкл' : 'выкл'}
          </button>
        </div>

        <div className="flex items-center gap-2 overflow-x-auto max-w-full pb-1 lg:pb-0">
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            const isEditing = editingTabId === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTabId(tab.id)}
                className={`group flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-all whitespace-nowrap ${
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
                    className="w-24 bg-transparent border-b border-blue-500 text-gray-900 outline-none p-0"
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
                    className="flex h-4 w-4 items-center justify-center rounded-full text-base leading-none opacity-0 group-hover:opacity-100 transition-opacity hover:bg-gray-200 hover:text-red-600"
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
            className="flex items-center justify-center h-9 w-9 rounded-lg border border-dashed border-gray-300 text-gray-400 hover:border-gray-400 hover:text-gray-600 hover:bg-gray-50 transition-all"
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

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
          <div
            ref={tableWrapperRef}
            className="overflow-auto max-h-[calc(100vh-300px)]"
            onKeyDownCapture={handleGridKeyDown}
            onContextMenu={(event) => {
              event.preventDefault();
              setFilterMenu(null);
              setContextMenu({ x: event.clientX, y: event.clientY });
            }}
          >
            <table className="min-w-max border-separate border-spacing-0">
              <thead>
                <tr>
                  <th className="sticky top-0 left-0 z-20 border-b border-r border-gray-200 bg-gray-50 px-2 py-2 text-xs font-semibold text-gray-500 w-10 min-w-[40px]">
                    <div className="flex items-center justify-center h-full">
                      <input
                        ref={selectAllRef}
                        type="checkbox"
                        checked={allVisibleSelected}
                        onChange={toggleSelectAllVisible}
                        onClick={(event) => event.stopPropagation()}
                        className="h-3.5 w-3.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
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
                        className={`sticky top-0 z-10 relative cursor-pointer border-b border-r border-gray-200 px-2 py-2 text-xs font-semibold text-gray-700 transition select-none ${
                          selectionMode === 'col' &&
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
                  <th className="sticky top-0 z-10 border-b border-gray-200 bg-gray-50 px-2 py-2 w-10">
                    <button
                      type="button"
                      onClick={handleAddColumn}
                      className="flex h-5 w-5 items-center justify-center rounded text-gray-400 hover:bg-gray-200 hover:text-gray-600 transition-colors"
                      aria-label="Добавить колонку"
                    >
                      +
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {activeTab?.data.map((row, rowIndex) => {
                  const isVisible = rowMatchesFilters(rowIndex, row);
                  if (!isVisible) return null;
                  const isChecked = selectedRows.has(rowIndex);
                  const isHeaderRow = rowIndex === 0;
                  return (
                    <tr key={`row-${rowIndex}`} className="group">
                      <th
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
                        className={`sticky left-0 z-10 cursor-pointer border-b border-r border-gray-200 px-2 py-2 text-xs font-medium transition-colors select-none ${
                          selectionMode === 'row' &&
                          rowIndex >= normalizedSelection.startRow &&
                          rowIndex <= normalizedSelection.endRow
                            ? 'bg-blue-100 text-blue-900'
                            : isChecked 
                              ? 'bg-blue-50 text-blue-800'
                              : 'bg-gray-50 text-gray-500 group-hover:bg-gray-100'
                        }`}
                      >
                        <div className="flex items-center justify-center gap-1.5 h-full">
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
                            normalizeText(value, normalizeOptions).includes(term),
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
                                  event.target.style.height = 'auto';
                                  event.target.style.height = `${event.target.scrollHeight}px`;
                                }}
                                onFocus={(e) => {
                                  handleCellFocus(rowIndex, colIndex);
                                  e.target.style.height = 'auto';
                                  e.target.style.height = `${e.target.scrollHeight}px`;
                                }}
                                onKeyDown={handleKeyDown}
                                onPaste={handlePaste}
                                rows={1}
                              wrap={wrapCells ? 'soft' : 'off'}
                                autoFocus
                              className={`w-full bg-transparent px-2 py-2 text-sm text-gray-900 outline-none resize-none min-h-[40px] leading-normal ring-2 ring-blue-500 ring-inset z-10 relative ${
                                wrapCells
                                  ? 'whitespace-pre-wrap break-words overflow-hidden'
                                  : 'whitespace-nowrap overflow-x-auto overflow-y-hidden'
                              }`}
                              />
                            ) : (
                              <div
                                className={`w-full h-full min-h-[40px] px-2 py-2 text-sm text-gray-900 leading-normal ${
                                  wrapCells ? 'whitespace-pre-wrap break-words' : 'truncate'
                                } ${cellMatchesSearch ? 'ring-1 ring-amber-300 ring-inset' : ''}`}
                                title={!wrapCells ? value : undefined}
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
                {rowCount > 0 && (
                  <tr>
                    <th className="sticky left-0 z-10 border-r border-gray-200 bg-gray-50 px-2 py-2">
                      <div className="flex items-center justify-center h-full">
                        <button
                          type="button"
                          onClick={handleAddRow}
                          className="flex h-5 w-5 items-center justify-center rounded text-gray-400 hover:bg-gray-200 hover:text-gray-600 transition-colors"
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
          </div>
        </div>

        <aside className="rounded-xl border border-gray-200 bg-white p-4 h-fit">
          <div className="flex items-center gap-2 rounded-lg bg-gray-50 p-1 text-xs mb-4">
            <button
              type="button"
              onClick={() => setRightPanelTab('summary')}
              className={`flex-1 rounded-md px-3 py-2 font-medium transition-all ${
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
              className={`flex-1 rounded-md px-3 py-2 font-medium transition-all ${
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
          className="fixed z-50 w-48 rounded-lg border border-gray-200 bg-white py-1 shadow-xl"
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
            className="w-full px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 transition-colors"
          >
            Копировать
          </button>
          <button
            type="button"
            onClick={() => {
              confirmDeleteSelection();
              setContextMenu(null);
            }}
            className="w-full px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50 transition-colors"
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
    </div>
  );
}
