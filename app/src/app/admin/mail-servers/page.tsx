'use client';

import Link from 'next/link';
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import { authFetch } from '@/lib/authFetch';
import {
  addressRows,
  attentionItems,
  freshness,
  providerOf,
  type MailServerRow,
  type RowState,
} from '@/lib/mailServers/heartbeat';

const DOT: Record<RowState, string> = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-400',
  bad: 'bg-red-500',
  off: 'bg-gray-300',
};

function ago(iso: string, now: Date): string {
  const min = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60_000));
  if (min < 60) return `${min} мин назад`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h} ч назад` : `${Math.floor(h / 24)} дн. назад`;
}

export default function AdminMailServersPage() {
  const [rows, setRows] = useState<MailServerRow[]>([]);
  const [now, setNow] = useState(() => new Date());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await authFetch('/api/admin/mail-servers');
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j?.error ?? res.statusText);
      }
      const data = (await res.json()) as { servers: MailServerRow[]; now: string };
      setRows(data.servers);
      setNow(new Date(data.now));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, [load]);

  const addresses = useMemo(() => addressRows(rows, now), [rows, now]);
  const attention = useMemo(() => attentionItems(rows, now), [rows, now]);
  const boxes = addresses.reduce((n, a) => n + (a.kind === 'paused' ? 0 : a.boxes), 0);

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      <Link href="/admin" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-4">
        <ChevronLeft className="h-4 w-4" /> Админ панель
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Почтовые серверы</h1>
          <p className="text-sm text-gray-500 mt-1">
            {rows.length} серв. · {addresses.length} адр. · {boxes} ящиков в работе · данные обновляются сами каждые 15 минут
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Обновить
        </button>
      </div>

      {error && (
        <div className="mb-6 flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <AlertTriangle className="h-4 w-4 shrink-0" /> {error}
        </div>
      )}

      {rows.length > 0 &&
        (attention.length === 0 ? (
          <div className="mb-8 flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-emerald-800">
            <CheckCircle2 className="h-5 w-5 shrink-0" />
            <span>Всё в порядке: все серверы на связи, тревог нет.</span>
          </div>
        ) : (
          <div className="mb-8 rounded-xl border border-amber-200 bg-amber-50 p-4">
            <div className="flex items-center gap-2 font-medium text-amber-900 mb-2">
              <AlertTriangle className="h-5 w-5" /> Требует внимания
            </div>
            <ul className="space-y-1 text-sm">
              {attention.map((a) => (
                <li key={a.text} className="flex gap-2">
                  <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${a.level === 'bad' ? 'bg-red-500' : 'bg-amber-400'}`} />
                  <span className={a.level === 'bad' ? 'text-red-800' : 'text-amber-900'}>{a.text}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}

      {!loading && rows.length === 0 && !error && (
        <div className="mb-8 rounded-xl border border-dashed border-gray-300 p-8 text-center text-sm text-gray-500">
          Пока ни один сервер не прислал отчёт.
        </div>
      )}

      {addresses.length > 0 && (
        <section className="mb-10">
          <h2 className="text-lg font-semibold text-gray-900 mb-1">Кто где живёт</h2>
          <p className="text-sm text-gray-500 mb-3">У каждого клиента свой адрес. Нажмите на строку — домены и ящики.</p>
          <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-gray-500 border-b border-gray-100">
                <tr>
                  <th className="px-4 py-2 font-medium">Кто</th>
                  <th className="px-4 py-2 font-medium text-right">Ящиков</th>
                  <th className="px-4 py-2 font-medium">Адрес</th>
                  <th className="px-4 py-2 font-medium">Сервер</th>
                  <th className="px-4 py-2 font-medium">Состояние</th>
                </tr>
              </thead>
              <tbody>
                {addresses.map((a) => (
                  <Fragment key={a.key}>
                    <tr
                      onClick={() => setOpen(open === a.key ? null : a.key)}
                      className="cursor-pointer border-b border-gray-100 last:border-0 hover:bg-gray-50"
                    >
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-1.5">
                          {open === a.key ? <ChevronDown className="h-4 w-4 text-gray-400" /> : <ChevronRight className="h-4 w-4 text-gray-400" />}
                          <span className={a.kind === 'client' ? 'font-semibold text-gray-900' : 'text-gray-700'}>{a.who}</span>
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-gray-900">{a.boxes}</td>
                      <td className="px-4 py-3 font-mono text-gray-700">{a.ip}</td>
                      <td className="px-4 py-3 text-gray-700">
                        {a.server} <span className="text-gray-400">· {a.where}</span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-2 text-gray-700">
                          <span className={`h-2.5 w-2.5 rounded-full ${DOT[a.state]}`} />
                          {a.stateText}
                        </span>
                      </td>
                    </tr>
                    {open === a.key && (
                      <tr className="border-b border-gray-100 bg-gray-50/70">
                        <td colSpan={5} className="px-10 py-3 text-xs text-gray-600">
                          <div className="mb-2">Обратное имя адреса: <span className="text-gray-900">{a.ptr || '—'}</span></div>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1">
                            {a.domains.map((d) => (
                              <div key={d.domain}>
                                <span className="text-gray-900">{d.domain}</span> — {d.boxes} ящ.
                                {d.paused ? `, на паузе ${d.paused}` : ''}
                                <span className="text-gray-400"> · подключение {d.conn || '—'}</span>
                              </div>
                            ))}
                          </div>
                          {a.tags.length > 0 && (
                            <div className="mt-2">
                              Instantly:{' '}
                              {a.tags.map((t) => `«${t.label}» — подключено ${t.active} из ${t.boxes}, прогрев у ${t.warmup_on}`).join('; ')}
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {rows.length > 0 && (
        <section className="mb-10">
          <h2 className="text-lg font-semibold text-gray-900 mb-3">Серверы</h2>
          <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-gray-500 border-b border-gray-100">
                <tr>
                  <th className="px-4 py-2 font-medium">Сервер</th>
                  <th className="px-4 py-2 font-medium">Где</th>
                  <th className="px-4 py-2 font-medium">Отчёт</th>
                  <th className="px-4 py-2 font-medium">Почта за сутки</th>
                  <th className="px-4 py-2 font-medium">Диск</th>
                  <th className="px-4 py-2 font-medium">Оплачен до</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const s = row.payload.server;
                  const m = row.payload.mail_today;
                  const fresh = freshness(row.received_at, now);
                  return (
                    <tr key={row.server_id} className="border-b border-gray-100 last:border-0">
                      <td className="px-4 py-3 text-gray-900">
                        {s.label}
                        <div className="text-xs text-gray-400">{s.hostname}</div>
                      </td>
                      <td className="px-4 py-3 text-gray-700">{providerOf(row)}</td>
                      <td className="px-4 py-3">
                        <span className={fresh === 'ok' ? 'text-gray-700' : 'font-medium text-red-600'}>{ago(row.received_at, now)}</span>
                      </td>
                      <td className="px-4 py-3 text-gray-700">
                        ушло {m.sent}, пришло {m.delivered_in}
                        {m.bounced_other > 0 && <span className="text-amber-700"> · отказов «спам» {m.bounced_other}</span>}
                      </td>
                      <td className={`px-4 py-3 ${s.disk_used_pct >= 80 ? 'font-medium text-red-600' : 'text-gray-700'}`}>{s.disk_used_pct}%</td>
                      <td className="px-4 py-3 text-gray-700">{s.pay_due || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <details className="rounded-xl border border-gray-200 bg-white p-5 text-sm text-gray-700">
        <summary className="cursor-pointer font-semibold text-gray-900">Как это устроено</summary>
        <ul className="mt-3 space-y-2 list-disc pl-5 leading-relaxed">
          <li>У каждого клиента свой адрес сервера; на одном сервере не больше двух клиентов. Чёрный список одного адреса не задевает остальных.</li>
          <li>Instantly подключается к ящикам по имени пары доменов (pN.&lt;домен сервера&gt;). Пару можно перевезти на другой сервер одной правкой DNS — прогрев не сбрасывается.</li>
          <li>Бот на каждом сервере раз в 15 минут проверяет службы, отказы, диск, чёрные списки, оплату и ящики в Instantly и пишет в Telegram; ошибки подключения в Instantly после простоя снимает сам.</li>
          <li>Каждую ночь с серверов забирается зашифрованная копия (настройки, ключи, ящики, письма), хранится 14 дней; сервер поднимается из неё за несколько минут.</li>
          <li>Новый клиент: домены в Reg.ru → add_domain.sh на сервере → записи DNS → проверки wait_dns_and_test.sh → instantly_add_pending.py с тегом клиента. Скрипты и инструкции — в папке mail-pilot.</li>
        </ul>
      </details>
    </div>
  );
}
