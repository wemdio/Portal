'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowDownToLine,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Eye,
  Globe,
  Loader2,
  MapPin,
  Play,
  Search,
  Star,
  ThumbsDown,
  ThumbsUp,
  XCircle,
} from 'lucide-react';
import { supabase } from '@/lib/supabaseClient';
import { authFetch } from '@/lib/authFetch';
import { writePendingDbImport, buildDatabasesImportUrl } from '@/lib/databases/pendingImport';
import { CITIES, RUBRICS } from '@/lib/parsers/yandexMapsData';
import { humanProgressStage } from '@/lib/reputationFinder/progressStages';

/* ───────── types ───────── */

interface ReputationJob {
  id: string;
  status: string;
  mode: string;
  config: Record<string, unknown>;
  total_candidates: number;
  processed_candidates: number;
  auto_export_count: number;
  review_count: number;
  discard_count: number;
  created_at: string;
  completed_at: string | null;
  error_message: string | null;
}

interface ReputationCandidateRow {
  id: string;
  job_id: string;
  company: string;
  city: string | null;
  category: string | null;
  source_mode: string;
  primary_source: string;
  primary_source_url: string | null;
  website: string | null;
  rating: number | null;
  reviews_count: number;
  negative_reviews_30d: number;
  negative_reviews_90d: number;
  unanswered_negative_reviews: number;
  negative_serp_results_top10: number;
  issue_themes: string[];
  proof_urls: string[];
  proof_snippets: string[];
  pain_score: number;
  confidence_score: number;
  classification: string;
  second_source_confirmed: boolean;
  review_decision: string | null;
}

type Tab = 'setup' | 'results';
type Mode = 'auto_search' | 'local_reviews';

/* ───────── helpers ───────── */

const API_BASE = '/api/tools/reputation-finder/jobs';
const CITY_GROUPS = Object.entries(CITIES);
const RUBRIC_GROUPS = Object.entries(RUBRICS);

async function apiFetch(path: string, init?: RequestInit) {
  return authFetch(`${API_BASE}${path}`, init);
}

function painBadge(score: number) {
  if (score >= 70) return 'bg-red-100 text-red-700';
  if (score >= 40) return 'bg-orange-100 text-orange-700';
  return 'bg-gray-100 text-gray-600';
}

function confBadge(score: number) {
  if (score >= 70) return 'bg-green-100 text-green-700';
  if (score >= 40) return 'bg-yellow-100 text-yellow-700';
  return 'bg-gray-100 text-gray-600';
}

function classLabel(c: string) {
  if (c === 'auto_export') return { text: 'Auto-export', cls: 'bg-green-100 text-green-700' };
  if (c === 'review') return { text: 'На проверку', cls: 'bg-amber-100 text-amber-700' };
  return { text: 'Отклонён', cls: 'bg-gray-100 text-gray-500' };
}

function modeLabel(mode: string) {
  if (mode === 'auto_search') return 'Авто-поиск';
  if (mode === 'local_reviews') return 'Из парсинга';
  if (mode === 'brand_serp') return 'Brand SERP';
  return mode;
}

/* ───────── main ───────── */

