'use client';

/**
 * Шаг 5 мастера «Движка вертикалей» — «Шаблон»: финальный боевой шаблон 85/15
 * под загруженную базу: письма с подсвеченными {{operators}}, сегментные
 * варианты, маппинг операторов, фиксированный блок и экспорт (копирование /
 * скачивание JSON). Поглощает старый TemplateView.
 */

import { useCallback, useMemo, useState, type JSX } from 'react';
import { Check, Copy, Download, Eye, FileText, Sparkles, User } from 'lucide-react';
import type { HeTemplate } from '@/lib/hypothesisEngine/types';
import {
  renderTemplatePreview,
  tokenizePreviewText,
  type HePreviewToken,
} from '@/lib/hypothesisEngine/renderPreview';
import { HE_API, heCall, type HeBaseSummary, type HeJobSummary } from '../api';
import { Badge, OperatorText, StatusBox } from '../ui';

const PRIMARY_BTN =
  'inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-blue-600 px-5 text-sm font-medium text-white transition hover:bg-blue-700';
const SECONDARY_BTN =
  'inline-flex h-9 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 text-xs font-medium text-gray-600 transition hover:bg-gray-50';
const TH_CLASS = 'px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-gray-500';

function templateToText(t: HeTemplate): string {
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
function latestStageJob(jobs: HeJobSummary[], stage: HeJobSummary['stage']): HeJobSummary | undefined {
  let best: HeJobSummary | undefined;
  for (const job of jobs) {
    if (job.stage !== stage) continue;
    if (!best || (job.started_at ?? '') >= (best.started_at ?? '')) best = job;
  }
  return best;
}

/** Ответ GET bases/[id]/template — шаблон + лёгкие строки базы для превью. */
interface HeTemplateGetResponse {
  template?: HeTemplate;
  columns?: string[];
  sample_rows?: Array<Record<string, unknown>>;
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
function PreviewTokens({ tokens, className }: { tokens: HePreviewToken[]; className?: string }) {
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
function TemplateLeadPreview({ template, baseId }: { template: HeTemplate; baseId: string }) {
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [sample, setSample] = useState<{
    columns: string[];
    rows: Array<Record<string, unknown>>;
  } | null>(null);

  const mapping = useMemo(
    () => template.personalization_plan?.operator_mapping ?? [],
    [template],
  );

  const handleToggle = (open: boolean) => {
    if (!open || (state !== 'idle' && state !== 'error')) return;
    setState('loading');
    heCall<HeTemplateGetResponse>(`${HE_API}/bases/${baseId}/template`)
      .then(({ ok, data }) => {
        if (!ok) {
          setState('error');
          return;
        }
        setSample({ columns: data.columns ?? [], rows: data.sample_rows ?? [] });
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
    });
  }, [state, sample, template, mapping]);

  const hasVariants = template.letters.some((l) => (l.segment_variants ?? []).length > 0);

  return (
    <details
      className="rounded-2xl border border-amber-200 bg-amber-50/40 shadow-sm"
      onToggle={(e) => handleToggle(e.currentTarget.open)}
    >
      <summary className="flex cursor-pointer select-none flex-wrap items-center gap-2 px-4 py-3 text-sm font-medium text-gray-600 hover:text-gray-800">
        <Eye className="h-4 w-4 text-amber-500" aria-hidden />
        Превью по лидам — письма глазами конкретных лидов из базы
        <Badge tone="amber">новое</Badge>
      </summary>
      <div className="border-t border-amber-100 px-4 py-3">
        {state === 'loading' || state === 'idle' ? (
          <p className="text-xs text-gray-400">Загружаем строки базы…</p>
        ) : null}
        {state === 'error' ? (
          <p className="text-xs text-gray-400">
            Не удалось загрузить строки базы — превью недоступно. Закройте и откройте блок, чтобы
            повторить.
          </p>
        ) : null}
        {preview && preview.rows.length === 0 ? (
          <p className="text-xs text-gray-400">В базе нет строк для превью.</p>
        ) : null}
        {preview && preview.rows.length > 0 && sample ? (
          <div className="space-y-3">
            {preview.rows.map((leadRow, leadIdx) => {
              const rawRow = sample.rows[leadIdx] ?? {};
              const unresolved = dedupOperatorNames(leadRow.letters.flatMap((l) => l.unresolved));
              const emptyVars = dedupOperatorNames(leadRow.letters.flatMap((l) => l.emptyVars));
              return (
                <div key={leadIdx} className="rounded-lg border border-gray-200 bg-white p-3">
                  <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-gray-700">
                    <User className="h-3.5 w-3.5 text-gray-400" aria-hidden />
                    {leadRow.rowLabel}
                  </p>
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
                              <span className="ml-1 font-normal text-gray-400">
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
                    <p className="mt-1 text-[11px] text-gray-400">
                      Пустые значения у этого лида: {emptyVars.map((u) => `{{${u}}}`).join(', ')} —
                      в письме будет пустая строка
                    </p>
                  ) : null}
                </div>
              );
            })}
            {hasVariants ? (
              <p className="text-[11px] text-gray-400">
                Сегментные варианты в превью не применяются — показан дефолтный текст писем.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </details>
  );
}

export function Step5Template(props: {
  template: HeTemplate | null;
  base: HeBaseSummary | null;
  jobs: HeJobSummary[];
  onBuildTemplate: () => void;
}): JSX.Element {
  const { template, base, jobs, onBuildTemplate } = props;
  const [copied, setCopied] = useState(false);
  const [copiedLetterIdx, setCopiedLetterIdx] = useState<number | null>(null);

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
          <p className="text-xs text-gray-400">
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
            <button type="button" onClick={onBuildTemplate} className={PRIMARY_BTN}>
              <Sparkles className="h-4 w-4" aria-hidden />
              Попробовать снова
            </button>
          </div>
        </div>
      );
    }
    return (
      <div className="flex min-h-[220px] flex-col items-center justify-center rounded-2xl border border-dashed border-gray-200 bg-gray-50/50 p-10 text-center">
        <FileText className="mb-3 h-8 w-8 text-gray-300" aria-hidden />
        <p className="text-sm font-medium text-gray-500">Шаблона пока нет</p>
        <p className="mt-1 max-w-md text-xs text-gray-400">
          Движок адаптирует цепочку вертикали под базу
          {base?.filename ? ` «${base.filename}»` : ''} и расставит операторы персонализации.
        </p>
        <button type="button" onClick={onBuildTemplate} className={`${PRIMARY_BTN} mt-4`}>
          <Sparkles className="h-4 w-4" aria-hidden />
          Собрать шаблон
        </button>
      </div>
    );
  }

  /* ── Готовый шаблон ── */
  const mapping = template.personalization_plan?.operator_mapping ?? [];

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <FileText className="h-4 w-4 text-gray-400" aria-hidden />
            <h2 className="text-lg font-bold text-gray-900">Шаблон 85/15</h2>
            {template.status === 'ready' ? (
              <Badge tone="emerald">Готов</Badge>
            ) : (
              <Badge tone="amber">Черновик</Badge>
            )}
          </div>
          <p className="mt-1 text-sm text-gray-400">
            Боевой шаблон: цепочка вертикали, адаптированная под базу {base?.filename ?? '—'}. В
            рассылку идёт этот текст.
          </p>
          <p className="mt-1 text-xs text-gray-400">
            Правится на шаге 3 (Контент) → пересобрать шаблон
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button type="button" onClick={handleCopy} className={SECONDARY_BTN}>
            {copied ? (
              <Check className="h-3.5 w-3.5 text-emerald-500" aria-hidden />
            ) : (
              <Copy className="h-3.5 w-3.5" aria-hidden />
            )}
            {copied ? 'Скопировано' : 'Скопировать всё'}
          </button>
          <button type="button" onClick={handleDownload} className={SECONDARY_BTN}>
            <Download className="h-3.5 w-3.5" aria-hidden />
            Скачать JSON
          </button>
        </div>
      </header>

      {/* Превью по лидам — финальные письма с подставленными значениями базы */}
      <TemplateLeadPreview template={template} baseId={base?.id ?? template.base_id} />

      {/* Финальные письма */}
      <ol className="max-w-3xl space-y-3">
        {template.letters.map((letter, idx) => (
          <li key={idx} className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-blue-100 text-[11px] font-bold text-blue-700">
                {idx + 1}
              </span>
              {letter.subject ? (
                <OperatorText text={letter.subject} className="text-sm font-semibold text-gray-900" />
              ) : (
                <p className="text-sm italic text-gray-400">Без темы</p>
              )}
              {letter.wait_days > 0 ? (
                <span className="text-[11px] text-gray-400">через {letter.wait_days} дн.</span>
              ) : null}
              <button
                type="button"
                onClick={() => handleCopyLetter(idx)}
                title="Скопировать письмо"
                aria-label="Скопировать письмо"
                className="ml-auto inline-flex h-8 w-8 items-center justify-center rounded-md text-gray-400 transition hover:bg-gray-100 hover:text-gray-600"
              >
                {copiedLetterIdx === idx ? (
                  <Check className="h-3.5 w-3.5 text-emerald-500" aria-hidden />
                ) : (
                  <Copy className="h-3.5 w-3.5" aria-hidden />
                )}
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
                    <summary className="cursor-pointer select-none px-3 py-2 text-xs font-semibold text-violet-700">
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
        <details className="rounded-2xl border border-gray-200 bg-white shadow-sm">
          <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium text-gray-600 hover:text-gray-800">
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
        <details className="rounded-2xl border border-gray-200 bg-white shadow-sm">
          <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium text-gray-600 hover:text-gray-800">
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
                              <span className="text-[11px] text-gray-400">
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
