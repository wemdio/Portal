/**
 * Петля сверки прогноза «Движка вертикалей» с реальностью: после запуска
 * шаблона в Instantly подтягивает из instantly_dataset фактические
 * sent/replies по кампаниям запуска (ve_templates.launch_info.campaigns)
 * и пишет их в ve_verticals.actual_reply_pct / actual_sent /
 * actual_measured_at. Без этого предсказанный potential_pct никогда не
 * сверялся с фактом — «калибровка» была односторонней.
 *
 * Вызов — из loadVeProjectDetail (best-effort, fire-and-forget): свежесть
 * замера 24ч на вертикаль, датасет дёргается только при наличии запущенных
 * кампаний и протухших метрик. Никогда не бросает.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getCampaignActuals } from './datasetStats';
import { parseLaunchInfo } from './launchHandoff';

/** Метрики свежие — не пересчитываем чаще раза в сутки. */
const FRESH_MS = 24 * 60 * 60 * 1000;

export async function reconcileProjectVerticals(
  supabase: SupabaseClient,
  projectId: string,
): Promise<void> {
  try {
    const { data: verticals, error: vErr } = await supabase
      .from('ve_verticals')
      .select('id, actual_measured_at')
      .eq('project_id', projectId);
    if (vErr || !verticals?.length) return;

    const staleIds = new Set(
      (verticals as Array<{ id: string; actual_measured_at: string | null }>)
        .filter((v) => {
          if (!v.actual_measured_at) return true;
          const ts = new Date(v.actual_measured_at).getTime();
          return Number.isNaN(ts) || Date.now() - ts > FRESH_MS;
        })
        .map((v) => v.id),
    );
    if (!staleIds.size) return;

    const { data: templates, error: tErr } = await supabase
      .from('ve_templates')
      .select('vertical_id, launch_info')
      .in('vertical_id', [...staleIds])
      .not('launch_info', 'is', null);
    if (tErr || !templates?.length) return;

    // campaign ids по вертикали (все кампании запуска, включая сегментные).
    const campaignsByVertical = new Map<string, string[]>();
    for (const t of templates as Array<{ vertical_id: string; launch_info: unknown }>) {
      const info = parseLaunchInfo(t.launch_info);
      if (!info) continue;
      const ids = (info.campaigns?.length
        ? info.campaigns.map((c) => c.campaign_id)
        : [info.campaign_id]
      ).filter(Boolean);
      if (!ids.length) continue;
      const bucket = campaignsByVertical.get(t.vertical_id) ?? [];
      bucket.push(...ids);
      campaignsByVertical.set(t.vertical_id, bucket);
    }

    for (const [verticalId, campaignIds] of campaignsByVertical) {
      try {
        const actuals = await getCampaignActuals(campaignIds);
        // null — кампании ещё не синкнулись в датасет: measured_at НЕ двигаем,
        // чтобы следующий визит попробовал снова.
        if (!actuals || actuals.sent === 0) continue;
        await supabase
          .from('ve_verticals')
          .update({
            actual_reply_pct: actuals.reply_pct,
            actual_sent: actuals.sent,
            actual_measured_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', verticalId);
      } catch {
        // одна вертикаль не помешает остальным
      }
    }
  } catch {
    // петля сверки — строго best-effort, деталка проекта не зависит от неё
  }
}
