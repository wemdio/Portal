'use client';

/**
 * Шаг 4 мастера «Движка вертикалей» — «База»: загрузка CSV/XLSX под вертикаль
 * (парсинг в браузере через readSpreadsheetFile, лимит строк как в
 * /client/launch), превью, статусы разбора, профиль последней разобранной
 * базы и запуск сборки финального шаблона. Поглощает старый BasesTab.
 */

import { useCallback, useMemo, useRef, useState, type JSX } from 'react';
import { ArrowRight, Check, FileSpreadsheet, Sparkles, Upload, X } from 'lucide-react';
import type { HeBaseAnalysis, HeDistributionEntry, HeVertical } from '@/lib/hypothesisEngine/types';
import { readSpreadsheetFile } from '@/lib/spreadsheet/parseCSV';
import { CLIENT_LAUNCH_ROW_LIMIT } from '@/lib/clientLaunch/constants';
import {
  HE_API,
  hePost,
  type HeBaseCreateResponse,
  type HeBaseSummary,
  type HeJobResponse,
  type HeJobSummary,
} from '../api';
import { Badge, Spinner, StatusBox, formatDate } from '../ui';

const PRIMARY_BTN =
  'inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-blue-600 px-5 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50';

interface ParsedFile {
  filename: string;
  columns: string[];
  rows: Array<Record<string, string>>;
}

/** Последняя джоба стадии (по started_at; записи без started_at считаются старыми). */
function latestStageJob(jobs: HeJobSummary[], stage: HeJobSummary['stage']): HeJobSummary | undefined {
  let best: HeJobSummary | undefined;
  for (const job of jobs) {
    if (job.stage !== stage) continue;
    if (!best || (job.started_at ?? '') >= (best.started_at ?? '')) best = job;
  }
  return best;
}

function jobActive(job: HeJobSummary | undefined): boolean {
  return job?.status === 'pending' || job?.status === 'running';
}

