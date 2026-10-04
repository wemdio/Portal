'use client';

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { Loader2, MessageSquare, RefreshCw, Search, Settings2 } from 'lucide-react';
import { ColumnResizer, useColumnWidths } from '@/components/ResizableColumns';
import { fetchCampaigns, fetchThreads, type CampaignDto, type ThreadDto } from './api';
import { CampaignReplyKbModal } from './CampaignReplyKbModal';
import { CAMPAIGN_STATUS_LABELS } from './labels';
import { SenderReplyPanel } from './SenderReplyPanel';
import { UnlinkedReplies } from './UnlinkedReplies';

const COLUMN_DEFAULTS = { campaigns: 250, threads: 380 };
const COLUMN_LIMITS = { campaigns: [180, 520], threads: [280, 760] } as const;

/** Пауза перед запросом: человек печатает адрес, а не отправляет запрос на каждую букву. */
const SEARCH_DEBOUNCE_MS = 250;

function formatAt(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay
    ? date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

/**
 * Вкладка «Письма» — как «Персонализированные ответы», но по своим кампаниям
 * «Рассылки» (Instantly здесь нет): слева кампании и их ящики, в середине
 * переписки, справа открытая переписка с ответом, который пишет ИИ на русском
 * или английском по брифу кампании.
 *
 * Сортировку и счётчики считает представление sender_threads, а не браузер:
 * переписок столько же, сколько получателей, и тянуть их все ради порядка
 * нельзя.
 */
export function ThreadsTab({ initialThreadId = null }: { initialThreadId?: string | null } = {}) {
  const [campaigns, setCampaigns] = useState<CampaignDto[]>([]);
  const [campaignId, setCampaignId] = useState('');
  const [mailboxId, setMailboxId] = useState('');
  // Сюда приходят отвечать — по умолчанию только переписки, где адресат ответил.
  // Переписка из ссылки может быть и без ответа, тогда фильтр не мешает её открыть.
  const [onlyReplied, setOnlyReplied] = useState(true);
  const [onlyLeads, setOnlyLeads] = useState(false);

  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');

  const [threads, setThreads] = useState<ThreadDto[]>([]);
  const [total, setTotal] = useState(0);
  const [pageSize, setPageSize] = useState(30);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(initialThreadId);
  const [kbCampaignId, setKbCampaignId] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [search]);

  const load = useCallback(async () => {
    // Крутилка на каждую загрузку, а не только на первую: при смене страницы
    // список молча стоял прежним, и было непонятно, идёт ли загрузка.
    setLoading(true);
    try {
      const res = await fetchThreads({ page, search: query, onlyReplied, onlyLeads, campaignId, mailboxId });
      setThreads(res.threads);
      setTotal(res.total);
      setPageSize(res.pageSize);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить переписки');
    } finally {
      setLoading(false);
    }
  }, [page, query, onlyReplied, onlyLeads, campaignId, mailboxId]);

  useEffect(() => {
    // Загрузка списка при смене фильтра или страницы — запрос во внешнюю систему.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    fetchCampaigns()
      .then((res) => { if (!cancelled) setCampaigns(res.campaigns); })
      .catch(() => { /* колонка кампаний — только навигация: без неё работает «Все кампании» */ });
    return () => { cancelled = true; };
  }, []);

  const columns = useColumnWidths('sender-threads:column-widths', COLUMN_DEFAULTS, COLUMN_LIMITS);
  const maxPage = Math.max(1, Math.ceil(total / pageSize));
  const pickCampaign = (id: string) => {
    setCampaignId(id);
    setMailboxId('');
    setPage(1);
  };

  return (
    <div className="space-y-4">
      {/* Высота — почти весь экран: переписке и полю ответа было тесно. Ширину
          колонок кампаний и переписок тянут мышью (ResizableColumns). */}
      <div
        className="grid h-[calc(100vh-8rem)] min-h-[720px] grid-cols-1 overflow-hidden rounded-xl border border-zinc-200 bg-white lg:grid-cols-[var(--col-campaigns)_var(--col-threads)_minmax(0,1fr)]"
        style={{
          '--col-campaigns': `${columns.widths.campaigns}px`,
          '--col-threads': `${columns.widths.threads}px`,
        } as CSSProperties}
      >
        {/* ── Кампании ── */}
        <div className="relative flex min-h-0 flex-col border-b border-zinc-200 lg:border-b-0 lg:border-r">
          <ColumnResizer
            className="hidden lg:block"
            onMouseDown={(e) => columns.startDrag('campaigns', e)}
            onDoubleClick={() => columns.reset('campaigns')}
          />
          <div className="border-b border-zinc-200 px-4 py-2.5 text-xs uppercase tracking-wide text-zinc-500">Кампании</div>
          <div className="min-h-0 flex-1 overflow-y-auto py-1">
            <button
              type="button"
              onClick={() => pickCampaign('')}
              className={`block w-full px-4 py-2 text-left text-sm transition-colors ${
                campaignId === '' ? 'bg-blue-50 font-medium text-blue-700' : 'text-zinc-600 hover:bg-zinc-100'
              }`}
            >
              Все кампании
            </button>
            {campaigns.map((campaign) => (
              <div key={campaign.id}>
                <div
                  className={`group flex items-start gap-1 px-4 py-2 text-sm transition-colors ${
                    campaignId === campaign.id ? 'bg-blue-50 text-blue-700' : 'text-zinc-700 hover:bg-zinc-100'
                  }`}
                >
                  {/* Статус всегда справа, у шестерёнки: длинное название
                      переносится само, а статус не уезжает под него. */}
                  <button
                    type="button"
                    onClick={() => pickCampaign(campaign.id)}
                    className="flex min-w-0 flex-1 items-start gap-1.5 text-left"
                  >
                    <span className={`min-w-0 flex-1 break-words ${campaignId === campaign.id ? 'font-medium' : ''}`}>
                      {campaign.name}
                    </span>
                    <span
                      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${CAMPAIGN_STATUS_LABELS[campaign.status].className}`}
                    >
                      {CAMPAIGN_STATUS_LABELS[campaign.status].text}
                    </span>
                  </button>
                  {/* Бриф, тон и пример кампании для ИИ-ответов — как у проекта в «Персонализированных ответах». */}
                  <button
                    type="button"
                    onClick={() => setKbCampaignId(campaign.id)}
                    title="База знаний для ответов: бриф, тон, пример"
                    className="shrink-0 rounded p-0.5 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700"
                  >
                    <Settings2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                {/* Ящики — только у выбранной кампании: иначе колонка превращается
                    в список из сотен адресов всех кампаний разом. */}
                {campaignId === campaign.id && campaign.mailboxes?.length ? (
                  <div className="pb-1">
                    <button
                      type="button"
                      onClick={() => { setMailboxId(''); setPage(1); }}
                      className={`block w-full py-1.5 pl-8 pr-4 text-left text-xs transition-colors ${
                        mailboxId === '' ? 'text-blue-700' : 'text-zinc-500 hover:bg-zinc-100'
                      }`}
                    >
                      Все ящики
                    </button>
                    {campaign.mailboxes.map((mailbox) => (
                      <button
                        key={mailbox.id}
                        type="button"
                        onClick={() => { setMailboxId(mailbox.id); setPage(1); }}
                        className={`block w-full truncate py-1.5 pl-8 pr-4 text-left text-xs transition-colors ${
                          mailboxId === mailbox.id ? 'font-medium text-blue-700' : 'text-zinc-500 hover:bg-zinc-100'
                        }`}
                      >
                        {mailbox.email}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
            {campaigns.length === 0 ? <p className="px-4 py-3 text-xs text-zinc-500">Кампаний пока нет.</p> : null}
          </div>
        </div>

        {/* ── Переписки ── */}
        <div className="relative flex min-h-0 flex-col border-b border-zinc-200 lg:border-b-0 lg:border-r">
          <ColumnResizer
            className="hidden lg:block"
            onMouseDown={(e) => columns.startDrag('threads', e)}
            onDoubleClick={() => columns.reset('threads')}
          />
          <div className="space-y-2 border-b border-zinc-200 px-3 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-2 text-sm font-semibold text-zinc-900">
                Переписок — {total} шт.
                {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-400" /> : null}
              </span>
              <button
                type="button"
                onClick={() => void load()}
                title="Обновить"
                className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
              <input
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                placeholder="Поиск по адресу"
                className="w-full rounded-lg border border-zinc-300 bg-white py-1.5 pl-8 pr-3 text-sm text-zinc-900"
              />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {[
                { on: onlyReplied, set: setOnlyReplied, label: 'С ответами' },
                { on: onlyLeads, set: setOnlyLeads, label: 'Только лиды' },
              ].map((f) => (
                <button
                  key={f.label}
                  type="button"
                  onClick={() => { f.set(!f.on); setPage(1); }}
                  className={`rounded-full border px-2.5 py-0.5 text-xs transition ${
                    f.on ? 'border-blue-300 bg-blue-50 text-blue-700' : 'border-zinc-200 text-zinc-600 hover:bg-zinc-100'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {error ? <p className="px-3 py-2 text-xs text-red-600">{error}</p> : null}

          <div className="min-h-0 flex-1 overflow-y-auto">
            {loading && threads.length === 0 ? (
              <div className="flex items-center justify-center gap-2 px-3 py-10 text-sm text-zinc-500">
                <Loader2 className="h-4 w-4 animate-spin" />
                Загрузка…
              </div>
            ) : threads.length === 0 ? (
              <p className="px-4 py-12 text-center text-sm text-zinc-500">
                {query || onlyReplied || onlyLeads
                  ? 'Ничего не нашлось — попробуйте снять фильтр.'
                  : 'Переписок пока нет: они появляются здесь, как только уходит первое письмо.'}
              </p>
            ) : (
              // Пока грузится следующая страница, прежняя видна приглушённой:
              // список не прыгает, а по виду ясно, что он сейчас сменится.
              <div className={`divide-y divide-zinc-100 transition-opacity ${loading ? 'pointer-events-none opacity-50' : ''}`}>
                {threads.map((thread) => (
                  <button
                    key={thread.recipient_id}
                    type="button"
                    onClick={() => setSelected(thread.recipient_id)}
                    className={`block w-full px-3 py-2.5 text-left transition-colors ${
                      selected === thread.recipient_id ? 'bg-blue-50' : 'hover:bg-zinc-50'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-900">
                        {thread.recipient_name || thread.recipient_email}
                      </span>
                      <span className="shrink-0 text-[11px] text-zinc-400">{formatAt(thread.last_activity_at)}</span>
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1">
                      {thread.has_human_reply ? (
                        <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">Ответил</span>
                      ) : thread.reply_count > 0 ? (
                        <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-600">Входящее</span>
                      ) : null}
                      {thread.lead_verdict === 'lead' ? (
                        <span className="rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-700">
                          Лид{thread.lead_verdict_source === 'manual' ? ' (вручную)' : ''}
                        </span>
                      ) : thread.lead_verdict === 'not_lead' ? (
                        <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-500">
                          Не лид{thread.lead_verdict_source === 'manual' ? ' (вручную)' : ''}
                        </span>
                      ) : null}
                      <span className="inline-flex items-center gap-0.5 text-[11px] text-zinc-400">
                        <MessageSquare className="h-3 w-3" />
                        {thread.sent_count + thread.reply_count}
                      </span>
                    </div>
                    <div className="mt-0.5 truncate text-[11px] text-zinc-500">
                      {thread.recipient_name ? `${thread.recipient_email} · ` : ''}
                      {thread.mailbox_email ? `с ${thread.mailbox_email}` : 'ящик не закреплён'}
                    </div>
                    {campaignId ? null : <div className="truncate text-[11px] text-zinc-400">{thread.campaign_name}</div>}
                  </button>
                ))}
              </div>
            )}
          </div>

          {total > pageSize ? (
            <div className="flex items-center justify-center gap-3 border-t border-zinc-200 px-3 py-2 text-xs">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1 || loading}
                className="rounded-md px-2 py-1 text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-40"
              >
                ← Назад
              </button>
              <span className="inline-flex items-center gap-1.5 text-zinc-500">
                {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                {page} из {maxPage}
              </span>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(maxPage, p + 1))}
                disabled={page >= maxPage || loading}
                className="rounded-md px-2 py-1 text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-40"
              >
                Вперёд →
              </button>
            </div>
          ) : null}
        </div>

        {/* ── Переписка и ответ ── */}
        <div className="min-h-0">
          {selected ? (
            <SenderReplyPanel key={selected} recipientId={selected} onSent={() => void load()} onVerdictChange={() => void load()} />
          ) : (
            <div className="flex h-full items-center justify-center px-6 text-center text-sm text-zinc-500">
              Выберите переписку из списка
            </div>
          )}
        </div>
      </div>

      {/* Отдельным блоком: это не переписки, а письма, которые вообще не удалось к ним привязать. */}
      <UnlinkedReplies refreshKey={page} />

      {kbCampaignId ? <CampaignReplyKbModal campaignId={kbCampaignId} onClose={() => setKbCampaignId(null)} /> : null}
    </div>
  );
}
