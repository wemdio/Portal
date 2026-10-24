'use client';

import { Fragment, useCallback, useEffect, useState } from 'react';
import { Loader2, Search } from 'lucide-react';
import { fetchCampaignRecipients, type CampaignDto, type CampaignRecipientDto } from './api';
import { SenderModal } from './SenderModal';

const STATUS_FILTERS = [
  { id: '', label: 'Все' },
  { id: 'active', label: 'В работе' },
  { id: 'replied', label: 'Ответили' },
  { id: 'bounced', label: 'Отбои' },
  { id: 'unsubscribed', label: 'Отписались' },
  { id: 'finished', label: 'Пройдены' },
  { id: 'stopped', label: 'Стоп-лист' },
];

const SEARCH_DEBOUNCE_MS = 300;

/** Подписи колонок файла по ключам из базы; неизвестный ключ показываем как есть. */
const COLUMN_LABELS: Record<string, string> = {
  company: 'Компания',
  domain: 'Домен',
  сайт: 'Сайт',
  деятельность: 'Деятельность',
  дата_проверки: 'Дата проверки',
  назначение_адреса: 'Назначение адреса',
  происхождение: 'Происхождение',
  сегмент: 'Сегмент',
  сигнал_маркетплейсов: 'Сигнал маркетплейсов',
  источник_email: 'Источник email',
  источник_сигнала: 'Источник сигнала',
  китай_основание: 'Основание (Китай)',
  фрагмент_публикации: 'Фрагмент публикации',
  email_статус: 'Статус email',
  email_провайдер: 'Провайдер email',
  комментарий: 'Комментарий',
};

/**
 * База получателей кампании (задача 5.2 хендоффа фич).
 *
 * Раньше о базе говорили только сводные цифры в строке кампании; «кому
 * отправлено, кто ответил, кто отбился» посмотреть было негде. Здесь список с
 * поиском, фильтром по статусу и страницами — как у ящиков.
 */
