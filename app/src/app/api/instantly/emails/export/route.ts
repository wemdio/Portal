import { NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import { withAuth, jsonError } from '@/lib/instantly/apiRouteHelper';
import * as instantly from '@/lib/instantly/client';
import { buildEmailsExportRows } from '@/lib/instantly/emailsExport';
import type { Lead } from '@/lib/instantly/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export const GET = withAuth(async (req) => {
  const url = new URL(req.url);
  const campaignId = url.searchParams.get('campaign_id');
  const format = (url.searchParams.get('format') ?? 'xlsx') as 'csv' | 'xlsx';

  if (!campaignId) return jsonError('campaign_id is required', 400);

  // Fetch all emails and all leads for the campaign in parallel
  const [emails, leads] = await Promise.all([
    fetchAllEmails(campaignId),
    instantly.listAllLeads(campaignId),
  ]);

  const leadsById = new Map<string, Lead>(leads.map((l) => [l.id, l]));
  const rows = buildEmailsExportRows(emails, leadsById);

  if (rows.length === 0) {
    return jsonError('Нет писем в этой кампании', 404);
  }

  const ws = XLSX.utils.json_to_sheet(rows);

  // Auto-fit column widths based on content
  const colWidths = Object.keys(rows[0]).map((key) => {
    const maxLen = rows.reduce((max, row) => {
      const val = String(row[key as keyof typeof row] ?? '');
      return Math.max(max, val.length);
    }, key.length);
    return { wch: Math.min(maxLen, 80) };
  });
  ws['!cols'] = colWidths;

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Письма');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: format });
  const ext = format === 'csv' ? 'csv' : 'xlsx';
  const mime =
    format === 'csv'
      ? 'text/csv; charset=utf-8'
      : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  return new NextResponse(buf, {
    headers: {
      'Content-Type': mime,
      'Content-Disposition': `attachment; filename="emails-${campaignId.slice(0, 8)}.${ext}"`,
    },
  });
});

async function fetchAllEmails(campaignId: string) {
  const all = [];
  let startingAfter: string | undefined;

  do {
    const page = await instantly.listEmails({
      campaign_id: campaignId,
      limit: 100,
      starting_after: startingAfter,
    });
    if (page.items?.length) all.push(...page.items);
    startingAfter = page.next_starting_after ?? undefined;
  } while (startingAfter);

  return all;
}
