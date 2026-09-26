'use client';

import { Download, Loader2, Square } from 'lucide-react';
import { CHAIN_LABELS, REASON_LABELS, SOURCE_LABELS, type ChainType, type SourceCode } from '@/lib/polzaRuOutreach/types';
import { ChainTemplates } from '@/components/outreach/ChainTemplates';
import { JOB_STATUS } from './JobList';
import { Reasons, ResultsTable } from './Results';
import { RuStages } from './Stages';
import { API, RESULTS_PAGE, RESULT_FILTERS, fmtDateTime, fmtUsd, type ResultsFilter, type ResultsResponse, type RuJob } from './shared';

export type ExportKind = 'ready' | 'doubtful' | 'journal';

interface Props {
  job: RuJob;
  results: ResultsResponse | null;
  loading: boolean;
  exporting: string | null;
  filter: ResultsFilter;
  reason: string | null;
  page: number;
  onFilter: (f: ResultsFilter) => void;
  onReason: (code: string | null) => void;
  onPage: (p: number) => void;
  onStop: () => void;
  onExport: (kind: ExportKind) => void;
  /** Перечитать запуск и таблицу: «Переписать цепочку» меняет готовых и расход на ИИ. */
  onRefresh: () => void;
}

export function JobDetail({ job, results, loading, exporting, filter, reason, page, onFilter, onReason, onPage, onStop, onExport, onRefresh }: Props) {
  const running = job.status === 'running' || job.status === 'pending';
  const detail = job.progress_detail ?? null;
  const totalPages = Math.max(1, Math.ceil((results?.count ?? 0) / RESULTS_PAGE));
  const target = job.config?.limit ?? null;
  const llm = detail?.llm ?? null;

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-base font-semibold text-gray-900">
              {target ? `Запуск на ${target} компаний` : 'Запуск'}
            </div>
            <div className="mt-0.5 text-sm text-gray-500">
              {fmtDateTime(job.created_at)} · {JOB_STATUS[job.status]}
              {running && <> · {job.progress_percent ?? 0}% · в пуле {detail?.pool ?? '…'} компаний</>}
              {detail?.doubtful ? ` · очень спорных ${detail.doubtful}` : ''}
              {detail?.stop_reason === 'pool_exhausted' && ' · кандидаты закончились раньше лимита'}
              {detail?.stop_reason === 'scan_limit' && ' · достигнут потолок просмотра'}
            </div>
            {llm && (
              <div className="mt-0.5 text-sm text-gray-500" title={`Вызовов ИИ: ${llm.calls}`}>
                ИИ: потрачено {fmtUsd(llm.spent_usd)} из {fmtUsd(llm.limit_usd)}
              </div>
            )}
            {detail?.stop_reason === 'budget' && (
              <div className="mt-2 rounded-lg bg-amber-50 px-3 py-1.5 text-sm text-amber-800">
                Остановлен: достигнут лимит на ИИ. Готовые компании сохранены — чтобы добрать остальные, повторите запуск с большим лимитом.
              </div>
            )}
            {/* Без SMTP-прокси адрес считается рабочим, если у домена есть почтовый сервер: письмо может не дойти. */}
            {detail?.smtp_unavailable && (
              <div className="mt-2 rounded-lg bg-amber-50 px-3 py-1.5 text-sm text-amber-800">
                SMTP-проверка почт недоступна — почты проверены только по MX
              </div>
            )}
            {job.status === 'failed' && job.error_message ? (
              <div className="mt-2 rounded-lg bg-red-50 px-3 py-1.5 text-sm text-red-700">{job.error_message}</div>
            ) : null}
          </div>

          <div className="flex shrink-0 flex-wrap gap-2">
            {running && (
              <button type="button" onClick={onStop} className="inline-flex items-center rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50">
                <Square className="mr-1.5 h-4 w-4" /> Остановить
              </button>
            )}
            <button
              type="button"
              disabled={exporting !== null}
              onClick={() => onExport('ready')}
              className="inline-flex items-center rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50"
            >
              {exporting === 'ready' ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Download className="mr-1.5 h-4 w-4" />}
              Excel: готовые
            </button>
            <button
              type="button"
              disabled={exporting !== null}
              onClick={() => onExport('doubtful')}
              className="inline-flex items-center rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              {exporting === 'doubtful' ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Download className="mr-1.5 h-4 w-4" />}
              Excel: очень спорные
            </button>
            <button
              type="button"
              disabled={exporting !== null}
              onClick={() => onExport('journal')}
              className="inline-flex items-center rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              {exporting === 'journal' ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Download className="mr-1.5 h-4 w-4" />}
              Excel: журнал
            </button>
          </div>
        </div>

        {running && (
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-gray-200">
            <div className="h-1.5 rounded-full bg-violet-600 transition-all duration-500" style={{ width: `${Math.min(100, job.progress_percent ?? 0)}%` }} />
          </div>
        )}

        {detail?.source_errors && Object.keys(detail.source_errors).length > 0 && (
          <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            Источники с ошибкой (запуск шёл без них):{' '}
            {Object.entries(detail.source_errors)
              .map(([code, msg]) => `${SOURCE_LABELS[code as SourceCode] ?? code}: ${msg}`)
              .join(' · ')}
          </div>
        )}

        {detail?.chains && Object.keys(detail.chains).length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            <span className="text-gray-500">Цепочки после скоринга:</span>
            {Object.entries(detail.chains).map(([c, n]) => (
              <span key={c} className="rounded-full bg-violet-50 px-2 py-0.5 text-violet-700">
                {CHAIN_LABELS[c as ChainType] ?? c}: {n}
              </span>
            ))}
          </div>
        )}

        {/* Вакансии разбираются после поиска почты — поэтому считаются только компании с рабочей почтой. */}
        {detail?.sdr && detail.sdr.any_sales_vacancy > 0 && (
          <p className="mt-2 text-xs text-gray-500">
            Вакансии продаж (среди компаний с рабочей почтой): у {detail.sdr.any_sales_vacancy} компаний. В SDR-цепочку — {detail.sdr.strict_sdr} (роль
            SDR/BDR и холодный поиск новых B2B-клиентов), остальные {detail.sdr.broad_to_general_queue} идут по другим поводам.
          </p>
        )}
      </div>

      <RuStages jobId={job.id} funnel={results?.funnel ?? null} run={{ running, failed: job.status === 'failed' }} error={job.error_message} />

      <ChainTemplates key={job.id} jobUrl={`${API}/${job.id}`} running={running} lang="ru" onChanged={onRefresh} />

      <Reasons
        reasons={results?.reason_counts ?? null}
        onReason={(code) => {
          onReason(code);
          onPage(1);
        }}
      />

      <div className="flex flex-wrap items-center gap-2">
        {RESULT_FILTERS.map(([f, l]) => (
          <button
            key={f}
            type="button"
            onClick={() => {
              onFilter(f);
              onReason(null);
              onPage(1);
            }}
            className={`rounded-full px-3 py-1 text-sm ${!reason && filter === f ? 'bg-violet-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
          >
            {l}
            {f !== 'all' && results?.status_counts?.[f] != null ? ` · ${results.status_counts[f]}` : ''}
          </button>
        ))}
        {reason && (
          <span className="rounded-full bg-amber-100 px-3 py-1 text-sm text-amber-700">
            Причина: {REASON_LABELS[reason] ?? reason}
            <button type="button" className="ml-2" onClick={() => onReason(null)} aria-label="Снять фильтр по причине">
              ×
            </button>
          </span>
        )}
        {loading && <Loader2 className="h-4 w-4 animate-spin text-gray-400" />}
      </div>

      <ResultsTable rows={results?.items ?? []} />

      {totalPages > 1 && (
        <div className="flex items-center justify-between gap-3 border-t border-gray-200 pt-3 text-sm">
          <span className="text-xs text-gray-500">
            {(page - 1) * RESULTS_PAGE + 1}–{Math.min(page * RESULTS_PAGE, results?.count ?? 0)} из {results?.count ?? 0}
          </span>
          <span className="flex items-center gap-1">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => onPage(page - 1)}
              className="rounded-md px-2 py-1 text-xs text-gray-700 hover:bg-gray-100 disabled:opacity-40 disabled:hover:bg-transparent"
            >
              Назад
            </button>
            <span className="px-1 text-xs text-gray-500">
              стр. {page} из {totalPages}
            </span>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => onPage(page + 1)}
              className="rounded-md px-2 py-1 text-xs text-gray-700 hover:bg-gray-100 disabled:opacity-40 disabled:hover:bg-transparent"
            >
              Вперёд
            </button>
          </span>
        </div>
      )}
    </div>
  );
}
