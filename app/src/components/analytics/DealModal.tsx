'use client';

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { authFetch } from '@/lib/authFetch';
import { logError } from '@/lib/loggerClient';

/**
 * Модалка одной сделки AMO: карточка, путь по воронке, комментарии и задачи.
 *
 * Нужна, чтобы ответить на «почему сделка застряла здесь», не уходя в AMO и не
 * теряя выбранный период. Ссылка в AMO при этом на месте — модалка её заменяет
 * не всегда, а в типичном случае.
 *
 * Общая для дашбордов первички и продлений, поэтому лежит в `analytics/`, а не
 * в папке одного из них. Различаются они только ручкой: у каждого дашборда
 * своя проверка доступа, и подставлять чужую нельзя — отсюда параметр
 * `endpoint`, а не зашитый путь.
 */

type Stages = {
  created_at: string | null;
  first_qualified_at: string | null;
  first_meeting_at: string | null;
  first_contract_at: string | null;
  won_at: string | null;
  history_complete: boolean;
};

type DealDetails = {
  amo_id: number;
  name: string | null;
  company_name: string | null;
  company_website: string | null;
  responsible_name: string | null;
  status_name: string | null;
  pipeline_name: string | null;
  amount: number | null;
  contact: { email: string | null; phone: string | null; telegram: string | null };
  stages: Stages | null;
  fields: Array<{ name: string; value: string }>;
  notes: Array<{ amo_note_id: number; text: string | null; created_at_amo: string | null; created_by: number | null }>;
  tasks: Array<{
    amo_task_id: number;
    text: string | null;
    result_text: string | null;
    is_completed: boolean | null;
    complete_till: string | null;
    created_at_amo: string | null;
  }>;
  amo_url: string | null;
};

const fmtDateTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : '—';
const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('ru-RU') : '—');
const fmtMoney = (n: number) => `${Math.round(n).toLocaleString('ru-RU')} ₽`;

/** Путь сделки по воронке — в порядке этапов, а не по дате: прочерк на месте
 *  непройденного этапа сам по себе информация. */
function stagePath(stages: Stages): Array<{ label: string; value: string }> {
  return [
    { label: 'Создана', value: fmtDate(stages.created_at) },
    { label: 'Квал', value: fmtDate(stages.first_qualified_at) },
    { label: 'Встреча', value: fmtDate(stages.first_meeting_at) },
    { label: 'Договор', value: fmtDate(stages.first_contract_at) },
    { label: 'Оплата', value: fmtDate(stages.won_at) },
  ];
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-zinc-100 px-4 py-3 first:border-t-0">
      <h4 className="mb-2 text-[10px] font-medium uppercase tracking-wider text-zinc-400">{title}</h4>
      {children}
    </section>
  );
}

