import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import ExcelJS from 'exceljs';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { logError } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';

/**
 * Выгрузка результатов прогона в Excel.
 *
 * CSV уже был, но его открывают в Excel — и там он рассыпается: письма
 * содержат переносы строк и запятые, локаль путает разделитель, а длинные
 * цитаты-доказательства превращаются в кашу. Поэтому настоящий xlsx собирается
 * здесь, на сервере: exceljs в браузер тащить незачем, он тяжёлый.
 *
 * Файл собирается в память целиком. Это осознанно: потолок прогона — тысяча
 * компаний, и такой файл считается единицами мегабайт.
 */

const COLUMNS: { header: string; key: string; width: number }[] = [
  { header: 'Компания', key: 'company_name', width: 28 },
  { header: 'Домен', key: 'normalized_domain', width: 24 },
  { header: 'Сайт', key: 'company_website', width: 28 },
  { header: 'Вакансия', key: 'job_title', width: 34 },
  { header: 'Ссылка на вакансию', key: 'job_source_url', width: 38 },
  { header: 'Страна', key: 'job_country_code', width: 10 },
  { header: 'Опубликована', key: 'job_published_at', width: 14 },
  { header: 'Направление услуг', key: 'service_line', width: 26 },
  { header: 'Гео продаж', key: 'target_sales_geo', width: 18 },
  { header: 'Уверенность в гео', key: 'target_sales_geo_confidence', width: 16 },
  { header: 'Цитата про гео', key: 'target_sales_geo_evidence', width: 48 },
  { header: 'Outbound-мандат', key: 'outbound_mandate', width: 16 },
  { header: 'Цитата про мандат', key: 'outbound_evidence', width: 48 },
  { header: 'Почта', key: 'selected_company_email', width: 28 },
  { header: 'Тип почты', key: 'email_type', width: 14 },
  { header: 'Статус', key: 'status', width: 18 },
  { header: 'Причина исключения', key: 'exclusion_reason', width: 22 },
  { header: 'На ручную проверку', key: 'review_reason', width: 22 },
  { header: 'Письмо 1 — тема', key: 'letter1_subject', width: 34 },
  { header: 'Письмо 1 — текст', key: 'letter1_body', width: 60 },
  { header: 'Письмо 2 — тема', key: 'letter2_subject', width: 34 },
  { header: 'Письмо 2 — текст', key: 'letter2_body', width: 60 },
  { header: 'Письмо 3 — тема', key: 'letter3_subject', width: 34 },
  { header: 'Письмо 3 — текст', key: 'letter3_body', width: 60 },
  { header: 'Письмо 4 — тема', key: 'letter4_subject', width: 34 },
  { header: 'Письмо 4 — текст', key: 'letter4_body', width: 60 },
];

const STATUS_RU: Record<string, string> = {
  discovered: 'найдена',
  normalized: 'домен найден',
  excluded: 'исключена',
  needs_review: 'на ручную проверку',
  qualified: 'квалифицирована',
  ready: 'готово',
  failed: 'ошибка',
};

const REASON_RU: Record<string, string> = {
  domain_not_resolved: 'домен не найден',
  competitor: 'конкурент (лидген)',
  staffing_agency: 'стаффинг/рекрутинг',
  generic_marketing: 'слишком общий маркетинг',
  b2c_or_education: 'B2C / образование / маркетплейс',
  size_11_50: 'размер 11–50',
  duplicate_domain: 'дубль домена',
  no_outbound_mandate: 'нет outbound-мандата',
  no_corporate_email: 'не нашли корпоративную почту',
  generic_company: 'слишком общее описание компании',
  low_geo_confidence: 'гео продаж подтверждено слабо',
  letters_guard_failed: 'письма не прошли проверку правил',
};

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

type Letter = { n: number; subject?: string | null; body?: string | null };

export async function GET(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  let userId: string;
  try {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data?.user) return jsonError('Unauthorized', 401);
    userId = data.user.id;
  } catch {
    return jsonError('Unauthorized', 401);
  }

  const { jobId } = await ctx.params;
  const { data: rows, error } = await supabase
    .from('polza_outreach_companies')
    .select('*')
    .eq('job_id', jobId)
    .order('created_at', { ascending: true })
    .limit(5000);

  if (error) {
    await logError('parser.polza_outreach.export.failed', error, { jobId }, { userId, route: req.nextUrl.pathname });
    return jsonError(error.message, 500);
  }

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Англ. аутрич');
  sheet.columns = COLUMNS;
  sheet.getRow(1).font = { bold: true };
  // Шапка не уезжает при прокрутке: строк бывает под тысячу, и без закрепления
  // к двадцатой колонке уже не помнишь, что в ней.
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  for (const raw of rows ?? []) {
    const row = raw as Record<string, unknown>;
    const letters = (row.letters as Letter[] | null) ?? [];
    const letter = (n: number, field: 'subject' | 'body') => letters.find((l) => l.n === n)?.[field] ?? '';
    const reason = (value: unknown) => (typeof value === 'string' ? REASON_RU[value] ?? value : '');

    sheet.addRow({
      ...row,
      job_published_at: typeof row.job_published_at === 'string' ? row.job_published_at.slice(0, 10) : '',
      // Да/нет вместо true/false: файл читает продажник, а не разработчик.
      outbound_mandate: row.outbound_mandate === true ? 'да' : row.outbound_mandate === false ? 'нет' : '',
      status: typeof row.status === 'string' ? STATUS_RU[row.status] ?? row.status : '',
      exclusion_reason: reason(row.exclusion_reason),
      review_reason: reason(row.review_reason),
      letter1_subject: letter(1, 'subject'), letter1_body: letter(1, 'body'),
      letter2_subject: letter(2, 'subject'), letter2_body: letter(2, 'body'),
      letter3_subject: letter(3, 'subject'), letter3_body: letter(3, 'body'),
      letter4_subject: letter(4, 'subject'), letter4_body: letter(4, 'body'),
    });
  }

  const buffer = await workbook.xlsx.writeBuffer();
  const filename = `polza_outreach_${jobId.slice(0, 8)}.xlsx`;

  return new NextResponse(buffer as ArrayBuffer, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
