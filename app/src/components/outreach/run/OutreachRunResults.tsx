'use client';

import { Fragment, useCallback, useState } from 'react';
import { ChevronDown, ChevronRight, Download, FileText, Filter, Loader2, Mail, Square, Trash2, User, X } from 'lucide-react';
import { fmtUsd } from '@/lib/outreachLlm/format';
import { OutreachStages } from '@/components/parsers/OutreachStages';
import { ChainTemplates } from '@/components/outreach/ChainTemplates';
import { SenderBlock } from '@/components/outreach/SenderBlock';
import { OutreachStageModal } from './OutreachStageModal';
import { EmailsCell, LettersBlock, StatusBadge, TONE_ROW } from './parts';
import type { OutreachResultsResponse, OutreachRunAdapter, OutreachRunJob } from './types';

type Props<Row extends { id: string }, Config, Job extends OutreachRunJob> = {
  adapter: OutreachRunAdapter<Row, Config, Job>;
  job: Job | null;
  resp: (OutreachResultsResponse<Row> & Record<string, unknown>) | null;
  loading: boolean;
  /** Перечитать запуск и таблицу: «Переписать цепочку» меняет готовых и расход на ИИ. */
  onRefresh: () => void;
  /** Строки всего прогона — для разбора шага. */
  loadAllRows: () => Promise<Row[]>;
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  /** 'ready', 'all' или фильтр языка (очень спорные, ручная проверка). */
  filter: string;
  onFilterChange: (filter: string) => void;
  reason: string | null;
  onReasonChange: (reason: string | null) => void;
  actionsBusy: boolean;
  exportProgress: string | null;
  onExportCsv: () => void;
  onExportXlsx: () => void;
  onExtraExport: (kind: string) => void;
  onStopJob?: () => void;
  onDeleteJob?: () => void;
  /** Чужой запуск: смотреть можно, менять — только автору. */
  readOnly?: boolean;
  /** Имя автора, если запуск чужой. */
  author?: string | null;
};

const FILTER_TITLES: Record<string, string> = { ready: 'Готовые к отправке', all: 'Компании' };

