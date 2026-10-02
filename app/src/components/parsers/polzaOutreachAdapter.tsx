'use client';

import { ExternalLink } from 'lucide-react';
import type { PolzaOutreachCompanyRow, PolzaOutreachConfig, PolzaOutreachParserJob } from '@/types';
import { companyEmailCell, extraCompanyEmails } from '@/lib/outreachEmail/companyEmails';
import type { OutreachLlmBudgetSnapshot } from '@/lib/outreachLlm/types';
import { POLZA_FUNNEL_ORDER, passedFunnelStep, type PolzaFunnelKey } from '@/lib/polzaOutreach/funnel';
import { polzaReviewLabel } from '@/lib/polzaOutreach/types';
import { PolzaOutreachLaunchPanel } from '@/components/parsers/PolzaOutreachLaunchPanel';
import { Chip, EvidenceCard, ScoreCard } from '@/components/outreach/run/parts';
import type { OutreachRowTone, OutreachRunAdapter, OutreachStageEntry } from '@/components/outreach/run/types';

/**
 * Английский автоаутрич на общем экране запуска (components/outreach/run):
 * свои шаги, столбцы, доказательства и выгрузки. Раскладка — общая с русским.
 */

type Row = PolzaOutreachCompanyRow;

const STATUS_LABELS: Record<string, string> = {
  discovered: 'найдена',
  normalized: 'домен найден',
  excluded: 'исключена',
  needs_review: 'на ручную проверку',
  qualified: 'квалифицирована',
  ready: 'готово',
  failed: 'ошибка',
};

const EXCLUSION_LABELS: Record<string, string> = {
  domain_not_resolved: 'домен не найден',
  competitor: 'конкурент (лидген)',
  staffing_agency: 'стаффинг/рекрутинг',
  generic_marketing: 'generic marketing',
  b2c_or_education: 'B2C/образование/маркетплейс',
  size_11_50: 'размер 11–50',
  size_out_of_range: 'размер вне 3–200',
  duplicate_domain: 'дубль домена',
  previously_exported: 'уже готова в прошлом запуске',
  no_outbound_mandate: 'нет outbound-мандата',
  site_unreachable: 'сайт не открылся',
  llm_failed: 'ИИ не ответил (сбой модели или ключа)',
  not_b2b: 'не B2B',
  no_trigger: 'нет повода написать',
  low_score: 'Lead Score ниже порога',
  no_corporate_email: 'не нашли корпоративную почту',
  email_invalid: 'почта на сайте не прошла проверку',
  suppressed_contact: 'почта в стоп-листе Рассылки',
};

const exclusionLabel = (code: string) => EXCLUSION_LABELS[code] ?? code;

const TRIGGER_LABELS: Record<string, string> = {
  hiring: 'найм sales/GTM',
  yc: 'YC',
  launch: 'запуск продукта',
  tech_stack: 'стек продаж',
};

const BLOCK_LABELS: Record<string, string> = { fit: 'fit', firmographic: 'размер/страна', trigger: 'повод', data_quality: 'данные' };

const CONFIDENCE_STYLES: Record<string, string> = {
  high: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  medium: 'border-amber-200 bg-amber-50 text-amber-800',
  low: 'border-gray-200 bg-gray-50 text-gray-500',
};

const STAGE_TEXT: Record<PolzaFunnelKey, { label: string; hint: string }> = {
  vacancies: { label: 'Кандидаты', hint: 'Компании с вакансией sales/GTM или из YC: одна компания — одна карточка' },
  domain_found: { label: 'Домен компании', hint: 'Официальный сайт компании; размер, страна и отрасль из PDL' },
  icp_passed: {
    label: 'Фильтр ICP и повторы',
    hint: 'Отсеиваем агентства, стаффинг, B2C, размер вне 3–200, дубли домена и компании, уже готовые в прошлых запусках',
  },
  email_found: {
    label: 'Корпоративная почта',
    hint: 'Адрес на сайте компании прошёл SMTP-проверку и не в стоп-листе — ищем до разбора ИИ; проверить не удалось — на ручную проверку',
  },
  geo_confirmed: { label: 'Lead Score: write now', hint: 'Разбор сайта и вакансии ИИ, поводы → балл 0–100 не ниже порога' },
  ready: {
    label: 'Цепочка писем',
    hint: 'Письма — от сильных к слабым до заказанного числа; готовы к отправке: компания, домен, почта и четыре письма',
  },
};

/** Вердикт SMTP-проверки адреса — рядом с почтой на шаге почты. */
const EMAIL_VERIFICATION_LABELS: Record<string, string> = {
  ok: 'проверена',
  catch_all: 'сервер принимает любые адреса',
  unverified: 'проверить не удалось',
};

function formatDate(value?: string | null) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
}

