import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireFirstSalesAccess } from '@/lib/firstSales/access';
import { parseFirstSalesParams } from '@/lib/firstSales/params';
import { MEETING_CHAT_ID } from '@/lib/firstSales/meetings';
import { chunkArray, IN_CHUNK_SIZE } from '@/lib/cisLeads/batchedQuery';

// Роут авторизуется по заголовку и зависит от query — предрендер здесь дал бы
// либо пустой ответ, либо чужой. Тот же паттерн, что у соседних роутов
// аналитики первички (summary/leads/source-map).
export const dynamic = 'force-dynamic';

const PIPELINE_ID = Number(process.env.FIRST_SALES_PIPELINE_ID ?? '7670334');

/** Первые ~200 символов расшифровки — достаточно, чтобы узнать разговор, не
 *  открывая видео (см. план, Task 3), но не вся запись целиком. */
const TRANSCRIPT_PREVIEW_LEN = 200;

/** Защитный потолок на размер очереди за одно окно. Реальный поток —
 *  единицы-десятки записей в месяц (см. план: 28 неразмеченных в июле), так
 *  что предел практически недостижим при разумном периоде; он страхует от
 *  случайно широкого диапазона дат (до `MAX_RANGE_DAYS` в params.ts), а не
 *  описывает штатный размер очереди. */
const QUEUE_MAX_ROWS = 300;

/**
 * Минимум символов для поиска сделки. Без порога первый же ввод одной буквы
 * в поле поиска даёт ILIKE '%а%' по названию/сайту компании на всей воронке
 * первички — это сотни строк на каждое нажатие клавиши, а не подсказка.
 */
const SEARCH_MIN_CHARS = 2;

/** Похожих сделок может быть больше — человек должен видеть, что список
 *  обрезан, и уточнить запрос, а не полагаться на «раз показали, значит все». */
const SEARCH_MAX_ROWS = 20;

type TranscriptRow = {
  id: string;
  tg_message_date: string | null;
  caption: string | null;
  filename: string;
  text: string | null;
};

type DealSearchRow = {
  amo_id: number;
  name: string | null;
  company_name: string | null;
  company_website: string | null;
  created_at: string | null;
  status_name: string | null;
};

export async function GET(req: NextRequest) {
  const gate = await requireFirstSalesAccess(req);
  if ('error' in gate) return gate.error;
  const db = gate.supabaseAdmin;

  const url = new URL(req.url);

  // Наличие параметра `q` (даже пустого) переключает роут в режим поиска
  // сделки — отдельная форма ответа ({ rows: DealSearchRow[] }), не очередь.
  if (url.searchParams.has('q')) {
    return handleDealSearch(db, url.searchParams.get('q') ?? '');
  }

  const parsed = parseFirstSalesParams(url);
  if (parsed.value === null) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const { from, to } = parsed.value;

  // `countOnly=1` — дашборд рисует число рядом с кнопкой «Записи без сделки»
  // ещё до того, как панель открыта, и сама очередь ему при этом не нужна.
  // Разница не косметическая: `text` — полная расшифровка разговора, за
  // тридцатидневное окно это больше мегабайта, который читался из базы на
  // каждую загрузку дашборда ради одной цифры в скобках.
  const countOnly = url.searchParams.get('countOnly') === '1';

  try {
    // Очередь работы: чем старше запись, тем дольше она не разобрана —
    // разбираем от старых к новым, а не наоборот, чтобы хвост не рос вечно.
    const { data, error } = await db
      .from('tg_video_transcripts')
      .select(countOnly ? 'id' : 'id, tg_message_date, caption, filename, text')
      .eq('tg_chat_id', MEETING_CHAT_ID)
      .gte('tg_message_date', from.toISOString())
      .lte('tg_message_date', to.toISOString())
      .order('tg_message_date', { ascending: true })
      .limit(QUEUE_MAX_ROWS);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const transcripts = (data ?? []) as unknown as TranscriptRow[];
    if (transcripts.length === 0) {
      return countOnly
        ? NextResponse.json({ count: 0, truncated: false })
        : NextResponse.json({ rows: [], truncated: false });
    }

    // Исключить записи, уже присутствующие в meeting_deal_links С ЛЮБЫМ
    // method — включая not_a_meeting: это и есть механизм, которым отметка
    // «не встреча» убирает запись из очереди навсегда.
    const ids = transcripts.map((t) => t.id);
    const linkedIds = new Set<string>();
    for (const chunk of chunkArray(ids, IN_CHUNK_SIZE)) {
      const { data: linkedChunk, error: linkedError } = await db
        .from('meeting_deal_links')
        .select('transcript_id')
        .in('transcript_id', chunk);
      if (linkedError) return NextResponse.json({ error: linkedError.message }, { status: 500 });
      for (const l of (linkedChunk ?? []) as Array<{ transcript_id: string }>) {
        linkedIds.add(l.transcript_id);
      }
    }

    // `truncated` относится к ЗАПРОСУ к tg_video_transcripts — см. комментарий
    // у полной ветки ниже, смысл флага в обоих режимах один и тот же.
    if (countOnly) {
      return NextResponse.json({
        count: transcripts.filter((t) => !linkedIds.has(t.id)).length,
        truncated: transcripts.length === QUEUE_MAX_ROWS,
      });
    }

    const rows = transcripts
      .filter((t) => !linkedIds.has(t.id))
      .map((t) => {
        const text = t.text ?? '';
        const preview = text.slice(0, TRANSCRIPT_PREVIEW_LEN);
        return {
          id: t.id,
          meeting_at: t.tg_message_date,
          caption: t.caption,
          filename: t.filename,
          transcript_preview: preview + (text.length > TRANSCRIPT_PREVIEW_LEN ? '…' : ''),
        };
      });

    // truncated относится к ЗАПРОСУ к tg_video_transcripts (мог ли за окно
    // быть ещё материал сверх QUEUE_MAX_ROWS), а не к итоговой длине очереди
    // после фильтра уже привязанных — иначе полностью разобранное большое
    // окно (rows.length===0) молча выглядело бы "не обрезано".
    return NextResponse.json({ rows, truncated: transcripts.length === QUEUE_MAX_ROWS });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'meeting_links_queue_failed' },
      { status: 500 },
    );
  }
}

