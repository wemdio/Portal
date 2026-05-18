import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CSV_HEADERS = [
  'Компания', 'ИНН', 'КПП', 'ОГРН', 'Адрес', 'Отрасль', 'ОКВЭД',
  'Сотрудников', 'Выручка', 'Сайт', 'Email', 'Источник email',
  'Возраст', 'Юбилей', 'Год юбилея', 'Вакансий ивент', 'Ищут ивент-менеджера',
  'Сигналы', 'Tier', 'Hook', 'Тема письма', 'Дата',
];

function escapeCsvField(value: unknown): string {
  const str = value === null || value === undefined ? '' : String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export async function GET(req: NextRequest) {
  if (!supabaseAdmin) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const { searchParams } = req.nextUrl;
  const batchDate = searchParams.get('batch_date');
  const tier = searchParams.get('tier');

  let query = supabaseAdmin
    .from('event_outreach_leads')
    .select('*')
    .order('tier', { ascending: true })
    .order('created_at', { ascending: false })
    .limit(2000);

  if (batchDate) query = query.eq('batch_date', batchDate);
  if (tier) query = query.eq('tier', tier);

  const { data, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = (data ?? []).map((lead) =>
    [
      lead.company_name,
      lead.inn,
      lead.kpp,
      lead.ogrn,
      lead.address,
      lead.industry,
      lead.okved_code,
      lead.employees_count,
      lead.revenue,
      lead.website,
      lead.email,
      lead.email_source,
      lead.company_age,
      lead.is_anniversary ? 'да' : 'нет',
      lead.anniversary_year,
      lead.hh_vacancies_count,
      lead.seeking_event_manager ? 'да' : 'нет',
      Array.isArray(lead.detected_signals) ? lead.detected_signals.join('; ') : '',
      lead.tier,
      lead.hook,
      lead.subject_line,
      lead.batch_date,
    ]
      .map(escapeCsvField)
      .join(','),
  );

  const bom = '﻿';
  const csv = bom + CSV_HEADERS.join(',') + '\n' + rows.join('\n');
  const filename = `event-outreach-${batchDate ?? 'all'}.csv`;

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}
