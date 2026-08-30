'use client';

/**
 * Шаг 4 мастера «Движка вертикалей» — «База»: загрузка CSV/XLSX под вертикаль
 * (парсинг в браузере через readSpreadsheetFile, лимит строк как в
 * /client/launch), превью, статусы разбора, профиль последней разобранной
 * базы и запуск сборки финального шаблона. Поглощает старый BasesTab.
 * Автосборка идёт по выбранным гипотезам вертикали (пикер с чекбоксами над
 * кнопкой, выбор персистится в localStorage): раньше сборка молча покрывала
 * ВСЕ неотклонённые гипотезы, хотя пользователь выбирал одну.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { ArrowRight } from 'lucide-react';
import type {
  VeBaseAnalysis,
  VeDistributionEntry,
  VeHypothesis,
  VeHypothesisTier,
  VeVertical,
} from '@/lib/verticalEngineV2/types';
import { authFetch } from '@/lib/authFetch';
import { readSpreadsheetFile } from '@/lib/spreadsheet/parseCSV';
import { CLIENT_LAUNCH_ROW_LIMIT } from '@/lib/clientLaunch/constants';
import { VE_LAUNCH_MAX_LEADS } from '@/lib/verticalEngineV2/launchHandoff';
import {
  VE_API,
  veEnginePost,
  type VeBaseCollectResponse,
  type VeBaseCreateResponse,
  type VeBaseSummary,
  type VeCollectInfo,
  type VeJobResponse,
  type VeJobSummary,
} from '../api';
import { HE, StatusDot, Spinner } from '../design';
import { SeasonalityDetail } from '../SeasonalitySummary';
import { StatusBox, TIER_META, formatDate } from '../ui';

/** Как часто дёргать reload детали во время автосборки (как POLL_INTERVAL_MS родителя). */
const COLLECT_POLL_MS = 4000;

/** Лимит строк автосборки — выбор пользователя; route валидирует те же значения. */
type CollectLimit = 2000 | 10000 | 50000;
type BaseMode = 'auto' | 'upload';
const COLLECT_LIMITS: readonly CollectLimit[] = [2000, 10000, 50000];
const DEFAULT_COLLECT_LIMIT: CollectLimit = 10000;

interface ParsedFile {
  filename: string;
  sizeBytes: number;
  columns: string[];
  rows: Array<Record<string, string>>;
}

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 Б';
  if (bytes < 1024) return `${Math.round(bytes)} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024).toLocaleString('ru-RU')} КБ`;
  return `${(bytes / (1024 * 1024)).toLocaleString('ru-RU', {
    maximumFractionDigits: 1,
  })} МБ`;
}

/** Последняя джоба стадии (по started_at; записи без started_at считаются старыми). */
function latestStageJob(jobs: VeJobSummary[], stage: VeJobSummary['stage']): VeJobSummary | undefined {
  let best: VeJobSummary | undefined;
  for (const job of jobs) {
    if (job.stage !== stage) continue;
    if (!best || (job.started_at ?? '') >= (best.started_at ?? '')) best = job;
  }
  return best;
}

function jobActive(job: VeJobSummary | undefined): boolean {
  return job?.status === 'pending' || job?.status === 'running';
}

