'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ClipboardEvent, KeyboardEvent, MouseEvent } from 'react';
import { Filter, Plus, Search, X } from 'lucide-react';
import Papa from 'papaparse';
import * as XLSX from 'xlsx';

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

const EMAIL_HEADER_REGEX = /(e-?mail|email|почта|mail)/i;
const EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const HELP_TOOLTIP_OFFSET = 10;
const MAX_FILTER_OPTIONS = 1000;
const BLANK_FILTER_LABEL = '(пусто)';
const EMOJI_REGEX = /[\u{1F300}-\u{1FAFF}]/gu;
const DEFAULT_COLUMN_WIDTH = 160;
const MIN_COLUMN_WIDTH = 80;
const COMPANY_HEADER_REGEX = /(компан|company|организац)/i;

const DEFAULT_ROWS = 20;
const DEFAULT_COLS = 10;

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

const HelpTip = ({ text }: { text: string }) => (
  <span className="relative inline-flex group">
    <span className="ml-1 inline-flex h-5 w-5 items-center justify-center rounded-full border border-gray-300 text-xs font-semibold text-gray-600 cursor-help">
      ?
    </span>
    <span
      className="pointer-events-none absolute left-1/2 top-full z-30 w-64 -translate-x-1/2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-gray-700 shadow-lg opacity-0 transition group-hover:opacity-100"
      style={{ marginTop: HELP_TOOLTIP_OFFSET }}
    >
      {text}
    </span>
  </span>
);

