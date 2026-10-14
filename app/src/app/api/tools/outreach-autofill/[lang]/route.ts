import { NextResponse, type NextRequest } from 'next/server';
import { jsonError, requireAdmin } from '@/lib/adminAuth';
import { logAudit, logError } from '@/lib/loggerServer';
import { outreachApiKey } from '@/lib/outreachLlm/client';
import { currentAutofillState } from '@/lib/outreachAutofill/check';
import {
  isAutofillLang,
  loadAutofill,
  sanitizeAutofillConfig,
  updateAutofill,
  type AutofillLang,
  type AutofillRow,
} from '@/lib/outreachAutofill/settings';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

/**
 * Настройки автодобора языка (вкладка «Автодобор» автоаутрича, только админ):
 * GET — настройки, живое состояние базы и последний автосбор; PUT
 * { enabled?, config? } — выключатель и настройки сбора. Включивший становится
 * автором автосборов (docs/superpowers/specs/2026-10-06-outreach-autofill-design.md).
 */

/** Ответ GET/PUT; тот же вид — в components/outreach/AutofillTab.tsx. */
interface AutofillResponse {
  enabled: boolean;
  config: AutofillRow['config'];
  ownerId: string | null;
  apiKeyReady: boolean;
  state: AutofillRow['last_state'];
  lastJob: { id: string; status: string; createdAt: string; handled: boolean; target: number | null } | null;
  lastCheckAt: string | null;
}

async function respond(lang: AutofillLang): Promise<NextResponse> {
  const row = await loadAutofill(lang);
  if (!row) return jsonError('Нет строки автодобора — примените миграцию 20261006_0030', 500);

  let lastJob: AutofillResponse['lastJob'] = null;
  if (row.last_job_id && supabaseAdmin) {
    const { data } = await supabaseAdmin
      .from('parser_jobs')
      .select('id, status, created_at')
      .eq('id', row.last_job_id)
      .maybeSingle();
    if (data) {
      lastJob = {
        id: String(data.id),
        status: String(data.status),
        createdAt: String(data.created_at),
        handled: row.last_job_handled,
        target: row.last_job_target,
      };
    }
  }

  const body: AutofillResponse = {
    enabled: row.enabled,
    config: row.config,
    ownerId: row.owner_id,
    apiKeyReady: Boolean(outreachApiKey(lang)),
    // Живой расчёт, а не снимок проверки: добавили ящик — экран видит сразу.
    state: (await currentAutofillState(lang)) ?? row.last_state,
    lastJob,
    lastCheckAt: row.last_check_at,
  };
  return NextResponse.json(body);
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ lang: string }> }) {
  const auth = await requireAdmin(req);
  if ('error' in auth) return auth.error;
  const { lang } = await params;
  if (!isAutofillLang(lang)) return jsonError('Неизвестный язык', 404);
  try {
    return await respond(lang);
  } catch (e) {
    await logError('outreach_autofill.get.failed', e, { lang }, { userId: auth.user.id });
    return jsonError(e instanceof Error ? e.message : 'Не удалось прочитать автодобор', 500);
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ lang: string }> }) {
  const auth = await requireAdmin(req);
  if ('error' in auth) return auth.error;
  const { lang } = await params;
  if (!isAutofillLang(lang)) return jsonError('Неизвестный язык', 404);

  const body = (await req.json().catch(() => null)) as { enabled?: unknown; config?: unknown } | null;
  if (!body || typeof body !== 'object') return jsonError('Невалидный JSON', 400);

  const patch: Partial<Omit<AutofillRow, 'lang'>> = {};
  if (typeof body.enabled === 'boolean') {
    patch.enabled = body.enabled;
    if (body.enabled) patch.owner_id = auth.user.id;
  }
  if (body.config !== undefined) patch.config = sanitizeAutofillConfig(lang, body.config);
  if (!Object.keys(patch).length) return jsonError('Нечего сохранять', 400);

  try {
    await updateAutofill(lang, patch);
    await logAudit('outreach_autofill.updated', `Автодобор ${lang}: настройки сохранены`, { lang, ...patch }, { userId: auth.user.id });
    return await respond(lang);
  } catch (e) {
    await logError('outreach_autofill.put.failed', e, { lang }, { userId: auth.user.id });
    return jsonError(e instanceof Error ? e.message : 'Не удалось сохранить автодобор', 500);
  }
}
