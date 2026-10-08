'use client';

import { Fragment, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { describeBounceCode, isTemporaryBounceCode } from '@/lib/sender/bounceCodes';
import {
  fetchBounceCodeEvents,
  fetchBounceCodes,
  type BounceCodeCountDto,
  type BounceCodeEventDto,
  type SenderStatsPeriod,
} from './api';

/**
 * «Коды отказов»: какими кодами ответили серверы получателей — из писем-
 * отбойников и отказов при отправке (sender_bounce_codes). Клик по коду
 * раскрывает последние письма с ним и текст ответа сервера.
 */

const nf = (value: number) => value.toLocaleString('ru-RU');
const keyOf = (code: string | null) => code ?? 'none';

function share(n: number, total: number): string {
  return total > 0 ? `${(Math.round((n / total) * 1000) / 10).toLocaleString('ru-RU')}%` : '—';
}

function formatAt(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow',
  });
}

function EventsList({ events }: { events: BounceCodeEventDto[] }) {
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  if (events.length === 0) return <p className="px-5 py-3 text-xs text-zinc-400">Писем нет</p>;
  return (
    <ul className="divide-y divide-zinc-100 bg-zinc-50/60">
      {events.map((e, i) => {
        const detail = (e.detail ?? '').trim();
        const firstLine = detail.split(/\r?\n/).find((l) => l.trim()) ?? '—';
        const open = openIdx === i;
        return (
          <li key={i} className="px-5 py-2 text-xs">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
              <span className="tabular-nums text-zinc-400">{formatAt(e.at)}</span>
              <span className="font-medium text-zinc-800">{e.to_email ?? 'адрес не указан'}</span>
              <span className="text-zinc-500">с {e.mailbox_email ?? '—'}</span>
              <span className="text-zinc-400">{e.campaign_name ?? 'кампания не определена'}</span>
              {e.source === 'send' && <span className="text-amber-600">при отправке</span>}
            </div>
            <button
              type="button"
              onClick={() => setOpenIdx(open ? null : i)}
              className="mt-0.5 block w-full text-left text-zinc-600 hover:text-zinc-900"
              title={open ? 'Свернуть' : 'Полный ответ сервера'}
            >
              {open ? <pre className="whitespace-pre-wrap break-words font-sans">{detail}</pre> : <span className="line-clamp-1 break-all">{firstLine}</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function BounceCodes({
  period,
  campaignId,
  reloadKey,
}: {
  period: SenderStatsPeriod;
  campaignId: string | null;
  reloadKey: number;
}) {
  const [codes, setCodes] = useState<BounceCodeCountDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [events, setEvents] = useState<Record<string, BounceCodeEventDto[] | 'loading' | 'error'>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchBounceCodes(period, campaignId);
        if (cancelled) return;
        // Раскрытые письма относятся к прошлому фильтру — сбрасываем вместе с кодами
        setOpenKey(null);
        setEvents({});
        setCodes(res.codes);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Не удалось загрузить коды');
      }
    })();
    return () => { cancelled = true; };
  }, [period, campaignId, reloadKey]);

  const toggle = async (code: string | null) => {
    const key = keyOf(code);
    if (openKey === key) { setOpenKey(null); return; }
    setOpenKey(key);
    if (Array.isArray(events[key]) || events[key] === 'loading') return;
    setEvents((prev) => ({ ...prev, [key]: 'loading' }));
    try {
      const res = await fetchBounceCodeEvents(code, period, campaignId);
      setEvents((prev) => ({ ...prev, [key]: res.events }));
    } catch {
      setEvents((prev) => ({ ...prev, [key]: 'error' }));
    }
  };

  const list = codes ?? [];
  const total = list.reduce((sum, c) => sum + c.n, 0);
  const groups = [
    { title: 'Окончательные — письмо не доставлено', rows: list.filter((c) => !isTemporaryBounceCode(c.code)) },
    { title: 'Временные — почта ещё пытается доставить', rows: list.filter((c) => isTemporaryBounceCode(c.code)) },
  ].filter((g) => g.rows.length > 0);

  return (
    <div className="rounded-xl border border-zinc-200 bg-white">
      <div className="px-5 pt-5">
        <h3 className="text-sm font-semibold text-zinc-900">Коды отказов</h3>
        <p className="mb-3 text-xs text-zinc-400">Что ответили серверы получателей. Клик по коду — письма</p>
      </div>

      {error ? (
        <p className="px-5 pb-5 text-sm text-red-600">{error}</p>
      ) : codes === null ? (
        <div className="flex items-center gap-2 px-5 pb-5 text-sm text-zinc-400">
          <Loader2 className="h-4 w-4 animate-spin" /> Загружаю коды…
        </div>
      ) : total === 0 ? (
        <p className="px-5 pb-5 text-sm text-zinc-500">Отказов за период нет</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase text-zinc-500">
            <tr className="border-y border-zinc-200">
              <th className="px-5 py-2 font-medium">Код</th>
              <th className="px-3 py-2 font-medium">Что значит</th>
              <th className="px-3 py-2 text-right font-medium">Писем</th>
              <th className="px-5 py-2 text-right font-medium">Доля</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => (
              <Fragment key={group.title}>
                <tr className="border-b border-zinc-100 bg-zinc-50">
                  <td colSpan={4} className="px-5 py-1.5 text-xs font-medium text-zinc-500">{group.title}</td>
                </tr>
                {group.rows.map((row) => {
                  const key = keyOf(row.code);
                  const open = openKey === key;
                  const state = events[key];
                  const temporary = isTemporaryBounceCode(row.code);
                  return (
                    <Fragment key={key}>
                      <tr
                        onClick={() => void toggle(row.code)}
                        className="cursor-pointer border-b border-zinc-100 hover:bg-zinc-50"
                      >
                        <td className="px-5 py-2 font-mono text-xs">
                          <span className="inline-flex items-center gap-1">
                            {open ? <ChevronDown className="h-3.5 w-3.5 text-zinc-400" /> : <ChevronRight className="h-3.5 w-3.5 text-zinc-400" />}
                            <span className={temporary ? 'text-amber-700' : 'text-red-700'}>{row.code ?? '—'}</span>
                          </span>
                        </td>
                        <td className="px-3 py-2 text-zinc-700">{describeBounceCode(row.code)}</td>
                        <td className="px-3 py-2 text-right font-medium tabular-nums text-zinc-900">{nf(row.n)}</td>
                        <td className="px-5 py-2 text-right tabular-nums text-zinc-500">{share(row.n, total)}</td>
                      </tr>
                      {open && (
                        <tr className="border-b border-zinc-100">
                          <td colSpan={4} className="p-0">
                            {state === 'loading' || state === undefined ? (
                              <div className="flex items-center gap-2 px-5 py-3 text-xs text-zinc-400">
                                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Загружаю письма…
                              </div>
                            ) : state === 'error' ? (
                              <p className="px-5 py-3 text-xs text-red-600">Не удалось загрузить письма</p>
                            ) : (
                              <EventsList events={state} />
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
