'use client';

/**
 * Компактный блок «Авто-пайплайн» в верху клиентского дашборда.
 *
 * Показывает только клиентам в auto-режиме (т.е. portal-mode === 'auto').
 * Замещает CTA «Создать кампанию» и онбординг — кампании собираются за них,
 * клиенту смотреть на «как настроить» нечего.
 *
 * Что показываем:
 *   — Time-of-last-run и его статус (зелёный/красный кружок).
 *   — Метрики последнего прогона: добавлено в работу / в очереди / отброшено.
 *   — Сводка за 30 дней (мелкий шрифт): сколько лидов прошло.
 *
 * Источник данных: GET /api/client/auto-pipeline/summary.
 */

import { useEffect, useState } from 'react';
import { Clock, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import { clientApiFetch } from '@/lib/clientFetcher';

interface LastRun {
  status: 'running' | 'completed' | 'failed';
  started_at: string;
  finished_at: string | null;
  parsed_count: number;
  new_count: number;
  routed_count: number;
  stored_count: number;
  skipped_count: number;
  failed_count: number;
  error_message: string | null;
}

interface Totals30d {
  routed: number;
  stored: number;
  skipped: number;
  failed: number;
}

interface SummaryResponse {
  enabled: boolean;
  daily_limit: number | null;
  last_run: LastRun | null;
  totals_30d: Totals30d | null;
  stored_count: number;
}

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return 'только что';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'только что';
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  const days = Math.floor(hours / 24);
  return `${days} дн назад`;
}

export function AutoPipelineSummary() {
  const [data, setData] = useState<SummaryResponse | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await clientApiFetch<SummaryResponse>('/auto-pipeline/summary');
        if (!cancelled) setData(res);
      } catch {
        if (!cancelled) setError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error || (data && !data.enabled)) return null;

  if (!data) {
    return (
      <section
        className="neu-card flex items-center gap-3 px-5 py-4"
        aria-label="Авто-пайплайн загружается"
      >
        <Loader2
          className="h-4 w-4 animate-spin"
          style={{ color: 'var(--cp-text-l)' }}
          aria-hidden
        />
        <p className="text-sm" style={{ color: 'var(--cp-text-m)' }}>
          Авто-пайплайн…
        </p>
      </section>
    );
  }

  const { last_run, totals_30d, stored_count } = data;
  const lastRunStatus = last_run?.status ?? null;
  const statusIcon =
    lastRunStatus === 'failed' ? (
      <AlertCircle className="h-4 w-4" style={{ color: 'var(--cp-danger)' }} aria-hidden />
    ) : lastRunStatus === 'completed' ? (
      <CheckCircle2 className="h-4 w-4" style={{ color: 'var(--cp-success, #4ade80)' }} aria-hidden />
    ) : (
      <Clock className="h-4 w-4" style={{ color: 'var(--cp-text-l)' }} aria-hidden />
    );

  return (
    <section className="neu-card px-5 py-4" aria-labelledby="auto-pipeline-label">
      <header className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          {statusIcon}
          <h2 id="auto-pipeline-label" className="text-sm font-bold" style={{ color: 'var(--cp-text)' }}>
            Авто-пайплайн
          </h2>
        </div>
        <span className="text-xs" style={{ color: 'var(--cp-text-l)' }}>
          {last_run ? relativeTime(last_run.finished_at ?? last_run.started_at) : 'ни одного прогона'}
        </span>
      </header>

      {last_run ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Metric label="Добавлено в работу" value={last_run.routed_count} accent />
          <Metric label="В очереди (stored)" value={stored_count} />
          <Metric label="Отброшено" value={last_run.skipped_count + last_run.failed_count} />
          <Metric label="Всего за 30 дней" value={totals_30d?.routed ?? 0} />
        </div>
      ) : (
        <p className="text-sm" style={{ color: 'var(--cp-text-m)' }}>
          Кампании собираются автоматически каждое утро в 07:00 МСК.
          Первый прогон ещё не запускался.
        </p>
      )}

      {last_run?.status === 'failed' && last_run.error_message && (
        <p
          className="mt-3 text-xs"
          style={{ color: 'var(--cp-danger)' }}
        >
          Последний прогон с ошибкой: {last_run.error_message}
        </p>
      )}
    </section>
  );
}

function Metric({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div>
      <p
        className="text-xl font-bold tabular-nums"
        style={{ color: accent ? 'var(--cp-accent)' : 'var(--cp-text)' }}
      >
        {value.toLocaleString('ru-RU')}
      </p>
      <p className="text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
        {label}
      </p>
    </div>
  );
}
