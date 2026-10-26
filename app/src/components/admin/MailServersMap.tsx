'use client';

import { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import {
  addressRows,
  attentionItems,
  freshness,
  providerOf,
  type AddressRow,
  type Freshness,
  type IpKind,
  type MailServerRow,
  type RowState,
} from '@/lib/mailServers/heartbeat';

/** Цвет слота — чей адрес: клиента, наш или на паузе. */
const SLOT: Record<IpKind, string> = {
  client: 'bg-indigo-50 border-indigo-200 text-indigo-950',
  ours: 'bg-teal-50 border-teal-200 text-teal-950',
  paused: 'bg-gray-50 border-gray-300 border-dashed text-gray-500',
  idle: 'bg-white border-gray-300 border-dashed text-gray-400',
};

/** Точка — состояние: зелёная в порядке, жёлтая есть проблема, красная сервер молчит, серая пауза. */
const DOT: Record<RowState, string> = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-400',
  bad: 'bg-red-500',
  off: 'bg-gray-300',
};

const SERVER_DOT: Record<Freshness, string> = {
  ok: 'bg-emerald-500',
  late: 'bg-amber-400',
  silent: 'bg-red-500',
};

function ago(iso: string, now: Date): string {
  const min = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60_000));
  if (min < 60) return `${min} мин назад`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h} ч назад` : `${Math.floor(h / 24)} дн. назад`;
}

function Slot({ a, selected, onSelect }: { a: AddressRow; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full text-left rounded-lg border px-3 py-2.5 transition ${SLOT[a.kind]} ${
        selected ? 'ring-2 ring-indigo-400 ring-offset-1' : 'hover:brightness-[0.97]'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <span className={`leading-tight break-words ${a.kind === 'client' ? 'font-semibold' : 'font-medium'}`}>{a.who}</span>
        <span className="shrink-0 text-lg font-semibold leading-none tabular-nums">
          {a.boxes}
          <span className="ml-0.5 text-xs font-normal opacity-60">ящ.</span>
        </span>
      </div>
      <div className="mt-1.5 flex items-center gap-1.5 text-xs opacity-70">
        <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[a.state]}`} />
        <span className="font-mono">{a.ip}</span>
      </div>
      {a.state !== 'ok' && <div className="mt-0.5 text-xs leading-snug opacity-70">{a.stateText}</div>}
    </button>
  );
}

function Details({ a }: { a: AddressRow }) {
  return (
    <div className="mt-4 rounded-xl border border-gray-200 bg-white p-4 text-sm">
      <div className="flex flex-wrap items-baseline gap-x-2 mb-3">
        <span className="font-semibold text-gray-900">{a.who}</span>
        <span className="text-gray-500">
          {a.boxes} ящ. · {a.ip} · {a.server}, {a.where} · обратное имя {a.ptr || '—'}
        </span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {a.domains.map((d) => (
          <div key={d.domain} className="rounded-lg bg-gray-50 px-3 py-2">
            <div className="text-gray-900">{d.domain}</div>
            <div className="text-xs text-gray-500">
              {d.boxes} ящ.{d.paused ? `, на паузе ${d.paused}` : ''} · подключение {d.conn || '—'}
            </div>
          </div>
        ))}
      </div>
      {a.tags.length > 0 && (
        <div className="mt-3 text-xs text-gray-600">
          Instantly:{' '}
          {a.tags.map((t) => `«${t.label}» — подключено ${t.active} из ${t.boxes}, прогрев у ${t.warmup_on}`).join('; ')}
        </div>
      )}
    </div>
  );
}

/**
 * Карта почтовых серверов: провайдер → серверы → слоты-адреса (кто на адресе, сколько ящиков, состояние),
 * сверху — что требует внимания, по клику на слот — домены и Instantly. Данные приходят готовыми
 * (страница грузит их из /api/admin/mail-servers), поэтому компонент можно отрисовать и вне страницы.
 */
