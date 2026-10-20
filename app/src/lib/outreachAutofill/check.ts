import 'server-only';

import { outreachApiKey } from '@/lib/outreachLlm/client';
import { workerLeaseLive } from '@/lib/outreachLlm/workerLease';
import { startJobCampaign, uploadJobToSender } from '@/lib/outreachSender/upload';
import { SenderOpError } from '@/lib/sender/campaignOps';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { notifyAutofill } from './notify';
import { baseUntil, latestCheckSlot, mskDay, nextCheckIsToday, planAutofill, shortDate } from './plan';
import {
  AUTOFILL_FOLDER_KEY,
  AUTOFILL_LANGS,
  AUTOFILL_PARSER_TYPE,
  buildAutofillJobConfig,
  loadAutofill,
  updateAutofill,
  type AutofillLang,
  type AutofillState,
} from './settings';

/**
 * Автодобор базы автоаутричей RU/EN
 * (docs/superpowers/specs/2026-10-06-outreach-autofill-design.md, §3).
 *
 * Тик воркера автоаутрича раз в минуту:
 *   • разбор законченного автосбора — на каждом тике: залить готовые компании
 *     в новую рассылку папки, запустить её и сообщить итог в чат техники;
 *   • проверка базы — в 09:00 и 21:00 МСК: базы меньше чем на 3 рабочих дня →
 *     автосбор на неделю. Каждая проверка смотрит на базу заново: утренний
 *     сбор, не закрывший потребность, вечерний не отменяет (11.10.2026).
 *     Больше двух сборов в сутки не выйдет — проверок всего две.
 */

