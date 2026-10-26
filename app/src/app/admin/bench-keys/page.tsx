'use client';

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, BarChart3, BookOpen, Ban, ChevronDown, ChevronRight, Copy, Download, KeyRound, Pencil, Plus, RefreshCw, ScrollText, X } from 'lucide-react';
import { authFetch } from '@/lib/authFetch';
import { RowActionsMenu, type RowAction } from '@/components/sender/RowActionsMenu';

interface BenchKeyUsage {
  requests_last_minute: number;
  jobs_today: number;
  rows_today: number;
}

interface ToolDayUsage {
  tool: string | null;
  requests: number;
  jobs: number;
  rows: number;
  limited: number;
  errors: number;
}

interface DayUsage {
  date: string;
  jobs: number;
  rows: number;
  requests: number;
  peak_per_minute: number;
  limited: number;
  errors: number;
  tools: ToolDayUsage[];
}

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
  usage: BenchKeyUsage;
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

type Limits = typeof DEFAULTS;

const LIMIT_FIELDS = [
  ['rpm_limit', 'Запросов в минуту'],
  ['daily_jobs_limit', 'Задач в сутки'],
  ['daily_rows_limit', 'Строк в сутки'],
  ['max_active_jobs', 'Задач одновременно'],
] as const;

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

/** Доля израсходованного, 0-100. Нулевой лимит трактуем как «не задан». */
function pct(used: number, limit: number): number {
  if (!limit || limit <= 0) return 0;
  return Math.min(100, Math.round((used / limit) * 100));
}

/**
 * Цвет полосы. Порог в 80% — чтобы упор в потолок было видно ДО того, как
 * ключ начнёт получать отказы, а не после.
 */
