'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ChevronLeft, RefreshCw, Server } from 'lucide-react';
import { authFetch } from '@/lib/authFetch';
import {
  activeAlerts,
  freshness,
  ipClients,
  ipKind,
  providerOf,
  summarize,
  type Freshness,
  type IpKind,
  type MailServerRow,
} from '@/lib/mailServers/heartbeat';

const FRESH_STYLE: Record<Freshness, string> = {
  ok: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  late: 'bg-amber-50 text-amber-700 border-amber-200',
  silent: 'bg-red-50 text-red-700 border-red-200',
};

const KIND_STYLE: Record<IpKind, string> = {
  ours: 'bg-teal-50 text-teal-700 border-teal-200',
  client: 'bg-purple-50 text-purple-700 border-purple-200',
  paused: 'bg-gray-50 text-gray-500 border-gray-300 border-dashed',
  idle: 'bg-gray-50 text-gray-500 border-gray-300 border-dashed',
};

function ago(iso: string, now: Date): string {
  const min = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60_000));
  if (min < 60) return `${min} мин назад`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h} ч назад` : `${Math.floor(h / 24)} дн. назад`;
}

function uptime(s: number): string {
  const d = Math.floor(s / 86_400);
  return d > 0 ? `${d} дн.` : `${Math.floor(s / 3600)} ч`;
}

function kindLabel(kind: IpKind, clients: string[]): string {
  if (kind === 'client') return clients.join(', ') || 'клиент';
  if (kind === 'ours') return 'наши неименные';
  if (kind === 'paused') return 'на паузе';
  return 'пусто';
}

function ServerCard({ row, now }: { row: MailServerRow; now: Date }) {
  const r = row.payload;
  const s = r.server;
  const fresh = freshness(row.received_at, now);
  const down = Object.entries(s.services ?? {}).filter(([, v]) => v !== 'active');
  const alerts = activeAlerts(r);
  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2 mb-3">
        <div>
          <div className="flex items-center gap-2">
            <Server className="h-4 w-4 text-gray-400" />
            <h3 className="text-base font-semibold text-gray-900">{s.label}</h3>
          </div>
          <p className="text-xs text-gray-500 mt-0.5">
            {s.hostname} · работает {uptime(s.uptime_s)}
          </p>
        </div>
        <span className={`text-xs border rounded-full px-2 py-0.5 ${FRESH_STYLE[fresh]}`}>
          {fresh === 'silent' ? 'молчит ' : 'обновлён '}
          {ago(row.received_at, now)}
        </span>
      </div>

      <div className="space-y-2 mb-3">
        {r.ips.map((ip) => {
          const kind = ipKind(ip);
          return (
            <div key={ip.ip} className="rounded-lg border border-gray-100 bg-gray-50/60 p-2.5">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <span className="font-mono text-gray-900">{ip.ip}</span>
                <span className="text-gray-500">{ip.ptr || 'нет PTR'}</span>
                <span className={`ml-auto text-xs border rounded-full px-2 py-0.5 ${KIND_STYLE[kind]}`}>
                  {kindLabel(kind, ipClients(ip))}
                  {kind !== 'idle' ? `, ${ip.domains.reduce((n, d) => n + d.boxes, 0)}` : ''}
                </span>
              </div>
              {ip.domains.length > 0 && (
                <div className="mt-1.5 grid grid-cols-1 gap-0.5 text-xs text-gray-600">
                  {ip.domains.map((d) => (
                    <div key={d.domain} className="flex flex-wrap gap-x-2">
                      <span className="text-gray-800">{d.domain}</span>
                      <span className="text-gray-400">→ {d.conn || '—'}</span>
                      <span>
                        {d.boxes} ящ.
                        {d.paused ? `, на паузе ${d.paused}` : ''}
                        {d.pending ? `, не подключено ${d.pending}` : ''}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 text-xs mb-3">
        <div><dt className="inline text-gray-500">Почта за сутки: </dt><dd className="inline text-gray-900">отправлено {r.mail_today.sent}, принято {r.mail_today.delivered_in}</dd></div>
        <div><dt className="inline text-gray-500">Отказы: </dt><dd className="inline text-gray-900">мёртвые адреса {r.mail_today.bounced_dead}, спам/блок {r.mail_today.bounced_other}</dd></div>
        <div><dt className="inline text-gray-500">Очередь: </dt><dd className="inline text-gray-900">{s.queue}</dd></div>
        <div><dt className="inline text-gray-500">Диск: </dt><dd className="inline text-gray-900">{s.disk_used_pct}%</dd></div>
        <div><dt className="inline text-gray-500">Память: </dt><dd className="inline text-gray-900">{s.mem_used_mb ?? '—'} из {s.mem_total_mb ?? '—'} МБ</dd></div>
        <div><dt className="inline text-gray-500">Сертификат: </dt><dd className="inline text-gray-900">{s.cert_days_left ?? '—'} дн.</dd></div>
        {s.pay_due && <div><dt className="inline text-gray-500">Оплачен до: </dt><dd className="inline text-gray-900">{s.pay_due}</dd></div>}
      </dl>

      {r.instantly.tags.length > 0 && (
        <div className="text-xs text-gray-600 mb-2">
          <span className="text-gray-500">Instantly: </span>
          {r.instantly.tags.map((t) => `«${t.label}» ${t.active} из ${t.boxes} подключены, прогрев у ${t.warmup_on}`).join('; ')}
          {r.instantly.error && <span className="text-red-600"> · не удалось проверить: {r.instantly.error}</span>}
        </div>
      )}

      {(down.length > 0 || r.dnsbl.listed.length > 0 || alerts.length > 0) && (
        <div className="rounded-lg border border-red-100 bg-red-50/60 p-2.5 text-xs text-red-800 space-y-1">
          {down.map(([name, state]) => (
            <div key={name}>Служба {name}: {state || 'не отвечает'}</div>
          ))}
          {r.dnsbl.listed.map((l) => (
            <div key={l.name + l.result}>В чёрном списке: {l.name} — {l.result}</div>
          ))}
          {alerts.map((a) => (
            <div key={a.key}>
              {a.text || a.key}
              {a.since ? ` (с ${a.since.slice(0, 16).replace('T', ' ')} UTC)` : ''}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function AdminMailServersPage() {
  const [rows, setRows] = useState<MailServerRow[]>([]);
  const [now, setNow] = useState(() => new Date());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

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

  const summary = useMemo(() => summarize(rows, now), [rows, now]);
  const groups = useMemo(() => {
    const map = new Map<string, MailServerRow[]>();
    for (const row of rows) {
      const key = providerOf(row);
      map.set(key, [...(map.get(key) ?? []), row]);
    }
    return [...map.entries()];
  }, [rows]);

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <Link href="/admin" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-4">
        <ChevronLeft className="h-4 w-4" /> Админ панель
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-2">
        <h1 className="text-2xl font-bold text-gray-900">Почтовые серверы</h1>
        <button
          type="button"
          onClick={() => void load()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Обновить
        </button>
      </div>
      <p className="text-sm text-gray-500 mb-6">
        Свои почтовые серверы для ящиков в Instantly. Каждый сервер сам присылает состояние раз в 15 минут; молчит
        дольше часа — значит, сломался он сам или связь с ним.
      </p>

      {error && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <AlertTriangle className="h-4 w-4" /> {error}
        </div>
      )}

      {rows.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-6 text-sm">
          <span className="rounded-lg border border-gray-200 bg-white px-3 py-1">Серверов: <b>{summary.servers}</b>{summary.silent ? <span className="text-red-600">, молчат {summary.silent}</span> : null}</span>
          <span className="rounded-lg border border-gray-200 bg-white px-3 py-1">Адресов: <b>{summary.ips}</b></span>
          <span className="rounded-lg border border-gray-200 bg-white px-3 py-1">Ящиков: наших <b>{summary.boxesOurs}</b>, клиентов <b>{summary.boxesClients}</b>, на паузе <b>{summary.boxesPaused}</b></span>
          <span className={`rounded-lg border px-3 py-1 ${summary.alerts || summary.listed ? 'border-red-200 bg-red-50 text-red-700' : 'border-gray-200 bg-white'}`}>
            Тревог: <b>{summary.alerts}</b>, в чёрных списках: <b>{summary.listed}</b>
          </span>
        </div>
      )}

      {!loading && rows.length === 0 && !error && (
        <div className="rounded-xl border border-dashed border-gray-300 p-8 text-center text-sm text-gray-500 mb-6">
          Пока ни один сервер не прислал отчёт.
        </div>
      )}

      {groups.map(([provider, list]) => (
        <section key={provider} className="mb-8">
          <h2 className="text-lg font-semibold text-gray-900 mb-3">{provider}</h2>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {list.map((row) => <ServerCard key={row.server_id} row={row} now={now} />)}
          </div>
        </section>
      ))}

      <section className="bg-white rounded-xl border border-gray-200 p-5 text-sm text-gray-700 leading-relaxed space-y-3">
        <h2 className="text-lg font-semibold text-gray-900">Как это устроено</h2>
        <p>
          <b>Изоляция.</b> У каждого клиента свой адрес сервера (на одном сервере — до двух клиентов, каждый на своём IP),
          у каждого сервера свой служебный домен для обратного имени (mx1.&lt;домен&gt;). Чёрный список одного адреса или
          домена не задевает остальных.
        </p>
        <p>
          <b>Имена подключения.</b> Instantly подключается к ящикам не по адресу сервера, а по имени пары доменов
          (pN.&lt;служебный домен&gt;). Пару можно перевезти на другой сервер одной правкой A-записи — прогрев в Instantly
          не сбрасывается. Срок жизни записей в DNS — 1 час.
        </p>
        <p>
          <b>Тревоги.</b> На каждом сервере бот (pilot-alert.py) раз в 15 минут проверяет службы, отказы, очередь, диск,
          сертификат, чёрные списки, оплату и ящики в Instantly; ошибки подключения в Instantly после простоя снимает сам.
          Из московского дата-центра Telegram недоступен, поэтому тревоги в бот пересылает внешний сервер.
        </p>
        <p>
          <b>Резервные копии.</b> Каждую ночь внешний сервер забирает с каждого сервера зашифрованный архив (настройки,
          ключи DKIM, ящики, письма), хранит 14 дней. Ключ расшифровки — только у владельца. Восстановление проверено:
          сервер поднимается из архива за несколько минут.
        </p>
        <p>
          <b>Новый клиент.</b> Домены покупаются в Reg.ru; на сервере add_domain.sh &lt;домен&gt; &lt;IP&gt; &lt;ящики&gt;,
          записи DNS через API Reg.ru, проверки wait_dns_and_test.sh (DKIM, приём, SPF/DKIM снаружи, чёрные списки),
          подключение к Instantly instantly_add_pending.py с тегом клиента. Скрипты и инструкции — папка mail-pilot.
        </p>
      </section>
    </div>
  );
}
