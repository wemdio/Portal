/**
 * Демо-роутер: сопоставляет путь клиентского GET-роута с фикстурой.
 *
 * Клиентские GET-роуты вызывают `serveClientDemo(req)` сразу после
 * requireClientAuth, если auth.isDemo === true. Реальная БД / Instantly
 * при этом не трогаются — отдаётся статическая выдумка из ./fixtures.
 *
 * Мутации (POST/PUT/PATCH/DELETE) сюда не доходят: их централизованно
 * режет requireClientAuth. Исключение — reports и companies-search:
 * это POST, но по сути read-only, их requireClientAuth пропускает, и
 * роутер ниже отдаёт по ним фикстуру.
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import {
  DEMO_CAMPAIGNS_RESPONSE,
  DEMO_ONBOARDING_RESPONSE,
  DEMO_BRIEF_RESPONSE,
  DEMO_BASES_RESPONSE,
  DEMO_PROJECTS_RESPONSE,
  DEMO_PRESET_RESPONSE,
  DEMO_TARIFF_RESPONSE,
  DEMO_LAUNCHES_RESPONSE,
  DEMO_SUPPORT_RESPONSE,
  DEMO_COMPANIES_SEARCH_RESPONSE,
  DEMO_ACTIVITY_TYPES_RESPONSE,
  DEMO_LEAD_COMMENTS,
  getDemoLeadsResponse,
  getDemoRepliesResponse,
  getDemoReplies,
  getDemoThread,
  getDemoCampaignDetail,
  getDemoProjectDetail,
  getDemoReportResponse,
} from './fixtures';

function json(body: unknown): NextResponse {
  return NextResponse.json(body);
}

async function readJsonBody<T>(req: NextRequest): Promise<T | null> {
  try {
    return (await req.clone().json()) as T;
  } catch {
    return null;
  }
}

export async function serveClientDemo(req: NextRequest): Promise<NextResponse> {
  const pathname = req.nextUrl?.pathname ?? new URL(req.url).pathname;
  const path =
    pathname.replace(/^\/api\/client/, '').replace(/\/+$/, '') || '/';
  const seg = path.split('/').filter(Boolean);

  switch (path) {
    case '/campaigns':
      return json(DEMO_CAMPAIGNS_RESPONSE);
    case '/onboarding/status':
      return json(DEMO_ONBOARDING_RESPONSE);
    case '/brief':
      return json(DEMO_BRIEF_RESPONSE);
    case '/bases':
      return json(DEMO_BASES_RESPONSE);
    case '/projects':
      return json(DEMO_PROJECTS_RESPONSE);
    case '/preset':
      return json(DEMO_PRESET_RESPONSE);
    case '/tariff':
      return json(DEMO_TARIFF_RESPONSE);
    case '/launches':
      return json(DEMO_LAUNCHES_RESPONSE);
    case '/reports': {
      const body = await readJsonBody<{ campaignIds?: unknown }>(req);
      const campaignIds = Array.isArray(body?.campaignIds)
        ? body.campaignIds.filter((id): id is string => typeof id === 'string')
        : [];
      return json(getDemoReportResponse(campaignIds));
    }
    case '/support/thread':
      return json(DEMO_SUPPORT_RESPONSE);
    case '/companies-search':
      return json(DEMO_COMPANIES_SEARCH_RESPONSE);
    case '/companies-search/activity-types':
      return json(DEMO_ACTIVITY_TYPES_RESPONSE);
    case '/leads': {
      const rawLimit = Number(req.nextUrl.searchParams.get('limit') ?? '50');
      const rawOffset = Number(req.nextUrl.searchParams.get('offset') ?? '0');
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 50;
      const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
      return json(getDemoLeadsResponse(limit, offset));
    }
    case '/replies': {
      const rawLimit = Number(req.nextUrl.searchParams.get('limit') ?? '50');
      const rawOffset = Number(req.nextUrl.searchParams.get('offset') ?? '0');
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 50;
      const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
      // Mirror real /replies API: whitelist status, pass search through.
      const rawStatus = req.nextUrl.searchParams.get('status');
      const status: 'all' | 'unread' | 'leads' =
        rawStatus === 'unread' || rawStatus === 'leads' ? rawStatus : 'all';
      const search = req.nextUrl.searchParams.get('search')?.trim() || undefined;
      return json(getDemoRepliesResponse(limit, offset, status, search));
    }
    default:
      break;
  }

  // ── Динамические сегменты ──────────────────────────────────────────────
  // /campaigns/<id>/replies/<emailId>/thread → тред (outbound + inbound)
  // /campaigns/<id>/replies                  → ответы получателей по кампании
  // /campaigns/<id>                          → деталь кампании
  if (
    seg[0] === 'campaigns'
    && seg[1]
    && seg[2] === 'replies'
    && seg[3]
    && seg[4] === 'thread'
  ) {
    return json(getDemoThread(seg[1], seg[3]));
  }
  if (seg[0] === 'campaigns' && seg[1]) {
    if (seg[2] === 'replies') return json(getDemoReplies(seg[1]));
    return json(getDemoCampaignDetail(seg[1]));
  }
  // /projects/<id>             → деталь проекта
  if (seg[0] === 'projects' && seg[1]) {
    return json(getDemoProjectDetail(seg[1]));
  }
  // /leads/<id>/comments       → комментарии к лиду
  if (seg[0] === 'leads' && seg[1] && seg[2] === 'comments') {
    return json(DEMO_LEAD_COMMENTS[seg[1]] ?? { items: [] });
  }

  // Неизвестный клиентский GET — пустой безопасный ответ, не ошибка.
  return json({});
}
