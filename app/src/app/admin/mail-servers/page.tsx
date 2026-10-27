'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ChevronLeft, RefreshCw } from 'lucide-react';
import { MailServersMap } from '@/components/admin/MailServersMap';
import { authFetch } from '@/lib/authFetch';
import { addressRows, type MailServerRow } from '@/lib/mailServers/heartbeat';

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

  const addresses = useMemo(() => addressRows(rows, now), [rows, now]);
  const boxes = addresses.reduce((n, a) => n + (a.kind === 'client' || a.kind === 'ours' ? a.boxes : 0), 0);
  const clients = new Set(addresses.filter((a) => a.kind === 'client').map((a) => a.who)).size;

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <Link href="/admin" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-4">
        <ChevronLeft className="h-4 w-4" /> Админ панель
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Почтовые серверы</h1>
          <p className="text-sm text-gray-500 mt-1">
            {rows.length} серв. · {addresses.length} адр. · {clients} клиентов · {boxes} ящиков в работе · обновляется само каждые 15 минут
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

      {!loading && rows.length === 0 && !error && (
        <div className="mb-6 rounded-xl border border-dashed border-gray-300 p-8 text-center text-sm text-gray-500">
          Пока ни один сервер не прислал отчёт.
        </div>
      )}

      <MailServersMap rows={rows} now={now} />

      <details className="rounded-xl border border-gray-200 bg-white p-5 text-sm text-gray-700">
        <summary className="cursor-pointer font-semibold text-gray-900">Как это устроено</summary>
        <ul className="mt-3 space-y-2 list-disc pl-5 leading-relaxed">
          <li>У каждого клиента свой адрес сервера; на одном сервере не больше двух клиентов. Чёрный список одного адреса не задевает остальных.</li>
          <li>Instantly подключается к ящикам по имени пары доменов (pN.&lt;домен сервера&gt;). Пару можно перевезти на другой сервер одной правкой DNS — прогрев не сбрасывается.</li>
          <li>Бот на каждом сервере раз в 15 минут проверяет службы, отказы, диск, чёрные списки и ящики в Instantly и пишет в Telegram; ошибки подключения в Instantly после простоя снимает сам.</li>
          <li>Каждую ночь с серверов забирается зашифрованная копия (настройки, ключи, ящики, письма), хранится 14 дней; сервер поднимается из неё за несколько минут.</li>
          <li>Новый клиент: домены в Reg.ru → add_domain.sh на сервере → записи DNS → проверки wait_dns_and_test.sh → instantly_add_pending.py с тегом клиента. Скрипты и инструкции — в папке mail-pilot.</li>
        </ul>
      </details>
    </div>
  );
}
