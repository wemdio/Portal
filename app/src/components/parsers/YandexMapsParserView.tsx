'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import type { YandexMapsJob, YandexMapsLinkRow, YandexMapsOrganizationRow } from '@/types/parsers';
import { YandexMapsParserForm } from '@/components/parsers/YandexMapsParserForm';
import { JobStatus, isStoppedByUser } from '@/components/parsers/JobStatus';
import { normalizeYandexOrgUrls } from '@/lib/parsers/yandexMapsUrlUtils';
import { Download, RefreshCw } from 'lucide-react';

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
    if (activeJob.status === 'running') {
      const interval = window.setInterval(() => {
        void refreshJobs();
        void loadResults(activeJobId);
      }, 5000);
      return () => window.clearInterval(interval);
    }
  }, [activeJob, activeJobId, refreshJobs, loadResults]);

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
      await refreshJobs();
      setActiveJobId(data.job.id);
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
    } catch (e) {
      console.error(e);
      setError('Не удалось запустить сбор ссылок');
    } finally {
      setJobActionId(null);
    }
  }, [activeJobId, apiFetch, refreshJobs]);

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
    a.download = `yandex_maps_${activeJobId}.csv`;
    a.click();
  }, [activeJobId, results]);

  const totalLinks = activeJob?.total_links ?? 0;
  const totalOrgs = activeJob?.total_organizations ?? results.length;
  const processedOrgs = activeJob?.processed_organizations ?? 0;
  const stage = (activeJob?.progress_stage ?? '').toString();

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1 space-y-4">
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <div className="text-sm font-semibold text-gray-900">Новый запуск</div>
            <div className="text-xs text-gray-500 mt-1">Создай задачу, затем собери ссылки и запусти парсинг.</div>
            <div className="mt-4">
              <YandexMapsParserForm busy={busy} onCreate={handleCreate} />
            </div>
          </div>

          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold text-gray-900">Запуски</div>
              <button
                type="button"
                className="inline-flex items-center gap-2 text-sm text-gray-700 hover:text-gray-900"
                onClick={() => { void refreshJobs(); triggerRefreshed(); }}
              >
                <RefreshCw className={`h-4 w-4 ${refreshed ? 'animate-spin' : ''}`} />
                Обновить
              </button>
            </div>
            <div className="mt-3 space-y-2">
              {jobs.length === 0 ? (
                <div className="text-sm text-gray-500">Нет запусков</div>
              ) : (
                jobs.map((j) => (
                  <button
                    key={j.id}
                    type="button"
                    onClick={() => setActiveJobId(j.id)}
                    className={`w-full text-left rounded-md border px-3 py-2 text-sm ${activeJobId === j.id ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:bg-gray-50'}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-gray-900">#{j.id.slice(0, 6)}</span>
                      <JobStatus status={j.status} errorMessage={j.error_message ?? null} />
                    </div>
                    <div className="text-xs text-gray-500 mt-1">{formatDate(j.created_at)}</div>
                    <div className="text-xs text-gray-500 mt-1">
                      {j.total_organizations ? `Орг: ${j.processed_organizations}/${j.total_organizations}` : `Ссылки: ${j.total_links}`}
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="lg:col-span-2 space-y-4">
          {!activeJob ? (
            <div className="bg-white rounded-lg border border-gray-200 p-6 text-sm text-gray-500">
              Выбери запуск слева, чтобы управлять ссылками и результатами.
            </div>
          ) : (
            <>
              <div className="bg-white rounded-lg border border-gray-200 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1">
                    <div className="text-sm font-semibold text-gray-900">Запуск #{activeJob.id.slice(0, 8)}</div>
                    <div className="text-xs text-gray-500">
                      Статус: <span className="font-medium">{activeJob.status}</span>{stage ? ` · ${stage}` : ''}
                    </div>
                    <div className="text-xs text-gray-500">
                      Ссылки: <span className="font-medium">{totalLinks}</span> · Организации: <span className="font-medium">{processedOrgs}/{totalOrgs}</span>
                    </div>
                    {activeJob.error_message && !isStoppedByUser(activeJob.status, activeJob.error_message) ? (
                      <div className="text-xs text-red-600">{activeJob.error_message}</div>
                    ) : null}
                  </div>

                  <div className="flex flex-wrap gap-2 justify-end">
                    <button
                      type="button"
                      onClick={handleCollectLinks}
                      disabled={jobActionId === activeJob.id || activeJob.status === 'running'}
                      className="rounded-md bg-amber-500 text-white px-3 py-2 text-sm hover:bg-amber-400 disabled:opacity-60"
                    >
                      Собрать ссылки
                    </button>
                    <button
                      type="button"
                      onClick={handleParse}
                      disabled={jobActionId === activeJob.id || activeJob.status === 'running'}
                      className="rounded-md bg-green-600 text-white px-3 py-2 text-sm hover:bg-green-500 disabled:opacity-60"
                    >
                      Парсить организации
                    </button>
                    <button
                      type="button"
                      onClick={() => stopJob(activeJob.id)}
                      disabled={jobActionId === activeJob.id || activeJob.status !== 'running'}
                      className="rounded-md bg-gray-800 text-white px-3 py-2 text-sm hover:bg-gray-700 disabled:opacity-60"
                    >
                      Остановить
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteJob(activeJob.id)}
                      disabled={jobActionId === activeJob.id}
                      className="rounded-md bg-red-600 text-white px-3 py-2 text-sm hover:bg-red-500 disabled:opacity-60"
                    >
                      Удалить
                    </button>
                  </div>
                </div>
                {error ? <div className="mt-3 text-sm text-red-600">{error}</div> : null}
              </div>

              <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold text-gray-900">Ссылки организаций</div>
                  <button
                    type="button"
                    onClick={handleSaveLinks}
                    disabled={jobActionId === activeJob.id}
                    className="rounded-md bg-blue-600 text-white px-3 py-2 text-sm hover:bg-blue-500 disabled:opacity-60"
                  >
                    Сохранить
                  </button>
                </div>
                <textarea
                  className="w-full h-44 rounded-md border border-gray-300 p-2 text-sm font-mono"
                  value={linksText}
                  onChange={(e) => setLinksText(e.target.value)}
                  placeholder="https://yandex.ru/maps/org/.../12345/"
                />
                <div className="text-xs text-gray-500">
                  Всего: {linksText.split('\n').map((s) => s.trim()).filter(Boolean).length}
                </div>
              </div>

              <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-semibold text-gray-900">Результаты</div>
                  <button
                    type="button"
                    onClick={handleExportCsv}
                    disabled={results.length === 0}
                    className="inline-flex items-center gap-2 rounded-md bg-gray-900 text-white px-3 py-2 text-sm hover:bg-gray-800 disabled:opacity-60"
                  >
                    <Download className="h-4 w-4" />
                    CSV
                  </button>
                </div>
                {loadingResults ? (
                  <div className="text-sm text-gray-500">Загрузка...</div>
                ) : results.length === 0 ? (
                  <div className="text-sm text-gray-500">Пока нет результатов</div>
                ) : (
                  <div className="overflow-auto border border-gray-200 rounded-md">
                    <table className="min-w-full text-sm">
                      <thead className="bg-gray-50 text-gray-700">
                        <tr>
                          <th className="px-3 py-2 text-left">Название</th>
                          <th className="px-3 py-2 text-left">Телефон</th>
                          <th className="px-3 py-2 text-left">Сайт</th>
                          <th className="px-3 py-2 text-left">Email</th>
                          <th className="px-3 py-2 text-left">Адрес</th>
                          <th className="px-3 py-2 text-left">Категории</th>
                          <th className="px-3 py-2 text-left">Рейтинг</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-200">
                        {results.slice(0, 500).map((r) => (
                          <tr key={r.id} className="hover:bg-gray-50">
                            <td className="px-3 py-2 whitespace-nowrap">{r.name ?? ''}</td>
                            <td className="px-3 py-2 whitespace-nowrap">{r.phone ?? ''}</td>
                            <td className="px-3 py-2 whitespace-nowrap">
                              {r.website ? <a className="text-blue-600 hover:underline" href={r.website} target="_blank" rel="noreferrer">{r.website}</a> : ''}
                            </td>
                            <td className="px-3 py-2 whitespace-nowrap">{r.email ?? ''}</td>
                            <td className="px-3 py-2">{r.address ?? ''}</td>
                            <td className="px-3 py-2">{r.categories ?? ''}</td>
                            <td className="px-3 py-2 whitespace-nowrap">{r.rating ?? ''}{r.reviews_count ? ` (${r.reviews_count})` : ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {results.length > 500 ? <div className="text-xs text-gray-500">Показано 500 из {results.length}</div> : null}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

