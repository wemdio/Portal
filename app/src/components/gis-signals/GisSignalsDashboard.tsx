'use client';

/**
 * Дашборд «2GIS + сигналы» — отчётность outreach-пайплайна для одного клиента.
 *
 * Данные — два GET-эндпоинта (оба гейтятся: чужим 404):
 *   /api/client/gis-signals         — сегменты + перформанс кампаний Instantly;
 *   /api/client/gis-signals/report  — периодная отчётность (воронка с дельтами,
 *                                     срез 16 сигналов, грейды A/B/C, недельный
 *                                     отчёт, остаток пула).
 *
 * Блоки:
 *   01 — заголовок + период-селектор (7 дней / 30 дней / всё время / свои даты);
 *   02 — воронка за выбранный период по сегментам + дельты к предыдущему
 *        равному интервалу (у «всё время» дельт нет);
 *   03 — перформанс кампаний Instantly (allTime + строка «за 7 дней»);
 *   04 — срез по 16 сигналам × сегментам за период;
 *   05 — грейды A/B/C + hit-rate сигналов за период (скоринг-сегменты, legal);
 *   06 — недельный отчёт (пн–вс МСК, «эта/прошлая»): воронка + дельта,
 *        залито из журнала Portal, кампании недели, грейды, остаток пула, CSV;
 *   07 — остаток пула по сегментам (processed |seen ∪ archive| vs оценка 2GIS).
 *
 * Стили — как у остальных страниц клиентского портала: neu-card, ds-eyebrow,
 * ds-mono/tabular-nums для чисел, CSS-переменные --cp-*.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, Download, Loader2, RefreshCw } from 'lucide-react';
import { clientApiFetch } from '@/lib/clientFetcher';

// ───────────────────────── types (зеркала ответов API) ─────────────────────────

interface GisSignalFunnelRow {
  runDate: string;
  segmentKey: string;
  pulled: number;
  signalsOk: number;
  /** Прошли online-гейт. Может отсутствовать в старых прогонах → fallback на signalsOk. */
  onlineOk?: number;
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
  | 'signal_multi_office'
  | 'signal_legal_relevance'
  | 'signal_crm_calltracking'
  | 'signal_accounting_relevance'
  | 'signal_consulting_relevance'
  | 'signal_pricing_packages'
  | 'signal_client_segments'
  | 'signal_medicine_relevance'
  | 'signal_medicine_promo'
  | 'signal_medicine_premium'
  | 'signal_medicine_marketing_team';