export function MailServersMap({ rows, now, initialSelected = null }: { rows: MailServerRow[]; now: Date; initialSelected?: string | null }) {
  const [selected, setSelected] = useState<string | null>(initialSelected);
  const addresses = useMemo(() => addressRows(rows, now), [rows, now]);
  const attention = useMemo(() => attentionItems(rows, now), [rows, now]);

  // Провайдер → серверы (клиентские первыми) → слоты-адреса
  const map = useMemo(() => {
    const order = (row: MailServerRow) =>
      Math.min(...addresses.filter((a) => a.serverId === row.server_id).map((a) => ({ client: 0, ours: 1, paused: 2, idle: 3 })[a.kind]), 3);
    const groups = new Map<string, MailServerRow[]>();
    for (const row of [...rows].sort((a, b) => order(a) - order(b) || a.payload.server.label.localeCompare(b.payload.server.label))) {
      const key = providerOf(row);
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    return [...groups.entries()];
  }, [rows, addresses]);

  const picked = addresses.find((a) => a.key === selected) ?? null;

  return (
    <>
      {rows.length > 0 &&
        (attention.length === 0 ? (
          <div className="mb-6 flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-emerald-800">
            <CheckCircle2 className="h-5 w-5 shrink-0" /> Всё в порядке: все серверы на связи, тревог нет.
          </div>
        ) : (
          <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
            <div className="flex items-center gap-2 font-medium text-amber-900 mb-1">
              <AlertTriangle className="h-5 w-5" /> Требует внимания
            </div>
            <ul className="space-y-0.5 text-sm">
              {attention.map((a) => (
                <li key={a.text} className="flex gap-2">
                  <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${a.level === 'bad' ? 'bg-red-500' : 'bg-amber-400'}`} />
                  <span className={a.level === 'bad' ? 'text-red-800' : 'text-amber-900'}>{a.text}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}

      {map.map(([provider, servers]) => (
        <section key={provider} className="mb-6 rounded-2xl border border-gray-200 bg-gray-50/60 p-4 sm:p-5">
          <div className="flex flex-wrap items-baseline gap-2 mb-3">
            <h2 className="text-base font-semibold text-gray-900">{provider}</h2>
            <span className="text-xs text-gray-500">
              {servers.length} серв. · {addresses.filter((a) => servers.some((s) => s.server_id === a.serverId)).length} адр.
            </span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {servers.map((row) => {
              const s = row.payload.server;
              const m = row.payload.mail_today;
              const fresh = freshness(row.received_at, now);
              const slots = addresses.filter((a) => a.serverId === row.server_id);
              return (
                <div key={row.server_id} className="flex flex-col rounded-xl border border-gray-200 bg-white p-3">
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <span className="flex items-center gap-1.5 font-semibold text-gray-900">
                      <span className={`h-2.5 w-2.5 rounded-full ${SERVER_DOT[fresh]}`} />
                      {s.label}
                    </span>
                    <span className={`text-xs ${fresh === 'ok' ? 'text-gray-400' : 'font-medium text-red-600'}`}>
                      {ago(row.received_at, now)}
                    </span>
                  </div>
                  <div className="space-y-2">
                    {slots.map((a) => (
                      <Slot key={a.key} a={a} selected={selected === a.key} onSelect={() => setSelected(selected === a.key ? null : a.key)} />
                    ))}
                  </div>
                  <div className="mt-auto pt-2 text-xs text-gray-400">
                    <span className="whitespace-nowrap">за сутки ушло {m.sent}, пришло {m.delivered_in}</span> ·{' '}
                    <span className={`whitespace-nowrap ${s.disk_used_pct >= 80 ? 'font-medium text-red-600' : ''}`}>диск {s.disk_used_pct}%</span>
                  </div>
                </div>
              );
            })}
          </div>
          {picked && servers.some((s) => s.server_id === picked.serverId) && <Details a={picked} />}
        </section>
      ))}

      {rows.length > 0 && (
        <div className="mb-8 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-gray-500">
          <span className="inline-flex items-center gap-1.5"><span className="h-3 w-5 rounded border border-indigo-200 bg-indigo-50" /> клиент</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-3 w-5 rounded border border-teal-200 bg-teal-50" /> наши неименные</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-3 w-5 rounded border border-dashed border-gray-300 bg-gray-50" /> на паузе</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-emerald-500" /> в порядке</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-amber-400" /> есть проблема</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-red-500" /> сервер молчит</span>
        </div>
      )}
    </>
  );
}
