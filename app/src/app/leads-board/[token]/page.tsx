'use client';

import { useCallback, useEffect, useState, useRef, use } from 'react';
import {
  columnLabel, isBuiltinColumnKey, makeCustomColumnKey, type BoardColumn,
} from '@/lib/leadBoard/columnConfig';

type BoardRow = {
  id: string;
  lead_email: string | null;
  lead_name: string | null;
  company_name: string | null;
  phone: string | null;
  website: string | null;
  request_text: string | null;
  campaign_name: string | null;
  step_number: number | null;
  reply_timestamp: string | null;
  quality: string | null;
  comment: string | null;
  taken: boolean;
  custom: Record<string, string> | null;
};

type BoardData = {
  project: { name: string | null; client: string | null };
  columnConfig: BoardColumn[];
  qualities: string[];
  rows: BoardRow[];
  stats: {
    total: number;
    last7d: number;
    byQuality: Record<string, number>;
    byCampaign: Record<string, number>;
  };
};

/**
 * Статус «Качество лида» в словаре системы (DESIGN.md): цвет — это данные,
 * поэтому статус = 6px точка + короткий mono-тег, без цветных фонов и пилюль.
 * 11 статусов спецов маппятся на 4 семантических цвета.
 */
const QUALITY_SEMANTIC: Record<string, 'go' | 'active' | 'attention' | 'quiet'> = {
  'ответил': 'go',
  'есть интерес': 'go',
  'назначили звонок': 'go',
  'обсуждаем сотрудничество': 'go',
  'оплатил услугу/товар': 'go',
  'уже в работе': 'go',
  'просит связаться позже': 'active',
  'не заинтересован': 'attention',
  'отказался': 'attention',
  'лид не релевантный': 'attention',
  'не отвечает': 'quiet',
};

const SEMANTIC_COLOR: Record<string, string> = {
  go: 'var(--cp-green)',
  active: 'var(--cp-amber)',
  attention: 'var(--cp-red)',
  quiet: 'var(--cp-grey)',
};

function qualityColor(quality: string | null): string {
  return SEMANTIC_COLOR[QUALITY_SEMANTIC[quality ?? ''] ?? 'quiet'];
}

function formatDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.${d.getFullYear()}`;
}

const CELL_INPUT =
  'w-full min-w-[6rem] bg-transparent border-b border-transparent hover:border-[var(--cp-divider-strong)] focus:border-[var(--cp-paper)] outline-none text-[13px] text-[var(--cp-paper-mute)] focus:text-[var(--cp-paper)] py-0.5 placeholder:text-[var(--cp-paper-faint)] disabled:opacity-50 transition-colors';
const CELL_INPUT_MONO = `${CELL_INPUT} ds-mono text-[12px]`;

/** Редактируемая текстовая ячейка: сохранение на blur/Enter, key у родителя. */
function TextCell({
  value, placeholder, disabled, onSave, className,
}: {
  value: string;
  placeholder?: string;
  disabled?: boolean;
  onSave: (v: string | null) => void;
  className?: string;
}) {
  return (
    <input
      type="text"
      defaultValue={value}
      disabled={disabled}
      placeholder={placeholder}
      onBlur={(e) => {
        const v = e.target.value.trim();
        if (v !== value) onSave(v || null);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
      className={className ?? CELL_INPUT}
    />
  );
}

const GHOST_LINK = 'text-[12px] text-[var(--cp-paper-faint)] hover:text-[var(--cp-paper)] transition-colors';

function RequestCell({ text, onSave }: { text: string | null; onSave: (v: string | null) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <textarea
        autoFocus
        defaultValue={text ?? ''}
        rows={6}
        onBlur={(e) => {
          setEditing(false);
          const v = e.target.value.trim();
          if (v !== (text ?? '')) onSave(v || null);
        }}
        className="ds-input w-full max-w-md text-[13px] leading-relaxed"
      />
    );
  }
  return (
    <div className="max-w-2xl">
      {text ? (
        <div className={`whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--cp-paper-mute)] ${expanded ? '' : 'line-clamp-4'}`}>
          {text}
        </div>
      ) : (
        <span className="text-[var(--cp-paper-faint)]">—</span>
      )}
      <div className="mt-1 flex items-center gap-3">
        {text && text.length > 220 && (
          <button onClick={() => setExpanded((v) => !v)} className={GHOST_LINK}>
            {expanded ? 'Свернуть' : 'Развернуть'}
          </button>
        )}
        <button onClick={() => setEditing(true)} className={GHOST_LINK}>
          Править
        </button>
      </div>
    </div>
  );
}

export default function LeadBoardPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [data, setData] = useState<BoardData | null>(null);
  const [rows, setRows] = useState<BoardRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [savingId, setSavingId] = useState<string | null>(null);
  const [toast, setToast] = useState('');
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{
    imported: number;
    skipped: { index: number; reason: string }[];
    warnings: string[];
    ignoredColumns: string[];
  } | null>(null);
  const [showColPanel, setShowColPanel] = useState(false);
  const [newColLabel, setNewColLabel] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const apiBase = `/api/lead-board/${encodeURIComponent(token)}`;

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(apiBase);
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d.error || `Ошибка ${res.status}`);
        return;
      }
      const d = (await res.json()) as BoardData;
      setData(d);
      setRows(d.rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setLoading(false);
    }
  }, [apiBase]);

  useEffect(() => { fetchData(); }, [fetchData]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  async function patchRow(rowId: string, patch: Record<string, unknown>) {
    setRows((cur) => cur.map((r) => (r.id === rowId ? { ...r, ...patch } : r)));
    setSavingId(rowId);
    try {
      const res = await fetch(apiBase, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rowId, ...patch }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `Ошибка ${res.status}`);
      }
      setToast('Сохранено');
    } catch (err) {
      // Откат через refetch, а не снапшот state: при параллельных патчах разных
      // строк снапшотный откат затирал бы чужое успешное изменение.
      await fetchData();
      setToast(err instanceof Error ? err.message : 'Ошибка сохранения');
    } finally {
      setSavingId(null);
    }
  }

  function saveCustomCell(row: BoardRow, key: string, v: string | null) {
    // Сервер мержит custom по ключам: null = удалить ключ.
    patchRow(row.id, { custom: { [key]: v } });
  }

  async function addRow() {
    try {
      const res = await fetch(apiBase, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `Ошибка ${res.status}`);
      }
      await fetchData();
      setToast('Строка добавлена, заполните ячейки');
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Ошибка');
    }
  }

  async function deleteRow(rowId: string) {
    if (!window.confirm('Удалить строку? Действие необратимо.')) return;
    setRows((cur) => cur.filter((r) => r.id !== rowId));
    try {
      const res = await fetch(apiBase, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rowId }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `Ошибка ${res.status}`);
      }
      setToast('Строка удалена');
    } catch (err) {
      await fetchData();
      setToast(err instanceof Error ? err.message : 'Ошибка удаления');
    }
  }

  async function saveConfig(next: BoardColumn[]) {
    setData((cur) => (cur ? { ...cur, columnConfig: next } : cur));
    try {
      const res = await fetch(`${apiBase}/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columnConfig: next }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || `Ошибка ${res.status}`);
      setData((cur) => (cur ? { ...cur, columnConfig: d.columnConfig } : cur));
      setToast('Колонки сохранены');
    } catch (err) {
      await fetchData(); // откат
      setToast(err instanceof Error ? err.message : 'Ошибка сохранения колонок');
    }
  }

  function toggleColumn(key: string) {
    if (!data) return;
    void saveConfig(data.columnConfig.map((c) => (c.key === key ? { ...c, visible: !c.visible } : c)));
  }

  function renameColumn(key: string, label: string) {
    if (!data || !label.trim()) return;
    void saveConfig(data.columnConfig.map((c) => (c.key === key ? { ...c, label: label.trim() } : c)));
  }

  function deleteColumn(key: string) {
    if (!data) return;
    if (!window.confirm('Удалить колонку? Значения в строках сохранятся, но отображаться перестанут.')) return;
    void saveConfig(data.columnConfig.filter((c) => c.key !== key));
  }

  function addColumn() {
    if (!data || !newColLabel.trim()) return;
    const existing = new Set(data.columnConfig.map((c) => c.key));
    const key = makeCustomColumnKey(newColLabel.trim(), existing);
    void saveConfig([
      ...data.columnConfig,
      { key, label: newColLabel.trim(), visible: true, custom: true },
    ]);
    setNewColLabel('');
  }

  async function handleImportFile(file: File) {
    setImporting(true);
    setImportResult(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(`${apiBase}/import`, { method: 'POST', body: form });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || `Ошибка ${res.status}`);
      setImportResult(d);
      await fetchData(); // показать новые строки
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Ошибка импорта');
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = ''; // повторный выбор того же файла
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-[13px] text-[var(--cp-paper-faint)]">Загрузка…</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen gap-2 px-4">
        <p className="text-[15px] text-[var(--cp-red)]">{error || 'Данные не найдены'}</p>
        <p className="text-[13px] text-[var(--cp-paper-faint)] text-center">
          Проверьте ссылку или попросите специалиста прислать новую.
        </p>
      </div>
    );
  }

  const visibleColumns = data.columnConfig.filter(
    (c) => c.visible && (isBuiltinColumnKey(c.key) || c.custom),
  );
  const projectTitle = data.project.name || 'Проект';

  return (
    <div className="min-h-screen">
      <header className="border-b border-[var(--cp-divider)] px-4 md:px-6 py-5">
        <div>
          <div className="ds-mono text-[11px] tracking-[0.02em] text-[var(--cp-paper-faint)]">
            Гостевая таблица{data.project.client ? ` · ${data.project.client}` : ''}
          </div>
          <h1 className="mt-1.5 text-[1.375rem] leading-tight font-semibold tracking-[-0.015em] text-[var(--cp-paper)]">
            {projectTitle}
          </h1>
          <p className="mt-1 text-[13px] text-[var(--cp-paper-mute)]">
            Новые лиды появляются автоматически, правки сохраняются сразу.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.tsv,.txt,.xlsx,.xls"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleImportFile(f);
              }}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={importing}
              className="ds-btn-secondary"
            >
              {importing ? 'Импортирую…' : 'Импорт CSV/Excel'}
            </button>
            <button onClick={() => void addRow()} className="ds-btn-secondary">
              Строка
            </button>
            <button onClick={() => setShowColPanel((v) => !v)} className="ds-btn-ghost">
              Колонки
            </button>
          </div>
          {showColPanel && (
            <div className="mt-3 rounded-lg bg-[var(--cp-surface-rest)] p-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-2">
                {data.columnConfig.map((c) => (
                  <div key={c.key} className="flex items-center gap-2 min-w-0">
                    <input
                      type="checkbox"
                      checked={c.visible}
                      onChange={() => toggleColumn(c.key)}
                      className="accent-[#fafafa] cursor-pointer shrink-0"
                    />
                    {c.custom ? (
                      <>
                        <input
                          key={`${c.key}:${columnLabel(c)}`}
                          type="text"
                          defaultValue={columnLabel(c)}
                          onBlur={(e) => {
                            const v = e.target.value.trim();
                            if (v && v !== columnLabel(c)) renameColumn(c.key, v);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                          }}
                          className={CELL_INPUT}
                        />
                        <button onClick={() => deleteColumn(c.key)} className={GHOST_LINK}>
                          Удалить
                        </button>
                      </>
                    ) : (
                      <span className="text-[13px] text-[var(--cp-paper-mute)]">{columnLabel(c)}</span>
                    )}
                  </div>
                ))}
              </div>
              <div className="mt-3 flex items-center gap-2 border-t border-[var(--cp-divider)] pt-3">
                <input
                  type="text"
                  value={newColLabel}
                  onChange={(e) => setNewColLabel(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') addColumn(); }}
                  placeholder="Новая колонка (напр. ИНН)"
                  className="ds-input w-56"
                />
                <button
                  onClick={addColumn}
                  disabled={!newColLabel.trim()}
                  className="ds-btn-secondary"
                >
                  Добавить
                </button>
              </div>
            </div>
          )}
        </div>
      </header>

      {importResult && (
        <div className="w-full px-3 md:px-6 mt-4">
          <div className="rounded-lg bg-[var(--cp-surface-rest)] px-4 py-3 text-[13px] text-[var(--cp-paper-mute)]">
            <div className="flex items-start justify-between gap-3">
              <span>
                Импортировано: <span className="text-[var(--cp-paper)] font-medium">{importResult.imported}</span>
                {importResult.skipped.length > 0 && <> · пропущено: {importResult.skipped.length}</>}
                {importResult.ignoredColumns.length > 0 && (
                  <> · колонки проигнорированы: {importResult.ignoredColumns.join(', ')}</>
                )}
              </span>
              <button onClick={() => setImportResult(null)} className={GHOST_LINK}>
                Скрыть
              </button>
            </div>
            {importResult.skipped.length > 0 && (
              <ul className="mt-2 max-h-24 overflow-auto text-[12px] text-[var(--cp-paper-faint)]">
                {importResult.skipped.slice(0, 20).map((s, i) => (
                  <li key={i}>строка {s.index}: {s.reason}</li>
                ))}
                {importResult.skipped.length > 20 && <li>…и ещё {importResult.skipped.length - 20}</li>}
              </ul>
            )}
            {importResult.warnings.length > 0 && (
              <ul className="mt-2 max-h-24 overflow-auto text-[12px] text-[var(--cp-amber)]">
                {importResult.warnings.slice(0, 20).map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-5 right-5 z-50 rounded-md border border-[var(--cp-divider)] bg-[var(--cp-surface-elev)] px-3.5 py-2 text-[13px] text-[var(--cp-paper)]">
          {toast}
        </div>
      )}

      <main className="px-3 md:px-6 py-5">
        <div>
          {rows.length === 0 ? (
            <div className="rounded-lg bg-[var(--cp-surface-rest)] px-5 py-10 text-center">
              <p className="text-[13px] text-[var(--cp-paper-mute)]">
                Лидов пока нет. Они появятся здесь автоматически, как только придут.
              </p>
              <p className="mt-1 text-[12px] text-[var(--cp-paper-faint)]">
                Можно добавить строку вручную или импортировать файл из Google Sheets.
              </p>
            </div>
          ) : (
            <>
              <style>{`
                /* Липкая первая колонка при горизонтальном скролле карточки:
                   идентификатор строки не уезжает за край. */
                .lb-table td:first-child, .lb-table th:first-child {
                  position: sticky;
                  left: 0;
                  z-index: 10;
                  background: var(--cp-surface-rest);
                  min-width: 130px;
                }
                .lb-table thead th:first-child { z-index: 20; }
                .lb-table tbody tr:hover td:first-child { background: var(--cp-surface-elev); }
                /* Тонкий скроллбар карточки, чтобы было видно, что есть куда листать */
                .lb-scroll::-webkit-scrollbar { height: 8px; }
                .lb-scroll::-webkit-scrollbar-thumb { background: var(--cp-divider-strong); border-radius: 4px; }
                .lb-scroll::-webkit-scrollbar-track { background: transparent; }
              `}</style>
            <div className="lb-scroll rounded-lg bg-[var(--cp-surface-rest)] overflow-x-auto">
              <table className="lb-table w-full text-[13px]">
                <thead>
                  <tr>
                    {visibleColumns.map((c) => (
                      <th
                        key={c.key}
                        className="ds-mono px-3 py-2.5 text-left text-[11px] font-medium tracking-[0.02em] text-[var(--cp-paper-faint)] whitespace-nowrap"
                      >
                        {columnLabel(c)}
                      </th>
                    ))}
                    <th className="w-16" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const saving = savingId === row.id;
                    return (
                      <tr
                        key={row.id}
                        className="border-t border-[var(--cp-divider)] first:border-t-0 align-top hover:bg-[var(--cp-surface-elev)] transition-colors"
                      >
                        {visibleColumns.map((c) => {
                          switch (c.key) {
                            case 'phone':
                              return (
                                <td key={c.key} className="px-3 py-2.5">
                                  <TextCell
                                    key={`${row.id}:${row.phone ?? ''}`}
                                    value={row.phone ?? ''}
                                    disabled={saving}
                                    placeholder="Телефон"
                                    className={CELL_INPUT_MONO}
                                    onSave={(v) => void patchRow(row.id, { phone: v })}
                                  />
                                </td>
                              );
                            case 'email':
                              return (
                                <td key={c.key} className="px-3 py-2.5">
                                  <TextCell
                                    key={`${row.id}:${row.lead_email ?? ''}`}
                                    value={row.lead_email ?? ''}
                                    disabled={saving}
                                    placeholder="email"
                                    className={CELL_INPUT_MONO}
                                    onSave={(v) => void patchRow(row.id, { lead_email: v })}
                                  />
                                </td>
                              );
                            case 'name':
                              return (
                                <td key={c.key} className="px-3 py-2.5">
                                  <TextCell
                                    key={`${row.id}:${row.lead_name ?? ''}`}
                                    value={row.lead_name ?? ''}
                                    disabled={saving}
                                    placeholder="Имя"
                                    onSave={(v) => void patchRow(row.id, { lead_name: v })}
                                  />
                                </td>
                              );
                            case 'company':
                              return (
                                <td key={c.key} className="px-3 py-2.5">
                                  <TextCell
                                    key={`${row.id}:${row.company_name ?? ''}`}
                                    value={row.company_name ?? ''}
                                    disabled={saving}
                                    placeholder="Организация"
                                    onSave={(v) => void patchRow(row.id, { company_name: v })}
                                  />
                                </td>
                              );
                            case 'website':
                              return (
                                <td key={c.key} className="px-3 py-2.5">
                                  <TextCell
                                    key={`${row.id}:${row.website ?? ''}`}
                                    value={row.website ?? ''}
                                    disabled={saving}
                                    placeholder="site.ru"
                                    className={CELL_INPUT_MONO}
                                    onSave={(v) => void patchRow(row.id, { website: v })}
                                  />
                                </td>
                              );
                            case 'request':
                              return (
                                <td key={c.key} className="px-3 py-2.5">
                                  <RequestCell
                                    key={`${row.id}:${(row.request_text ?? '').length}`}
                                    text={row.request_text}
                                    onSave={(v) => void patchRow(row.id, { request_text: v })}
                                  />
                                </td>
                              );
                            case 'quality':
                              return (
                                <td key={c.key} className="px-3 py-2.5">
                                  <span className="inline-flex items-center gap-2">
                                    <span
                                      className="w-1.5 h-1.5 rounded-full shrink-0"
                                      style={{ background: qualityColor(row.quality) }}
                                    />
                                    <select
                                      value={row.quality ?? ''}
                                      disabled={saving}
                                      onChange={(e) => patchRow(row.id, { quality: e.target.value || null })}
                                      className="ds-mono uppercase text-[11px] tracking-[0.02em] bg-transparent outline-none cursor-pointer disabled:opacity-50"
                                      style={{ color: qualityColor(row.quality) }}
                                    >
                                      <option value="">—</option>
                                      {data.qualities.map((q) => (
                                        <option key={q} value={q}>{q}</option>
                                      ))}
                                    </select>
                                  </span>
                                </td>
                              );
                            case 'comment':
                              return (
                                <td key={c.key} className="px-3 py-2.5">
                                  <TextCell
                                    key={`${row.id}:${row.comment ?? ''}`}
                                    value={row.comment ?? ''}
                                    disabled={saving}
                                    placeholder="Комментарий…"
                                    onSave={(v) => void patchRow(row.id, { comment: v })}
                                  />
                                </td>
                              );
                            case 'campaign':
                              return (
                                <td key={c.key} className="px-3 py-2.5">
                                  <TextCell
                                    key={`${row.id}:${row.campaign_name ?? ''}`}
                                    value={row.campaign_name ?? ''}
                                    disabled={saving}
                                    placeholder="Кампания"
                                    onSave={(v) => void patchRow(row.id, { campaign_name: v })}
                                  />
                                </td>
                              );
                            case 'step':
                              return (
                                <td key={c.key} className="px-3 py-2.5 text-center">
                                  <TextCell
                                    key={`${row.id}:${row.step_number ?? ''}`}
                                    value={row.step_number?.toString() ?? ''}
                                    disabled={saving}
                                    placeholder="—"
                                    className={`${CELL_INPUT_MONO} w-10 text-center`}
                                    onSave={(v) => {
                                      if (v === null) return void patchRow(row.id, { step_number: null });
                                      if (!/^\d{1,2}$/.test(v)) return setToast('Шаг — число 1..99');
                                      void patchRow(row.id, { step_number: Number.parseInt(v, 10) });
                                    }}
                                  />
                                </td>
                              );
                            case 'date':
                              return (
                                <td key={c.key} className="px-3 py-2.5">
                                  <TextCell
                                    key={`${row.id}:${row.reply_timestamp ?? ''}`}
                                    value={formatDate(row.reply_timestamp)}
                                    disabled={saving}
                                    placeholder="дд.мм.гггг"
                                    className={`${CELL_INPUT_MONO} w-24`}
                                    onSave={(v) => void patchRow(row.id, { reply_timestamp: v })}
                                  />
                                </td>
                              );
                            case 'taken':
                              return (
                                <td key={c.key} className="px-3 py-2.5 text-center">
                                  <input
                                    type="checkbox"
                                    checked={row.taken}
                                    disabled={saving}
                                    onChange={(e) => patchRow(row.id, { taken: e.target.checked })}
                                    className="w-4 h-4 accent-[#fafafa] cursor-pointer disabled:opacity-50"
                                  />
                                </td>
                              );
                            default:
                              // Кастомная колонка: значение в row.custom[key]
                              return (
                                <td key={c.key} className="px-3 py-2.5">
                                  <TextCell
                                    key={`${row.id}:${c.key}:${row.custom?.[c.key] ?? ''}`}
                                    value={row.custom?.[c.key] ?? ''}
                                    disabled={saving}
                                    placeholder={columnLabel(c)}
                                    onSave={(v) => saveCustomCell(row, c.key, v)}
                                  />
                                </td>
                              );
                          }
                        })}
                        <td className="px-3 py-2.5 text-right">
                          <button
                            onClick={() => void deleteRow(row.id)}
                            disabled={saving}
                            className="ds-mono uppercase text-[11px] tracking-[0.02em] text-[var(--cp-paper-faint)] hover:text-[var(--cp-red)] transition-colors disabled:opacity-40"
                          >
                            Удалить
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
