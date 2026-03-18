'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { buildDatabasesImportUrl, writePendingDbImport } from '@/lib/databases/pendingImport';

/* ═══════════════════════════════════════════
   TYPES
   ═══════════════════════════════════════════ */

interface DfybJob {
  id: string;
  status: string;
  current_step: number;
  current_step_name: string;
  current_step_progress: number;
  total_steps: number;
  target_count: number;
  plan?: Record<string, unknown>;
  result_stats?: { total_contacts: number; emails_found: number; avg_ta_score: number };
  personalization_prompt?: string;
  error_message?: string;
  created_at: string;
  started_at?: string;
  completed_at?: string;
}

/* ═══════════════════════════════════════════
   CONSTANTS
   ═══════════════════════════════════════════ */

const TARGET_OPTIONS = [1000, 2000, 3000, 4000, 5000];

const STEP_LABELS = [
  'Анализ брифа',
  'Парсинг',
  'Нормализация',
  'Пустые строки',
  'Дубликаты',
  'Email-ы',
  'Деdup email',
  'Сайты',
  'Обогащение',
  'Оценка ЦА',
  'Названия',
  'Персонализация',
];

/* ═══════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════ */

async function getToken(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token || '';
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/* ═══════════════════════════════════════════
   COMPONENT
   ═══════════════════════════════════════════ */

export default function DoneForYouPage() {
  const [briefMode, setBriefMode] = useState<'text' | 'pdf'>('text');
  const [brief, setBrief] = useState('');
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [pdfParsing, setPdfParsing] = useState(false);
  const [pdfFileName, setPdfFileName] = useState('');
  const [companyUrl, setCompanyUrl] = useState('');
  const [targetCount, setTargetCount] = useState(1000);
  const [persPrompt, setPersPrompt] = useState('');
  const [showPersPrompt, setShowPersPrompt] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const [activeJob, setActiveJob] = useState<DfybJob | null>(null);
  const [jobData, setJobData] = useState<string[][] | null>(null);
  const [history, setHistory] = useState<DfybJob[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /* ─── Load history ─── */

  const loadHistory = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    const res = await fetch('/api/tools/dfyb', { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return;
    const { jobs } = await res.json();
    setHistory(jobs || []);
    const running = (jobs || []).find(
      (j: DfybJob) => ['planning', 'parsing', 'processing'].includes(j.status),
    );
    if (running) setActiveJob(running);
  }, []);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  /* ─── Polling ─── */

  useEffect(() => {
    if (!activeJob || ['completed', 'failed', 'cancelled'].includes(activeJob.status)) {
      if (pollRef.current) clearInterval(pollRef.current);
      return;
    }

    async function poll() {
      const token = await getToken();
      if (!token || !activeJob) return;
      const res = await fetch(`/api/tools/dfyb/${activeJob.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const { job } = await res.json();
      setActiveJob(job);

      if (['completed', 'failed', 'cancelled'].includes(job.status)) {
        if (pollRef.current) clearInterval(pollRef.current);
        loadHistory();
        if (job.status === 'completed') loadJobData(job.id);
      }
    }

    pollRef.current = setInterval(poll, 5000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [activeJob, loadHistory]);

  /* ─── Load data ─── */

  async function loadJobData(jobId: string) {
    const token = await getToken();
    const res = await fetch(`/api/tools/dfyb/${jobId}/data`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return;
    const { data } = await res.json();
    setJobData(data || null);
  }

  /* ─── PDF upload ─── */

  async function handlePdfUpload(file: File) {
    setPdfFile(file);
    setPdfFileName(file.name);
    setPdfParsing(true);
    setError('');
    try {
      const token = await getToken();
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch('/api/brief-scoring/parse-pdf', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error || 'Ошибка при разборе PDF');
        setPdfFile(null);
        setPdfFileName('');
        return;
      }
      setBrief(json.text || '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки PDF');
      setPdfFile(null);
      setPdfFileName('');
    } finally {
      setPdfParsing(false);
    }
  }

  /* ─── Submit ─── */

  async function handleSubmit() {
    if (!brief.trim()) return;
    setSubmitting(true);
    setError('');
    try {
      const token = await getToken();
      const res = await fetch('/api/tools/dfyb', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          brief: brief.trim(),
          company_url: companyUrl.trim() || null,
          target_count: targetCount,
          personalization_prompt: persPrompt.trim() || null,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error || 'Ошибка');
        return;
      }
      setActiveJob(json.job);
      setBrief('');
      setCompanyUrl('');
      setPersPrompt('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка сети');
    } finally {
      setSubmitting(false);
    }
  }

  /* ─── Cancel ─── */

  async function handleCancel() {
    if (!activeJob) return;
    const token = await getToken();
    await fetch(`/api/tools/dfyb/${activeJob.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'cancel' }),
    });
    setActiveJob((j) => j ? { ...j, status: 'cancelled' } : null);
  }

  /* ─── Download CSV ─── */

  function downloadCSV() {
    if (!jobData) return;
    const csv = jobData.map((row) => row.map((c) => `"${(c || '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dfyb_base_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /* ─── Load to spreadsheet ─── */

  function loadToSpreadsheet() {
    if (!jobData) return;
    try {
      const raw = localStorage.getItem('database-spreadsheet-state');
      const state = raw ? JSON.parse(raw) : { tabs: [], activeTabId: null, columnWidths: {} };
      const tabId = `dfyb-${Date.now()}`;
      state.tabs = state.tabs || [];
      state.tabs.push({
        id: tabId,
        name: `DFY ${new Date().toLocaleDateString('ru-RU')}`,
        data: jobData,
      });
      state.activeTabId = tabId;
      localStorage.setItem('database-spreadsheet-state', JSON.stringify(state));
      const { id } = writePendingDbImport({
        title: `DFY ${new Date().toLocaleDateString('ru-RU')}`,
        rows: jobData,
      });
      const importUrl = buildDatabasesImportUrl(id);
      window.open(importUrl, '_blank');
    } catch (err) {
      console.error('Failed to load to spreadsheet:', err);
    }
  }

  /* ═══════════════════════════════════════════
     RENDER
     ═══════════════════════════════════════════ */

  const isRunning = activeJob && ['planning', 'parsing', 'processing'].includes(activeJob.status);
  const isComplete = activeJob?.status === 'completed';
  const isFailed = activeJob?.status === 'failed';

  const overallProgress = activeJob
    ? Math.round(((activeJob.current_step - 1 + activeJob.current_step_progress / 100) / activeJob.total_steps) * 100)
    : 0;

  return (
    <div className="min-h-screen bg-gray-50/60 px-4 py-6 sm:px-6 lg:px-8">
      <div className="max-w-[1000px] mx-auto space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-gray-900">Done For You База</h1>
          <p className="mt-1 text-sm text-gray-500">
            Загрузите бриф — AI соберет, очистит и персонализирует базу автоматически
          </p>
        </div>

        {/* ═══════════ FORM ═══════════ */}
        {!isRunning && !isComplete && (
          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-100 bg-gray-50/50">
              <h2 className="text-base font-bold text-gray-900">Новая задача</h2>
            </div>
            <div className="px-6 py-5 space-y-4">
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-sm font-semibold text-gray-700">Бриф компании</label>
                  <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-0.5">
                    <button
                      onClick={() => setBriefMode('text')}
                      className={`px-3 py-1 text-xs font-medium rounded-md transition ${
                        briefMode === 'text' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                      }`}
                    >
                      Текст
                    </button>
                    <button
                      onClick={() => setBriefMode('pdf')}
                      className={`px-3 py-1 text-xs font-medium rounded-md transition ${
                        briefMode === 'pdf' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                      }`}
                    >
                      PDF файл
                    </button>
                  </div>
                </div>

                {briefMode === 'text' ? (
                  <textarea
                    value={brief}
                    onChange={(e) => setBrief(e.target.value)}
                    rows={6}
                    placeholder="Опишите компанию, её продукт/услугу, целевую аудиторию, географию..."
                    className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl bg-gray-50 outline-none transition hover:bg-gray-100 focus:border-gray-400 focus:bg-white resize-none"
                  />
                ) : (
                  <div className="space-y-2">
                    <label
                      className={`flex flex-col items-center justify-center w-full py-6 border-2 border-dashed rounded-xl cursor-pointer transition ${
                        pdfParsing
                          ? 'border-blue-300 bg-blue-50/50'
                          : pdfFile
                            ? 'border-emerald-300 bg-emerald-50/50'
                            : 'border-gray-200 bg-gray-50 hover:bg-gray-100 hover:border-gray-300'
                      }`}
                    >
                      {pdfParsing ? (
                        <div className="text-center">
                          <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-2" />
                          <p className="text-sm text-blue-600 font-medium">Извлечение текста из PDF...</p>
                        </div>
                      ) : pdfFile ? (
                        <div className="text-center">
                          <p className="text-sm font-medium text-emerald-700">{pdfFileName}</p>
                          <p className="text-xs text-emerald-600 mt-0.5">PDF загружен. Нажмите чтобы заменить.</p>
                        </div>
                      ) : (
                        <div className="text-center">
                          <p className="text-sm font-medium text-gray-600">Нажмите или перетащите PDF файл</p>
                          <p className="text-xs text-gray-400 mt-0.5">Бриф клиента в формате PDF (макс. 20 МБ)</p>
                        </div>
                      )}
                      <input
                        type="file"
                        accept=".pdf,application/pdf"
                        className="hidden"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) void handlePdfUpload(file);
                          e.target.value = '';
                        }}
                      />
                    </label>
                    {brief && pdfFile && (
                      <details className="text-xs text-gray-500">
                        <summary className="cursor-pointer hover:text-gray-700">Извлеченный текст ({brief.length} символов)</summary>
                        <div className="mt-1 max-h-32 overflow-y-auto p-2 bg-gray-50 rounded-lg text-xs text-gray-600 whitespace-pre-wrap">
                          {brief.slice(0, 2000)}{brief.length > 2000 ? '...' : ''}
                        </div>
                      </details>
                    )}
                  </div>
                )}
              </div>

              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">
                  Сайт компании <span className="text-gray-400 font-normal">(необязательно)</span>
                </label>
                <input
                  type="text"
                  value={companyUrl}
                  onChange={(e) => setCompanyUrl(e.target.value)}
                  placeholder="https://example.com"
                  className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl bg-gray-50 outline-none transition hover:bg-gray-100 focus:border-gray-400 focus:bg-white"
                />
              </div>

              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">Количество контактов</label>
                <div className="flex gap-2">
                  {TARGET_OPTIONS.map((n) => (
                    <button
                      key={n}
                      onClick={() => setTargetCount(n)}
                      className={`px-4 py-2 text-sm font-medium rounded-lg border transition ${
                        targetCount === n
                          ? 'bg-gray-900 text-white border-gray-900'
                          : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
                      }`}
                    >
                      {(n / 1000).toFixed(0)}K
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <button
                  onClick={() => setShowPersPrompt(!showPersPrompt)}
                  className="text-sm text-blue-600 hover:text-blue-700 font-medium"
                >
                  {showPersPrompt ? 'Скрыть' : 'Настроить'} промпт персонализации
                </button>
                {showPersPrompt && (
                  <textarea
                    value={persPrompt}
                    onChange={(e) => setPersPrompt(e.target.value)}
                    rows={3}
                    placeholder="AI сгенерирует промпт автоматически из брифа. Заполните только если хотите свой вариант."
                    className="mt-2 w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl bg-gray-50 outline-none transition hover:bg-gray-100 focus:border-gray-400 focus:bg-white resize-none"
                  />
                )}
              </div>

              {error && <p className="text-sm text-red-600">{error}</p>}

              <button
                onClick={() => void handleSubmit()}
                disabled={!brief.trim() || submitting}
                className="w-full py-2.5 text-sm font-medium rounded-xl bg-gray-900 text-white shadow-sm transition hover:bg-gray-800 disabled:bg-gray-300 disabled:cursor-not-allowed"
              >
                {submitting ? 'Запуск...' : 'Запустить сборку базы'}
              </button>
            </div>
          </div>
        )}

        {/* ═══════════ PROGRESS ═══════════ */}
        {isRunning && activeJob && (
          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-100 bg-gray-50/50 flex items-center justify-between">
              <div>
                <h2 className="text-base font-bold text-gray-900">Сборка базы</h2>
                <p className="text-xs text-gray-500 mt-0.5">
                  Цель: {(activeJob.target_count / 1000).toFixed(0)}K контактов
                </p>
              </div>
              <button
                onClick={() => void handleCancel()}
                className="px-3 py-1.5 text-xs font-medium rounded-lg bg-red-50 text-red-600 hover:bg-red-100 transition"
              >
                Отменить
              </button>
            </div>
            <div className="px-6 py-5 space-y-5">
              {/* Overall progress */}
              <div>
                <div className="flex items-center justify-between text-sm mb-2">
                  <span className="font-medium text-gray-900">{activeJob.current_step_name}</span>
                  <span className="text-gray-500">{overallProgress}%</span>
                </div>
                <div className="w-full bg-gray-100 rounded-full h-2.5">
                  <div
                    className="bg-gray-900 h-2.5 rounded-full transition-all duration-500"
                    style={{ width: `${overallProgress}%` }}
                  />
                </div>
              </div>

              {/* Step indicators */}
              <div className="grid grid-cols-6 sm:grid-cols-12 gap-1.5">
                {STEP_LABELS.map((label, idx) => {
                  const stepNum = idx + 1;
                  const isActive = activeJob.current_step === stepNum;
                  const isDone = activeJob.current_step > stepNum;
                  return (
                    <div
                      key={idx}
                      className="flex flex-col items-center gap-1"
                      title={label}
                    >
                      <div
                        className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-all ${
                          isDone
                            ? 'bg-emerald-100 text-emerald-700'
                            : isActive
                              ? 'bg-gray-900 text-white ring-2 ring-gray-900/20 animate-pulse'
                              : 'bg-gray-100 text-gray-400'
                        }`}
                      >
                        {isDone ? '\u2713' : stepNum}
                      </div>
                      <span className="text-[10px] text-gray-400 text-center leading-tight hidden sm:block">
                        {label}
                      </span>
                    </div>
                  );
                })}
              </div>

              {/* Step detail */}
              <div className="bg-gray-50 rounded-xl px-4 py-3 text-sm text-gray-600">
                Шаг {activeJob.current_step}/12: {activeJob.current_step_name}
                {activeJob.current_step_progress > 0 && (
                  <span className="text-gray-400 ml-2">({activeJob.current_step_progress}%)</span>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ═══════════ FAILED ═══════════ */}
        {isFailed && activeJob && (
          <div className="bg-white rounded-2xl border border-red-200 shadow-sm overflow-hidden">
            <div className="px-6 py-4 border-b border-red-100 bg-red-50/50">
              <h2 className="text-base font-bold text-red-700">Ошибка</h2>
            </div>
            <div className="px-6 py-5 space-y-3">
              <p className="text-sm text-red-600">{activeJob.error_message || 'Неизвестная ошибка'}</p>
              <button
                onClick={() => { setActiveJob(null); setJobData(null); }}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-gray-100 text-gray-700 hover:bg-gray-200 transition"
              >
                Создать новую задачу
              </button>
            </div>
          </div>
        )}

        {/* ═══════════ RESULTS ═══════════ */}
        {isComplete && activeJob && (
          <div className="space-y-4">
            {/* Stats */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5">
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Контактов собрано</p>
                <p className="mt-2 text-2xl font-bold text-gray-900">
                  {activeJob.result_stats?.total_contacts ?? 0}
                </p>
              </div>
              <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5">
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Email найдено</p>
                <p className="mt-2 text-2xl font-bold text-emerald-600">
                  {activeJob.result_stats?.emails_found ?? 0}
                </p>
              </div>
              <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5">
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Средний балл ЦА</p>
                <p className="mt-2 text-2xl font-bold text-blue-600">
                  {activeJob.result_stats?.avg_ta_score ?? 0}
                </p>
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-3">
              <button
                onClick={downloadCSV}
                disabled={!jobData}
                className="px-4 py-2.5 text-sm font-medium rounded-xl bg-gray-900 text-white shadow-sm transition hover:bg-gray-800 disabled:bg-gray-300"
              >
                Скачать CSV
              </button>
              <button
                onClick={loadToSpreadsheet}
                disabled={!jobData}
                className="px-4 py-2.5 text-sm font-medium rounded-xl bg-blue-600 text-white shadow-sm transition hover:bg-blue-700 disabled:bg-gray-300"
              >
                Загрузить в базы
              </button>
              <button
                onClick={() => { setActiveJob(null); setJobData(null); }}
                className="px-4 py-2.5 text-sm font-medium rounded-xl bg-white text-gray-700 border border-gray-200 transition hover:bg-gray-50"
              >
                Новая задача
              </button>
            </div>

            {/* Preview table */}
            {jobData && jobData.length > 1 && (
              <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
                <div className="px-6 py-4 border-b border-gray-100 bg-gray-50/50">
                  <h3 className="text-base font-bold text-gray-900">
                    Предпросмотр <span className="text-gray-400 font-normal text-sm">(первые 20 строк)</span>
                  </h3>
                </div>
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-gray-100 text-sm">
                    <thead className="bg-gray-50/50">
                      <tr>
                        {jobData[0].map((h, i) => (
                          <th key={i} className="px-3 py-2 text-left font-semibold text-gray-500 whitespace-nowrap">
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {jobData.slice(1, 21).map((row, rIdx) => (
                        <tr key={rIdx} className="hover:bg-gray-50/50">
                          {row.map((cell, cIdx) => (
                            <td key={cIdx} className="px-3 py-2 text-gray-600 max-w-[200px] truncate" title={cell}>
                              {cell}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ═══════════ HISTORY ═══════════ */}
        {!isRunning && history.length > 0 && (
          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-100 bg-gray-50/50">
              <h3 className="text-base font-bold text-gray-900">История</h3>
            </div>
            <div className="divide-y divide-gray-50">
              {history.map((j) => (
                <div
                  key={j.id}
                  className="px-6 py-3 flex items-center justify-between cursor-pointer hover:bg-gray-50/50 transition"
                  onClick={() => {
                    setActiveJob(j);
                    if (j.status === 'completed') loadJobData(j.id);
                  }}
                >
                  <div>
                    <span className="text-sm font-medium text-gray-900">{(j.target_count / 1000).toFixed(0)}K контактов</span>
                    <span className="text-xs text-gray-400 ml-2">{formatDate(j.created_at)}</span>
                  </div>
                  <span
                    className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                      j.status === 'completed'
                        ? 'bg-emerald-50 text-emerald-700'
                        : j.status === 'failed'
                          ? 'bg-red-50 text-red-700'
                          : j.status === 'cancelled'
                            ? 'bg-gray-100 text-gray-500'
                            : 'bg-amber-50 text-amber-700'
                    }`}
                  >
                    {j.status === 'completed' ? `${j.result_stats?.total_contacts ?? 0} контактов` : j.status}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
