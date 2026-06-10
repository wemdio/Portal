import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/liOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

/**
 * Возвращает leads с приплюснутым per-campaign state из li2_deals.
 *
 * До 2026-06-10 li2_leads хранила и lead-уровневые данные (URN, профиль), и
 * per-campaign состояние (state machine, qualification_*). После рефакторинга
 * под OpenOutreach (см. migration 20260610_0001) per-(campaign × lead) state
 * уехал в li2_deals, а li2_leads осталась чисто lead-объектом. Чтобы фронту
 * не пришлось менять модель, мы JOIN'им и сплющиваем результат.
 *
 * Когда фильтр по campaign_id задан — мы матчим deal именно к этой кампании
 * (lead может участвовать в нескольких). Без фильтра — берём deal с
 * максимальным updated_at (свежее всего активное).
 */
export async function GET(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach-v2.leads.get' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;

    const url = new URL(req.url);
    const campaignId = url.searchParams.get('campaign_id');
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 100)));

    // Left join: leads без deals тоже отдаём (например, только-что discovered,
    // ещё не quoted).
    let query = auth.supabase
      .from('li2_leads')
      .select(`
        id, campaign_id, profile_url, public_identifier, name, first_name, last_name,
        position, company, urn, disqualified, meta, last_activity_at, updated_at,
        li2_deals!left (
          state, outcome, qualification_score, qualification_reason, updated_at
        )
      `)
      .eq('user_id', auth.user.id)
      .order('updated_at', { ascending: false })
      .limit(limit);
    if (campaignId) query = query.eq('campaign_id', campaignId);

    const { data, error } = await query;
    if (error) return jsonError(error.message, 500);

    // Сплющиваем li2_deals[] (может быть несколько deal'ов на один lead) →
    // одно "active" поле. Берём самое свежее по updated_at; для campaign-
    // фильтрованного запроса фильтруем по campaign_id deal'а (если он есть).
    type DealRow = {
      state: string | null;
      outcome: string | null;
      qualification_score: number | null;
      qualification_reason: string | null;
      updated_at: string | null;
    };
    type Row = Record<string, unknown> & {
      campaign_id: string | null;
      li2_deals: DealRow[] | DealRow | null;
    };
    const flat = ((data ?? []) as Row[]).map((row) => {
      const deals = Array.isArray(row.li2_deals) ? row.li2_deals : (row.li2_deals ? [row.li2_deals] : []);
      const sorted = deals.slice().sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));
      const deal = sorted[0];
      return {
        ...row,
        state: deal?.state ?? 'discovered',
        outcome: deal?.outcome ?? null,
        qualification_score: deal?.qualification_score ?? null,
        qualification_reason: deal?.qualification_reason ?? null,
        li2_deals: undefined,
      };
    });
    return NextResponse.json({ leads: flat });
  });
}
