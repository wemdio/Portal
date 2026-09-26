import 'server-only';

import { NextResponse, type NextRequest } from 'next/server';
import { logAudit, logError } from '@/lib/loggerServer';
import { authenticateRequest, jsonError } from '@/lib/sender/apiHelpers';
import { SenderOpError } from '@/lib/sender/campaignOps';
import { withToolTrace } from '@/lib/toolTrace';
import { getJobSenderStatus, startJobCampaign, uploadJobToSender, type OutreachLang } from './upload';

/**
 * Роуты «Рассылка» у запуска автоаутрича — одинаковые у русского
 * (/api/tools/polza-ru-outreach/[jobId]/sender/**) и английского
 * (/api/parsers/polza-outreach/[jobId]/sender/**): отличается только язык,
 * поэтому обработка живёт здесь, а файлы роутов лишь передают язык и jobId.
 *
 * Права — как у самой «Рассылки» (lib/sender/apiHelpers): внутренние
 * сотрудники, не демо. Остальные роуты аутрича пускают любого вошедшего к
 * своим запускам, но заливка создаёт рассылки и шлёт письма с наших ящиков —
 * это права сендера. Строки читаются сервисным ключом: залить и запустить
 * рассылку может любой сотрудник, а не только автор запуска.
 */

const TRACE: Record<OutreachLang, string> = {
  ru: 'tools.polza_ru_outreach.sender',
  en: 'parsers.polza_outreach.sender',
};
// Префиксы событий журнала — как у соседних роутов своего аутрича.
const LOG: Record<OutreachLang, string> = {
  ru: 'polza_ru_outreach.sender',
  en: 'parser.polza_outreach.sender',
};
const TOOL: Record<OutreachLang, string> = {
  ru: 'Наш автоаутрич',
  en: 'Английский автоаутрич',
};

type Handler = (userId: string) => Promise<NextResponse>;

async function run(req: NextRequest, lang: OutreachLang, jobId: string, op: string, handler: Handler) {
  return withToolTrace({ request: req, operation: `${TRACE[lang]}.${op}`, context: { jobId } }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    try {
      return await handler(auth.user.id);
    } catch (e) {
      // SenderOpError — ошибка для человека: текст как есть, со своим статусом.
      if (e instanceof SenderOpError) return jsonError(e.message, e.status);
      await logError(`${LOG[lang]}.${op}.failed`, e, { jobId }, { userId: auth.user.id });
      return jsonError(e instanceof Error ? e.message : 'Не удалось выполнить действие', 500);
    }
  });
}

async function readJson(req: NextRequest): Promise<Record<string, unknown> | null> {
  const body = await req.json().catch(() => null);
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

/** GET — что из запуска уже в «Рассылке», что можно долить, готова ли папка. */
export function senderStatusRoute(req: NextRequest, lang: OutreachLang, jobId: string) {
  return run(req, lang, jobId, 'status', async () => NextResponse.json(await getJobSenderStatus({ lang, jobId })));
}

/** POST { mode: 'new' | 'append', campaignId? } — залить готовые компании запуска. */
export function senderUploadRoute(req: NextRequest, lang: OutreachLang, jobId: string) {
  return run(req, lang, jobId, 'upload', async (userId) => {
    const body = await readJson(req);
    if (!body) return jsonError('Невалидный JSON', 400);
    // Режим обязателен: опечатка в экране не должна молча заводить новую рассылку.
    if (body.mode !== 'new' && body.mode !== 'append') return jsonError('Укажите режим: новая рассылка или добавить в существующую', 400);
    const campaignId = typeof body.campaignId === 'string' ? body.campaignId : null;

    const result = await uploadJobToSender({ lang, jobId, mode: body.mode, campaignId, userId });
    await logAudit(`${LOG[lang]}.uploaded`, `${TOOL[lang]}: компании залиты в «Рассылку»`, { jobId, ...result }, { userId });
    return NextResponse.json(result);
  });
}

/** POST { campaignId } — запустить рассылку, созданную этим запуском. */
export function senderStartRoute(req: NextRequest, lang: OutreachLang, jobId: string) {
  return run(req, lang, jobId, 'start', async (userId) => {
    const body = await readJson(req);
    if (!body) return jsonError('Невалидный JSON', 400);
    if (typeof body.campaignId !== 'string' || !body.campaignId) return jsonError('Не указана рассылка', 400);

    const result = await startJobCampaign({ lang, jobId, campaignId: body.campaignId });
    await logAudit(`${LOG[lang]}.started`, `${TOOL[lang]}: рассылка запущена`, { jobId, ...result }, { userId });
    return NextResponse.json({ ok: true, status: 'running', ...result });
  });
}