interface SegmentStats {
  segmentKey: string;
  companies: number;
  signalHits: Partial<Record<GisSignalKey, number>>;
  scored: number;
  gradeA: number;
  gradeB: number;
  gradeC: number;
  rejected: number;
  medianScore: number | null;
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

interface GisSignalsMainResponse {
  segments: SegmentInfo[];
  campaigns: CampaignEntry[];
}

interface WeeklyAppendedRow {
  segmentKey: string;
  label: string;
  campaignId: string;
  requested: number;
  accepted: number;
  skipped: number;
}

interface PoolRow {
  segmentKey: string;
  processed: number;
  poolEstimate: number | null;
  remaining: number | null;
  weeklyConsumption: number | null;
  weeksLeft: number | null;
}

interface GisSignalsReportResponse {
  period: {
    preset: '7d' | '30d' | 'all' | 'custom';
    from: string | null;
    to: string | null;
    days: number | null;
  };
  funnel: GisSignalFunnelRow[];
  funnelPrev: GisSignalFunnelRow[] | null;
  stats: SegmentStats[];
  weekly: {
    weekId: 'current' | 'previous';
    weekStart: string;
    weekEnd: string;
    funnel: GisSignalFunnelRow[];
    funnelPrev: GisSignalFunnelRow[];
    stats: SegmentStats[];
    appended: WeeklyAppendedRow[];
    campaignWindow: Array<{ segmentKey: string; label: string; window: CampaignWindowTotals | null }>;
  };
  pool: PoolRow[];
}

// ───────────────────────── константы ─────────────────────────

/** Порядок и русские подписи 16 сигналов — фиксированы, не зависят от выборки. */
const SIGNAL_ROWS: Array<{ key: GisSignalKey; label: string }> = [
  { key: 'signal_general_phone', label: 'Общий телефон / колл-центр' },
  { key: 'signal_contact_form', label: 'Форма заявки / обратной связи' },
  { key: 'signal_sales_dept', label: 'Отдел продаж / приемная / call-центр' },
  { key: 'signal_target_vacancy', label: 'Вакансии: менеджер продаж или оператор call-центра' },
  { key: 'signal_high_volume', label: 'Признак большого потока' },
  { key: 'signal_multi_office', label: 'Несколько офисов / филиалов' },
  { key: 'signal_legal_relevance', label: 'Юридическая релевантность сайта' },
  { key: 'signal_crm_calltracking', label: 'CRM / коллтрекинг / речевая аналитика' },
  { key: 'signal_accounting_relevance', label: 'Бухгалтерская релевантность сайта' },
  { key: 'signal_consulting_relevance', label: 'Консалтинговая релевантность сайта' },
  { key: 'signal_pricing_packages', label: 'Калькулятор / тарифы / пакеты обслуживания' },
  { key: 'signal_client_segments', label: 'Работа с ИП / ООО / МСБ' },
  { key: 'signal_medicine_relevance', label: 'Частная клиника / медцентр / сеть' },
  { key: 'signal_medicine_promo', label: 'Акции / посадочные / спецпредложения' },
  { key: 'signal_medicine_premium', label: 'Имплантация / хирургия / диагностика' },
  { key: 'signal_medicine_marketing_team', label: 'Маркетинговая команда / агентство' },
];

type PeriodPreset = '7d' | '30d' | 'all' | 'custom';

const PERIOD_OPTIONS: Array<{ id: PeriodPreset; label: string }> = [
  { id: '7d', label: '7 дней' },
  { id: '30d', label: '30 дней' },
  { id: 'all', label: 'Всё время' },
  { id: 'custom', label: 'Свои даты' },
];

type PeriodQuery =
  | { preset: '7d' | '30d' | 'all' }
  | { preset: 'custom'; from: string; to: string };

const FUNNEL_COLUMNS = [
  'Сегмент', 'Отобрано', 'С сигналами', 'Онлайн', 'В конструктор', 'Валидных контактов', 'Залито в Instantly',
] as const;

interface FunnelTotals {
  pulled: number;
  signalsOk: number;
  onlineOk: number;
  bcIn: number;
  validContacts: number;
  appended: number;
}

const EMPTY_TOTALS: FunnelTotals = { pulled: 0, signalsOk: 0, onlineOk: 0, bcIn: 0, validContacts: 0, appended: 0 };

// ───────────────────────── helpers ─────────────────────────

function fmt(n: number): string {
  return n.toLocaleString('ru-RU');
}

/** Дробные метрики (медианы, прогноз в неделях) — с запятой, без хвоста. */
function fmtFraction(n: number): string {
  return n.toLocaleString('ru-RU', { maximumFractionDigits: 1 });
}

/** onlineOk с fallback на signalsOk для старых прогонов без online-гейта. */
function onlineOkOf(row: GisSignalFunnelRow): number {
  return Number(row.onlineOk ?? row.signalsOk) || 0;
}

function sumFunnel(rows: GisSignalFunnelRow[], segmentKey: string): FunnelTotals {
  const totals = { ...EMPTY_TOTALS };
  for (const r of rows) {
    if (r.segmentKey !== segmentKey) continue;
    totals.pulled += Number(r.pulled) || 0;
    totals.signalsOk += Number(r.signalsOk) || 0;
    totals.onlineOk += onlineOkOf(r);
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
    totals.onlineOk += onlineOkOf(r);
    totals.bcIn += Number(r.bcIn) || 0;
    totals.validContacts += Number(r.validContacts) || 0;
    totals.appended += Number(r.appended) || 0;
  }
  return totals;
}

function deltaTotals(cur: FunnelTotals, prev: FunnelTotals): FunnelTotals {
  return {
    pulled: cur.pulled - prev.pulled,
    signalsOk: cur.signalsOk - prev.signalsOk,
    onlineOk: cur.onlineOk - prev.onlineOk,
    bcIn: cur.bcIn - prev.bcIn,
    validContacts: cur.validContacts - prev.validContacts,
    appended: cur.appended - prev.appended,
  };
}

function pct(part: number, total: number): string | null {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return null;
  return `${((part / total) * 100).toFixed(1)}%`;
}

/** '2026-08-10' → '10.08.2026'. */
function ruDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

function localIsoDay(d: Date): string {
  return d.toLocaleDateString('en-CA');
}

/** Подпись периода для подзаголовков блоков. */
function periodCaption(period: GisSignalsReportResponse['period']): string {
  if (period.preset === 'all' || !period.from || !period.to) return 'за всё время';
  return `${ruDate(period.from)} — ${ruDate(period.to)} (МСК)`;
}

/** Подпись предыдущего интервала для дельт. */
function prevCaption(period: GisSignalsReportResponse['period']): string {
  if (period.days === null) return '';
  if (period.days === 7) return 'к предыдущим 7 дням';
  if (period.days === 30) return 'к предыдущим 30 дням';
  return `к предыдущим ${period.days} дн.`;
}

// ───────────────────────── CSV ─────────────────────────

function csvEscape(value: string | number): string {
  const s = String(value);
  return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvRow(cells: Array<string | number>): string {
  return cells.map(csvEscape).join(';');
}

function csvNum(n: number | null | undefined): string | number {
  if (n === null || n === undefined) return '—';
  return String(n).replace('.', ',');
}

/** Клиентский CSV недельного отчёта из уже полученного JSON (без серверного экспорта). */
function buildWeeklyCsv(report: GisSignalsReportResponse, segments: Array<{ key: string; label: string }>): string {
  const w = report.weekly;
  const lines: string[] = [];
  const segLabel = (key: string) => segments.find((s) => s.key === key)?.label ?? key;

  lines.push(csvRow(['Недельный отчёт «2GIS + сигналы»', `${ruDate(w.weekStart)} — ${ruDate(w.weekEnd)} (пн–вс, МСК)`]));
  lines.push('');

  lines.push(csvRow(['Воронка недели']));
  lines.push(csvRow([...FUNNEL_COLUMNS]));
  const prevTotals = new Map<string, FunnelTotals>();
  for (const seg of segments) prevTotals.set(seg.key, sumFunnel(w.funnelPrev, seg.key));
  for (const seg of segments) {
    const t = sumFunnel(w.funnel, seg.key);
    lines.push(csvRow([seg.label, t.pulled, t.signalsOk, t.onlineOk, t.bcIn, t.validContacts, t.appended]));
  }
  const tot = sumFunnelAll(w.funnel);
  lines.push(csvRow(['Итого', tot.pulled, tot.signalsOk, tot.onlineOk, tot.bcIn, tot.validContacts, tot.appended]));
  lines.push('');

  lines.push(csvRow(['Воронка прошлой недели (для сравнения)']));
  lines.push(csvRow([...FUNNEL_COLUMNS]));
  for (const seg of segments) {
    const t = prevTotals.get(seg.key) ?? { ...EMPTY_TOTALS };
    lines.push(csvRow([seg.label, t.pulled, t.signalsOk, t.onlineOk, t.bcIn, t.validContacts, t.appended]));
  }
  const prevTot = sumFunnelAll(w.funnelPrev);
  lines.push(csvRow(['Итого', prevTot.pulled, prevTot.signalsOk, prevTot.onlineOk, prevTot.bcIn, prevTot.validContacts, prevTot.appended]));
  lines.push('');

  lines.push(csvRow(['Залито контактов за неделю (журнал Portal, не зависит от чистки Instantly)']));
  lines.push(csvRow(['Сегмент', 'Запрошено', 'Принято', 'Пропущено']));
  for (const row of w.appended) {
    lines.push(csvRow([row.label, row.requested, row.accepted, row.skipped]));
  }
  lines.push('');

  lines.push(csvRow(['Кампании за неделю (Instantly)']));
  lines.push(csvRow(['Сегмент', 'Отправлено', 'Открытия', 'Открытия %', 'Ответы', 'Ответы %']));
  for (const c of w.campaignWindow) {
    const win = c.window;
    lines.push(csvRow([
      c.label,
      win ? win.emailsSent : '—',
      win ? win.openCount : '—',
      win ? pct(win.openCount, win.emailsSent) ?? '—' : '—',
      win ? win.replyCount : '—',
      win ? pct(win.replyCount, win.emailsSent) ?? '—' : '—',
    ]));
  }
  lines.push('');

  lines.push(csvRow(['Грейды недели']));
  lines.push(csvRow(['Сегмент', 'Проверено', 'A', 'B', 'C', 'Отсев', 'Медианный скор']));
  for (const seg of segments) {
    const st = w.stats.find((s) => s.segmentKey === seg.key);
    if (!st || st.scored === 0) {
      lines.push(csvRow([seg.label, st?.companies ?? 0, '—', '—', '—', '—', '—']));
    } else {
      lines.push(csvRow([seg.label, st.companies, st.gradeA, st.gradeB, st.gradeC, st.rejected, csvNum(st.medianScore)]));
    }
  }
  lines.push('');

  lines.push(csvRow(['Остаток пула (снимок на момент выгрузки)']));
  lines.push(csvRow(['Сегмент', 'Обработано за всё время', 'Оценка пула 2GIS', 'Остаток', 'Потребление в неделю', 'Недель осталось']));
  for (const p of report.pool) {
    lines.push(csvRow([
      segLabel(p.segmentKey),
      p.processed,
      csvNum(p.poolEstimate),
      csvNum(p.remaining),
      csvNum(p.weeklyConsumption),
      csvNum(p.weeksLeft),
    ]));
  }

  // BOM — чтобы Excel корректно открыл UTF-8 с кириллицей.
  return '\uFEFF' + lines.join('\r\n');
}

function downloadCsv(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ───────────────────────── page component ─────────────────────────

export function GisSignalsDashboard() {
  const [main, setMain] = useState<GisSignalsMainResponse | null>(null);
  const [mainError, setMainError] = useState('');
  const [mainReloadKey, setMainReloadKey] = useState(0);
  const retryMain = useCallback(() => setMainReloadKey((k) => k + 1), []);

  const [report, setReport] = useState<GisSignalsReportResponse | null>(null);
  const [reportError, setReportError] = useState('');
  const [reportRefreshing, setReportRefreshing] = useState(false);
  const [reportReloadKey, setReportReloadKey] = useState(0);
  const retryReport = useCallback(() => setReportReloadKey((k) => k + 1), []);

  // Какая кнопка периода подсвечена vs какой период реально запрошен
  // (при «Свои даты» запрос уходит только после «Применить»).
  const [uiPreset, setUiPreset] = useState<PeriodPreset>('7d');
  const [periodQuery, setPeriodQuery] = useState<PeriodQuery>({ preset: '7d' });
  const [draftFrom, setDraftFrom] = useState(() => localIsoDay(new Date(Date.now() - 6 * 86_400_000)));
  const [draftTo, setDraftTo] = useState(() => localIsoDay(new Date()));
  const [dateError, setDateError] = useState('');
  const today = useMemo(() => localIsoDay(new Date()), []);

  const [week, setWeek] = useState<'current' | 'previous'>('current');

  // ── main fetch (сегменты + кампании) ──────────────────────
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (cancelled) return;
      setMainError('');
      try {
        const res = await clientApiFetch<GisSignalsMainResponse>('/gis-signals');
        if (!cancelled) setMain(res);
      } catch {
        if (cancelled) return;
        setMain(null);
        setMainError('Не удалось загрузить отчётность. Проверьте подключение и повторите.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mainReloadKey]);

  // ── report fetch (период + неделя) ────────────────────────
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (cancelled) return;
      setReportError('');
      setReportRefreshing(true);
      try {
        const params = new URLSearchParams({ period: periodQuery.preset, week });
        if (periodQuery.preset === 'custom') {
          params.set('from', periodQuery.from);
          params.set('to', periodQuery.to);
        }
        const res = await clientApiFetch<GisSignalsReportResponse>(`/gis-signals/report?${params.toString()}`);
        if (!cancelled) setReport(res);
      } catch {
        if (cancelled) return;
        setReport(null);
        setReportError('Не удалось загрузить отчёт за период. Проверьте подключение и повторите.');
      } finally {
        if (!cancelled) setReportRefreshing(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [periodQuery, week, reportReloadKey]);

  // Порядок сегментов — как в конфиге; сегменты, встретившиеся только в данных
  // (нет строки в gis_signal_segments), дописываем в конец с label = key.
  const segmentOrder = useMemo(() => {
    if (!main) return [] as Array<{ key: string; label: string }>;
    const order = main.segments.map((s) => ({ key: s.key, label: s.label }));
    const known = new Set(order.map((s) => s.key));
    const extra = new Set<string>();
    for (const r of [...(report?.funnel ?? []), ...(report?.stats ?? []), ...(report?.pool ?? [])]) {
      if (!known.has(r.segmentKey)) extra.add(r.segmentKey);
    }
    for (const key of extra) order.push({ key, label: key });
    return order;
  }, [main, report]);

  const statsBySegment = useMemo(() => {
    const map = new Map<string, SegmentStats>();
    for (const s of report?.stats ?? []) map.set(s.segmentKey, s);
    return map;
  }, [report]);

  const poolBySegment = useMemo(() => {
    const map = new Map<string, PoolRow>();
    for (const p of report?.pool ?? []) map.set(p.segmentKey, p);
    return map;
  }, [report]);

  const periodTotals = useMemo(
    () => (report ? sumFunnelAll(report.funnel) : EMPTY_TOTALS),
    [report],
  );
  const periodPrevTotals = useMemo(
    () => (report?.funnelPrev ? sumFunnelAll(report.funnelPrev) : null),
    [report],
  );

  // ── обработчики ──────────────────────────────────────────

  function choosePreset(preset: PeriodPreset) {
    setUiPreset(preset);
    setDateError('');
    if (preset !== 'custom') setPeriodQuery({ preset });
  }

  function applyCustomDates() {
    if (!draftFrom || !draftTo) {
      setDateError('Укажите обе даты');
      return;
    }
    if (draftFrom > draftTo) {
      setDateError('Дата «С» не должна быть позже даты «По»');
      return;
    }
    setDateError('');
    setPeriodQuery({ preset: 'custom', from: draftFrom, to: draftTo });
  }

  // ── loading / error ──────────────────────────────────────

  if (mainError) {
    return (
      <div className="mx-auto max-w-5xl">
        <div className="neu-card px-5 py-6 flex items-start gap-3" role="alert">
          <AlertCircle
            className="h-5 w-5 shrink-0 mt-0.5"
            style={{ color: 'var(--cp-paper-faint)' }}
            aria-hidden
          />
          <span className="flex-1 text-sm" style={{ color: 'var(--cp-paper)' }}>
            {mainError}
          </span>
          <button
            type="button"
            onClick={retryMain}
            className="ds-btn-secondary px-3 py-1 text-xs inline-flex items-center gap-1.5"
          >
            <RefreshCw className="h-3 w-3" aria-hidden />
            Повторить
          </button>
        </div>
      </div>
    );
  }

  if (!main) {
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

  const reportLoading = !report && !reportError;

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

        {/* Период-селектор: воронка (02), срез (04) и грейды (05) */}
        <div className="mt-4 flex flex-wrap items-center gap-2" role="group" aria-label="Период">
          {PERIOD_OPTIONS.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={uiPreset === item.id}
              className={`${uiPreset === item.id ? 'ds-btn-primary' : 'ds-btn-secondary'} whitespace-nowrap`}
              onClick={() => choosePreset(item.id)}
            >
              {item.label}
            </button>
          ))}
          {reportRefreshing && (
            <span className="ds-mono text-[11px] inline-flex items-center gap-1.5" role="status" style={{ color: 'var(--cp-paper-faint)' }}>
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
              Обновляем…
            </span>
          )}
        </div>
        {uiPreset === 'custom' && (
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label className="text-xs" style={{ color: 'var(--cp-paper-mute)' }}>
              <span className="mb-1.5 block">С</span>
              <input
                className="ds-input"
                type="date"
                value={draftFrom}
                max={today}
                onChange={(event) => setDraftFrom(event.target.value)}
              />
            </label>
            <label className="text-xs" style={{ color: 'var(--cp-paper-mute)' }}>
              <span className="mb-1.5 block">По</span>
              <input
                className="ds-input"
                type="date"
                value={draftTo}
                max={today}
                onChange={(event) => setDraftTo(event.target.value)}
              />
            </label>
            <button type="button" className="ds-btn-secondary" onClick={applyCustomDates}>
              Применить
            </button>
            {dateError && (
              <p className="w-full text-xs" role="alert" style={{ color: 'var(--cp-red)' }}>
                {dateError}
              </p>
            )}
          </div>
        )}
      </header>

      {reportError && (
        <div className="neu-card px-5 py-6 flex items-start gap-3" role="alert">
          <AlertCircle
            className="h-5 w-5 shrink-0 mt-0.5"
            style={{ color: 'var(--cp-paper-faint)' }}
            aria-hidden
          />
          <span className="flex-1 text-sm" style={{ color: 'var(--cp-paper)' }}>
            {reportError}
          </span>
          <button
            type="button"
            onClick={retryReport}
            className="ds-btn-secondary px-3 py-1 text-xs inline-flex items-center gap-1.5"
          >
            <RefreshCw className="h-3 w-3" aria-hidden />
            Повторить
          </button>
        </div>
      )}

      {/* 02 → Воронка за период */}
      <section aria-labelledby="gis-funnel-label">
        <h2 id="gis-funnel-label" className="ds-eyebrow mb-3">
          02<span aria-hidden> → </span>Воронка{report ? ` · ${periodCaption(report.period)}` : ''}
        </h2>

        {reportLoading ? (
          <CardLoader />
        ) : report && report.funnel.length === 0 ? (
          <EmptyCard
            title="За выбранный период прогонов не было"
            hint="Как только пайплайн отработает, здесь появится воронка по сегментам."
          />
        ) : report ? (
          <>
            <div className="neu-card overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    {FUNNEL_COLUMNS.map((h, i) => (
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
                  {segmentOrder.map((seg) => {
                    const t = sumFunnel(report.funnel, seg.key);
                    const d = report.funnelPrev
                      ? deltaTotals(t, sumFunnel(report.funnelPrev, seg.key))
                      : null;
                    return (
                      <tr
                        key={seg.key}
                        style={{ borderTop: '1px solid var(--cp-row-divider, rgba(180,173,164,0.18))' }}
                      >
                        <td className="px-4 sm:px-5 py-3 font-bold" style={{ color: 'var(--cp-text)' }}>
                          {seg.label}
                        </td>
                        <NumCell value={t.pulled} delta={d?.pulled} />
                        <NumCell value={t.signalsOk} delta={d?.signalsOk} />
                        <NumCell value={t.onlineOk} delta={d?.onlineOk} />
                        <NumCell value={t.bcIn} delta={d?.bcIn} />
                        <NumCell value={t.validContacts} delta={d?.validContacts} />
                        <NumCell value={t.appended} delta={d?.appended} />
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-xs mt-2" style={{ color: 'var(--cp-paper-mute)' }}>
              Итого за период: отобрано{' '}
              <Mono>{fmt(periodTotals.pulled)}</Mono>
              {' · с сигналами '}
              <Mono>{fmt(periodTotals.signalsOk)}</Mono>
              {' · онлайн '}
              <Mono>{fmt(periodTotals.onlineOk)}</Mono>
              {' · в конструктор '}
              <Mono>{fmt(periodTotals.bcIn)}</Mono>
              {' · валидных контактов '}
              <Mono>{fmt(periodTotals.validContacts)}</Mono>
              {' · залито в Instantly '}
              <Mono>{fmt(periodTotals.appended)}</Mono>
              {periodPrevTotals && (
                <>
                  {' · Δ '}
                  <DeltaInline value={periodTotals.pulled - periodPrevTotals.pulled} />
                  <span className="sr-only">к предыдущему равному периоду по «отобрано»</span>
                </>
              )}
            </p>
            {report.funnelPrev && (
              <p className="text-xs mt-1" style={{ color: 'var(--cp-text-l)' }}>
                Δ — {prevCaption(report.period)} по каждой метрике.
              </p>
            )}
          </>
        ) : null}
      </section>

      {/* 03 → Перформанс кампаний Instantly */}
      <section aria-labelledby="gis-campaigns-label">
        <h2 id="gis-campaigns-label" className="ds-eyebrow mb-3">
          03<span aria-hidden> → </span>Кампании в Instantly
        </h2>

        {main.campaigns.length === 0 ? (
          <EmptyCard
            title="Кампании ещё не привязаны"
            hint="Когда у сегментов появятся кампании в Instantly, метрики покажутся здесь."
          />
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
                {main.campaigns.map((c) => {
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

      {/* 04 → Срез по сигналам за период */}
      <section aria-labelledby="gis-slice-label">
        <h2 id="gis-slice-label" className="ds-eyebrow mb-3">
          04<span aria-hidden> → </span>Срез по сигналам{report ? ` · ${periodCaption(report.period)}` : ''}
        </h2>

        {reportLoading ? (
          <CardLoader />
        ) : report && report.stats.length === 0 ? (
          <EmptyCard
            title="За выбранный период проверок не было"
            hint="Срез появится после первых прогонов пайплайна в этом периоде."
          />
        ) : report ? (
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
                      <span className="block text-[10px] normal-case" style={{ color: 'var(--cp-text-l)' }}>
                        проверено: {fmt(statsBySegment.get(seg.key)?.companies ?? 0)}
                      </span>
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
                        value={statsBySegment.get(seg.key)?.signalHits[sig.key] ?? 0}
                      />
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      {/* 05 → Грейды A/B/C за период */}
      <section aria-labelledby="gis-grades-label">
        <h2 id="gis-grades-label" className="ds-eyebrow mb-3">
          05<span aria-hidden> → </span>Грейды A/B/C{report ? ` · ${periodCaption(report.period)}` : ''}
        </h2>

        {reportLoading ? (
          <CardLoader />
        ) : report ? (
          <>
            <div className="neu-card overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    {['Сегмент', 'Проверено', 'A', 'B', 'C', 'Отсев', 'Медианный скор'].map((h, i) => (
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
                  {segmentOrder.map((seg) => {
                    const st = statsBySegment.get(seg.key);
                    const scored = (st?.scored ?? 0) > 0;
                    return (
                      <tr
                        key={seg.key}
                        style={{ borderTop: '1px solid var(--cp-row-divider, rgba(180,173,164,0.18))' }}
                      >
                        <td className="px-4 sm:px-5 py-3 font-bold" style={{ color: 'var(--cp-text)' }}>
                          {seg.label}
                        </td>
                        <NumCell value={st?.companies ?? 0} />
                        {scored && st ? (
                          <>
                            <NumCell value={st.gradeA} />
                            <NumCell value={st.gradeB} />
                            <NumCell value={st.gradeC} />
                            <NumCell value={st.rejected} />
                            <td className="px-4 sm:px-5 py-3 text-right">
                              <span className="ds-mono tabular-nums" style={{ color: 'var(--cp-text)' }}>
                                {st.medianScore !== null ? fmtFraction(st.medianScore) : '—'}
                              </span>
                            </td>
                          </>
                        ) : (
                          <td className="px-4 sm:px-5 py-3 text-right" colSpan={5}>
                            <Dash title="Сегмент без скоринг-профиля — грейды не ведутся" />
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-xs mt-2" style={{ color: 'var(--cp-text-l)' }}>
              Скоринг ведут только сегменты с профилем (юристы, бухгалтерия, консалтинг, медицина), у остальных — «—».
              Отсев — скор ниже порога профиля (компания проверена, но нерелевантна).
            </p>

            {/* Hit-rate каждого из 16 сигналов в сегментном разрезе */}
            <div className="neu-card overflow-x-auto mt-4">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <th className="ds-eyebrow text-left px-4 sm:px-5 py-3 font-normal">Hit-rate сигнала</th>
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
                      {segmentOrder.map((seg) => {
                        const st = statsBySegment.get(seg.key);
                        const hits = st?.signalHits[sig.key] ?? 0;
                        const companies = st?.companies ?? 0;
                        const rate = pct(hits, companies);
                        return (
                          <td key={seg.key} className="px-4 sm:px-5 py-3 text-right">
                            {rate !== null ? (
                              <span
                                className="ds-mono tabular-nums"
                                style={{ color: 'var(--cp-text)' }}
                                title={`${fmt(hits)} из ${fmt(companies)}`}
                              >
                                {rate}
                              </span>
                            ) : (
                              <Dash title="Нет проверок за период" />
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}
      </section>

      {/* 06 → Недельный отчёт */}
      <section aria-labelledby="gis-weekly-label">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <h2 id="gis-weekly-label" className="ds-eyebrow m-0">
            06<span aria-hidden> → </span>Недельный отчёт
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex gap-2" role="group" aria-label="Неделя">
              {([
                { id: 'current', label: 'Эта неделя' },
                { id: 'previous', label: 'Прошлая неделя' },
              ] as const).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={week === item.id}
                  className={`${week === item.id ? 'ds-btn-primary' : 'ds-btn-secondary'} whitespace-nowrap`}
                  onClick={() => setWeek(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="ds-btn-secondary inline-flex items-center gap-1.5"
              disabled={!report}
              onClick={() => {
                if (!report) return;
                downloadCsv(
                  `gis-signals-week-${report.weekly.weekStart}.csv`,
                  buildWeeklyCsv(report, segmentOrder),
                );
              }}
            >
              <Download className="h-3.5 w-3.5" aria-hidden />
              Скачать CSV
            </button>
          </div>
        </div>
        {report && (
          <p className="text-xs mb-3" style={{ color: 'var(--cp-paper-mute)' }}>
            {ruDate(report.weekly.weekStart)} — {ruDate(report.weekly.weekEnd)} (пн–вс, МСК)
          </p>
        )}

        {reportLoading ? (
          <CardLoader />
        ) : report ? (
          <div className="space-y-4">
            {/* (а) воронка недели + дельта к прошлой */}
            <div>
              <h3 className="ds-eyebrow mb-2 text-[11px]">Воронка недели</h3>
              <div className="neu-card overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr>
                      {FUNNEL_COLUMNS.map((h, i) => (
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
                    {segmentOrder.map((seg) => {
                      const t = sumFunnel(report.weekly.funnel, seg.key);
                      const d = deltaTotals(t, sumFunnel(report.weekly.funnelPrev, seg.key));
                      return (
                        <tr
                          key={seg.key}
                          style={{ borderTop: '1px solid var(--cp-row-divider, rgba(180,173,164,0.18))' }}
                        >
                          <td className="px-4 sm:px-5 py-3 font-bold" style={{ color: 'var(--cp-text)' }}>
                            {seg.label}
                          </td>
                          <NumCell value={t.pulled} delta={d.pulled} />
                          <NumCell value={t.signalsOk} delta={d.signalsOk} />
                          <NumCell value={t.onlineOk} delta={d.onlineOk} />
                          <NumCell value={t.bcIn} delta={d.bcIn} />
                          <NumCell value={t.validContacts} delta={d.validContacts} />
                          <NumCell value={t.appended} delta={d.appended} />
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="text-xs mt-1" style={{ color: 'var(--cp-text-l)' }}>
                Δ — к предыдущей календарной неделе по каждой метрике.
              </p>
            </div>

            {/* (б) залито контактов из журнала Portal */}
            <div>
              <h3 className="ds-eyebrow mb-2 text-[11px]">Залито контактов за неделю</h3>
              <div className="neu-card overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr>
                      {['Сегмент', 'Запрошено', 'Принято', 'Пропущено'].map((h, i) => (
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
                    {report.weekly.appended.map((row) => (
                      <tr
                        key={row.campaignId}
                        style={{ borderTop: '1px solid var(--cp-row-divider, rgba(180,173,164,0.18))' }}
                      >
                        <td className="px-4 sm:px-5 py-3 font-bold" style={{ color: 'var(--cp-text)' }}>
                          {row.label}
                        </td>
                        <NumCell value={row.requested} />
                        <NumCell value={row.accepted} />
                        <NumCell value={row.skipped} />
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-xs mt-1" style={{ color: 'var(--cp-text-l)' }}>
                Факты заливок из журнала Portal — не зависят от чистки лидов в Instantly.
              </p>
            </div>

            {/* (в) кампании недели: отправки/открытия/ответы */}
            <div>
              <h3 className="ds-eyebrow mb-2 text-[11px]">Кампании за неделю (Instantly)</h3>
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
                    {report.weekly.campaignWindow.map((c) => {
                      const win = c.window;
                      const openPct = win ? pct(win.openCount, win.emailsSent) : null;
                      const replyPct = win ? pct(win.replyCount, win.emailsSent) : null;
                      return (
                        <tr
                          key={c.segmentKey}
                          style={{ borderTop: '1px solid var(--cp-row-divider, rgba(180,173,164,0.18))' }}
                        >
                          <td className="px-4 sm:px-5 py-3 font-bold" style={{ color: 'var(--cp-text)' }}>
                            {c.label}
                          </td>
                          <td className="px-4 sm:px-5 py-3 text-right">
                            {win ? (
                              <span className="ds-mono tabular-nums" style={{ color: 'var(--cp-text)' }}>
                                {fmt(win.emailsSent)}
                              </span>
                            ) : (
                              <Dash title="Нет данных Instantly за неделю" />
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
            </div>

            {/* (г) грейды недели */}
            <div>
              <h3 className="ds-eyebrow mb-2 text-[11px]">Грейды недели</h3>
              {report.weekly.stats.some((s) => s.scored > 0) ? (
                <div className="neu-card overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr>
                        {['Сегмент', 'Проверено', 'A', 'B', 'C', 'Отсев', 'Медианный скор'].map((h, i) => (
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
                      {segmentOrder.map((seg) => {
                        const st = report.weekly.stats.find((s) => s.segmentKey === seg.key);
                        if (!st) return null;
                        const scored = st.scored > 0;
                        return (
                          <tr
                            key={seg.key}
                            style={{ borderTop: '1px solid var(--cp-row-divider, rgba(180,173,164,0.18))' }}
                          >
                            <td className="px-4 sm:px-5 py-3 font-bold" style={{ color: 'var(--cp-text)' }}>
                              {seg.label}
                            </td>
                            <NumCell value={st.companies} />
                            {scored ? (
                              <>
                                <NumCell value={st.gradeA} />
                                <NumCell value={st.gradeB} />
                                <NumCell value={st.gradeC} />
                                <NumCell value={st.rejected} />
                                <td className="px-4 sm:px-5 py-3 text-right">
                                  <span className="ds-mono tabular-nums" style={{ color: 'var(--cp-text)' }}>
                                    {st.medianScore !== null ? fmtFraction(st.medianScore) : '—'}
                                  </span>
                                </td>
                              </>
                            ) : (
                              <td className="px-4 sm:px-5 py-3 text-right" colSpan={5}>
                                <Dash title="Сегмент без скоринг-профиля" />
                              </td>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="neu-card px-5 py-4">
                  <p className="text-xs" style={{ color: 'var(--cp-text-m)' }}>
                    За эту неделю скоринг не проводился (нет проверенных компаний в скоринг-сегментах).
                  </p>
                </div>
              )}
            </div>

            {/* (д) остаток пула — компактно, подробности в блоке 07 */}
            <div>
              <h3 className="ds-eyebrow mb-2 text-[11px]">Остаток пула</h3>
              <div className="neu-card px-5 py-4">
                <ul className="space-y-1.5 text-sm" style={{ color: 'var(--cp-text-m)' }}>
                  {report.pool.map((p) => {
                    const label = segmentOrder.find((s) => s.key === p.segmentKey)?.label ?? p.segmentKey;
                    return (
                      <li key={p.segmentKey} className="flex flex-wrap items-baseline gap-x-2">
                        <span className="font-bold" style={{ color: 'var(--cp-text)' }}>{label}</span>
                        {p.remaining !== null ? (
                          <span className="ds-mono tabular-nums" style={{ color: 'var(--cp-text)' }}>
                            ≈{fmt(p.remaining)} шт.{p.weeksLeft !== null ? ` · хватит на ~${fmtFraction(p.weeksLeft)} нед.` : ''}
                          </span>
                        ) : (
                          <Dash title="Не удалось оценить пул — см. блок 07" />
                        )}
                      </li>
                    );
                  })}
                </ul>
                <p className="text-xs mt-2" style={{ color: 'var(--cp-text-l)' }}>
                  Снимок на сейчас, не зависит от выбранной недели. Подробности — в блоке 07 ниже.
                </p>
              </div>
            </div>
          </div>
        ) : null}
      </section>

      {/* 07 → Остаток пула по сегментам */}
      <section aria-labelledby="gis-pool-label">
        <h2 id="gis-pool-label" className="ds-eyebrow mb-3">
          07<span aria-hidden> → </span>Остаток пула по сегментам
        </h2>

        {reportLoading ? (
          <CardLoader />
        ) : report ? (
          <>
            <div className="neu-card overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    {['Сегмент', 'Обработано за всё время', 'Оценка пула 2GIS', 'Остаток', 'Темп, комп./нед.', 'Хватит на'].map((h, i) => (
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
                  {segmentOrder.map((seg) => {
                    const p = poolBySegment.get(seg.key);
                    return (
                      <tr
                        key={seg.key}
                        style={{ borderTop: '1px solid var(--cp-row-divider, rgba(180,173,164,0.18))' }}
                      >
                        <td className="px-4 sm:px-5 py-3 font-bold" style={{ color: 'var(--cp-text)' }}>
                          {seg.label}
                        </td>
                        <NumCell value={p?.processed ?? 0} />
                        <td className="px-4 sm:px-5 py-3 text-right">
                          {p?.poolEstimate != null ? (
                            <span
                              className="ds-mono tabular-nums"
                              style={{ color: 'var(--cp-text)' }}
                              title="COUNT карточек 2GIS с сайтом по рубрикам сегмента"
                            >
                              ≈{fmt(p.poolEstimate)}
                            </span>
                          ) : (
                            <Dash title="Не удалось оценить: датасет 2GIS недоступен или ответил таймаутом" />
                          )}
                        </td>
                        <td className="px-4 sm:px-5 py-3 text-right">
                          {p?.remaining != null ? (
                            <span className="ds-mono tabular-nums" style={{ color: 'var(--cp-text)' }}>
                              ≈{fmt(p.remaining)}
                            </span>
                          ) : (
                            <Dash title="Нет оценки пула" />
                          )}
                        </td>
                        <td className="px-4 sm:px-5 py-3 text-right">
                          {p?.weeklyConsumption != null ? (
                            <span className="ds-mono tabular-nums" style={{ color: 'var(--cp-text)' }}>
                              {fmt(p.weeklyConsumption)}
                            </span>
                          ) : (
                            <Dash title="Сегмент выключен — квота не расходуется" />
                          )}
                        </td>
                        <td className="px-4 sm:px-5 py-3 text-right">
                          {p?.weeksLeft != null ? (
                            <span className="ds-mono tabular-nums" style={{ color: 'var(--cp-text)' }}>
                              ~{fmtFraction(p.weeksLeft)} нед.
                            </span>
                          ) : (
                            <Dash title="Прогноз недоступен" />
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-xs mt-2" style={{ color: 'var(--cp-text-l)' }}>
              Обработано = залитые компании ∪ архив проверок (без дублей). Оценка пула — COUNT карточек 2GIS
              с сайтом по рубрикам сегмента, кэшируется на 24 ч («≈» — это оценка, а не точный учёт).
              Прогноз = остаток / (дневная квота сегмента × 5 рабочих дней).
            </p>
          </>
        ) : null}
      </section>
    </div>
  );
}

// ── subcomponents ──────────────────────────────────────────

function NumCell({ value, delta }: { value: number; delta?: number | null }) {
  return (
    <td className="px-4 sm:px-5 py-3 text-right">
      <span className="ds-mono tabular-nums" style={{ color: 'var(--cp-text)' }}>
        {fmt(value)}
      </span>
      {delta !== undefined && delta !== null && <DeltaInline value={delta} block />}
    </td>
  );
}

/** Дельта к предыдущему равному периоду: +N зелёным, −N красным, ±0 приглушённо. */
function DeltaInline({ value, block = false }: { value: number; block?: boolean }) {
  const text = value > 0 ? `+${fmt(value)}` : value < 0 ? `−${fmt(-value)}` : '±0';
  const color =
    value > 0 ? 'var(--cp-green)' : value < 0 ? 'var(--cp-red)' : 'var(--cp-text-l)';
  return (
    <span
      className={`${block ? 'block ' : ''}text-[11px] ds-mono tabular-nums`}
      style={{ color }}
      title="Изменение к предыдущему равному периоду"
    >
      {block ? text : ` (${text})`}
    </span>
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

function EmptyCard({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="neu-card px-5 py-8 text-center">
      <p className="text-sm font-bold mb-1" style={{ color: 'var(--cp-text)' }}>
        {title}
      </p>
      <p className="text-xs" style={{ color: 'var(--cp-text-m)' }}>
        {hint}
      </p>
    </div>
  );
}

function CardLoader() {
  return (
    <div className="neu-card px-5 py-8 flex items-center justify-center">
      <Loader2
        className="h-4 w-4 animate-spin"
        style={{ color: 'var(--cp-paper-faint)' }}
        aria-hidden
      />
    </div>
  );
}
