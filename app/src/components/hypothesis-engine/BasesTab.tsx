'use client';

/**
 * Вкладка «Базы»: загрузка CSV/XLSX под вертикаль (парсинг в браузере через
 * readSpreadsheetFile, как в /client/launch), превью первых строк, статус
 * анализа базы, профиль анализа и сборка финального шаблона 85/15.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { Database, FileSpreadsheet, Loader2, Sparkles, Upload, X } from 'lucide-react';
import type { HeBaseAnalysis, HeDistributionEntry, HeTemplate, HeVertical } from '@/lib/hypothesisEngine/types';
import { readSpreadsheetFile } from '@/lib/spreadsheet/parseCSV';
import { CLIENT_LAUNCH_ROW_LIMIT } from '@/lib/clientLaunch/constants';
import { watchedJobState, type HeBaseSummary, type HeJobSummary } from './api';
import type { BaseUploadPayload } from './ProjectDetail';
import { TemplateView } from './TemplateView';
import { Badge, type BadgeTone, formatDate } from './ui';

const BASE_STATUS_META: Record<string, { label: string; tone: BadgeTone }> = {
  uploaded: { label: 'Загружена', tone: 'gray' },
  analyzing: { label: 'Анализ…', tone: 'amber' },
  analyzed: { label: 'Проанализирована', tone: 'emerald' },
  failed: { label: 'Ошибка', tone: 'red' },
};

interface ParsedFile {
  filename: string;
  columns: string[];
  rows: Array<Record<string, string>>;
}

interface BasesTabProps {
  verticals: HeVertical[];
  bases: HeBaseSummary[];
  templates: HeTemplate[];
  jobs: HeJobSummary[];
  templateJobs: Record<string, string>;
  onUpload: (payload: BaseUploadPayload) => Promise<void>;
  onBuildTemplate: (baseId: string) => Promise<void>;
}

export function BasesTab({
  verticals,
  bases,
  templates,
  jobs,
  templateJobs,
  onUpload,
  onBuildTemplate,
}: BasesTabProps) {
  const [verticalId, setVerticalId] = useState('');
  const [parsed, setParsed] = useState<ParsedFile | null>(null);
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [selectedBaseId, setSelectedBaseId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const effectiveVerticalId = verticalId || verticals[0]?.id || '';

  const sortedBases = useMemo(
    () => [...bases].sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [bases],
  );
  const selectedBase = sortedBases.find((b) => b.id === selectedBaseId) ?? sortedBases[0];
  const verticalName = useCallback(
    (id: string) => verticals.find((v) => v.id === id)?.name ?? '—',
    [verticals],
  );

  const handleFile = useCallback(async (file: File) => {
    setParseError('');
    setParsed(null);
    setParsing(true);
    try {
      const grid = await readSpreadsheetFile(file);
      if (grid.length < 2) {
        setParseError('Файл пустой или содержит только заголовок');
        return;
      }
      const dataRows = grid.slice(1);
      if (dataRows.length > CLIENT_LAUNCH_ROW_LIMIT) {
        setParseError(
          `Лимит ${CLIENT_LAUNCH_ROW_LIMIT.toLocaleString('ru-RU')} строк. В файле ${dataRows.length.toLocaleString('ru-RU')} строк.`,
        );
        return;
      }
      const headers = grid[0].map((h, i) => String(h ?? '').trim() || `col_${i + 1}`);
      const rows: Array<Record<string, string>> = dataRows.map((r) => {
        const obj: Record<string, string> = {};
        headers.forEach((h, i) => {
          obj[h] = String(r[i] ?? '');
        });
        return obj;
      });
      setParsed({ filename: file.name, columns: headers, rows });
    } catch (err) {
      setParseError(err instanceof Error ? err.message : 'Ошибка при чтении файла');
    } finally {
      setParsing(false);
    }
  }, []);

  const handleUpload = useCallback(async () => {
    if (!parsed || !effectiveVerticalId || uploading) return;
    setUploadError('');
    setUploading(true);
    try {
      await onUpload({
        vertical_id: effectiveVerticalId,
        filename: parsed.filename,
        columns: parsed.columns,
        rows: parsed.rows,
      });
      setParsed(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Не удалось загрузить базу');
    } finally {
      setUploading(false);
    }
  }, [parsed, effectiveVerticalId, uploading, onUpload]);

  if (verticals.length === 0) {
    return (
      <div className="flex min-h-[180px] flex-col items-center justify-center rounded-2xl border border-dashed border-gray-200 bg-gray-50/50 p-10 text-center">
        <Database className="mb-3 h-8 w-8 text-gray-300" aria-hidden />
        <p className="text-sm font-medium text-gray-500">Сначала нужны вертикали</p>
        <p className="mt-1 text-xs text-gray-400">
          База загружается под конкретную вертикаль — запустите исследование и дождитесь кластеризации.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Загрузка новой базы */}
      <div className="rounded-2xl border border-gray-200 bg-white p-5">
        <p className="text-sm font-medium text-gray-700">Загрузить базу специалиста</p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <select
            value={effectiveVerticalId}
            onChange={(e) => setVerticalId(e.target.value)}
            aria-label="Вертикаль"
            className="h-[42px] rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-700 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100"
          >
            {verticals.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
          <label
            className={`inline-flex h-[42px] flex-1 cursor-pointer items-center gap-2 rounded-lg border border-dashed border-gray-300 px-3 text-sm text-gray-500 transition hover:border-blue-300 hover:text-gray-700 ${
              parsing ? 'pointer-events-none opacity-60' : ''
            }`}
          >
            {parsing ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Upload className="h-4 w-4" aria-hidden />
            )}
            {parsed ? parsed.filename : 'CSV, TSV или XLSX (до 10 000 строк)'}
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.tsv,.xlsx,.xls,.txt"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleFile(file);
              }}
            />
          </label>
          <button
            type="button"
            onClick={() => void handleUpload()}
            disabled={!parsed || uploading || parsing}
            className="inline-flex h-[42px] items-center justify-center gap-2 rounded-lg bg-blue-600 px-5 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {uploading ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <FileSpreadsheet className="h-4 w-4" aria-hidden />
            )}
            Загрузить базу
          </button>
        </div>

        {parseError ? (
          <p className="mt-2 text-sm text-red-600" role="alert">
            {parseError}
          </p>
        ) : null}
        {uploadError ? (
          <p className="mt-2 text-sm text-red-600" role="alert">
            {uploadError}
          </p>
        ) : null}

        {/* Превью файла */}
        {parsed ? (
          <div className="mt-4">
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-xs text-gray-500">
                Строк: <span className="font-semibold text-gray-700">{parsed.rows.length.toLocaleString('ru-RU')}</span>
                {' · '}Колонок: <span className="font-semibold text-gray-700">{parsed.columns.length}</span>
                {' · '}первые 5 строк:
              </p>
              <button
                type="button"
                onClick={() => {
                  setParsed(null);
                  if (fileInputRef.current) fileInputRef.current.value = '';
                }}
                className="inline-flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600"
              >
                <X className="h-3.5 w-3.5" aria-hidden />
                Убрать файл
              </button>
            </div>
            <div className="overflow-x-auto rounded-lg border border-gray-200">
              <table className="min-w-full divide-y divide-gray-200 text-xs">
                <thead className="bg-gray-50">
                  <tr>
                    {parsed.columns.map((col) => (
                      <th
                        key={col}
                        className="whitespace-nowrap px-3 py-2 text-left font-semibold uppercase tracking-wider text-gray-500"
                      >
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 bg-white">
                  {parsed.rows.slice(0, 5).map((row, ri) => (
                    <tr key={ri}>
                      {parsed.columns.map((col) => (
                        <td key={col} className="max-w-[200px] truncate px-3 py-2 text-gray-700">
                          {row[col]}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </div>

      {/* Список баз */}
      {sortedBases.length > 0 ? (
        <div className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-widest text-gray-400">
            Базы проекта ({sortedBases.length})
          </p>
          <div className="flex flex-wrap gap-2">
            {sortedBases.map((base) => {
              const meta = BASE_STATUS_META[base.status] ?? BASE_STATUS_META.uploaded;
              const active = selectedBase?.id === base.id;
              return (
                <button
                  key={base.id}
                  type="button"
                  onClick={() => setSelectedBaseId(base.id)}
                  className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-xs transition ${
                    active
                      ? 'border-blue-300 bg-blue-50/60'
                      : 'border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50'
                  }`}
                >
                  <span className="min-w-0">
                    <span className="block max-w-[220px] truncate font-medium text-gray-800">{base.filename}</span>
                    <span className="block text-[11px] text-gray-400">
                      {verticalName(base.vertical_id)} · {base.row_count.toLocaleString('ru-RU')} строк ·{' '}
                      {formatDate(base.created_at)}
                    </span>
                  </span>
                  {base.status === 'analyzing' ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-500" aria-hidden />
                  ) : (
                    <Badge tone={meta.tone}>{meta.label}</Badge>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {/* Выбранная база: анализ + шаблон */}
      {selectedBase ? (
        <BaseDetail
          base={selectedBase}
          templates={templates.filter((t) => t.base_id === selectedBase.id)}
          jobs={jobs}
          templateJobId={templateJobs[selectedBase.id]}
          onBuildTemplate={onBuildTemplate}
        />
      ) : null}
    </div>
  );
}

function BaseDetail({
  base,
  templates,
  jobs,
  templateJobId,
  onBuildTemplate,
}: {
  base: HeBaseSummary;
  templates: HeTemplate[];
  jobs: HeJobSummary[];
  templateJobId: string | undefined;
  onBuildTemplate: (baseId: string) => Promise<void>;
}) {
  const [buildError, setBuildError] = useState('');
  const [starting, setStarting] = useState(false);

  const template = useMemo(() => {
    let best: HeTemplate | undefined;
    for (const t of templates) {
      if (!best || t.created_at > best.created_at) best = t;
    }
    return best;
  }, [templates]);

  const templateJobState = watchedJobState(jobs, templateJobId);
  const templateJobError =
    templateJobState === 'failed'
      ? (jobs.find((j) => j.id === templateJobId)?.error ?? null)
      : null;
  const templateBusy = starting || templateJobState === 'active' || template?.status === 'draft';

  const handleBuild = useCallback(async () => {
    setBuildError('');
    setStarting(true);
    try {
      await onBuildTemplate(base.id);
    } catch (err) {
      setBuildError(err instanceof Error ? err.message : 'Не удалось запустить сборку шаблона');
    } finally {
      setStarting(false);
    }
  }, [base.id, onBuildTemplate]);

  return (
    <div className="space-y-4">
      {/* Анализ базы */}
      {base.status === 'failed' ? (
        <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
          Анализ базы завершился ошибкой. Загрузите базу ещё раз.
        </p>
      ) : base.status !== 'analyzed' ? (
        <p className="flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-600">
          <Loader2 className="h-4 w-4 animate-spin text-gray-400" aria-hidden />
          Анализируем базу — обычно до минуты…
        </p>
      ) : base.analysis ? (
        <AnalysisView analysis={base.analysis} />
      ) : null}

      {/* Шаблон */}
      {base.status === 'analyzed' ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void handleBuild()}
              disabled={templateBusy}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {templateBusy ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Sparkles className="h-4 w-4" aria-hidden />
              )}
              {template ? 'Пересобрать шаблон' : 'Собрать шаблон'}
            </button>
            {templateBusy ? (
              <span className="text-xs text-gray-400">AI собирает шаблон 85/15 — 1–2 минуты…</span>
            ) : null}
          </div>
          {buildError ? (
            <p className="text-sm text-red-600" role="alert">
              {buildError}
            </p>
          ) : null}
          {templateJobError ? (
            <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
              Сборка шаблона завершилась ошибкой: {templateJobError}
            </p>
          ) : null}
          {template ? <TemplateView template={template} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function DistributionList({ title, entries }: { title: string; entries: HeDistributionEntry[] }) {
  if (!entries || entries.length === 0) return null;
  const top = entries.slice(0, 8);
  const max = Math.max(...top.map((e) => e.share_pct), 1);
  return (
    <div>
      <p className="mb-1.5 text-xs font-semibold uppercase tracking-widest text-gray-400">{title}</p>
      <ul className="space-y-1">
        {top.map((e) => (
          <li key={e.value} className="flex items-center gap-2 text-xs">
            <span className="w-40 truncate text-gray-700" title={e.value}>
              {e.value}
            </span>
            <span className="h-2 flex-1 overflow-hidden rounded-full bg-gray-100">
              <span
                className="block h-full rounded-full bg-blue-400"
                style={{ width: `${Math.max(4, (e.share_pct / max) * 100)}%` }}
              />
            </span>
            <span className="w-10 text-right text-gray-500">{e.share_pct}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AnalysisView({ analysis }: { analysis: HeBaseAnalysis }) {
  return (
    <div className="space-y-4 rounded-2xl border border-gray-200 bg-white p-5">
      <p className="text-sm font-semibold text-gray-800">Профиль базы</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <DistributionList title="География" entries={analysis.geo_distribution} />
        <DistributionList title="Индустрии" entries={analysis.industry_distribution} />
        <DistributionList title="Типы компаний" entries={analysis.company_type_distribution} />
        <DistributionList title="Должности" entries={analysis.title_distribution} />
      </div>
      {analysis.notable_segments.length > 0 ? (
        <div>
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-widest text-gray-400">
            Заметные сегменты
          </p>
          <div className="flex flex-wrap gap-1">
            {analysis.notable_segments.map((s) => (
              <span key={s} className="rounded bg-violet-100 px-1.5 py-0.5 text-[11px] text-violet-700">
                {s}
              </span>
            ))}
          </div>
        </div>
      ) : null}
      {analysis.data_quality_notes ? (
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-widest text-gray-400">Качество данных</p>
          <p className="text-sm leading-relaxed text-gray-600">{analysis.data_quality_notes}</p>
        </div>
      ) : null}
      {analysis.recommended_angles.length > 0 ? (
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-widest text-gray-400">
            Рекомендуемые углы (основа 15% дописки)
          </p>
          <ul className="list-disc space-y-1 pl-5 text-sm text-gray-600 marker:text-gray-300">
            {analysis.recommended_angles.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
