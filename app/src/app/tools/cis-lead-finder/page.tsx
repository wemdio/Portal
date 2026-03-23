'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { hasFioStructure } from '@/lib/cisLeads/fioStructure';

type ImportJob = {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  display_status?: 'pending' | 'running' | 'completed' | 'failed';
  enrichment_progress?: number;
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
  phone: string | null;
  email: string | null;
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
  channel_tg_user_id: number | null;
  channel_email: string | null;
  profile_links?: Record<string, string> | null;
  wa_registered?: boolean | null;
  score: number;
  confidence: number;
  created_at: string;
};

async function getToken(): Promise<string | null> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ?? null;
}

function phoneToWhatsApp(phone: string): string | null {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('8')) return `7${digits.slice(1)}`;
  if (digits.length === 11 && digits.startsWith('7')) return digits;
  if (digits.length === 10) return `7${digits}`;
  return digits.length >= 10 ? digits : null;
}

function getTgProfileLink(contact: Pick<ContactRow, 'channel_tg_username' | 'channel_tg_user_id'>): string | null {
  const username = String(contact.channel_tg_username ?? '').trim().replace(/^@/, '');
  if (username) return `https://t.me/${username}`;
  const userId = Number(contact.channel_tg_user_id ?? 0) || 0;
  if (userId > 0) return `tg://user?id=${userId}`;
  return null;
}

