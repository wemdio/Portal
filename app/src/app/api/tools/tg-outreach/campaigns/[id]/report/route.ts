/**
 * Отчёт по кампании в форме, приложенной к договору.
 *
 * `?format=xlsx` отдаёт файл, иначе — JSON для экрана. Считает одна и та же
 * функция (`buildCampaignReport`), чтобы на экране и в файле не могли оказаться
 * разные цифры.
 */
import { NextRequest, NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';
import {
  buildCampaignReport,
  formatDate,
  type CampaignReport,
  type ReportContact,
  type ReportDialog,
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
        .select('tg_user_id, tg_username, status, messages, last_message_at, can_send_changed_at, can_send_changed_reason')
        .eq('campaign_id', campaignId)
        .limit(20_000);

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
      });

      if (url.searchParams.get('format') !== 'xlsx') {
        return NextResponse.json({ campaign: { id: camp.id, name: camp.name }, from, to, report });
      }

      const buffer = buildWorkbook(report, camp.name, from, to);
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

const SECTION_1_HEADER = [
  'Период',
  'Кол-во обработанных чатов',
  'Кол-во подобранных контактов',
  'Сообщений доставлено',
  'Кол-во любых ответов',
  'Кол-во целевых ответов',
  'Кол-во блокировок',
  'Конверсия "Отправлено - ответ", %',
];

const SECTION_2_HEADER = [
  'Чат/группа откуда взят контакт',
  'Критерий отбора данного контакта',
  'Никнейм',
  'Дата отправки оффера',
  '№ оффера',
  'Качество лида',
  'Дата передачи лида клиенту',
];

const SECTION_3_HEADER = [
  '№ Оффера',
  'Оффер',
  'Канал/чат',
  'Язык аудитории',
  'Статус',
  'Дедлайн',
  'Комментарий/ссылки',
  'Выводы с цифрами',
];

/**
 * Один лист, три раздела подряд — как в бумажной форме. Разделять по вкладкам
 * нельзя: отчёт подписывают целиком и сверяют глазами с приложением к договору.
 */
function buildWorkbook(report: CampaignReport, campaignName: string, from: string, to: string): ArrayBuffer {
  const fromMs = new Date(from).getTime();
  const toMs = new Date(to).getTime();
  const rows: Array<Array<string | number | null>> = [];

  rows.push(['Форма Отчета к Договору оказания услуг']);
  rows.push([`За период с «${formatDate(fromMs, TZ_OFFSET_HOURS)}» по «${formatDate(toMs - 1, TZ_OFFSET_HOURS)}»`]);
  rows.push([`Кампания: ${campaignName}`]);
  rows.push([]);

  rows.push(['1. Рассылка и реакция']);
  rows.push(SECTION_1_HEADER);
  for (const w of [...report.weeks, report.total]) {
    rows.push([
      w.period, w.chats === null ? '—' : w.chats, w.contacts, w.delivered,
      w.anyReplies, w.targetReplies, w.blocks,
      w.conversion === null ? '—' : w.conversion,
    ]);
  }
  rows.push([]);

  rows.push(['2. Лиды']);
  rows.push(SECTION_2_HEADER);
  for (const l of report.leads) {
    rows.push([l.sourceChat, l.criterion, l.nickname, l.offerSentAt, l.offerNumber, l.quality, l.handedOverAt]);
  }
  // Пустая строка под ручное дозаполнение, если лидов за период не было.
  if (report.leads.length === 0) rows.push(['', '', '', '', '', '', '']);
  rows.push([]);

  rows.push(['3. План работ и Офферы']);
  rows.push(SECTION_3_HEADER);
  for (const o of report.offers) {
    rows.push([o.offerNumber, o.offer, o.channel, o.language, o.status, o.deadline, o.comment, o.conclusions]);
  }
  if (report.offers.length === 0) rows.push(['', '', '', '', '', '', '', '']);

  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet['!cols'] = [
    { wch: 34 }, { wch: 26 }, { wch: 26 }, { wch: 22 },
    { wch: 20 }, { wch: 20 }, { wch: 18 }, { wch: 30 },
  ];

  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Отчёт');
  // Отдаём именно ArrayBuffer: Node-Buffer из xlsx типы Response телом не
  // принимают, а копия среза избавляет от привязки к пулу Buffer'ов.
  const bytes = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Uint8Array;
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
