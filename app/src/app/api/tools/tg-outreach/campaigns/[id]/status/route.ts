import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * Состояние кампании для шапки: статус из базы ПЛЮС незавершённые задачи.
 *
 * Одного статуса мало. Остановка в базе ничего не меняет сразу: ручка кладёт
 * задачу, воркер подхватывает её в течение минуты, а сам круг сворачивается
 * ещё минуты — отключает клиентов, дописывает отправки. Всё это время статус
 * в базе прежний, и шапка, читающая только его, показывала «Запущена» у
 * кампании, которую оператор уже остановил. Признак «останавливается» жил
 * только в памяти страницы и пропадал при перезагрузке.
 *
 * Обратное тоже важно: пока старая start-задача висит в работе, новую создать
 * нельзя (частичный уникальный индекс), и шапка обязана это показать — иначе
 * кнопка «Запустить» молча не срабатывает.
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.campaigns.by-id.status.get' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      const { id } = await ctx.params;

      const { data: campaign, error } = await auth.supabase
        .from('tg_outreach_campaigns')
        .select('id, status, updated_at')
        .eq('id', id)
        .single();

      if (error) return jsonError('Кампания не найдена', 404);

      // Одним запросом вместо двух счётчиков: задач у кампании единицы.
      const { data: jobs } = await auth.supabase
        .from('tg_outreach_jobs')
        .select('action, status')
        .eq('campaign_id', id)
        .in('action', ['start', 'stop'])
        .in('status', ['pending', 'running']);

      const active = (jobs ?? []) as { action: string; status: string }[];
      const hasActiveStart = active.some((j) => j.action === 'start');
      const hasActiveStop = active.some((j) => j.action === 'stop');
      const startClaimed = active.some((j) => j.action === 'start' && j.status === 'running');

      /**
       * Что показать в шапке.
       *
       * «Сворачивается» — это не только задача остановки. Воркер ставит статус
       * `stopped` сразу, как её увидел, а круг после этого живёт ещё минуты:
       * отключает клиентов, дописывает отправки. Всё это время его start-задача
       * остаётся в работе — она и есть признак, что кампания ещё не свернулась
       * и новый запуск пока не создать.
       */
      const windingDown = hasActiveStop || (hasActiveStart && campaign.status !== 'running');
      const phase = windingDown
        ? 'stopping'
        : campaign.status === 'running' && !startClaimed
          ? 'starting'
          : campaign.status;

      return NextResponse.json({
        ...campaign,
        phase,
        has_active_start: hasActiveStart,
        has_active_stop: hasActiveStop,
        /** Можно ли прямо сейчас создать задачу запуска (см. уникальный индекс). */
        can_start: !hasActiveStart && !hasActiveStop,
        is_running: campaign.status === 'running' && hasActiveStart,
      });
    },
  );
}