function toneOf(row: Row): OutreachRowTone {
  switch (row.status) {
    case 'ready': return 'ready';
    case 'excluded': return 'excluded';
    case 'needs_review': return 'review';
    case 'failed': return 'failed';
    default: return 'processing';
  }
}

/**
 * Разбор строки на шаге: «прошла» — по тем же правилам, что счётчик шага
 * (lib/polzaOutreach/funnel.ts), что шаг узнал — у каждого шага своё.
 */
function describe(row: Row, stageKey: PolzaFunnelKey): OutreachStageEntry {
  const passed = passedFunnelStep(row, stageKey);
  const notPassed = (fallback: string): string => {
    if (row.status === 'excluded' && row.exclusion_reason) return exclusionLabel(row.exclusion_reason);
    if (row.review_reason) return polzaReviewLabel(row.review_reason);
    if (row.status === 'failed') return 'ошибка обработки';
    if (row.status === 'discovered' || row.status === 'normalized' || row.status === 'qualified') return 'ещё в работе';
    return fallback;
  };

  let detail = '';
  let fallback = 'не прошла';
  switch (stageKey) {
    case 'vacancies':
      detail = [row.source_list?.length ? row.source_list.join(' + ') : row.source_type, row.job_title, row.job_country_code?.toUpperCase()].filter(Boolean).join(' · ');
      break;
    case 'domain_found':
      detail = row.normalized_domain ?? '';
      fallback = 'домен не найден';
      break;
    case 'icp_passed':
      detail = [row.employee_range ? `${row.employee_range} чел.` : null, row.industry, row.country].filter(Boolean).join(' · ');
      fallback = 'не прошла фильтр';
      break;
    case 'email_found': {
      const label = (value: string | null | undefined) => (value ? EMAIL_VERIFICATION_LABELS[value] ?? value : null);
      const main = [row.selected_company_email, label(row.email_verification)].filter(Boolean).join(' · ');
      const extra = extraCompanyEmails(row.emails, row.selected_company_email ?? null).map((item) =>
        [item.email, label(item.verification)].filter(Boolean).join(' · '),
      );
      detail = [main, ...extra].filter(Boolean).join('; ');
      fallback = 'почта не найдена';
      break;
    }
    case 'geo_confirmed':
      detail = [row.lead_score != null ? `${row.lead_score}/100` : null, row.primary_trigger].filter(Boolean).join(' · ');
      fallback = 'Lead Score ниже порога';
      break;
    case 'ready': {
      const letters = row.letters?.length ?? 0;
      detail = letters > 0 ? `писем: ${letters}` : '';
      fallback = 'письма не собраны';
      break;
    }
  }
  return {
    id: row.id,
    company: row.company_name,
    link: row.job_source_url ? { href: row.job_source_url, label: 'вакансия' } : null,
    passed,
    detail,
    // Цитата нужна именно на шаге оценки: без неё «гео подтверждено» — просто слово.
    quote: stageKey === 'geo_confirmed' ? row.target_sales_geo_evidence ?? null : null,
    reason: passed ? null : notPassed(fallback),
  };
}

