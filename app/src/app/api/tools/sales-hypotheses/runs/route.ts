import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { logAudit, logError } from '@/lib/loggerServer';
import {
  generateBriefAutofill,
  WebsiteFetchError,
  AutofillTruncatedError,
} from '@/lib/clientBrief/autofill';
import { normalizeWebsiteUrl } from '@/lib/clientBrief/autofill/fetchWebsiteHtml';
import { compileBriefText, EMPTY_BRIEF_FIELDS } from '@/lib/clientBrief';
import { mergePatchEmptyOnly } from '@/lib/clientBrief/autofill/mergePatchEmptyOnly';
import { RUN_DETAIL_COLUMNS, RUN_LIST_COLUMNS, serializeRun } from '@/lib/salesHypotheses/run';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 90;

const OPENROUTER_BRIEF_API_KEY = process.env.OPENROUTER_BRIEF_API_KEY ?? '';
const AUTOFILL_TIMEOUT_MS = Number(process.env.SALES_HYPOTHESES_AUTOFILL_TIMEOUT_MS ?? '75000');

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

// GET — история прогонов текущего сейлза (без тел брифа/гипотез).
export async function GET(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.sales-hypotheses.runs.get' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      const { supabase } = authed.auth;

      const { data, error } = await supabase
        .from('sales_hypotheses_runs')
        .select(RUN_LIST_COLUMNS)
        .order('created_at', { ascending: false })
        .limit(50);

      if (error) return jsonError(error.message, 500);
      return NextResponse.json({ runs: (data ?? []).map(serializeRun) });
    },
  );
}

// POST — новый прогон: автозаполнение брифа по сайту + сохранение строки.
// Гипотезы генерируются отдельным запросом (runs/[id]/generate) — так каждый
// запрос укладывается в свой таймаут и фронт показывает поэтапный прогресс.
export async function POST(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.sales-hypotheses.runs.post' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      const { supabase, userId } = authed.auth;

      if (!OPENROUTER_BRIEF_API_KEY) {
        return jsonError('OPENROUTER_BRIEF_API_KEY не настроен на сервере', 500);
      }

      let body: { website?: unknown };
      try {
        body = (await req.json()) as { website?: unknown };
      } catch {
        return jsonError('Invalid body', 400);
      }

      const rawWebsite = typeof body?.website === 'string' ? body.website.trim() : '';
      if (!rawWebsite) return jsonError('Укажите URL сайта', 400);
      if (!normalizeWebsiteUrl(rawWebsite)) {
        return jsonError('Невалидный URL сайта. Используйте домен (acme.com) или https://...', 400);
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), AUTOFILL_TIMEOUT_MS);
      try {
        const result = await generateBriefAutofill({
          apiKey: OPENROUTER_BRIEF_API_KEY,
          website: rawWebsite,
          signal: controller.signal,
        });

        const mergedFields = mergePatchEmptyOnly(EMPTY_BRIEF_FIELDS, result.patch);
        const briefText = compileBriefText(mergedFields).trim();
        if (!briefText) {
          return jsonError(
            'Не удалось извлечь данные с сайта — бриф получился пустым. Проверьте URL или попробуйте другой сайт.',
            422,
          );
        }

        const { data: inserted, error } = await supabase
          .from('sales_hypotheses_runs')
          .insert({
            user_id: userId,
            status: 'autofilled',
            website: rawWebsite.slice(0, 2000),
            resolved_url: result.resolvedUrl ?? null,
            brief_fields: mergedFields,
            brief_text: briefText,
            autofill_questions: result.questions ?? [],
          })
          .select(RUN_DETAIL_COLUMNS)
          .single();

        if (error || !inserted) {
          await logError('tools.sales-hypotheses.autofill.persist_failed', error, { userId: userId });
          return jsonError(error?.message ?? 'Не удалось сохранить прогон', 500);
        }

        void logAudit('tools.sales-hypotheses.autofill.success', 'Sales hypotheses brief autofilled', {
          userId: userId,
          website: result.resolvedUrl,
          filledFields: Object.keys(result.patch),
          questionsCount: result.questions.length,
        });

        return NextResponse.json({ run: serializeRun(inserted) });
      } catch (err) {
        if (err instanceof WebsiteFetchError) {
          await logError('tools.sales-hypotheses.autofill.fetch_failed', err, { userId: userId, website: rawWebsite });
          return jsonError(err.message, 502);
        }
        if (err instanceof AutofillTruncatedError) {
          await logError('tools.sales-hypotheses.autofill.truncated', err, { userId: userId, website: rawWebsite });
          return jsonError(err.message, 502);
        }
        if (err instanceof Error && err.name === 'AbortError') {
          return jsonError('Превышен таймаут анализа сайта. Попробуйте ещё раз.', 504);
        }
        await logError('tools.sales-hypotheses.autofill.failed', err, { userId: userId, website: rawWebsite });
        const message = err instanceof Error ? `Не удалось проанализировать сайт: ${err.message}` : 'AI не ответил';
        return jsonError(message, 502);
      } finally {
        clearTimeout(timeoutId);
      }
    },
  );
}
