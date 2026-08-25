'use client';

/**
 * Шаг 5 мастера «Движка вертикалей» — «Шаблон»: финальный боевой шаблон 85/15
 * под загруженную базу: письма с подсвеченными {{operators}}, сегментные
 * варианты, маппинг операторов, фиксированный блок и экспорт (копирование /
 * скачивание JSON). Поглощает старый TemplateView.
 */

import { useCallback, useMemo, useState, type JSX } from 'react';
import type { VeTemplate } from '@/lib/verticalEngineV2/types';
import {
  renderTemplatePreview,
  tokenizePreviewText,
  type VePreviewToken,
} from '@/lib/verticalEngineV2/renderPreview';
import {
  VE_LAUNCH_MAX_LEADS,
  parseLaunchInfo,
  type VeLaunchPresetOption,
  type VeTemplateLaunchInfo,
} from '@/lib/verticalEngineV2/launchHandoff';
import { VE_API, veEngineCall, veEnginePost, type VeBaseSummary, type VeJobSummary } from '../api';
import { HE, StatusDot } from '../design';
import { Badge, OperatorText, StatusBox, formatDate } from '../ui';

const TH_CLASS = 'px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-gray-500';

function templateToText(t: VeTemplate): string {
  const parts: string[] = [`ФИКСИРОВАННЫЙ БЛОК (85%):\n${t.fixed_block}`];
  t.letters.forEach((letter, idx) => {
    const wait = letter.wait_days > 0 ? ` (через ${letter.wait_days} дн.)` : '';
    parts.push(`\n--- ПИСЬМО ${idx + 1}${wait} ---\nТема: ${letter.subject ?? ''}\n\n${letter.body}`);
    (letter.segment_variants ?? []).forEach((v) => {
      parts.push(`\n[Вариант для сегмента: ${v.when}]\n${v.text}`);
    });
  });
  return parts.join('\n');
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

/** Ответ GET bases/[id]/template — шаблон + лёгкие строки базы для превью. */
interface VeTemplateGetResponse {
  template?: VeTemplate;
  columns?: string[];
  sample_rows?: Array<Record<string, unknown>>;
  /** Сегмент каждой sample-строки (when дословно) по индексу; null — дефолт/сбой. */
  sample_segments?: Array<string | null> | null;
  error?: string;
}

/** Дедуп имён операторов по lowercase-ключу, сохраняет первое написание. */
function dedupOperatorNames(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/**
 * Подсветка превью: подставленные значения — янтарные (зеркально OperatorText,
 * где янтарным был сам {{operator}}), запасной текст unmatched-операторов —
 * фиолетовый, неразрешённые операторы — красные.
 */
function PreviewTokens({ tokens, className }: { tokens: VePreviewToken[]; className?: string }) {
  return (
    <span className={className}>
      {tokens.map((t, i) =>
        t.kind === 'value' ? (
          <mark key={i} className="rounded bg-amber-100 px-0.5 text-amber-800">
            {t.text}
          </mark>
        ) : t.kind === 'fallback' ? (
          <mark
            key={i}
            title="Запасной текст: колонки нет"
            className="rounded bg-violet-100 px-0.5 text-violet-800"
          >
            {t.text}
          </mark>
        ) : t.kind === 'unresolved' ? (
          <mark key={i} className="rounded bg-red-100 px-0.5 font-mono text-[0.92em] text-red-700">
            {t.text}
          </mark>
        ) : (
          <span key={i}>{t.text}</span>
        ),
      )}
    </span>
  );
}

/**
 * «Превью по лидам»: финальные письма глазами конкретных лидов из базы.
 * Строки базы лениво подгружаются при первом раскрытии; рендер — чистый,
 * через renderTemplatePreview (сегментные варианты не применяются).
 */
function TemplateLeadPreview({ template, baseId }: { template: VeTemplate; baseId: string }) {
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [sample, setSample] = useState<{
    columns: string[];
    rows: Array<Record<string, unknown>>;
    segments: Array<string | null> | null;
  } | null>(null);

  const mapping = useMemo(
    () => template.personalization_plan?.operator_mapping ?? [],
    [template],
  );

  const handleToggle = (open: boolean) => {
    if (!open || (state !== 'idle' && state !== 'error')) return;
    setState('loading');
    veEngineCall<VeTemplateGetResponse>(`${VE_API}/bases/${baseId}/template`)
      .then(({ ok, data }) => {
        if (!ok) {
          setState('error');
          return;
        }
        setSample({
          columns: data.columns ?? [],
          rows: data.sample_rows ?? [],
          segments: data.sample_segments ?? null,
        });
        setState('ready');
      })
      .catch(() => setState('error'));
  };

  const preview = useMemo(() => {
    if (state !== 'ready' || !sample) return null;
    return renderTemplatePreview({
      letters: template.letters,
      operatorMapping: mapping,
      rows: sample.rows,
      columns: sample.columns,
      maxRows: 3,
      rowSegments: sample.segments ?? undefined,
    });
  }, [state, sample, template, mapping]);

  const hasVariants = template.letters.some((l) => (l.segment_variants ?? []).length > 0);
  const segmentsClassified = hasVariants && (sample?.segments ?? null) !== null;

  return (
    <details
      className={HE.card}
      onToggle={(e) => handleToggle(e.currentTarget.open)}
    >
      <summary className={`${HE.btnQuiet} w-full cursor-pointer select-none px-4 py-3`}>
        Превью по лидам — письма глазами конкретных лидов из базы
        <Badge tone="amber">новое</Badge>
      </summary>
      <div className="border-t border-gray-100 px-4 py-3">
        {state === 'loading' || state === 'idle' ? (
          <p className="text-xs text-gray-500">Загружаем строки базы…</p>
        ) : null}
        {state === 'error' ? (
          <p className="text-xs text-gray-500">
            Не удалось загрузить строки базы — превью недоступно. Закройте и откройте блок, чтобы
            повторить.
          </p>
        ) : null}
        {preview && preview.rows.length === 0 ? (
          <p className="text-xs text-gray-500">В базе нет строк для превью.</p>
        ) : null}
        {preview && preview.rows.length > 0 && sample ? (
          <div className="space-y-3">
            {preview.rows.map((leadRow, leadIdx) => {
              const rawRow = sample.rows[leadIdx] ?? {};
              const unresolved = dedupOperatorNames(leadRow.letters.flatMap((l) => l.unresolved));
              const emptyVars = dedupOperatorNames(leadRow.letters.flatMap((l) => l.emptyVars));
              return (
                <div key={leadIdx} className="rounded-lg border border-gray-200 bg-white p-3">
                  <p className="mb-2 text-xs font-semibold text-gray-700">{leadRow.rowLabel}</p>
                  <div className="space-y-2">
                    {leadRow.letters.map((letter, letterIdx) => {
                      // Токенизируем ИСХОДНЫЙ текст письма (индексы совпадают с
                      // template.letters) — иначе позиции подстановок потеряны.
                      const source = template.letters[letterIdx];
                      const subjectTokens = tokenizePreviewText(
                        source?.subject ?? '',
                        mapping,
                        rawRow,
                      ).tokens;
                      const bodyTokens = tokenizePreviewText(source?.body ?? '', mapping, rawRow).tokens;
                      return (
                        <div
                          key={letterIdx}
                          className="rounded-md border border-gray-100 bg-gray-50/60 px-3 py-2"
                        >
                          <p className="text-xs font-semibold text-gray-800">
                            Письмо {letterIdx + 1}
                            {letter.wait_days > 0 ? (
                              <span className="ml-1 font-normal text-gray-500">
                                через {letter.wait_days} дн.
                              </span>
                            ) : null}
                            {letter.subject ? (
                              <>
                                {' — '}
                                <PreviewTokens tokens={subjectTokens} />
                              </>
                            ) : null}
                          </p>
                          <PreviewTokens
                            tokens={bodyTokens}
                            className="mt-1 block whitespace-pre-wrap text-xs leading-relaxed text-gray-600"
                          />
                        </div>
                      );
                    })}
                  </div>
                  {unresolved.length > 0 ? (
                    <p className="mt-2 text-[11px] text-red-500">
                      Не подставлено: {unresolved.map((u) => `{{${u}}}`).join(', ')}
                    </p>
                  ) : null}
                  {emptyVars.length > 0 ? (
                    <p className="mt-1 text-[11px] text-gray-500">
                      Пустые значения у этого лида: {emptyVars.map((u) => `{{${u}}}`).join(', ')} —
                      в письме будет пустая строка
                    </p>
                  ) : null}
                </div>
              );
            })}
            {hasVariants ? (
              <p className="text-[11px] text-gray-500">
                {segmentsClassified
                  ? 'Сегментные варианты подставлены по классификации сегмента — совпадает с запуском.'
                  : 'Сегментные варианты не подставлены (классификация недоступна) — показан дефолтный текст писем.'}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </details>
  );
}

/* ── «Отправить в запуск»: PAUSED-кампания в Instantly из готового шаблона ── */

interface VeLaunchPresetsResponse {
  presets?: VeLaunchPresetOption[];
  error?: string;
}

interface VeLaunchResponse {
  ok?: boolean;
  launch?: VeTemplateLaunchInfo;
  warnings?: string[];
  error?: string;
}

/**
 * Состояние запуска шаблона. Пока в launch_info шаблона есть запись — вместо
 * формы показываем её (один запуск на шаблон; повторный force — только через API).
 */
function useTemplateLaunch(template: VeTemplate | null) {
  const [recorded, setRecorded] = useState<VeTemplateLaunchInfo | null>(() =>
    parseLaunchInfo((template as { launch_info?: unknown } | null)?.launch_info),
  );
  const [formOpen, setFormOpen] = useState(false);
  const [presets, setPresets] = useState<VeLaunchPresetOption[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [presetId, setPresetId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  const openForm = useCallback(() => {
    if (!template) return;
    setFormOpen(true);
    setSubmitError(null);
    if (presets !== null) return;
    veEngineCall<VeLaunchPresetsResponse>(`${VE_API}/templates/${template.id}/launch`)
      .then(({ ok, data }) => {
        if (!ok) {
          setLoadError(data.error ?? 'Не удалось загрузить пресеты');
          setPresets([]);
          return;
        }
        const list = data.presets ?? [];
        setPresets(list);
        setPresetId((cur) => cur || list[0]?.id || '');
      })
      .catch(() => {
        setLoadError('Не удалось загрузить пресеты');
        setPresets([]);
      });
  }, [presets, template]);

  const submit = useCallback(() => {
    if (!template || !presetId || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    veEnginePost<VeLaunchResponse>(`${VE_API}/templates/${template.id}/launch`, { preset_id: presetId })
      .then(({ ok, data }) => {
        if (!ok || !data.launch) {
          setSubmitError(data.error ?? 'Не удалось отправить в запуск');
          return;
        }
        setRecorded(data.launch);
        setWarnings(data.warnings ?? []);
        setFormOpen(false);
      })
      .catch(() => setSubmitError('Не удалось отправить в запуск'))
      .finally(() => setSubmitting(false));
  }, [template, presetId, submitting]);

  return {
    recorded,
    formOpen,
    setFormOpen,
    presets,
    loadError,
    presetId,
    setPresetId,
    submitting,
    submitError,
    warnings,
    openForm,
    submit,
  };
}

type TemplateLaunchState = ReturnType<typeof useTemplateLaunch>;

/** Записанный запуск (emerald) либо инлайн-форма выбора пресета. */
function LaunchSection({ launch }: { launch: TemplateLaunchState }) {
  if (launch.recorded) {
    const info = launch.recorded;
    const campaigns = info.campaigns && info.campaigns.length > 0 ? info.campaigns : null;
    return (
      <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3">
        <p className="flex items-center gap-2 text-sm font-medium text-emerald-800">
          <StatusDot tone="ok" />
          {campaigns && campaigns.length > 1
            ? `Кампании созданы (на паузе): ${campaigns.length} по сегментам · ${info.leads_count.toLocaleString('ru-RU')} лидов`
            : `Кампания создана (на паузе): ${info.campaign_name} · ${info.leads_count.toLocaleString('ru-RU')} лидов`}
        </p>
        <p className="mt-1 text-xs text-emerald-700">
          {info.campaign_url && !campaigns ? (
            <a href={info.campaign_url} target="_blank" rel="noreferrer" className="underline">
              Открыть в Instantly
            </a>
          ) : null}
          {info.created_at ? <span> · {formatDate(info.created_at)}</span> : null}
          <span> · Активация — вручную в Instantly после проверки</span>
        </p>
        {campaigns && campaigns.length > 1 ? (
          <ul className="mt-1.5 space-y-0.5 text-xs text-emerald-700">
            {campaigns.map((c) => (
              <li key={c.campaign_id}>
                <a href={c.campaign_url} target="_blank" rel="noreferrer" className="underline">
                  {c.segment ?? 'Основная (дефолтный текст)'}
                </a>
                <span> · {c.leads_count.toLocaleString('ru-RU')} лидов</span>
              </li>
            ))}
          </ul>
        ) : null}
        {launch.warnings.map((w) => (
          <p key={w} className="mt-1 text-xs text-amber-700">
            {w}
          </p>
        ))}
      </div>
    );
  }

  if (!launch.formOpen) return null;

  return (
    <div className="space-y-3 rounded-2xl border border-blue-200 bg-blue-50/50 px-4 py-3">
      <p className="text-sm font-medium text-gray-800">
        Запуск в Instantly: кампания будет создана <b>на паузе</b>, лиды загрузятся из базы.
        Активация — вручную после проверки.
      </p>
      {launch.presets === null && !launch.loadError ? (
        <p className="text-xs text-gray-500">Загружаем пресеты…</p>
      ) : null}
      {launch.loadError ? <p className="text-xs text-red-500">{launch.loadError}</p> : null}
      {launch.presets && launch.presets.length === 0 && !launch.loadError ? (
        <p className="text-xs text-gray-500">Нет доступных пресетов — сначала настройте пресет клиенту.</p>
      ) : null}
      {launch.presets && launch.presets.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={launch.presetId}
            onChange={(e) => launch.setPresetId(e.target.value)}
            className="h-9 rounded-lg border border-gray-200 bg-white px-2 text-xs text-gray-700 transition focus:border-blue-400 focus:outline-none"
            aria-label="Пресет запуска"
          >
            {launch.presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={launch.submit}
            disabled={launch.submitting || !launch.presetId}
            className={HE.btnPrimary}
          >
            {launch.submitting ? 'Создаём кампанию…' : 'Создать кампанию (на паузе)'}
          </button>
          <button type="button" onClick={() => launch.setFormOpen(false)} className={HE.btnGhost}>
            Отмена
          </button>
        </div>
      ) : null}
      {launch.submitError ? (
        <p className="text-xs text-red-600" role="alert">
          {launch.submitError}
        </p>
      ) : null}
    </div>
  );
}

export function Step5Template(props: {
  template: VeTemplate | null;
  base: VeBaseSummary | null;
  jobs: VeJobSummary[];
  onBuildTemplate: () => void;
}): JSX.Element {
  const { template, base, jobs, onBuildTemplate } = props;
  const [copied, setCopied] = useState(false);
  const [copiedLetterIdx, setCopiedLetterIdx] = useState<number | null>(null);
  const launch = useTemplateLaunch(template);

  const templateJob = useMemo(() => latestStageJob(jobs, 'template'), [jobs]);
  const busy = templateJob?.status === 'pending' || templateJob?.status === 'running';
  const failed = !busy && templateJob?.status === 'failed';

  const handleCopy = useCallback(() => {
    if (!template || typeof navigator === 'undefined' || !navigator.clipboard) return;
    void navigator.clipboard.writeText(templateToText(template)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [template]);

  // Копирование одного письма: «{subject}\n\n{body}», краткое «✓» на кнопке.
  const handleCopyLetter = useCallback(
    (idx: number) => {
      if (!template || typeof navigator === 'undefined' || !navigator.clipboard) return;
      const letter = template.letters[idx];
      if (!letter) return;
      const text = letter.subject ? `${letter.subject}\n\n${letter.body}` : letter.body;
      void navigator.clipboard.writeText(text).then(() => {
        setCopiedLetterIdx(idx);
        setTimeout(() => setCopiedLetterIdx((cur) => (cur === idx ? null : cur)), 1500);
      });
    },
    [template],
  );

  const handleDownload = useCallback(() => {
    if (!template) return;
    const blob = new Blob([JSON.stringify(template, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `he-template-${template.id}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [template]);

  /* ── Шаблона ещё нет ── */
  if (!template) {
    if (busy) {
      return (
        <div className="space-y-3">
          <StatusBox tone="info">Собираем шаблон под базу {base?.filename ?? '—'}…</StatusBox>
          <p className="text-xs text-gray-500">
            Обычно это занимает несколько минут — страницу можно не закрывать.
          </p>
        </div>
      );
    }
    if (failed) {
      return (
        <div className="space-y-3">
          <StatusBox tone="error">
            Сборка шаблона завершилась ошибкой{templateJob?.error ? `: ${templateJob.error}` : '.'}
          </StatusBox>
          <div>
            <button type="button" onClick={onBuildTemplate} className={HE.btnPrimary}>
              Попробовать снова
            </button>
          </div>
        </div>
      );
    }
    return (
      <div className={`${HE.card} flex min-h-[220px] flex-col items-center justify-center border-dashed p-10 text-center`}>
        <p className="text-sm font-medium text-gray-500">Шаблона пока нет</p>
        <p className={`mt-1 max-w-md text-xs ${HE.muted}`}>
          Движок адаптирует цепочку вертикали под базу
          {base?.filename ? ` «${base.filename}»` : ''} и расставит операторы персонализации.
        </p>
        <button type="button" onClick={onBuildTemplate} className={`${HE.btnPrimary} mt-4`}>
          Собрать шаблон
        </button>
      </div>
    );
  }

  /* ── Готовый шаблон ── */
  const mapping = template.personalization_plan?.operator_mapping ?? [];
  // Пречек лимита запуска: роут ответит 413 сверх VE_LAUNCH_MAX_LEADS —
  // не даём дойти до клика по «Отправить в запуск» с заведомо большой базой.
  const baseOverLaunchLimit = (base?.row_count ?? 0) > VE_LAUNCH_MAX_LEADS;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-bold text-gray-900">Шаблон 85/15</h2>
            {template.status === 'ready' ? (
              <Badge tone="emerald">Готов</Badge>
            ) : (
              <Badge tone="amber">Черновик</Badge>
            )}
          </div>
          <p className="mt-1 text-sm text-gray-500">
            Боевой шаблон: цепочка вертикали, адаптированная под базу {base?.filename ?? '—'}. В
            рассылку идёт этот текст.
          </p>
          <p className="mt-1 text-xs text-gray-500">
            Правится на шаге 3 (Контент) → пересобрать шаблон
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!launch.recorded ? (
            <button
              type="button"
              onClick={launch.openForm}
              disabled={baseOverLaunchLimit}
              className={HE.btnPrimary}
            >
              Отправить в запуск
            </button>
          ) : null}
          <button type="button" onClick={handleCopy} className={HE.btnGhost}>
            {copied ? '✓ Скопировано' : 'Скопировать'}
          </button>
          <button type="button" onClick={handleDownload} className={HE.btnGhost}>
            Скачать JSON
          </button>
        </div>
      </header>

      {/* База больше лимита запуска — кнопка выключена, объясняем почему */}
      {baseOverLaunchLimit ? (
        <p className="text-xs text-gray-500">
          База больше лимита запуска ({VE_LAUNCH_MAX_LEADS}). Скачайте CSV и запускайте порциями —
          или соберите базу меньшего лимита.
        </p>
      ) : null}

      {/* Отправка в запуск: запись о запуске либо форма выбора пресета */}
      <LaunchSection launch={launch} />

      {/* Превью по лидам — финальные письма с подставленными значениями базы */}
      <TemplateLeadPreview template={template} baseId={base?.id ?? template.base_id} />

      {/* Финальные письма */}
      <ol className="max-w-3xl space-y-3">
        {template.letters.map((letter, idx) => (
          <li key={idx} className={`${HE.card} p-4`}>
            <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className={`${HE.muted2} text-[11px] font-medium uppercase tracking-wider`}>
                Письмо {idx + 1}
                {letter.wait_days > 0 ? ` · через ${letter.wait_days} дн.` : ''}
              </span>
              {letter.subject ? (
                <OperatorText text={letter.subject} className="text-sm font-semibold text-gray-900" />
              ) : (
                <p className="text-sm italic text-gray-500">Без темы</p>
              )}
              <button
                type="button"
                onClick={() => handleCopyLetter(idx)}
                title="Скопировать письмо"
                aria-label="Скопировать письмо"
                className={`ml-auto ${HE.btnQuiet}`}
              >
                {copiedLetterIdx === idx ? '✓' : 'Скопировать'}
              </button>
            </div>
            <OperatorText
              text={letter.body}
              className="whitespace-pre-wrap text-sm leading-relaxed text-gray-700"
            />
            {letter.segment_variants?.length ? (
              <div className="mt-3 space-y-2">
                {letter.segment_variants.map((v, vi) => (
                  <details
                    key={`${v.when}-${vi}`}
                    className="rounded-lg border border-violet-200 bg-violet-50"
                  >
                    <summary className={`${HE.btnQuiet} w-full cursor-pointer select-none px-3 py-2`}>
                      Вариант для сегмента: {v.when}
                    </summary>
                    <div className="border-t border-violet-100 px-3 py-2">
                      <OperatorText
                        text={v.text}
                        className="whitespace-pre-wrap text-sm leading-relaxed text-gray-700"
                      />
                    </div>
                  </details>
                ))}
              </div>
            ) : null}
          </li>
        ))}
      </ol>

      {/* Фиксированный блок — длинный, свёрнут */}
      {template.fixed_block ? (
        <details className={HE.card}>
          <summary className={`${HE.btnQuiet} w-full cursor-pointer select-none px-4 py-3`}>
            Фиксированный блок (85%) — общая основа всех писем
          </summary>
          <div className="border-t border-gray-100 px-4 py-3">
            <div className="rounded-lg border-2 border-dashed border-blue-200 bg-blue-50/40 p-3">
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-gray-700">
                {template.fixed_block}
              </p>
            </div>
          </div>
        </details>
      ) : null}

      {/* Маппинг операторов на колонки базы — свёрнут */}
      {mapping.length > 0 ? (
        <details className={HE.card}>
          <summary className={`${HE.btnQuiet} w-full cursor-pointer select-none px-4 py-3`}>
            Маппинг операторов на колонки базы ({mapping.length})
          </summary>
          <div className="border-t border-gray-100 px-4 py-3">
            <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
              <table className="min-w-full divide-y divide-gray-200 text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className={TH_CLASS}>Оператор</th>
                    <th className={TH_CLASS}>Колонка базы</th>
                    <th className={TH_CLASS}>Статус</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {mapping.map((m, i) => (
                    <tr key={`${m.operator}-${i}`}>
                      <td className="px-3 py-2">
                        <code className="rounded bg-amber-100 px-1 py-0.5 font-mono text-xs text-amber-800">
                          {`{{${m.operator}}}`}
                        </code>
                      </td>
                      <td className="px-3 py-2 text-gray-700">{m.column ?? '—'}</td>
                      <td className="px-3 py-2">
                        {m.matched ? (
                          <Badge tone="emerald">Совпало</Badge>
                        ) : (
                          <span className="inline-flex flex-col items-start gap-0.5">
                            <Badge tone="red">Нет колонки</Badge>
                            {m.fallback ? (
                              <span className="text-[11px] text-gray-500">
                                Подставим: {m.fallback}
                              </span>
                            ) : null}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </details>
      ) : null}
    </div>
  );
}
