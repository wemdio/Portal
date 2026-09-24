'use client';

import { useCallback, useState } from 'react';
import { ChevronDown, Server } from 'lucide-react';
import type { EgressIpDto } from './api';
import { useDismiss } from './MailboxTags';

/**
 * Адреса отправки: с каждого выходит в интернет свой воркер, и каждый ящик
 * закреплён за одним адресом. Блок показывает, жив ли адрес и сколько на нём
 * ящиков; меню «На адрес» переносит выбранные ящики.
 */

const STATE_LABELS: Record<EgressIpDto['state'], { text: string; className: string }> = {
  online: { text: 'Работает', className: 'bg-emerald-50 text-emerald-700' },
  silent: { text: 'Молчит', className: 'bg-amber-50 text-amber-700' },
  error: { text: 'Ошибка адреса', className: 'bg-red-50 text-red-700' },
};

function silentFor(lastSeenAt: string | null): string {
  if (!lastSeenAt) return 'ни разу не выходил на связь';
  const minutes = Math.round((Date.now() - new Date(lastSeenAt).getTime()) / 60_000);
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} ч` : `${Math.round(hours / 24)} дн`;
}

export function EgressPanel({
  ips,
  unassigned,
  filter,
  busyIp,
  onFilter,
  onToggleAcceptsNew,
}: {
  ips: EgressIpDto[];
  unassigned: number;
  filter: string | null;
  busyIp: string | null;
  onFilter: (ip: string | null) => void;
  onToggleAcceptsNew: (row: EgressIpDto) => void;
}) {
  if (!ips.length) return null;

  return (
    <div className="rounded-xl border border-zinc-200 bg-white">
      <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3">
        <h2 className="text-base font-semibold text-zinc-900">Адреса отправки</h2>
        {filter ? (
          <button
            type="button"
            onClick={() => onFilter(null)}
            className="rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700"
          >
            Показать ящики всех адресов
          </button>
        ) : null}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase text-zinc-500">
            <tr className="border-b border-zinc-200">
              <th className="px-5 py-2 font-medium">Адрес</th>
              <th className="px-3 py-2 font-medium">Сервер</th>
              <th className="px-3 py-2 font-medium">Состояние</th>
              <th className="px-3 py-2 font-medium">Ящиков</th>
              <th className="px-3 py-2 font-medium">Отправлено сегодня</th>
              <th className="px-5 py-2 font-medium">Новые ящики</th>
            </tr>
          </thead>
          <tbody>
            {ips.map((row) => {
              const state = STATE_LABELS[row.state];
              return (
                <tr
                  key={row.ip}
                  className={`border-b border-zinc-100 last:border-0 ${filter === row.ip ? 'bg-blue-50/40' : ''}`}
                >
                  <td className="px-5 py-2.5">
                    {/* Клик по адресу — его ящики в таблице ниже. */}
                    <button
                      type="button"
                      onClick={() => onFilter(filter === row.ip ? null : row.ip)}
                      title="Показать ящики этого адреса"
                      className="font-mono text-xs text-blue-600 underline-offset-2 hover:underline"
                    >
                      {row.ip}
                    </button>
                  </td>
                  <td className="px-3 py-2.5 font-mono text-xs text-zinc-500">{row.host || '—'}</td>
                  <td className="px-3 py-2.5">
                    <span
                      title={row.lastError ?? undefined}
                      className={`rounded-md px-2 py-0.5 text-xs font-medium ${state.className}`}
                    >
                      {state.text}
                    </span>
                    {row.state === 'silent' ? (
                      <span className="ml-2 text-xs text-zinc-400">{silentFor(row.lastSeenAt)}</span>
                    ) : null}
                    {row.state === 'error' && row.lastError ? (
                      <div className="mt-0.5 text-xs text-red-600">{row.lastError}</div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2.5 text-zinc-700">
                    {row.mailboxes}
                    {row.mailboxes ? (
                      <span className="ml-1 text-xs text-zinc-400">(в рассылке {row.enabledMailboxes})</span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2.5 text-zinc-700">{row.sentToday}</td>
                  <td className="px-5 py-2.5">
                    <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-zinc-600">
                      <input
                        type="checkbox"
                        checked={row.acceptsNew}
                        disabled={busyIp === row.ip}
                        onChange={() => onToggleAcceptsNew(row)}
                        className="h-4 w-4 cursor-pointer rounded border-zinc-300"
                      />
                      Выдавать
                    </label>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {unassigned > 0 ? (
        <p className="border-t border-zinc-200 px-5 py-2.5 text-xs text-amber-700">
          Ждут адреса: {unassigned}. Адрес выдаётся сам в течение минуты, если есть работающий адрес с включённой
          выдачей новых ящиков.
        </p>
      ) : null}
    </div>
  );
}

/** Меню «На адрес» в панели выделения. */
export function EgressMoveMenu({
  ips,
  disabled,
  onPick,
}: {
  ips: EgressIpDto[];
  disabled: boolean;
  onPick: (ip: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss(open, close);

  if (!ips.length) return null;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-100 disabled:opacity-50"
      >
        <Server className="h-3.5 w-3.5" />
        На адрес
        <ChevronDown className="h-3 w-3 opacity-60" />
      </button>

      {open ? (
        <div className="absolute left-0 z-30 mt-1 w-72 rounded-xl border border-zinc-200 bg-white p-1.5 shadow-lg">
          {ips.map((row) => {
            const state = STATE_LABELS[row.state];
            return (
              <button
                key={row.ip}
                type="button"
                onClick={() => {
                  setOpen(false);
                  onPick(row.ip);
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-zinc-700 hover:bg-zinc-100"
              >
                <span className="font-mono text-xs">{row.ip}</span>
                <span className="flex-1 truncate text-xs text-zinc-400">{row.host}</span>
                <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-medium ${state.className}`}>{state.text}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
