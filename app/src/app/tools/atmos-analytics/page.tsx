'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import { Download, Loader2, MessageCircle, Users, FileSpreadsheet } from 'lucide-react';


type AtmosChat = {
  chat_id: number;
  chat_title: string;
  chat_username: string | null;
};

type AtmosMessage = {
  chat_id: number;
  message_id: number;
  sender_id: number;
  sender_name: string;
  text: string;
  sent_at: string;
};

export default function AtmosAnalyticsPage() {
  const pathname = usePathname();
  const isAdminRoute = pathname?.startsWith('/admin');
  const [chats, setChats] = useState<AtmosChat[]>([]);
  const [selectedChatId, setSelectedChatId] = useState<number | ''>('');
  const [from, setFrom] = useState<string>('');
  const [to, setTo] = useState<string>('');
  const [_loadingChats, setLoadingChats] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [messages, setMessages] = useState<AtmosMessage[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Load chats on mount
  useEffect(() => {
    async function loadChats() {
      setLoadingChats(true);
      setError(null);
      const { data, error } = await supabase
        .from('tg_atmos_chat_state')
        .select('chat_id, chat_title, chat_username')
        .order('chat_title', { ascending: true });

      if (error) {
        setError(error.message);
      } else {
        setChats(data ?? []);
      }
      setLoadingChats(false);
    }

    void loadChats();
  }, []);

  async function loadMessages() {
    if (!selectedChatId) return;
    setLoadingMessages(true);
    setError(null);

    let query = supabase
      .from('tg_atmos_messages')
      .select('chat_id, message_id, sender_id, sender_name, text, sent_at')
      .eq('chat_id', selectedChatId)
      .order('sent_at', { ascending: true })
      .limit(2000);

    if (from) {
      query = query.gte('sent_at', from);
    }
    if (to) {
      query = query.lte('sent_at', to);
    }

    const { data, error } = await query;
    if (error) {
      setError(error.message);
    } else {
      setMessages(data ?? []);
    }
    setLoadingMessages(false);
  }

  const perUserStats = useMemo(() => {
    const map = new Map<number, { sender_name: string; count: number }>();
    for (const m of messages) {
      const existing = map.get(m.sender_id);
      if (existing) {
        existing.count += 1;
      } else {
        map.set(m.sender_id, { sender_name: m.sender_name, count: 1 });
      }
    }
    return Array.from(map.entries())
      .map(([sender_id, v]) => ({ sender_id, ...v }))
      .sort((a, b) => b.count - a.count);
  }, [messages]);

  function getExportTimestamp(): string {
    const d = new Date();
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = String(d.getFullYear()).slice(-2);
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    return `${day}_${month}_${year}_${hours}${minutes}`;
  }

  function exportCsv() {
    if (!messages.length) return;
    const header = ['chat_id', 'message_id', 'sender_id', 'sender_name', 'sent_at', 'text'];
    const rows = messages.map((m) => [
      m.chat_id,
      m.message_id,
      m.sender_id,
      m.sender_name.replace(/"/g, '""'),
      m.sent_at,
      m.text.replace(/"/g, '""'),
    ]);

    const csv =
      [header.join(',')]
        .concat(rows.map((r) => r.map((v) => `"${String(v)}"`).join(',')))
        .join('\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `atmos_messages_${getExportTimestamp()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function exportExcel() {
    if (!messages.length) return;

    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Messages');

    sheet.columns = [
      { header: 'Chat ID', key: 'chat_id' },
      { header: 'Message ID', key: 'message_id' },
      { header: 'Sender ID', key: 'sender_id' },
      { header: 'Sender name', key: 'sender_name' },
      { header: 'Sent at (UTC)', key: 'sent_at' },
      { header: 'Text', key: 'text' },
    ];

    messages.forEach((m) => {
      sheet.addRow({
        chat_id: m.chat_id,
        message_id: m.message_id,
        sender_id: m.sender_id,
        sender_name: m.sender_name,
        sent_at: m.sent_at,
        text: m.text,
      });
    });

    // Auto-fit column widths (ограничим, чтобы не разъезжалось)
    sheet.columns.forEach((col) => {
      if (!col?.eachCell) return;
      let maxLength = (col.header?.toString().length ?? 10) + 2;
      col.eachCell({ includeEmpty: false }, (cell) => {
        const v = cell.value;
        const len = v ? v.toString().length : 0;
        if (len + 2 > maxLength) {
          maxLength = len + 2;
        }
      });
      col.width = Math.min(Math.max(maxLength, 12), 60);
    });

    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `atmos_messages_${getExportTimestamp()}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6">
      {isAdminRoute && (
        <div>
          <Link href="/admin" className="text-sm font-medium text-blue-600 hover:text-blue-700">
            ← Назад в админку
          </Link>
        </div>
      )}
      <header>
        <h1 className="text-2xl font-bold text-gray-900">Atmos-аналитика</h1>
        <p className="mt-1 text-sm text-gray-500">
          История переписок из Atmos-bot. Выберите чат и период, чтобы посмотреть сообщения и статистику по
          специалистам. Для глубокого анализа выгрузите CSV или Excel.
        </p>
      </header>

      <section className="flex flex-wrap items-end gap-4 rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <div className="flex min-w-[220px] flex-col gap-1">
          <label className="text-xs font-medium text-gray-500">Чат</label>
          <select
            className="h-9 rounded-lg border border-gray-300 bg-white px-3 text-sm focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
            value={selectedChatId === '' ? '' : String(selectedChatId)}
            onChange={(e) => setSelectedChatId(e.target.value ? Number(e.target.value) : '')}
          >
            <option value="">Выберите чат…</option>
            {chats.map((c) => (
              <option key={c.chat_id} value={c.chat_id}>
                {c.chat_title || c.chat_username || c.chat_id}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-gray-500">С (UTC)</label>
          <input
            type="datetime-local"
            className="h-9 rounded-lg border border-gray-300 bg-white px-3 text-sm focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-gray-500">По (UTC)</label>
          <input
            type="datetime-local"
            className="h-9 rounded-lg border border-gray-300 bg-white px-3 text-sm focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>

        <button
          type="button"
          onClick={loadMessages}
          disabled={!selectedChatId || loadingMessages}
          title="Загрузить историю сообщений из выбранного чата за указанный период"
          className="inline-flex h-9 items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 disabled:opacity-60"
        >
          {loadingMessages ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageCircle className="h-4 w-4" />}
          Загрузить сообщения
        </button>

        <button
          type="button"
          onClick={exportCsv}
          disabled={!messages.length}
          title="Скачать текущую выборку сообщений в CSV для анализа или отчётов"
          className="inline-flex h-9 items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 disabled:opacity-60"
        >
          <Download className="h-4 w-4" />
          Экспорт CSV
        </button>

        <button
          type="button"
          onClick={exportExcel}
          disabled={!messages.length}
          title="Скачать текущую выборку сообщений в виде Excel-таблицы с колонками"
          className="inline-flex h-9 items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 disabled:opacity-60"
        >
          <FileSpreadsheet className="h-4 w-4" />
          Экспорт Excel
        </button>
      </section>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      <section className="grid gap-6 md:grid-cols-[2fr,1fr]">
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-900">
              <MessageCircle className="h-4 w-4 text-blue-600" />
              Сообщения ({messages.length})
            </h2>
          </div>
          <div className="max-h-[420px] overflow-auto">
            <table className="w-full border-collapse text-xs">
              <thead className="sticky top-0 bg-gray-50">
                <tr>
                  <th className="border border-gray-200 px-3 py-2 text-left font-medium text-gray-700">Время</th>
                  <th className="border border-gray-200 px-3 py-2 text-left font-medium text-gray-700">Отправитель</th>
                  <th className="border border-gray-200 px-3 py-2 text-left font-medium text-gray-700">ID</th>
                  <th className="border border-gray-200 px-3 py-2 text-left font-medium text-gray-700">Текст</th>
                </tr>
              </thead>
              <tbody>
                {messages.map((m) => (
                  <tr key={m.message_id} className="hover:bg-gray-50/50">
                    <td className="border border-gray-200 px-3 py-2 align-top text-gray-900">
                      {new Date(m.sent_at).toLocaleString('ru-RU', { hour12: false })}
                    </td>
                    <td className="border border-gray-200 px-3 py-2 align-top text-gray-900">{m.sender_name}</td>
                    <td className="border border-gray-200 px-3 py-2 align-top text-gray-600">{m.sender_id}</td>
                    <td className="border border-gray-200 px-3 py-2 align-top max-w-[360px] text-gray-900">
                      <span className="line-clamp-3 whitespace-pre-wrap">{m.text}</span>
                    </td>
                  </tr>
                ))}
                {!messages.length && (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center text-sm text-gray-500">
                      Нет данных. Выберите чат и период, затем нажмите «Загрузить сообщения».
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-900">
              <Users className="h-4 w-4 text-blue-600" />
              Статистика
            </h2>
          </div>
          <div className="max-h-[420px] overflow-auto">
            <table className="w-full border-collapse text-xs">
              <thead className="sticky top-0 bg-gray-50">
                <tr>
                  <th className="border border-gray-200 px-3 py-2 text-left font-medium text-gray-700">Пользователь</th>
                  <th className="border border-gray-200 px-3 py-2 text-left font-medium text-gray-700">ID</th>
                  <th className="border border-gray-200 px-3 py-2 text-right font-medium text-gray-700">Сообщений</th>
                </tr>
              </thead>
              <tbody>
                {perUserStats.map((u) => (
                  <tr key={u.sender_id} className="hover:bg-gray-50/50">
                    <td className="border border-gray-200 px-3 py-2 align-top text-gray-900">{u.sender_name}</td>
                    <td className="border border-gray-200 px-3 py-2 align-top text-gray-600">{u.sender_id}</td>
                    <td className="border border-gray-200 px-3 py-2 align-top text-right text-gray-900">{u.count}</td>
                  </tr>
                ))}
                {!perUserStats.length && (
                  <tr>
                    <td colSpan={3} className="px-4 py-8 text-center text-sm text-gray-500">
                      Данных пока нет.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  );
}

