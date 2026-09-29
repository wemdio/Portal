'use client';

import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import { LEAD_CRITERIA_MAX } from '@/lib/senderLeads/settings';
import type {
  LeadHistoryCounts,
  LeadHistoryFilter,
  LeadHistoryRowDto,
  LeadSettingsDto,
  LeadVerdict,
} from '@/lib/senderLeads/history';
import { fetchLeadHistory, fetchLeadSettings, saveLeadSettings, setLeadVerdict } from './api';

const FILTERS: { id: LeadHistoryFilter; label: string; tone: string }[] = [
  { id: 'all', label: 'Всего', tone: 'text-zinc-900' },
  { id: 'lead', label: 'Лиды', tone: 'text-emerald-700' },
  { id: 'sent', label: 'Ушли в чат', tone: 'text-blue-700' },
  { id: 'not_lead', label: 'Не лиды', tone: 'text-zinc-600' },
  { id: 'pending', label: 'В очереди', tone: 'text-amber-700' },
  { id: 'error', label: 'Ошибки', tone: 'text-red-700' },
];

const EMPTY_COUNTS: LeadHistoryCounts = { all: 0, lead: 0, sent: 0, not_lead: 0, pending: 0, error: 0 };

function formatAt(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** Время отправки в чат: сегодня — только часы, иначе с датой. */
function formatSentAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const time = date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return date.toDateString() === new Date().toDateString()
    ? time
    : `${date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })} ${time}`;
}

const BADGE: Record<string, string> = {
  lead: 'bg-emerald-100 text-emerald-700',
  not_lead: 'bg-zinc-100 text-zinc-600',
  pending: 'bg-amber-100 text-amber-700',
  error: 'bg-red-100 text-red-700',
};

const AI_LABEL: Record<LeadHistoryRowDto['status'], string> = {
  lead: 'Лид',
  not_lead: 'Не лид',
  pending: 'В очереди',
  error: 'Ошибка',
};

/**
 * Вердикт строки. Ручная метка переписки приоритетнее ИИ и показывается
 * главной; оценка ИИ тогда остаётся пояснением.
 */
function verdictBadge(row: LeadHistoryRowDto): { label: string; className: string } {
  if (row.verdictSource === 'manual' && row.verdict) {
    return {
      label: row.verdict === 'lead' ? 'Лид (вручную)' : 'Не лид (вручную)',
      className: BADGE[row.verdict],
    };
  }
  return { label: AI_LABEL[row.status], className: BADGE[row.status] };
}

function aiExplanation(row: LeadHistoryRowDto): string | null {
  const manual = row.verdictSource === 'manual' && row.verdict;
  if (row.status === 'error') return row.lastError ? `ИИ не ответил: ${row.lastError}` : 'ИИ не ответил за 5 попыток';
  if (row.status === 'pending') {
    return row.attempts > 0 && row.lastError ? `Повтор после сбоя (попытка ${row.attempts}): ${row.lastError}` : null;
  }
  if (!row.aiReason) return manual ? `ИИ: ${AI_LABEL[row.status].toLowerCase()}` : null;
  return manual ? `ИИ: ${AI_LABEL[row.status].toLowerCase()} — ${row.aiReason}` : row.aiReason;
}

function chatStatus(row: LeadHistoryRowDto): { text: string; className: string } {
  if (row.tgSentAt) return { text: `ушёл ${formatSentAt(row.tgSentAt)}`, className: 'text-blue-700' };
  if (row.tgError) return { text: `не ушёл: ${row.tgError}`, className: 'text-zinc-500' };
  if (row.status === 'lead') return { text: 'ещё не ушёл', className: 'text-amber-700' };
  return { text: '—', className: 'text-zinc-400' };
}

