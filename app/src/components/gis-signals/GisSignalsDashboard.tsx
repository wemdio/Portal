'use client';

/**
 * Дашборд «2GIS + сигналы» — отчётность outreach-пайплайна для одного клиента.
 *
 * Данные — GET /api/client/gis-signals (роут сам гейтит: чужим 404, сюда они
 * не доходят ещё на уровне server-component страницы). Три блока:
 *   01 — воронка недели по сегментам (суммы weeklyFunnel) + итог за всё время;
 *   02 — перформанс кампаний Instantly (allTime + строка «за 7 дней»);
 *   03 — общий срез по 6 сигналам × сегментам (companies count).
 *
 * Стили — как у остальных страниц клиентского портала: neu-card, ds-eyebrow,
 * ds-mono/tabular-nums для чисел, CSS-переменные --cp-*.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, Loader2, RefreshCw } from 'lucide-react';
import { clientApiFetch } from '@/lib/clientFetcher';

// ───────────────────────── types (зеркало ответа API) ─────────────────────────

interface GisSignalFunnelRow {
  runDate: string;
  segmentKey: string;
  pulled: number;
  signalsOk: number;
  bcIn: number;
  validContacts: number;
  appended: number;
}

type GisSignalKey =
  | 'signal_general_phone'
  | 'signal_contact_form'
  | 'signal_sales_dept'
  | 'signal_target_vacancy'
  | 'signal_high_volume'
  | 'signal_multi_office';

interface GisSignalSliceRow {
  segmentKey: string;
  signalKey: GisSignalKey;
  companies: number;
}

interface SegmentInfo {
  key: string;
  label: string;
  hasCampaign: boolean;
}

interface CampaignAllTime {
  emails_sent_count?: number;
  open_count?: number;
  reply_count?: number;
}

interface CampaignWindowTotals {
  emailsSent: number;
  openCount: number;
  replyCount: number;
}

interface CampaignEntry {
  segmentKey: string;
  label: string;
  analytics: {
    allTime: CampaignAllTime | null;
    last7Days: CampaignWindowTotals | null;
  } | null;
}

interface GisSignalsResponse {
  segments: SegmentInfo[];
  weeklyFunnel: GisSignalFunnelRow[];
  totalFunnel: GisSignalFunnelRow[];
  signalSlice: GisSignalSliceRow[];
  campaigns: CampaignEntry[];
}

// ───────────────────────── константы ─────────────────────────

/** Порядок и русские подписи 6 сигналов — фиксированы, не зависят от выборки. */
const SIGNAL_ROWS: Array<{ key: GisSignalKey; label: string }> = [
  { key: 'signal_general_phone', label: 'Общий телефон / колл-центр' },
  { key: 'signal_contact_form', label: 'Форма заявки / обратной связи' },
  { key: 'signal_sales_dept', label: 'Отдел продаж / приемная / call-центр' },
  { key: 'signal_target_vacancy', label: 'Вакансии: менеджер продаж или оператор call-центра' },
  { key: 'signal_high_volume', label: 'Признак большого потока' },
  { key: 'signal_multi_office', label: 'Несколько офисов / филиалов' },
];

interface FunnelTotals {
  pulled: number;
  signalsOk: number;
  bcIn: number;
  validContacts: number;
  appended: number;
}

const EMPTY_TOTALS: FunnelTotals = { pulled: 0, signalsOk: 0, bcIn: 0, validContacts: 0, appended: 0 };

// ───────────────────────── helpers ─────────────────────────

function fmt(n: number): string {
  return n.toLocaleString('ru-RU');
}

function sumFunnel(rows: GisSignalFunnelRow[], segmentKey: string): FunnelTotals {
  const totals = { ...EMPTY_TOTALS };
  for (const r of rows) {
    if (r.segmentKey !== segmentKey) continue;
    totals.pulled += Number(r.pulled) || 0;
    totals.signalsOk += Number(r.signalsOk) || 0;
    totals.bcIn += Number(r.bcIn) || 0;
    totals.validContacts += Number(r.validContacts) || 0;
    totals.appended += Number(r.appended) || 0;
  }
  return totals;
}

function sumFunnelAll(rows: GisSignalFunnelRow[]): FunnelTotals {
  const totals = { ...EMPTY_TOTALS };
  for (const r of rows) {
    totals.pulled += Number(r.pulled) || 0;
    totals.signalsOk += Number(r.signalsOk) || 0;
    totals.bcIn += Number(r.bcIn) || 0;
    totals.validContacts += Number(r.validContacts) || 0;
    totals.appended += Number(r.appended) || 0;
  }
  return totals;
}

function pct(part: number, total: number): string | null {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return null;
  return `${((part / total) * 100).toFixed(1)}%`;
}

// ───────────────────────── page component ─────────────────────────

