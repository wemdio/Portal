import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { isTargetLocale } from '@/lib/i18n';
import { translateBatch } from '@/lib/portalTranslate';

/**
 * POST /api/portal/translate
 *
 * Batch translation endpoint backing GlobalTextTranslator. Authenticated; any
 * portal user can call it. The route does NOT translate per-user content —
 * it only translates UI strings that the client observed in the DOM, so the
 * cache is org-wide (see RLS in migration 20260520_0003_portal_translations).
 *
 * Body:
 *   {
 *     "target_lang": "en" | "de" | "fr" | "es" | "it",
 *     "strings": string[]   // <= 256 entries, each <= 1000 chars
 *   }
 *
 * Response:
 *   { translations: { [source]: translated }, stats: {...} }
 *
 * Failure modes the client must tolerate:
 *   - 401: token missing/expired → fall back to source language in UI.
 *   - 400: bad target_lang or oversized body → don't retry.
 *   - 500: server error / LLM unreachable → caller should keep the source
 *     visible (the translator already falls back to identity on missing keys).
 */

export const dynamic = 'force-dynamic';

const MAX_STRINGS = 256;
const MAX_STRING_LENGTH = 1000;

interface TranslateRequestBody {
  target_lang?: string;
  strings?: unknown;
}

export async function POST(req: NextRequest) {
  try {
    const token = getBearerToken(req.headers.get('authorization'));
    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    let supabase;
    try {
      supabase = createAuthedSupabaseClient(token);
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Supabase not configured' },
        { status: 500 },
      );
    }
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let body: TranslateRequestBody;
    try {
      body = (await req.json()) as TranslateRequestBody;
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const target = body.target_lang;
    if (!isTargetLocale(target)) {
      return NextResponse.json(
        { error: 'target_lang must be one of: en, de, fr, es, it' },
        { status: 400 },
      );
    }

    if (!Array.isArray(body.strings)) {
      return NextResponse.json({ error: 'strings must be an array' }, { status: 400 });
    }
    if (body.strings.length === 0) {
      return NextResponse.json({ translations: {}, stats: { requested: 0, cached: 0, machine: 0, skipped: 0 } });
    }
    if (body.strings.length > MAX_STRINGS) {
      return NextResponse.json(
        { error: `Too many strings (max ${MAX_STRINGS})` },
        { status: 400 },
      );
    }

    const inputs: string[] = [];
    for (const raw of body.strings) {
      if (typeof raw !== 'string') continue;
      if (raw.length > MAX_STRING_LENGTH) continue;
      inputs.push(raw);
    }

    const result = await translateBatch({
      strings: inputs,
      targetLang: target,
    });
    return NextResponse.json(result);
  } catch (err) {
    console.error('[/api/portal/translate] failed:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 },
    );
  }
}
