'use client';

/**
 * Панель управления Background BoB Scorer'ом.
 *
 * Используется на двух страницах:
 *   - /admin/auto-pipeline/scorer — admin видит full controls (reset, config)
 *   - /client/auto-pipeline/setup — клиент видит progress + toggle (read+toggle)
 *
 * Props.canManage:
 *   true  — показываем кнопки Toggle / Reset / Config (admin)
 *   false — только progress bar + статистика (read-only, на клиентской странице
 *           кнопка Toggle остаётся, но Reset скрыт)
 */

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';

interface ScorerState {
  enabled: boolean;
  current_offset: number;
  domains_scored_total: number;
  domains_active_total: number;
  last_tick_at: string | null;
  last_tick_batch_size: number | null;
  last_error: string | null;
  last_error_at: string | null;
  batch_size: number;
  sleep_between_batches_ms: number;
  revenue_from: number;
  cached_domains: number;
  cached_active: number;
  seconds_since_last_tick: number | null;
}

export interface BackgroundScorerPanelProps {
  /** Может ли пользователь менять конфиг (только admin). Клиент видит только Toggle. */
  isAdmin?: boolean;
}

export function BackgroundScorerPanel({ isAdmin = false }: BackgroundScorerPanelProps) {
  const [state, setState] = useState<ScorerState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fetchState = useCallback(async () => {
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) {
        setError('Не авторизован');
        setLoading(false);
        return;
      }
      const res = await fetch('/api/auto-pipeline/scorer', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        setError(text || `Ошибка ${res.status}`);
        setLoading(false);
        return;
      }
      const data = (await res.json()) as ScorerState;
      setState(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка сети');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchState();
    // Авто-рефреш каждые 30s — UI остаётся актуальным пока вкладка открыта
    const interval = setInterval(() => void fetchState(), 30_000);
    return () => clearInterval(interval);
  }, [fetchState]);

  const performAction = useCallback(
    async (body: Record<string, unknown>) => {
      setBusy(true);
      setError(null);
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const token = session?.access_token;
        if (!token) {
          setError('Не авторизован');
          return;
        }
        const res = await fetch('/api/auto-pipeline/scorer', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          setError(text || `Ошибка ${res.status}`);
          return;
        }
        const data = (await res.json()) as ScorerState;
        setState(data);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Ошибка сети');
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  if (loading) {
    return <div className="text-sm text-gray-500">Загрузка состояния…</div>;
  }

  if (!state) {
    return (
      <div className="text-sm text-red-600">
        Не удалось загрузить состояние{error ? `: ${error}` : ''}
      </div>
    );
  }

  // Грубая оценка прогресса. С revenue_from=0 (без фильтра по выручке) скорер
  // проходит ВСЕ компании с сайтом, исключая ИП — на 2026-05 это ~483k
  // (COUNT по companies_directory). Берём с небольшим запасом.
  const ESTIMATED_TOTAL_BOB = 485_000;
  const progressPct = Math.min(
    100,
    Math.round((state.current_offset / ESTIMATED_TOTAL_BOB) * 100),
  );
  const isAlive =
    state.seconds_since_last_tick !== null && state.seconds_since_last_tick < 600;

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm space-y-4">
      <header className="flex items-center justify-between gap-3">
        <h3 className="text-base font-semibold text-gray-900">Фоновый сборщик баз (BoB scorer)</h3>
        <div className="flex items-center gap-2">
          <span
            className={`inline-block h-2.5 w-2.5 rounded-full ${
              state.enabled ? (isAlive ? 'bg-green-500' : 'bg-amber-400') : 'bg-gray-300'
            }`}
            aria-label={state.enabled ? 'Включён' : 'Выключен'}
          />
          <span className="text-sm font-medium text-gray-700">
            {state.enabled ? (isAlive ? 'Работает' : 'Запущен (нет активности)') : 'Остановлен'}
          </span>
        </div>
      </header>

      <p className="text-sm text-gray-600">
        Постоянно прогоняет компании из «базы баз» через Mailganer-скоринг.
        Найденные активные домены попадают в общий кэш и используются ежедневным
        утренним прогоном — это экономит время и улучшает покрытие.
      </p>

      {/* Прогресс */}
      <div>
        <div className="flex items-baseline justify-between text-xs text-gray-600 mb-1">
          <span>Просмотрено {state.current_offset.toLocaleString('ru-RU')} компаний</span>
          <span>~{progressPct}%</span>
        </div>
        <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
          <div
            className="h-full bg-blue-500 transition-all"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      </div>

      {/* Метрики */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
        <Stat label="В кэше всего" value={state.cached_domains.toLocaleString('ru-RU')} />
        <Stat
          label="Из них активных"
          value={state.cached_active.toLocaleString('ru-RU')}
          accent={state.cached_active > 0}
        />
        <Stat
          label="Последний тик"
          value={
            state.seconds_since_last_tick === null
              ? '—'
              : state.seconds_since_last_tick < 60
              ? `${state.seconds_since_last_tick} сек назад`
              : `${Math.round(state.seconds_since_last_tick / 60)} мин назад`
          }
        />
      </div>

      {state.last_error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          <strong>Последняя ошибка:</strong> {state.last_error}
        </div>
      )}

      {/* Управление */}
      <div className="flex flex-wrap gap-2 pt-2 border-t border-gray-100">
        <button
          type="button"
          disabled={busy}
          onClick={() => void performAction({ action: 'toggle' })}
          className={`inline-flex h-9 items-center justify-center rounded-lg px-4 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
            state.enabled
              ? 'bg-amber-500 hover:bg-amber-600 text-white'
              : 'bg-blue-600 hover:bg-blue-700 text-white'
          }`}
        >
          {busy ? '…' : state.enabled ? '⏸ Остановить' : '▶ Запустить'}
        </button>

        {isAdmin && (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (confirm('Сбросить прогресс до 0? Воркер пройдёт по всей базе заново.')) {
                  void performAction({ action: 'reset' });
                }
              }}
              className="inline-flex h-9 items-center justify-center rounded-lg border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              Сбросить прогресс
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void fetchState()}
              className="inline-flex h-9 items-center justify-center rounded-lg border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              Обновить
            </button>
          </>
        )}
      </div>

      {isAdmin && (
        <details className="text-xs text-gray-500 pt-2 border-t border-gray-100">
          <summary className="cursor-pointer">Технические параметры</summary>
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1">
            <dt>Размер батча:</dt><dd>{state.batch_size}</dd>
            <dt>Пауза между батчами:</dt><dd>{state.sleep_between_batches_ms} мс</dd>
            <dt>Мин. оборот:</dt><dd>{state.revenue_from > 0 ? `${state.revenue_from.toLocaleString('ru-RU')} ₽` : 'без фильтра (все сайты)'}</dd>
            <dt>Всего скорено:</dt><dd>{state.domains_scored_total.toLocaleString('ru-RU')}</dd>
            <dt>Из них активных:</dt><dd>{state.domains_active_total.toLocaleString('ru-RU')}</dd>
            <dt>Последний тик:</dt><dd>{state.last_tick_at ?? '—'}</dd>
          </dl>
        </details>
      )}

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}
    </section>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div>
      <div className="text-xs text-gray-500">{label}</div>
      <div
        className={`text-lg font-semibold tabular-nums ${
          accent ? 'text-blue-700' : 'text-gray-900'
        }`}
      >
        {value}
      </div>
    </div>
  );
}
