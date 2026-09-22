import { NextRequest, NextResponse } from 'next/server';
import { isInternalUser } from '@/lib/auth/internalGuard';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { digestPeriod, digestTitle } from '@/lib/changelog/digest';

export const dynamic = 'force-dynamic';

/**
 * GET — одна сводка целиком.
 *
 * Нужна карточке уведомления: в списке лежит только первая строка сводки,
 * полный текст хранится в changelog_digests и тянется по клику. Класть его
 * целиком в каждое уведомление значило бы держать десятки копий одного текста.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!supabaseAdmin) return NextResponse.json({ error: 'Сервис не настроен' }, { status: 503 });

  try {
    const supabase = createAuthedSupabaseClient(token);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (!(await isInternalUser(supabase, user.id))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const digestId = Number(id);
  if (!Number.isInteger(digestId)) return NextResponse.json({ error: 'Неверный id' }, { status: 400 });

  const { data, error } = await supabaseAdmin
    .from('changelog_digests')
    .select('id, window_from, window_to, summary')
    .eq('id', digestId)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: 'Сводка не найдена' }, { status: 404 });

  return NextResponse.json({
    id: data.id,
    title: digestTitle(String(data.window_to)),
    period: digestPeriod(String(data.window_from), String(data.window_to)),
    summary: String(data.summary ?? ''),
  });
}
