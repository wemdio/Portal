'use client';

import { Fragment, useState } from 'react';
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import { REASON_LABELS, STAGES, STAGE_LABELS, type Stage } from '@/lib/polzaRuOutreach/types';
import { MODE_LABELS, SIGNAL_LABELS, STATUS_LABELS, fmtDate, type RuRow } from './shared';

const STATUS_TONE: Record<RuRow['row_status'], string> = {
  ready: 'bg-emerald-50 text-emerald-700',
  manual_review: 'bg-amber-50 text-amber-700',
  rejected: 'bg-gray-100 text-gray-600',
  failed: 'bg-red-50 text-red-700',
  processing: 'bg-blue-50 text-blue-700',
};

export function Funnel({
  funnel,
  reasons,
  onReason,
}: {
  funnel: Record<Stage, number> | null;
  reasons: Record<string, number> | null;
  onReason: (code: string) => void;
}) {
  if (!funnel) return null;
  const top = funnel.candidates_loaded || 0;
  const sortedReasons = Object.entries(reasons ?? {}).sort((a, b) => b[1] - a[1]);
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <div className="rounded-xl border border-gray-200 bg-white p-4">
        <div className="mb-3 text-sm font-semibold text-gray-900">Воронка</div>
        <div className="space-y-1.5">
          {STAGES.map((s) => {
            const n = funnel[s] ?? 0;
            const pct = top ? Math.round((n / top) * 100) : 0;
            return (
              <div key={s} className="flex items-center gap-3 text-sm">
                <div className="w-40 shrink-0 text-gray-600">{STAGE_LABELS[s]}</div>
                <div className="h-2 flex-1 rounded bg-gray-100">
                  <div className="h-2 rounded bg-violet-500" style={{ width: `${pct}%` }} />
                </div>
                <div className="w-20 shrink-0 text-right tabular-nums text-gray-900">
                  {n} <span className="text-xs text-gray-400">{pct}%</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="rounded-xl border border-gray-200 bg-white p-4">
        <div className="mb-3 text-sm font-semibold text-gray-900">Почему отсеялись</div>
        {sortedReasons.length === 0 ? (
          <div className="text-sm text-gray-500">Пока нет отсеянных строк.</div>
        ) : (
          <div className="space-y-1">
            {sortedReasons.map(([code, n]) => (
              <button
                key={code}
                type="button"
                onClick={() => onReason(code)}
                className="flex w-full items-center justify-between rounded-md px-2 py-1 text-left text-sm hover:bg-gray-50"
              >
                <span className="text-gray-700">{REASON_LABELS[code] ?? code}</span>
                <span className="tabular-nums text-gray-900">{n}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Letters({ row }: { row: RuRow }) {
  if (!row.letters?.length) return null;
  return (
    <div className="space-y-3">
      {row.letters.map((l) => (
        <div key={l.n} className="rounded-lg border border-gray-200 bg-white p-3">
          <div className="mb-1 text-xs font-medium text-gray-500">
            Письмо {l.n}
            {l.subject ? (
              <>
                {' '}— тема: <span className="text-gray-900">{l.subject}</span>
                {l.n === 1 && row.subject_b ? <> / вариант Б: <span className="text-gray-900">{row.subject_b}</span></> : null}
              </>
            ) : (
              ' — ответом в той же ветке'
            )}
          </div>
          <pre className="whitespace-pre-wrap font-sans text-sm text-gray-800">{l.body}</pre>
        </div>
      ))}
    </div>
  );
}

function Details({ row }: { row: RuRow }) {
  return (
    <div className="grid grid-cols-1 gap-4 bg-gray-50 p-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <div className="space-y-3 text-sm">
        {row.reason_code && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-900">
            <b>{REASON_LABELS[row.reason_code] ?? row.reason_code}</b>
            {row.reason_detail ? <div className="mt-1 text-xs">{row.reason_detail}</div> : null}
          </div>
        )}
        {row.evidence_quote && (
          <div>
            <div className="text-xs text-gray-500">Доказательство ({row.evidence_level})</div>
            <div className="text-gray-900">«{row.evidence_quote}»</div>
          </div>
        )}
        {row.market_evidence_quote && (
          <div>
            <div className="text-xs text-gray-500">Рынок / клиенты{row.target_market ? `: ${row.target_market}` : ''}</div>
            <div className="text-gray-900">«{row.market_evidence_quote}»</div>
          </div>
        )}
        {row.signals?.length > 0 && (
          <div>
            <div className="text-xs text-gray-500">Все найденные сигналы</div>
            <ul className="mt-1 space-y-1">
              {row.signals.map((s, i) => (
                <li key={i} className="text-gray-800">
                  {SIGNAL_LABELS[s.type] ?? s.type}: {s.quote ? `«${s.quote}»` : s.title}
                  {s.date ? ` · ${fmtDate(s.date)}` : ''}
                  {s.url ? (
                    <a href={s.url} target="_blank" rel="noreferrer" className="ml-1 inline-flex text-violet-600">
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        )}
        {row.fit_reasons?.length > 0 && (
          <div>
            <div className="text-xs text-gray-500">Почему подходит</div>
            <ul className="mt-1 list-disc pl-5 text-gray-800">
              {row.fit_reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </div>
        )}
        <div className="text-xs text-gray-500">
          Почта: {row.recipient_email ?? '—'} {row.recipient_role ? `(${row.recipient_role})` : ''}
          {row.is_routing ? ' · письмо 1 в варианте «кому переслать»' : ''}
          {row.case_id ? ` · кейс ${row.case_id}` : ' · без кейса'}
        </div>
        {row.qa_flags?.length > 0 && <div className="text-xs text-red-700">QA: {row.qa_flags.join(', ')}</div>}
      </div>
      <Letters row={row} />
    </div>
  );
}

export function ResultsTable({ rows }: { rows: RuRow[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!rows.length) return <div className="rounded-xl border border-gray-200 bg-white p-6 text-sm text-gray-500">Строк нет.</div>;
  return (
    <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
      <table className="min-w-full text-sm">
        <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
          <tr>
            <th className="w-8 px-3 py-2" />
            <th className="px-3 py-2">Компания</th>
            <th className="px-3 py-2">Сигнал</th>
            <th className="px-3 py-2">Режим</th>
            <th className="px-3 py-2">Почта</th>
            <th className="px-3 py-2">Статус</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((row) => {
            const isOpen = open === row.id;
            return (
              <Fragment key={row.id}>
                <tr className="cursor-pointer hover:bg-gray-50" onClick={() => setOpen(isOpen ? null : row.id)}>
                  <td className="px-3 py-2 text-gray-400">{isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</td>
                  <td className="px-3 py-2">
                    <div className="font-medium text-gray-900">{row.company_brand ?? row.company_name}</div>
                    <div className="text-xs text-gray-500">
                      {row.normalized_domain ?? '—'}
                      {row.prior_contact ? ' · уже общались' : ''}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="text-gray-900">{row.signal_type ? SIGNAL_LABELS[row.signal_type] ?? row.signal_type : '—'}</div>
                    <div className="max-w-xs truncate text-xs text-gray-500">
                      {row.signal_title ?? ''}
                      {row.signal_score != null ? ` · скоринг ${row.signal_score}` : ''}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-600">{row.generation_mode ? MODE_LABELS[row.generation_mode] ?? row.generation_mode : '—'}</td>
                  <td className="px-3 py-2 text-xs text-gray-700">{row.recipient_email ?? '—'}</td>
                  <td className="px-3 py-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_TONE[row.row_status]}`}>
                      {STATUS_LABELS[row.row_status]}
                    </span>
                    {row.reason_code && row.row_status !== 'ready' ? (
                      <div className="mt-1 max-w-[16rem] text-xs text-gray-500">{REASON_LABELS[row.reason_code] ?? row.reason_code}</div>
                    ) : null}
                  </td>
                </tr>
                {isOpen && (
                  <tr>
                    <td colSpan={6} className="p-0">
                      <Details row={row} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
