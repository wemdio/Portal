import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CSV_HEADERS = [
  'Company', 'Website', 'Founder', 'LinkedIn', 'Email (guess)',
  'Description', 'Niche', 'Signal', 'Signal Detail', 'Score',
  'Priority', 'Outreach Angle', 'Timing', 'Source URL', 'Date',
];

function escapeCsvField(value: string | null | undefined): string {
  const str = value ?? '';
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
  const priority = searchParams.get('priority');

  let query = supabaseAdmin
    .from('bugor_outreach_leads')
    .select('*')
    .order('intent_score', { ascending: false })
    .limit(500);

  if (batchDate) query = query.eq('batch_date', batchDate);
  if (priority) query = query.eq('priority', priority);

  const { data, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = (data ?? []).map((lead) =>
    [
      lead.company_name,
      lead.website,
      lead.founder_name,
      lead.founder_linkedin,
      lead.email_guess,
      lead.description,
      lead.niche,
      lead.signal_type,
      lead.signal_detail,
      String(lead.intent_score),
      lead.priority,
      lead.outreach_angle,
      lead.timing,
      lead.source_url,
      lead.batch_date,
    ]
      .map(escapeCsvField)
      .join(','),
  );

  const bom = '\uFEFF';
  const csv = bom + CSV_HEADERS.join(',') + '\n' + rows.join('\n');

  const filename = `bugor-leads-${batchDate ?? 'all'}.csv`;

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}
