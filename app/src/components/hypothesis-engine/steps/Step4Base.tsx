'use client';

/**
 * Шаг 4 мастера «Движка вертикалей» — «База»: загрузка CSV/XLSX под вертикаль
 * (парсинг в браузере через readSpreadsheetFile, лимит строк как в
 * /client/launch), превью, статусы разбора, профиль последней разобранной
 * базы и запуск сборки финального шаблона. Поглощает старый BasesTab.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { ArrowRight, Check, Download, Eye, EyeOff, FileSpreadsheet, Sparkles, Upload, X } from 'lucide-react';
import type { HeBaseAnalysis, HeDistributionEntry, HeVertical } from '@/lib/hypothesisEngine/types';
import { authFetch } from '@/lib/authFetch';
import { readSpreadsheetFile } from '@/lib/spreadsheet/parseCSV';
import { CLIENT_LAUNCH_ROW_LIMIT } from '@/lib/clientLaunch/constants';
import {
  HE_API,
  hePost,
  type HeBaseCollectResponse,
  type HeBaseCreateResponse,
  type HeBaseSummary,
  type HeCollectInfo,
  type HeJobResponse,
  type HeJobSummary,
} from '../api';
import { Badge, Spinner, StatusBox, formatDate } from '../ui';

const PRIMARY_BTN =
  'inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-blue-600 px-5 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50';

/** Как часто дёргать reload детали во время автосборки (как POLL_INTERVAL_MS родителя). */
const COLLECT_POLL_MS = 4000;

