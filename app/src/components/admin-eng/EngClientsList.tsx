'use client';

/**
 * Раздел «Английские клиенты» — список (/admin/eng-clients): полоса пула
 * ящиков, чипы с числами по всем аккаунтам, поиск, таблица (уже 640 px —
 * карточки строк), страницы по 25. Состояние — в адресе (?page, ?filter, ?q).
 * Данные — GET /api/admin/eng-clients (engAdminView.readHeEngAdminList);
 * опроса нет, «Обновить» перечитывает.
 */

import Link from 'next/link';
import type { Route } from 'next';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2, RefreshCw } from 'lucide-react';
import { useIsTma } from '@/lib/useIsTma';
import { SendingPoolPanel } from '@/components/hypothesis-engine/SendingPoolPanel';
import type { HeEngAdminList, HeEngAdminRow } from '@/lib/hypothesisEngine/engAdminView';
import { HE_ENG_ADMIN_FILTERS, isHeEngAdminFilter, type HeEngAdminFilter } from './filters';
import { fetchEngClients } from './api';
import {
  FILTER_HINTS,
  FILTER_LABELS,
  MISSING_SOURCE_LABELS,
  RED_FILTERS,
  attentionText,
  fmtDateShort,
  fmtNum,
  leakText,
  projectStatusLabel,
  ruPlural,
  sendingBadge,
  sendingColumnText,
} from './labels';

type Tone = 'red' | 'amber' | 'blue' | 'grey' | 'green';

const TONE_CLASS: Record<Tone, string> = {
  red: 'bg-red-50 text-red-700 border-red-200',
  amber: 'bg-amber-50 text-amber-800 border-amber-200',
  blue: 'bg-blue-50 text-blue-700 border-blue-200',
  grey: 'bg-gray-100 text-gray-600 border-gray-200',
  green: 'bg-green-50 text-green-700 border-green-200',
};

