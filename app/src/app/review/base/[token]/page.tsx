'use client';

import { useCallback, useEffect, useState, useRef, use } from 'react';
import { MessageSquare, Palette, Send, Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';

type RowMark = {
  id: string;
  tab_id: string;
  row_index: number;
  color: string;
  comment: string;
  author_type: string;
  created_at: string;
};

type TabData = {
  id: string;
  name: string;
  data: string[][];
};

type ReviewInfo = {
  id: string;
  tabId: string;
  tabName: string;
  status: string;
};

const ROW_COLORS = [
  { value: '', label: 'Без цвета', bg: '' },
  { value: '#fecaca', label: 'Красный', bg: 'bg-red-200' },
  { value: '#fef08a', label: 'Жёлтый', bg: 'bg-yellow-200' },
  { value: '#bbf7d0', label: 'Зелёный', bg: 'bg-green-200' },
  { value: '#bfdbfe', label: 'Синий', bg: 'bg-blue-200' },
  { value: '#ddd6fe', label: 'Фиолетовый', bg: 'bg-purple-200' },
];

const STATUS_LABELS: Record<string, string> = {
  submitted: 'На проверке',
  needs_rework: 'На доработке',
  review_approved: 'Одобрено ревьюером',
  sent_to_client: 'Отправлено на согласование',
  client_approved: 'Согласовано',
  client_requested_changes: 'Запрошены правки',
};

export default function GuestReviewPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [reviewInfo, setReviewInfo] = useState<ReviewInfo | null>(null);
  const [tabData, setTabData] = useState<TabData | null>(null);
  const [marks, setMarks] = useState<RowMark[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeRow, setActiveRow] = useState<number | null>(null);
  const [commentText, setCommentText] = useState('');
  const [selectedColor, setSelectedColor] = useState('');
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState('');
  const commentRef = useRef<HTMLTextAreaElement>(null);

  const apiBase = `/api/database-review/guest/${encodeURIComponent(token)}`;

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(apiBase);
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d.error || `Ошибка ${res.status}`);
        return;
      }
      const d = await res.json();
      setReviewInfo(d.request);
      setTabData(d.tab);
      setMarks(d.marks ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setLoading(false);
    }
  }, [apiBase]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const canEdit = reviewInfo?.status === 'client_requested_changes' || reviewInfo?.status === 'sent_to_client';

  function getRowMark(rowIndex: number) {
    return marks.filter((m) => m.row_index === rowIndex);
  }

  function getRowColor(rowIndex: number): string {
    const rowMarks = getRowMark(rowIndex);
    const colorMark = rowMarks.find((m) => m.color);
    return colorMark?.color || '';
  }

  async function handleSaveMark(rowIndex: number) {
    if (!tabData || !canEdit) return;
    setSaving(true);
    try {
      const res = await fetch(apiBase, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tabId: tabData.id,
          rowIndex,
          color: selectedColor,
          comment: commentText,
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setToast(d.error || 'Ошибка сохранения');
        return;
      }
      setToast('Сохранено');
      setActiveRow(null);
      setCommentText('');
      setSelectedColor('');
      await fetchData();
    } catch {
      setToast('Ошибка сети');
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  function openRowEditor(rowIndex: number) {
    if (!canEdit) return;
    const existing = marks.find((m) => m.row_index === rowIndex && m.author_type === 'client');
    setActiveRow(rowIndex);
    setCommentText(existing?.comment || '');
    setSelectedColor(existing?.color || '');
    setTimeout(() => commentRef.current?.focus(), 50);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="w-8 h-8 animate-spin text-zinc-400" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen gap-3 px-4">
        <AlertCircle className="w-12 h-12 text-red-400" />
        <p className="text-lg text-red-400 text-center">{error}</p>
      </div>
    );
  }

  if (!tabData) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen gap-3 px-4">
        <AlertCircle className="w-12 h-12 text-zinc-500" />
        <p className="text-zinc-400">Данные базы не найдены</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-screen">
      {/* Header */}
      <header className="sticky top-0 z-30 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur px-4 py-3">
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold">{reviewInfo?.tabName || 'База'}</h1>
            <p className="text-sm text-zinc-400">
              Статус: {STATUS_LABELS[reviewInfo?.status ?? ''] || reviewInfo?.status}
            </p>
          </div>
          {canEdit && (
            <p className="text-xs text-emerald-400 flex items-center gap-1">
              <MessageSquare className="w-3.5 h-3.5" />
              Нажмите на строку для комментария
            </p>
          )}
        </div>
      </header>

      {/* Toast */}
      {toast && (
        <div className="fixed top-4 right-4 z-50 bg-zinc-800 border border-zinc-700 text-sm px-4 py-2 rounded-lg flex items-center gap-2 shadow-lg">
          <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          {toast}
        </div>
      )}

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <div className="max-w-7xl mx-auto p-4">
          <div className="border border-zinc-800 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-zinc-900">
                  <th className="w-10 px-2 py-2 text-center text-xs text-zinc-500 font-medium border-b border-zinc-800">#</th>
                  {tabData.data[0]?.map((header, ci) => (
                    <th
                      key={ci}
                      className="px-3 py-2 text-left text-xs font-medium text-zinc-300 border-b border-zinc-800 whitespace-nowrap"
                    >
                      {header}
                    </th>
                  ))}
                  {canEdit && (
                    <th className="w-10 px-2 py-2 text-center text-xs text-zinc-500 font-medium border-b border-zinc-800">
                      <Palette className="w-3.5 h-3.5 mx-auto" />
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {tabData.data.slice(1).map((row, ri) => {
                  const rowIndex = ri + 1;
                  const rowColor = getRowColor(rowIndex);
                  const rowComments = getRowMark(rowIndex).filter((m) => m.comment);
                  const isActive = activeRow === rowIndex;

                  return (
                    <tr
                      key={ri}
                      className={`border-b border-zinc-800/50 transition-colors ${
                        canEdit ? 'cursor-pointer hover:bg-zinc-800/60' : ''
                      } ${isActive ? 'ring-1 ring-blue-500/50' : ''}`}
                      style={rowColor ? { backgroundColor: rowColor + '20' } : undefined}
                      onClick={() => openRowEditor(rowIndex)}
                    >
                      <td className="px-2 py-1.5 text-center text-xs text-zinc-600">{rowIndex}</td>
                      {row.map((cell, ci) => (
                        <td key={ci} className="px-3 py-1.5 text-zinc-200 whitespace-nowrap max-w-[300px] truncate">
                          {cell}
                        </td>
                      ))}
                      {canEdit && (
                        <td className="px-2 py-1.5 text-center">
                          {rowComments.length > 0 && (
                            <MessageSquare className="w-3.5 h-3.5 text-blue-400 mx-auto" />
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Existing comments display */}
          {marks.filter((m) => m.comment).length > 0 && (
            <div className="mt-6">
              <h3 className="text-sm font-medium text-zinc-400 mb-3">Комментарии</h3>
              <div className="space-y-2">
                {marks
                  .filter((m) => m.comment)
                  .map((m) => (
                    <div key={m.id} className="bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-3 text-sm">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-zinc-500">Строка {m.row_index}</span>
                        <span className="text-zinc-700">·</span>
                        <span className="text-zinc-500 text-xs">
                          {m.author_type === 'client' ? 'Клиент' : m.author_type === 'reviewer' ? 'Ревьюер' : 'Специалист'}
                        </span>
                        {m.color && (
                          <span className="w-3 h-3 rounded-full inline-block border border-zinc-700" style={{ backgroundColor: m.color }} />
                        )}
                      </div>
                      <p className="text-zinc-300">{m.comment}</p>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Bottom row editor panel */}
      {activeRow !== null && canEdit && (
        <div className="sticky bottom-0 z-30 border-t border-zinc-800 bg-zinc-900/95 backdrop-blur px-4 py-4">
          <div className="max-w-7xl mx-auto">
            <div className="flex items-start gap-4">
              <div className="flex-1">
                <label className="text-xs text-zinc-500 mb-1 block">
                  Комментарий к строке {activeRow}
                </label>
                <textarea
                  ref={commentRef}
                  value={commentText}
                  onChange={(e) => setCommentText(e.target.value)}
                  placeholder="Опишите, что нужно исправить…"
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white resize-none focus:outline-none focus:ring-1 focus:ring-blue-500"
                  rows={2}
                />
              </div>
              <div>
                <label className="text-xs text-zinc-500 mb-1 block">Цвет</label>
                <div className="flex gap-1">
                  {ROW_COLORS.map((c) => (
                    <button
                      key={c.value}
                      onClick={() => setSelectedColor(c.value)}
                      title={c.label}
                      className={`w-7 h-7 rounded border transition-all ${
                        selectedColor === c.value
                          ? 'ring-2 ring-blue-500 border-blue-500'
                          : 'border-zinc-700 hover:border-zinc-500'
                      }`}
                      style={c.value ? { backgroundColor: c.value } : { backgroundColor: '#27272a' }}
                    />
                  ))}
                </div>
              </div>
              <div className="flex gap-2 pt-5">
                <button
                  onClick={() => { setActiveRow(null); setCommentText(''); setSelectedColor(''); }}
                  className="px-3 py-2 text-sm text-zinc-400 hover:text-white transition-colors"
                >
                  Отмена
                </button>
                <button
                  disabled={saving || (!commentText.trim() && !selectedColor)}
                  onClick={() => handleSaveMark(activeRow)}
                  className="flex items-center gap-1.5 px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg text-white transition-colors"
                >
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                  Отправить
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
