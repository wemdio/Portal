'use client';

/**
 * Блок «Авто-пайплайн» в верху клиентского дашборда.
 *
 * Показывается только клиентам в auto-режиме (portal-mode === 'auto').
 * Замещает CTA «Создать кампанию» и онбординг — кампании собираются за них,
 * клиенту смотреть на «как настроить» нечего.
 *
 * Editorial-dark вёрстка:
 *   — eyebrow «01 → Авто-пайплайн» + статус-точка с временем последнего прогона
 *   — четыре строки-ледгера: первая (Добавлено в работу) — primary, mono-2xl,
 *     полный paper; остальные — компактные mono-sm, paper-mute, разделены
 *     hairline-дивайдером сверху
 *   — пустое состояние: один абзац paper-mute («первый прогон ещё не запускался»)
 *   — ошибка последнего прогона: mono красная строка снизу с error_message
 *
 * Источник данных: GET /api/client/auto-pipeline/summary.
 */

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
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
}

interface PendingAttempt {
  status: 'running' | 'failed' | 'pending' | 'cancelled';
  started_at: string;
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
  /** Последний completed прогон — основной источник цифр плитки. */
  last_run: LastRun | null;
  /** Прерванный/работающий прогон поверх completed — тонкий индикатор. */
  pending_attempt: PendingAttempt | null;
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
          style={{ color: 'var(--cp-paper-faint)' }}
          aria-hidden
        />
        <p className="text-sm" style={{ color: 'var(--cp-paper-mute)' }}>
          Авто-пайплайн…
        </p>
      </section>
    );
  }

  const { last_run, pending_attempt, totals_30d, stored_count } = data;

  // Status dot: зелёная если completed, серая если ни разу не было
  // прогонов. Прерванный прогон (pending_attempt) НЕ красит точку
  // красным — это normal operational event, не error для клиента.
  const statusDotColor = last_run ? 'var(--cp-green)' : 'var(--cp-paper-faint)';

  const timeLabel = last_run
    ? relativeTime(last_run.finished_at ?? last_run.started_at)
    : 'ни одного прогона';

  return (
    <section className="neu-card px-5 py-4" aria-labelledby="auto-pipeline-label">
      <header className="flex items-baseline justify-between gap-3 mb-4">
        <h2 id="auto-pipeline-label" className="ds-eyebrow" style={{ color: 'var(--cp-paper-mute)' }}>
          01<span aria-hidden> → </span>Авто-пайплайн
        </h2>
        <span
          className="inline-flex items-center gap-1.5 text-xs ds-mono shrink-0"
          style={{ color: 'var(--cp-paper-mute)' }}
        >
          <span
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ background: statusDotColor }}
            aria-hidden
          />
          {timeLabel}
        </span>
      </header>

      {last_run ? (
        <div className="space-y-0">
          <LedgerRow
            label="Добавлено в работу"
            value={last_run.routed_count}
            primary
          />
          <LedgerRow label="В очереди" value={stored_count} />
          <LedgerRow
            label="Отброшено"
            value={last_run.skipped_count + last_run.failed_count}
          />
          <LedgerRow
            label="Всего за 30 дней"
            value={totals_30d?.routed ?? 0}
          />
        </div>
      ) : (
        <p className="text-sm" style={{ color: 'var(--cp-paper-mute)' }}>
          Кампании собираются автоматически каждое утро в 07:00 МСК.
          Первый прогон ещё не запускался.
        </p>
      )}

      {/* Тонкий индикатор прерванного прогона: только если ПОСЛЕ последнего
          completed был ещё один (failed/running). Не пугаем клиента — это
          может случиться при редеплое или сетевом сбое, и не критично:
          следующий cron-прогон отработает штатно. error_message сюда не
          выходит, это технический admin-only факт. */}
      {pending_attempt && (
        <p
          className="mt-3 text-xs"
          style={{ color: 'var(--cp-paper-mute)' }}
        >
          <span
            className="inline-block h-1.5 w-1.5 rounded-full mr-1.5 align-middle"
            style={{ background: 'var(--cp-amber)' }}
            aria-hidden
          />
          {pending_attempt.status === 'running'
            ? `Сейчас идёт прогон (запустился ${relativeTime(pending_attempt.started_at)})`
            : `Последний прогон ${relativeTime(pending_attempt.started_at)} не завершился — следующий пройдёт штатно`}
        </p>
      )}
    </section>
  );
}

/**
 * Ledger row. Primary — большая mono-цифра + жирный paper-лейбл, без
 * верхнего дивайдера (сидит флешем под заголовком). Остальные — компактные
 * paper-mute строки с hairline сверху.
 */
function LedgerRow({
  label,
  value,
  primary,
}: {
  label: string;
  value: number;
  primary?: boolean;
}) {
  return (
    <div
      className={`flex items-baseline justify-between gap-3 ${primary ? 'py-2' : 'py-2.5'}`}
      style={primary ? undefined : { borderTop: '1px solid var(--cp-divider)' }}
    >
      <p
        className={`text-sm ${primary ? 'font-semibold' : ''}`}
        style={{ color: primary ? 'var(--cp-paper)' : 'var(--cp-paper-mute)' }}
      >
        {label}
      </p>
      <p
        className={`ds-mono tabular-nums ${primary ? 'text-2xl font-bold' : 'text-sm'}`}
        style={{ color: 'var(--cp-paper)' }}
      >
        {value.toLocaleString('ru-RU')}
      </p>
    </div>
  );
}
