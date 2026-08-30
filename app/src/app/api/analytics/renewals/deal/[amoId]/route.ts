import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { requireRenewalsAccess } from '@/lib/renewals/access';
import { readDealCardFields } from '@/lib/firstSales/dealCard';

/**
 * Одна сделка воронки продлений для модалки: карточка, комментарии и задачи.
 *
 * Близнец ручки первички (api/analytics/first-sales/deal/[amoId]) и отличается
 * от неё ровно двумя вещами, ради которых и заведён отдельный файл:
 *
 *   * ПРОВЕРКА ДОСТУПА своя. Дашборды видят разные люди, и звать чужой гейт
 *     значило бы отдать сделки продлений тому, кому открыта только первичка.
 *   * ПУТИ ПО ЭТАПАМ нет. `amo_lead_stage_dates_v` собран под этапы первички
 *     (квал, встреча, договор) — у вторичной воронки этапы другие, и врать
 *     чужими датами хуже, чем не показывать их вовсе. Даты продления при этом
 *     видны: они лежат полями карточки («Дата оплаты продления», «Дата нового
 *     периода») и приезжают в `fields`.
 */
export const dynamic = 'force-dynamic';

const AMO_BASE = (process.env.AMO_BASE_URL ?? '').replace(/\/$/, '');

/** Комментариев в карточке бывают сотни; в модалке нужны последние. */
const MAX_NOTES = 20;

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ amoId: string }> },
) {
  const gate = await requireRenewalsAccess(req);
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
    const [leadRes, notesRes, tasksRes] = await Promise.all([
      db
        .from('amo_leads')
        .select('amo_id, name, company_name, company_website, responsible_name, status_name, pipeline_name, amount, contact_email, contact_phone, contact_tg_username, raw')
        .eq('amo_id', amoId)
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
      // Пути по этапам у вторичной воронки нет — см. шапку файла. Модалка
      // умеет `null` и просто не рисует блок.
      stages: null,
      fields: readDealCardFields(lead.raw),
      notes: notesRes.data ?? [],
      tasks: tasksRes.data ?? [],
      amo_url: AMO_BASE ? `${AMO_BASE}/leads/detail/${lead.amo_id}` : null,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'renewals_deal_failed' },
      { status: 500 },
    );
  }
}
