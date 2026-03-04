'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import type { YandexMapsJob, YandexMapsLinkRow, YandexMapsOrganizationRow } from '@/types/parsers';
import { YandexMapsParserForm } from '@/components/parsers/YandexMapsParserForm';
import { JobStatus, isStoppedByUser } from '@/components/parsers/JobStatus';
import { normalizeYandexOrgUrls } from '@/lib/parsers/yandexMapsUrlUtils';
import { Download, RefreshCw, FileSpreadsheet, Database } from 'lucide-react';
import * as XLSX from 'xlsx';
import { saveAs } from 'file-saver';
import { buildDatabasesImportUrl, writePendingDbImport } from '@/lib/databases/pendingImport';

function formatDate(dateStr: string) {
  try {
    return new Date(dateStr).toLocaleString('ru-RU', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return dateStr;
  }
}

function useTimedFlag(durationMs: number) {
  const [flag, setFlag] = useState(false);
  const timerRef = useRef<number | null>(null);
  const trigger = useCallback(() => {
    setFlag(true);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      setFlag(false);
      timerRef.current = null;
    }, durationMs);
  }, [durationMs]);
  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);
  return { flag, trigger };
}

export function YandexMapsParserView() {
  const [jobs, setJobs] = useState<YandexMapsJob[]>([]);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [linksText, setLinksText] = useState('');
  const [results, setResults] = useState<YandexMapsOrganizationRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [jobActionId, setJobActionId] = useState<string | null>(null);
  const [loadingResults, setLoadingResults] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ tone: 'success' | 'error'; message: string; href?: string } | null>(null);
  const { flag: refreshed, trigger: triggerRefreshed } = useTimedFlag(1200);

  const activeJob = useMemo(() => jobs.find((j) => j.id === activeJobId) ?? null, [jobs, activeJobId]);

  const getAccessToken = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.access_token ?? null;
  }, []);

  const apiFetch = useCallback(async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const token = await getAccessToken();
    if (!token) throw new Error('Not authenticated');
    const res = await fetch(path, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
        Authorization: `Bearer ${token}`,
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(text || `Request failed: ${res.status}`);
    }
    return (await res.json()) as T;
  }, [getAccessToken]);

  const refreshJobs = useCallback(async () => {
    try {
      const { data } = await supabase.from('yandex_maps_jobs').select('*').order('created_at', { ascending: false });
      if (data) setJobs(data as unknown as YandexMapsJob[]);
    } catch (e) {
      console.error(e);
    }
  }, []);

  const loadLinks = useCallback(async (jobId: string) => {
    const data = await apiFetch<{ links: YandexMapsLinkRow[] }>(`/api/parsers/yandexmaps/${jobId}/links`);
    const lines = (data.links ?? []).map((l) => l.link).filter(Boolean);
    setLinksText(lines.join('\n'));
  }, [apiFetch]);

  const loadResults = useCallback(async (jobId: string) => {
    setLoadingResults(true);
    try {
      const data = await apiFetch<{ results: YandexMapsOrganizationRow[] }>(`/api/parsers/yandexmaps/${jobId}/results?limit=1000&offset=0`);
      setResults(data.results ?? []);
    } finally {
      setLoadingResults(false);
    }
  }, [apiFetch]);

  useEffect(() => {
    refreshJobs();
  }, [refreshJobs]);

  useEffect(() => {
    if (!activeJobId) {
      setLinksText('');
      setResults([]);
      return;
    }
    void loadLinks(activeJobId);
    void loadResults(activeJobId);
  }, [activeJobId, loadLinks, loadResults]);

  useEffect(() => {
    if (!activeJobId || !activeJob) return;
    if (activeJob.status === 'running' || activeJob.status === 'pending') {
      const interval = window.setInterval(() => {
        void refreshJobs();
        void loadLinks(activeJobId);
        void loadResults(activeJobId);
      }, 2000);
      return () => window.clearInterval(interval);
    }
  }, [activeJob, activeJobId, refreshJobs, loadLinks, loadResults]);

  const handleCreate = useCallback(async (payload: {
    search_urls: string[];
    max_results: number;
    headless: boolean;
    proxy: {
      enabled: boolean;
      protocol: 'http' | 'https' | 'socks5';
      host: string;
      port: string;
      username: string;
      password: string;
    };
  }) => {
    setBusy(true);
    setError(null);
    try {
      const data = await apiFetch<{ job: YandexMapsJob }>('/api/parsers/yandexmaps', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      const jobId = data.job.id;
      await refreshJobs();
      setActiveJobId(jobId);

      try {
        await apiFetch(`/api/parsers/yandexmaps/${jobId}/collect-links`, { method: 'POST' });
        await refreshJobs();
      } catch {
        // Job was already created in 'pending' — worker will pick it up
      }
    } catch (e) {
      console.error(e);
      setError('Не удалось создать запуск');
    } finally {
      setBusy(false);
    }
  }, [apiFetch, refreshJobs]);

  const handleCollectLinks = useCallback(async () => {
    if (!activeJobId) return;
    setJobActionId(activeJobId);
    setError(null);
    try {
      await apiFetch(`/api/parsers/yandexmaps/${activeJobId}/collect-links`, { method: 'POST' });
      await refreshJobs();
      await loadLinks(activeJobId);
    } catch (e) {
      console.error(e);
      setError('Не удалось запустить парсинг');
    } finally {
      setJobActionId(null);
    }
  }, [activeJobId, apiFetch, refreshJobs, loadLinks]);

  const handleSaveLinks = useCallback(async () => {
    if (!activeJobId) return;
    setJobActionId(activeJobId);
    setError(null);
    try {
      const raw = linksText.split('\n').map((s) => s.trim()).filter(Boolean);
      const links = normalizeYandexOrgUrls(raw);
      await apiFetch(`/api/parsers/yandexmaps/${activeJobId}/links`, {
        method: 'PUT',
        body: JSON.stringify({ links }),
      });
      await refreshJobs();
      await loadLinks(activeJobId);
      triggerRefreshed();
    } catch (e) {
      console.error(e);
      setError('Не удалось сохранить ссылки');
    } finally {
      setJobActionId(null);
    }
  }, [activeJobId, apiFetch, linksText, loadLinks, refreshJobs, triggerRefreshed]);

  const handleParse = useCallback(async () => {
    if (!activeJobId) return;
    setJobActionId(activeJobId);
    setError(null);
    try {
      await apiFetch(`/api/parsers/yandexmaps/${activeJobId}/parse`, { method: 'POST' });
      await refreshJobs();
    } catch (e) {
      console.error(e);
      setError('Не удалось запустить парсинг организаций');
    } finally {
      setJobActionId(null);
    }
  }, [activeJobId, apiFetch, refreshJobs]);

  const stopJob = useCallback(async (jobId: string) => {
    setJobActionId(jobId);
    setError(null);
    try {
      await supabase
        .from('yandex_maps_jobs')
        .update({ status: 'failed', error_message: 'Остановлено пользователем', completed_at: new Date().toISOString() })
        .eq('id', jobId);
      await refreshJobs();
    } catch (e) {
      console.error(e);
      setError('Не удалось остановить');
    } finally {
      setJobActionId(null);
    }
  }, [refreshJobs]);

  const deleteJob = useCallback(async (jobId: string) => {
    setJobActionId(jobId);
    setError(null);
    try {
      await supabase.from('yandex_maps_jobs').delete().eq('id', jobId);
      if (activeJobId === jobId) {
        setActiveJobId(null);
      }
      await refreshJobs();
    } catch (e) {
      console.error(e);
      setError('Не удалось удалить запуск');
    } finally {
      setJobActionId(null);
    }
  }, [activeJobId, refreshJobs]);

  const getExportFilename = (extension: string) => {
    const now = new Date();
    const day = String(now.getDate()).padStart(2, '0');
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const year = now.getFullYear();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    return `yandex_${day}${month}${year}_${hours}${minutes}.${extension}`;
  };

  const handleExportCsv = useCallback(() => {
    if (!activeJobId || results.length === 0) return;
    const header = ['Name', 'Phone', 'Website', 'Email', 'Address', 'City', 'Categories', 'WorkingHours', 'Rating', 'Reviews', 'CardUrl', 'Telegram', 'VK', 'Instagram', 'WhatsApp'];
    const rows = results.map((r) => [
      `"${String(r.name ?? '').replace(/"/g, '""')}"`,
      `"${String(r.phone ?? '').replace(/"/g, '""')}"`,
      `"${String(r.website ?? '').replace(/"/g, '""')}"`,
      `"${String(r.email ?? '').replace(/"/g, '""')}"`,
      `"${String(r.address ?? '').replace(/"/g, '""')}"`,
      `"${String(r.city ?? '').replace(/"/g, '""')}"`,
      `"${String(r.categories ?? '').replace(/"/g, '""')}"`,
      `"${String(r.working_hours ?? '').replace(/"/g, '""')}"`,
      `"${String(r.rating ?? '').replace(/"/g, '""')}"`,
      `"${String(r.reviews_count ?? '').replace(/"/g, '""')}"`,
      `"${String(r.card_url ?? '').replace(/"/g, '""')}"`,
      `"${String(r.telegram ?? '').replace(/"/g, '""')}"`,
      `"${String(r.vk ?? '').replace(/"/g, '""')}"`,
      `"${String(r.instagram ?? '').replace(/"/g, '""')}"`,
      `"${String(r.whatsapp ?? '').replace(/"/g, '""')}"`,
    ]);
    const csv = [header.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = getExportFilename('csv');
    a.click();
  }, [activeJobId, results]);

  const handleExportExcel = useCallback(() => {
    if (!activeJobId || results.length === 0) return;

    const data = results.map((r) => ({
      'Название': r.name || '',
      'Телефон': r.phone || '',
      'Сайт': r.website || '',
      'Email': r.email || '',
      'Адрес': r.address || '',
      'Город': r.city || '',
      'Категории': r.categories || '',
      'Часы работы': r.working_hours || '',
      'Рейтинг': r.rating || '',
      'Отзывы': r.reviews_count || '',
      'Ссылка': r.card_url || '',
      'Telegram': r.telegram || '',
      'VK': r.vk || '',
      'Instagram': r.instagram || '',
      'WhatsApp': r.whatsapp || '',
    }));

    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Organizations');
    const excelBuffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
    const blob = new Blob([excelBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;charset=UTF-8' });
    saveAs(blob, getExportFilename('xlsx'));
  }, [activeJobId, results]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 3500);
    return () => window.clearTimeout(t);
  }, [toast]);

  const addToDatabase = useCallback(() => {
    try {
      if (!activeJobId) {
        setToast({ tone: 'error', message: 'Сначала выберите запуск' });
        return;
      }
      if (results.length === 0) {
        setToast({ tone: 'error', message: 'Нет результатов для добавления' });
        return;
      }

      const MAX_ROWS = 5000;
      const rows: string[][] = [
        [
          'Name',
          'Website',
          'Email',
          'Phone',
          'Address',
          'City',
          'Categories',
          'CardUrl',
          'Telegram',
          'VK',
          'Instagram',
          'WhatsApp',
          'Rating',
          'Reviews',
          'JobId',
          'Parser',
        ],
        ...results.slice(0, MAX_ROWS).map((r) => [
          r.name ?? '',
          r.website ?? '',
          r.email ?? '',
          r.phone ?? '',
          r.address ?? '',
          r.city ?? '',
          r.categories ?? '',
          r.card_url ?? '',
          r.telegram ?? '',
          r.vk ?? '',
          r.instagram ?? '',
          r.whatsapp ?? '',
          r.rating ?? '',
          r.reviews_count ?? '',
          activeJobId,
          'yandexmaps',
        ]),
      ];

      const title = `Яндекс.Карты #${activeJobId.slice(0, 8)}`;
      const { id } = writePendingDbImport({ title, rows });
      const url = buildDatabasesImportUrl(id);
      setToast({ tone: 'success', message: 'Добавлено в “Базы”. Можете перейти и проверить импорт.', href: url });
    } catch (e) {
      setToast({ tone: 'error', message: e instanceof Error ? e.message : 'Ошибка добавления в базу' });
    }
  }, [activeJobId, results]);

  const totalLinks = activeJob?.total_links ?? 0;
  const totalOrgs = activeJob?.total_organizations ?? results.length;
  const processedOrgs = activeJob?.processed_organizations ?? 0;
  const getStageLabel = (stage: string) => {
    if (!stage) return '—';
    if (stage === 'collecting_links') return 'Сбор ссылок';
    if (stage.startsWith('collecting_links:')) return `Сбор ссылок (URL ${stage.split(':')[1]})`;
    if (stage === 'links_collected') return 'Ссылки собраны, запуск парсинга...';
    if (stage === 'parsing_organizations') return 'Парсинг организаций';
    if (stage.startsWith('parsing_organizations:')) return `Парсинг организаций (${stage.split(':')[1]})`;
    if (stage === 'completed') return 'Завершено';
    return stage;
  };

  const stageStr = activeJob?.progress_stage?.toString() ?? '';
  const stage = getStageLabel(stageStr);
  const isCollecting = stageStr.includes('collecting_links') || stageStr === 'links_collected';
  const isParsing = stageStr.includes('parsing_organizations');

  return (
    <div className="space-y-8">
      {toast ? (
        <div
          className={`fixed bottom-4 right-4 z-50 max-w-[92vw] rounded-xl border px-4 py-3 text-sm shadow-lg ${
            toast.tone === 'success'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
              : 'border-red-200 bg-red-50 text-red-900'
          }`}
          role="status"
          aria-live="polite"
        >
          <div className="flex items-center gap-3">
            <div className="min-w-0">{toast.message}</div>
            {toast.href ? (
              <a
                href={toast.href}
                className="shrink-0 inline-flex items-center rounded-lg border border-emerald-200 bg-white px-2.5 py-1 text-xs font-medium text-emerald-900 shadow-sm hover:bg-emerald-50"
              >
                Перейти
              </a>
            ) : null}
          </div>
        </div>
      ) : null}
      {/* Top Section: New Run */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="p-4 border-b border-gray-100 bg-gray-50/50">
          <h3 className="text-base font-semibold text-gray-900">Новый парсинг</h3>
        </div>
        <div className="p-6">
          <YandexMapsParserForm busy={busy} onCreate={handleCreate} />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Left Sidebar: History */}
        <div className="lg:col-span-3 space-y-6">
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden flex flex-col h-[800px]">
            <div className="p-4 border-b border-gray-100 bg-gray-50/50 flex items-center justify-between">
              <h3 className="text-base font-semibold text-gray-900">История запусков</h3>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-600 hover:text-gray-900 transition-colors bg-white border border-gray-200 rounded-md px-2.5 py-1.5 shadow-sm hover:bg-gray-50"
                onClick={() => { void refreshJobs(); triggerRefreshed(); }}
              >
                <RefreshCw className={`h-3.5 w-3.5 ${refreshed ? 'animate-spin' : ''}`} />
                Обновить
              </button>
            </div>
            
            <div className="flex-1 overflow-y-auto p-2 space-y-2">
              {jobs.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-gray-400 text-sm">
                  <p>Нет запусков</p>
                </div>
              ) : (
                jobs.map((j) => (
                  <button
                    key={j.id}
                    type="button"
                    onClick={() => setActiveJobId(j.id)}
                    className={`w-full text-left rounded-lg border p-3 transition-all ${
                      activeJobId === j.id 
                        ? 'border-blue-500 bg-blue-50/50 ring-1 ring-blue-500/20' 
                        : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-mono text-xs font-medium text-gray-500">#{j.id.slice(0, 8)}</span>
                      <JobStatus status={j.status} errorMessage={j.error_message ?? null} />
                    </div>
                    
                    <div className="flex items-center justify-between text-xs text-gray-600">
                      <span>{formatDate(j.created_at)}</span>
                      <span className="font-medium">
                        {j.total_organizations 
                          ? `${j.processed_organizations}/${j.total_organizations} орг.` 
                          : `${j.total_links} ссыл.`
                        }
                      </span>
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Right Content: Active Job Details */}
        <div className="lg:col-span-9 space-y-6">
          {!activeJob ? (
            <div className="bg-white rounded-xl border border-dashed border-gray-300 p-12 text-center h-full flex flex-col items-center justify-center">
              <div className="mx-auto h-12 w-12 text-gray-300 mb-4">
                <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                </svg>
              </div>
              <h3 className="text-lg font-medium text-gray-900">Нет выбранного запуска</h3>
              <p className="mt-1 text-sm text-gray-500">Выберите запуск из списка слева, чтобы посмотреть детали.</p>
            </div>
          ) : (
            <>
              {/* Job Header & Actions */}
              <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                <div className="p-6 border-b border-gray-100">
                  <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
                    <div>
                      <div className="flex items-center gap-3 mb-1">
                        <h2 className="text-xl font-bold text-gray-900">Запуск #{activeJob.id.slice(0, 8)}</h2>
                        <span className={`inline-flex items-center rounded-md px-2 py-1 text-xs font-medium ring-1 ring-inset ${
                          activeJob.status === 'completed' ? 'bg-green-50 text-green-700 ring-green-600/20' :
                          activeJob.status === 'failed' ? 'bg-red-50 text-red-700 ring-red-600/20' :
                          activeJob.status === 'running' ? 'bg-blue-50 text-blue-700 ring-blue-600/20' :
                          'bg-gray-50 text-gray-600 ring-gray-500/10'
                        }`}>
                          {activeJob.status}
                        </span>
                      </div>
                      
                      <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-gray-500 mt-2">
                        <div className="flex items-center gap-1.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-gray-400"></span>
                          Этап: <span className="font-medium text-gray-900">{stage || '—'}</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-gray-400"></span>
                          Ссылок: <span className="font-medium text-gray-900">{totalLinks}</span>
                        </div>
                        {(isParsing || activeJob.status === 'completed') && (
                          <div className="flex items-center gap-1.5">
                            <span className="w-1.5 h-1.5 rounded-full bg-gray-400"></span>
                            Организаций: <span className="font-medium text-gray-900">{processedOrgs} / {totalOrgs}</span>
                          </div>
                        )}
                      </div>

                      {activeJob.status === 'running' ? (
                        <div className="mt-3 rounded-md border border-blue-100 bg-blue-50/60 px-3 py-2 text-xs text-blue-900">
                          Парсинг может занимать длительное время. Можно закрыть вкладку — задача выполняется в фоне, зайдите позже.
                        </div>
                      ) : null}

                      {activeJob.error_message && !isStoppedByUser(activeJob.status, activeJob.error_message) && (
                        <div className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700 border border-red-100">
                          <span className="font-medium">Ошибка:</span> {activeJob.error_message}
                        </div>
                      )}
                    </div>

                    <div className="flex flex-wrap gap-2">
                      {activeJob.status === 'running' ? (
                        <button
                          type="button"
                          onClick={() => stopJob(activeJob.id)}
                          disabled={jobActionId === activeJob.id}
                          className="inline-flex items-center justify-center rounded-lg bg-white border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-offset-2 disabled:opacity-50"
                        >
                          Остановить
                        </button>
                      ) : (
                        <>
                          {activeJob.status === 'failed' && (
                            <>
                              <button
                                type="button"
                                onClick={handleCollectLinks}
                                disabled={jobActionId === activeJob.id}
                                className="inline-flex items-center justify-center rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-600 focus:ring-offset-2 disabled:opacity-50"
                              >
                                Перезапустить
                              </button>
                              {totalLinks > 0 && !isStoppedByUser(activeJob.status, activeJob.error_message) && (
                                <button
                                  type="button"
                                  onClick={handleParse}
                                  disabled={jobActionId === activeJob.id}
                                  className="inline-flex items-center justify-center rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-2 disabled:opacity-50"
                                >
                                  Парсить ссылки
                                </button>
                              )}
                            </>
                          )}
                          {activeJob.status === 'pending' && (
                            <span className="inline-flex items-center gap-1.5 text-sm text-gray-500">
                              <svg className="h-4 w-4 animate-spin text-blue-500" fill="none" viewBox="0 0 24 24">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                              </svg>
                              Ожидание запуска...
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={() => deleteJob(activeJob.id)}
                            disabled={jobActionId === activeJob.id}
                            className="inline-flex items-center justify-center rounded-lg bg-red-50 border border-red-200 px-4 py-2 text-sm font-medium text-red-700 shadow-sm hover:bg-red-100 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 disabled:opacity-50"
                          >
                            Удалить
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  {error && <div className="mt-4 text-sm text-red-600 bg-red-50 p-2 rounded border border-red-100">{error}</div>}
                </div>
              </div>

              {/* Links Editor */}
              <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                <div className="p-4 border-b border-gray-100 bg-gray-50/50 flex items-center justify-between">
                  <h3 className="text-base font-semibold text-gray-900">Ссылки организаций</h3>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-gray-500">
                      {linksText.split('\n').map((s) => s.trim()).filter(Boolean).length} шт.
                    </span>
                    <button
                      type="button"
                      onClick={handleSaveLinks}
                      disabled={jobActionId === activeJob.id}
                      className="inline-flex items-center justify-center rounded-lg bg-white border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 shadow-sm hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50"
                    >
                      Сохранить
                    </button>
                  </div>
                </div>
                <div className="p-0">
                  <textarea
                    className="block w-full h-48 border-0 p-4 text-sm font-mono focus:ring-0 resize-y"
                    value={linksText}
                    onChange={(e) => setLinksText(e.target.value)}
                    placeholder="https://yandex.ru/maps/org/.../12345/"
                  />
                </div>
              </div>

              {/* Results Table */}
              <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden flex flex-col h-[600px]">
                <div className="p-4 border-b border-gray-100 bg-gray-50/50 flex items-center justify-between">
                  <h3 className="text-base font-semibold text-gray-900">Результаты</h3>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={addToDatabase}
                      disabled={!activeJobId || results.length === 0}
                      className="inline-flex items-center gap-2 rounded-lg bg-white border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 shadow-sm hover:bg-gray-50 disabled:opacity-50 transition-colors"
                      title="Откроет “Базы” и добавит результаты новой вкладкой"
                    >
                      <Database className="h-3.5 w-3.5" />
                      В базу
                    </button>
                    <button
                      type="button"
                      onClick={handleExportExcel}
                      disabled={results.length === 0}
                      className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 text-white px-3 py-1.5 text-xs font-medium hover:bg-emerald-500 disabled:opacity-50 shadow-sm transition-colors"
                    >
                      <FileSpreadsheet className="h-3.5 w-3.5" />
                      Скачать Excel
                    </button>
                    <button
                      type="button"
                      onClick={handleExportCsv}
                      disabled={results.length === 0}
                      className="inline-flex items-center gap-2 rounded-lg bg-gray-900 text-white px-3 py-1.5 text-xs font-medium hover:bg-gray-800 disabled:opacity-50 shadow-sm transition-colors"
                    >
                      <Download className="h-3.5 w-3.5" />
                      Скачать CSV
                    </button>
                  </div>
                </div>
                
                <div className="flex-1 overflow-auto relative">
                  {loadingResults ? (
                    <div className="absolute inset-0 flex items-center justify-center bg-white/80 z-10">
                      <div className="flex flex-col items-center gap-2">
                        <RefreshCw className="h-6 w-6 animate-spin text-blue-500" />
                        <span className="text-sm text-gray-500">Загрузка данных...</span>
                      </div>
                    </div>
                  ) : null}

                  {results.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full text-gray-400 text-sm">
                      <p>Нет результатов</p>
                    </div>
                  ) : (
                    <table className="min-w-full text-sm divide-y divide-gray-200">
                      <thead className="bg-gray-50 sticky top-0 z-10 shadow-sm">
                        <tr>
                          <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider w-[350px]">Название</th>
                          <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">Контакты</th>
                          <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">Адрес</th>
                          <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">Инфо</th>
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-200">
                        {results.slice(0, 500).map((r) => (
                          <tr key={r.id} className="hover:bg-gray-50 transition-colors">
                            <td className="px-4 py-3 align-top max-w-[350px]">
                              <div className="font-medium text-gray-900 break-words">{r.name || '—'}</div>
                              <div className="text-xs text-gray-500 mt-0.5 line-clamp-3" title={r.categories || ''}>{r.categories}</div>
                            </td>
                            <td className="px-4 py-3 align-top text-center">
                              <div className="space-y-1 flex flex-col items-center">
                                {r.phone && <div className="text-gray-900">{r.phone}</div>}
                                {r.website && (
                                  <div>
                                    <a className="text-blue-600 hover:text-blue-800 hover:underline truncate max-w-[200px] block" href={r.website} target="_blank" rel="noreferrer">
                                      {r.website}
                                    </a>
                                  </div>
                                )}
                                {r.email && <div className="text-gray-500 text-xs">{r.email}</div>}
                              </div>
                            </td>
                            <td className="px-4 py-3 align-top text-gray-600 max-w-xs text-center">
                              {r.address || '—'}
                            </td>
                            <td className="px-4 py-3 align-top whitespace-nowrap text-center">
                              <div className="flex items-center justify-center gap-1">
                                <span className="text-amber-500">★</span>
                                <span className="font-medium text-gray-900">{r.rating || '—'}</span>
                                <span className="text-gray-400 text-xs">({r.reviews_count || 0})</span>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
                {results.length > 500 && (
                  <div className="p-2 border-t border-gray-200 bg-gray-50 text-center text-xs text-gray-500">
                    Показано 500 из {results.length} записей
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