function usageTone(used: number, limit: number): string {
  const p = pct(used, limit);
  if (p >= 100) return 'bg-red-500';
  if (p >= 80) return 'bg-amber-500';
  return 'bg-emerald-500';
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

  const [issueOpen, setIssueOpen] = useState(false);
  const [issueError, setIssueError] = useState<string | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [form, setForm] = useState({ name: '', tools: [] as string[], ...DEFAULTS });
  const [issuedKey, setIssuedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [historyFor, setHistoryFor] = useState<BenchKey | null>(null);
  const [historyDays, setHistoryDays] = useState<DayUsage[]>([]);
  const [historyLimits, setHistoryLimits] = useState<{ daily_jobs_limit: number; daily_rows_limit: number } | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [openDays, setOpenDays] = useState<Set<string>>(new Set());

  const [limitsFor, setLimitsFor] = useState<BenchKey | null>(null);
  const [limitsForm, setLimitsForm] = useState<Limits>(DEFAULTS);
  const [limitsSaving, setLimitsSaving] = useState(false);
  const [limitsError, setLimitsError] = useState<string | null>(null);

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
    setIssueError(null);
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
      setIssueError(e instanceof Error ? e.message : 'Не удалось выдать ключ');
    } finally {
      setIssuing(false);
    }
  }

  function openIssue() {
    setIssuedKey(null);
    setIssueError(null);
    setCopied(false);
    setForm({ name: '', tools: [], ...DEFAULTS });
    setIssueOpen(true);
  }

  /** Закрыли окно — ключ больше не показываем: он выдаётся ровно один раз. */
  function closeIssue() {
    setIssueOpen(false);
    setIssuedKey(null);
    setIssueError(null);
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

  function openLimits(key: BenchKey) {
    setLimitsFor(key);
    setLimitsError(null);
    setLimitsForm({
      rpm_limit: key.rpm_limit,
      daily_jobs_limit: key.daily_jobs_limit,
      daily_rows_limit: key.daily_rows_limit,
      max_active_jobs: key.max_active_jobs,
    });
  }

  async function saveLimits() {
    if (!limitsFor) return;
    setLimitsSaving(true);
    setLimitsError(null);
    try {
      const res = await authFetch(`/api/admin/bench-keys/${limitsFor.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set_limits', limits: limitsForm }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? 'Не удалось сохранить лимиты');
      }
      setLimitsFor(null);
      await load();
    } catch (e) {
      setLimitsError(e instanceof Error ? e.message : 'Не удалось сохранить лимиты');
    } finally {
      setLimitsSaving(false);
    }
  }

  async function openHistory(key: BenchKey) {
    setHistoryFor(key);
    setHistoryLoading(true);
    setHistoryDays([]);
    setHistoryLimits(null);
    setOpenDays(new Set());
    try {
      const res = await authFetch(`/api/admin/bench-keys/${key.id}/history?days=10`);
      const body = await res.json();
      if (res.ok) {
        setHistoryDays(body.days ?? []);
        setHistoryLimits(body.limits ?? null);
      }
    } finally {
      setHistoryLoading(false);
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

  /** Действия строки ключа — в меню «⋯», чтобы кнопки не растягивали таблицу. */
  function keyActions(key: BenchKey): RowAction[] {
    const items: RowAction[] = [
      { label: 'Расход по дням', icon: BarChart3, onClick: () => void openHistory(key) },
      { label: 'Журнал', icon: ScrollText, onClick: () => void openLog(key) },
    ];
    if (!key.revoked_at) {
      items.push(
        { label: 'Лимиты', icon: Pencil, onClick: () => openLimits(key) },
        { label: 'Отозвать', icon: Ban, danger: true, onClick: () => void revoke(key) },
      );
    }
    return items;
  }

  function toggleDay(date: string) {
    setOpenDays((prev) => {
      const next = new Set(prev);
      if (next.has(date)) next.delete(date);
      else next.add(date);
      return next;
    });
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

      {/* Документы лежат в app/public и едут в образ вместе с приложением —
          здесь всегда версия из выкаченной ветки, а не копия, которую забыли
          обновить. Ключ в эти файлы не вставляем: его дают отдельным
          сообщением и при необходимости отзывают. */}
      <div className="mb-8 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-200 bg-gray-50 p-4">
        <div>
          <p className="font-medium text-sm">Документация</p>
          <p className="text-sm text-gray-500">
            Обзор — обязательная памятка безопасности для людей без опыта в
            коде. Контекст для ИИ-чата — файл, который прикладывают к ChatGPT,
            Claude или Cursor вместе с ключом.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 shrink-0">
          <a
            href="/api-portal.md"
            download="API портала.md"
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-600 bg-slate-800 px-3 py-1.5 text-sm text-white transition-colors hover:border-slate-500 hover:bg-slate-600"
          >
            <BookOpen className="w-3.5 h-3.5" />
            Обзор
          </a>
          <a
            href="/portal-api-ai-context.md"
            download="Контекст для ИИ-чата.md"
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-600 bg-slate-800 px-3 py-1.5 text-sm text-white transition-colors hover:border-slate-500 hover:bg-slate-600"
          >
            <Download className="w-3.5 h-3.5" />
            Контекст для ИИ-чата
          </a>
        </div>
      </div>

      <section>
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="font-medium">Выданные ключи</h2>
          <button
            type="button"
            onClick={openIssue}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-500"
          >
            <Plus className="h-4 w-4" />
            Ключ
          </button>
        </div>
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
                  <th className="px-3 py-2 text-right">Действия</th>
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
                    {/* Лимит без расхода — половина ответа: «50 задач в сутки»
                        не говорит, упёрся ключ в потолок или не начинал. */}
                    <td className="px-3 py-2 whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => void openHistory(key)}
                        title="История расхода за 10 дней"
                        className="w-full min-w-[190px] rounded px-1 py-0.5 text-left hover:bg-gray-50"
                      >
                        {(
                          [
                            ['в минуту', key.usage.requests_last_minute, key.rpm_limit, false],
                            ['задач сегодня', key.usage.jobs_today, key.daily_jobs_limit, false],
                            ['строк сегодня', key.usage.rows_today, key.daily_rows_limit, true],
                          ] as const
                        ).map(([label, used, limit, big]) => (
                          <div key={label} className="mb-1 last:mb-0">
                            <div className="flex items-baseline justify-between gap-2 text-[11px] leading-tight">
                              <span className="text-gray-400">{label}</span>
                              <span className="tabular-nums text-gray-600">
                                {big ? used.toLocaleString('ru-RU') : used}
                                <span className="text-gray-400">
                                  {' / '}
                                  {big ? limit.toLocaleString('ru-RU') : limit}
                                </span>
                              </span>
                            </div>
                            <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-gray-100">
                              <div
                                className={`h-full rounded-full ${usageTone(used, limit)}`}
                                style={{ width: `${pct(used, limit)}%` }}
                              />
                            </div>
                          </div>
                        ))}
                        <div className="mt-1 text-[11px] text-gray-400">
                          одновременно: до {key.max_active_jobs}
                        </div>
                      </button>
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-500 whitespace-nowrap">
                      {formatDateTime(key.last_used_at)}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-right">
                      <RowActionsMenu items={keyActions(key)} vertical />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {issueOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="max-h-[90vh] w-full max-w-3xl overflow-hidden rounded-lg bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
              <h3 className="font-medium">{issuedKey ? 'Ключ выдан' : 'Выдать ключ'}</h3>
              <button onClick={closeIssue} className="p-1 hover:bg-gray-100 rounded" aria-label="Закрыть">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="max-h-[75vh] overflow-y-auto p-4">
              {/* Ключ показывается ровно один раз: в базе лежит только его
                  отпечаток. Закрыли окно — ключ больше не увидеть. */}
              {issuedKey ? (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4">
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
                  </div>
                </div>
              </div>
              ) : (
                <>
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
                    {LIMIT_FIELDS.map(([field, label]) => (
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
                  {issueError && (
                    <div className="mb-3 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                      <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                      <span>{issueError}</span>
                    </div>
                  )}
                  <button
                    onClick={() => void issue()}
                    disabled={!canIssue || issuing}
                    className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-40"
                  >
                    {issuing ? 'Выдаём…' : 'Выдать ключ'}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {historyFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="max-h-[80vh] w-full max-w-3xl overflow-hidden rounded-lg bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
              <div>
                <h3 className="font-medium">Расход по дням — {historyFor.name}</h3>
                <p className="text-xs text-gray-500">
                  Последние 10 суток по Москве. Нажмите на день — разбивка по инструментам.
                </p>
              </div>
              <button
                onClick={() => setHistoryFor(null)}
                className="p-1 hover:bg-gray-100 rounded"
                aria-label="Закрыть"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="max-h-[65vh] overflow-y-auto">
              {historyLoading ? (
                <p className="p-4 text-sm text-gray-500">Загрузка…</p>
              ) : historyDays.length === 0 ? (
                <p className="p-4 text-sm text-gray-500">Обращений за этот период не было.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-gray-50 text-left text-xs uppercase text-gray-500">
                    <tr>
                      <th className="px-3 py-2">Дата</th>
                      <th className="px-3 py-2">Задач</th>
                      <th className="px-3 py-2">Строк</th>
                      <th className="px-3 py-2">Запросов</th>
                      <th className="px-3 py-2" title="Больше всего запросов за одну минуту этих суток">Пик в мин.</th>
                      <th className="px-3 py-2" title="Отказы по лимиту (429) / прочие ошибки">Отказы</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {historyDays.map((day) => (
                      <Fragment key={day.date}>
                      <tr
                        onClick={() => day.requests > 0 && toggleDay(day.date)}
                        className={day.requests > 0 ? 'cursor-pointer hover:bg-gray-50' : ''}
                      >
                        <td className="px-3 py-2 text-xs whitespace-nowrap tabular-nums">
                          <span className="inline-flex items-center gap-1">
                            {day.requests > 0 ? (
                              openDays.has(day.date)
                                ? <ChevronDown className="h-3 w-3 text-gray-400" />
                                : <ChevronRight className="h-3 w-3 text-gray-400" />
                            ) : <span className="w-3" />}
                            {new Date(day.date).toLocaleDateString('ru-RU', {
                              day: '2-digit',
                              month: '2-digit',
                            })}
                          </span>
                        </td>
                        {/* Полоса рисуется относительно суточного лимита, а не
                            относительно самого большого дня: так видно упор в
                            потолок, а не просто «этот день выше соседнего». */}
                        <td className="px-3 py-2 w-1/3">
                          <div className="flex items-center gap-2">
                            <span className="tabular-nums text-xs w-10 shrink-0">{day.jobs}</span>
                            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-100">
                              <div
                                className={`h-full rounded-full ${usageTone(day.jobs, historyLimits?.daily_jobs_limit ?? 0)}`}
                                style={{ width: `${pct(day.jobs, historyLimits?.daily_jobs_limit ?? 0)}%` }}
                              />
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-2 w-1/3">
                          <div className="flex items-center gap-2">
                            <span className="tabular-nums text-xs w-16 shrink-0">
                              {day.rows.toLocaleString('ru-RU')}
                            </span>
                            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-100">
                              <div
                                className={`h-full rounded-full ${usageTone(day.rows, historyLimits?.daily_rows_limit ?? 0)}`}
                                style={{ width: `${pct(day.rows, historyLimits?.daily_rows_limit ?? 0)}%` }}
                              />
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-2 text-xs tabular-nums text-gray-500">
                          {day.requests}
                        </td>
                        <td className="px-3 py-2 text-xs tabular-nums text-gray-500">
                          {day.peak_per_minute}
                          <span className="text-gray-400"> / {historyFor.rpm_limit}</span>
                        </td>
                        <td className="px-3 py-2 text-xs tabular-nums">
                          <span className={day.limited ? 'text-amber-600' : 'text-gray-400'}>{day.limited}</span>
                          <span className="text-gray-400"> / </span>
                          <span className={day.errors ? 'text-red-600' : 'text-gray-400'}>{day.errors}</span>
                        </td>
                      </tr>
                      {openDays.has(day.date) && day.tools.map((t) => (
                        <tr key={`${day.date}:${t.tool ?? ''}`} className="bg-gray-50/60 text-xs text-gray-600">
                          <td className="py-1.5 pl-8 pr-3">{t.tool ? (toolTitles.get(t.tool) ?? t.tool) : 'Без инструмента'}</td>
                          <td className="px-3 py-1.5 tabular-nums">{t.jobs}</td>
                          <td className="px-3 py-1.5 tabular-nums">{t.rows.toLocaleString('ru-RU')}</td>
                          <td className="px-3 py-1.5 tabular-nums">{t.requests}</td>
                          <td className="px-3 py-1.5" />
                          <td className="px-3 py-1.5 tabular-nums">
                            <span className={t.limited ? 'text-amber-600' : 'text-gray-400'}>{t.limited}</span>
                            <span className="text-gray-400"> / </span>
                            <span className={t.errors ? 'text-red-600' : 'text-gray-400'}>{t.errors}</span>
                          </td>
                        </tr>
                      ))}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            {historyLimits && (
              <div className="border-t border-gray-200 px-4 py-2 text-xs text-gray-500">
                Потолки: {historyLimits.daily_jobs_limit} задач и{' '}
                {historyLimits.daily_rows_limit.toLocaleString('ru-RU')} строк в сутки
              </div>
            )}
          </div>
        </div>
      )}

      {limitsFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-lg overflow-hidden rounded-lg bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
              <div>
                <h3 className="font-medium">Лимиты — {limitsFor.name}</h3>
                <p className="text-xs text-gray-500">Действуют со следующего запроса, ключ менять не нужно.</p>
              </div>
              <button
                onClick={() => setLimitsFor(null)}
                className="p-1 hover:bg-gray-100 rounded"
                aria-label="Закрыть"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3 p-4">
              {LIMIT_FIELDS.map(([field, label]) => (
                <div key={field}>
                  <label className="block text-xs text-gray-500 mb-1">{label}</label>
                  <input
                    type="number"
                    min={0}
                    value={limitsForm[field]}
                    onChange={(e) =>
                      setLimitsForm((f) => ({ ...f, [field]: Number(e.target.value) || 0 }))
                    }
                    className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
                  />
                </div>
              ))}
            </div>
            {limitsError && (
              <p className="mx-4 mb-3 rounded-lg border border-red-200 bg-red-50 p-2 text-sm text-red-700">
                {limitsError}
              </p>
            )}
            <div className="flex justify-end gap-2 border-t border-gray-200 px-4 py-3">
              <button
                onClick={() => setLimitsFor(null)}
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50"
              >
                Отмена
              </button>
              <button
                onClick={() => void saveLimits()}
                disabled={limitsSaving}
                className="rounded-lg bg-gray-900 px-3 py-1.5 text-sm text-white disabled:opacity-40"
              >
                {limitsSaving ? 'Сохраняем…' : 'Сохранить'}
              </button>
            </div>
          </div>
        </div>
      )}

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