async function handleDealSearch(db: SupabaseClient, qRaw: string) {
  const q = qRaw.trim();
  if (q.length < SEARCH_MIN_CHARS) {
    return NextResponse.json({ rows: [], truncated: false });
  }

  // PostgREST .or() разделяет условия запятой и группирует скобками — те же
  // символы в пользовательском вводе ломают разбор фильтра. Тот же риск уже
  // принят в invoices/clients и li-outreach/leads (`.ilike.%${search}%` без
  // экранирования); здесь режем запятые и скобки явно, а не молча повторяем
  // ту же дыру в новом месте.
  const safe = q.replace(/[,()]/g, ' ').trim();
  if (safe.length < SEARCH_MIN_CHARS) return NextResponse.json({ rows: [], truncated: false });
  const like = `%${safe}%`;

  // Ищем по ИСХОДНОЙ воронке: у сделки, перенесённой в другую воронку,
  // `pipeline_id` уже чужой, и в поиске она бы не находилась — привязать к ней
  // запись встречи стало бы невозможно (см. 20260807_0003).
  const { data, error } = await db
    .from('amo_leads_with_origin_v')
    .select('amo_id, name, company_name, company_website, created_at, status_name')
    .eq('origin_pipeline_id', PIPELINE_ID)
    .or(`company_name.ilike.${like},company_website.ilike.${like},name.ilike.${like}`)
    .order('created_at', { ascending: false })
    .limit(SEARCH_MAX_ROWS);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (data ?? []) as DealSearchRow[];
  // Похожих сделок с одинаковым/похожим названием часто несколько — отдаём
  // компанию, сайт, дату создания и текущий статус, чтобы человек мог выбрать
  // верную, не открывая AMO.
  return NextResponse.json({ rows, truncated: rows.length === SEARCH_MAX_ROWS });
}