/** Lead Score, поводы и поля персонализации — почему компании пишем именно так. */
function ScoreBlock({ row }: { row: Row }) {
  if (row.lead_score == null && !row.trigger_list?.length) return null;
  const breakdown = row.score_breakdown ?? {};
  return (
    <ScoreCard title={`Lead Score ${row.lead_score ?? '—'}/100${row.lead_status ? ` · ${row.lead_status === 'write_now' ? 'write now' : 'skip'}` : ''}`}>
      <div className="mb-2 flex flex-wrap gap-2 text-xs">
        {Object.entries(breakdown).map(([k, v]) => (
          <Chip key={k}>{BLOCK_LABELS[k] ?? k}: {v}</Chip>
        ))}
        {[row.employee_range ? `${row.employee_range} чел.` : null, row.industry, row.country].filter(Boolean).map((x) => (
          <Chip key={String(x)} muted>{x}</Chip>
        ))}
      </div>
      {row.trigger_list?.length ? (
        <ul className="mb-2 space-y-0.5">
          {row.trigger_list.map((t, i) => (
            <li key={i}>
              <b>{TRIGGER_LABELS[t.type] ?? t.type}</b>: {t.title}
              {t.url ? <a href={t.url} target="_blank" rel="noreferrer" className="ml-1 text-violet-700 underline">ссылка</a> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {row.company_context ? <div><span className="text-gray-500">Компания:</span> {row.company_context}</div> : null}
      {row.likely_gtm_problem ? <div><span className="text-gray-500">Вероятная GTM-боль:</span> {row.likely_gtm_problem}</div> : null}
      {row.outreach_angle ? <div><span className="text-gray-500">Угол:</span> {row.outreach_angle}</div> : null}
      {row.segments?.length ? <div><span className="text-gray-500">Сегменты:</span> {row.segments.join('; ')}</div> : null}
      <div className="mt-1">
        <span className="text-gray-500">Кейс:</span>{' '}
        {row.recommended_case ? `${row.recommended_case} (${row.case_reason ?? ''})` : 'нет утверждённого кейса этой отрасли — письмо 3 без кейса'}
      </div>
    </ScoreCard>
  );
}

function EvidenceBlock({ row }: { row: Row }) {
  const items: Array<{ label: string; quote: string }> = [];
  if (row.outbound_evidence) {
    items.push({
      label: `Outbound-мандат ${row.outbound_mandate === false ? '(мандат не подтверждён)' : ''}`,
      quote: row.outbound_evidence,
    });
  }
  if (row.target_sales_geo_evidence) {
    items.push({
      label: `Гео продаж: ${row.target_sales_geo ?? '—'} (уверенность ${row.target_sales_geo_confidence ?? '—'})`,
      quote: row.target_sales_geo_evidence,
    });
  }
  return <EvidenceCard title="Доказательства (дословно из вакансии)" items={items} />;
}

function letterField(row: Row, n: number, field: 'subject' | 'body' | 'alt_body'): string {
  return (row.letters ?? []).find((l) => l.n === n)?.[field] ?? '';
}

/** Почта 2 и 3 компании: адрес со статусом проверки или без него (файл для отправки). */
function extraEmailCells(row: Row, withStatus: boolean): [string, string] {
  const extra = extraCompanyEmails(row.emails, row.selected_company_email ?? null);
  const cell = (i: number) => (withStatus ? companyEmailCell(extra[i]) : extra[i]?.email ?? '');
  return [cell(0), cell(1)];
}

const LETTER_HEADERS = [
  'letter_1_subject', 'letter_1_body', 'letter_1_alt_body', 'letter_2_subject', 'letter_2_body',
  'letter_3_subject', 'letter_3_body', 'letter_4_subject', 'letter_4_body',
];
const letterCells = (row: Row) => [
  letterField(row, 1, 'subject'), letterField(row, 1, 'body'), letterField(row, 1, 'alt_body'),
  letterField(row, 2, 'subject'), letterField(row, 2, 'body'),
  letterField(row, 3, 'subject'), letterField(row, 3, 'body'),
  letterField(row, 4, 'subject'), letterField(row, 4, 'body'),
];

function runSummary(job: PolzaOutreachParserJob | null) {
  const detail = job?.progress_detail as Record<string, unknown> | null | undefined;
  const llm = detail?.llm as Partial<OutreachLlmBudgetSnapshot> | null | undefined;
  const valid = typeof llm?.spent_usd === 'number' && typeof llm?.limit_usd === 'number' && typeof llm?.calls === 'number';
  return {
    llm: valid ? (llm as OutreachLlmBudgetSnapshot) : null,
    stopReason: typeof detail?.stop_reason === 'string' ? detail.stop_reason : null,
    smtpUnavailable: detail?.smtp_unavailable === true,
    awaitingTemplates: typeof detail?.awaiting_templates === 'number' ? detail.awaiting_templates : null,
  };
}

export const polzaOutreachAdapter: OutreachRunAdapter<Row, PolzaOutreachConfig, PolzaOutreachParserJob> = {
  apiBase: '/api/parsers/polza-outreach',
  parserType: 'polza_outreach',
  lang: 'en',
  filePrefix: 'polza_outreach',
  emptyDescription:
    'Соберём B2B-компании с поводом написать — найм в sales/GTM или свежий батч YC, — найдём и проверим почту, отберём по Lead Score и напишем цепочку из четырёх писем на английском. Без отправки: на выходе таблица и выгрузка.',
  deleteDescription: 'Будут удалены запуск и все его результаты. Действие необратимо.',

  stages: POLZA_FUNNEL_ORDER.map((key) => STAGE_TEXT[key]),
  stageCounts: (funnel) => POLZA_FUNNEL_ORDER.map((key) => (funnel ? Number(funnel[key] ?? 0) : 0)),
  loadStage: async ({ stageIndex, loadAllRows }) => {
    const key = POLZA_FUNNEL_ORDER[stageIndex] ?? 'vacancies';
    const rows = await loadAllRows();
    return { entries: rows.map((row) => describe(row, key)) };
  },

  runSummary,

  readyCount: (resp) => (resp.funnel ? Number(resp.funnel.ready ?? 0) : null),
  unverifiedCount: (resp) => Number((resp.review_counts as Record<string, number> | null | undefined)?.email_unverified ?? 0),
  reasonCounts: (resp) => (resp.exclusion_counts as Record<string, number> | null | undefined) ?? null,
  reasonLabel: exclusionLabel,

  companyName: (row) => row.company_name,
  domain: (row) => row.normalized_domain ?? null,
  website: (row) => row.company_website ?? null,
  columns: [
    {
      header: 'Вакансия',
      cell: (row) =>
        row.job_source_url ? (
          <a
            href={row.job_source_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex max-w-[220px] items-center gap-1 text-blue-700 hover:underline"
            title={row.job_title ?? ''}
            onClick={(e) => e.stopPropagation()}
          >
            <span className="truncate">{row.job_title ?? 'вакансия'}</span>
            <ExternalLink className="h-3 w-3 shrink-0 text-gray-400" />
          </a>
        ) : (
          <span className="text-gray-400">—</span>
        ),
    },
    {
      header: 'Услуга',
      cell: (row) => <div className="max-w-[180px] truncate" title={row.service_line ?? ''}>{row.service_line ?? '—'}</div>,
    },
    {
      header: 'Гео продаж',
      cell: (row) => <div className="max-w-[140px] truncate" title={row.target_sales_geo ?? ''}>{row.target_sales_geo ?? '—'}</div>,
    },
    {
      header: 'Уверенность',
      cell: (row) =>
        row.target_sales_geo_confidence ? (
          <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${CONFIDENCE_STYLES[row.target_sales_geo_confidence] ?? CONFIDENCE_STYLES.low}`}>
            {row.target_sales_geo_confidence}
          </span>
        ) : (
          <span className="text-gray-400">—</span>
        ),
    },
  ],
  primaryEmail: (row) => row.selected_company_email ?? null,
  primaryVerification: (row) => row.email_verification ?? null,
  emails: (row) => row.emails,
  letters: (row) => row.letters ?? [],
  tone: toneOf,
  statusLabel: (row) => STATUS_LABELS[row.status] ?? row.status,
  statusNote: (row) =>
    row.exclusion_reason ? exclusionLabel(row.exclusion_reason) : row.review_reason ? polzaReviewLabel(row.review_reason) : null,

  detailHeading: (row) => `Вакансия от ${formatDate(row.job_published_at)} · ${row.job_country_code?.toUpperCase() ?? '—'}`,
  detailBlocks: (row) => (
    <>
      <ScoreBlock row={row} />
      <EvidenceBlock row={row} />
    </>
  ),
  reviewNote: (row) => (row.review_reason ? `На ручную проверку: ${polzaReviewLabel(row.review_reason)}` : null),

  csv: {
    readyHeader: ['company_name', 'email', 'email_2', 'email_3', 'domain', 'job_country', 'job_title', 'job_url', ...LETTER_HEADERS],
    readyRow: (row) => [
      row.company_name,
      row.selected_company_email ?? '',
      ...extraEmailCells(row, false),
      row.normalized_domain ?? '',
      row.job_country_code ?? '',
      row.job_title ?? '',
      row.job_source_url ?? '',
      ...letterCells(row),
    ],
    fullHeader: [
      'company_name', 'domain', 'website', 'job_title', 'job_url', 'job_country', 'job_published_at', 'service_line',
      'target_sales_geo', 'target_sales_geo_confidence', 'target_sales_geo_evidence', 'outbound_mandate', 'outbound_evidence',
      'email', 'email_type', 'email_verification', 'email_2', 'email_3', 'status', 'stage', 'exclusion_reason', 'review_reason',
      ...LETTER_HEADERS,
    ],
    fullRow: (row) => [
      row.company_name,
      row.normalized_domain ?? '',
      row.company_website ?? '',
      row.job_title ?? '',
      row.job_source_url ?? '',
      row.job_country_code ?? '',
      row.job_published_at ?? '',
      row.service_line ?? '',
      row.target_sales_geo ?? '',
      row.target_sales_geo_confidence ?? '',
      row.target_sales_geo_evidence ?? '',
      row.outbound_mandate ?? '',
      row.outbound_evidence ?? '',
      row.selected_company_email ?? '',
      row.email_type ?? '',
      row.email_verification ?? '',
      ...extraEmailCells(row, true),
      row.status,
      row.stage ?? '',
      row.exclusion_reason ?? '',
      row.review_reason ?? '',
      ...letterCells(row),
    ],
  },
  xlsxUrl: (jobId, filter) => `/api/parsers/polza-outreach/${jobId}/export${filter === 'ready' ? '?status=ready' : ''}`,

  renderLaunchPanel: ({ busy, initial, onClose, onStart }) => (
    <PolzaOutreachLaunchPanel busy={busy} initial={initial} onClose={onClose} onStart={async (config) => onStart(config)} />
  ),
  jobConfig: (job) => job.config ?? null,
};