function Badge({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${TONE_CLASS[tone]}`}>
      {children}
    </span>
  );
}

function hostOf(url: string | null | undefined): string {
  if (!url) return '—';
  try {
    return new URL(url.includes('://') ? url : `https://${url}`).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Значки колонки «Внимание». */
function rowBadges(row: HeEngAdminRow): Array<{ tone: Tone; text: string; title?: string }> {
  const out: Array<{ tone: Tone; text: string; title?: string }> = [];
  if (row.ban_without_stop) {
    out.push({
      tone: 'red',
      text: row.marker === 'unknown' ? 'Бан без остановки (таблицы блокировок нет)' : 'Бан без остановки',
      title: FILTER_HINTS.ban_no_stop,
    });
  }
  if (row.leak.length > 0) {
    out.push({ tone: 'red', text: 'Заблокирован, но работа идёт', title: row.leak.map(leakText).join('\n') });
  } else if (row.marker === 'active') {
    out.push({ tone: 'grey', text: `Заблокирован ${fmtDateShort(row.blocked_at)}` });
  }
  if (row.marker_without_ban) out.push({ tone: 'amber', text: 'Отметка блокировки без бана' });
  if (row.auth.state === 'unread') out.push({ tone: 'grey', text: 'Вход: статус не прочитан' });
  if (row.auth.state === 'missing') out.push({ tone: 'amber', text: 'Нет в списке входа' });
  const sendingMark = sendingBadge(row.sending);
  if (sendingMark) out.push(sendingMark);
  for (const a of row.attention) out.push({ tone: 'amber', text: attentionText(a) });
  if (row.email_verified === 'no') out.push({ tone: 'grey', text: 'Почта не подтверждена' });
  if (row.support?.awaiting_reply) out.push({ tone: 'blue', text: 'Ждёт ответа в поддержке' });
  if (row.projects_count > 1) out.push({ tone: 'grey', text: `Проектов: ${row.projects_count}` });
  return out;
}

function campaignsText(row: HeEngAdminRow): string {
  const c = row.campaigns;
  if (c.unread) return 'статусы не читаются';
  if (c.total === 0) return 'кампаний нет';
  const parts = [`отправляют ${c.sending} из ${c.total}`];
  if (c.sent !== null) parts.push(`${fmtNum(c.sent)} ${ruPlural(c.sent, 'письмо', 'письма', 'писем')}`);
  if (c.replies !== null) parts.push(`${fmtNum(c.replies)} ${ruPlural(c.replies, 'ответ', 'ответа', 'ответов')}`);
  return parts.join(' · ');
}

function CampaignsCell({ row }: { row: HeEngAdminRow }) {
  return (
    <div>
      <p>{campaignsText(row)}</p>
      {row.campaigns.stale && !row.campaigns.unread ? (
        <p className="text-[11px] text-gray-400">
          {row.campaigns.oldest_status_at ? `статус от ${fmtDateShort(row.campaigns.oldest_status_at)}` : 'статус не у всех прочитан'}
        </p>
      ) : null}
    </div>
  );
}

function ClientCell({ row }: { row: HeEngAdminRow }) {
  return (
    <div className="min-w-0">
      <p className="truncate font-medium text-gray-900">{row.full_name || row.email || 'Без имени'}</p>
      {row.full_name && row.email ? <p className="truncate text-xs text-gray-500">{row.email}</p> : null}
      {row.company ? <p className="truncate text-xs text-gray-400">{row.company}</p> : null}
    </div>
  );
}

function SiteCell({ row }: { row: HeEngAdminRow }) {
  if (!row.project) return <span className="text-gray-400">проекта нет</span>;
  return (
    <div className="min-w-0">
      <p className="truncate text-gray-900">{hostOf(row.project.website_url)}</p>
      <p className="text-xs text-gray-500">{projectStatusLabel(row.project.status)}</p>
    </div>
  );
}

function PoolStrip({ list }: { list: HeEngAdminList }) {
  const [open, setOpen] = useState(false);
  const pool = list.pool;
  return (
    <div className="mb-6 rounded-xl border border-gray-200 bg-white p-4 text-sm shadow-sm">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          {pool.state === 'ok' ? (
            <>
              <p className="font-medium text-gray-900">
                Пул: свободно {pool.available} · отдано {pool.assigned} · выключено {pool.disabled} (воркспейс{' '}
                {pool.workspace}) — хватит на {pool.fits_new_clients}{' '}
                {ruPlural(pool.fits_new_clients, 'нового клиента', 'новых клиентов', 'новых клиентов')}
                <span className="font-normal text-gray-500"> (по {pool.per_project} на проект)</span>
              </p>
              {pool.workspace_problem ? <p className="text-red-700">Воркспейс пула не годится: {pool.workspace_problem}</p> : null}
              {pool.held_by_blocked.mailboxes > 0 ? (
                <p className="text-amber-800">
                  Ящики у заблокированных клиентов: {pool.held_by_blocked.mailboxes} (проектов {pool.held_by_blocked.projects}) —
                  остаются за ними, пока их не освободят вручную
                </p>
              ) : null}
              {pool.limit_reached ? (
                <p className="text-red-700">
                  В пуле больше {pool.limit} строк — прочитаны первые {pool.rows_read}; счётчики выше неполные
                </p>
              ) : null}
              <p className="text-gray-500">Состояние ящиков проверяется вручную</p>
            </>
          ) : pool.state === 'missing' ? (
            <p className="text-amber-800">Пула нет: не применена миграция 20261011_0001</p>
          ) : (
            <p className="text-red-700">Пул не прочитался</p>
          )}
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="shrink-0 self-start rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
        >
          {open ? 'Свернуть пул' : 'Открыть пул'}
        </button>
      </div>
      {open ? (
        <div className="mt-4 border-t border-gray-100 pt-4">
          <SendingPoolPanel />
        </div>
      ) : null}
    </div>
  );
}

export function EngClientsList() {
  const isTma = useIsTma();
  const router = useRouter();
  const params = useSearchParams();
  const page = Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1);
  const filterParam = params.get('filter');
  const filter: HeEngAdminFilter = isHeEngAdminFilter(filterParam) ? filterParam : 'all';
  const q = params.get('q') ?? '';

  const [draft, setDraft] = useState(q);
  const [list, setList] = useState<HeEngAdminList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const go = useCallback(
    (next: { page?: number; filter?: HeEngAdminFilter; q?: string }) => {
      const sp = new URLSearchParams();
      const nextPage = next.page ?? 1;
      const nextFilter = next.filter ?? filter;
      const nextQ = next.q ?? q;
      if (nextPage > 1) sp.set('page', String(nextPage));
      if (nextFilter !== 'all') sp.set('filter', nextFilter);
      if (nextQ.trim()) sp.set('q', nextQ.trim());
      const qs = sp.toString();
      router.replace(`/admin/eng-clients${qs ? `?${qs}` : ''}` as Route);
    },
    [router, filter, q],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await fetchEngClients({ page, filter, q });
        if (!cancelled) setList(data);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Не удалось загрузить английских клиентов');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [page, filter, q, reloadKey]);

  const range = useMemo(() => {
    if (!list || list.total === 0) return null;
    const from = (list.page - 1) * list.per_page + 1;
    const to = Math.min(list.total, list.page * list.per_page);
    return { from, to, pages: Math.max(1, Math.ceil(list.total / list.per_page)) };
  }, [list]);

  const openCard = (id: string) => router.push(`/admin/eng-clients/${id}` as Route);

  return (
    <div className={`mx-auto max-w-7xl px-4 ${isTma ? 'py-6 text-sm leading-relaxed' : 'py-10'}`}>
      <div className="mb-6">
        <Link href="/admin" className="text-sm font-medium text-blue-600 hover:text-blue-700">
          ← Назад в админку
        </Link>
      </div>
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className={`${isTma ? 'text-xl' : 'text-3xl'} font-bold text-gray-900`}>Английские клиенты</h1>
          <p className="mt-1 text-sm text-gray-500">
            Все аккаунты английского кабинета. Нажмите на строку — откроется карточка клиента.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setReloadKey((k) => k + 1)}
          disabled={loading}
          className="inline-flex items-center gap-2 self-start rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Обновить
        </button>
      </div>

      {error ? (
        <div className="mb-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>
      ) : null}

      {list ? (
        <>
          <PoolStrip list={list} />

          {list.missing.length > 0 ? (
            <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              Не применены миграции — эти данные не читаются: {list.missing.map((m) => MISSING_SOURCE_LABELS[m]).join('; ')}.
            </div>
          ) : null}
          {list.truncated ? (
            <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              Показаны не все: прочитаны первые {list.profiles_cap} аккаунтов (новые первыми), остальные в список и
              числа не попали.
            </div>
          ) : null}
          {list.auth.state !== 'complete' ? (
            <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              {list.auth.state === 'error'
                ? 'Статус входа (бан) не прочитался — «Заблокированы» и «Бан без остановки» показаны не все.'
                : `Статус входа (бан) прочитан не у всех: не прочитан у ${list.auth.unread_rows} ${ruPlural(
                    list.auth.unread_rows,
                    'аккаунта',
                    'аккаунтов',
                    'аккаунтов',
                  )} (прочитано пользователей входа: ${list.auth.users_read}${
                    list.auth.users_total ? ` из ${list.auth.users_total}` : ''
                  }) — «Заблокированы» и «Бан без остановки» показаны не все.`}
            </div>
          ) : null}

          <div className="mb-3 flex flex-wrap gap-2">
            {HE_ENG_ADMIN_FILTERS.map((f) => {
              const active = f === filter;
              const red = RED_FILTERS.has(f) && list.counts[f] > 0;
              return (
                <button
                  key={f}
                  type="button"
                  onClick={() => go({ filter: f, page: 1 })}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition-colors ${
                    active
                      ? red
                        ? 'border-red-600 bg-red-600 text-white'
                        : 'border-blue-600 bg-blue-600 text-white'
                      : red
                        ? 'border-red-300 bg-red-50 text-red-700 hover:bg-red-100'
                        : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  {FILTER_LABELS[f]}
                  <span className="tabular-nums opacity-80">{list.counts[f]}</span>
                </button>
              );
            })}
          </div>
          {FILTER_HINTS[filter] ? <p className="mb-3 text-sm text-gray-600">{FILTER_HINTS[filter]}</p> : null}

          <form
            className="mb-4 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              go({ q: draft, page: 1 });
            }}
          >
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Почта, имя, компания или сайт"
              autoComplete="off"
              className="h-9 min-w-0 flex-1 rounded-lg border border-gray-300 px-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button type="submit" className="h-9 shrink-0 rounded-lg bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700">
              Найти
            </button>
          </form>

          {list.rows.length === 0 ? (
            <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 p-10 text-center text-sm text-gray-500">
              {q || filter !== 'all' ? 'Под условия никто не подошёл' : 'Английских клиентов пока нет'}
            </div>
          ) : (
            <>
              {/* Уже 640 px — строки карточками, без горизонтальной прокрутки страницы. */}
              <ul className="space-y-3 sm:hidden">
                {list.rows.map((row) => (
                  <li key={row.user_id}>
                    <button
                      type="button"
                      onClick={() => openCard(row.user_id)}
                      className="w-full rounded-xl border border-gray-200 bg-white p-4 text-left text-sm shadow-sm hover:border-blue-300"
                    >
                      <ClientCell row={row} />
                      <div className="mt-2 grid grid-cols-1 gap-1 text-gray-700">
                        <SiteCell row={row} />
                        <p>
                          Рынки: выбрано {row.markets.selected} · запущено {row.markets.launched}
                        </p>
                        <p>Отправка: {sendingColumnText(row.sending)}</p>
                        <CampaignsCell row={row} />
                        <p>Ящики: {row.mailboxes ?? '—'}</p>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1">
                        {rowBadges(row).map((b, i) => (
                          <Badge key={i} tone={b.tone} title={b.title}>
                            {b.text}
                          </Badge>
                        ))}
                      </div>
                      <p className="mt-2 text-xs text-gray-400">
                        Активность {fmtDateShort(row.last_activity_at)} · регистрация {fmtDateShort(row.signed_up_at)}
                      </p>
                    </button>
                  </li>
                ))}
              </ul>

              <div className="hidden overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm sm:block">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-gray-200 bg-gray-50 text-xs font-medium uppercase tracking-wide text-gray-500">
                    <tr>
                      <th className="px-4 py-3">Клиент</th>
                      <th className="px-4 py-3">Сайт</th>
                      <th className="px-4 py-3">Рынки</th>
                      <th className="px-4 py-3">Отправка</th>
                      <th className="px-4 py-3">Кампании</th>
                      <th className="px-4 py-3">Ящики</th>
                      <th className="px-4 py-3">Внимание</th>
                      <th className="px-4 py-3">Активность</th>
                      <th className="px-4 py-3">Регистрация</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {list.rows.map((row) => (
                      <tr
                        key={row.user_id}
                        onClick={() => openCard(row.user_id)}
                        className="cursor-pointer align-top hover:bg-blue-50/40"
                      >
                        <td className="max-w-[220px] px-4 py-3">
                          <Link
                            href={`/admin/eng-clients/${row.user_id}` as Route}
                            onClick={(e) => e.stopPropagation()}
                            className="block"
                          >
                            <ClientCell row={row} />
                          </Link>
                        </td>
                        <td className="max-w-[180px] px-4 py-3">
                          <SiteCell row={row} />
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-gray-700">
                          выбрано {row.markets.selected} · запущено {row.markets.launched}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-gray-700">
                          {sendingColumnText(row.sending)}
                        </td>
                        <td className="px-4 py-3 text-gray-700">
                          <CampaignsCell row={row} />
                        </td>
                        <td className="px-4 py-3 text-gray-700">{row.mailboxes ?? '—'}</td>
                        <td className="max-w-[260px] px-4 py-3">
                          <div className="flex flex-wrap gap-1">
                            {rowBadges(row).map((b, i) => (
                              <Badge key={i} tone={b.tone} title={b.title}>
                                {b.text}
                              </Badge>
                            ))}
                          </div>
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-gray-500">{fmtDateShort(row.last_activity_at)}</td>
                        <td className="whitespace-nowrap px-4 py-3 text-gray-500">{fmtDateShort(row.signed_up_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {range ? (
                <div className="mt-4 flex items-center justify-between gap-3 text-sm text-gray-600">
                  <button
                    type="button"
                    disabled={list.page <= 1 || loading}
                    onClick={() => go({ page: list.page - 1 })}
                    className="rounded-lg border border-gray-300 px-3 py-1.5 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    ← Назад
                  </button>
                  <span>
                    Показаны {range.from}–{range.to} из {list.total}
                  </span>
                  <button
                    type="button"
                    disabled={list.page >= range.pages || loading}
                    onClick={() => go({ page: list.page + 1 })}
                    className="rounded-lg border border-gray-300 px-3 py-1.5 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Вперёд →
                  </button>
                </div>
              ) : null}
            </>
          )}
        </>
      ) : loading ? (
        <div className="flex h-40 items-center justify-center text-sm text-gray-500">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Загрузка…
        </div>
      ) : null}
    </div>
  );
}