function getTgProfileLabel(contact: Pick<ContactRow, 'channel_tg_username' | 'channel_tg_user_id'>): string {
  const username = String(contact.channel_tg_username ?? '').trim();
  if (username) return username.startsWith('@') ? username : `@${username}`;
  return `id:${contact.channel_tg_user_id}`;
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
  const [exporting, setExporting] = useState<'csv' | 'xlsx' | null>(null);

  const selectedJob = useMemo(() => jobs.find((j) => j.id === selectedJobId) ?? null, [jobs, selectedJobId]);
  const hasActiveJob = useMemo(() => jobs.some((j) => (j.display_status ?? j.status) === 'running' || (j.display_status ?? j.status) === 'pending'), [jobs]);
  const selectedCompany = useMemo(() => companies.find((c) => c.id === selectedCompanyId) ?? null, [companies, selectedCompanyId]);
  const statusLabel = (status: ImportJob['status']) => {
    if (status === 'pending') return 'В очереди';
    if (status === 'running') return 'В работе';
    if (status === 'completed') return 'Завершено';
    if (status === 'failed') return 'Ошибка';
    return status;
  };
  const getDisplayStatus = (job: ImportJob): ImportJob['status'] => job.display_status ?? job.status;

  const TOTAL_STAGES = 13;
  const getStageLabel = (progress: number): string => {
    const pct = progress * 100;
    if (pct < 8) return 'Поиск ИНН';
    if (pct < 15) return 'Нормализация компаний';
    if (pct < 23) return 'Привязка компаний';
    if (pct < 77) return 'Обогащение (ЛПР, сайты, телефоны)';
    if (pct < 85) return 'Поиск LinkedIn';
    if (pct < 92) return 'Поиск соцсетей';
    return 'Сборка контактов';
  };
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

  async function stopJob(jobId: string) {
    const token = await getToken();
    if (!token) return;
    const res = await fetch('/api/tools/cis-leads/jobs', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: jobId, action: 'stop' }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      alert(data.error ?? 'Ошибка остановки');
      return;
    }
    await refreshJobs();
  }

  async function exportContacts(jobId: string, format: 'csv' | 'xlsx') {
    if (exporting) return;
    setExporting(format);
    try {
      const token = await getToken();
      if (!token) return;
      const res = await fetch(`/api/tools/cis-leads/jobs/${encodeURIComponent(jobId)}/export?format=${format}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `cis_leads_${jobId}.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } finally {
      setExporting(null);
    }
  }

  useEffect(() => {
    void refreshJobs();
    const t = setInterval(() => void refreshJobs(), hasActiveJob ? 5000 : 30000);
    return () => clearInterval(t);
  }, [hasActiveJob]);

  useEffect(() => {
    if (!selectedJobId) return;
    void loadCompanies(selectedJobId, true);
    if (!hasActiveJob) return;
    const t = setInterval(() => void loadCompanies(selectedJobId), 10000);
    return () => clearInterval(t);
  }, [selectedJobId, hasActiveJob]);

  useEffect(() => {
    if (!selectedCompanyId) return;
    void loadContacts(selectedCompanyId);
    if (!hasActiveJob) return;
    const t = setInterval(() => void loadContacts(selectedCompanyId), 10000);
    return () => clearInterval(t);
  }, [selectedCompanyId, hasActiveJob]);

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
    if (src === 'perplexity_search') return 'Perplexity';
    if (src === 'website_team') return 'Сайт';
    if (src === 'phone_tg') return 'Telegram';
    if (src === 'telegram') return 'Telegram';
    if (src === 'raw_import' || src === 'manual') return 'Импорт';
    return src;
  };

  const isPersonLike = (fullName: string): boolean => {
    const raw = String(fullName ?? '').trim();
    if (!raw) return false;
    if (raw.startsWith('@')) return true;
    if (/[А-ЯЁа-яё]/.test(raw)) return hasFioStructure(raw);
    return false;
  };

  const contactNameKey = (fullName: string): string => {
    const raw = String(fullName ?? '').trim().toLowerCase();
    if (!raw) return '';
    const parts = raw.split(/\s+/).filter(Boolean);

    // Drop likely patronymic so "Фамилия Имя Отчество" ~= "Имя Фамилия"
    const withoutPatronymic = parts.filter((p) => {
      const s = p.replace(/[.,]/g, '');
      return !(
        s.endsWith('вич') ||
        s.endsWith('вна') ||
        s.endsWith('ична') ||
        s.endsWith('оглы') ||
        s.endsWith('кызы')
      );
    });

    // Order-insensitive key to handle "Имя Фамилия" vs "Фамилия Имя"
    const normalized = (withoutPatronymic.length ? withoutPatronymic : parts)
      .slice(0, 3)
      .sort()
      .join(' ');

    return normalized;
  };

  const orderedContacts = useMemo(() => {
    if (!contacts.length) return contacts;
    // Hide non-person "contacts" (org/brand names) from web/google sources.
    const combined = contacts.filter((c) => {
      if (isPersonLike(c.full_name)) return true;
      const src = String(c.source ?? '');
      return !(src === 'serper_search' || src === 'perplexity_search' || src === 'website_team');
    });

    // Soft dedupe: avoid showing the same person multiple times (often happens across sources).
    const seenPerson = new Set<string>();
    const out: ContactRow[] = [];
    for (const c of combined) {
      const key = contactNameKey(c.full_name);
      if (!key) continue;
      if (seenPerson.has(key)) continue;
      seenPerson.add(key);
      out.push(c);
    }
    return out;
  }, [contacts]);

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

        {hasActiveJob ? (
          <div className="rounded-2xl border-2 border-dashed border-gray-200 bg-gray-50/60 p-5">
            <div className="text-sm text-gray-500 text-center">
              Идёт обработка. Дождитесь завершения или остановите текущий импорт.
            </div>
          </div>
        ) : (
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
                  className="inline-flex items-center justify-center rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium hover:bg-gray-50 cursor-pointer"
                >
                  Выбрать файл
                </label>
              </div>
            </div>
          </div>
        )}

        <div className="flex gap-3 flex-wrap">
          <button
            onClick={() => void handleUpload()}
            disabled={!file || uploading || hasActiveJob}
            className="rounded-lg bg-emerald-600 text-white px-4 py-2 text-sm font-medium disabled:opacity-50"
          >
            {uploading ? 'Загрузка…' : 'Загрузить и запустить'}
          </button>
          {file ? (
            <button
              onClick={() => setFile(null)}
              className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium hover:bg-gray-50"
            >
              Отменить
            </button>
          ) : null}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 items-start">
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
                  const displayStatus = getDisplayStatus(j);
                  const enrichProg = Math.max(0, Math.min(1, Number(j.enrichment_progress) || 0));
                  const progressPercent = displayStatus === 'completed' ? 100
                    : displayStatus === 'pending' ? 0
                    : Math.round(enrichProg * 100);
                  const isRunning = displayStatus === 'running';
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
                  <div className="absolute top-1.5 right-1.5 flex items-center gap-0.5">
                    {(displayStatus === 'running' || displayStatus === 'pending') ? (
                      <button
                        type="button"
                        title="Остановить задачу"
                        onClick={(e) => {
                          e.stopPropagation();
                          void stopJob(j.id);
                        }}
                        className="rounded-md p-0.5 text-gray-400 hover:text-amber-600 hover:bg-amber-50 transition-colors"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                          <path d="M5.25 3A2.25 2.25 0 003 5.25v9.5A2.25 2.25 0 005.25 17h9.5A2.25 2.25 0 0017 14.75v-9.5A2.25 2.25 0 0014.75 3h-9.5z" />
                        </svg>
                      </button>
                    ) : (
                      <button
                        type="button"
                        title="Удалить импорт"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteTarget({ id: j.id, name: j.source_filename });
                        }}
                        className="rounded-md p-0.5 text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                          <path fillRule="evenodd" d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.807a2.75 2.75 0 002.742-2.53l.841-10.52.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193V3.75A2.75 2.75 0 0011.25 1h-2.5zM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4zM8.58 7.72a.75.75 0 00-1.5.06l.3 7.5a.75.75 0 101.5-.06l-.3-7.5zm4.34.06a.75.75 0 10-1.5-.06l-.3 7.5a.75.75 0 101.5.06l.3-7.5z" clipRule="evenodd" />
                        </svg>
                      </button>
                    )}
                  </div>
                  <div className="font-medium text-gray-900 truncate pr-6">{j.source_filename}</div>
                  <div className="text-xs text-gray-600 flex gap-2 flex-wrap">
                    <span>{statusLabel(displayStatus)}</span>
                    <span>•</span>
                    <span>компаний: {j.companies_found ?? 0}</span>
                    <span>•</span>
                    <span>контактов: {j.contacts_found ?? 0}</span>
                  </div>
                  <div className="mt-2">
                    <div className="space-y-0.5">
                      <div className="flex items-center gap-2">
                        <div className="h-2 flex-1 rounded-full bg-gray-100 overflow-hidden">
                          {displayStatus === 'pending' ? (
                            <div className="h-full w-0" />
                          ) : isRunning && progressPercent === 0 ? (
                            <div className="h-full w-1/4 bg-emerald-400/60 animate-pulse rounded-full" />
                          ) : (
                            <div
                              className={`h-full rounded-full transition-[width] duration-500 ${displayStatus === 'completed' ? 'bg-emerald-500' : displayStatus === 'failed' ? 'bg-red-400' : 'bg-emerald-500'}`}
                              style={{ width: `${progressPercent}%` }}
                            />
                          )}
                        </div>
                        <span className="text-[10px] text-gray-500 w-8 text-right shrink-0">
                          {displayStatus === 'completed' ? '✓' : displayStatus === 'failed' ? '✗' : displayStatus === 'pending' ? '' : `${progressPercent}%`}
                        </span>
                      </div>
                      {isRunning && enrichProg > 0 && enrichProg < 1 ? (
                        <div className="text-[10px] text-emerald-600 truncate">{getStageLabel(enrichProg)}</div>
                      ) : null}
                    </div>
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

        <div className="rounded-2xl border border-gray-200 bg-white p-4 space-y-3 lg:col-span-3">
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
                  onClick={() => void exportContacts(selectedJobId, 'csv')}
                  disabled={!!exporting}
                  className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {exporting === 'csv' ? 'Экспортируем...' : 'Экспорт CSV'}
                </button>
              ) : null}
              {selectedJobId ? (
                <button
                  onClick={() => void exportContacts(selectedJobId, 'xlsx')}
                  disabled={!!exporting}
                  className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {exporting === 'xlsx' ? 'Экспортируем...' : 'Экспорт Excel'}
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
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
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
                    {orderedContacts.map((p) => {
                      const role = roleLabel(p.role_guess);
                      const tgProfileLink = getTgProfileLink(p);
                      const profileLinks = (p.profile_links && typeof p.profile_links === 'object' ? p.profile_links : {}) as Record<string, string>;
                      const hasChannels = p.channel_phone || p.channel_tg_username || p.channel_email || profileLinks.linkedin;
                      const hasProfileLinks = Object.keys(profileLinks).length > 0;
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
                              {profileLinks.linkedin ? (
                                <a
                                  href={profileLinks.linkedin}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1 rounded-lg bg-blue-50 border border-blue-200 px-2.5 py-1 text-xs text-[#0A66C2] hover:bg-blue-100 transition-colors"
                                  title="LinkedIn"
                                >
                                  <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="currentColor"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>
                                  LinkedIn
                                </a>
                              ) : null}
                              {tgProfileLink ? (
                                <a
                                  href={tgProfileLink}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1 rounded-lg bg-sky-50 border border-sky-200 px-2.5 py-1 text-xs text-sky-700 hover:bg-sky-100 transition-colors"
                                >
                                  <svg viewBox="0 0 24 24" fill="currentColor" className="w-3 h-3">
                                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69a.2.2 0 00-.05-.18c-.06-.05-.14-.03-.21-.02-.09.02-1.49.95-4.22 2.79-.4.27-.76.41-1.08.4-.36-.01-1.04-.2-1.55-.37-.63-.2-1.12-.31-1.08-.66.02-.18.27-.36.74-.55 2.92-1.27 4.86-2.11 5.83-2.51 2.78-1.16 3.35-1.36 3.73-1.36.08 0 .27.02.39.12.1.08.13.19.14.27-.01.06.01.24 0 .38z"/>
                                  </svg>
                                  {getTgProfileLabel(p)}
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
                            (() => {
                              const companyPhone = selectedCompany?.phone;
                              const companyEmail = selectedCompany?.email;
                              return (companyPhone || companyEmail) ? (
                                <div className="space-y-1.5">
                                  <div className="text-[11px] text-amber-600 font-medium">Контакты компании (общие):</div>
                                  <div className="flex gap-2 flex-wrap">
                                    {companyPhone ? (
                                      <a
                                        href={`tel:${companyPhone}`}
                                        className="inline-flex items-center gap-1 rounded-lg bg-amber-50 border border-amber-200 px-2.5 py-1 text-xs text-amber-700 hover:bg-amber-100 transition-colors"
                                      >
                                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 text-amber-400">
                                          <path fillRule="evenodd" d="M2 3.5A1.5 1.5 0 0 1 3.5 2h1.148a1.5 1.5 0 0 1 1.465 1.175l.716 3.223a1.5 1.5 0 0 1-1.052 1.767l-.933.267c-.41.117-.643.555-.48.95a11.542 11.542 0 0 0 6.254 6.254c.395.163.833-.07.95-.48l.267-.933a1.5 1.5 0 0 1 1.767-1.052l3.223.716A1.5 1.5 0 0 1 18 15.352V16.5a1.5 1.5 0 0 1-1.5 1.5H15c-1.149 0-2.263-.15-3.326-.43A13.022 13.022 0 0 1 2.43 8.326 13.019 13.019 0 0 1 2 5V3.5Z" clipRule="evenodd" />
                                        </svg>
                                        {companyPhone}
                                      </a>
                                    ) : null}
                                    {companyEmail ? (
                                      <a
                                        href={`mailto:${companyEmail}`}
                                        className="inline-flex items-center gap-1 rounded-lg bg-amber-50 border border-amber-200 px-2.5 py-1 text-xs text-amber-700 hover:bg-amber-100 transition-colors"
                                      >
                                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 text-amber-400">
                                          <path d="M2.5 3A1.5 1.5 0 0 0 1 4.5v.793c.026.009.051.02.076.032L7.674 8.51c.206.1.446.1.652 0l6.598-3.185A.755.755 0 0 1 15 5.293V4.5A1.5 1.5 0 0 0 13.5 3h-11Z" />
                                          <path d="M15 6.954 8.978 9.86a2.25 2.25 0 0 1-1.956 0L1 6.954V11.5A1.5 1.5 0 0 0 2.5 13h11a1.5 1.5 0 0 0 1.5-1.5V6.954Z" />
                                        </svg>
                                        {companyEmail}
                                      </a>
                                    ) : null}
                                  </div>
                                </div>
                              ) : (
                                <div className="text-xs text-gray-400 italic">Контактные данные пока не найдены</div>
                              );
                            })()
                          )}

                          {tgProfileLink ? (
                            <div className="text-[11px] text-gray-500">
                              TG profile:{' '}
                              <a
                                href={tgProfileLink}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-sky-700 hover:text-sky-800 underline break-all"
                              >
                                {tgProfileLink}
                              </a>
                            </div>
                          ) : null}

                          {hasProfileLinks ? (
                            <div className="flex gap-2 flex-wrap">
                              {Object.entries(profileLinks).map(([key, url]) =>
                                url ? (
                                  <a
                                    key={key}
                                    href={url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-1 rounded-lg bg-gray-50 border border-gray-200 px-2 py-1 text-[11px] text-gray-600 hover:bg-gray-100 transition-colors capitalize"
                                    title={key}
                                  >
                                    {key === 'linkedin' && (
                                      <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 text-[#0A66C2]" fill="currentColor"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>
                                    )}
                                    {key === 'vk' && (
                                      <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 text-[#0077FF]" fill="currentColor"><path d="M15.684 0H8.316C1.592 0 0 1.592 0 8.316v7.368C0 22.408 1.592 24 8.316 24h7.368C22.408 24 24 22.408 24 15.684V8.316C24 1.592 22.408 0 15.684 0zm3.692 17.123h-1.744c-.66 0-.864-.525-2.05-1.727-1.033-1-1.49-1.135-1.744-1.135-.356 0-.458.102-.458.593v1.575c0 .424-.135.678-1.253.678-1.846 0-3.896-1.118-5.335-3.202C4.624 10.857 4 8.57 4 8.096c0-.254.102-.491.593-.491h1.744c.44 0 .61.203.78.677.863 2.49 2.303 4.675 2.896 4.675.22 0 .322-.102.322-.66V9.721c-.068-1.186-.695-1.287-.695-1.71 0-.203.17-.407.44-.407h2.744c.373 0 .508.203.508.643v3.473c0 .372.17.508.271.678.102.17.203.254.44.254.22 0 .407-.085.78-.457 1.423-1.643 2.44-4.165 2.44-4.165.135-.271.34-.457.745-.457h1.744c.525 0 .644.27.525.643-.22 1.017-2.354 4.031-2.354 4.031-.186.305-.254.44 0 .78.186.254.796.779 1.203 1.253.745.847 1.32 1.558 1.473 2.05.17.49-.085.744-.576.744z"/></svg>
                                    )}
                                    {key === 'telegram' && (
                                      <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 text-[#0088cc]" fill="currentColor"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>
                                    )}
                                    <span className="capitalize">{key}</span>
                                  </a>
                                ) : null
                              )}
                            </div>
                          ) : null}

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

