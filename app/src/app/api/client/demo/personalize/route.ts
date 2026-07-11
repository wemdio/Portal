import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit, logError } from '@/lib/loggerServer';
import { generateBriefAutofill, WebsiteFetchError } from '@/lib/clientBrief/autofill';
import { normalizeWebsiteUrl } from '@/lib/clientBrief/autofill/fetchWebsiteHtml';
import {
  generateLeadSourceHypotheses,
  sanitizeClientHypothesesMarkdown,
} from '@/lib/projectBriefHypotheses/generateHypotheses';
import { compileBriefText, normalizeBriefFields, type ClientBriefFields } from '@/lib/clientBrief';
import {
  assertPublicWebsite,
  personalizeCacheDomain,
  generateDemoLetters,
  DEMO_PERSONALIZE_MODEL,
  type DemoPersonalizeLetter,
} from '@/lib/clientDemo/personalize';
import { sendDemoPersonalizeTelegramAlert } from '@/lib/demoLead/notify';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// Шаг hypotheses делает ту же работу, что /api/client/brief/hypotheses
// (внутри analyzeBriefIcp с суб-таймаутом 45с + основная генерация) — держим
// тот же бюджет 120с, что и у боевого роута.
export const maxDuration = 120;

/**
 * POST /api/client/demo/personalize — «проверьте на своей компании» в демо.
 *
 * Доступно ТОЛЬКО демо-аккаунту (у реальных клиентов есть настоящие
 * инструменты); путь внесён в DEMO_READONLY_POST_PATHS, потому что в БД
 * клиента ничего не пишет — результат живёт в своей таблице-кэше.
 *
 * Шаги (клиент зовёт последовательно, чтобы уложиться в maxDuration и
 * показывать прогресс):
 *   {website}                — анти-абуз гейты → скрейп сайта → бриф; создаёт run
 *   {runId, step:'hypotheses'} — гипотезы по брифу run'а
 *   {runId, step:'letters'}    — цепочка из 3 писем по брифу run'а
 *
 * Анти-абуз (простой, но с потолком):
 *   1) глобальный дневной кап (count runs за 24ч) — жёсткий потолок LLM-бюджета;
 *   2) кэш по домену 7 дней — повторные прогоны того же сайта бесплатны;
 *   3) 1 прогон на посетителя: httpOnly-кука + in-memory лимит на IP.
 *   Шаги hypotheses/letters гейтов не требуют: они выполняются по одному разу
 *   на существующий run (повторный вызов отдаёт сохранённое).
 */

const OPENROUTER_BRIEF_API_KEY = process.env.OPENROUTER_BRIEF_API_KEY ?? '';
const DAILY_CAP = Math.max(1, Number(process.env.DEMO_PERSONALIZE_DAILY_CAP ?? '200'));
const PER_IP_PER_DAY = Math.max(1, Number(process.env.DEMO_PERSONALIZE_PER_IP ?? '3'));
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const USED_COOKIE = 'oos_demo_pers';

// Best-effort per-instance лимит на IP (паттерн /demo route). Сбрасывается при
// рестарте контейнера — не страшно: жёсткий потолок держит глобальный кап.
const WINDOW_MS = 24 * 60 * 60 * 1000;
const ipHits = new Map<string, number[]>();
function ipLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (ipHits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  ipHits.set(ip, recent);
  return recent.length > PER_IP_PER_DAY;
}

interface RunRow {
  id: string;
  domain: string;
  resolved_url: string | null;
  brief: Record<string, unknown> | null;
  hypotheses_md: string | null;
  letters: DemoPersonalizeLetter[] | null;
}

interface Body {
  website?: unknown;
  runId?: unknown;
  step?: unknown;
}

function runPayload(row: RunRow, cached: boolean) {
  return {
    ok: true,
    runId: row.id,
    resolvedUrl: row.resolved_url,
    brief: row.brief ?? null,
    hypotheses: row.hypotheses_md ?? null,
    letters: row.letters ?? null,
    cached,
  };
}

function briefTextOf(row: RunRow): string {
  const fields = normalizeBriefFields((row.brief ?? null) as Partial<ClientBriefFields> | null);
  return compileBriefText(fields).trim();
}

