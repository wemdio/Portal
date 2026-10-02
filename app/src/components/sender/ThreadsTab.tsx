'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, MessageSquare, Search } from 'lucide-react';
import { fetchCampaigns, fetchThreads, type CampaignDto, type ThreadDto } from './api';
import { CAMPAIGN_STATUS_LABELS } from './labels';
import { ThreadModal } from './ThreadModal';
import { UnlinkedReplies } from './UnlinkedReplies';

type Mode = 'list' | 'campaigns';

const MODES: { id: Mode; label: string }[] = [
  { id: 'campaigns', label: 'По кампаниям' },
  { id: 'list', label: 'Списком' },
];

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
 * Вкладка «Письма»: переписки, которые начались после отправки.
 *
 * Два режима одного и того же списка. «Списком» — всё подряд, сверху свежее
 * событие в любую сторону: так видно, кто ответил прямо сейчас, независимо от
 * кампании. «По кампаниям» — сначала кампания, потом её ящик: так смотрят, что
 * уходило с конкретного адреса.
 *
 * Сортировку и счётчики считает представление sender_threads, а не браузер:
 * переписок столько же, сколько получателей, и тянуть их все ради порядка
 * нельзя.
 */
export function ThreadsTab({ initialThreadId = null }: { initialThreadId?: string | null } = {}) {
  // По умолчанию разбивка по кампаниям: сюда заходят смотреть конкретную
  // рассылку, а сплошной список — второй взгляд на те же переписки.
  const [mode, setMode] = useState<Mode>('campaigns');
  const [campaigns, setCampaigns] = useState<CampaignDto[]>([]);
  const [campaignId, setCampaignId] = useState('');
  const [mailboxId, setMailboxId] = useState('');
  const [onlyReplied, setOnlyReplied] = useState(false);
  const [onlyLeads, setOnlyLeads] = useState(false);

  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');

  const [threads, setThreads] = useState<ThreadDto[]>([]);
  const [total, setTotal] = useState(0);
  const [pageSize, setPageSize] = useState(30);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Переписка из ссылки открывается сразу, не дожидаясь списка: её может не
  // быть на первой странице.
  const [openThread, setOpenThread] = useState<string | null>(initialThreadId);

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [search]);

  const load = useCallback(async () => {
    // Крутилка на каждую загрузку, а не только на первую: при смене страницы
    // список молча стоял прежним, и было непонятно, идёт ли загрузка.
    setLoading(true);
    try {
      const res = await fetchThreads({
        page,
        search: query,
        onlyReplied,
        onlyLeads,
        // Фильтры кампании и ящика живут только в своём режиме: переключение
        // на «Списком» не должно молча оставлять невидимый фильтр.
        campaignId: mode === 'campaigns' ? campaignId : '',
        mailboxId: mode === 'campaigns' ? mailboxId : '',
      });
      setThreads(res.threads);
      setTotal(res.total);
      setPageSize(res.pageSize);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить переписки');
    } finally {
      setLoading(false);
    }
  }, [page, query, onlyReplied, onlyLeads, mode, campaignId, mailboxId]);

  useEffect(() => {
    // Загрузка списка при смене фильтра или страницы — запрос во внешнюю систему.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  useEffect(() => {
    if (mode !== 'campaigns' || campaigns.length) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchCampaigns();
        if (!cancelled) setCampaigns(res.campaigns);
      } catch {
        /* список кампаний — только навигация: без него работает режим «Списком» */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, campaigns.length]);

  const maxPage = Math.max(1, Math.ceil(total / pageSize));
  const selectedCampaign = campaigns.find((c) => c.id === campaignId) ?? null;

  const switchMode = (next: Mode) => {
    setMode(next);
    setPage(1);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex gap-1 rounded-xl border border-zinc-200 bg-zinc-50 p-1">
          {MODES.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => switchMode(item.id)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                mode === item.id ? 'bg-blue-600 text-white' : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Поиск по адресу получателя"
            className="w-full rounded-xl border border-zinc-300 bg-white py-2 pl-9 pr-3 text-sm text-zinc-900"
          />
        </div>

        <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-zinc-600">
          <input
            type="checkbox"
            checked={onlyReplied}
            onChange={(e) => {
              setOnlyReplied(e.target.checked);
              setPage(1);
            }}
            className="h-4 w-4 cursor-pointer rounded border-zinc-300"
          />
          Только с ответами
        </label>

        <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-zinc-600">
          <input
            type="checkbox"
            checked={onlyLeads}
            onChange={(e) => {
              setOnlyLeads(e.target.checked);
              setPage(1);
            }}
            className="h-4 w-4 cursor-pointer rounded border-zinc-300"
          />
          Только лиды
        </label>
      </div>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      <div className={mode === 'campaigns' ? 'flex flex-col gap-4 lg:flex-row' : ''}>
        {mode === 'campaigns' ? (
          <div className="w-full shrink-0 rounded-xl border border-zinc-200 bg-white lg:w-64">
            <div className="border-b border-zinc-200 px-4 py-2.5 text-xs uppercase tracking-wide text-zinc-500">
              Кампании
            </div>
            <div className="max-h-96 overflow-y-auto py-1">
              <button
                type="button"
                onClick={() => {
                  setCampaignId('');
                  setMailboxId('');
                  setPage(1);
                }}
                className={`block w-full px-4 py-2 text-left text-sm transition-colors ${
                  campaignId === '' ? 'bg-blue-50 text-blue-700' : 'text-zinc-600 hover:bg-zinc-100'
                }`}
              >
                Все кампании
              </button>
              {campaigns.map((campaign) => (
                <div key={campaign.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setCampaignId(campaign.id);
                      setMailboxId('');
                      setPage(1);
                    }}
                    className={`block w-full px-4 py-2 text-left text-sm transition-colors ${
                      campaignId === campaign.id ? 'bg-blue-50 font-medium text-blue-700' : 'text-zinc-700 hover:bg-zinc-100'
                    }`}
                  >
                    <span className="flex items-start justify-between gap-2">
                      <span className="min-w-0">{campaign.name}</span>
                      <span
                        className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${CAMPAIGN_STATUS_LABELS[campaign.status].className}`}
                      >
                        {CAMPAIGN_STATUS_LABELS[campaign.status].text}
                      </span>
                    </span>
                  </button>
                  {/* Ящики показываем только у раскрытой кампании: иначе колонка
                      превращается в список из сотен адресов всех кампаний разом. */}
                  {campaignId === campaign.id ? (
                    <div className="pb-1">
                      <button
                        type="button"
                        onClick={() => {
                          setMailboxId('');
                          setPage(1);
                        }}
                        className={`block w-full py-1.5 pl-8 pr-4 text-left text-xs transition-colors ${
                          mailboxId === '' ? 'text-blue-700' : 'text-zinc-500 hover:bg-zinc-100'
                        }`}
                      >
                        Все ящики
                      </button>
                      {campaign.mailboxes?.map((mailbox) => (
                        <button
                          key={mailbox.id}
                          type="button"
                          onClick={() => {
                            setMailboxId(mailbox.id);
                            setPage(1);
                          }}
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
              {campaigns.length === 0 ? (
                <p className="px-4 py-3 text-xs text-zinc-500">Кампаний пока нет.</p>
              ) : null}
            </div>
          </div>
        ) : null}

        <div className="min-w-0 flex-1 rounded-xl border border-zinc-200 bg-white">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 px-5 py-3">
            <h2 className="inline-flex items-center gap-2 text-base font-semibold text-zinc-900">
              Переписки ({total})
              {loading ? <Loader2 className="h-4 w-4 animate-spin text-zinc-400" /> : null}
            </h2>
            {mode === 'campaigns' && selectedCampaign ? (
              <span className="text-xs text-zinc-500">
                {selectedCampaign.name}
                {mailboxId ? ` · ${selectedCampaign.mailboxes?.find((m) => m.id === mailboxId)?.email ?? ''}` : ''}
              </span>
            ) : null}
          </div>

          {loading && threads.length === 0 ? (
            <div className="flex items-center justify-center gap-2 px-5 py-10 text-sm text-zinc-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              Загрузка…
            </div>
          ) : threads.length === 0 ? (
            <p className="px-5 py-12 text-center text-sm text-zinc-500">
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
                  onClick={() => setOpenThread(thread.recipient_id)}
                  className="flex w-full flex-wrap items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-zinc-100"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-medium text-zinc-900">
                        {thread.recipient_name || thread.recipient_email}
                      </span>
                      {thread.has_human_reply ? (
                        <span className="rounded-md bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">
                          Ответил
                        </span>
                      ) : thread.reply_count > 0 ? (
                        <span className="rounded-md bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600">
                          Входящее
                        </span>
                      ) : null}
                      {/* Метка квалификатора ответов или человека: итог по переписке. */}
                      {thread.lead_verdict === 'lead' ? (
                        <span
                          className="rounded-md bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-700"
                          title={thread.lead_verdict_source === 'manual' ? 'Отмечено вручную' : 'Оценка ИИ'}
                        >
                          Лид{thread.lead_verdict_source === 'manual' ? ' (вручную)' : ''}
                        </span>
                      ) : thread.lead_verdict === 'not_lead' ? (
                        <span
                          className="rounded-md bg-zinc-100 px-2 py-0.5 text-xs text-zinc-500"
                          title={thread.lead_verdict_source === 'manual' ? 'Отмечено вручную' : 'Оценка ИИ'}
                        >
                          Не лид{thread.lead_verdict_source === 'manual' ? ' (вручную)' : ''}
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-0.5 truncate text-xs text-zinc-500">
                      {thread.recipient_name ? `${thread.recipient_email} · ` : ''}
                      {thread.mailbox_email ? `с ${thread.mailbox_email}` : 'ящик не закреплён'}
                      {' · '}
                      {thread.campaign_name}
                    </div>
                  </div>

                  <div className="flex items-center gap-3 text-xs text-zinc-500">
                    <span className="inline-flex items-center gap-1">
                      <MessageSquare className="h-3.5 w-3.5" />
                      {thread.sent_count + thread.reply_count}
                    </span>
                    <span className="w-24 text-right">{formatAt(thread.last_activity_at)}</span>
                  </div>
                </button>
              ))}
            </div>
          )}

          {total > pageSize ? (
            <div className="flex items-center justify-center gap-4 border-t border-zinc-200 px-5 py-3 text-sm">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1 || loading}
                className="rounded-md px-3 py-1.5 text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-40"
              >
                ← Назад
              </button>
              <span className="inline-flex items-center gap-1.5 text-zinc-500">
                {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                Стр. {page} из {maxPage}
              </span>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(maxPage, p + 1))}
                disabled={page >= maxPage || loading}
                className="rounded-md px-3 py-1.5 text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-40"
              >
                Вперёд →
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {/* Отдельным блоком под списком: это не переписки, а письма, которые
          вообще не удалось к ним привязать. */}
      <UnlinkedReplies refreshKey={page} />

      {openThread ? (
        <ThreadModal
          recipientId={openThread}
          onClose={() => setOpenThread(null)}
          onVerdictChange={() => void load()}
        />
      ) : null}
    </div>
  );
}
