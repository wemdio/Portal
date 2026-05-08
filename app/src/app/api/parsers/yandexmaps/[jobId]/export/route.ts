import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';

export const dynamic = 'force-dynamic';

const PAGE = 5000;

const COLUMNS = [
  'name', 'phone', 'website', 'email', 'address', 'city',
  'categories', 'working_hours', 'rating', 'reviews_count',
  'card_url', 'telegram', 'vk', 'instagram', 'whatsapp',
] as const;

const HEADERS = [
  'Название', 'Телефон', 'Сайт', 'Email', 'Адрес', 'Город',
  'Категории', 'Часы работы', 'Рейтинг', 'Отзывы',
  'Ссылка', 'Telegram', 'VK', 'Instagram', 'WhatsApp',
];

function esc(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function getJobIdFromUrl(req: NextRequest) {
  const parts = req.nextUrl.pathname.split('/').filter(Boolean);
  return parts[parts.length - 2] ?? '';
}

export async function GET(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const jobId = getJobIdFromUrl(req);

  const lines: string[] = [HEADERS.join(',')];
  let offset = 0;

  for (;;) {
    const { data, error } = await supabase
      .from('yandex_maps_organizations')
      .select(COLUMNS.join(','))
      .eq('job_id', jobId)
      .order('created_at', { ascending: true })
      .range(offset, offset + PAGE - 1);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data || data.length === 0) break;

    for (const row of data) {
      lines.push(COLUMNS.map((c) => esc((row as Record<string, unknown>)[c])).join(','));
    }

    offset += data.length;
    if (data.length < PAGE) break;
  }

  const bom = '\uFEFF';
  const csv = bom + lines.join('\r\n');
  const now = new Date();
  const d = String(now.getDate()).padStart(2, '0');
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const filename = `yandex_${d}${m}${now.getFullYear()}_${jobId.slice(0, 8)}.csv`;

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}
