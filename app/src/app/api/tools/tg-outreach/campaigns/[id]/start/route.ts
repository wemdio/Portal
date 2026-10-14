import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** Один текст на оба случая: для оператора это одно и то же ожидание. */
const STOPPING_MESSAGE = 'Прошлый запуск ещё завершается — кампания стартует сама, как только он закроется.';

export async function POST(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.campaigns.by-id.start.post' },
    async () => {
      
        const auth = await authenticateRequest(req.headers.get('authorization'));
        if ('error' in auth) return auth.error;
        const { supabase, user } = auth;
        const { id } = await ctx.params;
      
        const { data: campaign } = await supabase
          .from('tg_outreach_campaigns')
          .select('id, status')
          .eq('id', id)
          .single();
      
        if (!campaign) return jsonError('Кампания не найдена', 404);
        if (campaign.status === 'running') return jsonError('Кампания уже запущена', 409);
        // Идущий прогрев запуску не мешает: взаимоисключающими остаются
        // аккаунт и его роль, а не кампания целиком. Отмеченные на прогрев
        // боевой круг пропускает сам.

        /**
         * Незавершённые задачи кампании. Пока старая start-задача висит в
         * работе — а висит она всё то время, пока круг сворачивается после
         * «Остановить», то есть минуты, — новую создать нельзя: этого не даст
         * частичный уникальный индекс tg_outreach_jobs_one_active_start_per_campaign_idx.
         *
         * Раньше запрос просто падал на индексе, ручка отдавала 500 с текстом
         * Postgres, а страница его не показывала: кнопка «Запустить»
         * прокручивала спиннер и возвращалась в исходное — и так пять раз
         * подряд, пока остановка не дойдёт до конца. Теперь это отдельный
         * внятный ответ, по которому страница сама дожидается и повторяет.
         */
        const { data: activeJobs } = await supabase
          .from('tg_outreach_jobs')
          .select('action')
          .eq('campaign_id', id)
          .in('action', ['start', 'stop'])
          .in('status', ['pending', 'running']);

        // Любая незакрытая задача запуска или остановки — одно и то же ожидание.
        if ((activeJobs ?? []).length > 0) {
          return jsonError(STOPPING_MESSAGE, 409, { code: 'stopping' });
        }

        const { data, error } = await supabase
          .from('tg_outreach_jobs')
          .insert({ campaign_id: id, user_id: user.id, action: 'start' })
          .select()
          .single();

        if (error) {
          // Гонка с проверкой выше (два оператора, двойной клик) — тот же
          // индекс, тот же ответ.
          if (error.code === '23505') return jsonError(STOPPING_MESSAGE, 409, { code: 'stopping' });
          if (error.code === '23503') {
            return jsonError('Профиль пользователя не найден. Обратитесь к администратору.', 409);
          }
          console.error('[tg-outreach][start] failed to enqueue start job', {
            campaignId: id,
            userId: user.id,
            code: error.code,
            message: error.message,
          });
          return jsonError(error.message, 500);
        }
      
        await supabase
          .from('tg_outreach_campaigns')
          .update({ status: 'running', updated_at: new Date().toISOString() })
          .eq('id', id);
      
        return NextResponse.json(data, { status: 201 });
    },
  );
}
