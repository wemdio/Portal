import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { buildAutoReportFromProviderItems, type OnProgressCallback } from '@/lib/tools/autoReportBuilder';

/**
 * «Автоотчёты» по кампаниям «Рассылки»: цифры из базы одним запросом
 * (sender_auto_report) в форме аналитики Instantly, отчёт — тот же построитель,
 * что у Instantly. Открытий в отчёте нет: трекинга у «Рассылки» нет намеренно.
 */
export async function buildSenderAutoReport(
  db: SupabaseClient,
  campaignIds: string[],
  onProgress?: OnProgressCallback,
): Promise<ReturnType<typeof buildAutoReportFromProviderItems>> {
  if (!campaignIds.length) throw new Error('Не указаны ID кампаний');

  const { data, error } = await db.rpc('sender_auto_report', { p_campaign_ids: campaignIds });
  if (error) throw new Error(`Цифры «Рассылки» не прочитаны: ${error.message}`);
  const rows = (Array.isArray(data) ? data : []) as {
    campaign_id: string;
    summary: Record<string, unknown>;
    steps: unknown[];
  }[];
  if (!rows.length) throw new Error('Кампании «Рассылки» не найдены');

  rows.forEach((row, index) =>
    onProgress?.({ current: index + 1, total: campaignIds.length, campaignId: String(row.campaign_id), phase: 'done' }),
  );

  const report = buildAutoReportFromProviderItems(
    rows.map((row) => ({ summary: row.summary, steps: Array.isArray(row.steps) ? row.steps : [] })),
  );
  const missing = campaignIds.length - rows.length;
  if (missing > 0) {
    report.tableText = `\n⚠ ${missing} из ${campaignIds.length} кампаний «Рассылки» не найдены. Отчёт сформирован по остальным.\n${report.tableText}`;
  }
  return report;
}
