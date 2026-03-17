'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';

type ImportJob = {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  display_status?: 'pending' | 'running' | 'completed' | 'failed';
  progress_ratio?: number;
  source_filename: string;
  source_label: string | null;
  total_rows: number;
  processed_rows: number;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  companies_found?: number;
  contacts_found?: number;
};

type CompanyRow = {
  id: string;
  inn: string | null;
  name: string;
  short_name: string | null;
  region: string | null;
  city: string | null;
  site: string | null;
  source: string;
  source_confidence: number;
  contacts_count: number;
};

type ContactRow = {
  id: string;
  source: string;
  full_name: string;
  title: string | null;
  role_guess: string | null;
  channel_phone: string | null;
  channel_tg_username: string | null;
  channel_email: string | null;
  score: number;
  confidence: number;
  created_at: string;
};

async function getToken(): Promise<string | null> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ?? null;
}

function ConfirmDeleteModal({
  jobName,
  onConfirm,
  onCancel,
}: {
  jobName: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 p-6 animate-in fade-in zoom-in-95 duration-200">
        <div className="flex items-center justify-center w-12 h-12 rounded-full bg-red-50 mx-auto mb-4">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-6 h-6 text-red-500">
            <path fillRule="evenodd" d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.807a2.75 2.75 0 002.742-2.53l.841-10.52.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193V3.75A2.75 2.75 0 0011.25 1h-2.5zM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4zM8.58 7.72a.75.75 0 00-1.5.06l.3 7.5a.75.75 0 101.5-.06l-.3-7.5zm4.34.06a.75.75 0 10-1.5-.06l-.3 7.5a.75.75 0 101.5.06l.3-7.5z" clipRule="evenodd" />
          </svg>
        </div>
        <h3 className="text-center text-base font-semibold text-gray-900">Удалить импорт?</h3>
        <p className="text-center text-sm text-gray-500 mt-1.5">
          <span className="font-medium text-gray-700">{jobName}</span> и все связанные данные будут удалены безвозвратно.
        </p>
        <div className="flex gap-3 mt-6">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="flex-1 rounded-xl bg-red-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-red-700 transition-colors"
          >
            Удалить
          </button>
        </div>
      </div>
    </div>
  );
}