export function RecipientsModal({ campaign, onClose }: { campaign: CampaignDto; onClose: () => void }) {
  const [recipients, setRecipients] = useState<CampaignRecipientDto[]>([]);
  const [columns, setColumns] = useState<string[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [pageSize, setPageSize] = useState(20);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [timer, setTimer] = useState<number | null>(null);

  const load = useCallback(
    async (targetPage: number) => {
      try {
        const res = await fetchCampaignRecipients(campaign.id, {
          page: targetPage,
          search: appliedSearch || undefined,
          status: status || undefined,
        });
        setRecipients(res.recipients);
        setColumns(res.columns);
        setTotal(res.total);
        setPageSize(res.pageSize);
        if (res.recipients.length === 0 && res.total > 0 && targetPage > 1) {
          setPage(Math.max(1, Math.ceil(res.total / res.pageSize)));
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Не удалось загрузить получателей');
      } finally {
        setLoading(false);
      }
    },
    [campaign.id, appliedSearch, status],
  );

  useEffect(() => {
    setLoading(true);
    void load(page).finally(() => setLoading(false));
  }, [load, page]);

  useEffect(() => () => {
    if (timer) window.clearTimeout(timer);
  }, [timer]);

  const onSearch = (value: string) => {
    setSearch(value);
    if (timer) window.clearTimeout(timer);
    setTimer(window.setTimeout(() => {
      setAppliedSearch(value.trim());
      setPage(1);
    }, SEARCH_DEBOUNCE_MS));
  };

  const maxPage = Math.max(1, Math.ceil(total / pageSize));

  return (
    <SenderModal
      title={`База: ${campaign.name}`}
      subtitle={`${campaign.stats?.recipients ?? total} получателей · кому ушло ${campaign.stats?.reached ?? '—'} · ответили ${campaign.stats?.replied ?? 0}`}
      size="wide"
      onClose={onClose}
      footer={
        <span className="mr-auto text-xs text-zinc-500">
          Стоп-лист не трогает уже начатые переписки: адрес лишь не получает новых писем.
        </span>
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
          <input
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Поиск по адресу"
            className="w-full rounded-lg border border-zinc-300 bg-white py-2 pl-9 pr-3 text-sm text-zinc-900"
          />
        </div>
        <div className="inline-flex flex-wrap gap-1">
          {STATUS_FILTERS.map((filter) => (
            <button
              key={filter.id || 'all'}
              type="button"
              onClick={() => {
                setStatus(filter.id);
                setPage(1);
              }}
              className={`rounded-lg px-2.5 py-1.5 text-xs transition-colors ${
                status === filter.id ? 'bg-blue-50 text-blue-700' : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700'
              }`}
            >
              {filter.label}
            </button>
          ))}
        </div>
      </div>

      {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}

      <div className="relative mt-3">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-zinc-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            Загрузка…
          </div>
        ) : recipients.length === 0 ? (
          <p className="py-8 text-center text-sm text-zinc-500">
            {appliedSearch || status ? 'Под фильтр не попал ни один получатель.' : 'База пуста.'}
          </p>
        ) : (
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-zinc-500">
              <tr className="border-b border-zinc-200">
                <th className="py-2 pr-3 font-medium">Адрес</th>
                <th className="py-2 pr-3 font-medium">Статус</th>
                <th className="py-2 pr-3 font-medium">Писем</th>
                <th className="py-2 pr-3 font-medium">Ящик</th>
                <th className="py-2 pr-3 font-medium">Обновлён</th>
                {columns.map((column) => (
                  <th key={column} className="whitespace-nowrap py-2 pr-3 font-medium normal-case">{COLUMN_LABELS[column] ?? column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {recipients.map((recipient) => (
                <Fragment key={recipient.id}>
                <tr className="border-b border-zinc-100 last:border-0">
                  <td className="py-2 pr-3">
                    <div className="font-medium text-zinc-900">{recipient.email}</div>
                    {recipient.name ? <div className="text-xs text-zinc-500">{recipient.name}</div> : null}
                    {recipient.letters.length ? (
                      <button
                        type="button"
                        onClick={() => setOpenId(openId === recipient.id ? null : recipient.id)}
                        className="mt-0.5 text-xs text-blue-600 hover:underline"
                      >
                        {openId === recipient.id ? 'Скрыть письма' : 'Письма'}
                      </button>
                    ) : null}
                  </td>
                  <td className="py-2 pr-3 text-zinc-600">{recipient.statusLabel}</td>
                  <td className="py-2 pr-3 text-zinc-600">
                    {recipient.lastStepSent > 0 ? `шаг ${recipient.lastStepSent}` : '—'}
                  </td>
                  <td className="py-2 pr-3 text-xs text-zinc-500">{recipient.mailboxEmail ?? '—'}</td>
                  <td className="py-2 pr-3 text-xs text-zinc-500">
                    {recipient.repliedAt
                      ? `ответ ${new Date(recipient.repliedAt).toLocaleDateString('ru-RU')}`
                      : new Date(recipient.updatedAt).toLocaleDateString('ru-RU')}
                  </td>
                  {columns.map((column) => (
                    <td key={column} className="max-w-[240px] truncate py-2 pr-3 text-xs text-zinc-600" title={recipient.vars[column]}>
                      {recipient.vars[column] || '—'}
                    </td>
                  ))}
                </tr>
                {openId === recipient.id ? (
                  <tr className="border-b border-zinc-100 bg-zinc-50">
                    <td colSpan={5 + columns.length} className="px-3 py-3">
                      <div className="space-y-3">
                        {recipient.letters.map((letter) => (
                          <div key={letter.step}>
                            <div className="text-xs font-medium text-zinc-500">
                              Письмо {letter.step}{letter.variant ? ` · вариант ${letter.variant}` : ''}
                            </div>
                            <div className="text-sm font-medium text-zinc-900">{letter.subject || '(без темы)'}</div>
                            <div className="whitespace-pre-wrap text-sm text-zinc-700">{letter.body}</div>
                          </div>
                        ))}
                      </div>
                    </td>
                  </tr>
                ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>

      {total > pageSize ? (
        <div className="mt-3 flex items-center justify-center gap-4 text-sm">
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1 || loading}
            className="rounded-md px-3 py-1.5 text-zinc-700 hover:bg-zinc-100 disabled:opacity-40"
          >
            ← Назад
          </button>
          <span className="text-zinc-500">
            Стр. {page} из {maxPage} · {total}
          </span>
          <button
            type="button"
            onClick={() => setPage((p) => Math.min(maxPage, p + 1))}
            disabled={page >= maxPage || loading}
            className="rounded-md px-3 py-1.5 text-zinc-700 hover:bg-zinc-100 disabled:opacity-40"
          >
            Вперёд →
          </button>
        </div>
      ) : null}
    </SenderModal>
  );
}
