/**
 * Отчёт по кампании в форме, приложенной к договору.
 *
 * `?format=xlsx` отдаёт файл, иначе — JSON для экрана. Считает одна и та же
 * функция (`buildCampaignReport`), чтобы на экране и в файле не могли оказаться
 * разные цифры.
 *
 * Собранный отчёт сохраняется (22.10.2026, таблица tg_outreach_reports): его
 * видно всем сотрудникам в истории справа от формы, с именем автора.
 *   - `?list=1`  — история отчётов кампании, свежие сверху;
 *   - `?id=…`    — сохранённый отчёт как он был собран (и `&format=xlsx` — файл по нему);
 *   - `?from&to` — собрать новый и сохранить; `&format=xlsx` сохранённое не плодит.
 */
import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';
import { buildReportWorkbook } from '@/lib/tgOutreach/reportWorkbook';
import {
  buildCampaignReport,
  type CampaignReport,
  type ReportContact,
  type ReportDialog,
  type ReportForward,
} from '@/lib/tgOutreach/report';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

const TZ_OFFSET_HOURS = 3;

export async function GET(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.campaigns.report.get' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      const { id: campaignId } = await ctx.params;

      const url = new URL(req.url);

      if (url.searchParams.get('list') === '1') {
        const { data: rows, error: listError } = await auth.supabase
          .from('tg_outreach_reports')
          .select('id, period_from, period_to, created_by_name, created_at')
          .eq('campaign_id', campaignId)
          .order('created_at', { ascending: false })
          .limit(100);
        if (listError) return jsonError(listError.message, 500);
        return NextResponse.json({ items: rows ?? [] });
      }

      const savedId = url.searchParams.get('id');
      if (savedId) {
        const { data: saved, error: savedError } = await auth.supabase
          .from('tg_outreach_reports')
          .select('id, campaign_id, period_from, period_to, report, created_by_name, created_at')
          .eq('id', savedId)
          .eq('campaign_id', campaignId)
          .maybeSingle();
        if (savedError) return jsonError(savedError.message, 500);
        if (!saved) return jsonError('Отчёт не найден', 404);
        const row = saved as {
          id: string; period_from: string; period_to: string; report: CampaignReport;
          created_by_name: string | null; created_at: string;
        };
        const { data: campRow } = await auth.supabase
          .from('tg_outreach_campaigns').select('id, name').eq('id', campaignId).maybeSingle();
        const campName = (campRow as { name?: string } | null)?.name ?? 'campaign';
        if (url.searchParams.get('format') === 'xlsx') {
          const buffer = await buildReportWorkbook(row.report, campName, row.period_from, row.period_to, TZ_OFFSET_HOURS);
          const fileName = `otchet-${slug(campName)}-${row.period_from.slice(0, 10)}_${row.period_to.slice(0, 10)}.xlsx`;
          return new NextResponse(buffer, {
            headers: {
              'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              'Content-Disposition': `attachment; filename="${fileName}"`,
            },
          });
        }
        return NextResponse.json({
          campaign: { id: campaignId, name: campName },
          from: row.period_from,
          to: row.period_to,
          report: row.report,
          saved: { id: row.id, created_by_name: row.created_by_name, created_at: row.created_at },
        });
      }

      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      if (!from || !to) return jsonError('from и to обязательны (ISO-даты)', 400);
      if (!Number.isFinite(new Date(from).getTime()) || !Number.isFinite(new Date(to).getTime())) {
        return jsonError('from и to должны быть датами', 400);
      }
      if (new Date(to).getTime() <= new Date(from).getTime()) {
        return jsonError('Конец периода должен быть позже начала', 400);
      }

      const { data: campaign } = await auth.supabase
        .from('tg_outreach_campaigns')
        .select('id, name')
        .eq('id', campaignId)
        .maybeSingle();
      if (!campaign) return jsonError('Кампания не найдена', 404);
      const camp = campaign as { id: string; name: string };

      // Базы теперь принадлежат кампании — контакты берём только по ним.
      const { data: baseRows } = await auth.supabase
        .from('tg_outreach_bases')
        .select('id, name, source_chats')
        .eq('campaign_id', campaignId);
      const bases = (baseRows ?? []) as Array<{ id: string; name: string; source_chats: string | null }>;

      let contacts: ReportContact[] = [];
      if (bases.length) {
        const { data: contactRows } = await auth.supabase
          .from('tg_outreach_base_contacts')
          .select('base_id, username, status, created_at, sent_at, raw')
          .in('base_id', bases.map((b) => b.id))
          .limit(50_000);
        contacts = (contactRows ?? []) as ReportContact[];
      }

      const { data: dialogRows } = await auth.supabase
        .from('tg_outreach_dialogs')
        .select('id, tg_user_id, tg_username, status, messages, last_message_at, auto_forwarded_at, lead_marked_at, can_send_changed_at, can_send_changed_reason')
        .eq('campaign_id', campaignId)
        .limit(20_000);

      // Ручные передачи карточки: «целевой ответ» — это переданный клиенту лид.
      const { data: forwardRows } = await auth.supabase
        .from('tg_outreach_lead_forwards')
        .select('dialog_id, status, requested_at, sent_at')
        .eq('campaign_id', campaignId)
        .eq('kind', 'lead');

      /**
       * Задачи парсера сюда больше не приходят. Раньше «обработанные чаты»
       * считались по ним — но к кампании они не привязаны, только к владельцу,
       * и в отчёт клиента попадали чаты, которые специалист парсил в тот же
       * период для другого клиента. Теперь чаты считаются по контактам самой
       * кампании, внутри buildCampaignReport.
       */
      const report = buildCampaignReport({
        from,
        to,
        tzOffsetHours: TZ_OFFSET_HOURS,
        dialogs: (dialogRows ?? []) as ReportDialog[],
        contacts,
        bases,
        forwards: (forwardRows ?? []) as ReportForward[],
      });

      if (url.searchParams.get('format') !== 'xlsx') {
        // Сохраняем собранный отчёт: имя автора берём из профиля, как у переносов.
        const { data: profile } = await auth.supabase
          .from('profiles').select('full_name, email').eq('id', auth.user.id).maybeSingle();
        const byName =
          (profile?.full_name as string | null) || (profile?.email as string | null) || auth.user.email || null;
        const { data: savedRow, error: saveError } = await auth.supabase
          .from('tg_outreach_reports')
          .insert({
            campaign_id: campaignId,
            period_from: from,
            period_to: to,
            report,
            created_by: auth.user.id,
            created_by_name: byName,
          })
          .select('id, created_by_name, created_at')
          .single();
        // Сбой сохранения не должен прятать готовые цифры: отчёт отдаём как есть.
        if (saveError) console.error('[tg-outreach][report] не удалось сохранить отчёт', saveError.message);
        return NextResponse.json({
          campaign: { id: camp.id, name: camp.name },
          from,
          to,
          report,
          saved: savedRow ?? null,
        });
      }

      const buffer = await buildReportWorkbook(report, camp.name, from, to, TZ_OFFSET_HOURS);
      const fileName = `otchet-${slug(camp.name)}-${from.slice(0, 10)}_${to.slice(0, 10)}.xlsx`;
      return new NextResponse(buffer, {
        headers: {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="${fileName}"`,
        },
      });
    },
  );
}

/** Имя кампании в имя файла: кириллица и пробелы в Content-Disposition лишние. */
function slug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'campaign';
}