export function OutreachRunResults<Row extends { id: string }, Config, Job extends OutreachRunJob>({
  adapter,
  job,
  resp,
  loading,
  onRefresh,
  loadAllRows,
  currentPage,
  totalPages,
  onPageChange,
  filter,
  onFilterChange,
  reason,
  onReasonChange,
  actionsBusy,
  exportProgress,
  onExportCsv,
  onExportXlsx,
  onExtraExport,
  onStopJob,
  onDeleteJob,
  readOnly = false,
  author = null,
}: Props<Row, Config, Job>) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [openStage, setOpenStage] = useState<number | null>(null);
  const jobStatus = job?.status ?? null;
  const running = jobStatus === 'running' || jobStatus === 'pending';
  const items = resp?.items ?? [];
  const count = resp?.count ?? 0;
  const hasItems = items.length > 0;
  const summary = adapter.runSummary(job);
  const readyCount = resp ? adapter.readyCount(resp) : null;
  const unverifiedCount = resp ? adapter.unverifiedCount(resp) : 0;
  const funnel = resp?.funnel ?? null;
  const counts = adapter.stageCounts(funnel);
  const jobUrl = job ? `${adapter.apiBase}/${job.id}` : null;
  const readyOnly = filter === 'ready';
  const extraFilter = adapter.extraFilters?.find((f) => f.status === filter) ?? null;
  const title = reason
    ? `Причина: ${adapter.reasonLabel(reason)}`
    : extraFilter?.label ?? FILTER_TITLES[filter] ?? 'Компании';
  const columnCount = adapter.columns.length + 6;

  const loadStage = useCallback(
    () =>
      job && openStage !== null
        ? adapter.loadStage({ jobId: job.id, stageIndex: openStage, funnel, loadAllRows })
        : Promise.resolve({ entries: [] }),
    // Окно грузится один раз на открытие шага: воронка за это время может
    // обновиться опросом, но перечитывать строки из-за неё незачем.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [job?.id, openStage],
  );

  return (
    <div className="space-y-4">
      {job && author ? (
        <div className="flex items-center gap-1.5 px-1 text-sm text-gray-500">
          <User className="h-4 w-4 shrink-0 text-violet-700" />
          Автор запуска: <span className="font-medium text-gray-900">{author}</span> · только просмотр
        </div>
      ) : null}
      {/* Цепочка шагов вместо ряда цифр: по плоской воронке не понять, где
          сейчас работа и где она встала. Пока запуск не выбран — цепочки нет. */}
      {jobStatus ? (
        <OutreachStages
          stages={adapter.stages.map((s, i) => ({ label: s.label, hint: s.hint, count: counts[i] ?? 0 }))}
          run={{ running, failed: jobStatus === 'failed' }}
          error={job?.error_message ?? null}
          onOpenStage={setOpenStage}
        />
      ) : null}

      {jobStatus && summary.llm ? (
        <div className="px-1 text-sm text-gray-500" title={`Вызовов ИИ: ${summary.llm.calls}`}>
          ИИ: потрачено {fmtUsd(summary.llm.spent_usd)} из {fmtUsd(summary.llm.limit_usd)}
        </div>
      ) : null}
      {/* Строки с непроверенной почтой — не отсев: адрес есть, решает человек. */}
      {jobStatus && unverifiedCount > 0 ? (
        <div
          className="px-1 text-sm text-amber-700"
          title="Адрес на сайте нашёлся, но SMTP-проверка не дала ответа: строки ждут ручной проверки, разбора ИИ и писем у них нет"
        >
          почта не проверена — {unverifiedCount}
        </div>
      ) : null}
      {jobStatus && summary.stopReason === 'budget' ? (
        <div className="rounded-lg bg-amber-50 px-3 py-1.5 text-sm text-amber-800">
          Остановлен: достигнут лимит на ИИ. Готовые компании сохранены — чтобы добрать остальные, повторите запуск с большим лимитом.
        </div>
      ) : null}
      {jobStatus && summary.stopReason === 'awaiting_templates' ? (
        <div className="rounded-lg bg-amber-50 px-3 py-1.5 text-sm text-amber-800">
          Набрано вместе с компаниями, которые ждут цепочку{summary.awaitingTemplates ? ` (${summary.awaitingTemplates})` : ''} — перепишите цепочку в
          блоке «Цепочки запуска»
        </div>
      ) : null}
      {/* Без SMTP-прокси адрес считается рабочим, если у домена есть почтовый сервер: письмо может не дойти. */}
      {jobStatus && summary.smtpUnavailable ? (
        <div className="rounded-lg bg-amber-50 px-3 py-1.5 text-sm text-amber-800">
          SMTP-проверка почт недоступна — почты проверены только по MX
        </div>
      ) : null}
      {job && adapter.summaryExtras ? adapter.summaryExtras(job) : null}

      {job && jobUrl ? (
        <>
          {/* Цепочки на экране не показываем — только когда компании ждут
              «Переписать цепочку»: без блока их не довести до готовых. */}
          {summary.stopReason === 'awaiting_templates' ? (
            <ChainTemplates key={job.id} jobUrl={jobUrl} running={running} lang={adapter.lang} onChanged={onRefresh} readOnly={readOnly} />
          ) : null}
          <SenderBlock key={`sender-${job.id}`} jobUrl={jobUrl} running={running} readyCount={readyCount} onChanged={onRefresh} />
        </>
      ) : null}

      {openStage !== null && job ? (
        <OutreachStageModal
          stageLabel={adapter.stages[openStage]?.label ?? 'Этап'}
          load={loadStage}
          onClose={() => setOpenStage(null)}
        />
      ) : null}

      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-gray-200 px-6 py-4">
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-semibold text-gray-900">
              {title} ({count})
            </h3>
            {reason ? (
              <button type="button" onClick={() => onReasonChange(null)} aria-label="Снять фильтр по причине" className="rounded p-0.5 text-gray-400 hover:text-gray-700">
                <X className="h-4 w-4" />
              </button>
            ) : null}
            {loading ? <Loader2 className="h-4 w-4 animate-spin text-gray-400" /> : null}
            {exportProgress ? <span className="text-xs text-gray-500">{exportProgress}</span> : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {/* По умолчанию на экране и в выгрузках только готовые строки:
                инструмент существует ради них. Отсеянные — за этой кнопкой. */}
            <button
              type="button"
              onClick={() => onFilterChange(readyOnly ? 'all' : 'ready')}
              className={`inline-flex items-center rounded-lg border px-3 py-1.5 text-sm font-medium transition ${
                readyOnly && !reason ? 'border-gray-200 text-gray-700 hover:bg-gray-50' : 'border-emerald-300 bg-emerald-50 text-emerald-800'
              }`}
            >
              {readyOnly && !reason ? (
                <>
                  <Filter className="mr-1.5 h-4 w-4" />
                  Показать отсеянные
                </>
              ) : (
                <>
                  <Mail className="mr-1.5 h-4 w-4" />
                  Только готовые
                  {readyCount != null ? <span className="ml-1.5 text-xs opacity-70">{readyCount}</span> : null}
                </>
              )}
            </button>
            {adapter.extraFilters?.map((f) => {
              const n = resp?.status_counts?.[f.status];
              const active = filter === f.status && !reason;
              return (
                <button
                  key={f.status}
                  type="button"
                  onClick={() => onFilterChange(active ? 'ready' : f.status)}
                  className={`inline-flex items-center rounded-lg border px-3 py-1.5 text-sm font-medium transition ${
                    active ? 'border-orange-300 bg-orange-50 text-orange-800' : 'border-gray-200 text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  {f.label}
                  {n != null ? <span className="ml-1.5 text-xs opacity-70">{n}</span> : null}
                </button>
              );
            })}
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
            {adapter.extraExports?.map((x) => (
              <button
                key={x.kind}
                type="button"
                onClick={() => onExtraExport(x.kind)}
                disabled={actionsBusy || !job}
                className="inline-flex items-center rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                <Download className="mr-1.5 h-4 w-4" /> {x.label}
              </button>
            ))}
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
            {running ? 'Конвейер работает. Первые строки появятся после выборки кандидатов.' : loading ? 'Загрузка...' : 'Нет результатов'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50">
                <tr className="text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  <th className="px-3 py-3" />
                  <th className="px-3 py-3">Компания</th>
                  <th className="px-3 py-3">Домен</th>
                  {adapter.columns.map((c) => (
                    <th key={c.header} className="px-3 py-3">{c.header}</th>
                  ))}
                  <th className="px-3 py-3">Почта</th>
                  <th className="px-3 py-3">Письма</th>
                  <th className="px-3 py-3">Статус</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {items.map((row) => {
                  const isOpen = expanded === row.id;
                  const tone = adapter.tone(row);
                  const letters = adapter.letters(row);
                  const website = adapter.website(row);
                  const domain = adapter.domain(row);
                  const note = adapter.companyNote?.(row) ?? null;
                  const statusNote = adapter.statusNote(row);
                  const reviewNote = adapter.reviewNote(row);
                  return (
                    <Fragment key={row.id}>
                      <tr className={`cursor-pointer hover:bg-gray-50 ${TONE_ROW[tone] ?? ''}`} onClick={() => setExpanded(isOpen ? null : row.id)}>
                        <td className="px-3 py-3 text-gray-400">
                          {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        </td>
                        <td className="px-3 py-3 font-medium text-gray-900">
                          <div className="max-w-[200px] truncate" title={adapter.companyName(row)}>
                            {adapter.companyName(row)}
                          </div>
                          {note ? <div className="text-[11px] font-normal text-gray-400">{note}</div> : null}
                        </td>
                        <td className="px-3 py-3">
                          {website ? (
                            <a
                              href={website}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-violet-700 hover:underline"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {domain ?? website}
                            </a>
                          ) : domain ? (
                            <span className="text-gray-700">{domain}</span>
                          ) : (
                            <span className="text-gray-400">—</span>
                          )}
                        </td>
                        {adapter.columns.map((c) => (
                          <td key={c.header} className="px-3 py-3 text-gray-600">
                            {c.cell(row)}
                          </td>
                        ))}
                        <td className="px-3 py-3">
                          <EmailsCell primary={adapter.primaryEmail(row)} verification={adapter.primaryVerification(row)} emails={adapter.emails(row)} />
                        </td>
                        <td className="px-3 py-3">
                          {letters.length ? (
                            <span className="inline-flex items-center gap-1 rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-800">
                              <FileText className="h-3 w-3" />
                              {letters.length} письма
                            </span>
                          ) : (
                            <span className="text-gray-400">—</span>
                          )}
                        </td>
                        <td className="px-3 py-3">
                          <StatusBadge tone={tone} label={adapter.statusLabel(row)} />
                          {statusNote ? (
                            <div className="mt-0.5 max-w-[160px] truncate text-[11px] text-gray-400" title={statusNote}>
                              {statusNote}
                            </div>
                          ) : null}
                          {adapter.statusExtra?.(row)}
                        </td>
                      </tr>
                      {isOpen ? (
                        <tr className="bg-gray-50/60">
                          <td colSpan={columnCount} className="px-6 py-4">
                            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                              <div className="space-y-3">
                                <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">{adapter.detailHeading(row)}</div>
                                {adapter.detailBlocks(row)}
                                {reviewNote ? (
                                  <div className="rounded-lg border border-amber-100 bg-amber-50 p-3 text-sm text-amber-900">{reviewNote}</div>
                                ) : null}
                              </div>
                              <LettersBlock letters={letters} subjectB={adapter.subjectB?.(row) ?? null} />
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
          {/* Кнопки рядом с номером страницы, а не по краям полосы: на широком
              экране между «Назад» и «Вперёд» было полтора метра пустоты. */}
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
