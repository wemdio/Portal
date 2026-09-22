import { NextResponse, type NextRequest } from 'next/server';
import ExcelJS from 'exceljs';
import { logError } from '@/lib/loggerServer';
import { authed, jsonError } from '@/lib/polzaRuOutreach/routeAuth';
import { PROFILE_LABELS, REASON_LABELS, STAGE_LABELS, type ProfileCode, type Stage } from '@/lib/polzaRuOutreach/types';

export const dynamic = 'force-dynamic';

/**
 * Выгрузка запуска в Excel.
 *
 * ?kind=ready   — только готовые строки (email + QA passed), колонки из
 *                 инструкции оффера: это файл «кому и что отправлять»;
 * ?kind=journal — все строки с этапом и причиной отсева: «почему выход такой».
 *
 * Названия колонок — поля из ТЗ латиницей: файл дальше грузят в рассылку,
 * где письма подставляются по имени колонки ({{email_1_body}}).
 */

type Row = Record<string, unknown> & { letters?: Array<{ n: number; subject?: string; body?: string }> | null };
type Col = { header: string; value: (r: Row) => unknown; width?: number };

const letter = (n: number, part: 'subject' | 'body') => (r: Row) => r.letters?.find((l) => l.n === n)?.[part] ?? '';
const field = (key: string) => (r: Row) => r[key] ?? '';
const list = (key: string) => (r: Row) => (Array.isArray(r[key]) ? (r[key] as unknown[]).join('; ') : '');

const COMMON_HEAD: Col[] = [
  { header: 'company_name', value: field('company_name'), width: 30 },
  { header: 'company_domain', value: field('normalized_domain'), width: 24 },
];
const COMMON_TAIL: Col[] = [
  { header: 'offer_version', value: field('offer_version') },
  { header: 'template_version', value: field('template_version') },
  { header: 'case_id', value: field('case_id') },
  { header: 'qa_status', value: field('qa_status') },
];
const BODY = (w = 70): Col[] => [
  { header: 'email_1_subject', value: letter(1, 'subject'), width: 36 },
  { header: 'email_1_body', value: letter(1, 'body'), width: w },
  { header: 'email_2_body', value: letter(2, 'body'), width: w },
  { header: 'email_3_body', value: letter(3, 'body'), width: w },
];

const READY_COLUMNS: Record<ProfileCode, Col[]> = {
  sdr_hiring_v1: [
    ...COMMON_HEAD,
    { header: 'vacancy_source', value: () => 'hh.ru' },
    { header: 'vacancy_url', value: field('source_url'), width: 36 },
    { header: 'job_title', value: field('signal_title'), width: 30 },
    { header: 'sdr_evidence_quote', value: field('evidence_quote'), width: 50 },
    { header: 'target_market', value: (r) => r.target_market ?? 'unknown' },
    { header: 'market_evidence_quote', value: field('market_evidence_quote'), width: 40 },
    { header: 'recipient_role', value: field('recipient_role') },
    { header: 'recipient_email', value: field('recipient_email'), width: 30 },
    ...BODY(),
    ...COMMON_TAIL,
  ],
  automated_outreach_v1: [
    ...COMMON_HEAD,
    { header: 'audience_source', value: field('source_type') },
    { header: 'generation_mode', value: field('generation_mode') },
    { header: 'prior_contact', value: (r) => (r.prior_contact ? 'true' : 'false') },
    { header: 'signal_type', value: field('signal_type') },
    { header: 'signal_url', value: field('source_url'), width: 36 },
    { header: 'signal_quote', value: field('evidence_quote'), width: 50 },
    { header: 'fit_reason', value: list('fit_reasons'), width: 50 },
    { header: 'recipient_role', value: field('recipient_role') },
    { header: 'recipient_email', value: field('recipient_email'), width: 30 },
    ...BODY(),
    { header: 'offer_claim_ids', value: list('offer_claim_ids') },
    ...COMMON_TAIL,
  ],
  signals_v1: [
    ...COMMON_HEAD,
    { header: 'company_brand', value: field('company_brand') },
    { header: 'signal_type', value: field('signal_type') },
    { header: 'signal_date', value: field('signal_date') },
    { header: 'source_url', value: field('source_url'), width: 36 },
    { header: 'evidence_quote', value: field('evidence_quote'), width: 50 },
    { header: 'evidence_grade', value: field('evidence_level') },
    { header: 'personalization_mode', value: field('generation_mode') },
    { header: 'signal_score', value: field('signal_score') },
    { header: 'recipient_email', value: field('recipient_email'), width: 30 },
    { header: 'subject_a', value: letter(1, 'subject'), width: 36 },
    { header: 'subject_b', value: field('subject_b'), width: 36 },
    { header: 'email_1', value: letter(1, 'body'), width: 70 },
    { header: 'email_2', value: letter(2, 'body'), width: 70 },
    { header: 'email_3', value: letter(3, 'body'), width: 70 },
    { header: 'email_4', value: letter(4, 'body'), width: 70 },
    ...COMMON_TAIL,
  ],
};

