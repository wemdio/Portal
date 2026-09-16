'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, RefreshCw, Trash2, Upload } from 'lucide-react';
import {
  deleteMailbox,
  fetchMailboxes,
  importMailboxes,
  patchMailbox,
  type ImportMailboxesResult,
  type MailboxDto,
} from './api';

const PROVIDERS = [
  { id: 'maildoso', label: 'Maildoso' },
  { id: 'zapmail', label: 'ZapMail' },
  { id: 'google', label: 'Google Workspace' },
  { id: 'custom', label: 'Другой' },
];

const STATUS_LABELS: Record<MailboxDto['status'], { text: string; className: string }> = {
  pending: { text: 'Проверяется', className: 'bg-amber-100 text-amber-700' },
  verified: { text: 'Готов', className: 'bg-emerald-100 text-emerald-700' },
  failed: { text: 'Ошибка', className: 'bg-red-100 text-red-700' },
  disabled: { text: 'Выключен', className: 'bg-zinc-100 text-zinc-600' },
};

const PAGE_SIZE = 30;

export function MailboxesTab() {
  const [mailboxes, setMailboxes] = useState<MailboxDto[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [provider, setProvider] = useState('maildoso');
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<ImportMailboxesResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async (targetPage: number) => {
    try {
      const { mailboxes: rows, total: count } = await fetchMailboxes(targetPage);
      setMailboxes(rows);
      setTotal(count);
      // Строку удалили и страница стала пустой — откатываемся к предыдущей.
      if (rows.length === 0 && count > 0 && targetPage > 1) {
        setPage(Math.max(1, Math.ceil(count / PAGE_SIZE)));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить ящики');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(page);
  }, [load, page]);

  useEffect(() => {
    // Ящики после загрузки проверяются воркером — подтягиваем статусы, пока
    // есть хоть один в очереди на проверку. Сортировка по email стабильна,
    // поэтому опрос больше дёргает строки местами.
    const timer = window.setInterval(() => void load(page), 15_000);
    return () => window.clearInterval(timer);
  }, [load, page]);

  const maxPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const handleUpload = async (file: File) => {
    setUploading(true);
    setError(null);
    setResult(null);
    try {
      setResult(await importMailboxes(file, provider));
      await load(page);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить файл');
    } finally {
      setUploading(false);
    }
  };

  const act = async (id: string, body: Record<string, unknown>) => {
    await patchMailbox(id, body);
    await load(page);
  };

  const remove = async (mailbox: MailboxDto) => {
    if (!window.confirm(`Убрать ящик ${mailbox.email} из инструмента?`)) return;
    await deleteMailbox(mailbox.id);
    await load(page);
  };

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-zinc-200 bg-white p-5">
        <h2 className="text-base font-semibold text-zinc-900">Подключить ящики файлом</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Выгрузка провайдера как есть: CSV или XLSX. Колонки распознаются сами. После загрузки каждый ящик
          проверяется на вход по SMTP и IMAP — до проверки он в рассылку не идёт.
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900"
          >
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
          >
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            {uploading ? 'Загружаю…' : 'Выбрать файл'}
          </button>

          <input
            ref={fileRef}
            type="file"
            accept=".csv,.tsv,.xlsx,.xls"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleUpload(file);
              e.target.value = '';
            }}
          />
        </div>

        {result ? (
          <div className="mt-4 rounded-lg bg-zinc-50 p-3 text-sm">
            <p className="text-zinc-900">Подключено ящиков: {result.imported}</p>
            {result.errors.length ? (
              <ul className="mt-2 space-y-1 text-zinc-600">
                {/* line === null — сломан файл целиком: подпись «Строка N» тут
                    отправила бы искать проблему в данных, хотя она в заголовках. */}
                {result.errors.slice(0, 10).map((row, index) => (
                  <li key={`${row.line ?? 'file'}-${row.email ?? ''}-${index}`}>
                    {row.line === null
                      ? row.message
                      : `Строка ${row.line}${row.email ? ` (${row.email})` : ''}: ${row.message}`}
                  </li>
                ))}
                {result.errors.length > 10 ? <li>…и ещё {result.errors.length - 10}</li> : null}
              </ul>
            ) : null}
          </div>
        ) : null}

        {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}
      </div>

      <div className="rounded-xl border border-zinc-200 bg-white">
        <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3">
          <h2 className="text-base font-semibold text-zinc-900">Ящики ({total})</h2>
          <button
            type="button"
            onClick={() => void load(page)}
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Обновить
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center gap-2 px-5 py-10 text-sm text-zinc-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            Загрузка…
          </div>
        ) : mailboxes.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-zinc-500">Ящиков пока нет — загрузите выгрузку провайдера.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-zinc-500">
                <tr className="border-b border-zinc-200">
                  <th className="px-5 py-2 font-medium">Ящик</th>
                  <th className="px-3 py-2 font-medium">Статус</th>
                  <th className="px-3 py-2 font-medium">Лимит/день</th>
                  <th className="px-3 py-2 font-medium">SMTP</th>
                  <th className="px-3 py-2 font-medium">IMAP</th>
                  <th className="px-5 py-2" />
                </tr>
              </thead>
              <tbody>
                {mailboxes.map((mailbox) => {
                  const status = STATUS_LABELS[mailbox.status];
                  return (
                    <tr key={mailbox.id} className="border-b border-zinc-100 last:border-0">
                      <td className="px-5 py-2.5">
                        <div className="font-medium text-zinc-900">{mailbox.email}</div>
                        {mailbox.last_error ? (
                          <div className="mt-0.5 text-xs text-amber-600">{mailbox.last_error}</div>
                        ) : null}
                      </td>
                      <td className="px-3 py-2.5">
                        <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${status.className}`}>
                          {status.text}
                        </span>
                      </td>
                      <td className="px-3 py-2.5">
                        <input
                          type="number"
                          min={1}
                          max={500}
                          defaultValue={mailbox.daily_campaign_limit}
                          onBlur={(e) => {
                            const next = Number(e.target.value);
                            if (next && next !== mailbox.daily_campaign_limit) {
                              void act(mailbox.id, { dailyCampaignLimit: next });
                            }
                          }}
                          className="w-16 rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm text-zinc-900"
                        />
                      </td>
                      <td className="px-3 py-2.5 text-zinc-600">
                        {mailbox.smtp_host}:{mailbox.smtp_port}
                      </td>
                      <td className="px-3 py-2.5 text-zinc-600">
                        {mailbox.imap_host ? `${mailbox.imap_host}:${mailbox.imap_port}` : '—'}
                      </td>
                      <td className="px-5 py-2.5">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => void act(mailbox.id, { action: 'recheck' })}
                            className="rounded-md px-2 py-1 text-xs text-blue-600 hover:bg-zinc-100"
                          >
                            Проверить
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              void act(mailbox.id, { action: mailbox.status === 'disabled' ? 'enable' : 'disable' })
                            }
                            className="rounded-md px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100"
                          >
                            {mailbox.status === 'disabled' ? 'Включить' : 'Выключить'}
                          </button>
                          <button
                            type="button"
                            onClick={() => void remove(mailbox)}
                            aria-label="Убрать ящик"
                            className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-red-600"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {total > PAGE_SIZE ? (
          <div className="flex items-center justify-between border-t border-zinc-200 px-5 py-3 text-sm">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="rounded-md px-3 py-1.5 text-zinc-700 hover:bg-zinc-100 disabled:opacity-40"
            >
              ← Назад
            </button>
            <span className="text-zinc-500">
              Стр. {page} из {maxPage} · {total} ящиков
            </span>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(maxPage, p + 1))}
              disabled={page >= maxPage}
              className="rounded-md px-3 py-1.5 text-zinc-700 hover:bg-zinc-100 disabled:opacity-40"
            >
              Вперёд →
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
