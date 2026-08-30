import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { requireFirstSalesAccess } from '@/lib/firstSales/access';
import { readDealCardFields } from '@/lib/firstSales/dealCard';

/**
 * Одна сделка для модалки: карточка, путь по этапам, комментарии и задачи.
 *
 * Отдельной ручкой, а не полем в списке: комментарии и задачи есть у каждой
 * сделки, и подтягивать их сразу для нескольких тысяч строк — заведомо лишний
 * мегабайт ради данных, которые почти никто не откроет. Дёргается в момент
 * открытия модалки.
 */
export const dynamic = 'force-dynamic';

const AMO_BASE = (process.env.AMO_BASE_URL ?? '').replace(/\/$/, '');

/** Комментариев в карточке бывают сотни; в модалке нужны последние. */
const MAX_NOTES = 20;

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ amoId: string }> },
) {
  const gate = await requireFirstSalesAccess(req);
  if ('error' in gate) return gate.error;

  const { amoId: amoIdRaw } = await ctx.params;
  const amoId = Number(amoIdRaw);
  // `Number.isSafeInteger`, а не просто `isFinite`: id сделки уходит в
  // запрос к БД, и «1e999» или дробное значение здесь — ошибка вызова.
  if (!Number.isSafeInteger(amoId) || amoId <= 0) {
    return NextResponse.json({ error: 'Некорректный номер сделки' }, { status: 400 });
  }

  const db = gate.supabaseAdmin;

  try {
    const [leadRes, stageRes, notesRes, tasksRes] = await Promise.all([
      db
        .from('amo_leads')
        .select('amo_id, name, company_name, company_website, responsible_name, status_name, pipeline_name, amount, contact_email, contact_phone, contact_tg_username, raw')
        .eq('amo_id', amoId)
        .maybeSingle(),
      db
        .from('amo_lead_stage_dates_v')
        .select('created_at, first_qualified_at, first_meeting_at, first_contract_at, won_at, history_complete')
        .eq('amo_deal_id', amoId)
        .maybeSingle(),
      db
        .from('amo_notes')
        .select('amo_note_id, text, created_at_amo, created_by')
        .eq('amo_deal_id', amoId)
        .order('created_at_amo', { ascending: false })
        .limit(MAX_NOTES),
      db
        .from('amo_tasks')
        .select('amo_task_id, text, result_text, is_completed, complete_till, created_at_amo')
        .eq('amo_deal_id', amoId)
        .order('complete_till', { ascending: false }),
    ]);

    if (leadRes.error) throw leadRes.error;
    if (stageRes.error) throw stageRes.error;
    if (notesRes.error) throw notesRes.error;
    if (tasksRes.error) throw tasksRes.error;

    const lead = leadRes.data as {
      amo_id: number; name: string | null; company_name: string | null;
      company_website: string | null; responsible_name: string | null;
      status_name: string | null; pipeline_name: string | null; amount: number | null;
      contact_email: string | null; contact_phone: string | null;
      contact_tg_username: string | null; raw: unknown;
    } | null;

    if (!lead) return NextResponse.json({ error: 'Сделка не найдена' }, { status: 404 });

    const stages = (stageRes.data ?? null) as {
      created_at: string | null; first_qualified_at: string | null;
      first_meeting_at: string | null; first_contract_at: string | null;
      won_at: string | null; history_complete: boolean;
    } | null;

    return NextResponse.json({
      amo_id: lead.amo_id,
      name: lead.name,
      company_name: lead.company_name,
      company_website: lead.company_website,
      responsible_name: lead.responsible_name,
      status_name: lead.status_name,
      pipeline_name: lead.pipeline_name,
      amount: lead.amount,
      contact: {
        email: lead.contact_email,
        phone: lead.contact_phone,
        telegram: lead.contact_tg_username,
      },
      // Путь по воронке. `history_complete = false` означает, что сделка
      // старше глубины синка событий: прочерк у этапа тогда значит «мы не
      // видим», а не «этапа не было», и модалка обязана это сказать.
      stages: stages ?? null,
      fields: readDealCardFields(lead.raw),
      notes: notesRes.data ?? [],
      tasks: tasksRes.data ?? [],
      amo_url: AMO_BASE ? `${AMO_BASE}/leads/detail/${lead.amo_id}` : null,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'first_sales_deal_failed' },
      { status: 500 },
    );
  }
}
