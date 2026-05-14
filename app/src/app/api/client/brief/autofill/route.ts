import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { logAudit, logError } from '@/lib/loggerServer';
import {
  generateBriefAutofill,
  WebsiteFetchError,
  AutofillTruncatedError,
} from '@/lib/clientBrief/autofill';
import { normalizeWebsiteUrl } from '@/lib/clientBrief/autofill/fetchWebsiteHtml';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

const OPENROUTER_BRIEF_API_KEY = process.env.OPENROUTER_BRIEF_API_KEY ?? '';

interface AutofillBody {
  website?: unknown;
}

export async function POST(req: NextRequest) {
  const auth = await requireClientAuth(req);
  if ('error' in auth) return auth.error;

  if (!OPENROUTER_BRIEF_API_KEY) {
    return jsonError('OPENROUTER_BRIEF_API_KEY не настроен на сервере', 500);
  }

  let body: AutofillBody;
  try {
    body = (await req.json()) as AutofillBody;
  } catch {
    return jsonError('Invalid body', 400);
  }

  const rawWebsite = typeof body?.website === 'string' ? body.website.trim() : '';
  if (!rawWebsite) {
    return jsonError('Укажите URL сайта', 400);
  }
  const normalized = normalizeWebsiteUrl(rawWebsite);
  if (!normalized) {
    return jsonError('Невалидный URL сайта. Используйте домен (acme.com) или https://...', 400);
  }

  const { userId } = auth.auth;

  try {
    const result = await generateBriefAutofill({
      apiKey: OPENROUTER_BRIEF_API_KEY,
      website: rawWebsite,
    });

    void logAudit('client.brief.autofill.success', 'Client brief autofilled from website', {
      userId,
      website: result.resolvedUrl,
      filledFields: Object.keys(result.patch),
      questionsCount: result.questions.length,
    });

    return NextResponse.json({
      ok: true,
      fieldsPatch: result.patch,
      questions: result.questions,
      sources: result.sources,
      resolvedUrl: result.resolvedUrl,
    });
  } catch (err) {
    if (err instanceof WebsiteFetchError) {
      await logError('client.brief.autofill.fetch_failed', err, { userId, website: rawWebsite });
      return jsonError(err.message, 502);
    }
    if (err instanceof AutofillTruncatedError) {
      // Отдельный audit event — чтобы в логах было видно "AI обрезался" vs
      // "AI совсем не ответил". Если truncation-кейсы участятся, поднимем
      // maxTokens или сократим whitelist. Без отдельного события эту
      // ветку статистики не увидеть.
      await logError('client.brief.autofill.truncated', err, { userId, website: rawWebsite });
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: 502 },
      );
    }
    await logError('client.brief.autofill.ai_failed', err, { userId, website: rawWebsite });
    const message =
      err instanceof Error ? `Не удалось сгенерировать черновик: ${err.message}` : 'AI не ответил';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
