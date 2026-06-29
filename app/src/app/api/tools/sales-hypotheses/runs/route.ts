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
import { expandQueryToBrief } from '@/lib/salesHypotheses/expandQuery';
import { SALES_HYPOTHESES_MODEL } from '@/lib/salesHypotheses/model';
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

      const rawInput = typeof body?.website === 'string' ? body.website.trim() : '';
      if (!rawInput) return jsonError('Укажите сайт компании или запрос', 400);

      // Вход может быть сайтом (домен/URL) ИЛИ свободным запросом сейлза
      // («кому продавать франшизу кофеен?»). Сайт распознаём через
      // normalizeWebsiteUrl — он возвращает null для текста со словами/пробелами.
      const isWebsite = Boolean(normalizeWebsiteUrl(rawInput));

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), AUTOFILL_TIMEOUT_MS);
      try {
        let briefText: string;
        let resolvedUrl: string | null = null;
        let briefFields: typeof EMPTY_BRIEF_FIELDS | null = null;
        let questions: string[] = [];
        let filledFields: string[] = [];

        if (isWebsite) {
          const result = await generateBriefAutofill({
            apiKey: OPENROUTER_BRIEF_API_KEY,
            website: rawInput,
            model: SALES_HYPOTHESES_MODEL,
            signal: controller.signal,
          });
          const mergedFields = mergePatchEmptyOnly(EMPTY_BRIEF_FIELDS, result.patch);
          briefText = compileBriefText(mergedFields).trim();
          if (!briefText) {
            return jsonError(
              'Не удалось извлечь данные с сайта — бриф получился пустым. Проверьте URL или попробуйте другой сайт.',
              422,
            );
          }
          resolvedUrl = result.resolvedUrl ?? null;
          briefFields = mergedFields;
          questions = result.questions ?? [];
          filledFields = Object.keys(result.patch);
        } else {
          // Свободный запрос: разворачиваем в мини-бриф (аналог autofill, но из
          // текста). Если развёртка не удалась — откатываемся на сырой запрос:
          // генератор гипотез устойчив к коротким брифам.
          try {
            briefText = await expandQueryToBrief({
              apiKey: OPENROUTER_BRIEF_API_KEY,
              query: rawInput,
              model: SALES_HYPOTHESES_MODEL,
              signal: controller.signal,
            });
          } catch (expandErr) {
            // Таймаут (AbortError) пробрасываем наружу → отдадим 504, как
            // website-путь. Откат на сырой запрос — только для НАСТОЯЩИХ ошибок
            // модели (4xx/5xx/пустой ответ), а не для подвисшего вызова, иначе
            // зависший AI маскируется под успех с сырым запросом вместо брифа.
            if (expandErr instanceof Error && expandErr.name === 'AbortError') throw expandErr;
            await logError('tools.sales-hypotheses.query.expand_failed', expandErr, { userId });
            briefText = rawInput;
          }
        }

        const { data: inserted, error } = await supabase
          .from('sales_hypotheses_runs')
          .insert({
            user_id: userId,
            status: 'autofilled',
            website: rawInput.slice(0, 2000),
            resolved_url: resolvedUrl,
            brief_fields: briefFields,
            brief_text: briefText,
            autofill_questions: questions,
          })
          .select(RUN_DETAIL_COLUMNS)
          .single();

        if (error || !inserted) {
          await logError('tools.sales-hypotheses.autofill.persist_failed', error, { userId });
          return jsonError(error?.message ?? 'Не удалось сохранить прогон', 500);
        }

        void logAudit('tools.sales-hypotheses.autofill.success', 'Sales hypotheses brief prepared', {
          userId,
          kind: isWebsite ? 'website' : 'query',
          resolvedUrl,
          filledFields,
          questionsCount: questions.length,
        });

        return NextResponse.json({ run: serializeRun(inserted) });
      } catch (err) {
        if (err instanceof WebsiteFetchError) {
          await logError('tools.sales-hypotheses.autofill.fetch_failed', err, { userId, website: rawInput });
          // 403/недоступность часто = анти-бот защита сайта (mod_dp и т.п.):
          // зафетчить его с сервера нельзя ни с каким User-Agent. Подсказываем
          // сейлзу query-режим — он не заходит на сайт.
          return jsonError(
            `Не удалось зайти на сайт: ${err.message} Возможно, сайт защищён от ботов или недоступен с сервера. ` +
              'Вставьте вместо ссылки короткое описание компании или запрос — AI соберёт гипотезы без захода на сайт.',
            502,
          );
        }
        if (err instanceof AutofillTruncatedError) {
          await logError('tools.sales-hypotheses.autofill.truncated', err, { userId, website: rawInput });
          return jsonError(err.message, 502);
        }
        if (err instanceof Error && err.name === 'AbortError') {
          return jsonError(
            isWebsite
              ? 'Превышен таймаут анализа сайта. Попробуйте ещё раз.'
              : 'Превышен таймаут обработки запроса. Попробуйте ещё раз.',
            504,
          );
        }
        await logError('tools.sales-hypotheses.autofill.failed', err, {
          userId,
          // На query-пути rawInput — свободный текст (возможны имена клиентов):
          // в лог пишем урезанно, как и success-аудит не пишет сырой запрос.
          website: isWebsite ? rawInput : rawInput.slice(0, 80),
        });
        const message = err instanceof Error
          ? (isWebsite ? `Не удалось проанализировать сайт: ${err.message}` : `Не удалось обработать запрос: ${err.message}`)
          : 'AI не ответил';
        return jsonError(message, 502);
      } finally {
        clearTimeout(timeoutId);
      }
    },
  );
}