/** Лимит строк автосборки — выбор пользователя; route валидирует те же значения. */
type CollectLimit = 2000 | 10000 | 50000;
const COLLECT_LIMITS: readonly CollectLimit[] = [2000, 10000, 50000];
const DEFAULT_COLLECT_LIMIT: CollectLimit = 10000;

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
  const [collectStarting, setCollectStarting] = useState(false);
  const [collectError, setCollectError] = useState('');
  const [collectLimit, setCollectLimit] = useState<CollectLimit>(DEFAULT_COLLECT_LIMIT);
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

  /** Последняя база в статусе автосборки (verticalBases отсортированы по created_at desc). */
  const collectingBase = useMemo(
    () => verticalBases.find((b) => b.status === 'collecting'),
    [verticalBases],
  );
  /** Автосборка упала: последняя база вертикали — авто и в ошибке (retry уводит в re-POST). */
  const collectFailed =
    !collectingBase && latestBase?.source === 'auto' && latestBase.status === 'failed';

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

  const handleCollect = useCallback(async () => {
    if (collectStarting || collectingBase) return;
    setCollectError('');
    setCollectStarting(true);
    try {
      const { ok, data } = await hePost<HeBaseCollectResponse>(
        `${HE_API}/verticals/${vertical.id}/collect`,
        { limit: collectLimit },
      );
      if (!ok) {
        setCollectError(data.error || 'Не удалось запустить автосборку');
        return;
      }
      // 201 (сборка стартовала) и 200 (уже идёт) — в обоих случаях перечитываем деталь.
      onUploaded();
    } catch (err) {
      setCollectError(err instanceof Error ? err.message : 'Не удалось запустить автосборку');
    } finally {
      setCollectStarting(false);
    }
  }, [collectStarting, collectingBase, collectLimit, vertical.id, onUploaded]);

  // Сборка создаёт base_collect-джобу, и родительский поллинг по активным
  // джобам её уже покрывает; локальный интервал — запасной вариант поверх
  // него: если джоба выпала из выборки детали (лимит 30 последних jobs) или
  // родительский поллинг остановился, прогресс-карта сборки всё равно
  // обновляется. Когда сборка кончается, base_analyze поднимает джобу и
  // родительский поллинг подхватывает analyzing → analyzed.
  useEffect(() => {
    if (!collectingBase) return;
    const timer = setInterval(() => onUploaded(), COLLECT_POLL_MS);
    return () => clearInterval(timer);
  }, [collectingBase, onUploaded]);

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

      {/* Автосборка базы под вертикаль */}
      <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
        <p className="text-sm font-semibold text-gray-800">Или соберите автоматически</p>
        <p className="mt-1 text-xs text-gray-500">
          Движок сам подберёт источники: реестр компаний, hh.ru, карты — и соберёт базу под это
          направление.
        </p>
        {collectingBase ? (
          <CollectProgress base={collectingBase} />
        ) : (
          <div className="mt-3">
            {collectFailed ? (
              <p className="mb-2 text-sm text-red-600" role="alert">
                Автосборка завершилась ошибкой. Попробуйте ещё раз или загрузите файл вручную ниже.
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => void handleCollect()}
                disabled={collectStarting}
                className={PRIMARY_BTN}
              >
                {collectStarting ? <Spinner /> : <Sparkles className="h-4 w-4" aria-hidden />}
                {collectFailed ? 'Попробовать снова' : 'Собрать базу автоматически'}
              </button>
              <span className="inline-flex items-center gap-1 text-xs text-gray-500">
                <span className="mr-0.5">Строк:</span>
                {COLLECT_LIMITS.map((l) => (
                  <button
                    key={l}
                    type="button"
                    onClick={() => setCollectLimit(l)}
                    aria-pressed={collectLimit === l}
                    className={`rounded-md border px-2 py-1 text-xs font-medium transition ${
                      collectLimit === l
                        ? 'border-blue-600 bg-blue-600 text-white'
                        : 'border-gray-200 bg-white text-gray-600 hover:border-blue-300 hover:text-blue-600'
                    }`}
                  >
                    {l.toLocaleString('ru-RU')}
                  </button>
                ))}
              </span>
            </div>
            <p className="mt-1.5 text-[11px] text-gray-400">
              Больше строк — дольше сбор и больше файл.
            </p>
            {collectError ? (
              <p className="mt-2 text-sm text-red-600" role="alert">
                {collectError}
              </p>
            ) : null}
          </div>
        )}
      </section>

      {/* Загрузка файла */}
      <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
        <label
          className={`flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-gray-300 bg-gray-50/50 px-4 py-8 text-center transition hover:border-blue-300 hover:bg-blue-50/60 ${
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
          <div className="flex flex-wrap items-start gap-2">
            {verticalBases.map((base) => (
              <BaseCard key={base.id} base={base} />
            ))}
          </div>
        </section>
      ) : null}

      {latestBase?.status === 'failed' && latestBase.source !== 'auto' ? (
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
      <section className="flex flex-wrap items-center gap-3 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
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

/* ─────────────────────────── Карточка базы: скачать CSV / превью ─────────────────────────── */

/** Строк базы в превью на карточке (sample_rows в БД капнут 30 — хватает). */
const PREVIEW_ROWS = 10;
/** Усечение текста ячейки превью; полный текст — в title. */
const PREVIEW_CELL_CHARS = 80;

function previewCellText(value: unknown): string {
  if (value == null) return '';
  return typeof value === 'string' ? value : String(value);
}

/** Имя файла из Content-Disposition ответа экспорта; fallback — base-<id>.csv. */
function exportDownloadName(res: Response, baseId: string): string {
  const match = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '');
  return match?.[1] ?? `base-${baseId}.csv`;
}

const CARD_ACTION_BTN =
  'inline-flex items-center gap-1 rounded border border-gray-200 px-1.5 py-0.5 text-[11px] text-gray-500 transition hover:border-blue-300 hover:text-blue-600 disabled:cursor-not-allowed disabled:opacity-50';

function BaseCard({ base }: { base: HeBaseSummary }) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState('');

  const hasRows = base.row_count > 0;
  const columns = Array.isArray(base.columns) ? base.columns : [];
  const previewRows = (Array.isArray(base.sample_rows) ? base.sample_rows : []).slice(
    0,
    PREVIEW_ROWS,
  );

  const handleDownload = useCallback(async () => {
    if (downloading) return;
    setDownloadError('');
    setDownloading(true);
    try {
      // Не <a href>: экспорт за Bearer-авторизацией — тянем через authFetch
      // и скачиваем blob через временный objectURL.
      const res = await authFetch(`${HE_API}/bases/${base.id}/export`);
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `Ошибка ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = exportDownloadName(res, base.id);
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : 'Не удалось скачать CSV');
    } finally {
      setDownloading(false);
    }
  }, [base.id, downloading]);

  return (
    <div
      className={`rounded-lg border border-gray-200 bg-white px-3 py-2 ${previewOpen ? 'w-full' : ''}`}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0">
          <span className="flex items-center gap-1.5">
            <span className="max-w-[200px] truncate text-xs font-medium text-gray-800">
              {base.filename}
            </span>
            {base.source === 'auto' ? (
              <Badge tone="blue">авто</Badge>
            ) : (
              <Badge tone="gray">загрузка</Badge>
            )}
          </span>
          <span className="block text-[11px] text-gray-400">
            {base.row_count.toLocaleString('ru-RU')} строк · {formatDate(base.created_at)}
          </span>
        </span>
        {base.status === 'collecting' ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-blue-600">
            <Spinner className="h-3.5 w-3.5" />
            Собираем…
          </span>
        ) : base.status === 'analyzing' ? (
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
        {hasRows ? (
          <span className="ml-auto inline-flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => setPreviewOpen((v) => !v)}
              className={CARD_ACTION_BTN}
              aria-expanded={previewOpen}
            >
              {previewOpen ? (
                <EyeOff className="h-3 w-3" aria-hidden />
              ) : (
                <Eye className="h-3 w-3" aria-hidden />
              )}
              Превью
            </button>
            <button
              type="button"
              onClick={() => void handleDownload()}
              disabled={downloading}
              className={CARD_ACTION_BTN}
            >
              {downloading ? (
                <Spinner className="h-3 w-3" />
              ) : (
                <Download className="h-3 w-3" aria-hidden />
              )}
              Скачать CSV
            </button>
          </span>
        ) : null}
      </div>
      {downloadError ? (
        <p className="mt-1 text-[11px] text-red-600" role="alert">
          {downloadError}
        </p>
      ) : null}
      {previewOpen && hasRows ? (
        <div className="mt-2 overflow-x-auto rounded-lg border border-gray-200">
          <table className="min-w-full divide-y divide-gray-200 text-xs">
            <thead className="bg-gray-50">
              <tr>
                {columns.map((col) => (
                  <th
                    key={col}
                    className="whitespace-nowrap px-3 py-1.5 text-left font-semibold uppercase tracking-wider text-gray-500"
                  >
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 bg-white">
              {previewRows.map((row, ri) => (
                <tr key={ri}>
                  {columns.map((col) => {
                    const text = previewCellText(row[col]);
                    return (
                      <td
                        key={col}
                        className="max-w-[220px] truncate px-3 py-1.5 text-gray-700"
                        title={text}
                      >
                        {text.length > PREVIEW_CELL_CHARS
                          ? `${text.slice(0, PREVIEW_CELL_CHARS)}…`
                          : text}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {previewRows.length === 0 ? (
            <p className="px-3 py-2 text-[11px] text-gray-400">Нет строк для превью</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/* ─────────────────────────── Автосборка базы ─────────────────────────── */

/** Русские имена источников автосборки; неизвестный ключ показываем как пришёл. */
const COLLECT_SOURCE_LABELS: Record<string, string> = {
  registry: 'реестр',
  reestr: 'реестр',
  rusprofile: 'реестр',
  hh: 'hh.ru',
  hh_ru: 'hh.ru',
  yandex: 'яндекс.карты',
  yandex_maps: 'яндекс.карты',
  google_maps: 'google maps',
  gmaps: 'google maps',
};

function collectSourceLabel(source: string | undefined): string {
  const key = (source ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return COLLECT_SOURCE_LABELS[key] ?? (source?.trim() || 'источник');
}

function collectTaskDone(status: string | undefined): boolean {
  return ['done', 'completed', 'success', 'ok'].includes((status ?? '').toLowerCase());
}

function collectTaskFailed(status: string | undefined): boolean {
  return ['failed', 'error'].includes((status ?? '').toLowerCase());
}

/** Защитное чтение collect_info: форма толерантная, любой кусок может отсутствовать. */
function readCollectInfo(info: HeCollectInfo | null | undefined) {
  const plan = info?.plan?.tasks;
  const tasks = info?.tasks;
  // limit появился позже plan/tasks — читаем так же защитно, как весь collect_info.
  const rawLimit = (info as { limit?: unknown } | null | undefined)?.limit;
  return {
    plan: Array.isArray(plan) ? plan.filter((t) => t && typeof t === 'object') : [],
    tasks: Array.isArray(tasks) ? tasks.filter((t) => t && typeof t === 'object') : [],
    limit: typeof rawLimit === 'number' && Number.isFinite(rawLimit) ? rawLimit : null,
  };
}

/** Карточка прогресса автосборки: план (почему эти источники) + живые статусы задач. */
function CollectProgress({ base }: { base: HeBaseSummary }) {
  const { plan, tasks, limit } = readCollectInfo(base.collect_info);
  // У баз, созданных до появления limit в collect_info, показываем дефолт.
  const shownLimit = limit ?? DEFAULT_COLLECT_LIMIT;
  return (
    <div className="mt-3 rounded-xl border border-blue-100 bg-blue-50/40 p-4">
      <p className="flex items-center gap-2 text-sm font-medium text-blue-800">
        <Spinner className="h-4 w-4" />
        Собираем базу…
      </p>
      <p className="mt-1 text-xs text-blue-700/70">
        собираем до {shownLimit.toLocaleString('ru-RU')} строк
      </p>
      {plan.length > 0 ? (
        <ul className="mt-2.5 space-y-1">
          {plan.map((task, i) => (
            <li key={`plan-${i}`} className="text-xs text-gray-500">
              <span className="font-medium text-gray-600">{collectSourceLabel(task.source)}</span>
              {task.rationale ? ` — ${task.rationale}` : ''}
            </li>
          ))}
        </ul>
      ) : null}
      {tasks.length > 0 ? (
        <ul className="mt-2.5 space-y-1.5">
          {tasks.map((task, i) => (
            <li key={`task-${i}`} className="flex items-center gap-2 text-xs text-gray-700">
              {collectTaskDone(task.status) ? (
                <Check className="h-3.5 w-3.5 shrink-0 text-emerald-500" aria-hidden />
              ) : collectTaskFailed(task.status) ? (
                <X className="h-3.5 w-3.5 shrink-0 text-red-500" aria-hidden />
              ) : (
                <Spinner className="h-3.5 w-3.5 shrink-0 text-blue-500" />
              )}
              <span>{collectSourceLabel(task.source)}</span>
              {collectTaskDone(task.status) && typeof task.rows === 'number' ? (
                <span className="text-gray-400">· {task.rows.toLocaleString('ru-RU')} строк</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {plan.length === 0 && tasks.length === 0 ? (
        <p className="mt-2 text-xs text-gray-400">Подбираем источники под направление…</p>
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
            <span className="mt-0.5 block h-1.5 overflow-hidden rounded-full bg-gray-200">
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