export default function CisLeadFinderPage() {
  const [uploading, setUploading] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);

  const [jobs, setJobs] = useState<ImportJob[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);

  const [companies, setCompanies] = useState<CompanyRow[]>([]);
  const [companySearch, setCompanySearch] = useState('');
  const [selectedCompanyId, setSelectedCompanyId] = useState<string | null>(null);
  const [contacts, setContacts] = useState<ContactRow[]>([]);

  const selectedJob = useMemo(() => jobs.find((j) => j.id === selectedJobId) ?? null, [jobs, selectedJobId]);
  const statusLabel = (status: ImportJob['status']) => {
    if (status === 'pending') return 'В очереди';
    if (status === 'running') return 'В работе';
    if (status === 'completed') return 'Завершено';
    if (status === 'failed') return 'Ошибка';
    return status;
  };
  const getDisplayStatus = (job: ImportJob): ImportJob['status'] => job.display_status ?? job.status;
  const selectedJobProgress = useMemo(() => {
    if (!selectedJob) return null;
    const total = Math.max(0, Number(selectedJob.total_rows) || 0);
    const processed = Math.max(0, Number(selectedJob.processed_rows) || 0);
    if (total <= 0) return { total, processed, ratio: null as number | null };
    const ratio = Math.max(0, Math.min(1, processed / total));
    return { total, processed, ratio };
  }, [selectedJob]);

  async function refreshJobs() {
    const token = await getToken();
    if (!token) return;
    const res = await fetch('/api/tools/cis-leads/jobs', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return;
    const data = (await res.json()) as { jobs?: ImportJob[] };
    const items = Array.isArray(data.jobs) ? data.jobs : [];
    const ordered = [...items]
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, 15);
    setJobs(ordered);
  }

  async function loadCompanies(jobId: string, resetSearch = false) {
    const token = await getToken();
    if (!token) return;
    const res = await fetch(`/api/tools/cis-leads/jobs/${encodeURIComponent(jobId)}/companies?page=1&page_size=500`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return;
    const data = (await res.json()) as { companies?: CompanyRow[] };
    setCompanies(Array.isArray(data.companies) ? data.companies : []);
    if (resetSearch) setCompanySearch('');
  }

  const filteredCompanies = useMemo(() => {
    if (!companySearch.trim()) return companies;
    const q = companySearch.toLowerCase();
    return companies.filter(
      (c) =>
        (c.name ?? '').toLowerCase().includes(q) ||
        (c.short_name ?? '').toLowerCase().includes(q) ||
        (c.inn ?? '').includes(q) ||
        (c.region ?? '').toLowerCase().includes(q),
    );
  }, [companies, companySearch]);

  async function loadContacts(companyId: string) {
    const token = await getToken();
    if (!token) return;
    const res = await fetch(`/api/tools/cis-leads/companies/${encodeURIComponent(companyId)}/contacts`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return;
    const data = (await res.json()) as { contacts?: ContactRow[] };
    setContacts(Array.isArray(data.contacts) ? data.contacts : []);
  }

  async function handleUpload() {
    if (!file) return;
    setUploading(true);
    try {
      const token = await getToken();
      if (!token) return;
      const fd = new FormData();
      fd.set('file', file);

      const res = await fetch('/api/tools/cis-leads/import', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      const data = (await res.json()) as { job_id?: string; error?: string };
      if (!res.ok) {
        alert(data.error ?? 'Ошибка загрузки файла');
        return;
      }
      await refreshJobs();
      if (data.job_id) {
        setSelectedJobId(data.job_id);
        setSelectedCompanyId(null);
        setContacts([]);
        await loadCompanies(data.job_id, true);
      }
      setFile(null);
    } finally {
      setUploading(false);
    }
  }

  function setFileFromDrop(files: FileList | null | undefined) {
    const f = files?.[0] ?? null;
    if (!f) return;
    setFile(f);
  }

  const confirmDeleteJob = useCallback(async () => {
    if (!deleteTarget) return;
    const jobId = deleteTarget.id;
    setDeleteTarget(null);
    const token = await getToken();
    if (!token) return;
    const res = await fetch(`/api/tools/cis-leads/jobs?id=${encodeURIComponent(jobId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      alert(data.error ?? 'Ошибка удаления');
      return;
    }
    if (selectedJobId === jobId) {
      setSelectedJobId(null);
      setCompanies([]);
      setSelectedCompanyId(null);
      setContacts([]);
    }
    await refreshJobs();
  }, [deleteTarget, selectedJobId]);

  async function exportCsv(jobId: string) {
    const token = await getToken();
    if (!token) return;
    const res = await fetch(`/api/tools/cis-leads/jobs/${encodeURIComponent(jobId)}/export`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cis_leads_${jobId}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  useEffect(() => {
    void refreshJobs();
    const t = setInterval(() => void refreshJobs(), 4000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!selectedJobId) return;
    void loadCompanies(selectedJobId, true);
    const t = setInterval(() => void loadCompanies(selectedJobId), 6000);
    return () => clearInterval(t);
  }, [selectedJobId]);

  useEffect(() => {
    if (!selectedCompanyId) return;
    void loadContacts(selectedCompanyId);
    const t = setInterval(() => void loadContacts(selectedCompanyId), 6000);
    return () => clearInterval(t);
  }, [selectedCompanyId]);

  const roleLabel = (role: string | null): { text: string; color: string } => {
    switch (role) {
      case 'owner': return { text: 'Собственник', color: 'bg-amber-100 text-amber-800' };
      case 'ceo': return { text: 'Генеральный директор', color: 'bg-red-100 text-red-700' };
      case 'commercial': return { text: 'Коммерческий директор', color: 'bg-blue-100 text-blue-700' };
      case 'sales': return { text: 'Продажи', color: 'bg-indigo-100 text-indigo-700' };
      case 'marketing': return { text: 'Маркетинг', color: 'bg-pink-100 text-pink-700' };
      case 'ops': return { text: 'Операции', color: 'bg-cyan-100 text-cyan-700' };
      case 'it': return { text: 'IT / CTO', color: 'bg-violet-100 text-violet-700' };
      case 'hr': return { text: 'HR', color: 'bg-lime-100 text-lime-700' };
      case 'director': return { text: 'Директор', color: 'bg-orange-100 text-orange-700' };
      default: return { text: role ?? 'ЛПР', color: 'bg-gray-100 text-gray-600' };
    }
  };

  const sourceLabel = (src: string): string => {
    if (src === 'dadata_management') return 'ЕГРЮЛ';
    if (src === 'dadata_founder') return 'Учредитель';
    if (src === 'serper_search') return 'Google';
    if (src === 'website_team') return 'Сайт';
    if (src === 'phone_tg') return 'Telegram';
    if (src === 'telegram') return 'Telegram';
    if (src === 'raw_import' || src === 'manual') return 'Импорт';
    return src;
  };

  return (
    <div className="space-y-6 text-left max-w-full">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">CIS Lead Finder</h1>
        <p className="text-sm text-gray-500">
          Инструмент уже готов для поиска ЛПР: импорт таблиц с ИНН/телефонами → нормализация компаний → пробив Telegram → контакты.
        </p>
      </div>

      <div className="rounded-2xl border border-gray-200 bg-white p-6 space-y-5 max-w-5xl mx-auto">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-gray-900">Загрузка файла</div>
            <div className="text-xs text-gray-500">Перетащите файл сюда или выберите вручную. Поддержка: CSV/XLS/XLSX.</div>
          </div>
        </div>

        {selectedJob && (selectedJob.status === 'pending' || selectedJob.status === 'running') ? (
          <div className="rounded-xl border border-gray-200 bg-white px-4 py-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="text-xs text-gray-700">
                Обработка: <span className="font-medium">{selectedJob.source_filename}</span>
              </div>
              <div className="text-xs text-gray-500">
                {selectedJobProgress?.total
                  ? `${selectedJobProgress.processed}/${selectedJobProgress.total}`
                  : selectedJobProgress?.processed
                    ? `${selectedJobProgress.processed} строк`
                    : 'стартуем…'}
              </div>
            </div>
            <div className="mt-2 h-2 rounded-full bg-gray-100 overflow-hidden">
              {selectedJobProgress?.ratio === null ? (
                <div className="h-full w-1/2 bg-emerald-500/70 animate-pulse" />
              ) : (
                <div
                  className="h-full bg-emerald-600 transition-[width] duration-300"
                  style={{ width: `${Math.round((selectedJobProgress?.ratio ?? 0) * 100)}%` }}
                />
              )}
            </div>
          </div>
        ) : null}

        <div
          className={[
            'rounded-2xl border-2 border-dashed p-5 transition',
            isDraggingFile ? 'border-emerald-400 bg-emerald-50/60' : 'border-gray-200 bg-gray-50/40 hover:bg-gray-50/70',
          ].join(' ')}
          onDragEnter={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setIsDraggingFile(true);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setIsDraggingFile(true);
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setIsDraggingFile(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setIsDraggingFile(false);
            setFileFromDrop(e.dataTransfer?.files);
          }}
        >
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="min-w-0">
              <div className="text-sm font-medium text-gray-900">
                {file ? 'Файл выбран' : 'Файл не выбран'}
              </div>
              <div className="text-xs text-gray-600 mt-1 truncate">
                {file ? `${file.name} • ${(file.size / (1024 * 1024)).toFixed(2)} MB` : 'Нажмите «Выбрать файл» или перетащите его в этот блок.'}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <input
                id="cis-leads-file"
                type="file"
                accept=".csv,.xls,.xlsx"
                onChange={(e) => setFileFromDrop(e.target.files)}
                className="sr-only"
              />
              <label
                htmlFor="cis-leads-file"
                className="inline-flex items-center justify-center rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium hover:bg-gray-50"
              >
                Выбрать файл
              </label>
              {file ? (
                <button
                  type="button"
                  onClick={() => setFile(null)}
                  className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium hover:bg-gray-50"
                >
                  Очистить
                </button>
              ) : null}
            </div>
          </div>
        </div>

        <div className="flex gap-3 flex-wrap">
          <button
            onClick={() => void handleUpload()}
            disabled={!file || uploading}
            className="rounded-lg bg-emerald-600 text-white px-4 py-2 text-sm font-medium disabled:opacity-50"
          >
            {uploading ? 'Загрузка…' : 'Загрузить и запустить'}
          </button>
          <button
            onClick={() => void refreshJobs()}
            className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium hover:bg-gray-50"
          >
            Обновить
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start">
        <div className="rounded-2xl border border-gray-200 bg-white p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-900">Импорты</h2>
            <span className="text-xs text-gray-500">{jobs.length}</span>
          </div>
          <div className="space-y-2">
            {jobs.length === 0 ? (
              <div className="text-sm text-gray-500">Пока нет импортов.</div>
            ) : (
              jobs.map((j) => (
                (() => {
                  const total = Math.max(0, Number(j.total_rows) || 0);
                  const processed = Math.max(0, Number(j.processed_rows) || 0);
                  const displayStatus = getDisplayStatus(j);
                  const ratio = typeof j.progress_ratio === 'number'
                    ? Math.max(0, Math.min(1, j.progress_ratio))
                    : displayStatus === 'completed'
                      ? 1
                      : total > 0
                      ? Math.max(0, Math.min(1, processed / total))
                      : null;
                  return (
                <div
                  key={j.id}
                  className={`relative w-full text-left rounded-xl border px-3 py-2 text-sm cursor-pointer ${
                    selectedJobId === j.id ? 'border-emerald-300 bg-emerald-50' : 'border-gray-200 hover:bg-gray-50'
                  }`}
                  onClick={() => {
                    setSelectedJobId(j.id);
                    setSelectedCompanyId(null);
                    setContacts([]);
                  }}
                >
                  <button
                    type="button"
                    title="Удалить импорт"
                    onClick={(e) => {
                      e.stopPropagation();
                      setDeleteTarget({ id: j.id, name: j.source_filename });
                    }}
                    className="absolute top-1.5 right-1.5 rounded-md p-0.5 text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                      <path fillRule="evenodd" d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.807a2.75 2.75 0 002.742-2.53l.841-10.52.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193V3.75A2.75 2.75 0 0011.25 1h-2.5zM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4zM8.58 7.72a.75.75 0 00-1.5.06l.3 7.5a.75.75 0 101.5-.06l-.3-7.5zm4.34.06a.75.75 0 10-1.5-.06l-.3 7.5a.75.75 0 101.5.06l.3-7.5z" clipRule="evenodd" />
                    </svg>
                  </button>
                  <div className="font-medium text-gray-900 truncate pr-6">{j.source_filename}</div>
                  <div className="text-xs text-gray-600 flex gap-2 flex-wrap">
                    <span>{statusLabel(displayStatus)}</span>
                    <span>•</span>
                    {displayStatus === 'completed' ? (
                      <span>компаний: {j.companies_found ?? 0}</span>
                    ) : (
                      <span>{j.processed_rows}/{j.total_rows}</span>
                    )}
                    <span>•</span>
                    <span>контактов: {j.contacts_found ?? 0}</span>
                  </div>
                  <div className="mt-2 space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-gray-400 w-14 shrink-0">импорт</span>
                      <div className="h-1.5 flex-1 rounded-full bg-gray-100 overflow-hidden">
                        {ratio === null ? (
                          <div className="h-full w-1/2 bg-emerald-500/70 animate-pulse" />
                        ) : (
                          <div
                            className="h-full bg-emerald-600 transition-[width] duration-300"
                            style={{ width: `${Math.round(ratio * 100)}%` }}
                          />
                        )}
                      </div>
                    </div>
                    {displayStatus === 'completed' ? (
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-gray-400 w-14 shrink-0">контакты</span>
                        <div className="h-1.5 flex-1 rounded-full bg-gray-100 overflow-hidden">
                          {(j.companies_found ?? 0) > 0 ? (
                            <div
                              className={`h-full transition-[width] duration-300 ${(j.contacts_found ?? 0) > 0 ? 'bg-violet-500' : 'bg-violet-400/60 animate-pulse'}`}
                              style={{ width: (j.contacts_found ?? 0) > 0 ? '100%' : '40%' }}
                            />
                          ) : (
                            <div className="h-full w-0 bg-violet-500" />
                          )}
                        </div>
                      </div>
                    ) : null}
                  </div>
                  {j.error_message ? (
                    <div className="text-xs text-red-600 mt-1 line-clamp-2">{j.error_message}</div>
                  ) : null}
                </div>
                  );
                })()
              ))
            )}
          </div>
        </div>

        <div className="rounded-2xl border border-gray-200 bg-white p-4 space-y-3 lg:col-span-2">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-gray-900">Компании</h2>
              <div className="text-xs text-gray-500">
                {selectedJob ? `Импорт: ${selectedJob.source_filename}` : 'Выберите импорт'}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <div className="text-xs text-gray-500">{companies.length > 0 ? `${filteredCompanies.length} из ${companies.length}` : ''}</div>
              {selectedJobId ? (
                <button
                  onClick={() => void exportCsv(selectedJobId)}
                  className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium hover:bg-gray-50"
                >
                  Экспорт CSV
                </button>
              ) : null}
            </div>
          </div>

          {selectedJobId && companies.length === 0 ? (
            selectedJob && (getDisplayStatus(selectedJob) === 'pending' || getDisplayStatus(selectedJob) === 'running') ? (
              <div className="text-sm text-gray-500">Компании появятся после завершения импорта и нормализации. Сейчас задача в работе.</div>
            ) : (
              <div className="text-sm text-gray-500">
                Компаний пока нет. Если в файле есть ИНН, проверьте заголовок колонки — подойдут, например: «ИНН», «ИНН компании», «ИНН организации».
              </div>
            )
          ) : null}

          {companies.length > 0 ? (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
              <div className="space-y-2">
                {companies.length > 10 && (
                  <input
                    type="text"
                    placeholder="Поиск по названию, ИНН, региону…"
                    value={companySearch}
                    onChange={(e) => setCompanySearch(e.target.value)}
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm placeholder:text-gray-400 focus:border-emerald-300 focus:outline-none focus:ring-1 focus:ring-emerald-300"
                  />
                )}
                <div className="max-h-[600px] overflow-y-auto space-y-1.5 pr-1">
                  {filteredCompanies.map((c) => (
                    <button
                      key={c.id}
                      onClick={() => setSelectedCompanyId(c.id)}
                      className={`w-full text-left rounded-xl border px-3 py-2 text-sm transition-colors ${
                        selectedCompanyId === c.id ? 'border-emerald-300 bg-emerald-50' : 'border-gray-200 hover:bg-gray-50'
                      }`}
                    >
                      <div className="font-medium text-gray-900 truncate">{c.short_name || c.name}</div>
                      <div className="text-xs text-gray-500 flex gap-1.5 flex-wrap">
                        {c.inn ? <span>ИНН {c.inn}</span> : null}
                        {c.inn && c.region ? <span>•</span> : null}
                        {c.region ? <span>{c.region}</span> : null}
                        {(c.inn || c.region) ? <span>•</span> : null}
                        <span className={c.contacts_count > 0 ? 'text-emerald-600 font-medium' : ''}>
                          {c.contacts_count > 0 ? `${c.contacts_count} контакт${c.contacts_count === 1 ? '' : c.contacts_count < 5 ? 'а' : 'ов'}` : 'нет контактов'}
                        </span>
                      </div>
                    </button>
                  ))}
                  {filteredCompanies.length === 0 && companySearch.trim() && (
                    <div className="text-sm text-gray-400 py-4 text-center">Ничего не найдено</div>
                  )}
                </div>
              </div>

              <div className="rounded-xl border border-gray-200 p-3 min-h-[200px] max-h-[650px] overflow-y-auto">
                {!selectedCompanyId ? (
                  <div className="text-sm text-gray-400 py-8 text-center">Выберите компанию, чтобы увидеть контакты</div>
                ) : contacts.length === 0 ? (
                  (selectedJob && (getDisplayStatus(selectedJob) === 'pending' || getDisplayStatus(selectedJob) === 'running')) ? (
                    <div className="text-sm text-gray-400 py-8 text-center">
                      Контактов пока нет — идёт обработка
                    </div>
                  ) : (
                    <div className="text-sm text-gray-400 py-8 text-center">
                      Контактов пока нет для этой компании
                    </div>
                  )
                ) : (
                  <div className="space-y-2">
                    {contacts.map((p) => {
                      const role = roleLabel(p.role_guess);
                      const hasChannels = p.channel_phone || p.channel_tg_username || p.channel_email;
                      return (
                        <div key={p.id} className="rounded-xl border border-gray-200 p-3 space-y-2">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="font-semibold text-gray-900 truncate">{p.full_name}</div>
                              {(p.title ?? '').trim() ? (
                                <div className="text-xs text-gray-600 mt-0.5">{p.title}</div>
                              ) : null}
                            </div>
                            <span className={`shrink-0 rounded-md px-2 py-0.5 text-[11px] font-medium ${role.color}`}>
                              {role.text}
                            </span>
                          </div>

                          {hasChannels ? (
                            <div className="flex gap-2 flex-wrap">
                              {p.channel_phone ? (
                                <a
                                  href={`tel:${p.channel_phone}`}
                                  className="inline-flex items-center gap-1 rounded-lg bg-gray-50 border border-gray-200 px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-100 transition-colors"
                                >
                                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 text-gray-400">
                                    <path fillRule="evenodd" d="M2 3.5A1.5 1.5 0 0 1 3.5 2h1.148a1.5 1.5 0 0 1 1.465 1.175l.716 3.223a1.5 1.5 0 0 1-1.052 1.767l-.933.267c-.41.117-.643.555-.48.95a11.542 11.542 0 0 0 6.254 6.254c.395.163.833-.07.95-.48l.267-.933a1.5 1.5 0 0 1 1.767-1.052l3.223.716A1.5 1.5 0 0 1 18 15.352V16.5a1.5 1.5 0 0 1-1.5 1.5H15c-1.149 0-2.263-.15-3.326-.43A13.022 13.022 0 0 1 2.43 8.326 13.019 13.019 0 0 1 2 5V3.5Z" clipRule="evenodd" />
                                  </svg>
                                  {p.channel_phone}
                                </a>
                              ) : null}
                              {p.channel_tg_username ? (
                                <a
                                  href={`https://t.me/${p.channel_tg_username.replace(/^@/, '')}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1 rounded-lg bg-sky-50 border border-sky-200 px-2.5 py-1 text-xs text-sky-700 hover:bg-sky-100 transition-colors"
                                >
                                  <svg viewBox="0 0 24 24" fill="currentColor" className="w-3 h-3">
                                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69a.2.2 0 00-.05-.18c-.06-.05-.14-.03-.21-.02-.09.02-1.49.95-4.22 2.79-.4.27-.76.41-1.08.4-.36-.01-1.04-.2-1.55-.37-.63-.2-1.12-.31-1.08-.66.02-.18.27-.36.74-.55 2.92-1.27 4.86-2.11 5.83-2.51 2.78-1.16 3.35-1.36 3.73-1.36.08 0 .27.02.39.12.1.08.13.19.14.27-.01.06.01.24 0 .38z"/>
                                  </svg>
                                  {p.channel_tg_username}
                                </a>
                              ) : null}
                              {p.channel_email ? (
                                <a
                                  href={`mailto:${p.channel_email}`}
                                  className="inline-flex items-center gap-1 rounded-lg bg-gray-50 border border-gray-200 px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-100 transition-colors"
                                >
                                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 text-gray-400">
                                    <path d="M2.5 3A1.5 1.5 0 0 0 1 4.5v.793c.026.009.051.02.076.032L7.674 8.51c.206.1.446.1.652 0l6.598-3.185A.755.755 0 0 1 15 5.293V4.5A1.5 1.5 0 0 0 13.5 3h-11Z" />
                                    <path d="M15 6.954 8.978 9.86a2.25 2.25 0 0 1-1.956 0L1 6.954V11.5A1.5 1.5 0 0 0 2.5 13h11a1.5 1.5 0 0 0 1.5-1.5V6.954Z" />
                                  </svg>
                                  {p.channel_email}
                                </a>
                              ) : null}
                            </div>
                          ) : (
                            <div className="text-xs text-gray-400 italic">Контактные данные пока не найдены</div>
                          )}

                          <div className="text-[11px] text-gray-400">
                            Источник: {sourceLabel(p.source)}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {deleteTarget && (
        <ConfirmDeleteModal
          jobName={deleteTarget.name}
          onConfirm={() => void confirmDeleteJob()}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}