export function GisSignalsDashboard() {
  const [data, setData] = useState<GisSignalsResponse | null>(null);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const retry = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (cancelled) return;
      setError('');
      try {
        const res = await clientApiFetch<GisSignalsResponse>('/gis-signals');
        if (!cancelled) setData(res);
      } catch {
        if (cancelled) return;
        setData(null);
        setError('Не удалось загрузить отчётность. Проверьте подключение и повторите.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  // Порядок сегментов — как в конфиге; сегменты, встретившиеся только в данных
  // (нет строки в gis_signal_segments), дописываем в конец с label = key.
  const segmentOrder = useMemo(() => {
    if (!data) return [];
    const order = data.segments.map((s) => ({ key: s.key, label: s.label }));
    const known = new Set(order.map((s) => s.key));
    const extra = new Set<string>();
    for (const r of [...data.weeklyFunnel, ...data.totalFunnel, ...data.signalSlice]) {
      if (!known.has(r.segmentKey)) extra.add(r.segmentKey);
    }
    for (const key of extra) order.push({ key, label: key });
    return order;
  }, [data]);

  const sliceIndex = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of data?.signalSlice ?? []) {
      const k = `${row.signalKey}::${row.segmentKey}`;
      map.set(k, (map.get(k) ?? 0) + (Number(row.companies) || 0));
    }
    return map;
  }, [data]);

  const totalAllTime = useMemo(
    () => (data ? sumFunnelAll(data.totalFunnel) : EMPTY_TOTALS),
    [data],
  );

  // ── loading / error ──────────────────────────────────────

  if (error) {
    return (
      <div className="mx-auto max-w-5xl">
        <div className="neu-card px-5 py-6 flex items-start gap-3" role="alert">
          <AlertCircle
            className="h-5 w-5 shrink-0 mt-0.5"
            style={{ color: 'var(--cp-paper-faint)' }}
            aria-hidden
          />
          <span className="flex-1 text-sm" style={{ color: 'var(--cp-paper)' }}>
            {error}
          </span>
          <button
            type="button"
            onClick={retry}
            className="ds-btn-secondary px-3 py-1 text-xs inline-flex items-center gap-1.5"
          >
            <RefreshCw className="h-3 w-3" aria-hidden />
            Повторить
          </button>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2
          className="h-5 w-5 animate-spin"
          style={{ color: 'var(--cp-paper-faint)' }}
          aria-hidden
        />
      </div>
    );
  }

  // ── render ───────────────────────────────────────────────

  return (
    <div className="mx-auto max-w-5xl space-y-6 sm:space-y-8">
      <header>
        <p className="ds-eyebrow mb-2">
          01<span aria-hidden> → </span>Отчётность
        </p>
        <h1
          className="text-xl sm:text-2xl font-bold m-0"
          style={{ color: 'var(--cp-paper)' }}
        >
          2GIS + сигналы — отчётность
        </h1>
      </header>

      {/* 02 → Воронка недели */}
      <section aria-labelledby="gis-weekly-label">
        <h2 id="gis-weekly-label" className="ds-eyebrow mb-3">
          02<span aria-hidden> → </span>Воронка недели
        </h2>

        {data.weeklyFunnel.length === 0 ? (
          <div className="neu-card px-5 py-8 text-center">
            <p className="text-sm font-bold mb-1" style={{ color: 'var(--cp-text)' }}>
              За эту неделю прогонов ещё не было
            </p>
            <p className="text-xs" style={{ color: 'var(--cp-text-m)' }}>
              Как только пайплайн отработает, здесь появится воронка по сегментам.
            </p>
          </div>
        ) : (
          <div className="neu-card overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  {['Сегмент', 'Отобрано', 'С сигналами', 'В конструктор', 'Валидных контактов', 'Залито в Instantly'].map(
                    (h, i) => (
                      <th
                        key={h}
                        className={`ds-eyebrow text-left px-4 sm:px-5 py-3 font-normal ${i > 0 ? 'text-right' : ''}`}
                      >
                        {h}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {segmentOrder.map((seg) => {
                  const t = sumFunnel(data.weeklyFunnel, seg.key);
                  return (
                    <tr
                      key={seg.key}
                      style={{ borderTop: '1px solid var(--cp-row-divider, rgba(180,173,164,0.18))' }}
                    >
                      <td className="px-4 sm:px-5 py-3 font-bold" style={{ color: 'var(--cp-text)' }}>
                        {seg.label}
                      </td>
                      <NumCell value={t.pulled} />
                      <NumCell value={t.signalsOk} />
                      <NumCell value={t.bcIn} />
                      <NumCell value={t.validContacts} />
                      <NumCell value={t.appended} />
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {data.totalFunnel.length > 0 && (
          <p className="text-xs mt-2" style={{ color: 'var(--cp-paper-mute)' }}>
            За всё время: отобрано{' '}
            <Mono>{fmt(totalAllTime.pulled)}</Mono>
            {' · с сигналами '}
            <Mono>{fmt(totalAllTime.signalsOk)}</Mono>
            {' · в конструктор '}
            <Mono>{fmt(totalAllTime.bcIn)}</Mono>
            {' · валидных контактов '}
            <Mono>{fmt(totalAllTime.validContacts)}</Mono>
            {' · залито в Instantly '}
            <Mono>{fmt(totalAllTime.appended)}</Mono>
          </p>
        )}
      </section>

      {/* 03 → Перформанс кампаний Instantly */}
      <section aria-labelledby="gis-campaigns-label">
        <h2 id="gis-campaigns-label" className="ds-eyebrow mb-3">
          03<span aria-hidden> → </span>Кампании в Instantly
        </h2>

        {data.campaigns.length === 0 ? (
          <div className="neu-card px-5 py-8 text-center">
            <p className="text-sm font-bold mb-1" style={{ color: 'var(--cp-text)' }}>
              Кампании ещё не привязаны
            </p>
            <p className="text-xs" style={{ color: 'var(--cp-text-m)' }}>
              Когда у сегментов появятся кампании в Instantly, метрики покажутся здесь.
            </p>
          </div>
        ) : (
          <div className="neu-card overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  {['Сегмент', 'Отправлено', 'Открытия %', 'Ответы %'].map((h, i) => (
                    <th
                      key={h}
                      className={`ds-eyebrow text-left px-4 sm:px-5 py-3 font-normal ${i > 0 ? 'text-right' : ''}`}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.campaigns.map((c) => {
                  const allTime = c.analytics?.allTime ?? null;
                  const sent = Number(allTime?.emails_sent_count ?? 0);
                  const opened = Number(allTime?.open_count ?? 0);
                  const replied = Number(allTime?.reply_count ?? 0);
                  const openPct = allTime ? pct(opened, sent) : null;
                  const replyPct = allTime ? pct(replied, sent) : null;
                  const last7 = c.analytics?.last7Days ?? null;
                  return (
                    <tr
                      key={c.segmentKey}
                      style={{ borderTop: '1px solid var(--cp-row-divider, rgba(180,173,164,0.18))' }}
                    >
                      <td className="px-4 sm:px-5 py-3 font-bold" style={{ color: 'var(--cp-text)' }}>
                        {c.label}
                      </td>
                      <td className="px-4 sm:px-5 py-3 text-right">
                        {allTime ? (
                          <>
                            <span className="ds-mono tabular-nums" style={{ color: 'var(--cp-text)' }}>
                              {fmt(sent)}
                            </span>
                            {last7 && (
                              <span
                                className="block text-[11px] ds-mono tabular-nums"
                                style={{ color: 'var(--cp-text-l)' }}
                              >
                                за 7 дней: {fmt(last7.emailsSent)}
                              </span>
                            )}
                          </>
                        ) : (
                          <Dash title="Нет данных Instantly" />
                        )}
                      </td>
                      <td className="px-4 sm:px-5 py-3 text-right">
                        {openPct !== null ? (
                          <span className="ds-mono tabular-nums" style={{ color: 'var(--cp-text)' }}>
                            {openPct}
                          </span>
                        ) : (
                          <Dash title="Нет данных" />
                        )}
                      </td>
                      <td className="px-4 sm:px-5 py-3 text-right">
                        {replyPct !== null ? (
                          <span className="ds-mono tabular-nums" style={{ color: 'var(--cp-text)' }}>
                            {replyPct}
                          </span>
                        ) : (
                          <Dash title="Нет данных" />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 04 → Общий срез по сигналам */}
      <section aria-labelledby="gis-slice-label">
        <h2 id="gis-slice-label" className="ds-eyebrow mb-3">
          04<span aria-hidden> → </span>Общий срез по сигналам
        </h2>

        {segmentOrder.length === 0 ? (
          <div className="neu-card px-5 py-8 text-center">
            <p className="text-sm font-bold mb-1" style={{ color: 'var(--cp-text)' }}>
              Данных пока нет
            </p>
            <p className="text-xs" style={{ color: 'var(--cp-text-m)' }}>
              Срез появится после первых прогонов пайплайна.
            </p>
          </div>
        ) : (
          <div className="neu-card overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th className="ds-eyebrow text-left px-4 sm:px-5 py-3 font-normal">Сигнал</th>
                  {segmentOrder.map((seg) => (
                    <th
                      key={seg.key}
                      className="ds-eyebrow px-4 sm:px-5 py-3 font-normal text-right"
                    >
                      {seg.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {SIGNAL_ROWS.map((sig) => (
                  <tr
                    key={sig.key}
                    style={{ borderTop: '1px solid var(--cp-row-divider, rgba(180,173,164,0.18))' }}
                  >
                    <td className="px-4 sm:px-5 py-3" style={{ color: 'var(--cp-text-m)' }}>
                      {sig.label}
                    </td>
                    {segmentOrder.map((seg) => (
                      <NumCell
                        key={seg.key}
                        value={sliceIndex.get(`${sig.key}::${seg.key}`) ?? 0}
                      />
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

// ── subcomponents ──────────────────────────────────────────

function NumCell({ value }: { value: number }) {
  return (
    <td className="px-4 sm:px-5 py-3 text-right">
      <span className="ds-mono tabular-nums" style={{ color: 'var(--cp-text)' }}>
        {fmt(value)}
      </span>
    </td>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return (
    <span className="ds-mono tabular-nums" style={{ color: 'var(--cp-paper)' }}>
      {children}
    </span>
  );
}

function Dash({ title }: { title: string }) {
  return (
    <span className="ds-mono" style={{ color: 'var(--cp-text-l)' }} title={title}>
      —
    </span>
  );
}
