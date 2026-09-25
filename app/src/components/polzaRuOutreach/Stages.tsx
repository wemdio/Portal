'use client';

import { useEffect, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { OutreachStages } from '@/components/parsers/OutreachStages';
import { CHAIN_LABELS, REASON_LABELS, STAGES, type ChainType, type Stage } from '@/lib/polzaRuOutreach/types';
import { API, api, STATUS_LABELS, type RuRow } from './shared';

/**
 * Шаги «Нашего автоаутрича» — как у английского: где работа сейчас, сколько
 * прошло и отсеялось, и по клику — кто именно и почему.
 */

export const RU_STAGE_VIEW: Array<{ keys: Stage[]; label: string; hint: string }> = [
  { keys: ['candidates_loaded'], label: 'Кандидаты', hint: 'Компании из выбранных источников: одна компания — одна карточка со всеми поводами' },
  { keys: ['amo_checked'], label: 'Проверка AMO', hint: 'Открытые сделки, клиенты и свежие отказы не пишем; вакансии hh проверены вживую' },
  { keys: ['company_resolved'], label: 'Компания и сайт', hint: 'Нашли официальный сайт компании' },
  { keys: ['deduplicated'], label: 'Без повторов', hint: 'Нет повторов в запуске и в прошлых выгрузках' },
  { keys: ['enriched'], label: 'Сайт и поводы', hint: 'Разбор сайта: B2B, исключения, события; новости и отчётность ФНС' },
  { keys: ['scored'], label: 'Оценка', hint: 'Похожесть, размер, выбор оффера и оценка 0–100 не ниже порога' },
  { keys: ['recipient_resolved'], label: 'Почта', hint: 'Корпоративная почта на сайте, не в стоп-листе' },
  { keys: ['sequence_assembled', 'qa_checked'], label: 'Письма и проверка', hint: 'Цепочка собрана и прошла автоматическую проверку' },
  { keys: ['ready'], label: 'Готово', hint: 'Идут в Excel для Instantly; очень спорные — в отдельной вкладке' },
];

const MODAL_PAGE = 500;
const MODAL_MAX_ROWS = 5000;

function passedDetail(row: RuRow): string {
  return [
    row.normalized_domain,
    row.chain_type ? CHAIN_LABELS[row.chain_type as ChainType] : null,
    row.priority_score != null ? `оценка ${row.priority_score}` : null,
    row.recipient_email,
  ].filter(Boolean).join(' · ');
}

function StageModal({ jobId, viewIndex, onClose }: { jobId: string; viewIndex: number; onClose: () => void }) {
  const view = RU_STAGE_VIEW[viewIndex];
  const [rows, setRows] = useState<RuRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const all: RuRow[] = [];
      for (let offset = 0; offset < MODAL_MAX_ROWS; offset += MODAL_PAGE) {
        const page = await api<{ items: RuRow[]; count: number }>(`${API}/${jobId}/results?limit=${MODAL_PAGE}&offset=${offset}`);
        all.push(...page.items);
        if (all.length >= page.count || page.items.length < MODAL_PAGE) break;
      }
      if (!cancelled) setRows(all);
    }
    // Загрузка разбора этапа по клику — запрос во внешнюю систему.
    load().catch((e) => !cancelled && setError(e instanceof Error ? e.message : 'Ошибка загрузки'));
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  const lastIdx = Math.max(...view.keys.map((k) => STAGES.indexOf(k)));
  const dropped = (rows ?? []).filter((r) => view.keys.includes(r.pipeline_stage as Stage) && r.row_status !== 'ready' && r.row_status !== 'processing');
  const passed = (rows ?? []).filter((r) => r.row_status === 'ready' || STAGES.indexOf(r.pipeline_stage as Stage) > lastIdx);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={onClose}>
      <div className="max-h-[85vh] w-full max-w-3xl overflow-y-auto rounded-2xl bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4">
          <h3 className="text-lg font-semibold text-gray-900">{view.label}</h3>
          <button type="button" onClick={onClose} className="rounded p-1 text-gray-400 hover:text-gray-700" aria-label="Закрыть">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="space-y-5 px-6 py-4 text-sm">
          {error && <div className="text-red-600">{error}</div>}
          {!rows && !error && <Loader2 className="h-5 w-5 animate-spin text-gray-400" />}
          {rows && (
            <>
              <section>
                <div className="mb-2 font-medium text-gray-900">Не прошли здесь · {dropped.length}</div>
                {dropped.length === 0 ? (
                  <div className="text-gray-500">Никто.</div>
                ) : (
                  <ul className="divide-y divide-gray-100">
                    {dropped.slice(0, 300).map((r) => (
                      <li key={r.id} className="py-1.5">
                        <span className="text-gray-900">{r.company_brand ?? r.company_name}</span>
                        <span className="ml-2 text-gray-500">
                          {r.row_status === 'doubtful'
                            ? `очень спорная: ${r.doubt_detail ?? ''}`
                            : `${r.reason_code ? REASON_LABELS[r.reason_code] ?? r.reason_code : STATUS_LABELS[r.row_status]}${r.reason_detail ? ` — ${r.reason_detail}` : ''}`}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <section>
                <div className="mb-2 font-medium text-gray-900">Прошли дальше · {passed.length}</div>
                <ul className="divide-y divide-gray-100">
                  {passed.slice(0, 300).map((r) => (
                    <li key={r.id} className="py-1.5">
                      <span className="text-gray-900">{r.company_brand ?? r.company_name}</span>
                      <span className="ml-2 text-gray-500">{passedDetail(r)}</span>
                    </li>
                  ))}
                </ul>
                {passed.length > 300 && <div className="mt-1 text-xs text-gray-500">Показаны первые 300 — полный список в Excel-журнале.</div>}
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function RuStages({
  jobId,
  funnel,
  run,
  error,
}: {
  jobId: string | null;
  funnel: Record<Stage, number> | null;
  run: { running: boolean; failed: boolean } | null;
  error?: string | null;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const stages = RU_STAGE_VIEW.map((v) => ({ label: v.label, hint: v.hint, count: funnel ? funnel[v.keys[v.keys.length - 1]] ?? 0 : 0 }));
  return (
    <>
      <OutreachStages stages={stages} run={run} error={error} onOpenStage={jobId ? setOpen : undefined} />
      {open !== null && jobId && <StageModal jobId={jobId} viewIndex={open} onClose={() => setOpen(null)} />}
    </>
  );
}
