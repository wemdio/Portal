'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import type { PolzaOutreachCompanyRow } from '@/types';

/**
 * Что происходило на конкретном этапе конвейера.
 *
 * Цепочка этапов отвечает «сколько прошло и сколько отсеялось», но не
 * отвечает «кто именно и почему». Между «домен нашёлся у 32 из 100» и
 * доверием к этой цифре стоит ровно один вопрос: а у кого не нашёлся. Здесь
 * на него и отвечаем — списком компаний с тем, что этап про них узнал.
 *
 * Строки берём одним запросом на весь прогон, а не с текущей страницы
 * таблицы: этап — это про весь прогон, и показывать его по полусотне строк,
 * случайно оказавшихся на экране, значило бы отвечать не на тот вопрос.
 */

export interface StageModalProps {
  /** Номер этапа с нуля: 0 — вакансии, 5 — цепочка писем. */
  stageIndex: number;
  stageLabel: string;
  loadRows: () => Promise<PolzaOutreachCompanyRow[]>;
  reviewLabel: (reason: string) => string;
  exclusionLabel: (reason: string) => string;
  onClose: () => void;
}

interface StageEntry {
  row: PolzaOutreachCompanyRow;
  /** Прошла ли строка этот этап дальше. */
  passed: boolean;
  /** Что этап узнал: домен, гео, почта — то, ради чего он и есть. */
  detail: string;
  /** Почему не прошла. */
  reason: string | null;
}

/**
 * Разбор строки на конкретном этапе.
 *
 * Каждый этап смотрит на свои поля — поэтому это не общий рендер таблицы, а
 * шесть маленьких правил. Зато в окне видно именно то, что этап делает, а не
 * двадцать колонок, из которых нужны две.
 */
function describe(
  row: PolzaOutreachCompanyRow,
  stageIndex: number,
  reviewLabel: (reason: string) => string,
  exclusionLabel: (reason: string) => string,
): StageEntry {
  const excluded = row.status === 'excluded' && row.exclusion_reason
    ? exclusionLabel(row.exclusion_reason)
    : null;

  switch (stageIndex) {
    case 0:
      return {
        row,
        passed: true,
        detail: [row.source_list?.length ? row.source_list.join(' + ') : row.source_type, row.job_title, row.job_country_code?.toUpperCase()].filter(Boolean).join(' · ') || '—',
        reason: null,
      };
    case 1: {
      const domain = row.normalized_domain ?? '';
      return {
        row,
        passed: Boolean(domain),
        detail: domain || '—',
        reason: domain ? null : (excluded ?? 'домен не найден'),
      };
    }
    case 2: {
      const passed = row.status !== 'excluded';
      return {
        row,
        passed,
        detail: [row.employee_range ? `${row.employee_range} чел.` : null, row.industry, row.country].filter(Boolean).join(' · ') || '—',
        reason: passed ? null : excluded,
      };
    }
    case 3: {
      const passed = row.lead_status === 'write_now' || row.stage === 's5_email' || row.stage === 's6_letters';
      const score = row.lead_score != null ? `${row.lead_score}/100` : null;
      return {
        row,
        passed,
        detail: [score, row.primary_trigger].filter(Boolean).join(' · ') || '—',
        reason: passed ? null : (excluded ?? (row.review_reason ? reviewLabel(row.review_reason) : 'Lead Score ниже порога')),
      };
    }
    case 4: {
      const email = row.selected_company_email ?? '';
      return {
        row,
        passed: Boolean(email),
        detail: email || '—',
        reason: email ? null : (row.review_reason ? reviewLabel(row.review_reason) : (excluded ?? 'почта не найдена')),
      };
    }
    default: {
      const letters = row.letters?.length ?? 0;
      return {
        row,
        passed: letters > 0,
        detail: letters > 0 ? `писем: ${letters}` : '—',
        reason: letters > 0 ? null : (row.review_reason ? reviewLabel(row.review_reason) : (excluded ?? 'письма не собраны')),
      };
    }
  }
}

export function PolzaOutreachStageModal({
  stageIndex,
  stageLabel,
  loadRows,
  reviewLabel,
  exclusionLabel,
  onClose,
}: StageModalProps) {
  const [rows, setRows] = useState<PolzaOutreachCompanyRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [onlyFailed, setOnlyFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows(await loadRows());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось загрузить строки');
      setRows([]);
    }
  }, [loadRows]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const entries = (rows ?? []).map((row) => describe(row, stageIndex, reviewLabel, exclusionLabel));
  const passedCount = entries.filter((entry) => entry.passed).length;
  const failedCount = entries.length - passedCount;
  const shown = onlyFailed ? entries.filter((entry) => !entry.passed) : entries;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 backdrop-blur-sm sm:items-center"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={stageLabel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="my-auto flex max-h-[88vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-gray-200 px-6 py-4">
          <div>
            <h2 className="text-base font-semibold text-gray-900">{stageLabel}</h2>
            <p className="mt-0.5 text-xs text-gray-500">
              {rows === null
                ? 'Загружаю строки прогона…'
                : `Прошли дальше: ${passedCount} · не прошли: ${failedCount}`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {failedCount > 0 ? (
              <button
                type="button"
                onClick={() => setOnlyFailed((v) => !v)}
                className={`rounded-lg border px-2.5 py-1.5 text-xs transition ${
                  onlyFailed
                    ? 'border-rose-300 text-rose-600'
                    : 'border-gray-300 text-gray-600 hover:bg-gray-100'
                }`}
              >
                Только отсеянные
              </button>
            ) : null}
            <button
              type="button"
              onClick={onClose}
              aria-label="Закрыть"
              className="rounded-lg p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-700"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {rows === null ? (
            <div className="flex items-center gap-2 px-6 py-10 text-sm text-gray-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              Загружаю…
            </div>
          ) : error ? (
            <p className="px-6 py-10 text-center text-sm text-rose-600">{error}</p>
          ) : shown.length === 0 ? (
            <p className="px-6 py-10 text-center text-sm text-gray-500">
              До этого этапа ещё ничего не дошло.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-gray-50 text-left text-xs uppercase text-gray-500">
                <tr className="border-b border-gray-200">
                  <th className="px-6 py-2 font-medium">Компания</th>
                  <th className="px-3 py-2 font-medium">Что нашли</th>
                  <th className="px-6 py-2 font-medium">Итог</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {shown.map((entry) => (
                  <tr key={entry.row.id}>
                    <td className="px-6 py-2.5">
                      <div className="font-medium text-gray-900">{entry.row.company_name}</div>
                      {entry.row.job_source_url ? (
                        <a
                          href={entry.row.job_source_url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[11px] text-indigo-600 hover:underline"
                        >
                          вакансия
                        </a>
                      ) : null}
                    </td>
                    <td className="min-w-0 px-3 py-2.5 text-gray-700">
                      <span className="break-words">{entry.detail}</span>
                      {/* Цитата-доказательство нужна именно на этапе гео: без
                          неё «гео подтверждено» — просто слово. */}
                      {stageIndex === 3 && entry.row.target_sales_geo_evidence ? (
                        <p className="mt-1 text-[11px] italic leading-relaxed text-gray-500">
                          «{entry.row.target_sales_geo_evidence}»
                        </p>
                      ) : null}
                    </td>
                    <td className="px-6 py-2.5">
                      {entry.passed ? (
                        <span className="rounded-md bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700">прошла</span>
                      ) : (
                        <span className="rounded-md bg-rose-50 px-2 py-0.5 text-xs text-rose-700">
                          {entry.reason ?? 'не прошла'}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
