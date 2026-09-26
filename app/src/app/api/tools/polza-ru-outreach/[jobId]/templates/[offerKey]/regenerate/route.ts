import { NextResponse, type NextRequest } from 'next/server';
import { logAudit, logError } from '@/lib/loggerServer';
import { outreachApiKey } from '@/lib/outreachLlm/client';
import { BudgetExceededError, LlmAuthError } from '@/lib/outreachLlm/context';
import { fmtUsd } from '@/lib/outreachLlm/format';
import { workerLeaseLive } from '@/lib/outreachLlm/workerLease';
import { loadLibraries, type Libraries } from '@/lib/polzaRuOutreach/libraries';
import { regenerateOfferChain } from '@/lib/polzaRuOutreach/regenerate';
import { authed, jsonError } from '@/lib/polzaRuOutreach/routeAuth';
import {
  CHAIN_LABELS,
  CHAIN_TYPES,
  RU_OUTREACH_PARSER_TYPE,
  sanitizeRuOutreachConfig,
  type ChainType,
  type RuOutreachConfig,
} from '@/lib/polzaRuOutreach/types';

export const dynamic = 'force-dynamic';
// Писатель — до 100 с на вызов, с повтором около 200 с, и пересборка писем:
// ниже таймаута прокси (300 с, deploy/nginx). Сама работа укладывается в
// ROUTE_BUDGET_MS — с запасом до maxDuration.
export const maxDuration = 280;
const ROUTE_BUDGET_MS = 270_000;
const RUNNING_TEXT = 'Запуск ещё идёт — переписать цепочку можно после его окончания';
const STOPPING_TEXT = 'Запуск ещё останавливается — попробуйте через минуту';

/**
 * «Переписать цепочку» оффера: новая попытка писателя для шаблона, не
 * прошедшего проверку, и пересборка писем компаний, которые его ждали
 * (lib/polzaRuOutreach/regenerate.ts). Деньги — из лимита на ИИ запуска.
 *
 * Только для законченного запуска: пока он идёт, воркер сам ведёт лимит
 * готовых и расход на ИИ в памяти — пересборка сбоку набрала бы готовых
 * сверх лимита, а её расход перетёрла бы следующая публикация прогресса.
 * Остановленный запуск воркер ещё доводит (аренда progress_detail.worker) —
 * его итоговая запись стёрла бы расход пересборки, поэтому ждём и её. И одна
 * пересборка на запуск за раз (отметка в progress_detail). Писателю не платим,
 * если ждущих строк нет, лимит готовых уже набран или попытка писателя не
 * помещается в лимит на ИИ.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ jobId: string; offerKey: string }> }) {
  const startedAt = Date.now();
  const auth = await authed(req);
  if ('error' in auth) return auth.error;
  const { jobId, offerKey } = await ctx.params;
  if (!(CHAIN_TYPES as readonly string[]).includes(offerKey)) return jsonError('Неизвестный оффер', 400);
  const chain = offerKey as ChainType;
  if (!outreachApiKey('ru')) {
    return jsonError('Не задан ключ ИИ для русского автоаутрича (POLZA_RU_OUTREACH_API_KEY в .env сервера)', 400);
  }

  const { data: job, error: jobErr } = await auth.supabase
    .from('parser_jobs')
    .select('id,status,config,progress_detail,completed_at')
    .eq('id', jobId)
    .eq('parser_type', RU_OUTREACH_PARSER_TYPE)
    .maybeSingle();
  if (jobErr) {
    await logError('polza_ru_outreach.template.regenerate.failed', jobErr, { jobId, offer: chain }, { userId: auth.user.id });
    return jsonError(jobErr.message, 500);
  }
  if (!job) return jsonError('Запуск не найден', 404);
  // Быстрые отказы до загрузки библиотек; окончательно то же проверяется при
  // постановке отметки пересборки (regenerate.ts).
  if (job.status === 'pending' || job.status === 'running') return jsonError(RUNNING_TEXT, 409);
  if (workerLeaseLive(job.progress_detail, job.completed_at)) return jsonError(STOPPING_TEXT, 409);

  const config = sanitizeRuOutreachConfig((job.config ?? {}) as Partial<RuOutreachConfig>);

  let libraries: Libraries;
  try {
    libraries = await loadLibraries(auth.supabase, config.sender_id);
  } catch (err) {
    await logError('polza_ru_outreach.template.regenerate.failed', err, { jobId, offer: chain }, { userId: auth.user.id });
    return jsonError(err instanceof Error ? err.message : 'Не удалось загрузить библиотеки', 500);
  }
  const sender = libraries.sender;
  if (!sender) return jsonError('Нет активной подписи отправителя — добавьте её во вкладке «Библиотеки»', 400);

  try {
    // Лимит на ИИ и уже потраченное regenerate берёт из снимка запуска,
    // прочитанного под отметкой пересборки: «Переписать» тратит из того же лимита.
    const result = await regenerateOfferChain({
      db: auth.supabase, jobId, chain, target: config.limit, libraries, sender, deadlineAt: startedAt + ROUTE_BUDGET_MS,
    });
    if (result.kind === 'missing') return jsonError(`В запуске нет цепочки оффера «${CHAIN_LABELS[chain]}»`, 404);
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
        result.reason === 'writing' && result.offer
          ? `Сейчас пишется цепочка оффера «${CHAIN_LABELS[result.offer]}» — обновите экран через минуту`
          : 'Цепочки этого запуска уже переписывают — обновите экран через минуту',
        409,
      );
    }
    if (result.kind === 'nothing') return jsonError('Компаний, которые ждут эту цепочку, нет — переписывать незачем', 409);
    if (result.kind === 'limit') {
      return jsonError(`Лимит готовых компаний запуска уже набран (${result.ready} из ${config.limit}) — пересобранные письма не стали бы готовыми`, 409);
    }
    await logAudit(
      'polza_ru_outreach.template.regenerated',
      'Наш автоаутрич: цепочка оффера переписана',
      { jobId, offer: chain, ...result.summary },
      { userId: auth.user.id },
    );
    return NextResponse.json(result.summary);
  } catch (err) {
    // Ключ отвергнут, кончились деньги или модель неизвестна — это не сбой
    // портала, а настройка ИИ: текст ошибки уже понятный.
    if (err instanceof LlmAuthError) return jsonError(err.message, 502);
    if (err instanceof BudgetExceededError) return jsonError(err.message, 409);
    await logError('polza_ru_outreach.template.regenerate.failed', err, { jobId, offer: chain }, { userId: auth.user.id });
    return jsonError(err instanceof Error ? err.message : 'Не удалось переписать цепочку', 500);
  }
}