/** Ответ: первые строки, по кнопке — целиком. */
function ReplyText({ text }: { text: string | null }) {
  const [open, setOpen] = useState(false);
  const body = (text ?? '').trim();
  if (!body) return <p className="text-sm text-zinc-400">Текста нет</p>;
  const long = body.length > 280 || body.split('\n').length > 3;
  return (
    <div>
      <p className={`whitespace-pre-wrap break-words text-sm text-zinc-700 ${open ? '' : 'line-clamp-3'}`}>{body}</p>
      {long ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="mt-1 text-xs font-medium text-blue-600 hover:text-blue-500"
        >
          {open ? 'Свернуть' : 'Показать целиком'}
        </button>
      ) : null}
    </div>
  );
}

/** Настройки квалификатора папки: сохраняются кнопкой, воркер подхватывает их сам. */
function SettingsCard({ folderKey }: { folderKey: string }) {
  const [loaded, setLoaded] = useState<LeadSettingsDto | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [telegram, setTelegram] = useState(true);
  const [criteria, setCriteria] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = (settings: LeadSettingsDto) => {
    setLoaded(settings);
    setEnabled(settings.enabled);
    setTelegram(settings.telegram);
    setCriteria(settings.criteria);
  };

  useEffect(() => {
    let cancelled = false;
    fetchLeadSettings(folderKey)
      .then((settings) => {
        if (!cancelled) apply(settings);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Не удалось загрузить настройки');
      });
    return () => {
      cancelled = true;
    };
  }, [folderKey]);

  const dirty = loaded !== null
    && (enabled !== loaded.enabled || telegram !== loaded.telegram || criteria.trim() !== loaded.criteria.trim());
  const tooLong = criteria.trim().length > LEAD_CRITERIA_MAX;

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      apply(await saveLeadSettings(folderKey, { enabled, telegram, criteria: criteria.trim() }));
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сохранить');
    } finally {
      setSaving(false);
    }
  };

  const touch = () => setSaved(false);

  return (
    <div className="rounded-xl border border-zinc-200 bg-white">
      <div className="border-b border-zinc-200 px-5 py-3">
        <h2 className="text-base font-semibold text-zinc-900">Настройки квалификатора</h2>
        <p className="mt-0.5 text-xs text-zinc-500">
          ИИ оценивает живые ответы на письма {loaded?.folderName ? `папки «${loaded.folderName}»` : 'этой папки'} «Рассылки».
        </p>
      </div>

      {loaded === null && !error ? (
        <div className="flex items-center gap-2 px-5 py-6 text-sm text-zinc-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          Загрузка…
        </div>
      ) : (
        <div className="space-y-4 px-5 py-4">
          {loaded && !loaded.folderExists ? (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
              Папка ещё не создана — появится с первой заливкой в Рассылку.
            </p>
          ) : null}

          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => {
                setEnabled(e.target.checked);
                touch();
              }}
              className="mt-0.5 h-4 w-4 cursor-pointer rounded border-zinc-300"
            />
            <span>
              <span className="block text-sm font-medium text-zinc-900">Оценивать ответы</span>
              <span className="block text-xs text-zinc-500">Выключено — новые ответы не оцениваются и в историю не попадают.</span>
            </span>
          </label>

          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              checked={telegram}
              onChange={(e) => {
                setTelegram(e.target.checked);
                touch();
              }}
              className="mt-0.5 h-4 w-4 cursor-pointer rounded border-zinc-300"
            />
            <span>
              <span className="block text-sm font-medium text-zinc-900">Слать лидов в ТГ-чат</span>
              <span className="block text-xs text-zinc-500">Чат «Продажи Polza», ветка General. Одно сообщение на переписку.</span>
            </span>
          </label>

          <div>
            <div className="flex items-baseline justify-between gap-3">
              <label htmlFor={`lead-criteria-${folderKey}`} className="text-sm font-medium text-zinc-900">
                Что считать лидом
              </label>
              <span className={`text-xs ${tooLong ? 'text-red-600' : 'text-zinc-400'}`}>
                {criteria.trim().length} / {LEAD_CRITERIA_MAX}
              </span>
            </div>
            <textarea
              id={`lead-criteria-${folderKey}`}
              value={criteria}
              onChange={(e) => {
                setCriteria(e.target.value);
                touch();
              }}
              rows={4}
              placeholder="Пусто — общие правила квалификатора"
              className="mt-1.5 w-full resize-y rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900"
            />
            <p className="mt-1 text-xs text-zinc-500">
              Приоритетнее общих правил. Пример: «Лид — если просят цену, созвон или прислать список; передача контакта
              коллеге — тоже лид».
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || !dirty || tooLong || !loaded?.folderExists}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Сохранить
            </button>
            {error ? <span className="text-sm text-red-600">{error}</span> : null}
            {saved && !error ? (
              <span className="text-sm text-emerald-700">
                Сохранено. Применится к новым ответам в течение минуты.
              </span>
            ) : null}
          </div>
          <p className="text-xs text-zinc-400">Уже оценённые ответы не переоцениваются.</p>
        </div>
      )}
    </div>
  );
}

