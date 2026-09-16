import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

/**
 * Поставить выделенные аккаунты на прогрев (или снять с него).
 *
 * Массовая ручка, потому что аккаунты приезжают партиями: новая закупка — это
 * пятнадцать строк, которые надо развести с боевой рассылкой одним действием, а
 * не пятнадцатью.
 *
 * Срок, а не флаг: партия, поставленная на неделю, сама уходит в бой. Боевой
 * круг и прогрев смотрят на одно и то же поле с разных сторон, так что третьего
 * состояния «забыли снять» не возникает.
 */
export async function POST(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.accounts.warmup.post' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;

      let body: { account_ids?: unknown; days?: unknown };
      try {
        body = await req.json();
      } catch {
        return jsonError('Неверный JSON', 400);
      }

      const ids = Array.isArray(body.account_ids)
        ? body.account_ids.filter((v): v is string => typeof v === 'string' && v.length > 0)
        : [];
      if (!ids.length) return jsonError('account_ids должен быть непустым массивом', 400);

      // days = 0 снимает прогрев: отдельной ручки «снять» не заводим, чтобы
      // состояние всегда задавалось одним и тем же полем.
      const days = Number(body.days);
      if (!Number.isFinite(days) || days < 0 || days > 60) {
        return jsonError('days должен быть числом от 0 до 60', 400);
      }

      const warmupUntil = days > 0
        ? new Date(Date.now() + days * 86_400_000).toISOString()
        : null;

      const { data, error } = await auth.supabase
        .from('tg_outreach_accounts')
        .update({ warmup_until: warmupUntil })
        .in('id', ids)
        .select('id');

      if (error) return jsonError(error.message, 500);

      return NextResponse.json({ updated: data?.length ?? 0, warmup_until: warmupUntil });
    },
  );
}