export default function ReputationFinderPage() {
  const [tab, setTab] = useState<Tab>('setup');
  const [jobs, setJobs] = useState<ReputationJob[]>([]);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<ReputationCandidateRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [progressLog, setProgressLog] = useState<string[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filterClass, setFilterClass] = useState<string>('');
  const [toast, setToast] = useState<{ tone: 'success' | 'error'; message: string; href?: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLPreElement>(null);

  // ── setup form state ──
  const [mode, setMode] = useState<Mode>('auto_search');
  const [maxRating, setMaxRating] = useState('4.0');
  const [minReviews, setMinReviews] = useState('10');
  const [enableSerpScan, setEnableSerpScan] = useState(false);
  const [selectedCities, setSelectedCities] = useState<Set<string>>(new Set());
  const [selectedRubrics, setSelectedRubrics] = useState<Set<string>>(new Set());
  const [ymapsJobIds, setYmapsJobIds] = useState('');

  // ── auto scroll log ──
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [progressLog]);

  // ── fetch jobs ──
  const fetchJobs = useCallback(async () => {
    try {
      const res = await apiFetch('');
      if (!res.ok) {
        console.warn('[reputation-finder] fetchJobs failed:', res.status);
        return;
      }
      const data = await res.json();
      const fetched: ReputationJob[] = data.jobs ?? [];
      setJobs(fetched);
      if (!activeJobId && fetched.length > 0) {
        setActiveJobId(fetched[0].id);
        setTab('results');
      }
    } catch (err) {
      console.warn('[reputation-finder] fetchJobs error:', err);
    }
  }, [activeJobId]);

  useEffect(() => { void fetchJobs(); }, [fetchJobs]);

  // ── fetch candidates ──
  const fetchCandidates = useCallback(async (jobId: string) => {
    setLoading(true);
    try {
      const params = filterClass ? `?classification=${filterClass}` : '';
      const res = await apiFetch(`/${jobId}/candidates${params}`);
      if (!res.ok) return;
      const data = await res.json();
      setCandidates(data.candidates ?? []);
    } catch { /* noop */ }
    finally { setLoading(false); }
  }, [filterClass]);

  useEffect(() => {
    if (activeJobId) void fetchCandidates(activeJobId);
  }, [activeJobId, fetchCandidates]);

  // ── city/rubric toggle helpers ──
  const toggleCity = (city: string) => {
    setSelectedCities((prev) => {
      const next = new Set(prev);
      next.has(city) ? next.delete(city) : next.add(city);
      return next;
    });
  };

  const toggleCityGroup = (cities: string[]) => {
    setSelectedCities((prev) => {
      const next = new Set(prev);
      const allSelected = cities.every((c) => next.has(c));
      if (allSelected) cities.forEach((c) => next.delete(c));
      else cities.forEach((c) => next.add(c));
      return next;
    });
  };

  const toggleRubric = (rubric: string) => {
    setSelectedRubrics((prev) => {
      const next = new Set(prev);
      next.has(rubric) ? next.delete(rubric) : next.add(rubric);
      return next;
    });
  };

  const toggleRubricGroup = (rubrics: string[]) => {
    setSelectedRubrics((prev) => {
      const next = new Set(prev);
      const allSelected = rubrics.every((r) => next.has(r));
      if (allSelected) rubrics.forEach((r) => next.delete(r));
      else rubrics.forEach((r) => next.add(r));
      return next;
    });
  };

  // ── poll DB for job progress (fallback when SSE drops) ──
  const pollJobProgress = useCallback(async (jobId: string, signal: AbortSignal) => {
    const POLL_MS = 5_000;
    let lastStage = '';
    while (!signal.aborted) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      if (signal.aborted) break;

      const { data: row } = await supabase
        .from('reputation_jobs')
        .select('status, progress_stage, error_message, processed_candidates, total_candidates, auto_export_count, review_count, discard_count')
        .eq('id', jobId)
        .single();

      if (!row) break;

      const stage = String(row.progress_stage ?? '');
      if (stage && stage !== lastStage && stage !== 'pending') {
        lastStage = stage;
        const msg = humanProgressStage(stage);
        if (msg) setProgressLog((prev) => [...prev, msg]);
      }

      if (row.status === 'completed') {
        setProgressLog((prev) => [...prev, 'Pipeline завершён.']);
        break;
      }
      if (row.status === 'failed') {
        setProgressLog((prev) => [...prev, `Ошибка: ${row.error_message ?? 'Pipeline failed'}`]);
        break;
      }
    }
  }, []);

  // ── create + run job ──
  const handleRun = useCallback(async () => {
    setRunning(true);
    setProgressLog([]);
    let createdJobId: string | null = null;
    try {
      let config: Record<string, unknown>;
      let jobMode: string;

      if (mode === 'auto_search') {
        if (selectedCities.size === 0 || selectedRubrics.size === 0) {
          setToast({ tone: 'error', message: 'Выберите хотя бы один город и одну рубрику' });
          setRunning(false);
          return;
        }
        jobMode = 'auto_search';
        config = {
          cities: [...selectedCities],
          rubrics: [...selectedRubrics],
          maxRating: parseFloat(maxRating) || 4.0,
          minReviews: parseInt(minReviews) || 10,
          enableSerpScan,
        };
      } else {
        jobMode = 'local_reviews';
        config = {
          maxRating: parseFloat(maxRating) || 4.0,
          minReviews: parseInt(minReviews) || 10,
          ...(ymapsJobIds.trim() ? { ymapsJobIds: ymapsJobIds.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
        };
      }

      const createRes = await apiFetch('', {
        method: 'POST',
        body: JSON.stringify({ mode: jobMode, config }),
      });
      if (!createRes.ok) throw new Error('Failed to create job');
      const { job } = await createRes.json();
      createdJobId = job.id;
      setActiveJobId(job.id);
      setTab('results');

      const ac = new AbortController();
      abortRef.current = ac;

      const runRes = await authFetch(`${API_BASE}/${job.id}/run`, {
        method: 'POST',
        signal: ac.signal,
      });

      if (!runRes.ok || !runRes.body) throw new Error('Run failed');

      const reader = runRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const raw = line.replace(/^data:\s*/, '').replace(/^:\s*\w+$/, '');
          if (!raw) continue;
          try {
            const ev = JSON.parse(raw);
            if (ev.message) setProgressLog((prev) => [...prev, ev.message]);
            if (ev.done) setProgressLog((prev) => [...prev, 'Pipeline завершён.']);
            if (ev.error) setProgressLog((prev) => [...prev, `Ошибка: ${ev.error}`]);
          } catch { /* skip non-json or heartbeats */ }
        }
      }

      await fetchJobs();
      await fetchCandidates(job.id);
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;

      if (createdJobId) {
        setProgressLog((prev) => [...prev, 'SSE-соединение потеряно, переключение на опрос БД...']);
        const pollAc = new AbortController();
        abortRef.current = pollAc;
        try {
          await pollJobProgress(createdJobId, pollAc.signal);
          await fetchJobs();
          await fetchCandidates(createdJobId);
        } catch { /* noop */ }
      } else {
        setProgressLog((prev) => [...prev, `Критическая ошибка: ${(err as Error).message}`]);
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [mode, maxRating, minReviews, enableSerpScan, selectedCities, selectedRubrics, ymapsJobIds, fetchJobs, fetchCandidates, pollJobProgress]);

  // ── review decision ──
  const handleReview = useCallback(async (candidateId: string, decision: 'accept' | 'reject') => {
    if (!activeJobId) return;
    try {
      const res = await apiFetch(`/${activeJobId}/candidates`, {
        method: 'PATCH',
        body: JSON.stringify({ candidateId, decision }),
      });
      if (res.ok) {
        setCandidates((prev) =>
          prev.map((c) =>
            c.id === candidateId
              ? { ...c, review_decision: decision, classification: decision === 'accept' ? 'auto_export' : 'discard' }
              : c,
          ),
        );
      }
    } catch { /* noop */ }
  }, [activeJobId]);

  // ── export to Базы ──
  const handleExport = useCallback(async () => {
    if (!activeJobId) return;
    try {
      const res = await apiFetch(`/${activeJobId}/export`);
      if (!res.ok) throw new Error('Export failed');
      const data = await res.json();
      if (!data.rows?.length) {
        setToast({ tone: 'error', message: 'Нет кандидатов для экспорта' });
        return;
      }

      const rows = [data.header, ...data.rows];
      const title = `Reputation #${activeJobId.slice(0, 8)}`;
      const { id } = writePendingDbImport({ title, rows });
      const url = buildDatabasesImportUrl(id);
      setToast({ tone: 'success', message: `Экспортировано ${data.total} лидов в "Базы".`, href: url });
    } catch {
      setToast({ tone: 'error', message: 'Ошибка экспорта' });
    }
  }, [activeJobId]);

  // ── stats ──
  const stats = useMemo(() => {
    const total = candidates.length;
    const auto = candidates.filter((c) => c.classification === 'auto_export').length;
    const review = candidates.filter((c) => c.classification === 'review').length;
    const discard = candidates.filter((c) => c.classification === 'discard').length;
    const avgPain = total > 0 ? Math.round(candidates.reduce((s, c) => s + c.pain_score, 0) / total) : 0;
    return { total, auto, review, discard, avgPain };
  }, [candidates]);

  const activeJob = useMemo(() => jobs.find((j) => j.id === activeJobId) ?? null, [jobs, activeJobId]);

  const urlCount = selectedCities.size * selectedRubrics.size;

  return (
    <div className="space-y-6 text-left max-w-full">
      {/* ── header ── */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Reputation Finder</h1>
          <p className="text-sm text-gray-500">
            Поиск компаний с плохой репутацией для SERM-агентств.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setTab('setup')}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${tab === 'setup' ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
          >
            Настройка
          </button>
          <button
            onClick={() => setTab('results')}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${tab === 'results' ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
          >
            Результаты
          </button>
        </div>
      </div>

      {/* ── toast ── */}
      {toast && (
        <div className={`rounded-lg border px-4 py-3 text-sm flex items-center gap-2 ${toast.tone === 'success' ? 'bg-green-50 border-green-200 text-green-700' : 'bg-red-50 border-red-200 text-red-700'}`}>
          {toast.tone === 'success' ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
          {toast.message}
          {toast.href && <a href={toast.href} className="underline ml-1">Открыть</a>}
          <button onClick={() => setToast(null)} className="ml-auto text-xs opacity-60 hover:opacity-100">Закрыть</button>
        </div>
      )}

      {/* ═══════════ SETUP TAB ═══════════ */}
      {tab === 'setup' && (
        <div className="grid gap-6 lg:grid-cols-3">
          {/* ── left: mode + form ── */}
          <div className="lg:col-span-2 space-y-5">
            {/* mode selector */}
            <div className="rounded-xl border border-gray-200 bg-white p-5 space-y-4">
              <h2 className="text-lg font-semibold text-gray-900">Режим поиска</h2>
              <div className="flex gap-3">
                <ModeCard
                  active={mode === 'auto_search'}
                  icon={<Search className="h-5 w-5" />}
                  title="Новый поиск"
                  desc="Выберите рубрику и города — система найдёт и проанализирует компании"
                  onClick={() => setMode('auto_search')}
                />
                <ModeCard
                  active={mode === 'local_reviews'}
                  icon={<Star className="h-5 w-5" />}
                  title="Из существующего парсинга"
                  desc="Используйте данные из уже выполненного парсинга Яндекс.Карт"
                  onClick={() => setMode('local_reviews')}
                />
              </div>
            </div>

            {mode === 'auto_search' && (
              <>
                {/* rubrics */}
                <div className="rounded-xl border border-gray-200 bg-white p-5 space-y-3">
                  <h3 className="text-sm font-semibold text-gray-800">Рубрики</h3>
                  <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                    {RUBRIC_GROUPS.map(([group, items]) => {
                      const allChecked = items.every((r) => selectedRubrics.has(r));
                      const someChecked = items.some((r) => selectedRubrics.has(r));
                      return (
                        <div key={group}>
                          <label className="flex items-center gap-2 cursor-pointer py-1">
                            <input
                              type="checkbox"
                              checked={allChecked}
                              ref={(el) => { if (el) el.indeterminate = someChecked && !allChecked; }}
                              onChange={() => toggleRubricGroup(items)}
                              className="rounded border-gray-300 text-gray-900 focus:ring-gray-900"
                            />
                            <span className="text-sm font-medium text-gray-700">{group}</span>
                            <span className="text-xs text-gray-400">({items.length})</span>
                          </label>
                          <div className="ml-6 flex flex-wrap gap-1.5">
                            {items.map((r) => (
                              <button
                                key={r}
                                onClick={() => toggleRubric(r)}
                                className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors ${
                                  selectedRubrics.has(r)
                                    ? 'bg-gray-900 text-white'
                                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                                }`}
                              >
                                {r}
                              </button>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {selectedRubrics.size > 0 && (
                    <p className="text-xs text-gray-500">Выбрано: {selectedRubrics.size} рубрик</p>
                  )}
                </div>

                {/* cities */}
                <div className="rounded-xl border border-gray-200 bg-white p-5 space-y-3">
                  <h3 className="text-sm font-semibold text-gray-800">Города</h3>
                  <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                    {CITY_GROUPS.map(([group, items]) => {
                      const allChecked = items.every((c) => selectedCities.has(c));
                      const someChecked = items.some((c) => selectedCities.has(c));
                      return (
                        <div key={group}>
                          <label className="flex items-center gap-2 cursor-pointer py-1">
                            <input
                              type="checkbox"
                              checked={allChecked}
                              ref={(el) => { if (el) el.indeterminate = someChecked && !allChecked; }}
                              onChange={() => toggleCityGroup(items)}
                              className="rounded border-gray-300 text-gray-900 focus:ring-gray-900"
                            />
                            <span className="text-sm font-medium text-gray-700">{group}</span>
                            <span className="text-xs text-gray-400">({items.length})</span>
                          </label>
                          <div className="ml-6 flex flex-wrap gap-1.5">
                            {items.map((c) => (
                              <button
                                key={c}
                                onClick={() => toggleCity(c)}
                                className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors ${
                                  selectedCities.has(c)
                                    ? 'bg-gray-900 text-white'
                                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                                }`}
                              >
                                {c}
                              </button>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {selectedCities.size > 0 && (
                    <p className="text-xs text-gray-500">Выбрано: {selectedCities.size} городов</p>
                  )}
                </div>
              </>
            )}

            {mode === 'local_reviews' && (
              <div className="rounded-xl border border-gray-200 bg-white p-5 space-y-3">
                <h3 className="text-sm font-semibold text-gray-800">Параметры</h3>
                <label className="block">
                  <span className="text-xs font-medium text-gray-600">ID задач Яндекс.Карт (через запятую)</span>
                  <input
                    value={ymapsJobIds} onChange={(e) => setYmapsJobIds(e.target.value)}
                    placeholder="uuid-1, uuid-2"
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm"
                  />
                </label>
              </div>
            )}

            {/* thresholds + serp + run */}
            <div className="rounded-xl border border-gray-200 bg-white p-5 space-y-4">
              <h3 className="text-sm font-semibold text-gray-800">Пороги и опции</h3>
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="text-xs font-medium text-gray-600">Макс. рейтинг</span>
                  <input
                    type="number" step="0.1" min="1" max="5"
                    value={maxRating} onChange={(e) => setMaxRating(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm"
                  />
                </label>
                <label className="block">
                  <span className="text-xs font-medium text-gray-600">Мин. отзывов</span>
                  <input
                    type="number" min="1"
                    value={minReviews} onChange={(e) => setMinReviews(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm"
                  />
                </label>
              </div>

              {mode === 'auto_search' && (
                <label className="flex items-center gap-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={enableSerpScan}
                    onChange={(e) => setEnableSerpScan(e.target.checked)}
                    className="rounded border-gray-300 text-gray-900 focus:ring-gray-900"
                  />
                  <span className="text-sm text-gray-700">
                    Проверить выдачу Google/DDG на негатив
                  </span>
                  <Globe className="h-3.5 w-3.5 text-gray-400" />
                  <span className="text-xs text-gray-400">(бесплатно, +4 сек/компания)</span>
                </label>
              )}

              {mode === 'auto_search' && urlCount > 0 && (
                <p className="text-xs text-gray-500">
                  Будет создано <span className="font-semibold">{urlCount}</span> поисковых запросов для Яндекс.Карт
                </p>
              )}

              <button
                onClick={handleRun}
                disabled={running}
                className="inline-flex items-center gap-1.5 rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-800 disabled:opacity-50"
              >
                {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                {running ? 'Выполняется…' : 'Запустить поиск'}
              </button>
            </div>
          </div>

          {/* ── right: history ── */}
          <div className="space-y-5">
            <div className="rounded-xl border border-gray-200 bg-white p-5 space-y-3">
              <h2 className="text-lg font-semibold text-gray-900">История</h2>
              {jobs.length === 0 ? (
                <p className="text-sm text-gray-400">Запусков пока нет.</p>
              ) : (
                <div className="space-y-2 max-h-[32rem] overflow-y-auto">
                  {jobs.map((j) => (
                    <button
                      key={j.id}
                      onClick={() => { setActiveJobId(j.id); setTab('results'); }}
                      className={`w-full text-left rounded-lg border p-3 text-sm transition-colors hover:bg-gray-50 ${activeJobId === j.id ? 'border-gray-900 bg-gray-50' : 'border-gray-200'}`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-gray-800">{modeLabel(j.mode)}</span>
                        <StatusBadge status={j.status} />
                      </div>
                      <div className="mt-1 text-xs text-gray-500">
                        {new Date(j.created_at).toLocaleString('ru')} &middot;{' '}
                        {j.auto_export_count} export, {j.review_count} review, {j.discard_count} discard
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* ── progress log ── */}
          {progressLog.length > 0 && (
            <div className="lg:col-span-3 rounded-xl border border-gray-200 bg-gray-900 p-4">
              <pre ref={logRef} className="text-xs text-gray-300 whitespace-pre-wrap font-mono max-h-64 overflow-y-auto">
                {progressLog.join('\n')}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* ═══════════ RESULTS TAB ═══════════ */}
      {tab === 'results' && (
        <div className="space-y-4">
          {/* ── running indicator + progress log ── */}
          {running && (
            <div className="rounded-xl border border-blue-200 bg-blue-50 p-4 space-y-3">
              <div className="flex items-center gap-3">
                <Loader2 className="h-5 w-5 animate-spin text-blue-600" />
                <div>
                  <p className="text-sm font-semibold text-blue-800">Поиск выполняется…</p>
                  <p className="text-xs text-blue-600">
                    {progressLog.length > 0 ? progressLog[progressLog.length - 1] : 'Инициализация…'}
                  </p>
                </div>
                <button
                  onClick={() => abortRef.current?.abort()}
                  className="ml-auto rounded-lg border border-blue-300 px-3 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100 transition-colors"
                >
                  Отменить
                </button>
              </div>
              {progressLog.length > 1 && (
                <details className="text-xs">
                  <summary className="cursor-pointer text-blue-600 hover:text-blue-800 font-medium">
                    Подробный лог ({progressLog.length} записей)
                  </summary>
                  <pre ref={logRef} className="mt-2 rounded-lg bg-gray-900 p-3 text-gray-300 whitespace-pre-wrap font-mono max-h-48 overflow-y-auto">
                    {progressLog.join('\n')}
                  </pre>
                </details>
              )}
            </div>
          )}

          {/* stats strip */}
          {!running && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              <StatCard label="Всего" value={stats.total} color="bg-gray-100 text-gray-800" />
              <StatCard label="Auto-export" value={stats.auto} color="bg-green-50 text-green-700" />
              <StatCard label="На проверку" value={stats.review} color="bg-amber-50 text-amber-700" />
              <StatCard label="Отклонено" value={stats.discard} color="bg-gray-50 text-gray-500" />
              <StatCard label="Avg Pain" value={stats.avgPain} color="bg-red-50 text-red-700" />
            </div>
          )}

          {/* filters + export */}
          <div className="flex flex-wrap items-center gap-3">
            <select
              value={filterClass}
              onChange={(e) => setFilterClass(e.target.value)}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm"
            >
              <option value="">Все статусы</option>
              <option value="auto_export">Auto-export</option>
              <option value="review">На проверку</option>
              <option value="discard">Отклонён</option>
            </select>

            {activeJobId && !running && (
              <button
                onClick={handleExport}
                className="inline-flex items-center gap-1.5 rounded-lg bg-gray-900 px-3.5 py-1.5 text-sm font-medium text-white transition-colors hover:bg-gray-800"
              >
                <ArrowDownToLine className="h-4 w-4" />
                Экспорт в Базы
              </button>
            )}

            {activeJob && (
              <span className="text-xs text-gray-400">
                Job: {modeLabel(activeJob.mode)} &middot; {activeJob.status}
              </span>
            )}
          </div>

          {/* candidates table */}
          <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
            {loading ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
              </div>
            ) : candidates.length === 0 ? (
              <div className="py-16 text-center text-gray-400">
                <AlertTriangle className="h-8 w-8 mx-auto mb-2" />
                <p className="text-lg font-medium">Нет кандидатов</p>
                <p className="mt-1 text-sm">Запустите поиск во вкладке «Настройка».</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100 bg-gray-50/50 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                      <th className="w-8 px-3 py-3" />
                      <th className="px-3 py-3">Компания</th>
                      <th className="px-3 py-3">Город</th>
                      <th className="px-3 py-3 text-center">Рейтинг</th>
                      <th className="px-3 py-3 text-center">Отзывов</th>
                      <th className="px-3 py-3 text-center">Pain</th>
                      <th className="px-3 py-3 text-center">Conf.</th>
                      <th className="px-3 py-3 text-center">Статус</th>
                      <th className="px-3 py-3 text-center">Действия</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {candidates.map((c) => {
                      const cl = classLabel(c.classification);
                      const expanded = expandedId === c.id;
                      return (
                        <CandidateRows
                          key={c.id}
                          c={c}
                          expanded={expanded}
                          cl={cl}
                          onToggle={() => setExpandedId(expanded ? null : c.id)}
                          onReview={handleReview}
                        />
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ═══════════ sub-components ═══════════ */

function CandidateRows({
  c,
  expanded,
  cl,
  onToggle,
  onReview,
}: {
  c: ReputationCandidateRow;
  expanded: boolean;
  cl: { text: string; cls: string };
  onToggle: () => void;
  onReview: (id: string, d: 'accept' | 'reject') => void;
}) {
  return (
    <>
      <tr className="hover:bg-gray-50/50 cursor-pointer" onClick={onToggle}>
        <td className="px-3 py-2.5 text-gray-400">
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </td>
        <td className="px-3 py-2.5 font-medium text-gray-900 max-w-[200px] truncate">{c.company}</td>
        <td className="px-3 py-2.5 text-gray-600">
          {c.city && (
            <span className="inline-flex items-center gap-1">
              <MapPin className="h-3 w-3" /> {c.city}
            </span>
          )}
        </td>
        <td className="px-3 py-2.5 text-center">
          {c.rating != null && c.rating > 0 ? (
            <span className="inline-flex items-center gap-0.5">
              <Star className="h-3 w-3 text-amber-400 fill-amber-400" /> {c.rating}
            </span>
          ) : '—'}
        </td>
        <td className="px-3 py-2.5 text-center text-gray-600">{c.reviews_count}</td>
        <td className="px-3 py-2.5 text-center">
          <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${painBadge(c.pain_score)}`}>
            {c.pain_score}
          </span>
        </td>
        <td className="px-3 py-2.5 text-center">
          <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${confBadge(c.confidence_score)}`}>
            {c.confidence_score}
          </span>
        </td>
        <td className="px-3 py-2.5 text-center">
          <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${cl.cls}`}>{cl.text}</span>
        </td>
        <td className="px-3 py-2.5 text-center" onClick={(e) => e.stopPropagation()}>
          {c.classification === 'review' && !c.review_decision && (
            <div className="flex items-center justify-center gap-1">
              <button
                onClick={() => onReview(c.id, 'accept')}
                className="rounded p-1 text-green-600 hover:bg-green-50 transition-colors"
                title="Принять"
              >
                <ThumbsUp className="h-4 w-4" />
              </button>
              <button
                onClick={() => onReview(c.id, 'reject')}
                className="rounded p-1 text-red-500 hover:bg-red-50 transition-colors"
                title="Отклонить"
              >
                <ThumbsDown className="h-4 w-4" />
              </button>
            </div>
          )}
          {c.review_decision === 'accept' && <CheckCircle2 className="h-4 w-4 text-green-500 mx-auto" />}
          {c.review_decision === 'reject' && <XCircle className="h-4 w-4 text-red-400 mx-auto" />}
        </td>
      </tr>

      {expanded && (
        <tr>
          <td colSpan={9} className="bg-gray-50 px-6 py-4">
            <div className="grid gap-3 sm:grid-cols-2 text-xs">
              <div>
                <p className="font-medium text-gray-700 mb-1">Категория</p>
                <p className="text-gray-600">{c.category || '—'}</p>
              </div>
              <div>
                <p className="font-medium text-gray-700 mb-1">Сайт</p>
                {c.website ? (
                  <a href={c.website} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline inline-flex items-center gap-1">
                    {c.website} <ExternalLink className="h-3 w-3" />
                  </a>
                ) : <p className="text-gray-400">—</p>}
              </div>
              <div>
                <p className="font-medium text-gray-700 mb-1">Негатив 30д / 90д / Без ответа</p>
                <p className="text-gray-600">{c.negative_reviews_30d} / {c.negative_reviews_90d} / {c.unanswered_negative_reviews}</p>
              </div>
              <div>
                <p className="font-medium text-gray-700 mb-1">Негатив SERP top-10</p>
                <p className="text-gray-600">{c.negative_serp_results_top10}</p>
              </div>
              {c.issue_themes.length > 0 && (
                <div className="sm:col-span-2">
                  <p className="font-medium text-gray-700 mb-1">Темы проблем</p>
                  <div className="flex flex-wrap gap-1">
                    {c.issue_themes.map((t, i) => (
                      <span key={i} className="rounded bg-red-100 px-1.5 py-0.5 text-red-700">{t}</span>
                    ))}
                  </div>
                </div>
              )}
              {c.proof_urls.length > 0 && (
                <div className="sm:col-span-2">
                  <p className="font-medium text-gray-700 mb-1">Proof URLs</p>
                  <div className="space-y-0.5">
                    {c.proof_urls.map((url, i) => (
                      <a key={i} href={url} target="_blank" rel="noreferrer" className="block text-blue-600 hover:underline truncate">
                        {url}
                      </a>
                    ))}
                  </div>
                </div>
              )}
              {c.proof_snippets.length > 0 && (
                <div className="sm:col-span-2">
                  <p className="font-medium text-gray-700 mb-1">Сниппеты</p>
                  {c.proof_snippets.map((s, i) => (
                    <p key={i} className="text-gray-600 italic border-l-2 border-red-200 pl-2 mb-1">&ldquo;{s}&rdquo;</p>
                  ))}
                </div>
              )}
              <div>
                <p className="font-medium text-gray-700 mb-1">Источник</p>
                {c.primary_source_url ? (
                  <a href={c.primary_source_url} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline inline-flex items-center gap-1">
                    <Eye className="h-3 w-3" /> {c.primary_source}
                  </a>
                ) : <p className="text-gray-400">{c.primary_source}</p>}
              </div>
              <div>
                <p className="font-medium text-gray-700 mb-1">Второй источник</p>
                <p className="text-gray-600">{c.second_source_confirmed ? 'Подтверждён' : 'Нет'}</p>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function ModeCard({
  active,
  icon,
  title,
  desc,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  title: string;
  desc: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 rounded-lg border-2 p-4 text-left transition-all ${
        active
          ? 'border-gray-900 bg-gray-50 shadow-sm'
          : 'border-gray-200 bg-white hover:border-gray-300'
      }`}
    >
      <div className={`mb-2 ${active ? 'text-gray-900' : 'text-gray-400'}`}>{icon}</div>
      <p className={`text-sm font-semibold ${active ? 'text-gray-900' : 'text-gray-700'}`}>{title}</p>
      <p className="text-xs text-gray-500 mt-0.5">{desc}</p>
    </button>
  );
}

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className={`rounded-lg p-3 ${color}`}>
      <p className="text-2xl font-bold">{value}</p>
      <p className="text-xs font-medium opacity-75">{label}</p>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { cls: string; label: string }> = {
    pending: { cls: 'bg-gray-100 text-gray-600', label: 'Ожидание' },
    running: { cls: 'bg-blue-100 text-blue-700', label: 'В работе' },
    completed: { cls: 'bg-green-100 text-green-700', label: 'Готово' },
    failed: { cls: 'bg-red-100 text-red-700', label: 'Ошибка' },
  };
  const { cls, label } = map[status] ?? { cls: 'bg-gray-100 text-gray-600', label: status };
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{label}</span>;
}