/**
 * Вкладка «Квалификация» автоаутрича: настройки квалификатора папки
 * «Рассылки» и история оценок её ответов — кто лид, кто нет, что ушло в
 * ТГ-чат. Ручная метка «Лид» / «Не лид» приоритетнее ИИ и в чат не шлёт.
 */
export function QualificationTab({ folderKey }: { folderKey: string }) {
  const [filter, setFilter] = useState<LeadHistoryFilter>('all');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<LeadHistoryRowDto[]>([]);
  const [counts, setCounts] = useState<LeadHistoryCounts>(EMPTY_COUNTS);
  const [total, setTotal] = useState(0);
  const [pageSize, setPageSize] = useState(30);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyRecipient, setBusyRecipient] = useState<string | null>(null);
  const [verdictError, setVerdictError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetchLeadHistory({ folder: folderKey, filter, page });
      setRows(res.rows);
      setCounts(res.counts);
      setTotal(res.total);
      setPageSize(res.pageSize);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить историю');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [folderKey, filter, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const mark = async (recipientId: string, verdict: LeadVerdict) => {
    setBusyRecipient(recipientId);
    setVerdictError(null);
    try {
      const res = await setLeadVerdict(recipientId, verdict);
      // Метка — у переписки: у всех её ответов в списке она одна.
      setRows((prev) => prev.map((row) => (row.recipientId === recipientId
        ? { ...row, verdict: res.verdict, verdictSource: res.verdictSource, verdictAt: res.verdictAt }
        : row)));
    } catch (err) {
      setVerdictError(err instanceof Error ? err.message : 'Не удалось поставить метку');
    } finally {
      setBusyRecipient(null);
    }
  };

  const maxPage = Math.max(1, Math.ceil(total / pageSize));
  const filterLabel = FILTERS.find((f) => f.id === filter)?.label ?? '';

  return (
    <div className="space-y-4">
      <SettingsCard folderKey={folderKey} />

      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        {FILTERS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => {
              setFilter(item.id);
              setPage(1);
            }}
            className={`rounded-xl border px-3 py-2.5 text-left transition-colors ${
              filter === item.id ? 'border-blue-500 bg-blue-50' : 'border-zinc-200 bg-white hover:bg-zinc-50'
            }`}
          >
            <div className="text-xs text-zinc-500">{item.label}</div>
            <div className={`text-lg font-semibold ${item.tone}`}>{counts[item.id]}</div>
          </button>
        ))}
      </div>

      <div className="rounded-xl border border-zinc-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 px-5 py-3">
          <h2 className="text-base font-semibold text-zinc-900">
            История{filter !== 'all' ? ` · ${filterLabel}` : ''} ({total})
          </h2>
          <button
            type="button"
            onClick={() => void load()}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-zinc-600 transition-colors hover:bg-zinc-100 disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
            Обновить
          </button>
        </div>

        {error ? <p className="px-5 pt-3 text-sm text-red-600">{error}</p> : null}
        {verdictError ? <p className="px-5 pt-3 text-sm text-red-600">{verdictError}</p> : null}

        {loading ? (
          <div className="flex items-center justify-center gap-2 px-5 py-10 text-sm text-zinc-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            Загрузка…
          </div>
        ) : rows.length === 0 ? (
          <p className="px-5 py-12 text-center text-sm text-zinc-500">
            {filter !== 'all'
              ? 'Здесь пусто — выберите другую плашку.'
              : 'Оценённых ответов пока нет: они появятся, как только на письма папки ответят.'}
          </p>
        ) : (
          <div className="divide-y divide-zinc-100">
            {rows.map((row) => {
              const badge = verdictBadge(row);
              const explanation = aiExplanation(row);
              const chat = chatStatus(row);
              const otherAddress = row.replyFrom && row.recipientEmail
                && row.replyFrom.toLowerCase() !== row.recipientEmail.toLowerCase();
              const manual = row.verdictSource === 'manual' ? row.verdict : null;
              const busy = busyRecipient === row.recipientId;
              return (
                <div key={row.replyId} className="space-y-2 px-5 py-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-zinc-900">
                          {row.companyName || row.recipientEmail || 'Без названия'}
                        </span>
                        <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${badge.className}`}>{badge.label}</span>
                        {row.criteriaUsed ? (
                          <span className="rounded-md bg-violet-50 px-2 py-0.5 text-xs text-violet-700" title="Оценено с правилом папки «Что считать лидом»">
                            по правилу папки
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-0.5 text-xs text-zinc-500">
                        {otherAddress
                          ? `ответил ${row.replyFrom}, писали на ${row.recipientEmail}`
                          : row.recipientEmail ?? row.replyFrom ?? ''}
                        {row.campaignName ? ` · ${row.campaignName}` : ''}
                      </div>
                    </div>
                    <span className="shrink-0 text-xs text-zinc-500">{formatAt(row.replyAt)}</span>
                  </div>

                  <div className="rounded-lg bg-zinc-50 px-3 py-2">
                    {row.replySubject ? <p className="mb-0.5 text-xs font-medium text-zinc-600">{row.replySubject}</p> : null}
                    {/* Тело письма — текст как есть: это чужой ввод, разметку не исполняем. */}
                    <ReplyText text={row.replyBody} />
                  </div>

                  {explanation ? <p className="text-sm text-zinc-600">{explanation}</p> : null}

                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <span className={`text-xs ${chat.className}`}>Чат: {chat.text}</span>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void mark(row.recipientId, 'lead')}
                        disabled={busy || manual === 'lead'}
                        className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-default ${
                          manual === 'lead'
                            ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                            : 'border-zinc-300 text-zinc-700 hover:bg-zinc-100 disabled:opacity-50'
                        }`}
                      >
                        Лид
                      </button>
                      <button
                        type="button"
                        onClick={() => void mark(row.recipientId, 'not_lead')}
                        disabled={busy || manual === 'not_lead'}
                        className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-default ${
                          manual === 'not_lead'
                            ? 'border-zinc-400 bg-zinc-100 text-zinc-700'
                            : 'border-zinc-300 text-zinc-700 hover:bg-zinc-100 disabled:opacity-50'
                        }`}
                      >
                        Не лид
                      </button>
                      <a
                        href={`/tools/sender?tab=threads&thread=${row.recipientId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-blue-600 transition-colors hover:bg-blue-50"
                      >
                        Открыть переписку
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {total > pageSize ? (
          <div className="flex items-center justify-center gap-4 border-t border-zinc-200 px-5 py-3 text-sm">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="rounded-md px-3 py-1.5 text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-40"
            >
              ← Назад
            </button>
            <span className="text-zinc-500">
              Стр. {page} из {maxPage}
            </span>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(maxPage, p + 1))}
              disabled={page >= maxPage}
              className="rounded-md px-3 py-1.5 text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-40"
            >
              Вперёд →
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
