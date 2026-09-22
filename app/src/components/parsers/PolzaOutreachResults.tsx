'use client';

import { Fragment, useState } from 'react';
import type { PolzaOutreachCompanyRow, PolzaOutreachFunnel, ParserJobStatus } from '@/types';
import { POLZA_STAGE_LABELS, PolzaOutreachStages } from '@/components/parsers/PolzaOutreachStages';
import { PolzaOutreachStageModal } from '@/components/parsers/PolzaOutreachStageModal';
import { ChevronDown, ChevronRight, Download, ExternalLink, FileText, Loader2, Mail, Square, Trash2 } from 'lucide-react';

type Props = {
  items: PolzaOutreachCompanyRow[];
  count: number;
  funnel: PolzaOutreachFunnel | null;
  exclusionCounts: Record<string, number> | null;
  loading: boolean;
  jobStatus: ParserJobStatus | null;
  /** Текст ошибки запуска — показываем у этапа, на котором встали. */
  jobError?: string | null;
  /** Строки всего прогона — для разбора этапа. */
  loadAllRows?: () => Promise<PolzaOutreachCompanyRow[]>;
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  /** Показывать только готовые к отправке строки. */
  readyOnly: boolean;
  onReadyOnlyChange: (value: boolean) => void;
  actionsBusy: boolean;
  exportProgress: string | null;
  onExportCsv: () => void;
  onExportXlsx?: () => void;
  onStopJob?: () => void;
  onDeleteJob?: () => void;
};

const STATUS_LABELS: Record<string, string> = {
  discovered: 'найдена',
  normalized: 'домен найден',
  excluded: 'исключена',
  needs_review: 'на ручную проверку',
  qualified: 'квалифицирована',
  ready: 'готово',
  failed: 'ошибка',
};

const EXCLUSION_LABELS: Record<string, string> = {
  domain_not_resolved: 'домен не найден',
  competitor: 'конкурент (лидген)',
  staffing_agency: 'стаффинг/рекрутинг',
  generic_marketing: 'generic marketing',
  b2c_or_education: 'B2C/образование/маркетплейс',
  size_11_50: 'размер 11–50',
  duplicate_domain: 'дубль домена',
  no_outbound_mandate: 'нет outbound-мандата',
};

/**
 * Причины, по которым строка ушла на ручную проверку.
 *
 * Показывались машинным кодом («no_corporate_email»): оператору он ничего не
 * объясняет, а гадать по подчёркиваниям — не его работа.
 */
const REVIEW_LABELS: Record<string, string> = {
  no_corporate_email: 'не нашли корпоративную почту',
  generic_company: 'слишком общее описание компании',
  low_geo_confidence: 'гео продаж подтверждено слабо',
  letters_guard_failed: 'письма не прошли проверку правил',
};

function reviewLabel(reason: string): string {
  return REVIEW_LABELS[reason] ?? reason;
}

const CONFIDENCE_STYLES: Record<string, string> = {
  high: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  medium: 'border-amber-200 bg-amber-50 text-amber-800',
  low: 'border-gray-200 bg-gray-50 text-gray-500',
};

const STATUS_ROW_STYLES: Record<string, string> = {
  ready: 'bg-emerald-50/40',
  excluded: 'opacity-60',
  failed: 'bg-red-50/40',
};

