import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { serveClientDemo } from '@/lib/clientDemo/demoResponse';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { getClientTariffRow, resolveEffectiveLimits } from '@/lib/tariffs';
import { extractBrand } from '@/lib/clientDomains/extractBrand';
import { suggestDomains } from '@/lib/clientDomains/suggestDomains';
import { getRequiredDomainCount } from '@/lib/clientDomains/constants';
import type { SuggestedDomain } from '@/lib/clientDomains/constants';
import { logError } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';

/**
 * GET /api/client/domains/suggestions — current picker state for the
 * onboarding "domains" step. Generates (and persists) the first batch on
 * demand when the client has no row yet.
 *
 * POST /api/client/domains/suggestions — (re)generate offers from a given
 * brand. Used by the manual brand input (brief has no website) and by
 * "Показать ещё варианты" (passes a rotating `offset`).
 *
 * Both return the same shape:
 *   { brand, suggested, selected, required_count, status }
 *
 * No payment gate: picking domains is part of onboarding/setup and must work
 * before the first payment too.
 */

interface SelectionRow {
  brand: string | null;
  suggested: SuggestedDomain[] | null;
  selected: string[] | null;
  required_count: number | null;
  status: string | null;
}

function stateResponse(row: SelectionRow) {
  return NextResponse.json({
    brand: row.brand ?? null,
    suggested: Array.isArray(row.suggested) ? row.suggested : [],
    selected: Array.isArray(row.selected) ? row.selected : [],
    required_count: row.required_count ?? 0,
    status: row.status ?? 'suggested',
  });
}

async function loadRow(userId: string): Promise<SelectionRow | null> {
  const { data } = await supabaseInstantly!
    .from('client_domain_selections')
    .select('brand, suggested, selected, required_count, status')
    .eq('client_user_id', userId)
    .maybeSingle();
  return (data as SelectionRow | null) ?? null;
}

async function resolveRequiredCount(userId: string): Promise<number> {
  const tariff = await getClientTariffRow(userId);
  return getRequiredDomainCount(
    tariff?.tariff_type ?? 'standard',
    resolveEffectiveLimits(tariff),
  );
}

/** Brief website (instantly DB, jsonb) — may be missing or unnormalised. */
async function loadBriefWebsite(userId: string): Promise<string | null> {
  const { data } = await supabaseInstantly!
    .from('client_briefs')
    .select('fields')
    .eq('client_user_id', userId)
    .maybeSingle();
  const fields = data?.fields as { company_website?: unknown } | null;
  return typeof fields?.company_website === 'string' ? fields.company_website : null;
}

/**
 * Generate a fresh batch and persist it. Throws on reg.ru/API failures —
 * callers translate that into a 502 with a retry hint (we never offer
 * unchecked domains).
 *
 * A CONFIRMED selection (status='selected') is never touched: the manager
 * was already notified and may be buying that list right now. The client
 * re-confirms a new set explicitly via PUT /selection, which re-notifies.
 * For unconfirmed rows the kept picks are those still present in the new
 * batch.
 */
async function generateAndStore(
  userId: string,
  brand: string,
  offset: number,
): Promise<SelectionRow> {
  const [requiredCount, existing] = await Promise.all([
    resolveRequiredCount(userId),
    loadRow(userId),
  ]);

  const suggested = await suggestDomains(brand, { requiredCount, offset });

  const isConfirmed = existing?.status === 'selected';
  const offered = new Set(suggested.map((s) => s.domain));
  const selected = isConfirmed
    ? (existing?.selected ?? [])
    : (existing?.selected ?? []).filter((d) => offered.has(d));
  const status = isConfirmed
    ? 'selected'
    : selected.length === requiredCount && requiredCount > 0
      ? 'selected'
      : 'suggested';

  const row: SelectionRow = {
    brand,
    suggested,
    selected,
    required_count: requiredCount,
    status,
  };

  const { error } = await supabaseInstantly!
    .from('client_domain_selections')
    .upsert(
      {
        client_user_id: userId,
        brand,
        suggested,
        selected,
        required_count: requiredCount,
        status,
      },
      { onConflict: 'client_user_id' },
    );

  if (error) throw error;
  return row;
}

export async function GET(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (result.auth.isDemo) return serveClientDemo(req);
  if (!supabaseInstantly) return jsonError('Server misconfigured', 500);

  const { userId } = result.auth;

  try {
    const existing = await loadRow(userId);
    if (existing) return stateResponse(existing);

    // First visit: derive the brand from the brief website and generate.
    // No website (or unusable one) → brand:null, the UI asks for manual input.
    const website = await loadBriefWebsite(userId);
    const extracted = extractBrand(website);
    if (!extracted.ok || !extracted.brand) {
      return NextResponse.json({
        brand: null,
        suggested: [],
        selected: [],
        required_count: await resolveRequiredCount(userId),
        status: 'suggested',
      });
    }

    const row = await generateAndStore(userId, extracted.brand, 0);
    return stateResponse(row);
  } catch (err) {
    await logError('client.domains.suggestions.get.failed', err, { userId });
    return jsonError(
      'Не удалось проверить доступность доменов. Попробуйте ещё раз через минуту.',
      502,
    );
  }
}

interface PostBody {
  brand?: unknown;
  offset?: unknown;
}

export async function POST(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (!supabaseInstantly) return jsonError('Server misconfigured', 500);

  const { userId } = result.auth;

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return jsonError('Некорректный JSON', 400);
  }

  const extracted = extractBrand(typeof body.brand === 'string' ? body.brand : null);
  if (!extracted.ok) return jsonError(extracted.error, 400);
  if (!extracted.brand) {
    return jsonError('Введите домен сайта или название компании латиницей', 400);
  }

  const rawOffset = Number(body.offset);
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;

  try {
    const row = await generateAndStore(userId, extracted.brand, offset);
    return stateResponse(row);
  } catch (err) {
    await logError('client.domains.suggestions.post.failed', err, { userId });
    return jsonError(
      'Не удалось проверить доступность доменов. Попробуйте ещё раз через минуту.',
      502,
    );
  }
}
