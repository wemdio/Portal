'use client';

import { useEffect, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { OutreachStages } from '@/components/parsers/OutreachStages';
import { CHAIN_LABELS, REASON_LABELS, STAGES, type Stage } from '@/lib/polzaRuOutreach/types';
import { API, api, STATUS_LABELS, type RuRow } from './shared';

/**
 * Шаги «Нашего автоаутрича» — как у английского: где работа сейчас, сколько
 * прошло и отсеялось, и по клику — кто именно и почему.
 *
 * Большие запуски просматривают до 12 тыс. кандидатов — тянуть весь журнал
 * ради одного этапа неверно и не помещается в разумный кап. Поэтому
 * «не прошли здесь» запрашивается точечно, по каждому ключу этапа
 * (`?stage=…`) — сервер уже фильтрует по `pipeline_stage`, и список
 * получается полным, а не «первые 5000 строк job'а». «Прошли дальше»,
 * наоборот, не обязан быть полным — это витрина примеров, а счётчик берётся
 * из воронки, которая и так считает по всем строкам на сервере.
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
const MODAL_MAX_ROWS_PER_STAGE = 5000;

function passedDetail(row: RuRow): string {
  return [
    row.normalized_domain,
    row.chain_type ? CHAIN_LABELS[row.chain_type] : null,
    row.priority_score != null ? `оценка ${row.priority_score}` : null,
    row.recipient_email,
  ].filter(Boolean).join(' · ');
}

/** Все строки, отсеянные на данном этапе — постранично, по каждому ключу этапа отдельно. */
async function loadDropped(jobId: string, keys: Stage[], isCancelled: () => boolean): Promise<RuRow[]> {
  const dropped: RuRow[] = [];
  for (const key of keys) {
    for (let offset = 0; offset < MODAL_MAX_ROWS_PER_STAGE; offset += MODAL_PAGE) {
      if (isCancelled()) return dropped;
      const page = await api<{ items: RuRow[]; count: number }>(`${API}/${jobId}/results?stage=${key}&limit=${MODAL_PAGE}&offset=${offset}`);
      dropped.push(...page.items.filter((r) => r.row_status !== 'ready' && r.row_status !== 'processing'));
      if (offset + MODAL_PAGE >= page.count || page.items.length < MODAL_PAGE) break;
    }
  }
  return dropped;
}

function StageModal({ jobId, viewIndex, passedCount, onClose }: { jobId: string; viewIndex: number; passedCount: number; onClose: () => void }) {
  const view = RU_STAGE_VIEW[viewIndex];
  const [dropped, setDropped] = useState<RuRow[] | null>(null);
  const [passedExamples, setPassedExamples] = useState<RuRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const lastIdx = Math.max(...view.keys.map((k) => STAGES.indexOf(k)));
    async function load() {
      const [droppedRows, page] = await Promise.all([
        loadDropped(jobId, view.keys, () => cancelled),
        api<{ items: RuRow[] }>(`${API}/${jobId}/results?limit=${MODAL_PAGE}&offset=0`),
      ]);
      if (cancelled) return;
      setDropped(droppedRows);
      setPassedExamples(page.items.filter((r) => r.row_status === 'ready' || STAGES.indexOf(r.pipeline_stage as Stage) > lastIdx));
    }
    // Загрузка разбора этапа по клику — запрос во внешнюю систему.
    load().catch((e) => !cancelled && setError(e instanceof Error ? e.message : 'Ошибка загрузки'));
    return () => {
      cancelled = true;
    };
  }, [jobId, view.keys]);

  const examples = (passedExamples ?? []).slice(0, 300);
  const rows = dropped && passedExamples ? { dropped, examples } : null;

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
                <div className="mb-2 font-medium text-gray-900">Не прошли здесь · {rows.dropped.length}</div>
                {rows.dropped.length === 0 ? (
                  <div className="text-gray-500">Никто.</div>
                ) : (
                  <ul className="divide-y divide-gray-100">
                    {rows.dropped.slice(0, 300).map((r) => (
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
                {rows.dropped.length > 300 && <div className="mt-1 text-xs text-gray-500">Показаны первые 300 — полный список в Excel-журнале.</div>}
              </section>
              <section>
                <div className="mb-2 font-medium text-gray-900">Прошли дальше · {passedCount}</div>
                <ul className="divide-y divide-gray-100">
                  {rows.examples.map((r) => (
                    <li key={r.id} className="py-1.5">
                      <span className="text-gray-900">{r.company_brand ?? r.company_name}</span>
                      <span className="ml-2 text-gray-500">{passedDetail(r)}</span>
                    </li>
                  ))}
                </ul>
                {rows.examples.length < passedCount && <div className="mt-1 text-xs text-gray-500">Показаны примеры — полный список в Excel-журнале.</div>}
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
      {open !== null && jobId && (
        <StageModal jobId={jobId} viewIndex={open} passedCount={stages[open].count} onClose={() => setOpen(null)} />
      )}
    </>
  );
}