export function Step4Base(props: {
  projectId: string;
  vertical: HeVertical;
  bases: HeBaseSummary[];
  jobs: HeJobSummary[];
  onUploaded: () => void;
  onTemplateStarted: () => void;
  onGoToTemplate: () => void;
}): JSX.Element {
  const { projectId, vertical, bases, jobs, onUploaded, onTemplateStarted, onGoToTemplate } = props;

  const [parsed, setParsed] = useState<ParsedFile | null>(null);
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [templateStarting, setTemplateStarting] = useState(false);
  const [templateError, setTemplateError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const verticalBases = useMemo(
    () =>
      bases
        .filter((b) => b.vertical_id === vertical.id)
        .sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [bases, vertical.id],
  );
  const latestBase = verticalBases[0];
  const latestAnalyzed = useMemo(
    () => verticalBases.find((b) => b.status === 'analyzed' && b.analysis),
    [verticalBases],
  );

  const templateJob = useMemo(() => latestStageJob(jobs, 'template'), [jobs]);
  const templateBusy = templateStarting || jobActive(templateJob);
  const templateDone = !templateBusy && templateJob?.status === 'done';
  const templateFailed = !templateBusy && templateJob?.status === 'failed';

  const clearFile = useCallback(() => {
    setParsed(null);
    setParseError('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  const handleFile = useCallback(async (file: File) => {
    setParseError('');
    setUploadError('');
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
    if (!parsed || uploading) return;
    setUploadError('');
    setUploading(true);
    try {
      const { ok, data } = await hePost<HeBaseCreateResponse>(
        `${HE_API}/projects/${projectId}/bases`,
        {
          vertical_id: vertical.id,
          filename: parsed.filename,
          columns: parsed.columns,
          rows: parsed.rows,
        },
      );
      if (!ok) {
        setUploadError(data.error || 'Не удалось загрузить базу');
        return;
      }
      clearFile();
      onUploaded();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Не удалось загрузить базу');
    } finally {
      setUploading(false);
    }
  }, [parsed, uploading, projectId, vertical.id, clearFile, onUploaded]);

  const handleBuildTemplate = useCallback(async () => {
    if (!latestBase || templateBusy) return;
    setTemplateError('');
    setTemplateStarting(true);
    try {
      const { ok, data } = await hePost<HeJobResponse>(`${HE_API}/bases/${latestBase.id}/template`);
      if (!ok) {
        setTemplateError(data.error || 'Не удалось запустить сборку шаблона');
        return;
      }
      onTemplateStarted();
    } catch (err) {
      setTemplateError(err instanceof Error ? err.message : 'Не удалось запустить сборку шаблона');
    } finally {
      setTemplateStarting(false);
    }
  }, [latestBase, templateBusy, onTemplateStarted]);

  return (
    <div className="space-y-5">
      <p className="text-sm text-gray-500">
        Загрузите CSV или XLSX с контактами под эту вертикаль (до{' '}
        {CLIENT_LAUNCH_ROW_LIMIT.toLocaleString('ru-RU')} строк). Движок разберёт состав базы и
        подготовит финальный шаблон.
      </p>

      {/* Загрузка файла */}
      <section className="rounded-2xl border border-gray-200 bg-white p-5">
        <label
          className={`flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-gray-300 bg-gray-50/50 px-4 py-8 text-center transition hover:border-blue-300 hover:bg-blue-50/30 ${
            parsing ? 'pointer-events-none opacity-60' : ''
          }`}
        >
          {parsing ? (
            <Spinner className="h-6 w-6 text-gray-400" />
          ) : (
            <Upload className="h-6 w-6 text-gray-400" aria-hidden />
          )}
          <span className="text-sm font-medium text-gray-600">
            {parsing ? 'Читаем файл…' : parsed ? parsed.filename : 'Выберите файл с базой'}
          </span>
          <span className="text-xs text-gray-400">CSV, TSV или XLSX</span>
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

        {/* Превью распарсенного файла */}
        {parsed ? (
          <div className="mt-4">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-gray-500">
                <span className="font-semibold text-gray-700">
                  {parsed.rows.length.toLocaleString('ru-RU')}
                </span>{' '}
                строк · <span className="font-semibold text-gray-700">{parsed.columns.length}</span>{' '}
                колонок · первые 5 строк:
              </p>
              <button
                type="button"
                onClick={clearFile}
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
            <div className="mt-3 flex justify-end">
              <button
                type="button"
                onClick={() => void handleUpload()}
                disabled={uploading || parsing}
                className={PRIMARY_BTN}
              >
                {uploading ? (
                  <Spinner />
                ) : (
                  <FileSpreadsheet className="h-4 w-4" aria-hidden />
                )}
                Загрузить базу
              </button>
            </div>
          </div>
        ) : null}
      </section>

      {/* Список баз вертикали */}
      {verticalBases.length > 0 ? (
        <section className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-widest text-gray-400">
            Базы под эту вертикаль ({verticalBases.length})
          </p>
          <div className="flex flex-wrap gap-2">
            {verticalBases.map((base) => (
              <div
                key={base.id}
                className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2"
              >
                <span className="min-w-0">
                  <span className="block max-w-[220px] truncate text-xs font-medium text-gray-800">
                    {base.filename}
                  </span>
                  <span className="block text-[11px] text-gray-400">
                    {base.row_count.toLocaleString('ru-RU')} строк · {formatDate(base.created_at)}
                  </span>
                </span>
                {base.status === 'analyzing' ? (
                  <span className="inline-flex items-center gap-1 text-[11px] text-amber-600">
                    <Spinner className="h-3.5 w-3.5" />
                    Разбираем…
                  </span>
                ) : base.status === 'analyzed' ? (
                  <Badge tone="emerald">Разобрана</Badge>
                ) : base.status === 'failed' ? (
                  <Badge tone="red">Ошибка</Badge>
                ) : (
                  <Badge tone="gray">Загружена</Badge>
                )}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {latestBase?.status === 'failed' ? (
        <StatusBox tone="error">
          Разбор базы «{latestBase.filename}» завершился ошибкой. Загрузите файл ещё раз.
        </StatusBox>
      ) : null}

      {/* Профиль последней разобранной базы */}
      {latestAnalyzed?.analysis ? (
        <section className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-widest text-gray-400">
            Состав базы «{latestAnalyzed.filename}»
          </p>
          <BaseAnalysisCards analysis={latestAnalyzed.analysis} />
        </section>
      ) : null}

      {/* Переход к шаблону */}
      <section className="flex flex-wrap items-center gap-3 rounded-2xl border border-gray-200 bg-white p-5">
        {templateDone ? (
          <button type="button" onClick={onGoToTemplate} className={PRIMARY_BTN}>
            Перейти к шаблону
            <ArrowRight className="h-4 w-4" aria-hidden />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void handleBuildTemplate()}
            disabled={templateBusy || latestBase?.status !== 'analyzed'}
            className={PRIMARY_BTN}
          >
            {templateBusy ? <Spinner /> : <Sparkles className="h-4 w-4" aria-hidden />}
            {templateBusy ? 'Собираем шаблон…' : 'Собрать шаблон'}
            {!templateBusy ? <ArrowRight className="h-4 w-4" aria-hidden /> : null}
          </button>
        )}
        {templateBusy ? (
          <span className="text-xs text-gray-400">
            AI собирает боевой шаблон под базу — обычно 1–2 минуты.
          </span>
        ) : null}
        {!templateBusy && !templateDone && latestBase?.status !== 'analyzed' ? (
          <span className="text-xs text-gray-400">
            Кнопка станет активной, когда база будет разобрана.
          </span>
        ) : null}
      </section>
      {templateError ? <StatusBox tone="error">{templateError}</StatusBox> : null}
      {templateFailed ? (
        <StatusBox tone="error">
          Сборка шаблона завершилась ошибкой{templateJob?.error ? `: ${templateJob.error}` : '.'}{' '}
          Нажмите «Собрать шаблон», чтобы попробовать снова.
        </StatusBox>
      ) : null}
    </div>
  );
}

/* ─────────────────────────── Профиль базы ─────────────────────────── */

function BarList({
  title,
  entries,
}: {
  title: string;
  entries: HeDistributionEntry[] | undefined;
}) {
  const top = (entries ?? []).slice(0, 6);
  if (top.length === 0) return null;
  return (
    <div className="rounded-xl border border-gray-200 bg-gray-50/50 p-3">
      <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-gray-400">{title}</p>
      <ul className="space-y-1.5">
        {top.map((e) => (
          <li key={e.value} className="text-xs">
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-gray-700" title={e.value}>
                {e.value}
              </span>
              <span className="shrink-0 text-gray-400">{e.share_pct}%</span>
            </div>
            <span className="mt-0.5 block h-1.5 overflow-hidden rounded-full bg-gray-200/70">
              <span
                className="block h-full rounded-full bg-blue-400"
                style={{ width: `${Math.min(100, Math.max(3, e.share_pct))}%` }}
              />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function BaseAnalysisCards({ analysis }: { analysis: HeBaseAnalysis }) {
  const qualityItems = (analysis.data_quality_notes ?? '')
    .split(/\n+/)
    .map((s) => s.replace(/^[•\-–*]\s*/, '').trim())
    .filter(Boolean);
  const segments = analysis.notable_segments ?? [];
  const angles = analysis.recommended_angles ?? [];

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <BarList title="География" entries={analysis.geo_distribution} />
        <BarList title="Отрасли" entries={analysis.industry_distribution} />
        <BarList title="Типы компаний" entries={analysis.company_type_distribution} />
        <BarList title="Должности" entries={analysis.title_distribution} />
      </div>
      {segments.length > 0 ? (
        <div>
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-widest text-gray-400">
            Заметные сегменты
          </p>
          <div className="flex flex-wrap gap-1">
            {segments.map((s) => (
              <span key={s} className="rounded bg-violet-100 px-1.5 py-0.5 text-[11px] text-violet-700">
                {s}
              </span>
            ))}
          </div>
        </div>
      ) : null}
      {qualityItems.length > 0 ? (
        <div>
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-widest text-gray-400">
            Качество данных
          </p>
          <ul className="space-y-1">
            {qualityItems.map((note, i) => (
              <li key={i} className="flex items-start gap-1.5 text-xs text-gray-500">
                <Check className="mt-0.5 h-3 w-3 shrink-0 text-gray-300" aria-hidden />
                {note}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {angles.length > 0 ? (
        <div>
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-widest text-gray-400">
            Рекомендуемые углы для писем
          </p>
          <ul className="list-disc space-y-1 pl-5 text-sm text-gray-600 marker:text-gray-300">
            {angles.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