export function DatabaseSpreadsheet() {
  const [tabs, setTabs] = useState<Sheet[]>(() => [createSheet('Вкладка 1')]);
  const [activeTabId, setActiveTabId] = useState<string>(() => tabs[0].id);
  const [tabCounter, setTabCounter] = useState(1);
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingTabName, setEditingTabName] = useState('');
  const [selectionMode, setSelectionMode] = useState<SelectionMode>('cell');
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [filterMenu, setFilterMenu] = useState<FilterMenuState | null>(null);
  const [columnFilters, setColumnFilters] = useState<Record<number, string[]>>({});
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOnlyMatches, setSearchOnlyMatches] = useState(false);
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
  const [activeCell, setActiveCell] = useState({ row: 0, col: 0 });
  const [isSelecting, setIsSelecting] = useState(false);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const selectAllRef = useRef<HTMLInputElement | null>(null);
  const confirmActionRef = useRef<(() => void) | null>(null);
  const [columnWidths, setColumnWidths] = useState<number[]>([]);
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
    setSelection({ startRow: 0, startCol: 0, endRow: 0, endCol: 0 });
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
    const startRow = isRange ? selection.startRow : rowIndex;
    setSelection({
      startRow,
      endRow: rowIndex,
      startCol: 0,
      endCol: lastCol,
    });
    setActiveCell({ row: rowIndex, col: 0 });
    setSelectionMode('row');
  };

  const handleColumnHeaderClick = (colIndex: number, isRange: boolean) => {
    const lastRow = Math.max((activeTab?.data.length ?? 0) - 1, 0);
    const startCol = isRange ? selection.startCol : colIndex;
    setSelection({
      startRow: 0,
      endRow: lastRow,
      startCol,
      endCol: colIndex,
    });
    setActiveCell({ row: 0, col: colIndex });
    setSelectionMode('col');
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
    if (event.ctrlKey || event.metaKey) {
      setSelection((prev) => ({ ...prev, endRow: row, endCol: col }));
    } else {
      setSelection({ startRow: row, startCol: col, endRow: row, endCol: col });
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
        const { [colIndex]: _, ...rest } = prev;
        return rest;
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
      const { [colIndex]: _, ...rest } = prev;
      return rest;
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

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const isCopy =
      (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c';
    if (isCopy) {
      event.preventDefault();
      void copySelection();
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLInputElement>) => {
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

  const handleUndo = () => {
    if (!lastUndo) return;
    setTabs((prev) =>
      prev.map((tab) => (tab.id === lastUndo.tabId ? { ...tab, data: lastUndo.data } : tab)),
    );
    setLastAction({ message: `Вернули: ${lastUndo.message}`, time: Date.now() });
    setLastUndo(null);
  };

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someVisibleSelected;
    }
  }, [someVisibleSelected]);

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

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Работа с базами</h1>
          <p className="text-sm text-gray-500">
            Табличный редактор с вкладками и копированием. Ctrl/Cmd+C/V.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => importInputRef.current?.click()}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
          >
            Импорт
          </button>
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
          <button
            type="button"
            onClick={handleExportCsv}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
          >
            CSV
          </button>
          <button
            type="button"
            onClick={handleExportXlsx}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
          >
            Excel
          </button>
          <div className="flex flex-col gap-1">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <input
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Поиск (слова через запятую)"
                className="w-72 rounded-lg border border-gray-200 bg-white py-2 pl-9 pr-9 text-sm text-gray-700 outline-none transition focus:border-blue-500"
              />
              {searchQuery.length > 0 && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                  aria-label="Очистить поиск"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
            <span className="text-[11px] text-gray-500">
              Ищет по всем колонкам. Можно несколько слов через запятую.
            </span>
          </div>
          <label className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-2 py-2 text-xs text-gray-600">
            <input
              type="checkbox"
              checked={searchOnlyMatches}
              onChange={(event) => setSearchOnlyMatches(event.target.checked)}
              className="h-3.5 w-3.5"
            />
            Показывать только строки с совпадением
          </label>
          {selectedRows.size > 0 && (
            <button
              type="button"
              onClick={confirmRemoveSelectedRows}
              className="inline-flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700 transition hover:bg-red-100"
            >
              Удалить выбранные ({selectedRows.size})
            </button>
          )}
        </div>
      </div>
      {importStatus.status !== 'idle' && (
        <div className="rounded-xl border border-gray-200 bg-white px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-gray-500">
            <span>
              {formatProgressLabel(importStatus)}
              {importStatus.filename ? `: ${importStatus.filename}` : ''}
            </span>
            <span>{importStatus.progress}%</span>
          </div>
          <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-gray-200">
            <div
              className={`h-full transition-all ${
                importStatus.status === 'error' ? 'bg-red-500' : 'bg-blue-600'
              }`}
              style={{ width: `${importStatus.progress}%` }}
            />
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          const isEditing = editingTabId === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTabId(tab.id)}
              className={`flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition ${
                isActive
                  ? 'bg-gray-900 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
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
                  className="w-32 rounded-full border border-gray-300 bg-white px-3 py-1 text-sm text-gray-800 outline-none focus:border-blue-500"
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
                  className={`flex h-5 w-5 items-center justify-center rounded-full text-xs ${
                    isActive ? 'bg-white/20 text-white' : 'bg-gray-300 text-gray-600'
                  }`}
                >
                  ×
                </span>
              )}
            </button>
          );
        })}
        <button
          type="button"
          onClick={handleAddTab}
          className="inline-flex items-center gap-2 rounded-full border border-dashed border-gray-300 px-4 py-2 text-sm font-medium text-gray-600 transition hover:border-gray-400 hover:text-gray-700"
        >
          <Plus className="h-4 w-4" />
          Новая вкладка
        </button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="rounded-xl border border-gray-200 bg-white">
          <div
            className="overflow-auto"
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
                  <th className="sticky left-0 z-10 border border-gray-200 bg-gray-50 px-2 py-1 text-xs font-semibold text-gray-500">
                    <div className="flex items-center gap-2">
                      <input
                        ref={selectAllRef}
                        type="checkbox"
                        checked={allVisibleSelected}
                        onChange={toggleSelectAllVisible}
                        onClick={(event) => event.stopPropagation()}
                        className="h-3.5 w-3.5"
                      />
                      <span>#</span>
                    </div>
                  </th>
                  {Array.from({ length: colCount }, (_, colIndex) => {
                    const isFiltered = columnFilters[colIndex] !== undefined;
                    return (
                      <th
                        key={`col-${colIndex}`}
                        onClick={(event) =>
                          handleColumnHeaderClick(colIndex, event.ctrlKey || event.metaKey)
                        }
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
                        className={`relative cursor-pointer border border-gray-200 bg-gray-50 px-2 py-1 text-xs font-semibold text-gray-500 transition ${
                          selectionMode === 'col' &&
                          colIndex >= normalizedSelection.startCol &&
                          colIndex <= normalizedSelection.endCol
                            ? 'bg-blue-200 text-blue-800'
                            : 'hover:bg-gray-100'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-1">
                          <span className="truncate">{toColumnLabel(colIndex)}</span>
                          <button
                            type="button"
                            onClick={(event) => openFilterMenu(event, colIndex)}
                            className="flex h-5 w-5 items-center justify-center rounded text-gray-400 hover:bg-gray-200 hover:text-gray-600"
                            aria-label="Фильтр колонки"
                          >
                            <Filter
                              className={`h-3.5 w-3.5 ${isFiltered ? 'text-blue-600' : ''}`}
                            />
                          </button>
                        </div>
                        <div
                          onMouseDown={(event) => startColumnResize(event, colIndex)}
                          className="absolute right-0 top-0 h-full w-1 cursor-col-resize"
                        />
                      </th>
                    );
                  })}
                  <th className="border border-gray-200 bg-gray-50 px-2 py-1">
                    <button
                      type="button"
                      onClick={handleAddColumn}
                      className="flex h-6 w-6 items-center justify-center rounded-md text-gray-500 transition hover:bg-gray-200 hover:text-gray-700"
                      aria-label="Добавить колонку"
                    >
                      <Plus className="h-4 w-4" />
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {activeTab?.data.map((row, rowIndex) => {
                  const isVisible = rowMatchesFilters(rowIndex, row);
                  if (!isVisible) return null;
                  const isChecked = selectedRows.has(rowIndex);
                  return (
                    <tr key={`row-${rowIndex}`}>
                      <th
                        onClick={(event) =>
                          handleRowHeaderClick(rowIndex, event.ctrlKey || event.metaKey)
                        }
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
                        className={`sticky left-0 z-10 cursor-pointer border border-gray-200 bg-gray-50 px-2 py-1 text-xs font-semibold text-gray-500 transition ${
                          selectionMode === 'row' &&
                          rowIndex >= normalizedSelection.startRow &&
                          rowIndex <= normalizedSelection.endRow
                            ? 'bg-blue-200 text-blue-800'
                            : 'hover:bg-gray-100'
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          {rowIndex > 0 && (
                            <input
                              type="checkbox"
                              checked={isChecked}
                              onChange={() => toggleRowSelection(rowIndex)}
                              onClick={(event) => event.stopPropagation()}
                              className="h-3.5 w-3.5"
                            />
                          )}
                          <span>{rowIndex + 1}</span>
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
                            className={`border border-gray-100 p-0 ${
                              isSelected
                                ? 'bg-blue-100 shadow-[inset_0_0_0_1px_rgba(59,130,246,0.6)]'
                                : cellMatchesSearch
                                  ? 'bg-amber-50'
                                  : 'bg-white'
                            }`}
                          >
                            <input
                              value={value}
                              onChange={(event) =>
                                handleValueChange(rowIndex, colIndex, event.target.value)
                              }
                              onFocus={() => handleCellFocus(rowIndex, colIndex)}
                              onKeyDown={handleKeyDown}
                              onPaste={handlePaste}
                              className={`h-9 w-full bg-transparent px-2 text-sm text-gray-800 outline-none ${
                                isActive
                                  ? 'ring-2 ring-blue-500 ring-inset'
                                  : cellMatchesSearch
                                    ? 'ring-1 ring-amber-300 ring-inset'
                                    : ''
                              }`}
                            />
                          </td>
                        );
                      })}
                      <td className="border border-gray-100 bg-gray-50" />
                    </tr>
                  );
                })}
                {rowCount > 0 && (
                  <tr>
                    <th className="sticky left-0 z-10 border border-gray-200 bg-gray-50 px-2 py-1">
                      <button
                        type="button"
                        onClick={handleAddRow}
                        className="flex h-6 w-6 items-center justify-center rounded-md text-gray-500 transition hover:bg-gray-200 hover:text-gray-700"
                        aria-label="Добавить строку"
                      >
                        <Plus className="h-4 w-4" />
                      </button>
                    </th>
                    {Array.from({ length: colCount }, (_, colIndex) => (
                      <td key={`add-row-${colIndex}`} className="border border-gray-100 bg-gray-50" />
                    ))}
                    <td className="border border-gray-100 bg-gray-50" />
                  </tr>
                )}
                {rowCount === 0 && (
                  <tr>
                    <td className="px-4 py-6 text-center text-sm text-gray-500" colSpan={colCount + 2}>
                      Таблица пуста. Добавьте строки или вкладку.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
        <aside className="rounded-xl border border-gray-200 bg-white p-4">
          <div className="flex items-center gap-2 rounded-lg bg-gray-100 p-1 text-xs">
            <button
              type="button"
              onClick={() => setRightPanelTab('summary')}
              className={`flex-1 rounded-md px-3 py-2 font-medium transition ${
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
              className={`flex-1 rounded-md px-3 py-2 font-medium transition ${
                rightPanelTab === 'cleanup'
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              Очистка
            </button>
          </div>
          {rightPanelTab === 'summary' ? (
            <div className="mt-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-gray-800">Сводка по компаниям</h3>
                {groupByCol !== null && columnFilters[groupByCol] && (
                  <button
                    type="button"
                    onClick={() => resetFilter(groupByCol)}
                    className="text-xs text-blue-600 hover:text-blue-700"
                  >
                    Сбросить фильтр
                  </button>
                )}
              </div>
              {colCount === 0 ? (
                <div className="mt-3 rounded-md border border-dashed border-gray-200 p-3 text-center text-xs text-gray-400">
                  Нет колонок для группировки
                </div>
              ) : (
                <>
                  <div className="mt-3 space-y-2">
                    <select
                      value={groupByCol ?? ''}
                      onChange={(event) => setGroupByCol(Number(event.target.value))}
                      className="w-full rounded-md border border-gray-200 px-2 py-1.5 text-xs text-gray-700"
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
                      placeholder="Поиск по компании..."
                      className="w-full rounded-md border border-gray-200 px-2 py-1.5 text-xs text-gray-700 outline-none focus:border-blue-500"
                    />
                  </div>
                  <div className="mt-3 flex items-center justify-between text-xs text-gray-500">
                    <span>Всего: {groupSummary.length}</span>
                    <span>Строк: {visibleRowIndices.length}</span>
                  </div>
                  <div className="mt-3 max-h-[360px] space-y-1 overflow-auto">
                    {filteredGroupSummary.length === 0 && (
                      <div className="rounded-md border border-dashed border-gray-200 p-3 text-center text-xs text-gray-400">
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
                          className={`flex w-full items-center justify-between rounded-md px-2 py-1 text-xs ${
                            isActive
                              ? 'bg-blue-100 text-blue-800'
                              : 'text-gray-700 hover:bg-gray-50'
                          }`}
                        >
                          <span className="truncate">{item.label}</span>
                          <span className="ml-2 text-[10px] text-gray-500">{item.count}</span>
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="mt-4 space-y-4 text-xs text-gray-600">
              {lastAction && (
                <div className="rounded-md border border-blue-100 bg-blue-50 px-3 py-2 text-[11px] text-blue-800">
                  <div className="flex items-center justify-between gap-2">
                    <span>
                      {lastAction.message} · {formatTime(lastAction.time)}
                    </span>
                    {lastUndo && (
                      <button
                        type="button"
                        onClick={handleUndo}
                        className="rounded border border-blue-200 bg-white px-2 py-1 text-[11px] font-semibold text-blue-700 hover:bg-blue-100"
                      >
                        Отменить
                      </button>
                    )}
                  </div>
                </div>
              )}
              <div>
                <div className="flex items-center gap-1 text-[11px] font-semibold uppercase text-gray-400">
                  <span>Дубликаты</span>
                  <HelpTip text="Удаление лишних строк: полные совпадения или совпадения с разными e-mail." />
                </div>
                <div className="mt-2 flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleRemoveDuplicates}
                      className="flex-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-700 transition hover:bg-gray-50"
                    >
                      Убрать дубликаты
                    </button>
                    <HelpTip text="Удаляет полностью одинаковые строки. Если строки совпадают по всем колонкам — остаётся одна." />
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleRemoveDuplicatesByEmail}
                      className="flex-1 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-medium text-blue-700 transition hover:bg-blue-100"
                    >
                      По почте
                    </button>
                    <HelpTip text="Сначала удаляет дубликаты по e-mail (оставляет строку с большим числом заполненных ячеек), затем удаляет строки, совпадающие во всём, кроме почтовых колонок." />
                  </div>
                </div>
              </div>
              <div>
                <div className="flex items-center gap-1 text-[11px] font-semibold uppercase text-gray-400">
                  <span>Нормализация</span>
                  <HelpTip text="Упрощает поиск: регистр, пробелы, эмодзи. Можно применить к данным." />
                </div>
                <div className="mt-2 flex flex-col gap-2">
                  <label className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={normalizeLowercase}
                        onChange={(event) => setNormalizeLowercase(event.target.checked)}
                        className="h-3.5 w-3.5"
                      />
                      Нижний регистр
                    </span>
                    <HelpTip text="Приводит текст к нижнему регистру (для поиска и нормализации)." />
                  </label>
                  <label className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={normalizeSpaces}
                        onChange={(event) => setNormalizeSpaces(event.target.checked)}
                        className="h-3.5 w-3.5"
                      />
                      Удалять лишние пробелы
                    </span>
                    <HelpTip text="Схлопывает повторяющиеся пробелы и удаляет пробелы по краям." />
                  </label>
                  <label className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={normalizeEmoji}
                        onChange={(event) => setNormalizeEmoji(event.target.checked)}
                        className="h-3.5 w-3.5"
                      />
                      Убирать эмодзи
                    </span>
                    <HelpTip text="Удаляет эмодзи из текста для более точного поиска." />
                  </label>
                  <button
                    type="button"
                    onClick={applyNormalizationToData}
                    className="mt-1 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-100"
                  >
                    Применить к данным
                  </button>
                  <HelpTip text="Изменяет значения ячеек навсегда. Можно отменить последним действием." />
                </div>
              </div>
            </div>
          )}
        </aside>
      </div>
      {filterMenu && (
        <div
          className="fixed z-50 w-72 rounded-lg border border-gray-200 bg-white shadow-lg"
          style={{ top: filterMenu.y, left: filterMenu.x }}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div className="border-b border-gray-100 px-3 py-2 text-xs font-semibold text-gray-500">
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
              className="w-full rounded-md border border-gray-200 px-2 py-1.5 text-xs text-gray-700 outline-none focus:border-blue-500"
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
                className="text-gray-600 hover:text-gray-800"
              >
                Сбросить
              </button>
              <button
                type="button"
                onClick={() => clearFilter(filterMenu.col)}
                className="text-gray-600 hover:text-gray-800"
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
                  className="h-3.5 w-3.5"
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
          <div className="w-full max-w-sm rounded-xl border border-gray-200 bg-white p-4 shadow-xl">
            <h4 className="text-sm font-semibold text-gray-900">{confirmState.title}</h4>
            <p className="mt-2 text-sm text-gray-600">{confirmState.message}</p>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={handleCancelConfirm}
                className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={handleConfirm}
                className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700"
              >
                {confirmState.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
      {contextMenu && (
        <div
          className="fixed z-50 w-48 rounded-lg border border-gray-200 bg-white py-1 shadow-lg"
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
            className="w-full px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
          >
            Копировать
          </button>
          <button
            type="button"
            onClick={() => {
              confirmDeleteSelection();
              setContextMenu(null);
            }}
            className="w-full px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50"
          >
            Удалить
          </button>
        </div>
      )}
    </div>
  );
}