type Log = (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void;

const ACTIVE_JOB_STATUSES = ['pending', 'running'];
/** Отказ заливки «готовых нет» — это сбор 0, а не сбой. */
const NOTHING_READY_PREFIX = 'В запуске пока нет готовых';

const STOP_REASON_TEXT: Record<string, string> = {
  budget: 'кончился бюджет на ИИ',
  pool_exhausted: 'кончились подходящие компании',
  scan_limit: 'просмотрен потолок кандидатов',
  awaiting_templates: 'часть компаний ждёт цепочку писем',
};

function db() {
  if (!supabaseAdmin) throw new Error('Сервис не настроен: нет сервисного ключа базы');
  return supabaseAdmin;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

interface FolderState {
  perDay: number;
  remaining: number;
  weekdays: number[];
  timezone: string;
}

async function loadFolderState(lang: AutofillLang): Promise<FolderState | null> {
  const { data, error } = await db().rpc('outreach_autofill_folder_state', { p_folder_key: AUTOFILL_FOLDER_KEY[lang] });
  if (error) throw new Error(`состояние папки не прочитано: ${error.message}`);
  if (!data) return null;
  const raw = data as { per_day?: unknown; remaining?: unknown; send_weekdays?: unknown; timezone?: unknown };
  return {
    perDay: Number(raw.per_day ?? 0),
    remaining: Number(raw.remaining ?? 0),
    weekdays: Array.isArray(raw.send_weekdays) ? raw.send_weekdays.map(Number) : [1, 2, 3, 4, 5],
    timezone: typeof raw.timezone === 'string' && raw.timezone ? raw.timezone : 'Europe/Moscow',
  };
}

function stateOf(folder: FolderState, now: Date): AutofillState {
  const plan = planAutofill(folder);
  return {
    perDay: folder.perDay,
    remaining: folder.remaining,
    daysLeft: plan.daysLeft,
    baseUntil: baseUntil(now, plan.daysLeft, folder.weekdays, folder.timezone),
    checkedAt: now.toISOString(),
  };
}

// ── Разбор законченного автосбора ──────────────────────────────────────────

async function handleFinishedJob(lang: AutofillLang, now: Date, log: Log): Promise<void> {
  const row = await loadAutofill(lang);
  if (!row || row.last_job_handled || !row.last_job_id) return;

  const { data: job, error } = await db()
    .from('parser_jobs')
    .select('id, status, progress_detail, completed_at, error_message')
    .eq('id', row.last_job_id)
    .maybeSingle();
  if (error) throw new Error(`автосбор не прочитан: ${error.message}`);
  if (!job) {
    await updateAutofill(lang, { last_job_handled: true });
    await notifyAutofill(lang, 'запуск автосбора удалён — итог не разобран, следующая проверка доберёт заново', { tag: true });
    return;
  }
  const status = String(job.status);
  if (ACTIVE_JOB_STATUSES.includes(status)) return;
  // Остановленный запуск воркер ещё доводит — заливка сейчас его отвергнет.
  if (workerLeaseLive(job.progress_detail, (job.completed_at as string | null) ?? null)) return;

  const target = row.last_job_target ?? 0;
  const detail = (job.progress_detail ?? {}) as { stop_reason?: unknown };
  const stopReason = typeof detail.stop_reason === 'string' ? STOP_REASON_TEXT[detail.stop_reason] ?? null : null;

  let companies = 0;
  let problem: string | null = null;
  try {
    const uploaded = await uploadJobToSender({ lang, jobId: String(job.id), mode: 'new', userId: row.owner_id });
    companies = uploaded.companies;
    try {
      await startJobCampaign({ lang, jobId: String(job.id), campaignId: uploaded.campaignId });
    } catch (e) {
      problem = `${companies} компаний залито в «${uploaded.campaignName}», но рассылка не запустилась: ${errorText(e)}`;
    }
  } catch (e) {
    // Сбой базы или сети — не итог: следующий тик попробует снова.
    if (!(e instanceof SenderOpError) || e.status >= 500) throw e;
    if (!e.message.startsWith(NOTHING_READY_PREFIX)) problem = `не залито в «Рассылку»: ${e.message}`;
  }

  const folder = await loadFolderState(lang);
  const state = folder ? stateOf(folder, now) : row.last_state;
  const until = shortDate(state?.baseUntil ?? null);

  // Авария сбора или заливки не доказывает, что источники иссякли.
  const short = status === 'completed' && !problem && target > 0 && companies < target / 2;
  const streak = short ? row.short_streak + 1 : 0;

  if (status === 'failed') {
    const reason = String(job.error_message ?? '').trim() || 'причина не записана';
    const deliveryProblem = problem ? ` ${problem}.` : '';
    await notifyAutofill(
      lang,
      `автосбор остановился с ошибкой: ${reason}. Нужно ${target}, собрано ${companies}. База до ${until}.${deliveryProblem}`,
      { tag: true },
    );
  } else if (problem) {
    await notifyAutofill(lang, problem, { tag: true });
  } else if (companies >= target) {
    await notifyAutofill(lang, `добрано ${companies} компаний, база до ${until}`, { tag: false });
  } else {
    const why = stopReason ? ` (${stopReason})` : '';
    // Сообщаем время проверки, не обещаем успешный добор после остановки.
    const when = nextCheckIsToday(now) ? 'следующая проверка базы — вечером' : 'следующая проверка базы — завтра утром';
    await notifyAutofill(lang, `нужно ${target}, собрано ${companies}${why}, база до ${until}, ${when}`, { tag: true });
  }
  if (streak >= 2) {
    await notifyAutofill(
      lang,
      `${streak}-й автосбор подряд набирает меньше половины — похоже, источники иссякли, поменяйте настройки сбора`,
      { tag: true },
    );
  }

  await updateAutofill(lang, { last_job_handled: true, short_streak: streak, last_state: state ?? null });
  log('info', `Автодобор ${lang}: автосбор ${job.id} разобран — залито ${companies} из ${target}`);
}

// ── Проверка базы в 09:00 и 21:00 МСК ──────────────────────────────────────

async function hasActiveRuSender(): Promise<boolean> {
  const { count, error } = await db()
    .from('polza_ru_senders')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'active');
  if (error) throw new Error(`подписи не прочитаны: ${error.message}`);
  return Boolean(count);
}

async function checkBase(lang: AutofillLang, now: Date, log: Log): Promise<void> {
  const row = await loadAutofill(lang);
  if (!row) return;
  if (row.last_check_at && Date.parse(row.last_check_at) >= latestCheckSlot(now).getTime()) return;
  // Отметка — до проверки: упавшая проверка не повторяется каждую минуту до
  // следующего часа проверки и не засыпает чат одинаковыми сообщениями.
  await updateAutofill(lang, { last_check_at: now.toISOString() });
  if (!row.enabled || !row.last_job_handled) return;

  const folder = await loadFolderState(lang);
  if (!folder) {
    await notifyAutofill(lang, `в «Рассылке» нет папки ${AUTOFILL_FOLDER_KEY[lang]} — добор не запущен`, { tag: true });
    return;
  }
  const plan = planAutofill(folder);
  const state = stateOf(folder, now);
  await updateAutofill(lang, { last_state: state });

  if (folder.perDay === 0) {
    await notifyAutofill(lang, 'в папке нет рабочих ящиков (или у них 0 новых в день) — добор не запущен', { tag: true });
    return;
  }
  if (!plan.needed) return;
  /**
   * Утренний сбор второй проверке не помеха.
   *
   * Раньше здесь стояло «сегодня сбор уже был — ждём завтра», и вечерняя
   * проверка пропускала добор, даже когда базы по-прежнему не хватало:
   * 11.10.2026 утренний сбор дал 60 компаний из 800, а в 21:00 автодобор
   * просто промолчал. Условие запуска — состояние базы (`plan.needed`), а не
   * факт утреннего сбора.
   *
   * Ограничение теперь по ОКНУ проверки, а не по дню: в одном окне (09:00 или
   * 21:00) сбор запускается один раз. Так два сбора в сутки — потолок, и
   * внеплановая проверка (её просит смена ящиков в папке, см.
   * requestAutofillRecheck) не начинает второй сбор в том же окне.
   */
  if (row.last_job_id) {
    const { data: lastJob, error: lastJobErr } = await db()
      .from('parser_jobs')
      .select('created_at')
      .eq('id', row.last_job_id)
      .maybeSingle();
    if (lastJobErr) throw new Error(`прошлый автосбор не прочитан: ${lastJobErr.message}`);
    const startedAt = lastJob?.created_at ? Date.parse(String(lastJob.created_at)) : 0;
    if (startedAt >= latestCheckSlot(now).getTime()) {
      log('info', `Автодобор ${lang}: базы мало, но сбор в этом окне проверки уже был — ждём следующего`);
      return;
    }
  }
  if (!row.owner_id) {
    await notifyAutofill(lang, 'не знаю, от чьего имени запускать сбор — выключите и включите автодобор заново', { tag: true });
    return;
  }
  if (!outreachApiKey(lang)) {
    await notifyAutofill(lang, 'не задан ключ ИИ автоаутрича на сервере — добор не запущен', { tag: true });
    return;
  }
  if (lang === 'ru' && !(await hasActiveRuSender())) {
    await notifyAutofill(lang, 'нет активной подписи отправителя («Библиотеки») — добор не запущен', { tag: true });
    return;
  }

  const config = buildAutofillJobConfig(lang, row.config, plan.target);
  const { data: job, error } = await db()
    .from('parser_jobs')
    .insert({
      user_id: row.owner_id,
      parser_type: AUTOFILL_PARSER_TYPE[lang],
      status: 'pending',
      progress_stage: 'pending',
      progress_percent: 0,
      config,
    })
    .select('id')
    .single();
  if (error || !job) throw new Error(`автосбор не создан: ${error?.message ?? 'пустой ответ'}`);

  await updateAutofill(lang, {
    last_job_id: String(job.id),
    last_job_day: mskDay(now),
    last_job_target: plan.target,
    last_job_handled: false,
  });
  log('info', `Автодобор ${lang}: в базе ${folder.remaining} при ${folder.perDay}/день — запущен сбор на ${plan.target} (${job.id})`);
}

/** Тик воркера: разбор автосборов и, в часы проверки, проверка базы. Не бросает. */
export async function runAutofillTick(now: Date, log: Log): Promise<void> {
  for (const lang of AUTOFILL_LANGS) {
    try {
      await handleFinishedJob(lang, now, log);
    } catch (e) {
      log('error', `Автодобор ${lang}: разбор автосбора не удался — повтор на следующем тике`, e);
    }
    try {
      await checkBase(lang, now, log);
    } catch (e) {
      log('error', `Автодобор ${lang}: проверка базы упала`, e);
      await notifyAutofill(lang, `проверка базы упала: ${errorText(e)}`, { tag: true });
    }
  }
}

/** Состояние папки для экрана: скорость, остаток, до какого дня хватит. */
export async function currentAutofillState(lang: AutofillLang, now = new Date()): Promise<AutofillState | null> {
  const folder = await loadFolderState(lang);
  return folder ? stateOf(folder, now) : null;
}