export async function POST(req: NextRequest) {
  const auth = await requireClientAuth(req);
  if ('error' in auth) return auth.error;
  // Только демо: реальный клиент пользуется настоящими брифом/гипотезами/цепочками.
  if (!auth.auth.isDemo) return jsonError('Доступно только в демо-режиме', 403);
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);
  if (!OPENROUTER_BRIEF_API_KEY) return jsonError('OPENROUTER_BRIEF_API_KEY не настроен', 500);

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return jsonError('Invalid body', 400);
  }

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';

  // ── Шаги 2-3: догенерация по существующему run ─────────────────────────────
  const step = typeof body.step === 'string' ? body.step : '';
  const runId = typeof body.runId === 'string' ? body.runId.trim() : '';
  if (step) {
    if (!runId || !/^[0-9a-f-]{36}$/i.test(runId)) return jsonError('Невалидный runId', 400);
    const { data: row, error } = await supabaseAdmin
      .from('demo_personalize_runs')
      .select('id, domain, resolved_url, brief, hypotheses_md, letters')
      .eq('id', runId)
      .maybeSingle<RunRow>();
    if (error || !row) return jsonError('Прогон не найден', 404);

    try {
      if (step === 'hypotheses') {
        if (!row.hypotheses_md) {
          const briefText = briefTextOf(row);
          if (!briefText) return jsonError('Бриф прогона пуст', 409);
          const md = await generateLeadSourceHypotheses({
            apiKey: OPENROUTER_BRIEF_API_KEY,
            briefText,
            model: DEMO_PERSONALIZE_MODEL,
            audience: 'client',
          });
          row.hypotheses_md = sanitizeClientHypothesesMarkdown(md);
          await supabaseAdmin
            .from('demo_personalize_runs')
            .update({ hypotheses_md: row.hypotheses_md })
            .eq('id', row.id);
        }
        return NextResponse.json(runPayload(row, false));
      }
      if (step === 'letters') {
        if (!row.letters || row.letters.length === 0) {
          const briefText = briefTextOf(row);
          if (!briefText) return jsonError('Бриф прогона пуст', 409);
          row.letters = await generateDemoLetters({
            apiKey: OPENROUTER_BRIEF_API_KEY,
            briefText,
          });
          await supabaseAdmin
            .from('demo_personalize_runs')
            .update({ letters: row.letters })
            .eq('id', row.id);
        }
        return NextResponse.json(runPayload(row, false));
      }
      return jsonError('Неизвестный шаг', 400);
    } catch (err) {
      await logError(`demo.personalize.${step}.failed`, err, { runId, domain: row.domain });
      return jsonError(
        err instanceof Error ? err.message : 'Генерация не удалась, попробуйте ещё раз',
        502,
      );
    }
  }

  // ── Шаг 1: новый прогон по сайту ───────────────────────────────────────────
  const rawWebsite = typeof body.website === 'string' ? body.website.trim() : '';
  if (!rawWebsite) return jsonError('Укажите URL сайта', 400);
  const normalized = normalizeWebsiteUrl(rawWebsite);
  if (!normalized) {
    return jsonError('Невалидный URL сайта. Используйте домен (acme.com) или https://…', 400);
  }
  const domain = personalizeCacheDomain(normalized);

  // Кэш по домену: бесплатно и мгновенно, гейты не трогаем.
  const since = new Date(Date.now() - CACHE_TTL_MS).toISOString();
  const { data: cachedRow } = await supabaseAdmin
    .from('demo_personalize_runs')
    .select('id, domain, resolved_url, brief, hypotheses_md, letters')
    .eq('domain', domain)
    .gte('created_at', since)
    .not('brief', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<RunRow>();
  if (cachedRow) return NextResponse.json(runPayload(cachedRow, true));

  // Гейт 3а: 1 прогон на посетителя (кука) → дальше регистрация.
  if (req.cookies.get(USED_COOKIE)?.value) {
    return NextResponse.json(
      {
        error: 'Бесплатный разбор уже использован — зарегистрируйтесь, чтобы продолжить',
        code: 'DEMO_PERSONALIZE_LIMIT',
      },
      { status: 429 },
    );
  }
  // Гейт 3б: IP.
  if (ipLimited(ip)) {
    return NextResponse.json(
      {
        error: 'Слишком много запросов — зарегистрируйтесь, чтобы продолжить',
        code: 'DEMO_PERSONALIZE_LIMIT',
      },
      { status: 429 },
    );
  }
  // Гейт 1: глобальный дневной кап — жёсткий потолок расходов.
  const { count } = await supabaseAdmin
    .from('demo_personalize_runs')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', new Date(Date.now() - WINDOW_MS).toISOString());
  if ((count ?? 0) >= DAILY_CAP) {
    return NextResponse.json(
      {
        error: 'Дневной лимит демо-разборов исчерпан — загляните завтра или зарегистрируйтесь',
        code: 'DEMO_PERSONALIZE_EXHAUSTED',
      },
      { status: 429 },
    );
  }

  try {
    await assertPublicWebsite(normalized);
    const result = await generateBriefAutofill({
      apiKey: OPENROUTER_BRIEF_API_KEY,
      website: rawWebsite,
    });

    const { data: inserted, error: insErr } = await supabaseAdmin
      .from('demo_personalize_runs')
      .insert({
        domain,
        resolved_url: result.resolvedUrl,
        ip,
        brief: result.patch,
        model: DEMO_PERSONALIZE_MODEL,
      })
      .select('id, domain, resolved_url, brief, hypotheses_md, letters')
      .single<RunRow>();
    if (insErr || !inserted) {
      await logError('demo.personalize.insert_failed', insErr, { domain });
      return jsonError('Не удалось сохранить прогон', 500);
    }

    void logAudit('demo.personalize.started', 'Demo visitor personalized by website', {
      domain,
      ip,
      runId: inserted.id,
    });
    // Каждый вставленный сайт — тёплый лид: сигналим в TG (best-effort).
    void sendDemoPersonalizeTelegramAlert({
      domain,
      resolvedUrl: result.resolvedUrl,
      ip,
    });

    const res = NextResponse.json(runPayload(inserted, false));
    res.cookies.set({
      name: USED_COOKIE,
      value: '1',
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      maxAge: 30 * 24 * 60 * 60,
      path: '/',
    });
    return res;
  } catch (err) {
    if (err instanceof WebsiteFetchError) {
      return jsonError(err.message, 502);
    }
    await logError('demo.personalize.brief.failed', err, { domain });
    return jsonError(
      err instanceof Error ? `Не удалось разобрать сайт: ${err.message}` : 'Не удалось разобрать сайт',
      502,
    );
  }
}
