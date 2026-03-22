import { NextResponse } from 'next/server';
import { withAuth, jsonError } from '@/lib/instantly/apiRouteHelper';
import * as instantly from '@/lib/instantly/client';
import * as XLSX from 'xlsx';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const INTEREST: Record<number, string> = {
  0: 'Не обработан',
  1: 'Заинтересован',
  [-1]: 'Не заинтересован',
  [-2]: 'Ответ получен',
  [-3]: 'Неверный контакт',
};

export const GET = withAuth(async (req) => {
  const url = new URL(req.url);
  const campaignId = url.searchParams.get('campaign_id');
  const format = (url.searchParams.get('format') ?? 'xlsx') as 'csv' | 'xlsx';
  if (!campaignId) return jsonError('campaign_id is required', 400);

  const leads = await instantly.listAllLeads(campaignId);

  const rows = leads.map((l) => ({
    Email: l.email,
    'Имя': l.first_name ?? '',
    'Фамилия': l.last_name ?? '',
    'Компания': l.company_name ?? '',
    'Должность': l.title ?? '',
    'Телефон': l.phone ?? '',
    'Сайт': l.website ?? '',
    'Статус': INTEREST[l.interest_status ?? 0] ?? '',
    'Добавлен': l.timestamp_created ? new Date(l.timestamp_created).toLocaleDateString('ru-RU') : '',
  }));

  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Leads');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: format });
  const ext = format === 'csv' ? 'csv' : 'xlsx';
  const mime = format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  return new NextResponse(buf, {
    headers: {
      'Content-Type': mime,
      'Content-Disposition': `attachment; filename="leads-${campaignId.slice(0, 8)}.${ext}"`,
    },
  });
});
