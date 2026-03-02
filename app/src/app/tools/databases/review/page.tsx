'use client';

import { useCallback, useEffect, useState, useRef } from 'react';
import { supabase } from '@/lib/supabaseClient';
import {
  ArrowLeft,
  CheckCircle2,
  XCircle,
  Send,
  Loader2,
  MessageSquare,
  Palette,
  X,
} from 'lucide-react';

type ReviewRequest = {
  id: string;
  owner_user_id: string;
  tab_id: string;
  tab_name: string;
  project_id: string | null;
  specialist_comment: string;
  status: string;
  reviewer_user_id: string | null;
  reviewer_comment: string;
  telegram_chat_id: number | null;
  telegram_message_id: number | null;
  created_at: string;
  updated_at: string;
  owner_name?: string;
  project_name?: string;
};

type TabData = { id: string; name: string; data: string[][] };
type RowMark = {
  id: string;
  tab_id: string;
  row_index: number;
  color: string;
  comment: string;
  author_type: string;
};

const STATUS_LABELS: Record<string, string> = {
  submitted: 'Ожидает проверки',
  needs_rework: 'На доработке',
  review_approved: 'Одобрено',
  sent_to_client: 'Отправлено клиенту',
  client_approved: 'Согласовано клиентом',
  client_requested_changes: 'Клиент запросил правки',
};

const STATUS_COLORS: Record<string, string> = {
  submitted: 'bg-yellow-100 text-yellow-800',
  needs_rework: 'bg-orange-100 text-orange-800',
  review_approved: 'bg-emerald-100 text-emerald-800',
  sent_to_client: 'bg-blue-100 text-blue-800',
  client_approved: 'bg-green-100 text-green-800',
  client_requested_changes: 'bg-red-100 text-red-800',
};

const ROW_COLORS = [
  { value: '', label: 'Без цвета', swatch: '#e5e7eb' },
  { value: '#fecaca', label: 'Красный', swatch: '#f87171' },
  { value: '#fef08a', label: 'Жёлтый', swatch: '#facc15' },
  { value: '#bbf7d0', label: 'Зелёный', swatch: '#4ade80' },
  { value: '#bfdbfe', label: 'Синий', swatch: '#60a5fa' },
  { value: '#ddd6fe', label: 'Фиолетовый', swatch: '#a78bfa' },
];

