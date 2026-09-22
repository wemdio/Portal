import { NextRequest, NextResponse } from 'next/server';
import { isInternalUser } from '@/lib/auth/internalGuard';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { digestPeriod, digestPreview, digestTitle } from '@/lib/changelog/digest';

export const dynamic = 'force-dynamic';

/**
 * Сколько сводок держим в поле зрения. Дальше — история, которая в модалке уже
 * не нужна: сводка за позапрошлый месяц не «пропущенное обновление», а архив.
 */
const WINDOW_DAYS = 45;

interface DigestRow {
  id: number;
  window_from: string;
  window_to: string;
  summary: string;
}

async function authenticate(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return null;
  try {
    const supabase = createAuthedSupabaseClient(token);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return null;
    // Сводка написана про внутреннюю кухню: имена инструментов, воркеры,
    // лимиты. Клиенту и демо её показывать нельзя.
    if (!(await isInternalUser(supabase, user.id))) return null;
    return { user, supabase };
  } catch {
    return null;
  }
}

/**
 * GET — что показать человеку при входе: последняя непрочитанная сводка и
 * сколько до неё пропущено.
 *
 * Уведомления заводятся здесь же, лениво. Рассылать их всем сотрудникам в
 * момент появления сводки значило бы писать десятки строк тем, кто на портал
 * сегодня не зайдёт; а так запись появляется ровно у того, кто пришёл.
 */
export async function GET(req: NextRequest) {
  const auth = await authenticate(req);
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!supabaseAdmin) return NextResponse.json({ error: 'Сервис не настроен' }, { status: 503 });

  const sinceIso = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data: digestRows, error } = await supabaseAdmin
    .from('changelog_digests')
    .select('id, window_from, window_to, summary')
    .gte('window_to', sinceIso)
    .order('window_to', { ascending: false })
    .limit(60);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const digests = (digestRows ?? []).filter((d) => (d.summary ?? '').trim()) as DigestRow[];
  if (!digests.length) return NextResponse.json({ latest: null, missed: [] });

  const { count: seenCount } = await supabaseAdmin
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', auth.user.id)
    .not('changelog_digest_id', 'is', null);

  /**
   * Первый заход человека после запуска этой возможности.
   *
   * Архив сводок уже накоплен, и показать его целиком как «пропущенные» —
   * худшее первое впечатление: сорок штук, которые никто не читал и читать не
   * будет. Поэтому при первом заходе непрочитанной остаётся только свежая
   * сводка, а история сразу ложится прочитанной — в уведомлениях она есть, и
   * открыть её можно когда угодно.
   *
   * Дальше правило обычное: всё, что появилось после первого захода, копится
   * непрочитанным и попадает в «пропущенные».
   */
  const firstVisit = (seenCount ?? 0) === 0;
  const newestId = digests[0].id;

  // Заводим недостающие уведомления одной вставкой: уникальный индекс
  // (user_id, changelog_digest_id) делает повторный заход безобидным.
  const { error: insertError } = await supabaseAdmin
    .from('notifications')
    .upsert(
      digests.map((d) => ({
        user_id: auth.user.id,
        type: 'info',
        title: digestTitle(d.window_to),
        body: digestPreview(d.summary),
        changelog_digest_id: d.id,
        is_read: firstVisit && d.id !== newestId,
      })),
      { onConflict: 'user_id,changelog_digest_id', ignoreDuplicates: true },
    );
  if (insertError) return NextResponse.json({ error: insertError.message }, { status: 500 });

  const { data: unreadRows } = await supabaseAdmin
    .from('notifications')
    .select('changelog_digest_id')
    .eq('user_id', auth.user.id)
    .eq('is_read', false)
    .not('changelog_digest_id', 'is', null);

  const unread = new Set((unreadRows ?? []).map((r) => Number(r.changelog_digest_id)));
  const pending = digests.filter((d) => unread.has(d.id));
  if (!pending.length) return NextResponse.json({ latest: null, missed: [] });

  // Показываем последнюю, остальные считаются пропущенными: человек, не
  // заходивший три дня, не должен закрывать три окна подряд.
  const [latest, ...missed] = pending;
  return NextResponse.json({
    latest: {
      id: latest.id,
      title: digestTitle(latest.window_to),
      period: digestPeriod(latest.window_from, latest.window_to),
      summary: latest.summary,
    },
    missed: missed.map((d) => ({
      id: d.id,
      title: digestTitle(d.window_to),
      period: digestPeriod(d.window_from, d.window_to),
      summary: d.summary,
    })),
  });
}

/** POST — «Всё понятно»: гасим все непрочитанные сводки человека разом. */
export async function POST(req: NextRequest) {
  const auth = await authenticate(req);
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!supabaseAdmin) return NextResponse.json({ error: 'Сервис не настроен' }, { status: 503 });

  const { error } = await supabaseAdmin
    .from('notifications')
    .update({ is_read: true })
    .eq('user_id', auth.user.id)
    .eq('is_read', false)
    .not('changelog_digest_id', 'is', null);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