export default function DealModal({
  amoId,
  endpoint,
  onClose,
}: {
  amoId: number;
  /** Базовый путь ручки сделки без id, например `/api/analytics/renewals/deal`. */
  endpoint: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<DealDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Esc закрывает — обычное ожидание от модалки, и без него единственный выход
  // мышью в правый верхний угол.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    const run = async () => {
      setLoading(true);
      try {
        const res = await authFetch(`${endpoint}/${amoId}`, { signal: controller.signal });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error || `HTTP ${res.status}`);
        }
        const json = (await res.json()) as DealDetails;
        if (!active) return;
        setError(null);
        setData(json);
      } catch (e) {
        if (!active) return;
        if (e instanceof DOMException && e.name === 'AbortError') return;
        logError('analytics.deal.fetch_failed', e, { amoId, endpoint });
        setError(e instanceof Error ? e.message : 'Не удалось загрузить сделку');
      } finally {
        if (active) setLoading(false);
      }
    };

    void run();
    return () => {
      active = false;
      controller.abort();
    };
  }, [amoId, endpoint]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      // Клик по подложке закрывает, клик внутри окна — нет: проверяем, что
      // событие пришло именно от подложки, а не всплыло из содержимого.
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Карточка сделки"
        className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-zinc-200 bg-white shadow-xl"
      >
        <div className="sticky top-0 flex items-start gap-3 border-b border-zinc-100 bg-white px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-zinc-900">
              {data?.company_name || data?.name || `Сделка #${amoId}`}
            </p>
            {data?.company_name && data.name ? (
              <p className="truncate text-xs text-zinc-500">{data.name}</p>
            ) : null}
          </div>
          {data?.amo_url ? (
            <a
              href={data.amo_url}
              target="_blank"
              rel="noreferrer"
              className="shrink-0 rounded-lg border border-zinc-200 px-2.5 py-1 text-xs text-blue-600 hover:bg-zinc-50"
            >
              Открыть в AMO
            </a>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть"
            className="shrink-0 rounded-lg p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {loading ? (
          <div className="px-4 py-10 text-center text-sm text-zinc-400">Загрузка сделки…</div>
        ) : error ? (
          <div className="px-4 py-10 text-center text-sm text-red-600">Ошибка загрузки: {error}</div>
        ) : data ? (
          <>
            <Section title="Сделка">
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                <div><dt className="text-zinc-400">Ответственный</dt><dd className="text-zinc-700">{data.responsible_name || 'не закреплён'}</dd></div>
                <div><dt className="text-zinc-400">Этап AMO</dt><dd className="text-zinc-700">{data.status_name || '—'}</dd></div>
                <div><dt className="text-zinc-400">Воронка</dt><dd className="text-zinc-700">{data.pipeline_name || '—'}</dd></div>
                <div><dt className="text-zinc-400">Сумма</dt><dd className="text-zinc-700">{data.amount != null ? fmtMoney(data.amount) : '—'}</dd></div>
                {data.company_website ? (
                  <div className="col-span-2"><dt className="text-zinc-400">Сайт</dt><dd className="truncate text-zinc-700">{data.company_website}</dd></div>
                ) : null}
                {data.contact.telegram || data.contact.email || data.contact.phone ? (
                  <div className="col-span-2">
                    <dt className="text-zinc-400">Контакт</dt>
                    <dd className="text-zinc-700">
                      {[
                        data.contact.telegram ? `@${data.contact.telegram}` : null,
                        data.contact.email,
                        data.contact.phone,
                      ].filter(Boolean).join(' · ')}
                    </dd>
                  </div>
                ) : null}
              </dl>
            </Section>

            {data.stages ? (
              <Section title="Путь по воронке">
                <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-xs">
                  {stagePath(data.stages).map((step) => (
                    <div key={step.label}>
                      <span className="text-zinc-400">{step.label}: </span>
                      <span className="tabular-nums text-zinc-700">{step.value}</span>
                    </div>
                  ))}
                </div>
                {!data.stages.history_complete && (
                  <p className="mt-2 text-[11px] text-amber-700">
                    Сделка создана раньше глубины синка событий AMO: прочерк у этапа здесь значит «не видим», а не
                    «этапа не было».
                  </p>
                )}
              </Section>
            ) : null}

            {data.fields.length > 0 ? (
              <Section title="Поля карточки">
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                  {data.fields.map((field) => (
                    <div key={field.name}>
                      <dt className="text-zinc-400">{field.name}</dt>
                      <dd className="break-words text-zinc-700">{field.value}</dd>
                    </div>
                  ))}
                </dl>
              </Section>
            ) : null}

            <Section title={`Комментарии${data.notes.length > 0 ? ` (${data.notes.length})` : ''}`}>
              {data.notes.length === 0 ? (
                <p className="text-xs text-zinc-400">Комментариев нет.</p>
              ) : (
                <ul className="space-y-2">
                  {data.notes.map((note) => (
                    <li key={note.amo_note_id} className="rounded-lg bg-[var(--glass-rows)] px-2.5 py-2">
                      <p className="whitespace-pre-wrap break-words text-xs text-zinc-700">{note.text || '—'}</p>
                      <p className="mt-1 text-[10px] text-zinc-400">{fmtDateTime(note.created_at_amo)}</p>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section title={`Задачи${data.tasks.length > 0 ? ` (${data.tasks.length})` : ''}`}>
              {data.tasks.length === 0 ? (
                <p className="text-xs text-zinc-400">Задач нет.</p>
              ) : (
                <ul className="space-y-2">
                  {data.tasks.map((task) => (
                    <li key={task.amo_task_id} className="rounded-lg bg-[var(--glass-rows)] px-2.5 py-2">
                      <div className="flex items-start gap-2">
                        <span
                          className={`mt-0.5 shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${
                            task.is_completed
                              ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                              : 'border-amber-200 bg-amber-50 text-amber-700'
                          }`}
                        >
                          {task.is_completed ? 'выполнена' : 'открыта'}
                        </span>
                        <p className="whitespace-pre-wrap break-words text-xs text-zinc-700">{task.text || '—'}</p>
                      </div>
                      {/* Результат задачи — обычно единственное место, где
                          написано, чем этап кончился. */}
                      {task.result_text ? (
                        <p className="mt-1 whitespace-pre-wrap break-words text-xs text-zinc-600">
                          Результат: {task.result_text}
                        </p>
                      ) : null}
                      <p className="mt-1 text-[10px] text-zinc-400">срок: {fmtDate(task.complete_till)}</p>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </>
        ) : null}
      </div>
    </div>
  );
}
