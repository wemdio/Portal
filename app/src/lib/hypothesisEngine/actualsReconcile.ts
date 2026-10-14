/**
 * Петля сверки прогноза «Движка вертикалей» с реальностью: после запуска
 * шаблона в Instantly подтягивает из instantly_dataset фактические
 * sent/replies по кампаниям запуска (he_templates.launch_info.campaigns)
 * и пишет их в he_verticals.actual_reply_pct / actual_sent /
 * actual_measured_at. Без этого предсказанный potential_pct никогда не
 * сверялся с фактом — «калибровка» была односторонней.
 *
 * Вызов — из loadHeProjectDetail и ENG-дашборда (best-effort,
 * fire-and-forget): свежесть замера 24ч на вертикаль, датасет дёргается только
 * при наличии запущенных кампаний и протухших метрик и не чаще раза в
 * MISS_RETRY_MS по тем же кампаниям. Никогда не бросает.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getCampaignActuals } from './datasetStats';
import { parseLaunchInfo } from './launchHandoff';

/** Метрики свежие — не пересчитываем чаще раза в сутки. */
const FRESH_MS = 24 * 60 * 60 * 1000;

/**
 * Окно после КАЖДОГО запроса к датасету по вертикали. Запрос, который записал
 * факт, двигает measured_at, и вертикаль сутки не спрашивается вовсе (FRESH_MS),
 * поэтому окно работает только у запросов без записи: кампании ещё не доехали
 * синком, отправок ноль, датасет не ответил, запись факта не легла.
 *
 * Без окна такой запрос повторялся на каждом полле: деталка проекта зовёт
 * сверку раз в 4 с, ENG-дашборд — раз в 15 с по каждому проекту, а
 * measured_at при промахе не двигается (иначе честный факт ждал бы сутки).
 * Датасет синкается ночью, поэтому ответ за полчаса не меняется почти никогда;
 * стоимость окна — до 30 мин задержки первой цифры после ночного синка.
 *
 * Память ПРОЦЕССА, а не строка БД: промах — не факт о вертикали, писать его
 * некуда и читать некому. Рестарт процесса окно сбрасывает — один лишний
 * запрос. Ключ — вертикаль вместе с набором кампаний: новый запуск (другие
 * кампании) спрашивает датасет сразу. Отметка ставится ДО запроса, поэтому
 * одновременные поллы, пока первый запрос идёт, второй не шлют.
 *
 * Рынок здесь не различается сознательно: блок «прогноз vs факт» есть и в
 * английском кабинете, и выход по market='us' его бы погасил.
 */
const MISS_RETRY_MS = 30 * 60 * 1000;
/** Потолок памяти окна: при переполнении выбрасываются истёкшие отметки. */
const MISS_MAX_ENTRIES = 5000;
const lastAttempt = new Map<string, { campaignsKey: string; at: number }>();

/** Спрашивать ли датасет по вертикали сейчас; true — отметка попытки уже поставлена. */
function claimDatasetAttempt(verticalId: string, campaignIds: string[], now: number): boolean {
  const campaignsKey = [...new Set(campaignIds)].sort().join(',');
  const prev = lastAttempt.get(verticalId);
  if (prev && prev.campaignsKey === campaignsKey && now - prev.at < MISS_RETRY_MS) return false;
  if (lastAttempt.size >= MISS_MAX_ENTRIES) {
    for (const [key, entry] of lastAttempt) {
      if (now - entry.at >= MISS_RETRY_MS) lastAttempt.delete(key);
    }
  }
  lastAttempt.set(verticalId, { campaignsKey, at: now });
  return true;
}

export async function reconcileProjectVerticals(
  supabase: SupabaseClient,
  projectId: string,
): Promise<void> {
  try {
    const { data: verticals, error: vErr } = await supabase
      .from('he_verticals')
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
      .from('he_templates')
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
        // Недавний запрос по тем же кампаниям ничего не дал — датасет не
        // спрашиваем до конца окна (MISS_RETRY_MS).
        if (!claimDatasetAttempt(verticalId, campaignIds, Date.now())) continue;
        const actuals = await getCampaignActuals(campaignIds);
        // null — кампании ещё не синкнулись в датасет: measured_at НЕ двигаем,
        // чтобы визит после окна попробовал снова.
        if (!actuals || actuals.sent === 0) continue;
        await supabase
          .from('he_verticals')
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