export async function PUT(req: NextRequest) {
  const gate = await requireFirstSalesAccess(req);
  if ('error' in gate) return gate.error;
  const db = gate.supabaseAdmin;

  const body = (await req.json().catch(() => null)) as
    | { transcript_id?: unknown; amo_deal_id?: unknown; not_a_meeting?: unknown }
    | null;

  const transcriptId = typeof body?.transcript_id === 'string' ? body.transcript_id : null;
  if (!transcriptId) return NextResponse.json({ error: 'Нужен transcript_id' }, { status: 400 });

  const notAMeeting = body?.not_a_meeting === true;
  const dealIdRaw = body?.amo_deal_id;
  const dealId =
    typeof dealIdRaw === 'number'
      ? dealIdRaw
      : typeof dealIdRaw === 'string' && dealIdRaw.trim() !== ''
        ? Number(dealIdRaw)
        : null;

  if (!notAMeeting && (dealId === null || !Number.isFinite(dealId))) {
    return NextResponse.json(
      { error: 'Нужен amo_deal_id (число) либо not_a_meeting: true' },
      { status: 400 },
    );
  }

  // Запись должна существовать — amo_deal_id на meeting_deal_links не имеет
  // FK (обычный bigint, см. миграцию 20260731_0001), но transcript_id имеет
  // FK на tg_video_transcripts, так что мусорный transcript_id база отклонит
  // сама; здесь же проверяем заранее, чтобы вернуть внятную 404, а не сырую
  // ошибку constraint-нарушения.
  const { data: transcript, error: transcriptError } = await db
    .from('tg_video_transcripts')
    .select('id')
    .eq('id', transcriptId)
    .maybeSingle();
  if (transcriptError) return NextResponse.json({ error: transcriptError.message }, { status: 500 });
  if (!transcript) return NextResponse.json({ error: 'Запись не найдена' }, { status: 404 });

  let insertRow: {
    transcript_id: string;
    amo_deal_id: number | null;
    method: 'manual' | 'not_a_meeting';
    matched_by: string;
  };

  if (notAMeeting) {
    insertRow = {
      transcript_id: transcriptId,
      amo_deal_id: null,
      method: 'not_a_meeting',
      matched_by: gate.user.id,
    };
  } else {
    // Сделка обязана быть из воронки первички — иначе привязка потащит в
    // метрику встречу чужой воронки. fetchMeetingLinks() ниже по цепочке уже
    // сужает по воронке, но лучше не заводить в таблице мусор у источника, чем
    // полагаться на фильтр в другом файле.
    //
    // Проверяем ИСХОДНУЮ воронку, а не текущую: перенесённая сделка родом из
    // первички, и запрещать привязку к ней нет причин — её встречи по-прежнему
    // считаются в первичке (см. 20260807_0002).
    const { data: deal, error: dealError } = await db
      .from('amo_leads_with_origin_v')
      .select('amo_id')
      .eq('amo_id', dealId as number)
      .eq('origin_pipeline_id', PIPELINE_ID)
      .maybeSingle();
    if (dealError) return NextResponse.json({ error: dealError.message }, { status: 500 });
    if (!deal) {
      return NextResponse.json({ error: 'Сделка не найдена в воронке первички' }, { status: 400 });
    }
    insertRow = {
      transcript_id: transcriptId,
      amo_deal_id: dealId as number,
      method: 'manual',
      matched_by: gate.user.id,
    };
  }

  // INSERT, а не upsert. В штатном сценарии transcript_id ещё ни разу не
  // встречается в meeting_deal_links — GET-очередь показывает только то, чего
  // там нет. Совпадение возможно единственным способом: двое одновременно
  // открыли одну и ту же запись из очереди и оба сохраняют. Тогда второй
  // запрос должен явно упасть на уникальном индексе uq_meeting_deal_links_tid
  // (SQLSTATE 23505) — а не молча затереть выбор первого чужим значением.
  const { error: insertError } = await db.from('meeting_deal_links').insert(insertRow);
  if (insertError) {
    if (insertError.code === '23505') {
      return NextResponse.json(
        {
          error:
            'Эту запись уже разметил кто-то другой, пока вы работали с ней. Обновите очередь.',
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

/**
 * Ручной пересчёт привязок — та же функция, что зовёт ночной синк
 * (services/portal-external-sync/sources/meeting_links.py), только по
 * запросу. Ждать до ночи ради проверки свежей привязки не нужно; функция
 * тяжеловата (полное пересканирование всех записей чата встреч), поэтому
 * кнопка на клиенте (MeetingLinksEditor.tsx) на время выполнения
 * блокируется — двойной клик не нужен.
 */
export async function POST(req: NextRequest) {
  const gate = await requireFirstSalesAccess(req);
  if ('error' in gate) return gate.error;
  const db = gate.supabaseAdmin;

  const { data, error } = await db.rpc('apply_meeting_deal_links');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, linked: (data as number | null) ?? 0 });
}