async function authHeaders() {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

export default function ReviewQueuePage() {
  const [requests, setRequests] = useState<ReviewRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tabData, setTabData] = useState<TabData | null>(null);
  const [marks, setMarks] = useState<RowMark[]>([]);
  const [tabLoading, setTabLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');
  const [toast, setToast] = useState('');
  const [deciding, setDeciding] = useState(false);
  const [decisionComment, setDecisionComment] = useState('');

  // Row editor popup
  const [activeRow, setActiveRow] = useState<number | null>(null);
  const [popupPos, setPopupPos] = useState<{ top: number; left: number } | null>(null);
  const [commentText, setCommentText] = useState('');
  const [selectedColor, setSelectedColor] = useState('');
  const [savingMark, setSavingMark] = useState(false);
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  

  const selected = requests.find((r) => r.id === selectedId) ?? null;

  const fetchRequests = useCallback(async () => {
    try {
      const h = await authHeaders();
      const url = statusFilter
        ? `/api/database-review/requests?status=${statusFilter}`
        : '/api/database-review/requests';
      const res = await fetch(url, { headers: h });
      const d = await res.json();
      setRequests(d.requests ?? []);
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => { fetchRequests(); }, [fetchRequests]);

  async function openRequest(id: string) {
    setSelectedId(id);
    setTabLoading(true);
    setActiveRow(null);
    setPopupPos(null);
    try {
      const h = await authHeaders();
      const [baseRes, marksRes] = await Promise.all([
        fetch(`/api/database-review/requests/${id}/base`, { headers: h }),
        fetch(`/api/database-review/requests/${id}/marks`, { headers: h }),
      ]);
      const baseData = await baseRes.json();
      const marksData = await marksRes.json();
      setTabData(baseData.tab ?? null);
      setMarks(marksData.marks ?? []);
    } finally {
      setTabLoading(false);
    }
  }

  async function handleDecision(decision: 'review_approved' | 'needs_rework') {
    if (!selectedId) return;
    setDeciding(true);
    try {
      const h = await authHeaders();
      const res = await fetch(`/api/database-review/requests/${selectedId}/decide`, {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ decision, comment: decisionComment }),
      });
      const d = await res.json();
      if (!res.ok) { setToast(d.error || 'Ошибка'); return; }
      setToast(decision === 'review_approved' ? 'Одобрено' : 'Отправлено на доработку');
      setDecisionComment('');
      await fetchRequests();
    } finally {
      setDeciding(false);
    }
  }

  async function handleSaveMark() {
    if (activeRow === null || !selectedId || !tabData) return;
    setSavingMark(true);
    try {
      const h = await authHeaders();
      await fetch(`/api/database-review/requests/${selectedId}/marks`, {
        method: 'POST',
        headers: h,
        body: JSON.stringify({
          tabId: tabData.id,
          rowIndex: activeRow,
          color: selectedColor,
          comment: commentText,
          authorType: 'reviewer',
        }),
      });
      closeRowEditor();
      const marksRes = await fetch(`/api/database-review/requests/${selectedId}/marks`, { headers: h });
      const marksData = await marksRes.json();
      setMarks(marksData.marks ?? []);
      setToast('Пометка сохранена');
    } finally {
      setSavingMark(false);
    }
  }

  function closeRowEditor() {
    setActiveRow(null);
    setPopupPos(null);
    setCommentText('');
    setSelectedColor('');
  }


  function openRowEditor(rowIndex: number, event: React.MouseEvent) {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const existing = marks.find((m) => m.row_index === rowIndex && m.author_type === 'reviewer');
    setActiveRow(rowIndex);
    setCommentText(existing?.comment || '');
    setSelectedColor(existing?.color || '');
    setPopupPos({
      top: rect.bottom + 4,
      left: Math.min(rect.left, window.innerWidth - 380),
    });
    setTimeout(() => commentRef.current?.focus(), 50);
  }

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (activeRow === null) return;
    function handleClickOutside(e: MouseEvent) {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) {
        closeRowEditor();
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [activeRow]);

  // ========== Queue view ==========
  if (!selectedId) {
    return (
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-5">
          <h1 className="text-lg font-semibold text-gray-900">Проверка баз</h1>
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-500">Статус:</label>
            <select
              value={statusFilter}
              onChange={(e) => { setStatusFilter(e.target.value); setLoading(true); }}
              className="border border-gray-300 rounded-lg px-2.5 py-1.5 text-xs text-gray-700 bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="">Все</option>
              {Object.entries(STATUS_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
          </div>
        ) : requests.length === 0 ? (
          <p className="text-gray-400 text-center py-16 text-sm">Нет заявок на проверку</p>
        ) : (
          <div className="space-y-2">
            {requests.map((r) => (
              <button
                key={r.id}
                onClick={() => openRequest(r.id)}
                className="w-full text-left bg-white hover:bg-gray-50 border border-gray-200 rounded-lg px-4 py-3 transition-colors shadow-sm"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-gray-900 truncate text-sm">{r.tab_name || r.tab_id}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      {r.owner_name && (
                        <span className="text-[10px] text-gray-500">👤 {r.owner_name}</span>
                      )}
                      {r.project_name && (
                        <span className="text-[10px] text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded">📁 {r.project_name}</span>
                      )}
                      {r.specialist_comment && (
                        <span className="text-[10px] text-gray-400 truncate">— {r.specialist_comment}</span>
                      )}
                    </div>
                  </div>
                  <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium whitespace-nowrap ${STATUS_COLORS[r.status] || 'bg-gray-100 text-gray-600'}`}>
                    {STATUS_LABELS[r.status] || r.status}
                  </span>
                  <span className="text-[10px] text-gray-400 whitespace-nowrap">
                    {new Date(r.created_at).toLocaleDateString('ru')}
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ========== Detail view ==========
  return (
    <div className="flex flex-col h-full relative">
      {/* Toast */}
      {toast && (
        <div className="fixed top-4 right-4 z-50 bg-white border border-emerald-200 text-sm px-4 py-2 rounded-lg flex items-center gap-2 shadow-lg text-emerald-700">
          <CheckCircle2 className="w-4 h-4" />
          {toast}
        </div>
      )}

      {/* Header */}
      <div className="border-b border-gray-200 px-4 py-2.5 flex items-center gap-3 bg-white flex-shrink-0">
        <button
          onClick={() => { setSelectedId(null); setTabData(null); setMarks([]); closeRowEditor(); }}
          className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors text-gray-500"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="font-medium text-gray-900 text-sm truncate">{selected?.tab_name || selected?.tab_id}</h2>
            {selected && (
              <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[selected.status] || ''}`}>
                {STATUS_LABELS[selected.status] || selected.status}
              </span>
            )}
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2">
          {selected?.status === 'submitted' && (
            <>
              <button
                disabled={deciding}
                onClick={() => handleDecision('needs_rework')}
                className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-orange-500 hover:bg-orange-600 text-white disabled:opacity-50 rounded-lg transition-colors"
              >
                <XCircle className="w-3.5 h-3.5" /> На доработку
              </button>
              <button
                disabled={deciding}
                onClick={() => handleDecision('review_approved')}
                className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-50 rounded-lg transition-colors"
              >
                <CheckCircle2 className="w-3.5 h-3.5" /> Одобрить
              </button>
            </>
          )}
        </div>
      </div>

      {/* Specialist comment + decision comment */}
      {(selected?.specialist_comment || selected?.status === 'submitted') && (
        <div className="border-b border-gray-100 px-4 py-2 bg-gray-50/50 flex-shrink-0">
          {selected?.specialist_comment && (
            <div className="mb-2">
              <p className="text-[10px] font-medium text-gray-400 uppercase tracking-wider mb-0.5">Комментарий специалиста</p>
              <p className="text-xs text-gray-700">{selected.specialist_comment}</p>
            </div>
          )}
          {selected?.status === 'submitted' && (
            <textarea
              value={decisionComment}
              onChange={(e) => setDecisionComment(e.target.value)}
              placeholder="Комментарий ревьюера (необязательно)…"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-xs text-gray-700 bg-white resize-none focus:outline-none focus:ring-1 focus:ring-blue-500"
              rows={2}
            />
          )}
        </div>
      )}

      {/* Table */}
      <div className="flex-1 overflow-auto">
        {tabLoading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
          </div>
        ) : !tabData ? (
          <p className="text-gray-400 text-center py-16 text-sm">Данные вкладки не найдены</p>
        ) : (
          <div className="p-3">
            <div className="border border-gray-200 rounded-lg overflow-auto bg-white">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-gray-50">
                    <th className="w-8 px-2 py-2 text-center text-[10px] text-gray-400 font-medium border-b border-gray-200">#</th>
                    {tabData.data[0]?.map((h, ci) => (
                      <th key={ci} className="px-2.5 py-2 text-left text-[10px] font-semibold text-gray-600 border-b border-gray-200 whitespace-nowrap uppercase tracking-wider">{h}</th>
                    ))}
                    <th className="w-8 px-2 py-2 border-b border-gray-200">
                      <Palette className="w-3 h-3 mx-auto text-gray-400" />
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {tabData.data.slice(1).map((row, ri) => {
                    const rowIndex = ri + 1;
                    const rowMarks = marks.filter((m) => m.row_index === rowIndex);
                    const colorMark = rowMarks.find((m) => m.color);
                    const hasComment = rowMarks.some((m) => m.comment);
                    const isActive = activeRow === rowIndex;

                    return (
                      <tr
                        key={ri}
                        className={`border-b border-gray-100 cursor-pointer transition-colors ${
                          isActive ? 'ring-1 ring-blue-400 ring-inset' : 'hover:bg-blue-50/40'
                        }`}
                        style={colorMark?.color ? { backgroundColor: colorMark.color } : undefined}
                        onClick={(e) => openRowEditor(rowIndex, e)}
                      >
                        <td className="px-2 py-1.5 text-center text-[10px] text-gray-400">{rowIndex}</td>
                        {row.map((cell, ci) => (
                          <td key={ci} className="px-2.5 py-1.5 text-gray-800 whitespace-nowrap max-w-[280px] truncate">{cell}</td>
                        ))}
                        <td className="px-2 py-1.5 text-center">
                          {hasComment && <MessageSquare className="w-3 h-3 text-blue-500 mx-auto" />}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Comments list */}
            {marks.filter((m) => m.comment).length > 0 && (
              <div className="mt-4">
                <h3 className="text-xs font-semibold text-gray-500 mb-2 uppercase tracking-wider">Комментарии</h3>
                <div className="space-y-1.5">
                  {marks.filter((m) => m.comment).map((m) => (
                    <div key={m.id} className="bg-white border border-gray-200 rounded-lg px-3 py-2 text-xs">
                      <div className="flex items-center gap-1.5 mb-0.5">
                        <span className="text-gray-400 font-medium">Строка {m.row_index}</span>
                        <span className="text-gray-300">·</span>
                        <span className="text-gray-400">
                          {m.author_type === 'client' ? 'Клиент' : m.author_type === 'reviewer' ? 'Ревьюер' : 'Специалист'}
                        </span>
                        {m.color && <span className="w-2.5 h-2.5 rounded-full inline-block border border-gray-200" style={{ backgroundColor: m.color }} />}
                      </div>
                      <p className="text-gray-700">{m.comment}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Row editor popup */}
      {activeRow !== null && popupPos && (
        <div
          ref={popupRef}
          className="fixed z-50 bg-white border border-gray-200 rounded-xl shadow-xl w-[360px] p-4"
          style={{
            top: Math.min(popupPos.top, window.innerHeight - 260),
            left: Math.max(8, Math.min(popupPos.left, window.innerWidth - 376)),
          }}
        >
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-semibold text-gray-700">Строка {activeRow}</span>
            <button onClick={closeRowEditor} className="p-0.5 rounded hover:bg-gray-100 text-gray-400">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <textarea
            ref={commentRef}
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            placeholder="Комментарий…"
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-xs text-gray-700 bg-white resize-none focus:outline-none focus:ring-1 focus:ring-blue-500 mb-3"
            rows={3}
          />
          <div className="flex items-center justify-between">
            <div className="flex gap-1">
              {ROW_COLORS.map((c) => (
                <button
                  key={c.value}
                  onClick={() => setSelectedColor(c.value)}
                  title={c.label}
                  className={`w-6 h-6 rounded-full border-2 transition-all ${
                    selectedColor === c.value ? 'border-blue-500 scale-110' : 'border-transparent hover:border-gray-300'
                  }`}
                  style={{ backgroundColor: c.swatch }}
                />
              ))}
            </div>
            <button
              disabled={savingMark || (!commentText.trim() && !selectedColor)}
              onClick={handleSaveMark}
              className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-white transition-colors"
            >
              {savingMark ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
              Сохранить
            </button>
          </div>
        </div>
      )}

    </div>
  );
}