function ConfidenceBadge({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="text-gray-400">—</span>;
  return (
    <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${CONFIDENCE_STYLES[value] ?? CONFIDENCE_STYLES.low}`}>
      {value}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === 'ready'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
      : status === 'excluded'
        ? 'border-gray-200 bg-gray-100 text-gray-500'
        : status === 'needs_review'
          ? 'border-amber-200 bg-amber-50 text-amber-800'
          : status === 'failed'
            ? 'border-red-200 bg-red-50 text-red-700'
            : 'border-blue-200 bg-blue-50 text-blue-700';
  return (
    <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${tone}`}>
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

function formatDate(value?: string | null) {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
  } catch {
    return value;
  }
}

function LettersBlock({ row }: { row: PolzaOutreachCompanyRow }) {
  if (!row.letters?.length) {
    return <div className="text-sm text-gray-400">Письма не собирались.</div>;
  }
  return (
    <div className="space-y-3">
      {row.letters.map((letter) => (
        <div key={letter.n} className="rounded-lg border border-gray-200 bg-gray-50 p-4">
          <div className="mb-2 flex items-center gap-2">
            <span className="rounded bg-violet-100 px-1.5 py-0.5 text-[11px] font-semibold text-violet-800">
              Письмо {letter.n}
            </span>
            <span className="text-sm font-medium text-gray-800">{letter.subject}</span>
          </div>
          <pre className="whitespace-pre-wrap break-words font-sans text-sm text-gray-700">{letter.body}</pre>
        </div>
      ))}
    </div>
  );
}

function EvidenceBlock({ row }: { row: PolzaOutreachCompanyRow }) {
  const hasMandate = Boolean(row.outbound_evidence);
  const hasGeo = Boolean(row.target_sales_geo_evidence);
  if (!hasMandate && !hasGeo) return null;
  return (
    <div className="rounded-lg border border-blue-100 bg-blue-50/60 p-4">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-blue-800">Доказательства (дословно из вакансии)</div>
      {hasMandate ? (
        <div className="mb-2">
          <div className="text-[11px] font-medium text-blue-700">
            Outbound-мандат {row.outbound_mandate === false ? '(мандат не подтверждён)' : ''}
          </div>
          <blockquote className="border-l-2 border-blue-300 pl-3 text-sm italic text-gray-700">«{row.outbound_evidence}»</blockquote>
        </div>
      ) : null}
      {hasGeo ? (
        <div>
          <div className="text-[11px] font-medium text-blue-700">
            Гео продаж: {row.target_sales_geo ?? '—'} (уверенность {row.target_sales_geo_confidence ?? '—'})
          </div>
          <blockquote className="border-l-2 border-blue-300 pl-3 text-sm italic text-gray-700">«{row.target_sales_geo_evidence}»</blockquote>
        </div>
      ) : null}
    </div>
  );
}

export function PolzaOutreachResults({
  items,
  count,
  funnel,
  exclusionCounts,
  loading,
  jobStatus,
  jobError,
  loadAllRows,
  currentPage,
  totalPages,
  onPageChange,
  readyOnly,
  onReadyOnlyChange,
  actionsBusy,
  exportProgress,
  onExportCsv,
  onExportXlsx,
  onStopJob,
  onDeleteJob,
}: Props) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [openStage, setOpenStage] = useState<number | null>(null);
  const running = jobStatus === 'running' || jobStatus === 'pending';
  const hasItems = items.length > 0;
  const readyCount = funnel ? Number(funnel.ready ?? 0) : null;

  return (
    <div className="space-y-4">
      {/* Цепочка этапов вместо ряда цифр: по плоской воронке не понять, где
          сейчас работа и где она встала — все нули выглядят одинаково и когда
          конвейер не запускали, и когда он упал на первом шаге.

          Пока запуск не выбран, цепочки нет вовсе: шесть строк с нулями
          занимают пол-экрана и не отвечают ни на один вопрос — этапы всегда
          про конкретный прогон. */}
      {jobStatus ? (
        <PolzaOutreachStages
          funnel={funnel}
          run={{ running, failed: jobStatus === 'failed' }}
          error={jobError}
          onOpenStage={loadAllRows ? setOpenStage : undefined}
        />
      ) : null}

      {openStage !== null && loadAllRows ? (
        <PolzaOutreachStageModal
          stageIndex={openStage}
          stageLabel={POLZA_STAGE_LABELS[openStage] ?? 'Этап'}
          loadRows={loadAllRows}
          reviewLabel={reviewLabel}
          exclusionLabel={(reason) => EXCLUSION_LABELS[reason] ?? reason}
          onClose={() => setOpenStage(null)}
        />
      ) : null}

      {exclusionCounts && Object.keys(exclusionCounts).length > 0 ? (
        <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
          <div className="mb-2 text-sm font-semibold text-gray-900">Почему отсеивались</div>
          <div className="flex flex-wrap gap-2">
            {Object.entries(exclusionCounts)
              .sort((a, b) => b[1] - a[1])
              .map(([reason, value]) => (
                <span key={reason} className="rounded-full border border-gray-200 bg-gray-50 px-2.5 py-0.5 text-xs text-gray-600">
                  {EXCLUSION_LABELS[reason] ?? reason}: {value}
                </span>
              ))}
          </div>
        </div>
      ) : null}

      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-gray-200 px-6 py-4">
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-semibold text-gray-900">
              {readyOnly ? 'Готовые к отправке' : 'Компании'} ({count})
            </h3>
            {loading ? <Loader2 className="h-4 w-4 animate-spin text-gray-400" /> : null}
            {exportProgress ? <span className="text-xs text-gray-500">{exportProgress}</span> : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {/* Отсеянные компании нужны, когда разбираешься, почему выход
                такой; когда пора отправлять — мешают. Переключатель отвечает
                сразу за таблицу и за обе выгрузки: что видно, то и выгрузится. */}
            <button
              type="button"
              onClick={() => onReadyOnlyChange(!readyOnly)}
              className={`inline-flex items-center rounded-lg border px-3 py-1.5 text-sm font-medium transition ${
                readyOnly
                  ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
                  : 'border-gray-200 text-gray-700 hover:bg-gray-50'
              }`}
            >
              <Mail className="mr-1.5 h-4 w-4" />
              Только готовые
              {readyCount != null ? <span className="ml-1.5 text-xs opacity-70">{readyCount}</span> : null}
            </button>
            <button
              type="button"
              onClick={onExportCsv}
              disabled={actionsBusy || !hasItems}
              className="inline-flex items-center rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              <Download className="mr-1.5 h-4 w-4" /> CSV
            </button>
            <button
              type="button"
              onClick={onExportXlsx}
              disabled={actionsBusy || !hasItems}
              className="inline-flex items-center rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              <Download className="mr-1.5 h-4 w-4" /> Excel
            </button>
            {running && onStopJob ? (
              <button
                type="button"
                onClick={onStopJob}
                className="inline-flex items-center rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-sm font-medium text-amber-800 hover:bg-amber-100"
              >
                <Square className="mr-1.5 h-4 w-4" /> Стоп
              </button>
            ) : null}
            {onDeleteJob ? (
              <button
                type="button"
                onClick={onDeleteJob}
                className="inline-flex items-center rounded-lg border border-red-200 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50"
                aria-label="Удалить запуск"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            ) : null}
          </div>
        </div>

        {!hasItems ? (
          <div className="px-6 py-12 text-center text-gray-500">
            {running ? 'Конвейер работает. Первые строки появятся после выборки вакансий.' : loading ? 'Загрузка...' : 'Нет результатов'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50">
                <tr className="text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  <th className="px-3 py-3" />
                  <th className="px-3 py-3">Компания</th>
                  <th className="px-3 py-3">Домен</th>
                  <th className="px-3 py-3">Вакансия</th>
                  <th className="px-3 py-3">Услуга</th>
                  <th className="px-3 py-3">Гео продаж</th>
                  <th className="px-3 py-3">Уверенность</th>
                  <th className="px-3 py-3">Почта</th>
                  <th className="px-3 py-3">Письма</th>
                  <th className="px-3 py-3">Статус</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {items.map((row) => {
                  const isOpen = expanded === row.id;
                  return (
                    <Fragment key={row.id}>
                      <tr
                        className={`cursor-pointer hover:bg-gray-50 ${STATUS_ROW_STYLES[row.status] ?? ''}`}
                        onClick={() => setExpanded(isOpen ? null : row.id)}
                      >
                        <td className="px-3 py-3 text-gray-400">
                          {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        </td>
                        <td className="px-3 py-3 font-medium text-gray-900">
                          <div className="max-w-[200px] truncate" title={row.company_name}>
                            {row.company_name}
                          </div>
                        </td>
                        <td className="px-3 py-3">
                          {row.company_website ? (
                            <a
                              href={row.company_website}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-violet-700 hover:underline"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {row.normalized_domain}
                            </a>
                          ) : (
                            <span className="text-gray-400">—</span>
                          )}
                        </td>
                        <td className="px-3 py-3">
                          {row.job_source_url ? (
                            <a
                              href={row.job_source_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex max-w-[220px] items-center gap-1 text-blue-700 hover:underline"
                              title={row.job_title ?? ''}
                              onClick={(e) => e.stopPropagation()}
                            >
                              <span className="truncate">{row.job_title ?? 'вакансия'}</span>
                              <ExternalLink className="h-3 w-3 shrink-0 text-gray-400" />
                            </a>
                          ) : (
                            <span className="text-gray-400">—</span>
                          )}
                        </td>
                        <td className="px-3 py-3 text-gray-600">
                          <div className="max-w-[180px] truncate" title={row.service_line ?? ''}>
                            {row.service_line ?? '—'}
                          </div>
                        </td>
                        <td className="px-3 py-3 text-gray-600">
                          <div className="max-w-[140px] truncate" title={row.target_sales_geo ?? ''}>
                            {row.target_sales_geo ?? '—'}
                          </div>
                        </td>
                        <td className="px-3 py-3">
                          <ConfidenceBadge value={row.target_sales_geo_confidence} />
                        </td>
                        <td className="px-3 py-3">
                          {row.selected_company_email ? (
                            <span className="inline-flex max-w-[180px] items-center gap-1 truncate text-gray-700" title={row.selected_company_email}>
                              <Mail className="h-3 w-3 shrink-0 text-gray-400" />
                              {row.selected_company_email}
                            </span>
                          ) : (
                            <span className="text-gray-400">—</span>
                          )}
                        </td>
                        <td className="px-3 py-3">
                          {row.letters?.length ? (
                            <span className="inline-flex items-center gap-1 rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-800">
                              <FileText className="h-3 w-3" />
                              {row.letters.length} письма
                            </span>
                          ) : (
                            <span className="text-gray-400">—</span>
                          )}
                        </td>
                        <td className="px-3 py-3">
                          <StatusBadge status={row.status} />
                          {row.exclusion_reason ? (
                            <div className="mt-0.5 max-w-[140px] truncate text-[11px] text-gray-400" title={row.exclusion_reason}>
                              {EXCLUSION_LABELS[row.exclusion_reason] ?? row.exclusion_reason}
                            </div>
                          ) : null}
                          {row.review_reason ? (
                            <div className="mt-0.5 max-w-[140px] truncate text-[11px] text-gray-400" title={reviewLabel(row.review_reason)}>
                              {reviewLabel(row.review_reason)}
                            </div>
                          ) : null}
                        </td>
                      </tr>
                      {isOpen ? (
                        <tr className="bg-gray-50/60">
                          <td colSpan={10} className="px-6 py-4">
                            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                              <div className="space-y-3">
                                <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                                  Вакансия от {formatDate(row.job_published_at)} · {row.job_country_code?.toUpperCase() ?? '—'}
                                </div>
                                <EvidenceBlock row={row} />
                                {row.review_reason ? (
                                  <div className="rounded-lg border border-amber-100 bg-amber-50 p-3 text-sm text-amber-900">
                                    На ручную проверку: {reviewLabel(row.review_reason)}
                                  </div>
                                ) : null}
                              </div>
                              <LettersBlock row={row} />
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {totalPages > 1 ? (
        <div className="flex items-center justify-center gap-4 rounded-xl border border-gray-200 bg-white px-6 py-3 text-sm shadow-sm">
          {/* Кнопки стоят рядом с номером страницы, а не по краям полосы: на
              широком экране между «Назад» и «Вперёд» было полтора метра пустоты,
              и мышь ездила через весь экран ради одного клика. */}
          <button
            type="button"
            onClick={() => onPageChange(currentPage - 1)}
            disabled={currentPage <= 1 || loading}
            className="rounded-lg border border-gray-200 px-3 py-1.5 text-gray-700 hover:bg-gray-50 disabled:opacity-40"
          >
            Назад
          </button>
          <span className="text-gray-500">
            Стр. {currentPage} из {totalPages}
          </span>
          <button
            type="button"
            onClick={() => onPageChange(currentPage + 1)}
            disabled={currentPage >= totalPages || loading}
            className="rounded-lg border border-gray-200 px-3 py-1.5 text-gray-700 hover:bg-gray-50 disabled:opacity-40"
          >
            Вперед
          </button>
        </div>
      ) : null}
    </div>
  );
}
