import { NextResponse, type NextRequest } from 'next/server';
import { logAudit, logError } from '@/lib/loggerServer';
import { outreachApiKey } from '@/lib/outreachLlm/client';
import { BudgetExceededError, LlmAuthError } from '@/lib/outreachLlm/context';
import { fmtUsd } from '@/lib/outreachLlm/format';
import { workerLeaseLive } from '@/lib/outreachLlm/workerLease';
import { loadEnCases, type EnCase } from '@/lib/polzaOutreach/caseRouter';
import { regenerateOfferChain } from '@/lib/polzaOutreach/regenerate';
import { authed, jsonError } from '@/lib/polzaOutreach/routeAuth';
import { loadSignature } from '@/lib/polzaOutreach/settings';
import {
  isPolzaOfferKey,
  POLZA_OFFER_LABELS,
  sanitizePolzaOutreachConfig,
  type PolzaOutreachConfig,
} from '@/lib/polzaOutreach/types';

export const dynamic = 'force-dynamic';
// Писатель — до 100 с на вызов и до 200 с на обе попытки вместе
// (templateWriter.ts, ROUTE_WRITER_TOTAL_MS), плюс пересборка писем
// застрявших строк без ИИ — секунды. nginx обрывает запрос на 300 с.
export const maxDuration = 280;
const RUNNING_TEXT = 'Запуск ещё идёт — переписать цепочку можно после его окончания';
const STOPPING_TEXT = 'Запуск ещё останавливается — попробуйте через минуту';

/**
 * «Переписать цепочку» оффера английского аутрича: новая попытка писателя
 * для шаблона, не прошедшего проверку, и пересборка писем компаний, которые
 * его ждали (lib/polzaOutreach/regenerate.ts). Деньги — из лимита на ИИ
 * запуска.
 *
 * Только для законченного запуска: пока он идёт, воркер сам ведёт лимит
 * готовых и расход на ИИ в памяти — пересборка сбоку набрала бы готовых
 * сверх лимита, а её расход перетёрла бы следующая публикация прогресса.
 * Остановленный запуск воркер ещё доводит (аренда progress_detail.worker) —
 * его итоговая запись стёрла бы расход пересборки, поэтому ждём и её.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ jobId: string; offerKey: string }> }) {
  const auth = await authed(req);
  if ('error' in auth) return auth.error;
  const { jobId, offerKey } = await ctx.params;
  if (!isPolzaOfferKey(offerKey)) return jsonError('Неизвестный оффер', 400);
  const offer = offerKey;
  if (!outreachApiKey('en')) {
    return jsonError('Не задан ключ ИИ для английского автоаутрича (POLZA_EN_OUTREACH_API_KEY в .env сервера)', 400);
  }

  const { data: job, error: jobErr } = await auth.supabase
    .from('parser_jobs')
    .select('id,status,config,progress_detail,completed_at')
    .eq('id', jobId)
    .eq('parser_type', 'polza_outreach')
    .maybeSingle();
  if (jobErr) {
    await logError('parser.polza_outreach.template.regenerate.failed', jobErr, { jobId, offer }, { userId: auth.user.id });
    return jsonError(jobErr.message, 500);
  }
  if (!job) return jsonError('Запуск не найден', 404);
  // Быстрые отказы до загрузки подписи и кейсов; окончательно то же
  // проверяется под маркером пересборки (regenerate.ts).
  if (job.status === 'pending' || job.status === 'running') return jsonError(RUNNING_TEXT, 409);
  if (workerLeaseLive(job.progress_detail, job.completed_at)) return jsonError(STOPPING_TEXT, 409);

  const config = sanitizePolzaOutreachConfig((job.config ?? {}) as Partial<PolzaOutreachConfig>);

  let signature: string;
  let cases: EnCase[];
  try {
    [signature, cases] = await Promise.all([loadSignature(auth.supabase), loadEnCases(auth.supabase)]);
  } catch (err) {
    await logError('parser.polza_outreach.template.regenerate.failed', err, { jobId, offer }, { userId: auth.user.id });
    return jsonError(err instanceof Error ? err.message : 'Не удалось загрузить подпись и кейсы', 500);
  }

  try {
    // Лимит на ИИ и уже потраченное regenerate берёт из снимка запуска,
    // прочитанного под маркером пересборки: «Переписать» тратит из того же лимита.
    const result = await regenerateOfferChain({ db: auth.supabase, jobId, offer, target: config.limit, signature, cases });
    if (result.kind === 'missing') return jsonError(`В запуске нет цепочки оффера «${POLZA_OFFER_LABELS[offer]}»`, 404);
    if (result.kind === 'active') return jsonError(result.state === 'stopping' ? STOPPING_TEXT : RUNNING_TEXT, 409);
    if (result.kind === 'budget') {
      return jsonError(
        result.needUsd === undefined
          ? `Лимит на ИИ этого запуска исчерпан: потрачено ${fmtUsd(result.spentUsd)} из ${fmtUsd(result.limitUsd)}`
          : `Лимита на ИИ этого запуска не хватит на цепочку: потрачено ${fmtUsd(result.spentUsd)} из ${fmtUsd(result.limitUsd)}, а попытка писателя может стоить до ${fmtUsd(result.needUsd)}`,
        409,
      );
    }
    if (result.kind === 'busy') {
      return jsonError(
        result.reason === 'rebuild'
          ? 'Письма этого запуска уже пересобираются — обновите экран через пару минут'
          : 'Цепочку этого запуска сейчас пишет ИИ — обновите экран через пару минут',
        409,
      );
    }
    if (result.kind === 'nothing_waiting') {
      return jsonError(`Цепочку оффера «${POLZA_OFFER_LABELS[offer]}» не ждёт ни одна компания — переписывать незачем`, 409);
    }
    if (result.kind === 'limit_full') {
      return jsonError(`Лимит готовых компаний запуска уже набран (${result.ready} из ${result.target}) — переписывать цепочку незачем`, 409);
    }
    await logAudit(
      'parser.polza_outreach.template.regenerated',
      'Polza outreach: offer chain regenerated',
      { jobId, offer, ...result.summary },
      { userId: auth.user.id },
    );
    return NextResponse.json(result.summary);
  } catch (err) {
    // Ключ отвергнут, кончились деньги или модель неизвестна — это не сбой
    // портала, а настройка ИИ: текст ошибки уже понятный.
    if (err instanceof LlmAuthError) return jsonError(err.message, 502);
    if (err instanceof BudgetExceededError) return jsonError(err.message, 409);
    await logError('parser.polza_outreach.template.regenerate.failed', err, { jobId, offer }, { userId: auth.user.id });
    return jsonError(err instanceof Error ? err.message : 'Не удалось переписать цепочку', 500);
  }
}
