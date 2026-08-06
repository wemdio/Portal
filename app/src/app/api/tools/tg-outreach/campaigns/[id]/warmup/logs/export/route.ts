import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * Потолок строк. Прогрев на 16 аккаунтов пишет ~16 строк подключения на каждый
 * круг плюс по строке на реплику: за четыре дня это тысячи записей, но до
 * сотни тысяч не доходит. 200k — с большим запасом, чтобы выгрузка не могла
 * положить память процесса.
 */
const MAX_ROWS = 200_000;
const PAGE_SIZE = 1_000;

function slugify(name: string | null | undefined, fallback: string): string {
  const raw = (name ?? '').trim();
  if (!raw) return fallback;
  return raw
    .replace(/[\\/:*?"<>|]+/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 60);
}

function formatLine(row: { created_at: string; level: string; message: string }): string {
  const ts = row.created_at
    ? new Date(row.created_at).toISOString().replace('T', ' ').slice(0, 19)
    : '????-??-?? ??:??:??';
  const level = (row.level ?? 'info').toUpperCase().padEnd(7, ' ');
  return `${ts}  ${level}  ${row.message ?? ''}\n`;
}

/**
 * Выгрузка логов прогрева за весь период одним файлом.
 *
 * Отдельно от экспорта логов кампании: там окна на 6ч/24ч/7д, а прогрев живёт
 * несколько суток и разбирают его целиком — «что вообще происходило с первого
 * дня». Выбирать диапазон незачем, поэтому и параметра range здесь нет.
 *
 * Порядок хронологический: файл читается сверху вниз от старого к новому, как
 * читают логи. В самом интерфейсе порядок обратный — там смотрят последнее.
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.campaigns.by-id.warmup.logs.export.get' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;

      const { id: campaignId } = await ctx.params;

      const { data: campaign, error: cErr } = await auth.supabase
        .from('tg_outreach_campaigns')
        .select('id, name')
        .eq('id', campaignId)
        .maybeSingle();
      if (cErr) return jsonError(cErr.message, 500);
      if (!campaign) return jsonError('Кампания не найдена', 404);

      // run_id — необязательный фильтр: если прогревов было несколько, можно
      // выгрузить конкретный. Без него отдаём всё, что есть по кампании.
      const runId = new URL(req.url).searchParams.get('run_id');

      let from = 0;
      let totalRows = 0;
      const chunks: string[] = [];

      while (totalRows < MAX_ROWS) {
        let query = auth.supabase
          .from('tg_outreach_warmup_logs')
          .select('created_at, level, message')
          .eq('campaign_id', campaignId);
        if (runId) query = query.eq('run_id', runId);

        // Сортируем по id, а не по created_at: у записей одной переписки
        // таймстампы совпадают до миллисекунды, и постраничная выборка по
        // времени теряла бы часть строк на границах страниц.
        const { data, error } = await query
          .order('id', { ascending: true })
          .range(from, from + PAGE_SIZE - 1);

        if (error) return jsonError(error.message, 500);
        if (!data || data.length === 0) break;

        for (const row of data) {
          chunks.push(formatLine(row as { created_at: string; level: string; message: string }));
          totalRows++;
          if (totalRows >= MAX_ROWS) break;
        }

        if (data.length < PAGE_SIZE) break;
        from += PAGE_SIZE;
      }

      const truncated = totalRows >= MAX_ROWS;
      const header =
        `# TG Outreach — логи прогрева за весь период\n` +
        `# кампания: ${campaign.name ?? campaignId} (${campaignId})\n` +
        (runId ? `# прогрев:  ${runId}\n` : '') +
        `# выгружено: ${new Date().toISOString()}\n` +
        `# строк:     ${totalRows}${truncated ? ` (ОБРЕЗАНО на MAX_ROWS=${MAX_ROWS})` : ''}\n` +
        `# ─────────────────────────────────────────────────────────────────────\n`;

      const body = header + chunks.join('');

      const today = new Date().toISOString().slice(0, 10);
      const filename = `tg-warmup-${slugify(campaign.name, campaignId)}-${today}.txt`;

      return new NextResponse(body, {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          // ASCII-запас плюс форма RFC 5987: кириллица в имени кампании иначе
          // не переживает загрузку браузером.
          'Content-Disposition':
            `attachment; filename="tg-warmup-${campaignId}-${today}.txt"; ` +
            `filename*=UTF-8''${encodeURIComponent(filename)}`,
          'Cache-Control': 'no-store',
        },
      });
    },
  );
}
