import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import type { ClientNavMode } from '@/lib/clientNav';
import type { ClientMarket } from '@/lib/engMarket';

export const dynamic = 'force-dynamic';

/**
 * GET /api/client/portal-mode
 *
 * Возвращает текущий режим работы клиента в портале:
 *   - 'auto'   — авто-пайплайн HH → endpoint → Instantly. Видны только
 *                Дашборд / Ответы / Лиды / Отчёты / Поддержка.
 *   - 'manual' — обычный режим. Виден весь UI (Старт / Мониторинг / Архив).
 *
 * Решение принимается по profiles.auto_pipeline_enabled И существованию
 * client_auto_pipeline_configs.enabled = true. Оба источника должны
 * совпадать — иначе режим manual (защита от рассинхрона админских флагов).
 *
 * Помимо mode отдаёт profiles.market ('ru'|'eng') — layout разводит по нему
 * навигацию: eng-клиент видит только ENG-кабинет, ru — всё кроме ENG.
 *
 * Используется /client/layout.tsx один раз при загрузке.
 */
export async function GET(req: NextRequest) {
  try {
    const token = getBearerToken(req.headers.get('authorization'));
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const supabase = createAuthedSupabaseClient(token);
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    // 1) Флаг на profile + рынок профиля.
    const { data: profile, error: profileErr } = await supabase
      .from('profiles')
      .select('auto_pipeline_enabled, market')
      .eq('id', user.id)
      .single();

    if (profileErr) {
      return NextResponse.json({ error: profileErr.message }, { status: 500 });
    }

    const profileEnabled = Boolean(
      (profile as { auto_pipeline_enabled?: boolean } | null)?.auto_pipeline_enabled,
    );
    // Только 'eng' — маркер ENG-мира; всё остальное (включая старые строки
    // без колонки) — 'ru'.
    const market: ClientMarket =
      (profile as { market?: string } | null)?.market === 'eng' ? 'eng' : 'ru';

    if (!profileEnabled) {
      return NextResponse.json({ mode: 'manual' satisfies ClientNavMode, market });
    }

    // 2) Конфиг enabled. Идём через supabaseAdmin, т.к. у клиента read-only
    //    доступ к собственной строке (через RLS), но это всё равно требует
    //    отдельного запроса; держим логику симметрично admin-проверке.
    if (!supabaseAdmin) {
      return NextResponse.json({ mode: 'manual' satisfies ClientNavMode, market });
    }

    const { data: config } = await supabaseAdmin
      .from('client_auto_pipeline_configs')
      .select('enabled')
      .eq('client_user_id', user.id)
      .maybeSingle();

    const configEnabled = Boolean((config as { enabled?: boolean } | null)?.enabled);

    return NextResponse.json({
      mode: (profileEnabled && configEnabled ? 'auto' : 'manual') satisfies ClientNavMode,
      market,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 },
    );
  }
}
