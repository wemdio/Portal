'use client';

import { useCallback, useEffect, useState } from 'react';
import { authFetch } from '@/lib/authFetch';
import { YD_PRESETS, YD_REGIONS } from '@/lib/parsers/yandexDirect/regions';

/**
 * Yandex Direct Parser UI — вкладка парсера рекламодателей Яндекс Директа.
 *
 * Находит компании, которые крутят платную рекламу по нишевым ключам —
 * готовые «тёплые» лиды (платят за рекламу → есть маркетинговый бюджет).
 *
 * Два режима ключей:
 *  - manual — список ключей задаётся руками;
 *  - ai     — Requesty/Claude генерит ключи по описанию аудитории.
 */

interface YDJob {
  id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
  niche: string;
  keyword_mode: 'manual' | 'ai';
  audience: string;
  keywords: string[];
  regions: string[];
  include_organic: boolean;
  total_requests: number;
  processed_requests: number;
  found_advertisers: number;
  saved_total: number;
  errors_count: number;
  error_message: string | null;
  created_at: string;
}

const DEFAULT_KEYWORDS = `crm для бизнеса
сквозная аналитика
коллтрекинг`;

export function YandexDirectParserView() {
  const [niche, setNiche] = useState('');
  const [keywordMode, setKeywordMode] = useState<'manual' | 'ai'>('manual');
  const [keywordsRaw, setKeywordsRaw] = useState(DEFAULT_KEYWORDS);
  const [audience, setAudience] = useState('');
  const [nSeeds, setNSeeds] = useState(20);
  const [expandSuggest, setExpandSuggest] = useState(true);
  const [includeOrganic, setIncludeOrganic] = useState(false);
  const [preset, setPreset] = useState<string>('msk');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [jobs, setJobs] = useState<YDJob[]>([]);
  const [activeJob, setActiveJob] = useState<YDJob | null>(null);

  const keywords = keywordsRaw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  const loadJobs = useCallback(async () => {
    try {
      const res = await authFetch('/api/parsers/yandex-direct');
      if (!res.ok) return;
      const { jobs: items } = (await res.json()) as { jobs: YDJob[] };
      setJobs(items);
      const active = items.find((j) => j.status === 'pending' || j.status === 'processing');
      if (active) setActiveJob(active);
      else if (activeJob) {
        setActiveJob(items.find((j) => j.id === activeJob.id) ?? null);
      }
    } catch { /* ignore */ }
  }, [activeJob]);

  useEffect(() => { void loadJobs(); }, [loadJobs]);

  // Поллинг активной задачи раз в 3 сек
  useEffect(() => {
    if (!activeJob) return;
    if (['completed', 'failed', 'cancelled'].includes(activeJob.status)) return;
    const t = setInterval(() => { void loadJobs(); }, 3000);
    return () => clearInterval(t);
  }, [activeJob, loadJobs]);

  const handleStart = async () => {
    setError('');
    if (keywordMode === 'manual' && keywords.length === 0) {
      setError('Введите хотя бы одно ключевое слово');
      return;
    }
    if (keywordMode === 'ai' && !audience.trim()) {
      setError('Для AI-режима опишите аудиторию');
      return;
    }
    setSubmitting(true);
    try {
      const res = await authFetch('/api/parsers/yandex-direct', {
        method: 'POST',
        body: JSON.stringify({
          niche,
          keyword_mode: keywordMode,
          keywords: keywordMode === 'manual' ? keywords : [],
          audience,
          n_seeds: nSeeds,
          expand_suggest: expandSuggest,
          include_organic: includeOrganic,
          regions: [preset],
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Ошибка запуска' }));
        throw new Error(data.error ?? 'Ошибка запуска');
      }
      const { job } = (await res.json()) as { job: YDJob };
      setActiveJob(job);
      void loadJobs();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка запуска');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = async (id: string) => {
    await authFetch(`/api/parsers/yandex-direct/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ action: 'cancel' }),
    });
    void loadJobs();
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Удалить задачу и её результаты?')) return;
    await authFetch(`/api/parsers/yandex-direct/${id}`, { method: 'DELETE' });
    if (activeJob?.id === id) setActiveJob(null);
    void loadJobs();
  };

  const handleExport = async (jobId: string) => {
    let offset = 0;
    const LIMIT = 5000;
    const all: { niche: string; domain: string; title: string; ad_text: string; url: string; region: string; keyword: string; block: string; source: string }[] = [];
    for (;;) {
      const res = await authFetch(`/api/parsers/yandex-direct/${jobId}/results?limit=${LIMIT}&offset=${offset}`);
      if (!res.ok) { setError('Не удалось загрузить результаты'); return; }
      const { results, total } = (await res.json()) as { results: typeof all; total: number };
      all.push(...results);
      offset += results.length;
      if (results.length === 0 || offset >= total) break;
    }
    if (all.length === 0) { setError('Пусто'); return; }

    const headers = ['Ниша', 'Домен', 'Сайт_URL', 'Заголовок', 'Текст_объявления', 'Регион', 'Ключевой_запрос', 'Блок', 'Источник'];
    const lines = [headers.join(',')];
    for (const r of all) {
      const row = [r.niche, r.domain, `https://${r.domain}`, r.title, r.ad_text, r.region, r.keyword, r.block, r.source]
        .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`);
      lines.push(row.join(','));
    }
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `yandex-direct-${jobId.slice(0, 8)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const isRunning = activeJob && (activeJob.status === 'pending' || activeJob.status === 'processing');
  const progress = activeJob && activeJob.total_requests > 0
    ? Math.round((activeJob.processed_requests / activeJob.total_requests) * 100)
    : 0;
  const presetRegionCount = YD_PRESETS[preset]?.aliases.length ?? 1;
  const estRequests = keywordMode === 'manual'
    ? keywords.length * presetRegionCount
    : null;

  return (
    <div className="space-y-6">
      <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-900">
        <strong>Яндекс Директ:</strong> ищет компании, которые крутят платную рекламу
        по нишевым ключам — это «тёплые» лиды (раз платят за рекламу → есть маркетинговый
        бюджет). Один домен = одна строка. Агрегаторы и job-борды отфильтрованы.
      </div>

      <div className="bg-white rounded-lg border border-gray-200 p-5 space-y-4">
        <div>
          <label className="block text-sm font-semibold text-gray-700 mb-1">Ниша (метка)</label>
          <input
            type="text"
            value={niche}
            onChange={(e) => setNiche(e.target.value)}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
            placeholder="например: IT-аутсорс, SaaS, юр. услуги"
          />
          <p className="text-xs text-gray-500 mt-1">Попадёт в каждую строку результатов — удобно фильтровать разные запуски.</p>
        </div>

        {/* Режим ключей */}
        <div>
          <label className="block text-sm font-semibold text-gray-700 mb-1">Ключевые слова</label>
          <div className="inline-flex rounded-lg border border-gray-200 bg-gray-50 p-1 mb-2">
            <button
              type="button"
              onClick={() => setKeywordMode('manual')}
              className={`px-3 py-1 text-sm rounded-md ${keywordMode === 'manual' ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500'}`}
            >
              Список вручную
            </button>
            <button
              type="button"
              onClick={() => setKeywordMode('ai')}
              className={`px-3 py-1 text-sm rounded-md ${keywordMode === 'ai' ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500'}`}
            >
              AI-генерация
            </button>
          </div>

          {keywordMode === 'manual' ? (
            <>
              <textarea
                value={keywordsRaw}
                onChange={(e) => setKeywordsRaw(e.target.value)}
                rows={6}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm font-mono"
                placeholder="crm для бизнеса&#10;сквозная аналитика"
              />
              <p className="text-xs text-gray-500 mt-1">{keywords.length} ключ(а/ей), по одному на строку. Макс 500.</p>
            </>
          ) : (
            <>
              <textarea
                value={audience}
                onChange={(e) => setAudience(e.target.value)}
                rows={3}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
                placeholder="Опиши кого ищем — например: B2B SaaS-платформы для автоматизации продаж"
              />
              <div className="flex items-center gap-4 mt-2">
                <label className="text-xs text-gray-600 flex items-center gap-1">
                  Seed-ключей:
                  <input
                    type="number"
                    value={nSeeds}
                    onChange={(e) => setNSeeds(Math.max(1, Math.min(60, Number(e.target.value) || 20)))}
                    className="w-16 rounded border border-gray-200 px-2 py-1 font-mono"
                    min={1}
                    max={60}
                  />
                </label>
                <label className="text-xs text-gray-600 flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={expandSuggest}
                    onChange={(e) => setExpandSuggest(e.target.checked)}
                  />
                  Расширять через Yandex Suggest
                </label>
              </div>
              <p className="text-xs text-gray-500 mt-1">Claude (через Requesty) придумает ключи по описанию.</p>
            </>
          )}
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-1">Регионы</label>
            <select
              value={preset}
              onChange={(e) => setPreset(e.target.value)}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
            >
              {Object.entries(YD_PRESETS).map(([key, p]) => (
                <option key={key} value={key}>{p.label}</option>
              ))}
              {YD_REGIONS.filter((r) => r.group === 'Города').map((r) => (
                <option key={r.alias} value={r.alias}>Город: {r.name}</option>
              ))}
            </select>
            <p className="text-xs text-gray-500 mt-1">{presetRegionCount} регион(а/ов)</p>
          </div>
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-1">Доп. опции</label>
            <label className="text-sm text-gray-700 flex items-center gap-2 mt-2">
              <input
                type="checkbox"
                checked={includeOrganic}
                onChange={(e) => setIncludeOrganic(e.target.checked)}
              />
              Включить органику (топ сайтов)
            </label>
            <p className="text-xs text-gray-500 mt-1">Сайты из топа поиска — часто тоже крутят рекламу.</p>
          </div>
        </div>

        {estRequests !== null && (
          <div className="text-xs text-gray-500">
            Запросов к XMLStock: ~{estRequests.toLocaleString()} (≈{(estRequests * 0.02).toFixed(1)} ₽)
          </div>
        )}

        <button
          onClick={() => void handleStart()}
          disabled={submitting || !!isRunning}
          className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {submitting ? 'Запускаем…' : isRunning ? 'Уже идёт задача…' : '▶ Запустить парсинг'}
        </button>

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
            {error}
          </div>
        )}
      </div>

      {/* Активная задача */}
      {activeJob && isRunning && (
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-semibold">
              {activeJob.status === 'pending' ? 'В очереди' : 'Парсинг'}: {activeJob.processed_requests}/{activeJob.total_requests} запросов
            </span>
            <button
              onClick={() => void handleCancel(activeJob.id)}
              className="text-xs text-red-600 hover:text-red-700"
            >
              Отменить
            </button>
          </div>
          <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
            <div className="h-full bg-blue-500 transition-all" style={{ width: `${progress}%` }} />
          </div>
          <div className="text-xs text-gray-500 mt-2">
            Найдено реклам: {activeJob.found_advertisers} · Уникальных доменов: {activeJob.saved_total}
            {activeJob.errors_count > 0 && <> · Ошибок: {activeJob.errors_count}</>}
          </div>
        </div>
      )}

      {/* История */}
      {jobs.length > 0 && (
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">История задач</h3>
          <div className="space-y-2">
            {jobs.map((j) => (
              <div key={j.id} className="flex items-center justify-between p-3 rounded-lg border border-gray-100">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm">
                    <StatusBadge status={j.status} />
                    <span className="text-gray-700 truncate">{j.niche || '(без ниши)'}</span>
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {j.keyword_mode === 'ai' ? 'AI-ключи' : `${j.keywords.length} ключей`}
                    {' · '}{j.saved_total.toLocaleString()} уник. доменов
                    {j.errors_count > 0 && <> · <span className="text-amber-700">ошибок: {j.errors_count}</span></>}
                  </div>
                  {j.status === 'failed' && j.error_message && (
                    <div className="text-xs text-red-600 mt-0.5">{j.error_message}</div>
                  )}
                </div>
                <div className="flex gap-2 shrink-0">
                  {j.status === 'completed' && j.saved_total > 0 && (
                    <button
                      onClick={() => void handleExport(j.id)}
                      className="text-xs text-blue-600 hover:text-blue-700"
                    >
                      Экспорт CSV
                    </button>
                  )}
                  {(j.status === 'pending' || j.status === 'processing') && (
                    <button onClick={() => void handleCancel(j.id)} className="text-xs text-red-600">
                      Отменить
                    </button>
                  )}
                  {(j.status === 'completed' || j.status === 'failed' || j.status === 'cancelled') && (
                    <button
                      onClick={() => void handleDelete(j.id)}
                      className="text-xs text-gray-400 hover:text-red-600"
                    >
                      ✕
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: YDJob['status'] }) {
  const styles: Record<YDJob['status'], string> = {
    pending: 'bg-gray-100 text-gray-700',
    processing: 'bg-blue-100 text-blue-700',
    completed: 'bg-emerald-100 text-emerald-700',
    failed: 'bg-red-100 text-red-700',
    cancelled: 'bg-amber-100 text-amber-700',
  };
  const labels: Record<YDJob['status'], string> = {
    pending: 'В очереди',
    processing: 'Парсинг',
    completed: 'Готово',
    failed: 'Ошибка',
    cancelled: 'Отменено',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${styles[status]}`}>
      {labels[status]}
    </span>
  );
}
