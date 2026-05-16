/**
 * POST /api/parsers/yandex-direct — создаёт job (worker подберёт)
 * GET  /api/parsers/yandex-direct — список своих job'ов
 *
 * Защиты:
 *   - один активный job на user (partial UNIQUE index → INSERT 23505 → 409)
 *   - валидация режима ключей, регионов, лимитов
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { resolveRegions } from '@/lib/parsers/yandexDirect/regions';

export const dynamic = 'force-dynamic';

function err(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

interface CreateRequest {
  niche?: unknown;
  keyword_mode?: unknown;
  keywords?: unknown;
  audience?: unknown;
  n_seeds?: unknown;
  expand_suggest?: unknown;
  include_organic?: unknown;
  regions?: unknown;
}

export async function POST(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return err('Unauthorized', 401);
  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return err('Unauthorized', 401);

  let body: CreateRequest;
  try {
    body = (await req.json()) as CreateRequest;
  } catch {
    return err('Invalid JSON', 400);
  }

  const niche = typeof body.niche === 'string' ? body.niche.trim().slice(0, 200) : '';
  const keywordMode = body.keyword_mode === 'ai' ? 'ai' : 'manual';

  const keywords = Array.isArray(body.keywords)
    ? body.keywords
        .filter((k): k is string => typeof k === 'string' && k.trim().length > 0)
        .map((k) => k.trim())
        .slice(0, 500)
    : [];
  const audience = typeof body.audience === 'string' ? body.audience.trim().slice(0, 2000) : '';

  // Валидация режима
  if (keywordMode === 'manual' && keywords.length === 0) {
    return err('Укажите хотя бы одно ключевое слово', 400);
  }
  if (keywordMode === 'ai' && !audience) {
    return err('Для AI-режима нужно описание аудитории', 400);
  }

  const nSeeds = typeof body.n_seeds === 'number' ? Math.max(1, Math.min(60, Math.floor(body.n_seeds))) : 20;
  const expandSuggest = body.expand_suggest !== false;
  const includeOrganic = body.include_organic === true;

  // Регионы — массив алиасов/пресетов. Проверяем что распознаётся хоть один.
  const regionsInput = Array.isArray(body.regions)
    ? body.regions.filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
    : ['msk'];
  if (resolveRegions(regionsInput).length === 0) {
    return err('Не распознан ни один регион', 400);
  }

  const { data: job, error } = await supabase
    .from('yandex_direct_jobs')
    .insert({
      user_id: user.id,
      niche,
      keyword_mode: keywordMode,
      keywords,
      audience,
      n_seeds: nSeeds,
      expand_suggest: expandSuggest,
      include_organic: includeOrganic,
      regions: regionsInput,
    })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {
      return err('У вас уже есть активная задача — дождитесь её завершения', 409);
    }
    return err(error.message, 500);
  }
  return NextResponse.json({ job }, { status: 201 });
}

export async function GET(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return err('Unauthorized', 401);
  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return err('Unauthorized', 401);

  const { data, error } = await supabase
    .from('yandex_direct_jobs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return err(error.message, 500);
  return NextResponse.json({ jobs: data ?? [] });
}