const JOURNAL_COLUMNS: Col[] = [
  { header: 'run_id', value: field('job_id') },
  { header: 'source_type', value: field('source_type') },
  { header: 'source_record_id', value: field('source_record_id') },
  { header: 'source_url', value: field('source_url'), width: 36 },
  { header: 'company_name', value: field('company_name'), width: 30 },
  { header: 'company_domain', value: field('normalized_domain'), width: 24 },
  { header: 'inn', value: field('inn') },
  { header: 'crm_record_id', value: field('crm_lead_id') },
  { header: 'prior_contact', value: (r) => (r.prior_contact ? 'true' : 'false') },
  { header: 'signal_type', value: field('signal_type') },
  { header: 'signal_date', value: field('signal_date') },
  { header: 'evidence_level', value: field('evidence_level') },
  { header: 'evidence_quote', value: field('evidence_quote'), width: 50 },
  { header: 'target_market', value: field('target_market') },
  { header: 'market_evidence_quote', value: field('market_evidence_quote'), width: 40 },
  { header: 'fit_reasons', value: list('fit_reasons'), width: 50 },
  { header: 'signal_score', value: field('signal_score') },
  { header: 'generation_mode', value: field('generation_mode') },
  { header: 'recipient_email', value: field('recipient_email'), width: 30 },
  { header: 'pipeline_stage', value: (r) => STAGE_LABELS[r.pipeline_stage as Stage] ?? r.pipeline_stage ?? '' },
  { header: 'row_status', value: field('row_status') },
  { header: 'reason_code', value: field('reason_code') },
  { header: 'reason', value: (r) => (r.reason_code ? REASON_LABELS[String(r.reason_code)] ?? r.reason_code : '') , width: 36 },
  { header: 'reason_detail', value: field('reason_detail'), width: 40 },
  { header: 'qa_flags', value: list('qa_flags'), width: 36 },
];

export async function GET(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  const auth = await authed(req);
  if ('error' in auth) return auth.error;
  const { jobId } = await ctx.params;
  const kind = req.nextUrl.searchParams.get('kind') === 'journal' ? 'journal' : 'ready';

  const { data: job, error: jobErr } = await auth.supabase.from('parser_jobs').select('config,created_at').eq('id', jobId).single();
  if (jobErr || !job) return jsonError('Запуск не найден', 404);
  const profile = ((job.config ?? {}) as { profile_code?: ProfileCode }).profile_code ?? 'sdr_hiring_v1';

  const rows: Row[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    let q = auth.supabase
      .from('polza_ru_outreach_companies')
      .select('*')
      .eq('job_id', jobId)
      .order('created_at', { ascending: true })
      .range(from, from + PAGE - 1);
    if (kind === 'ready') q = q.eq('row_status', 'ready').eq('qa_status', 'passed').not('recipient_email', 'is', null);
    const { data, error } = await q;
    if (error) {
      await logError('polza_ru_outreach.export.failed', error, { jobId, kind }, { userId: auth.user.id });
      return jsonError(error.message, 500);
    }
    rows.push(...((data ?? []) as Row[]));
    if (!data || data.length < PAGE) break;
  }

  const columns = kind === 'ready' ? READY_COLUMNS[profile] : JOURNAL_COLUMNS;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(kind === 'ready' ? 'Готовые' : 'Журнал');
  ws.columns = columns.map((c) => ({ header: c.header, key: c.header, width: c.width ?? 18 }));
  for (const r of rows) {
    const values: Record<string, unknown> = {};
    for (const c of columns) values[c.header] = c.value(r);
    ws.addRow(values);
  }
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.eachRow((row, i) => {
    if (i > 1) row.alignment = { vertical: 'top', wrapText: true };
  });

  const buffer = await wb.xlsx.writeBuffer();
  const date = String(job.created_at ?? '').slice(0, 10);
  const name = `nash-autooutreach-${profile}-${kind}-${date}.xlsx`;
  return new NextResponse(buffer as ArrayBuffer, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(`Наш автоаутрич — ${PROFILE_LABELS[profile]} — ${kind === 'ready' ? 'готовые' : 'журнал'} ${date}.xlsx`)}`,
    },
  });
}
