'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';

type ImportJob = {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  source_filename: string;
  source_label: string | null;
  total_rows: number;
  processed_rows: number;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
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

export default function CisLeadFinderPage() {
  const [uploading, setUploading] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [sourceLabel, setSourceLabel] = useState('');
  const [isDraggingFile, setIsDraggingFile] = useState(false);

  const [jobs, setJobs] = useState<ImportJob[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);

  const [companies, setCompanies] = useState<CompanyRow[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string | null>(null);
  const [contacts, setContacts] = useState<ContactRow[]>([]);

  const selectedJob = useMemo(() => jobs.find((j) => j.id === selectedJobId) ?? null, [jobs, selectedJobId]);
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
    setJobs(Array.isArray(data.jobs) ? data.jobs : []);
  }

  async function loadCompanies(jobId: string) {
    const token = await getToken();
    if (!token) return;
    const res = await fetch(`/api/tools/cis-leads/jobs/${encodeURIComponent(jobId)}/companies?page=1&page_size=120`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return;
    const data = (await res.json()) as { companies?: CompanyRow[] };
    setCompanies(Array.isArray(data.companies) ? data.companies : []);
  }

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
      if (sourceLabel.trim()) fd.set('source_label', sourceLabel.trim());

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
        await loadCompanies(data.job_id);
      }
      setFile(null);
      setSourceLabel('');
    } finally {
      setUploading(false);
    }
  }

  function setFileFromDrop(files: FileList | null | undefined) {
    const f = files?.[0] ?? null;
    if (!f) return;
    setFile(f);
  }

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
    void loadCompanies(selectedJobId);
  }, [selectedJobId]);

  useEffect(() => {
    if (!selectedCompanyId) return;
    void loadContacts(selectedCompanyId);
  }, [selectedCompanyId]);

  return (
    <div className="space-y-6 text-left max-w-full">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">CIS Lead Finder</h1>
        <p className="text-sm text-gray-500">
          Импорт таблиц с ИНН/телефонами → нормализация компаний → пробив Telegram → контакты.
        </p>
      </div>

      <div className="rounded-2xl border border-gray-200 bg-white p-6 space-y-5 max-w-5xl mx-auto">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-gray-900">Загрузка файла</div>
            <div className="text-xs text-gray-500">Перетащите файл сюда или выберите вручную. Поддержка: CSV/XLS/XLSX.</div>
          </div>
          <div className="w-full sm:w-auto">
            <label className="block text-sm font-medium text-gray-700 mb-1">Метка источника (опционально)</label>
            <input
              value={sourceLabel}
              onChange={(e) => setSourceLabel(e.target.value)}
              placeholder="например: okdesk_lookalike"
              className="w-full sm:w-[320px] rounded-lg border border-gray-200 px-3 py-2 text-sm"
            />
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
                <button
                  key={j.id}
                  onClick={() => {
                    setSelectedJobId(j.id);
                    setSelectedCompanyId(null);
                    setContacts([]);
                  }}
                  className={`w-full text-left rounded-xl border px-3 py-2 text-sm ${
                    selectedJobId === j.id ? 'border-emerald-300 bg-emerald-50' : 'border-gray-200 hover:bg-gray-50'
                  }`}
                >
                  <div className="font-medium text-gray-900 truncate">{j.source_filename}</div>
                  <div className="text-xs text-gray-600 flex gap-2 flex-wrap">
                    <span>{j.status}</span>
                    <span>•</span>
                    <span>{j.processed_rows}/{j.total_rows}</span>
                    {j.source_label ? (<><span>•</span><span className="truncate">{j.source_label}</span></>) : null}
                  </div>
                  {j.status === 'pending' || j.status === 'running' ? (
                    <div className="mt-2 h-1.5 rounded-full bg-gray-100 overflow-hidden">
                      <div
                        className={j.total_rows > 0 ? 'h-full bg-emerald-600 transition-[width] duration-300' : 'h-full w-1/2 bg-emerald-500/70 animate-pulse'}
                        style={j.total_rows > 0 ? { width: `${Math.round(Math.min(1, Math.max(0, j.processed_rows / Math.max(1, j.total_rows))) * 100)}%` } : undefined}
                      />
                    </div>
                  ) : null}
                  {j.error_message ? (
                    <div className="text-xs text-red-600 mt-1 line-clamp-2">{j.error_message}</div>
                  ) : null}
                </button>
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
              <div className="text-xs text-gray-500">{companies.length}</div>
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
            selectedJob && (selectedJob.status === 'pending' || selectedJob.status === 'running') ? (
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
                {companies.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => setSelectedCompanyId(c.id)}
                    className={`w-full text-left rounded-xl border px-3 py-2 text-sm ${
                      selectedCompanyId === c.id ? 'border-emerald-300 bg-emerald-50' : 'border-gray-200 hover:bg-gray-50'
                    }`}
                  >
                    <div className="font-medium text-gray-900 truncate">{c.short_name || c.name}</div>
                    <div className="text-xs text-gray-600 flex gap-2 flex-wrap">
                      {c.inn ? (<><span>ИНН {c.inn}</span><span>•</span></>) : null}
                      {c.region ? (<><span>{c.region}</span><span>•</span></>) : null}
                      <span>контактов: {c.contacts_count}</span>
                    </div>
                  </button>
                ))}
              </div>

              <div className="rounded-xl border border-gray-200 p-3 min-h-[200px]">
                {!selectedCompanyId ? (
                  <div className="text-sm text-gray-500">Выберите компанию, чтобы увидеть контакты.</div>
                ) : contacts.length === 0 ? (
                  <div className="text-sm text-gray-500">
                    Контактов пока нет. Пробив телефонов и агрегация идут фоном (нужно, чтобы был активный TG аккаунт в TG Outreach).
                  </div>
                ) : (
                  <div className="space-y-2">
                    {contacts.map((p) => (
                      <div key={p.id} className="rounded-lg border border-gray-200 p-3">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="font-medium text-gray-900 truncate">{p.full_name}</div>
                            <div className="text-xs text-gray-600">
                              {(p.title ?? '').trim() ? p.title : '—'} {p.role_guess ? `• ${p.role_guess}` : ''}
                            </div>
                          </div>
                          <div className="text-xs text-gray-600 shrink-0">score {p.score}</div>
                        </div>
                        <div className="mt-2 text-xs text-gray-700 flex gap-3 flex-wrap">
                          {p.channel_tg_username ? <span>TG: {p.channel_tg_username}</span> : null}
                          {p.channel_phone ? <span>Тел: {p.channel_phone}</span> : null}
                          {p.channel_email ? <span>Email: {p.channel_email}</span> : null}
                        </div>
                        <div className="mt-2 text-[11px] text-gray-500">
                          {p.source} • conf {p.confidence}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

