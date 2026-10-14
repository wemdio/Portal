'use client';

import { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { companyEmailCell, extraCompanyEmails } from '@/lib/outreachEmail/companyEmails';
import { CHAIN_LABELS, DOUBT_LABELS, REASON_LABELS, SOURCE_LABELS, STAGES, type ChainType, type DoubtCode, type RuOutreachConfig, type SourceCode, type Stage } from '@/lib/polzaRuOutreach/types';
import { Chip, EvidenceCard, ScoreCard } from '@/components/outreach/run/parts';
import type { OutreachRowTone, OutreachRunAdapter, OutreachStageEntry } from '@/components/outreach/run/types';
import { LaunchPanel } from './LaunchPanel';
import { API, SIGNAL_LABELS, STATUS_LABELS, api, fmtDate, type RuJob, type RuRow } from './shared';

/**
 * Наш (русский) автоаутрич на общем экране запуска (components/outreach/run):
 * раскладка, таблица и доказательства — как у английского; шаги поиска,
 * столбцы и выгрузки — свои.
 */

/**
 * Шаги на экране — в порядке работы раннера (STAGES): почта до разбора ИИ,
 * сомнения до писем. Счётчик шага — воронка по его последнему ключу. Очень
 * спорная строка задержана на своём шаге, как отсеянная.
 */
const RU_STAGE_VIEW: Array<{ keys: Stage[]; label: string; hint: string }> = [
  { keys: ['candidates_loaded'], label: 'Кандидаты', hint: 'Компании из выбранных источников: одна компания — одна карточка со всеми поводами' },
  { keys: ['amo_checked'], label: 'Проверка AMO', hint: 'Открытые сделки, клиенты и свежие отказы не пишем' },
  { keys: ['company_resolved'], label: 'Компания и сайт', hint: 'Нашли официальный сайт компании' },
  { keys: ['deduplicated'], label: 'Без повторов', hint: 'Нет повторов в запуске и в прошлых выгрузках' },
  { keys: ['recipient_resolved'], label: 'Почта', hint: 'Рабочая почта на сайте, не в стоп-листе — до разбора ИИ; не удалось проверить — очень спорная, без разбора' },
  { keys: ['enriched'], label: 'Разбор ИИ', hint: 'Вакансии hh вживую и разбор сайта: B2B, исключения, события' },
  { keys: ['scored'], label: 'Оценка', hint: 'Похожесть, размер, новости и ФНС, оффер и оценка 0–100 не ниже порога; очень спорные — без писем' },
  { keys: ['sequence_assembled', 'qa_checked'], label: 'Письма и проверка', hint: 'Письма — от сильных к слабым до заказанного числа; прошли автопроверку' },
  { keys: ['ready'], label: 'Готово', hint: 'Готовы к заливке в «Рассылку»' },
];

/**
 * Большие запуски просматривают до 12 тыс. кандидатов — весь журнал ради
 * одного шага не тянем. «Не прошли здесь» запрашивается точечно по ключу шага
 * (`?stage=…`) и получается полным; «прошли дальше» — витрина примеров, а их
 * число берётся из воронки, которая считает по всем строкам на сервере.
 */
const STAGE_PAGE = 1000;
const STAGE_MAX_ROWS = 5000;
const STAGE_EXAMPLES = 300;

const EVIDENCE_LEVEL_STYLES: Record<string, string> = {
  A: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  B: 'border-amber-200 bg-amber-50 text-amber-800',
  C: 'border-gray-200 bg-gray-50 text-gray-500',
};

const EVIDENCE_LEVEL_TITLES: Record<string, string> = {
  A: 'Дословная цитата из первоисточника',
  B: 'Структурное поле источника (без цитаты)',
  C: 'Косвенный признак',
};

/** Откуда адрес и чем кончилась SMTP-проверка. */
const EMAIL_VERIFICATION_LABELS: Record<string, string> = {
  crm_contact: 'контакт из AMO',
  found_on_site: 'найдена на сайте',
  ok: 'проверена',
  catch_all: 'сервер принимает любые адреса',
  unverified: 'проверить не удалось',
};

/** Короткие имена источников для таблицы и окна шага; полные — SOURCE_LABELS в панели запуска. */
const SOURCE_SHORT: Record<SourceCode, string> = {
  hh: 'hh.ru',
  direct: 'Директ',
  crm: 'AMO',
  exhibitors: 'Выставки',
  contracts: 'Госконтракты',
  tenders: 'Тендеры',
  growth: 'Гранты',
  site_news: 'Новости сайтов',
  directory: 'Общая база',
  gis: '2ГИС',
  ymaps: 'Я.Карты',
  revenue_growth: 'Выручка ФНС',
  news: 'Новости',
};

/** Откуда пришла компания: source_type — все её источники через «+» (одна компания — одна карточка). */
function sourcesOf(row: RuRow): string | null {
  const codes = (row.source_type ?? '').split('+').filter(Boolean);
  return codes.length ? codes.map((c) => SOURCE_SHORT[c as SourceCode] ?? c).join(' + ') : null;
}

const reasonLabel = (code: string) => REASON_LABELS[code] ?? code;
const signalLabel = (type: string | null | undefined) => (type ? SIGNAL_LABELS[type] ?? type : null);
const chainLabel = (chain: string | null | undefined) => (chain ? CHAIN_LABELS[chain as ChainType] ?? chain : null);

function toneOf(row: RuRow): OutreachRowTone {
  switch (row.row_status) {
    case 'ready': return 'ready';
    case 'rejected': return 'excluded';
    case 'manual_review': return 'review';
    case 'doubtful': return 'doubtful';
    case 'failed': return 'failed';
    default: return 'processing';
  }
}

function companyOf(row: RuRow): string {
  return row.company_brand ?? row.company_name;
}

function passedDetail(row: RuRow): string {
  return [
    sourcesOf(row),
    row.normalized_domain,
    chainLabel(row.chain_type),
    row.priority_score != null ? `оценка ${row.priority_score}` : null,
    row.recipient_email,
    ...extraCompanyEmails(row.emails, row.recipient_email).map(companyEmailCell),
  ].filter(Boolean).join(' · ');
}

function droppedReason(row: RuRow): string {
  if (row.row_status === 'doubtful') return `очень спорная${row.letters?.length ? '' : ', писем нет'}${row.doubt_detail ? `: ${row.doubt_detail}` : ''}`;
  const base = row.reason_code ? reasonLabel(row.reason_code) : STATUS_LABELS[row.row_status];
  return row.reason_detail ? `${base} — ${row.reason_detail}` : base;
}

function entryOf(row: RuRow, passed: boolean): OutreachStageEntry {
  return {
    id: row.id,
    company: companyOf(row),
    link: row.source_url ? { href: row.source_url, label: signalLabel(row.signal_type) ?? 'источник' } : null,
    passed,
    detail: passed ? passedDetail(row) : [sourcesOf(row), row.normalized_domain, signalLabel(row.signal_type)].filter(Boolean).join(' · '),
    quote: passed ? row.evidence_quote : null,
    reason: passed ? null : droppedReason(row),
  };
}

async function loadDropped(jobId: string, keys: Stage[]): Promise<RuRow[]> {
  const dropped: RuRow[] = [];
  for (const key of keys) {
    for (let offset = 0; offset < STAGE_MAX_ROWS; offset += STAGE_PAGE) {
      const page = await api<{ items: RuRow[]; count: number }>(`${API}/${jobId}/results?stage=${key}&limit=${STAGE_PAGE}&offset=${offset}`);
      dropped.push(...page.items.filter((r) => r.row_status !== 'ready' && r.row_status !== 'processing'));
      if (offset + STAGE_PAGE >= page.count || page.items.length < STAGE_PAGE) break;
    }
  }
  return dropped;
}

/** Повод, оценка, оффер и почему подходит — почему компании пишем именно так. */
function ScoreBlock({ row }: { row: RuRow }) {
  const chips = [
    row.ta_score != null ? `ЦА: ${row.ta_score}/10` : null,
    row.signal_score != null ? `повод: ${row.signal_score}` : null,
    chainLabel(row.chain_type),
    row.amo_status && row.amo_status !== 'none' ? `AMO: ${row.amo_status}` : null,
    row.prior_contact ? 'уже общались' : null,
    row.inn ? `ИНН ${row.inn}` : null,
  ].filter(Boolean) as string[];
  return (
    <ScoreCard title={`Оценка ${row.priority_score ?? '—'}/100`}>
      {chips.length ? (
        <div className="mb-2 flex flex-wrap gap-2 text-xs">
          {chips.map((c) => <Chip key={c}>{c}</Chip>)}
        </div>
      ) : null}
      {row.signals?.length ? (
        <ul className="mb-2 space-y-0.5">
          {row.signals.map((s, i) => (
            <li key={i}>
              <b>{signalLabel(s.type)}</b>: {s.title}
              {s.date ? <span className="text-gray-500"> · {fmtDate(s.date)}</span> : null}
              {s.url ? <a href={s.url} target="_blank" rel="noreferrer" className="ml-1 text-violet-700 underline">ссылка</a> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {row.ta_reason ? <div><span className="text-gray-500">ЦА:</span> {row.ta_reason}</div> : null}
      {row.route_reason ? (
        <div>
          <span className="text-gray-500">Почему этот оффер:</span> {row.route_reason}
          {row.route_runner_up ? <span className="text-gray-500"> · второй вариант: {row.route_runner_up}</span> : null}
        </div>
      ) : null}
      {row.campaign_hypothesis ? <div><span className="text-gray-500">Гипотеза:</span> {row.campaign_hypothesis}</div> : null}
      {row.fit_reasons?.length ? <div><span className="text-gray-500">Почему подходит:</span> {row.fit_reasons.join('; ')}</div> : null}
      <div>
        <span className="text-gray-500">Почта:</span> {row.recipient_email ?? '—'}
        {row.recipient_role ? ` (${row.recipient_role})` : ''}
        {row.email_verification ? ` · ${EMAIL_VERIFICATION_LABELS[row.email_verification] ?? row.email_verification}` : ''}
        {row.is_routing ? ' · письмо 1 в варианте «кому переслать»' : ''}
      </div>
      <div className="mt-1">
        <span className="text-gray-500">Кейс:</span>{' '}
        {row.case_id ? `${row.case_id}${row.case_match_reason ? ` (${row.case_match_reason})` : ''}` : 'без кейса'}
      </div>
      {row.qa_flags?.length ? <div className="mt-1 text-xs text-red-700">Автопроверка: {row.qa_flags.join(', ')}</div> : null}
    </ScoreCard>
  );
}

function EvidenceBlock({ row }: { row: RuRow }) {
  const items: Array<{ label: string; quote: string }> = [];
  if (row.evidence_quote) {
    items.push({
      label: `${signalLabel(row.signal_type) ?? 'Повод'} (уровень ${row.evidence_level ?? '—'})`,
      quote: row.evidence_quote,
    });
  }
  if (row.market_evidence_quote) {
    items.push({ label: `Рынок / клиенты${row.target_market ? `: ${row.target_market}` : ''}`, quote: row.market_evidence_quote });
  }
  // Цитаты остальных поводов — тоже доказательства, а не только главного.
  for (const s of row.signals ?? []) {
    if (s.quote && s.quote !== row.evidence_quote) items.push({ label: `${signalLabel(s.type)} (уровень ${s.level})`, quote: s.quote });
  }
  return <EvidenceCard title="Доказательства (дословно из источников)" items={items} />;
}

function letterField(row: RuRow, n: number, field: 'subject' | 'body' | 'alt_body'): string {
  return (row.letters ?? []).find((l) => l.n === n)?.[field] ?? '';
}

function extraEmailCells(row: RuRow, withStatus: boolean): [string, string] {
  const extra = extraCompanyEmails(row.emails, row.recipient_email);
  const cell = (i: number) => (withStatus ? companyEmailCell(extra[i]) : extra[i]?.email ?? '');
  return [cell(0), cell(1)];
}

const LETTER_HEADERS = [
  'letter_1_subject', 'letter_1_subject_b', 'letter_1_body', 'letter_1_alt_body', 'letter_2_subject', 'letter_2_body',
  'letter_3_subject', 'letter_3_body', 'letter_4_subject', 'letter_4_body',
];
const letterCells = (row: RuRow) => [
  letterField(row, 1, 'subject'), row.subject_b ?? '', letterField(row, 1, 'body'), letterField(row, 1, 'alt_body'),
  letterField(row, 2, 'subject'), letterField(row, 2, 'body'),
  letterField(row, 3, 'subject'), letterField(row, 3, 'body'),
  letterField(row, 4, 'subject'), letterField(row, 4, 'body'),
];

type Sender = { id: string; sender_name: string; sender_title: string | null; is_default: boolean; status: string };

/**
 * Панель запуска со списком отправителей — он нужен только здесь, грузим при
 * открытии. Она же — настройки автодобора (mode 'autofill', RuAutofillTab).
 */
export function RuLaunchPanel(props: {
  busy: boolean;
  initial: Partial<RuOutreachConfig> | null;
  onClose: () => void;
  onStart: (config: Partial<RuOutreachConfig>) => void;
  mode?: 'run' | 'autofill';
}) {
  const [senders, setSenders] = useState<Sender[]>([]);
  useEffect(() => {
    let cancelled = false;
    api<{ senders: Sender[] }>(`${API}/libraries`)
      .then((data) => { if (!cancelled) setSenders(data.senders ?? []); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  return (
    <LaunchPanel
      open
      busy={props.busy}
      senders={senders}
      initial={props.initial}
      onClose={props.onClose}
      onStart={props.onStart}
      mode={props.mode}
    />
  );
}

function summaryExtras(job: RuJob) {
  const detail = job.progress_detail;
  if (!detail) return null;
  const notes = [
    job.status === 'running' || job.status === 'pending' ? `в пуле ${detail.pool ?? '…'} компаний` : null,
    detail.stop_reason === 'pool_exhausted' ? 'кандидаты закончились раньше лимита' : null,
    detail.stop_reason === 'scan_limit' ? 'достигнут потолок просмотра' : null,
  ].filter(Boolean);
  return (
    <>
      {notes.length ? <div className="px-1 text-sm text-gray-500">{notes.join(' · ')}</div> : null}
      {detail.source_errors && Object.keys(detail.source_errors).length > 0 ? (
        <div className="rounded-lg bg-amber-50 px-3 py-1.5 text-sm text-amber-800">
          Источники с ошибкой (запуск шёл без них):{' '}
          {Object.entries(detail.source_errors)
            .map(([code, msg]) => `${SOURCE_LABELS[code as SourceCode] ?? code}: ${msg}`)
            .join(' · ')}
        </div>
      ) : null}
    </>
  );
}

export const ruOutreachAdapter: OutreachRunAdapter<RuRow, Partial<RuOutreachConfig>, RuJob> = {
  apiBase: API,
  parserType: 'polza_ru_outreach',
  lang: 'ru',
  filePrefix: 'nash_autooutreach',
  emptyDescription:
    'Соберём компании по свежим поводам, найдём и проверим почту, отберём по скорингу и напишем цепочку писем. Без отправки: на выходе таблица и выгрузка, заливка в «Рассылку» — по кнопке.',
  deleteDescription: 'Будут удалены запуск, его журнал и все результаты. Действие необратимо.',

  stages: RU_STAGE_VIEW.map(({ label, hint }) => ({ label, hint })),
  stageCounts: (funnel) => RU_STAGE_VIEW.map((v) => (funnel ? Number(funnel[v.keys[v.keys.length - 1]] ?? 0) : 0)),
  loadStage: async ({ jobId, stageIndex, funnel }) => {
    const view = RU_STAGE_VIEW[stageIndex] ?? RU_STAGE_VIEW[0];
    const lastIdx = Math.max(...view.keys.map((k) => STAGES.indexOf(k)));
    const [dropped, page] = await Promise.all([
      loadDropped(jobId, view.keys),
      api<{ items: RuRow[] }>(`${API}/${jobId}/results?limit=${STAGE_PAGE}&offset=0`),
    ]);
    const passed = page.items
      .filter((r) => r.row_status === 'ready' || STAGES.indexOf(r.pipeline_stage as Stage) > lastIdx)
      .slice(0, STAGE_EXAMPLES);
    const passedTotal = funnel ? Number(funnel[view.keys[view.keys.length - 1]] ?? 0) : passed.length;
    return {
      entries: [...dropped.map((r) => entryOf(r, false)), ...passed.map((r) => entryOf(r, true))],
      passedTotal,
      note: passed.length < passedTotal ? `Прошедших показаны примеры (${passed.length} из ${passedTotal}) — полный список в Excel.` : null,
    };
  },

  runSummary: (job) => {
    const detail = job?.progress_detail ?? null;
    const llm = detail?.llm;
    return {
      llm: llm && typeof llm.spent_usd === 'number' ? { spent_usd: llm.spent_usd, limit_usd: llm.limit_usd, calls: llm.calls } : null,
      stopReason: detail?.stop_reason ?? null,
      smtpUnavailable: detail?.smtp_unavailable === true,
      awaitingTemplates: typeof detail?.awaiting_templates === 'number' ? detail.awaiting_templates : null,
    };
  },
  summaryExtras,

  readyCount: (resp) => (resp.funnel ? Number(resp.funnel.ready ?? 0) : null),
  unverifiedCount: () => 0,
  reasonCounts: (resp) => (resp.reason_counts as Record<string, number> | null | undefined) ?? null,
  reasonLabel,
  extraFilters: [
    { status: 'doubtful', label: 'Очень спорные' },
    { status: 'manual_review', label: 'Ручная проверка' },
  ],

  companyName: companyOf,
  companyNote: (row) => (row.prior_contact ? 'уже общались' : null),
  domain: (row) => row.normalized_domain,
  website: (row) => row.company_website,
  columns: [
    {
      header: 'Источник',
      cell: (row) => {
        const label = sourcesOf(row) ?? '—';
        return <div className="max-w-[140px] truncate" title={label}>{label}</div>;
      },
    },
    {
      header: 'Повод',
      cell: (row) => {
        const label = signalLabel(row.signal_type) ?? '—';
        const title = row.signal_title ? `${label}: ${row.signal_title}` : label;
        return row.source_url ? (
          <a
            href={row.source_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex max-w-[220px] items-center gap-1 text-blue-700 hover:underline"
            title={title}
            onClick={(e) => e.stopPropagation()}
          >
            <span className="truncate">{row.signal_title ?? label}</span>
            <ExternalLink className="h-3 w-3 shrink-0 text-gray-400" />
          </a>
        ) : (
          <div className="max-w-[220px] truncate" title={title}>{row.signal_title ?? label}</div>
        );
      },
    },
    {
      header: 'Цепочка',
      cell: (row) => <div className="max-w-[180px] truncate" title={chainLabel(row.chain_type) ?? ''}>{chainLabel(row.chain_type) ?? '—'}</div>,
    },
    {
      header: 'Рынок',
      cell: (row) => <div className="max-w-[140px] truncate" title={row.target_market ?? ''}>{row.target_market ?? '—'}</div>,
    },
    {
      header: 'Доказательство',
      cell: (row) =>
        row.evidence_level && row.evidence_level !== 'NONE' ? (
          <span
            title={EVIDENCE_LEVEL_TITLES[row.evidence_level]}
            className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${EVIDENCE_LEVEL_STYLES[row.evidence_level] ?? EVIDENCE_LEVEL_STYLES.C}`}
          >
            {row.evidence_level}
          </span>
        ) : (
          <span className="text-gray-400">—</span>
        ),
    },
  ],
  primaryEmail: (row) => row.recipient_email,
  primaryVerification: (row) => row.email_verification,
  emails: (row) => row.emails,
  letters: (row) => row.letters ?? [],
  subjectB: (row) => row.subject_b,
  tone: toneOf,
  statusLabel: (row) => STATUS_LABELS[row.row_status] ?? row.row_status,
  statusNote: (row) => (row.reason_code && row.row_status !== 'ready' ? reasonLabel(row.reason_code) : null),
  statusExtra: (row) =>
    row.doubt_flags?.length ? (
      <div className="mt-1 flex max-w-[180px] flex-wrap gap-1">
        {row.doubt_flags.map((f) => (
          <span key={f} className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-800">
            {DOUBT_LABELS[f as DoubtCode] ?? f}
          </span>
        ))}
      </div>
    ) : null,

  detailHeading: (row) =>
    `${signalLabel(row.signal_type) ?? 'Повод'} от ${row.signal_date ? fmtDate(row.signal_date) : '—'}${sourcesOf(row) ? ` · ${sourcesOf(row)}` : ''}`,
  detailBlocks: (row) => (
    <>
      <ScoreBlock row={row} />
      <EvidenceBlock row={row} />
    </>
  ),
  reviewNote: (row) => {
    const parts: string[] = [];
    if (row.reason_code && row.row_status !== 'ready') {
      parts.push(`${reasonLabel(row.reason_code)}${row.reason_detail ? ` — ${row.reason_detail}` : ''}`);
    }
    if (row.doubt_detail) parts.push(`Сомнения: ${row.doubt_detail}`);
    return parts.length ? parts.join('. ') : null;
  },

  csv: {
    readyHeader: ['company_name', 'email', 'email_2', 'email_3', 'domain', 'signal', 'signal_title', 'source_url', 'chain', ...LETTER_HEADERS],
    readyRow: (row) => [
      companyOf(row),
      row.recipient_email ?? '',
      ...extraEmailCells(row, false),
      row.normalized_domain ?? '',
      signalLabel(row.signal_type) ?? '',
      row.signal_title ?? '',
      row.source_url ?? '',
      chainLabel(row.chain_type) ?? '',
      ...letterCells(row),
    ],
    fullHeader: [
      'company_name', 'inn', 'domain', 'website', 'signal', 'signal_title', 'source_url', 'signal_date', 'chain',
      'priority_score', 'ta_score', 'target_market', 'market_evidence', 'evidence_level', 'evidence', 'email', 'email_type',
      'email_verification', 'email_2', 'email_3', 'status', 'stage', 'reason', 'reason_detail', 'doubts',
      ...LETTER_HEADERS,
    ],
    fullRow: (row) => [
      companyOf(row),
      row.inn ?? '',
      row.normalized_domain ?? '',
      row.company_website ?? '',
      signalLabel(row.signal_type) ?? '',
      row.signal_title ?? '',
      row.source_url ?? '',
      row.signal_date ?? '',
      chainLabel(row.chain_type) ?? '',
      row.priority_score ?? '',
      row.ta_score ?? '',
      row.target_market ?? '',
      row.market_evidence_quote ?? '',
      row.evidence_level ?? '',
      row.evidence_quote ?? '',
      row.recipient_email ?? '',
      row.email_type ?? '',
      row.email_verification ?? '',
      ...extraEmailCells(row, true),
      STATUS_LABELS[row.row_status] ?? row.row_status,
      row.pipeline_stage ?? '',
      row.reason_code ? reasonLabel(row.reason_code) : '',
      row.reason_detail ?? '',
      (row.doubt_flags ?? []).map((f) => DOUBT_LABELS[f as DoubtCode] ?? f).join('; '),
      ...letterCells(row),
    ],
  },
  // Excel под фильтр таблицы: готовые, очень спорные или весь журнал.
  xlsxUrl: (jobId, filter) => `${API}/${jobId}/export?kind=${filter === 'ready' ? 'ready' : filter === 'doubtful' ? 'doubtful' : 'journal'}`,

  renderLaunchPanel: ({ busy, initial, onClose, onStart }) => (
    <RuLaunchPanel busy={busy} initial={initial} onClose={onClose} onStart={onStart} />
  ),
  jobConfig: (job) => job.config ?? null,
};
