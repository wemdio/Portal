'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, BookOpen, Copy, Download, KeyRound, Plus, RefreshCw, ScrollText, X } from 'lucide-react';
import { authFetch } from '@/lib/authFetch';

interface BenchKey {
  id: string;
  name: string;
  key_last4: string;
  allowed_tools: string[];
  rpm_limit: number;
  daily_jobs_limit: number;
  daily_rows_limit: number;
  max_active_jobs: number;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

interface ToolInfo {
  id: string;
  kind: 'job' | 'search';
  title: string;
  stop_supported: boolean;
}

interface LogEntry {
  id: number;
  tool: string | null;
  action: string;
  status_code: number;
  rows_returned: number;
  duration_ms: number;
  created_at: string;
}

const DEFAULTS = {
  rpm_limit: 60,
  daily_jobs_limit: 50,
  daily_rows_limit: 200_000,
  max_active_jobs: 3,
};

function formatDateTime(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function statusBadge(code: number) {
  if (code < 300) return 'bg-emerald-50 text-emerald-700 border-emerald-200';
  if (code === 429) return 'bg-amber-50 text-amber-700 border-amber-200';
  return 'bg-red-50 text-red-700 border-red-200';
}

export default function BenchKeysPage() {
  const [keys, setKeys] = useState<BenchKey[]>([]);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [issuing, setIssuing] = useState(false);
  const [form, setForm] = useState({ name: '', tools: [] as string[], ...DEFAULTS });
  const [issuedKey, setIssuedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [logFor, setLogFor] = useState<BenchKey | null>(null);
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [logLoading, setLogLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await authFetch('/api/admin/bench-keys');
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? 'Не удалось загрузить ключи');
      setKeys(body.keys ?? []);
      setTools(body.tools ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось загрузить ключи');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toolTitles = useMemo(
    () => new Map(tools.map((t) => [t.id, t.title])),
    [tools],
  );

  const canIssue = form.name.trim().length > 0 && form.tools.length > 0;

  async function issue() {
    if (!canIssue) return;
    setIssuing(true);
    setError(null);
    try {
      const res = await authFetch('/api/admin/bench-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, name: form.name.trim() }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? 'Не удалось выдать ключ');
      setIssuedKey(body.key);
      setForm({ name: '', tools: [], ...DEFAULTS });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось выдать ключ');
    } finally {
      setIssuing(false);
    }
  }

  async function revoke(key: BenchKey) {
    const confirmed = window.confirm(
      `Отозвать ключ «${key.name}»? Он перестанет работать со следующего же запроса. Отменить отзыв нельзя — потребуется выдать новый ключ.`,
    );
    if (!confirmed) return;
    try {
      const res = await authFetch(`/api/admin/bench-keys/${key.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'revoke' }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? 'Не удалось отозвать ключ');
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось отозвать ключ');
    }
  }

  async function openLog(key: BenchKey) {
    setLogFor(key);
    setLogLoading(true);
    setLogEntries([]);
    try {
      const res = await authFetch(`/api/admin/bench-keys/${key.id}`);
      const body = await res.json();
      if (res.ok) setLogEntries(body.entries ?? []);
    } finally {
      setLogLoading(false);
    }
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <KeyRound className="w-6 h-6" />
            API портала
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Программный доступ к нашим инструментам — для своих автоматизаций,
            подрядчиков и сервисов. Каждый ключ видит только свои задачи и
            только открытые ему инструменты.
          </p>
        </div>
        <button
          onClick={() => void load()}
          className="p-2 rounded-lg border border-gray-200 hover:bg-gray-50"
          title="Обновить"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Документ лежит в app/public и едет в образ вместе с приложением —
          то есть здесь всегда та версия, что в выкаченной ветке, а не копия,
          которую забыли обновить. Ссылка ведёт на статику портала, поэтому
          её видят только сотрудники: middleware гейтит и статические пути. */}
      <div className="mb-8 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-200 bg-gray-50 p-4">
        <div>
          <p className="font-medium text-sm">Документация</p>
          <p className="text-sm text-gray-500">
            Все ручки, инструменты, коды ошибок, лимиты и примеры на curl и Python.
            Отдаётся текущая версия из выкаченной ветки.
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <a
            href="/api-portal.md"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm hover:bg-gray-50"
          >
            <BookOpen className="w-3.5 h-3.5" />
            Открыть
          </a>
          <a
            href="/api-portal.md"
            download="API Portal.md"
            className="inline-flex items-center gap-1.5 rounded-lg bg-gray-900 px-3 py-1.5 text-sm text-white hover:bg-gray-800"
          >
            <Download className="w-3.5 h-3.5" />
            Скачать
          </a>
        </div>
      </div>

      {/* Ключ показывается ровно один раз: в базе лежит только его отпечаток,
          восстановить его потом неоткуда. */}
      {issuedKey && (
        <div className="mb-6 rounded-lg border border-emerald-200 bg-emerald-50 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-medium text-emerald-900">
                Ключ выдан. Скопируйте его сейчас — второй раз он не покажется.
              </p>
              <p className="text-xs text-emerald-800 mt-1">
                В базе хранится только отпечаток, восстановить ключ невозможно.
                Если потеряется — выдайте новый, а этот отзовите.
              </p>
              <code className="mt-3 block break-all rounded bg-white px-3 py-2 font-mono text-sm border border-emerald-200">
                {issuedKey}
              </code>
            </div>
            <div className="flex flex-col gap-2 shrink-0">
              <button
                onClick={() => {
                  void navigator.clipboard.writeText(issuedKey);
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 2000);
                }}
                className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm text-white hover:bg-emerald-700"
              >
                <Copy className="w-3.5 h-3.5" />
                {copied ? 'Скопировано' : 'Копировать'}
              </button>
              <button
                onClick={() => setIssuedKey(null)}
                className="rounded-lg border border-emerald-300 px-3 py-1.5 text-sm text-emerald-800 hover:bg-emerald-100"
              >
                Скрыть
              </button>
            </div>
          </div>
        </div>
      )}

      <section className="mb-8 rounded-lg border border-gray-200 p-4">
        <h2 className="font-medium mb-3 flex items-center gap-2">
          <Plus className="w-4 h-4" />
          Выдать ключ
        </h2>

        <label className="block text-sm mb-1 text-gray-600">Кому выдаём</label>
        <input
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          placeholder="Например: Дима — парсеры"
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm mb-4"
        />

        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-gray-600">
            Инструменты — ключ не увидит ничего, кроме отмеченного
          </p>
          {/* Подрядчику чаще открывают весь набор, чем два инструмента из
              четырнадцати, а отмечать их приходилось по одному. Промежуточное
              состояние показываем полоской: галочка, стоящая при трёх
              отмеченных из четырнадцати, читалась бы как «открыто всё». */}
          <label className="flex shrink-0 cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm text-gray-600 hover:bg-gray-50">
            <input
              type="checkbox"
              ref={(el) => {
                if (el) el.indeterminate = form.tools.length > 0 && form.tools.length < tools.length;
              }}
              checked={tools.length > 0 && form.tools.length === tools.length}
              onChange={(e) =>
                setForm((f) => ({ ...f, tools: e.target.checked ? tools.map((t) => t.id) : [] }))
              }
            />
            <span>Все инструменты</span>
            <span className="text-xs text-gray-400">
              выбрано {form.tools.length} из {tools.length}
            </span>
          </label>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1 mb-4">
          {tools.map((tool) => (
            <label
              key={tool.id}
              className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-gray-50 cursor-pointer"
            >
              <input
                type="checkbox"
                checked={form.tools.includes(tool.id)}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    tools: e.target.checked
                      ? [...f.tools, tool.id]
                      : f.tools.filter((t) => t !== tool.id),
                  }))
                }
              />
              <span>{tool.title}</span>
              <span className="text-xs text-gray-400">
                {tool.kind === 'job' ? 'задача' : 'поиск'}
                {tool.kind === 'job' && !tool.stop_supported ? ' · без остановки' : ''}
              </span>
            </label>
          ))}
        </div>

        <p className="text-sm text-gray-600 mb-2">
          Лимиты — они и не дают чужому скрипту выжечь прокси и бюджет
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          {(
            [
              ['rpm_limit', 'Запросов в минуту'],
              ['daily_jobs_limit', 'Задач в сутки'],
              ['daily_rows_limit', 'Строк в сутки'],
              ['max_active_jobs', 'Задач одновременно'],
            ] as const
          ).map(([field, label]) => (
            <div key={field}>
              <label className="block text-xs text-gray-500 mb-1">{label}</label>
              <input
                type="number"
                min={0}
                value={form[field]}
                onChange={(e) =>
                  setForm((f) => ({ ...f, [field]: Number(e.target.value) || 0 }))
                }
                className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
              />
            </div>
          ))}
        </div>

        <button
          onClick={() => void issue()}
          disabled={!canIssue || issuing}
          className="rounded-lg bg-gray-900 px-4 py-2 text-sm text-white disabled:opacity-40"
        >
          {issuing ? 'Выдаём…' : 'Выдать ключ'}
        </button>
      </section>

      <section>
        <h2 className="font-medium mb-3">Выданные ключи</h2>
        {loading && keys.length === 0 ? (
          <p className="text-sm text-gray-500">Загрузка…</p>
        ) : keys.length === 0 ? (
          <p className="text-sm text-gray-500">Ключей пока нет.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-gray-200">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
                <tr>
                  <th className="px-3 py-2">Кому</th>
                  <th className="px-3 py-2">Ключ</th>
                  <th className="px-3 py-2">Инструменты</th>
                  <th className="px-3 py-2">Лимиты</th>
                  <th className="px-3 py-2">Последний раз</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {keys.map((key) => (
                  <tr key={key.id} className={key.revoked_at ? 'opacity-50' : ''}>
                    <td className="px-3 py-2">
                      <div className="font-medium">{key.name}</div>
                      <div className="text-xs text-gray-400">
                        выдан {formatDateTime(key.created_at)}
                      </div>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">
                      …{key.key_last4}
                      {key.revoked_at && (
                        <div className="mt-1 inline-block rounded border border-red-200 bg-red-50 px-1.5 py-0.5 text-[11px] text-red-700">
                          отозван
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-600 max-w-xs">
                      {key.allowed_tools.map((t) => toolTitles.get(t) ?? t).join(', ')}
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-500 whitespace-nowrap">
                      {key.rpm_limit}/мин · {key.daily_jobs_limit} задач
                      <br />
                      {key.daily_rows_limit.toLocaleString('ru-RU')} строк · {key.max_active_jobs} разом
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-500 whitespace-nowrap">
                      {formatDateTime(key.last_used_at)}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-right">
                      <button
                        onClick={() => void openLog(key)}
                        className="mr-2 inline-flex items-center gap-1 rounded border border-gray-200 px-2 py-1 text-xs hover:bg-gray-50"
                      >
                        <ScrollText className="w-3 h-3" />
                        Журнал
                      </button>
                      {!key.revoked_at && (
                        <button
                          onClick={() => void revoke(key)}
                          className="rounded border border-red-200 px-2 py-1 text-xs text-red-700 hover:bg-red-50"
                        >
                          Отозвать
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {logFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="max-h-[80vh] w-full max-w-3xl overflow-hidden rounded-lg bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
              <h3 className="font-medium">Журнал — {logFor.name}</h3>
              <button onClick={() => setLogFor(null)} className="p-1 hover:bg-gray-100 rounded">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="max-h-[65vh] overflow-y-auto">
              {logLoading ? (
                <p className="p-4 text-sm text-gray-500">Загрузка…</p>
              ) : logEntries.length === 0 ? (
                <p className="p-4 text-sm text-gray-500">Обращений пока не было.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-gray-50 text-left text-xs uppercase text-gray-500">
                    <tr>
                      <th className="px-3 py-2">Когда</th>
                      <th className="px-3 py-2">Инструмент</th>
                      <th className="px-3 py-2">Действие</th>
                      <th className="px-3 py-2">Ответ</th>
                      <th className="px-3 py-2">Строк</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {logEntries.map((entry) => (
                      <tr key={entry.id}>
                        <td className="px-3 py-1.5 text-xs whitespace-nowrap">
                          {formatDateTime(entry.created_at)}
                        </td>
                        <td className="px-3 py-1.5 text-xs">{entry.tool ?? '—'}</td>
                        <td className="px-3 py-1.5 text-xs font-mono">{entry.action}</td>
                        <td className="px-3 py-1.5">
                          <span
                            className={`rounded border px-1.5 py-0.5 text-[11px] ${statusBadge(entry.status_code)}`}
                          >
                            {entry.status_code}
                          </span>
                        </td>
                        <td className="px-3 py-1.5 text-xs">{entry.rows_returned}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