export function Step4Base(props: {
  projectId: string;
  vertical: VeVertical;
  /** Гипотезы проекта (пикер автосборки фильтрует по vertical.id). */
  hypotheses: VeHypothesis[];
  bases: VeBaseSummary[];
  jobs: VeJobSummary[];
  onUploaded: () => void;
  onTemplateStarted: () => void;
  onGoToTemplate: () => void;
}): JSX.Element {
  const { projectId, vertical, hypotheses, bases, jobs, onUploaded, onTemplateStarted, onGoToTemplate } = props;

  const [baseMode, setBaseMode] = useState<BaseMode>('auto');
  const [parsed, setParsed] = useState<ParsedFile | null>(null);
  const [parsing, setParsing] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [parseError, setParseError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [collectStarting, setCollectStarting] = useState(false);
  const [collectError, setCollectError] = useState('');
  const [collectNotice, setCollectNotice] = useState('');
  const [collectLimit, setCollectLimit] = useState<CollectLimit>(DEFAULT_COLLECT_LIMIT);
  const [templateStarting, setTemplateStarting] = useState(false);
  const [templateError, setTemplateError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  /* ── Пикер гипотез автосборки ── */

  // Гипотезы выбранной вертикали (по pct desc, как на доске шага 2).
  const verticalHypotheses = useMemo(
    () => hypotheses.filter((h) => h.vertical_id === vertical.id).sort((a, b) => b.potential_pct - a.potential_pct),
    [hypotheses, vertical.id],
  );

  // localStorage-ключ последнего выбора гипотез под вертикаль.
  // v2: смена семантики дефолта (приоритет accepted) — старый выбор эпохи
  // «все неотклонённые» не должен тихо перекрывать новый дефолт.
  const collectHypsKey = `he.collect.hyps.v2.${vertical.id}`;
  const [checkedHyps, setCheckedHyps] = useState<ReadonlySet<string>>(new Set());
  // Инициализация — один раз на вертикаль (дефолт: отмечены неотклонённые),
  // с восстановлением прошлого выбора из localStorage. Не по эффекту на
  // verticalHypotheses: родительский поллинг меняет идентичность массива
  // каждые 4 секунды и сбрасывал бы выбор пользователя.
  const hypsInitRef = useRef<string | null>(null);
  useEffect(() => {
    if (hypsInitRef.current === vertical.id) return;
    if (verticalHypotheses.length === 0) return; // гипотезы ещё не загрузились
    hypsInitRef.current = vertical.id;
    // Дефолт: если есть принятые (accepted) — отмечены только они (приоритет
    // разметки специалиста), иначе — все неотклонённые.
    const accepted = verticalHypotheses.filter((h) => h.status === 'accepted');
    let initial =
      accepted.length > 0
        ? accepted.map((h) => h.id)
        : verticalHypotheses.filter((h) => h.status !== 'rejected').map((h) => h.id);
    try {
      const raw = window.localStorage.getItem(collectHypsKey);
      const saved: unknown = raw ? (JSON.parse(raw) as unknown) : null;
      if (Array.isArray(saved)) {
        const selectable = new Set(
          verticalHypotheses
            .filter((hypothesis) => hypothesis.status !== 'rejected')
            .map((hypothesis) => hypothesis.id),
        );
        const kept = saved.filter((id): id is string => typeof id === 'string' && selectable.has(id));
        // Прошлый выбор применяем, только если пересекается с актуальными
        // гипотезами — иначе он от другой эпохи (гипотезы перегенерированы).
        if (kept.length > 0) initial = kept;
      }
    } catch {
      // localStorage недоступен или битый JSON — живём на дефолте.
    }
    setCheckedHyps(new Set(initial));
  }, [vertical.id, verticalHypotheses, collectHypsKey]);

  const persistCheckedHyps = useCallback(
    (next: ReadonlySet<string>) => {
      try {
        window.localStorage.setItem(collectHypsKey, JSON.stringify([...next]));
      } catch {
        // localStorage недоступен — выбор живёт только в состоянии компонента.
      }
    },
    [collectHypsKey],
  );

  const toggleHypothesis = useCallback(
    (id: string) => {
      const next = new Set(checkedHyps);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setCheckedHyps(next);
      persistCheckedHyps(next);
    },
    [checkedHyps, persistCheckedHyps],
  );

  const setAllHypotheses = useCallback(
    (on: boolean) => {
      const next = new Set<string>(
        on ? verticalHypotheses.filter((h) => h.status !== 'rejected').map((h) => h.id) : [],
      );
      setCheckedHyps(next);
      persistCheckedHyps(next);
    },
    [verticalHypotheses, persistCheckedHyps],
  );

  // Считаем по актуальному списку: в checkedHyps могут остаться id уже
  // удалённых/перегенерированных гипотез. Отклонённые не считаем (как и в POST).
  const checkedHypCount = useMemo(
    () => verticalHypotheses.filter((h) => checkedHyps.has(h.id) && h.status !== 'rejected').length,
    [verticalHypotheses, checkedHyps],
  );
  // Есть ли в выборе непринятые (proposed) — для подсказки у счётчика.
  const includesProposed = useMemo(
    () => verticalHypotheses.some((h) => checkedHyps.has(h.id) && h.status === 'proposed'),
    [verticalHypotheses, checkedHyps],
  );

  const verticalBases = useMemo(
    () => bases.filter((b) => b.vertical_id === vertical.id).sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [bases, vertical.id],
  );
  // Гипотеза → заголовок: метка на карточке базы (base-per-hypothesis).
  const hypothesisTitleById = useMemo(() => {
    const map = new Map<string, string>();
    for (const h of hypotheses) map.set(h.id, h.title);
    return map;
  }, [hypotheses]);
  const latestBase = verticalBases[0];
  const latestAnalyzed = useMemo(
    () => verticalBases.find((b) => b.status === 'analyzed' && b.analysis),
    [verticalBases],
  );
  const latestSeasonality = useMemo(() => {
    if (!latestAnalyzed) return null;
    if (latestAnalyzed.hypothesis_id) {
      return hypotheses.find((hypothesis) => hypothesis.id === latestAnalyzed.hypothesis_id)?.seasonality ?? null;
    }
    return verticalHypotheses.find((hypothesis) => hypothesis.seasonality)?.seasonality ?? null;
  }, [hypotheses, latestAnalyzed, verticalHypotheses]);

  /** Последняя база в статусе автосборки (verticalBases отсортированы по created_at desc). */
  const collectingBase = useMemo(() => verticalBases.find((b) => b.status === 'collecting'), [verticalBases]);
  /** Автосборка упала: последняя база вертикали — авто и в ошибке (retry уводит в re-POST). */
  const collectFailed = !collectingBase && latestBase?.source === 'auto' && latestBase.status === 'failed';

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
      setParsed({
        filename: file.name,
        sizeBytes: file.size,
        columns: headers,
        rows,
      });
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
      const { ok, data } = await veEnginePost<VeBaseCreateResponse>(`${VE_API}/projects/${projectId}/bases`, {
        vertical_id: vertical.id,
        filename: parsed.filename,
        columns: parsed.columns,
        rows: parsed.rows,
      });
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
    // Пикер виден, но ничего не отмечено (кнопка в этом состоянии disabled) —
    // страховка от «сборки по всем гипотезам при снятых галочках».
    if (verticalHypotheses.length > 0 && checkedHypCount === 0) return;
    setCollectError('');
    setCollectNotice('');
    setCollectStarting(true);
    try {
      // Отмеченные гипотезы — всегда в запросе, когда пикер есть: явный выбор
      // вместо молчаливой сборки по всем неотклонённым. Порядок — как в
      // пикере (pct desc), детерминированно.
      const body: { limit: CollectLimit; hypothesis_ids?: string[] } = {
        limit: collectLimit,
      };
      if (verticalHypotheses.length > 0) {
        // Отклонённые не отправляем: стадия их всё равно отрежет — не даём
        // пользователю включить их молча (в пикере они disabled).
        body.hypothesis_ids = verticalHypotheses
          .filter((h) => checkedHyps.has(h.id) && h.status !== 'rejected')
          .map((h) => h.id);
      }
      const { ok, data } = await veEnginePost<VeBaseCollectResponse>(
        `${VE_API}/verticals/${vertical.id}/collect`,
        body,
      );
      if (!ok) {
        setCollectError(data.error || 'Не удалось запустить автосборку');
        return;
      }
      // Дедуп-ответ (200, existing): новая сборка не создана. Показываем,
      // с каким лимитом уже идёт сборка, — иначе клик с другим лимитом
      // выглядел бы как молча проигнорированный.
      if (data.existing) {
        const runningLimit = data.base?.collect_info?.limit;
        setCollectNotice(
          typeof runningLimit === 'number' && Number.isFinite(runningLimit)
            ? `Уже собирается база с лимитом ${runningLimit.toLocaleString('ru-RU')}`
            : 'Уже собирается база — повторный запуск не создаётся',
        );
      }
      // 201 (сборка стартовала) и 200 (уже идёт) — в обоих случаях перечитываем деталь.
      onUploaded();
    } catch (err) {
      setCollectError(err instanceof Error ? err.message : 'Не удалось запустить автосборку');
    } finally {
      setCollectStarting(false);
    }
  }, [
    collectStarting,
    collectingBase,
    collectLimit,
    verticalHypotheses,
    checkedHyps,
    checkedHypCount,
    vertical.id,
    onUploaded,
  ]);

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
      const { ok, data } = await veEnginePost<VeJobResponse>(`${VE_API}/bases/${latestBase.id}/template`);
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

  const collectLocked = Boolean(collectingBase || collectStarting);

  return (
    <div className="max-w-6xl">
      <div className="ve2-tabs" role="tablist" aria-label="Способ подготовки базы">
        <button
          id="ve-base-tab-auto"
          type="button"
          role="tab"
          aria-selected={baseMode === 'auto'}
          aria-controls="ve-base-panel-auto"
          onClick={() => setBaseMode('auto')}
          className="ve2-tab"
        >
          Собрать автоматически
        </button>
        <button
          id="ve-base-tab-upload"
          type="button"
          role="tab"
          aria-selected={baseMode === 'upload'}
          aria-controls="ve-base-panel-upload"
          onClick={() => setBaseMode('upload')}
          className="ve2-tab"
        >
          Загрузить файл
        </button>
      </div>

      <section
        id="ve-base-panel-auto"
        role="tabpanel"
        aria-labelledby="ve-base-tab-auto"
        hidden={baseMode !== 'auto'}
        className="ve2-sec"
      >
        <div className="ve2-sec-head">
          <div>
            <p className={HE.eyebrow}>01 → Гипотезы для сбора</p>
            <p className={`mt-1.5 ${HE.muted}`}>
              База соберётся под выбранные гипотезы, включая предложенные специалистом.
            </p>
          </div>
          {verticalHypotheses.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1">
              <button
                type="button"
                onClick={() => setAllHypotheses(true)}
                disabled={collectLocked}
                className={HE.btnQuiet}
              >
                Все
              </button>
              <button
                type="button"
                onClick={() => setAllHypotheses(false)}
                disabled={collectLocked}
                className={HE.btnQuiet}
              >
                Нет
              </button>
              <span className={`ml-2 ${HE.faint}`}>
                выбрано {checkedHypCount} из{' '}
                {verticalHypotheses.filter((hypothesis) => hypothesis.status !== 'rejected').length}
                {includesProposed ? ' · включая непринятые' : ''}
              </span>
            </div>
          ) : null}
        </div>

        {verticalHypotheses.length > 0 ? (
          <HypothesisPicker
            hypotheses={verticalHypotheses}
            checked={checkedHyps}
            disabled={collectLocked}
            onToggle={toggleHypothesis}
          />
        ) : (
          <div className="ve2-nt ve2-nt-info px-4 py-3">
            Для этой вертикали гипотез пока нет. Движок подберёт источники по самой вертикали.
          </div>
        )}

        {verticalHypotheses.length > 0 && checkedHypCount === 0 ? (
          <div className="ve2-nt ve2-nt-warn mt-3 flex items-start gap-2.5 px-4 py-3" role="alert">
            <StatusDot tone="warn" className="mt-[7px] shrink-0" />
            <p>
              <strong className="font-semibold">Отметьте хотя бы одну гипотезу.</strong>{' '}
              <span className={HE.muted}>Иначе сбору не из чего исходить.</span>
            </p>
          </div>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <span className={HE.eyebrow}>Строк</span>
          <span className="ve2-mini-seg" role="group" aria-label="Лимит строк">
            {COLLECT_LIMITS.map((limit) => (
              <button
                key={limit}
                type="button"
                onClick={() => setCollectLimit(limit)}
                disabled={collectLocked}
                aria-pressed={collectLimit === limit}
              >
                {limit.toLocaleString('ru-RU')}
              </button>
            ))}
          </span>
          <span className={HE.faint}>Больше строк: дольше сбор и выше расход на обогащение.</span>
        </div>

        {collectingBase ? (
          <CollectProgress base={collectingBase} />
        ) : (
          <div className="mt-4">
            {collectFailed ? (
              <p className="mb-3 text-sm text-red-600" role="alert">
                Автосборка завершилась ошибкой. Попробуйте ещё раз или переключитесь на загрузку файла.
              </p>
            ) : null}
            <button
              type="button"
              onClick={() => void handleCollect()}
              disabled={collectStarting || (verticalHypotheses.length > 0 && checkedHypCount === 0)}
              className={`${HE.btnPrimary} inline-flex items-center justify-center gap-2`}
            >
              {collectStarting ? <Spinner /> : null}
              {collectFailed ? 'Попробовать снова' : 'Собрать базу автоматически'}
            </button>
            {collectNotice ? (
              <p className={`mt-2 ${HE.faint}`} role="status">
                {collectNotice}
              </p>
            ) : null}
            {collectError ? (
              <p className="mt-2 text-sm text-red-600" role="alert">
                {collectError}
              </p>
            ) : null}
          </div>
        )}
      </section>

      <section
        id="ve-base-panel-upload"
        role="tabpanel"
        aria-labelledby="ve-base-tab-upload"
        hidden={baseMode !== 'upload'}
        className="ve2-sec"
      >
        <div className="ve2-sec-head">
          <div>
            <p className={HE.eyebrow}>01 → Загрузка файла</p>
            <p className={`mt-1.5 ${HE.muted}`}>Своя база тоже работает: движок разберёт колонки и покажет состав.</p>
          </div>
        </div>

        {parsed ? (
          <div className="ve2-panel px-5 py-4">
            <div className="flex flex-wrap items-center gap-3">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-gray-800" title={parsed.filename}>
                  {parsed.filename}
                </span>
                <span className={HE.faint}>{formatFileSize(parsed.sizeBytes)}</span>
              </span>
              <button type="button" onClick={clearFile} className={`${HE.btnQuiet} ve2-t-dan`}>
                Убрать файл
              </button>
            </div>

            <div className="mt-3 overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200 text-xs">
                <thead>
                  <tr>
                    {parsed.columns.map((column) => (
                      <th
                        key={column}
                        className="whitespace-nowrap px-3 py-2 text-left font-semibold uppercase text-gray-500 first:pl-0"
                      >
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {parsed.rows.slice(0, 3).map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {parsed.columns.map((column) => (
                        <td
                          key={column}
                          className="max-w-[220px] truncate px-3 py-2 text-gray-700 first:pl-0"
                          title={row[column]}
                        >
                          {row[column]}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className={`mt-2 ${HE.faint}`}>
              Первые {Math.min(3, parsed.rows.length)} из {parsed.rows.length.toLocaleString('ru-RU')} строк ·{' '}
              {parsed.columns.length.toLocaleString('ru-RU')} колонок распознано.
            </p>
            <button
              type="button"
              onClick={() => void handleUpload()}
              disabled={uploading || parsing}
              className={`${HE.btnPrimary} mt-4 inline-flex items-center justify-center gap-2`}
            >
              {uploading ? <Spinner /> : null}
              Загрузить базу
            </button>
          </div>
        ) : (
          <button
            type="button"
            disabled={parsing}
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(event) => {
              event.preventDefault();
              if (!parsing) setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragOver(false);
              if (parsing) return;
              const file = event.dataTransfer.files?.[0];
              if (file) void handleFile(file);
            }}
            className={`ve2-drop flex w-full cursor-pointer flex-col items-center justify-center gap-1.5 px-5 py-9 ${
              parsing ? 'pointer-events-none opacity-60' : ''
            } ${dragOver ? 've2-drop-on' : ''}`}
          >
            {parsing ? <Spinner className="h-5 w-5" /> : null}
            <span className="text-sm font-semibold text-gray-800">
              {parsing ? 'Читаем файл…' : 'Выберите или перетащите файл'}
            </span>
            <span className={HE.faint}>
              CSV, TSV или XLSX · до {CLIENT_LAUNCH_ROW_LIMIT.toLocaleString('ru-RU')} строк
            </span>
          </button>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,.tsv,.xlsx,.xls,.txt"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void handleFile(file);
          }}
        />

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
      </section>

      <section className="ve2-sec" aria-labelledby="ve-bases-title">
        <div className="ve2-sec-head">
          <p id="ve-bases-title" className={HE.eyebrow}>
            02 → Базы под эту вертикаль
          </p>
          {verticalBases.length > 0 ? (
            <span className={HE.faint}>{verticalBases.length.toLocaleString('ru-RU')}</span>
          ) : null}
        </div>
        {verticalBases.length > 0 ? (
          <div className="ve2-rows">
            {verticalBases.map((base) => (
              <BaseRow
                key={base.id}
                base={base}
                hypothesisTitle={base.hypothesis_id ? hypothesisTitleById.get(base.hypothesis_id) : undefined}
              />
            ))}
          </div>
        ) : (
          <div className="ve2-nt ve2-nt-info px-4 py-3">
            Баз под эту вертикаль пока нет. Соберите новую или загрузите файл выше.
          </div>
        )}
        {latestBase?.status === 'failed' && latestBase.source !== 'auto' ? (
          <div className="mt-3">
            <StatusBox tone="error">
              Разбор базы «{latestBase.filename}» завершился ошибкой. Загрузите файл ещё раз.
            </StatusBox>
          </div>
        ) : null}
      </section>

      <section className="ve2-sec" aria-labelledby="ve-base-analysis-title">
        <div className="ve2-sec-head">
          <div>
            <p id="ve-base-analysis-title" className={HE.eyebrow}>
              03 → Состав базы
            </p>
            {latestAnalyzed ? (
              <p className={`mt-1.5 ${HE.muted}`}>Последний разбор: {latestAnalyzed.filename}</p>
            ) : null}
          </div>
        </div>

        {latestAnalyzed?.analysis ? (
          <BaseAnalysisCards analysis={latestAnalyzed.analysis} />
        ) : (
          <div className="ve2-nt ve2-nt-info px-4 py-3">Состав появится после завершения разбора базы.</div>
        )}

        {latestSeasonality ? (
          <div className="mt-4">
            <SeasonalityDetail assessment={latestSeasonality} />
          </div>
        ) : null}

        <div className="ve2-step-footer">
          {templateDone ? (
            <button type="button" onClick={onGoToTemplate} className={HE.btnPrimary}>
              Перейти к шаблону
              <ArrowRight aria-hidden className="h-4 w-4" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void handleBuildTemplate()}
              disabled={templateBusy || latestBase?.status !== 'analyzed'}
              className={`${HE.btnPrimary} inline-flex items-center justify-center gap-2`}
            >
              {templateBusy ? <Spinner /> : null}
              {templateBusy ? 'Собираем шаблон…' : 'Собрать шаблон'}
              {!templateBusy ? <ArrowRight aria-hidden className="h-4 w-4" /> : null}
            </button>
          )}
          <span className={HE.faint}>
            {templateBusy
              ? 'AI собирает боевой шаблон — обычно это занимает 1–2 минуты.'
              : templateDone
                ? 'Шаблон готов и доступен на следующем шаге.'
                : latestBase?.status === 'analyzed'
                  ? 'База разобрана, можно собирать шаблон.'
                  : 'Кнопка станет активной, когда база будет разобрана.'}
          </span>
        </div>
        {templateError ? (
          <div className="mt-3">
            <StatusBox tone="error">{templateError}</StatusBox>
          </div>
        ) : null}
        {templateFailed ? (
          <div className="mt-3">
            <StatusBox tone="error">
              Сборка шаблона завершилась ошибкой
              {templateJob?.error ? `: ${templateJob.error}` : '.'} Нажмите «Собрать шаблон», чтобы попробовать снова.
            </StatusBox>
          </div>
        ) : null}
      </section>
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

function BaseRow({ base, hypothesisTitle }: { base: VeBaseSummary; hypothesisTitle?: string }) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState('');

  const hasRows = base.row_count > 0;
  const columns = Array.isArray(base.columns) ? base.columns : [];
  const previewRows = (Array.isArray(base.sample_rows) ? base.sample_rows : []).slice(0, PREVIEW_ROWS);

  const handleDownload = useCallback(async () => {
    if (downloading) return;
    setDownloadError('');
    setDownloading(true);
    try {
      // Не <a href>: экспорт за Bearer-авторизацией — тянем через authFetch
      // и скачиваем blob через временный objectURL.
      const res = await authFetch(`${VE_API}/bases/${base.id}/export`);
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
    <div className="border-b ve2-div last:border-b-0">
      <div className="ve2-row !cursor-default !border-b-0 flex-wrap">
        <span className="min-w-[180px] flex-1">
          <span className="block min-w-0">
            <span className="block truncate font-mono text-xs font-medium text-gray-800" title={base.filename}>
              {base.filename}
            </span>
            {hypothesisTitle ? (
              <span className="block truncate text-[11px] text-gray-500" title={hypothesisTitle}>
                {hypothesisTitle}
              </span>
            ) : null}
          </span>
          <span className={HE.faint}>{formatDate(base.created_at)}</span>
        </span>
        <span className="ve2-tag">{base.source === 'auto' ? 'авто' : 'загрузка'}</span>
        <span className="shrink-0 font-mono text-xs text-gray-700">{base.row_count.toLocaleString('ru-RU')} строк</span>
        {base.status === 'collecting' ? (
          <span className="ve2-st ve2-tg-warn">
            <Spinner className="h-3.5 w-3.5" />
            Собираем…
          </span>
        ) : base.status === 'analyzing' ? (
          <span className="ve2-st ve2-tg-warn">
            <StatusDot tone="warn" />
            Разбираем…
          </span>
        ) : base.status === 'analyzed' ? (
          <span className="ve2-st ve2-tg-ok">
            <StatusDot tone="ok" />
            Разобрана
          </span>
        ) : base.status === 'failed' ? (
          <span className="ve2-st ve2-tg-err">
            <StatusDot tone="err" />
            Ошибка
          </span>
        ) : (
          <span className="ve2-st ve2-tg-q">
            <StatusDot tone="muted" />
            Загружена
          </span>
        )}
        {hasRows ? (
          <span className="ml-auto inline-flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => setPreviewOpen((v) => !v)}
              className={HE.btnQuiet}
              aria-expanded={previewOpen}
              aria-controls={`ve-base-preview-${base.id}`}
            >
              {previewOpen ? 'Скрыть' : 'Превью'}
            </button>
            <button type="button" onClick={() => void handleDownload()} disabled={downloading} className={HE.btnGhost}>
              {downloading ? <Spinner className="h-3 w-3" /> : null}
              Скачать CSV
            </button>
          </span>
        ) : null}
      </div>
      {base.source === 'auto' && base.status !== 'collecting' ? (
        <div className="px-4 pb-3">
          <CollectionFunnel base={base} />
        </div>
      ) : null}
      {downloadError ? (
        <p className="px-4 pb-3 text-[11px] text-red-600" role="alert">
          {downloadError}
        </p>
      ) : null}
      {previewOpen && hasRows ? (
        <div id={`ve-base-preview-${base.id}`} className="overflow-x-auto px-4 pb-4">
          <table className="min-w-full divide-y divide-gray-200 text-xs">
            <thead>
              <tr>
                {columns.map((col) => (
                  <th
                    key={col}
                    className="whitespace-nowrap px-3 py-1.5 text-left font-semibold uppercase text-gray-500 first:pl-0"
                  >
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {previewRows.map((row, ri) => (
                <tr key={ri}>
                  {columns.map((col) => {
                    const text = previewCellText(row[col]);
                    return (
                      <td
                        key={col}
                        className="max-w-[220px] truncate px-3 py-1.5 text-gray-700 first:pl-0"
                        title={text}
                      >
                        {text === '' ? (
                          <span className={HE.chip}>—</span>
                        ) : text.length > PREVIEW_CELL_CHARS ? (
                          `${text.slice(0, PREVIEW_CELL_CHARS)}…`
                        ) : (
                          text
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {previewRows.length === 0 ? (
            <p className="px-3 py-2 text-[11px] text-gray-500">Нет строк для превью</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/* ─────────────────────────── Автосборка базы ─────────────────────────── */

/** Текстовая метка тира (T1/T2/T3); копия приватного хелпера Step2Verticals. */
function TierText({ tier }: { tier: VeHypothesisTier }) {
  const meta = TIER_META[tier] ?? TIER_META[3];
  return (
    <span title={meta.hint} className={`shrink-0 ${HE.tierText}`}>
      {meta.label}
    </span>
  );
}

/** Процент потенциала как данные: без заливки, только семантический цвет текста. */
function PctText({ pct }: { pct: number }) {
  const tone = pct >= 50 ? 've2-pct-hi' : pct >= 25 ? 've2-pct-mid' : 've2-pct-lo';
  return <span className={`ve2-pct shrink-0 ${tone}`}>{pct}%</span>;
}

/**
 * Пикер гипотез автосборки: неотклонённые отмечены по умолчанию, отклонённые —
 * приглушены и недоступны. POST уходит строго с отмеченными non-rejected id.
 */
function HypothesisPicker({
  hypotheses,
  checked,
  disabled,
  onToggle,
}: {
  hypotheses: VeHypothesis[];
  checked: ReadonlySet<string>;
  disabled: boolean;
  onToggle: (id: string) => void;
}) {
  return (
    <ul className="ve2-rows">
      {hypotheses.map((hypothesis) => {
        const rejected = hypothesis.status === 'rejected';
        return (
          <li key={hypothesis.id} className="ve2-row !cursor-default">
            <label
              className={`flex w-full min-w-0 items-start gap-3 ${
                rejected ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'
              }`}
            >
              <input
                type="checkbox"
                checked={!rejected && checked.has(hypothesis.id)}
                onChange={() => onToggle(hypothesis.id)}
                disabled={disabled || rejected}
                className="ve2-cbx mt-0.5 h-4 w-4 shrink-0"
              />
              <TierText tier={hypothesis.tier} />
              <span className="min-w-0 flex-1 text-sm font-medium text-gray-700" title={hypothesis.title}>
                {hypothesis.title}
              </span>
              {rejected ? <span className="shrink-0 text-[10.5px] text-gray-500">отклонена</span> : null}
              <PctText pct={hypothesis.potential_pct} />
            </label>
          </li>
        );
      })}
    </ul>
  );
}

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
  const key = (source ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return COLLECT_SOURCE_LABELS[key] ?? (source?.trim() || 'источник');
}

function collectTaskDone(status: string | undefined): boolean {
  return ['done', 'completed', 'success', 'ok'].includes((status ?? '').toLowerCase());
}

function collectTaskFailed(status: string | undefined): boolean {
  return ['failed', 'error'].includes((status ?? '').toLowerCase());
}

/** Счётчики jsonb читаем как недоверенные данные: только конечные неотрицательные числа. */
function collectCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
}

function recipientWord(value: number): string {
  const mod100 = value % 100;
  if (mod100 >= 11 && mod100 <= 14) return 'получателей';
  const mod10 = value % 10;
  if (mod10 === 1) return 'получатель';
  if (mod10 >= 2 && mod10 <= 4) return 'получателя';
  return 'получателей';
}

/** Защитное чтение collect_info: форма толерантная, любой кусок может отсутствовать. */
function readCollectInfo(info: VeCollectInfo | null | undefined) {
  const plan = info?.plan?.tasks;
  const tasks = info?.tasks;
  // limit появился позже plan/tasks — читаем так же защитно, как весь collect_info.
  const rawLimit = info?.limit;
  // hypotheses появились позже limit — тоже защитно.
  const hyps = info?.hypotheses;
  const estimate = info?.estimate;
  const stats = info?.stats;
  return {
    plan: Array.isArray(plan) ? plan.filter((t) => t && typeof t === 'object') : [],
    tasks: Array.isArray(tasks) ? tasks.filter((t) => t && typeof t === 'object') : [],
    limit: typeof rawLimit === 'number' && Number.isFinite(rawLimit) ? rawLimit : null,
    hypotheses: Array.isArray(hyps)
      ? hyps
          .map((h) =>
            h && typeof h === 'object' && typeof (h as { title?: unknown }).title === 'string'
              ? (h as { title: string }).title
              : '',
          )
          .filter(Boolean)
      : [],
    estimate: {
      uniqueCompanies: collectCount(estimate?.unique_companies),
      companiesWithEmail: collectCount(estimate?.companies_with_email),
      note: typeof estimate?.note === 'string' ? estimate.note.trim() : '',
    },
    stats: {
      rowsTotal: collectCount(stats?.rows_total),
      processedRows: collectCount(stats?.processed_rows),
      launchableRows: collectCount(stats?.launchable_rows),
      relevanceUnchecked: collectCount(stats?.relevance_unchecked),
      relevanceCheckedCompanies: collectCount(stats?.relevance_checked_companies),
      relevanceTotalCompanies: collectCount(stats?.relevance_total_companies),
      relevanceCoverageComplete:
        typeof stats?.relevance_coverage_complete === 'boolean' ? stats.relevance_coverage_complete : null,
    },
  };
}

/**
 * Честная воронка одной автосборки. Рыночная оценка, лимит задачи, строки
 * обработки и адресаты запуска не подменяют друг друга словом «контакты».
 */
function CollectionFunnel({ base, useDefaultLimit = false }: { base: VeBaseSummary; useDefaultLimit?: boolean }) {
  const { limit, estimate, stats } = readCollectInfo(base.collect_info);
  const shownLimit = limit ?? (useDefaultLimit ? DEFAULT_COLLECT_LIMIT : null);
  // После завершения CONSTRUCT row_count — надёжный фолбэк для старых записей,
  // где processed_rows ещё не сохранялся. Failed-база могла остановиться до
  // конструктора, поэтому её row_count сюда подставлять нельзя.
  const processedRows =
    stats.processedRows ??
    (base.status === 'analyzing' || base.status === 'analyzed' ? collectCount(base.row_count) : null);
  const hasAny =
    estimate.note !== '' ||
    [
      estimate.uniqueCompanies,
      estimate.companiesWithEmail,
      shownLimit,
      stats.rowsTotal,
      processedRows,
      stats.launchableRows,
      stats.relevanceUnchecked,
      stats.relevanceCheckedCompanies,
      stats.relevanceTotalCompanies,
    ].some((value) => value !== null);
  if (!hasAny) return null;

  return (
    <div
      className="mt-3 grid gap-x-5 gap-y-1 border-t pt-3 text-[11px] text-gray-600 ve2-div sm:grid-cols-2"
      aria-label="Воронка автосборки"
    >
      {estimate.uniqueCompanies !== null ? (
        <p>{estimate.uniqueCompanies.toLocaleString('ru-RU')} уникальных компаний в реестровом срезе гипотезы</p>
      ) : null}
      {estimate.companiesWithEmail !== null ? (
        <p>Из них {estimate.companiesWithEmail.toLocaleString('ru-RU')} с email в реестре</p>
      ) : null}
      {shownLimit !== null ? <p>Лимит этого прогона: {shownLimit.toLocaleString('ru-RU')} кандидатов</p> : null}
      {stats.rowsTotal !== null ? (
        <p>Собрано до обработки: {stats.rowsTotal.toLocaleString('ru-RU')} кандидатов</p>
      ) : null}
      {processedRows !== null ? <p>После обработки: {processedRows.toLocaleString('ru-RU')} строк</p> : null}
      {stats.relevanceCheckedCompanies !== null && stats.relevanceTotalCompanies !== null ? (
        <p>
          Релевантность проверена: {stats.relevanceCheckedCompanies.toLocaleString('ru-RU')} из{' '}
          {stats.relevanceTotalCompanies.toLocaleString('ru-RU')} компаний
        </p>
      ) : null}
      {stats.launchableRows !== null ? (
        <p className="font-medium text-emerald-700">
          Прошли проверки: {stats.launchableRows.toLocaleString('ru-RU')} {recipientWord(stats.launchableRows)}
        </p>
      ) : null}
      {stats.launchableRows !== null && stats.launchableRows > VE_LAUNCH_MAX_LEADS ? (
        <p className="sm:col-span-2 font-medium text-amber-700">
          Лимит одного запуска — {VE_LAUNCH_MAX_LEADS.toLocaleString('ru-RU')}. Разделите аудиторию или уменьшите базу
          перед запуском.
        </p>
      ) : null}
      {stats.relevanceUnchecked !== null && stats.relevanceUnchecked > 0 ? (
        <p className="sm:col-span-2 font-medium text-amber-700">
          {stats.relevanceUnchecked.toLocaleString('ru-RU')} строк без relevance-вердикта не входят в «Прошли проверки»
          и исключены из запуска.
        </p>
      ) : null}
      {estimate.companiesWithEmail !== null ? (
        <p className="sm:col-span-2 text-gray-500">
          Email в реестре ещё не проверены; итог после фильтров появляется только после полной построчной валидации.
        </p>
      ) : null}
      {estimate.note ? <p className="sm:col-span-2 text-gray-500">{estimate.note}</p> : null}
    </div>
  );
}

/** Карточка прогресса автосборки: план (почему эти источники) + живые статусы задач. */
function CollectProgress({ base }: { base: VeBaseSummary }) {
  const { plan, tasks, hypotheses, limit, stats } = readCollectInfo(base.collect_info);
  const shownLimit = limit ?? DEFAULT_COLLECT_LIMIT;
  const progressCount = stats.processedRows ?? stats.rowsTotal ?? collectCount(base.row_count);
  const progressPct = progressCount === null ? null : Math.min(100, Math.max(0, (progressCount / shownLimit) * 100));

  return (
    <div className="ve2-panel-line mt-4 px-5 py-4" aria-live="polite">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <p className="flex items-center gap-2 text-sm font-semibold text-gray-800">
          <Spinner className="h-4 w-4" />
          Собираем базу
        </p>
        <span className={HE.faint}>
          {progressCount === null ? '—' : progressCount.toLocaleString('ru-RU')} / {shownLimit.toLocaleString('ru-RU')}
        </span>
      </div>
      {progressPct !== null ? (
        <span
          className="ve2-bar mt-2.5 block"
          role="progressbar"
          aria-label="Прогресс автосборки"
          aria-valuemin={0}
          aria-valuemax={shownLimit}
          aria-valuenow={Math.min(progressCount ?? 0, shownLimit)}
        >
          <span className="ve2-bar-f" style={{ width: `${progressPct}%` }} />
        </span>
      ) : null}
      <CollectionFunnel base={base} useDefaultLimit />
      {hypotheses.length > 0 ? (
        <p className={`mt-2 text-[11px] ${HE.muted}`} title={hypotheses.join(', ')}>
          По гипотезам: {hypotheses.join(' · ')}
        </p>
      ) : null}
      {plan.length > 0 ? (
        <ul className="mt-3 space-y-1">
          {plan.map((task, i) => (
            <li key={`plan-${i}`} className="text-xs text-gray-500">
              <span className="font-medium text-gray-600">{collectSourceLabel(task.source)}</span>
              {task.rationale ? ` — ${task.rationale}` : ''}
            </li>
          ))}
        </ul>
      ) : null}
      {tasks.length > 0 ? (
        <ul className="mt-3">
          {tasks.map((task, i) => (
            <li key={`task-${i}`} className="ve2-check-row text-xs text-gray-700">
              {collectTaskDone(task.status) ? (
                <StatusDot tone="ok" />
              ) : collectTaskFailed(task.status) ? (
                <StatusDot tone="err" />
              ) : (
                <Spinner className="h-3.5 w-3.5 shrink-0" />
              )}
              <span>{collectSourceLabel(task.source)}</span>
              {collectTaskDone(task.status) && typeof task.rows === 'number' ? (
                <span className="text-gray-500">· {task.rows.toLocaleString('ru-RU')} строк</span>
              ) : null}
              <span className={`ml-auto ${HE.faint}`}>
                {collectTaskDone(task.status) ? 'готово' : collectTaskFailed(task.status) ? 'ошибка' : 'в работе'}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {plan.length === 0 && tasks.length === 0 ? (
        <p className="mt-2 text-xs text-gray-500">Подбираем источники под направление…</p>
      ) : null}
    </div>
  );
}

/* ─────────────────────────── Профиль базы ─────────────────────────── */

function BarList({ title, entries }: { title: string; entries: VeDistributionEntry[] | undefined }) {
  const top = (entries ?? []).slice(0, 6);
  return (
    <div className="ve2-panel px-5 py-4">
      <p className={HE.eyebrow}>{title}</p>
      {top.length > 0 ? (
        <ul className="mt-2.5 space-y-2.5">
          {top.map((entry) => (
            <li key={entry.value} className="text-xs">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-gray-700" title={entry.value}>
                  {entry.value}
                </span>
                <span className={`shrink-0 ${HE.faint}`}>{entry.share_pct}%</span>
              </div>
              <span className="ve2-bar mt-1 block">
                <span
                  className="ve2-bar-f"
                  style={{
                    width: `${Math.min(100, Math.max(0, entry.share_pct))}%`,
                  }}
                />
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className={`mt-2 ${HE.faint}`}>Нет данных для распределения.</p>
      )}
    </div>
  );
}

function BaseAnalysisCards({ analysis }: { analysis: VeBaseAnalysis }) {
  const qualityItems = (analysis.data_quality_notes ?? '')
    .split(/\n+/)
    .map((s) => s.replace(/^[•\-–*]\s*/, '').trim())
    .filter(Boolean);
  const segments = analysis.notable_segments ?? [];
  const angles = analysis.recommended_angles ?? [];
  const hasAdditionalSlices =
    (analysis.industry_distribution?.length ?? 0) > 0 ||
    (analysis.company_type_distribution?.length ?? 0) > 0 ||
    segments.length > 0;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-3">
        <BarList title="География" entries={analysis.geo_distribution} />
        <BarList title="Должности" entries={analysis.title_distribution} />
        <div className="ve2-panel px-5 py-4">
          <p className={HE.eyebrow}>Качество данных</p>
          {qualityItems.length > 0 ? (
            <ul className="mt-2">
              {qualityItems.map((note, index) => (
                <li key={index} className="ve2-check-row text-xs text-gray-600">
                  <StatusDot tone="muted" />
                  <span>{note}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className={`mt-2 ${HE.faint}`}>Замечаний по качеству нет.</p>
          )}
          <p className={`${HE.eyebrow} mt-4`}>Углы для писем</p>
          {angles.length > 0 ? (
            <ul className="mt-2 space-y-1 text-xs text-gray-600">
              {angles.map((angle, index) => (
                <li key={index} className="flex items-start gap-2">
                  <StatusDot tone="muted" className="mt-[6px] shrink-0" />
                  <span>{angle}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className={`mt-2 ${HE.faint}`}>Рекомендованных углов пока нет.</p>
          )}
        </div>
      </div>

      {hasAdditionalSlices ? (
        <div>
          <p className={`${HE.eyebrow} mb-2.5`}>Дополнительный срез</p>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {(analysis.industry_distribution?.length ?? 0) > 0 ? (
              <BarList title="Отрасли" entries={analysis.industry_distribution} />
            ) : null}
            {(analysis.company_type_distribution?.length ?? 0) > 0 ? (
              <BarList title="Типы компаний" entries={analysis.company_type_distribution} />
            ) : null}
            {segments.length > 0 ? (
              <div className="ve2-panel px-5 py-4">
                <p className={HE.eyebrow}>Заметные сегменты</p>
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {segments.map((segment) => (
                    <span key={segment} className="ve2-tag">
                      {segment}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
