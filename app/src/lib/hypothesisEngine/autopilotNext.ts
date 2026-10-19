/**
 * Автопилот ENG-кабинета «Движка вертикалей»: дочейн конвейера
 * «выбрал вертикали → одна кнопка → всё само».
 *
 * Вызывается воркером (worker/hypothesisEngine.ts) ПОСЛЕ done-апдейта джобы и
 * enqueueNextResearchStage, под try/catch воркера: сбой постановки followup
 * не должен ронять уже завершённую джобу.
 *
 * Работает ТОЛЬКО при he_projects.autopilot=true (флаг ставит
 * POST /api/client/eng/projects/[id]/autopilot): ручной RU-режим
 * (autopilot=false) здесь никогда ничего не ставит. Флаг читается дважды: на
 * входе и ещё раз прямо перед каждой платной постановкой
 * (isHeAutopilotStillOn) — отмена клиентом пишет autopilot=false и могла лечь
 * между этими чтениями.
 *
 * Правила:
 *  - клиентский ENG начинает сборку прямо из реконсилера, без chain; прежняя
 *    chain done всё ещё обслуживается для уже поставленных до перехода джоб;
 *  - chain done        → сборка базы вертикали (enqueueHeBaseCollect, лимит
 *                        AUTOPILOT_BASE_LIMIT, accepted-гипотезы вертикали;
 *                        пустой список → null = по всем). Повторный chain при
 *                        уже готовой (analyzed) или ЖИВОЙ анализируемой
 *                        auto-базе НИЧЕГО не ставит: re-chain — про письма, а
 *                        не про новую базу. Осиротевшая 'analyzing'-база (нет
 *                        активной джобы, запись давняя) блокировщиком не
 *                        считается, но и новой сборки НЕ вызывает: ей
 *                        доставляют пропавший base_analyze
 *                        (repairOrphanAnalyzingBase) — собранные и оплаченные
 *                        строки не выбрасываем. Если же анализ этой базы уже
 *                        ЗАПУСКАЛСЯ и упал или был отменён клиентом, дочейн
 *                        его не переоплачивает и сборку тоже не ставит
 *                        (analysis_failed_before / analysis_cancelled) —
 *                        повтор решает человек. Сборка идёт только там, где
 *                        анализировать нечего. Сама
 *                        base_collect в не-refill режиме завершает базу в
 *                        'analyzing' и ставит base_analyze — это звено
 *                        конвейера уже автоматично;
 *  - base_analyze done → генерация 85/15 шаблона (he_jobs stage='template',
 *                        дедуп активных template-джоб этой базы, гонку держит
 *                        he_jobs_one_active_template_per_base), база обязана
 *                        быть 'analyzed', шаблона у неё ещё быть не должно
 *                        (есть — 'skipped:template_ready', как у реконсилера:
 *                        второй анализ базы — не повод платить за письма,
 *                        которые уже есть), и бюджет поколения анализа должен
 *                        быть не исчерпан (heTemplateGenerationBudget);
 *  - всё остальное     → no-op.
 *
 * ЧТО ЕЩЁ ЖИВЁТ В ЭТОМ ФАЙЛЕ (волна 5):
 *  - HeAutopilotReadError: сбой ЧТЕНИЯ состояния отличается от решения классом,
 *    а не текстом, и никогда не переводит проект или базу в терминальный статус;
 *  - причина паузы на строке проекта (recordHeAutopilotPause / toHeAutopilotPause
 *    + HE_AUTOPILOT_PAUSE_REASONS): закрытый список машинных токенов, который
 *    читают ночной реконсилер (autopilotReconcile.ts) и проекция кабинета;
 *  - heTemplateGenerationBudget: тормоз бесконечной платной генерации писем,
 *    привязанный к ПОКОЛЕНИЮ анализа базы;
 *  - latestEndedJobByBase / endedBaseAnalyzeOutcomes: «эту стадию по базе уже
 *    пробовали» — последний упавший или отменённый исход, общий для дочейна и
 *    ночного реконсилера;
 *  - readHeEngOwnerHold (S3b): заблокирован ли владелец us-проекта — для
 *    дочейна, ночного добора и гейта платных шагов.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { HeJob } from './types';
import { enqueueHeBaseCollect } from './baseCollectEnqueue';
import { readHeEngAccountBlock } from './engAccountBlockMarker';
import type { HeEngAccountStanding } from './engAutoLaunch';
import {
  HE_JOB_BRAND_INPUTS_KEY,
  HE_JOB_UNPAID_BRAND_INPUT,
  HE_JOB_UNPAID_REFUSAL_KEY,
  HeLetterBrandInputError,
  heBrandInputsBeforeEnqueue,
  heJobUnpaidBrandInput,
  type HeBrandInputLeak,
} from './letterBrandGuard';
import { normalizeHeMarket } from './market';
import { readHeEngBaseFirst } from './engBaseFirst';

/* ───────────── Владелец заблокирован? (S3b) ───────────── */

/**
 * Можно ли тратить деньги на работу аккаунта — для путей без запроса клиента
 * (дочейн автопилота ниже, ночной добор autoPipeline.ts и его долив
 * stages/baseCollectRefill.ts) и для гейта платных шагов (engPaidAccess.ts).
 * Решение владельца 12.10.2026: «если бан, то всё нужно останавливать».
 *
 * Читает два источника:
 *  - отметку блокировки (he_eng_account_blocks, engAccountBlockMarker): её
 *    пишет кнопка «Заблокировать» карточки ENG-клиента ПЕРВЫМ шагом. Одно
 *    чтение по ключу;
 *  - при `standing: true` — ещё и аккаунт тем же чтением, что автозапуск
 *    (engAutoLaunch.readHeEngAccountStanding: бан Supabase, роль не
 *    client/admin, демо, пользователя нет). Так держится и бан, поставленный
 *    мимо карточки (без отметки). Это чтение пользователя в Supabase Auth и
 *    профиля — его зовут там, где оно редкое (раз на дочейн, на ночь проекта,
 *    на повторный старт, на нажатие платной кнопки), а не на каждом клейме
 *    джобы;
 *  - при `standing: 'eng_client'` — аккаунт читается только у владельца,
 *    который может быть клиентом английского кабинета
 *    (heEngOwnerNeedsStanding): у сотрудника (кроме админа) чтение аккаунта
 *    ответило бы 'role' (его роль не client/admin), а проект сотрудника
 *    (staff-инструмент) блокировкой клиента не останавливается — так же, как
 *    ночной добор пропускает его по 'not_client' (autoPipeline.ts,
 *    createHeRefillSendGate). Отметку при этом читают у любого владельца.
 *    Это режим путей без запроса клиента, где владелец — любой: дочейн
 *    автопилота ниже и ночной проход (autopilotReconcile.ts).
 * engAutoLaunch подгружается динамически: он сам (через engClientLaunch)
 * импортирует этот модуль, и статический импорт замкнул бы круг.
 * `marker: false` — отметку не читать (вызывающий уже прочитал её сам).
 *
 * Вердикт: 'blocked' — работу не начинать; 'unavailable' — не прочиталось:
 * работу тоже не начинать («не сейчас»); 'clear' — как до S3b. Таблицы
 * отметок нет (миграция 20261013_0001 не применена) — отметка не мешает, а
 * одну строку warn на процесс пишет сам читатель отметки. НЕ БРОСАЕТ.
 */
export type HeEngOwnerHold =
  | { kind: 'clear' }
  /** 'marker' — отметка блокировки; остальное — HeEngAccountStanding.reason. */
  | { kind: 'blocked'; source: 'marker' | Extract<HeEngAccountStanding, { kind: 'blocked' }>['reason'] }
  | { kind: 'unavailable'; detail: string };

export async function readHeEngOwnerHold(
  db: SupabaseClient,
  userId: string,
  opts: { standing: boolean | 'eng_client'; marker?: boolean },
): Promise<HeEngOwnerHold> {
  if (opts.marker !== false) {
    const marker = await readHeEngAccountBlock(db, userId);
    if (marker.state === 'blocked') return { kind: 'blocked', source: 'marker' };
    if (marker.state === 'error') return { kind: 'unavailable', detail: marker.detail };
  }
  if (!opts.standing) return { kind: 'clear' };
  if (opts.standing === 'eng_client') {
    const owner = await heEngOwnerNeedsStanding(db, userId);
    if (owner.kind === 'unavailable') return owner;
    if (owner.kind === 'skip') return { kind: 'clear' };
  }
  try {
    const { readHeEngAccountStanding } = await import('./engAutoLaunch');
    const standing = await readHeEngAccountStanding(db, userId);
    if (standing.kind === 'blocked') return { kind: 'blocked', source: standing.reason };
    if (standing.kind === 'unavailable') return { kind: 'unavailable', detail: `account standing: ${standing.message}` };
    return { kind: 'clear' };
  } catch (e) {
    return { kind: 'unavailable', detail: `account standing threw: ${e instanceof Error ? e.message.slice(0, 200) : 'unknown'}` };
  }
}

/**
 * Читать ли аккаунт владельца в режиме `standing: 'eng_client'`.
 * 'read' — профиль клиента английского кабинета (profiles.role='client' AND
 * market='eng': то же правило, что у readHeEngSendingAccess) или профиля нет
 * (аккаунт удалён или не дописан — чтение аккаунта ответит 'role', работа
 * не начнётся). 'skip' — любой другой профиль (сотрудник,
 * RU-клиент), владельца нет (пустой id: отметки и аккаунта у такого проекта
 * нет) или колонки market нет (42703 — английских клиентов быть не может, как
 * у readHeEngSendingAccess). Сбой чтения — 'unavailable': работу не начинать.
 * НЕ БРОСАЕТ.
 */
async function heEngOwnerNeedsStanding(
  db: SupabaseClient,
  userId: string,
): Promise<{ kind: 'read' } | { kind: 'skip' } | { kind: 'unavailable'; detail: string }> {
  if (typeof userId !== 'string' || userId.length === 0) return { kind: 'skip' };
  try {
    const { data, error } = await db
      .from('profiles')
      .select('role, market')
      .eq('id', userId)
      .maybeSingle();
    if (error) {
      const code = typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : '';
      if (code === '42703') return { kind: 'skip' };
      return { kind: 'unavailable', detail: `owner profile read: ${code ? `${code} ` : ''}${error.message}`.slice(0, 300) };
    }
    const row = (data ?? null) as { role?: unknown; market?: unknown } | null;
    if (!row) return { kind: 'read' };
    return row.role === 'client' && row.market === 'eng' ? { kind: 'read' } : { kind: 'skip' };
  } catch (e) {
    return { kind: 'unavailable', detail: `owner profile read threw: ${e instanceof Error ? e.message.slice(0, 200) : 'unknown'}` };
  }
}

/* ───────────── Сбой чтения ≠ решение ───────────── */

/**
 * ОШИБКА ЧТЕНИЯ СОСТОЯНИЯ — отдельный КЛАСС, а не текст.
 *
 * До этой правки координатор бросал наверх обычный Error, и «я решил ничего не
 * ставить» было неотличимо от «я не смог прочитать состояние»: обе новости
 * уходили одной строкой лога воркера, а в данных не оставалось ничего —
 * зацепиться автоматическому восстановлению было не за что.
 *
 * Класс, а не разбор сообщения: в этом движке по тексту ошибки судьбу работы не
 * решают (слово 'abort' здесь означает отмену пользователем, а не сбой).
 *
 * Класс НЕ терминальный. «Не прочитали» не переводит ни проект, ни базу в
 * failed — ни здесь, ни в реконсилере (autopilotReconcile.ts): единственное
 * последствие — причина 'read_failed' на строке проекта, которую снимает
 * следующий проход. СЛЕДУЮЩИЙ ПРОХОД — ЭТО НЕ ОБЕЩАНИЕ РАСПИСАНИЯ: ночной
 * автоматический (runHeAutopilotReconcilePass) существует в коде, но идёт
 * только там, где выставлен HE_AUTOPILOT_RECONCILE, а по умолчанию он
 * выключен. На установке без флага следующий проход — это нажатие кнопки
 * «Start outreach» клиентом, и ровно поэтому текст кабинета называет кнопку,
 * а не обещает возврат сам собой.
 */
export class HeAutopilotReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HeAutopilotReadError';
  }
}

/** Сбой ЧТЕНИЯ (а не решения и не записи) — по классу, не по тексту. */
export function isHeAutopilotReadError(err: unknown): err is HeAutopilotReadError {
  return err instanceof HeAutopilotReadError;
}

/* ───────────── Автопилот всё ещё включён? ───────────── */

/**
 * he_projects.autopilot всё ещё true — перечитывается ПРЯМО ПЕРЕД каждой
 * платной постановкой автопилота: в дочейне ниже (сборка, ремонт анализа,
 * письма) и в реконсилере (autopilotReconcile.ts: цепочка, ремонт анализа,
 * сборка, письма).
 *
 * Зачем второе чтение, если флаг уже прочитан на входе. Между тем чтением и
 * вставкой — несколько запросов (вертикаль, гипотезы, базы, живые джобы,
 * бюджет писем), а отмена клиентом (api/client/eng/projects/[id]/cancel)
 * пишет autopilot=false ПЕРВОЙ записью и только потом гасит стоящие джобы.
 * Постановка, прочитавшая флаг до отмены и вставившая джобу уже после того, как
 * роут погасил стоящие, оплачивала стадию на отменённом проекте. Остаток —
 * миллисекунды между ЭТИМ чтением и вставкой: чтение должно лечь раньше записи
 * флага роутом, а вставка — позже его записи джоб (вставку, легшую раньше, роут
 * гасит сам).
 *
 * Пауза ночного добора (refill_paused_at) здесь НЕ читается: добор — отдельный
 * контур, а «Start outreach» после отмены включает автопилот снова, не снимая
 * паузу добора (её снимает специалист), — и дочейн включённого клиентом
 * автопилота идти обязан.
 *
 * RU не меняется: autopilot=true пишет только кнопка кабинета
 * (reconcileHeAutopilotProject, trigger='client'), а проект с autopilot=false
 * до этого чтения не доходит — enqueueAutopilotFollowups возвращается сразу
 * после первого чтения флага.
 *
 * Сбой чтения бросает HeAutopilotReadError: «не знаю» платную постановку не
 * разрешает.
 */
export async function isHeAutopilotStillOn(supabase: SupabaseClient, projectId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('he_projects')
    .select('autopilot')
    .eq('id', projectId)
    .maybeSingle();
  if (error) throw new HeAutopilotReadError(`autopilot re-read: ${error.message}`);
  return (data as { autopilot?: unknown } | null)?.autopilot === true;
}

/* ───────────── Пауза автопилота: причина на строке проекта ───────────── */

/**
 * Колонки причины (миграция 20260930_0001_he_projects_autopilot_error.sql).
 * Наружу не экспортируются: единственный способ прочитать паузу — разбор
 * строки проекта функцией toHeAutopilotPause ниже, единственный способ
 * записать — recordHeAutopilotPause.
 */
const PAUSE_COLUMN = 'autopilot_error';
const PAUSE_AT_COLUMN = 'autopilot_error_at';

/**
 * Почему автопилот НЕ повёл конвейер дальше — ЗАКРЫТЫЙ список машинных
 * токенов. Русской прозы, текста БД и имён таблиц в колонке нет вовсе: в неё
 * уезжает ровно один из этих токенов, поэтому даже дословный проброс значения
 * в кабинет ничего не раскрывает. Подробность сбоя живёт в логе прогона и в
 * application_logs — там её читает специалист, а не клиент.
 *
 *  - 'read_failed'       — состояние не прочиталось (БД не ответила). НЕ
 *                          терминал: повторить может и ночной реконсилер, и
 *                          кнопка кабинета — путь у них один;
 *  - 'enqueue_failed'    — постановка стадии отвергнута БД. Тоже повторяется;
 *  - 'letters_exhausted' — засчитанные прогоны генерации писем на это поколение
 *                          анализа дошли до порога (см.
 *                          heTemplateGenerationBudget);
 *  - 'stage_failed'      — оплаченная стадия закончилась отказом, и сам по себе
 *                          автопилот за неё второй раз не платит;
 *  - 'setup_incomplete'  — вести нечего: вертикаль или база исчезли, в джобе нет
 *                          цели;
 *  - 'spend_ceiling'     — достигнут потолок расхода us-проекта (spendCeiling.ts;
 *                          ПО УМОЛЧАНИЮ ПОТОЛОК ВЫКЛЮЧЕН, и тогда этот токен не
 *                          пишет никто). Следующая платная стадия не поставлена,
 *                          команда получила алерт. Снимают причину полный проход
 *                          реконсилера, дочейн при прогрессе по правилу
 *                          followupMayClearPause и кнопка кабинета, увидевшая
 *                          расход ниже потолка, — через
 *                          clearHeSpendCeilingPauseIfSafe.
 *
 * «ПОВТОРИТСЯ» У ПЕРВЫХ ДВУХ — ПРО МЕХАНИЗМ, А НЕ ПРО РАСПИСАНИЕ. Автоматический
 * ночной проход (runHeAutopilotReconcilePass) идёт только на установке с
 * выставленным HE_AUTOPILOT_RECONCILE, по умолчанию флаг не выставлен, и тогда
 * повтор делает ровно тот же код по кнопке клиента. Поэтому кабинет в этих двух
 * состояниях и зовёт нажать «Start outreach» вместо «мы вернёмся сами».
 */
export const HE_AUTOPILOT_PAUSE_REASONS = [
  'read_failed',
  'enqueue_failed',
  'letters_exhausted',
  'stage_failed',
  'setup_incomplete',
  'spend_ceiling',
] as const;

export type HeAutopilotPauseReason = (typeof HE_AUTOPILOT_PAUSE_REASONS)[number];

/**
 * Пауза в виде, готовом для проекции кабинета (её собирает соседняя дорожка
 * волны 5 — clientEngProjection.ts). Второго источника у кабинета нет и быть не
 * должно: строка проекта разбирается ТОЛЬКО этой функцией.
 *
 * ФЛАГА «ПОВТОРИТСЯ САМО» ЗДЕСЬ НЕТ, и это решение, а не пропуск. Он был —
 * `auto_retry` поверх приватного множества из двух причин, — и не читал его
 * никто: единственный потребитель паузы, текст кабинета
 * (`components/client-eng/engText.ts`), про автоматический повтор намеренно
 * ничего не обещает, потому что ночной проход выключен флагом
 * `HE_AUTOPILOT_RECONCILE`. Пока флаг только вычислялся, «какие причины
 * чинятся сами» жило в ДВУХ местах — здесь и в тексте, — компилятор сверял
 * только одно из них, и разойтись они могли молча. Вернуть флаг имеет смысл
 * вместе с читателем, который умеет учесть env установки.
 */
export interface HeAutopilotPause {
  reason: HeAutopilotPauseReason;
  /** Когда записана (ISO). Нечитаемое значение → null. */
  at: string | null;
}

/**
 * Строка he_projects → пауза автопилота (или null: паузы нет).
 *
 * Неизвестный токен — тоже null: колонку пишет только recordHeAutopilotPause,
 * и значение вне закрытого списка означает лишь то, что строку писал код
 * новее этого; показывать его кабинету как причину нельзя.
 */
export function toHeAutopilotPause(
  project: Record<string, unknown> | null | undefined,
): HeAutopilotPause | null {
  const raw = project?.[PAUSE_COLUMN];
  if (typeof raw !== 'string') return null;
  const reason = HE_AUTOPILOT_PAUSE_REASONS.find((r) => r === raw);
  if (!reason) return null;
  const at = project?.[PAUSE_AT_COLUMN];
  return {
    reason,
    at: typeof at === 'string' && !Number.isNaN(Date.parse(at)) ? at : null,
  };
}

/**
 * Записать (reason) или снять (null) причину паузы. Возвращает, удалось ли.
 *
 * Три свойства, каждое намеренное:
 *  - СБОЙ ЗАПИСИ НЕ БРОСАЕТСЯ. Причина — сигнал кабинету и след для
 *    специалиста, а не состояние, из которого движок делает выводы: и ночной
 *    реконсилер, и воркер решают по САМИМ данным конвейера (джобы, базы,
 *    шаблоны). Уронить из-за этой записи уже сделанную работу нельзя. Сюда же
 *    попадает инсталляция без применённой миграции (PostgREST 42703) — там
 *    запись просто не выполняется, и всё остальное работает как раньше;
 *  - updated_at НЕ ТРОГАЕТСЯ: пометка паузы — не работа по проекту, а колонку
 *    двигает учёт расхода оплаченных стадий (worker/hypothesisEngine:
 *    accumulateProjectUsage). Очередь ночного прохода от неё больше не зависит
 *    (он идёт по id с ночным сдвигом окна, см. runHeAutopilotReconcilePass);
 *  - СНЯТИЕ адресное: `.not(is null)` — строку без причины запись не трогает
 *    вовсе.
 */
export async function recordHeAutopilotPause(
  supabase: SupabaseClient,
  projectId: string,
  reason: HeAutopilotPauseReason | null,
): Promise<boolean> {
  try {
    const patch = reason === null
      ? { [PAUSE_COLUMN]: null, [PAUSE_AT_COLUMN]: null }
      : { [PAUSE_COLUMN]: reason, [PAUSE_AT_COLUMN]: new Date().toISOString() };
    let query = supabase.from('he_projects').update(patch).eq('id', projectId);
    if (reason === null) query = query.not(PAUSE_COLUMN, 'is', null);
    const { error } = await query;
    return !error;
  } catch {
    return false;
  }
}

/**
 * Снять причину паузы, только если на проекте стоит ИМЕННО она (не чужую:
 * 'letters_exhausted' по другой вертикали и т. п.). Те же свойства, что у
 * recordHeAutopilotPause: не бросает, updated_at не трогает, строку без этой
 * причины не задевает (условный UPDATE). Решение «вправе ли» — за вызывающим:
 * единственный сегодня — clearHeSpendCeilingPauseIfSafe ниже.
 */
async function clearHeAutopilotPauseIf(
  supabase: SupabaseClient,
  projectId: string,
  reason: HeAutopilotPauseReason,
): Promise<boolean> {
  try {
    const { error } = await supabase
      .from('he_projects')
      .update({ [PAUSE_COLUMN]: null, [PAUSE_AT_COLUMN]: null })
      .eq('id', projectId)
      .eq(PAUSE_COLUMN, reason);
    return !error;
  } catch {
    return false;
  }
}

/**
 * Снять устаревшую причину 'spend_ceiling' после проверки КНОПКИ кабинета,
 * увидевшей расход ниже потолка (spendCeiling.enforceHeSpendCeiling).
 * Возвращает, снята ли.
 *
 * Причина — ОДНО поле на проект, а кнопка видит одну вертикаль (или ни одной:
 * старт исследования, письма по базе). Пауза 'spend_ceiling' на проекте с
 * автопилотом может означать, что потолок не дал поставить шаг ДРУГОЙ
 * вертикали, и его до сих пор никто не поставил; снять её здесь — спрятать
 * этот шаг от кабинета («autopilot has not flagged anything»), ровно как
 * описано у followupMayClearPause. Поэтому снимается только:
 *  - у проекта БЕЗ автопилота — пропущенных шагов автопилота у него нет, а
 *    причину записал отказ кнопки (ручной режим) или отказ, случившийся до
 *    выключения автопилота: следующий шаг всё равно за клиентом;
 *  - либо когда followupMayClearPause разрешает для `verticalId` (других
 *    выбранных вертикалей нет). Без вертикали — не разрешает.
 * Иначе причину снимет путь, видящий все вертикали, — «Start outreach»
 * (reconcileHeAutopilotProject).
 *
 * Запросы: один SELECT строки проекта; у проекта без этой причины (обычный
 * случай) на нём всё. Сбой чтения — не снимаем: устаревшая пауза безопаснее
 * ложного «всё чисто». Не бросает.
 */
export async function clearHeSpendCeilingPauseIfSafe(
  supabase: SupabaseClient,
  projectId: string,
  verticalId: string | null,
): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from('he_projects')
      .select(`autopilot, ${PAUSE_COLUMN}`)
      .eq('id', projectId)
      .maybeSingle();
    if (error || !data) return false;
    const row = data as Record<string, unknown>;
    if (row[PAUSE_COLUMN] !== 'spend_ceiling') return false;
    const mayClear = row.autopilot !== true || await followupMayClearPause(supabase, projectId, verticalId);
    return mayClear ? clearHeAutopilotPauseIf(supabase, projectId, 'spend_ceiling') : false;
  } catch {
    return false;
  }
}

/**
 * Ворота потолка расхода перед платной постановкой автопилота: true — ставить
 * можно, false — потолок достигнут (пауза и алерт уже сделаны тем, кто ворота
 * создал). Реализация — spendCeiling.createHeSpendGate; тип живёт здесь, чтобы
 * этот модуль не тянул spendCeiling (тот сам пишет паузу через этот модуль).
 * `stage` — что собирались поставить (строка алерта).
 */
export type HeSpendGate = ((stage: string) => Promise<boolean>) & {
  /**
   * Отказ дал ОБЩИЙ потолок ENG (HE_US_ENG_DAY_SPEND_CAP_USD): паузы на
   * проекте ворота не записали, и вызывающий свою тоже не пишет — пропуск
   * 'spend_ceiling_global' (spendCeiling.ts, шапка «ОБЩИЙ потолок ENG»). Нет
   * поля (ворота старого вида) или до первого отказа — false.
   */
  stopIsGlobal?: () => boolean;
};

/** Причина пропуска по отказу ворот потолка: общий потолок ENG — без паузы. */
function spendGateSkip(spendGate: HeSpendGate): HeAutopilotSkipReason {
  return spendGate.stopIsGlobal?.() === true ? 'spend_ceiling_global' : 'spend_ceiling';
}

/**
 * Лимит строк авто-сборки автопилота — 2000, как дефолт ручной кнопки
 * «Collect base» кабинета: полный цикл collect → construct → analyze укладывается
 * в разумное время; 10000 остаётся осознанным ручным выбором.
 */
export const AUTOPILOT_BASE_LIMIT = 2000;

/**
 * Окно, в котором 'analyzing'-база считается живой даже без активной джобы.
 *
 * Стадия base_collect переводит базу в 'analyzing' и ставит base_analyze двумя
 * отдельными запросами (stages/baseCollect.ts, harvest-финал). Читать эту щель
 * как «база мертва» нельзя — иначе автопилот запустит вторую платную сборку
 * поверх идущего анализа. Десяти минут хватает с запасом: между двумя
 * запросами проходят миллисекунды.
 *
 * Часы окна — he_bases.updated_at: harvest-финал пишет статус 'analyzing' и эту
 * колонку ОДНИМ апдейтом, и пока база висит в 'analyzing', её строку больше
 * никто не трогает — значит updated_at и есть «когда началось состояние без
 * анализа». created_at для этого не годится (возраст базы: сборка идёт часами,
 * свежую analyzing-базу он объявил бы мёртвой), he_jobs.finished_at сборки —
 * тоже (у убитой вместе с подом джобы его не бывает вовсе, а self-requeue
 * base_collect переписывает свои метки десятки раз).
 */
export const ANALYZING_ORPHAN_GRACE_MS = 10 * 60 * 1000;

/**
 * Поля he_bases, по которым воркер, автопилот и клиентский роут судят об
 * 'analyzing'-базе. `data` тут намеренно нет: строки базы — десятки мегабайт.
 */
export interface HeAnalyzingBase {
  id: string;
  status?: string | null;
  updated_at?: string | null;
  row_count?: unknown;
  columns?: unknown;
  filename?: unknown;
  /**
   * he_bases.source: 'auto' у авто-сборки, 'upload' (или NULL на старых строках)
   * у CSV специалиста. В HE_ANALYZING_BASE_FIELDS его НЕТ: автопилот и
   * клиентский роут отбирают базы `.eq('source', 'auto')` до предиката, а воркер
   * дописывает колонку к списку сам (worker/hypothesisEngine:
   * repairBaseAfterCollectFinalFail) — он единственный, кто читает базу по
   * base_id из payload джобы и обязан проверить источник сам.
   */
  source?: unknown;
}

/** SELECT-список под HeAnalyzingBase — чтобы три контура не разъехались полями. */
export const HE_ANALYZING_BASE_FIELDS = 'id, status, updated_at, row_count, columns, filename';

/**
 * ЕДИНСТВЕННЫЙ предикат «эта 'analyzing'-база жива» на все три контура: воркер
 * (ремонт после финального фейла base_collect), автопилот (этот файл) и
 * клиентский роут «Start outreach». Живая = по ней есть активная джоба ИЛИ её
 * строку писали только что (щель harvest-финала, см. ANALYZING_ORPHAN_GRACE_MS).
 *
 * graceMs=0 передаёт контур, который смерть НАБЛЮДАЛ, а не вывел из снапшота:
 * воркер зовёт ремонт из финального фейла той самой base_collect, которая и
 * должна была поставить анализ, — ждать там нечего, окно только мешало бы
 * лечить. Остальные два читают снапшот и берут окно по умолчанию.
 *
 * «Неизвестно» (нечитаемый updated_at) трактуем как «жива»: вторую платную
 * сборку на догадке не запускаем.
 */
export function isAnalyzingBaseLive(
  base: HeAnalyzingBase,
  liveBaseIds: Set<string>,
  graceMs: number = ANALYZING_ORPHAN_GRACE_MS,
): boolean {
  if (liveBaseIds.has(base.id)) return true;
  if (graceMs <= 0) return false;
  const updatedAt = typeof base.updated_at === 'string' ? Date.parse(base.updated_at) : NaN;
  if (Number.isNaN(updatedAt)) return true;
  return Date.now() - updatedAt <= graceMs;
}

/**
 * base_id всех активных (pending/running) джоб проекта — по ним отличаем живую
 * базу от осиротевшей. Любая стадия, а не только base_analyze: под идущей
 * джобой базу не ремонтируют. Сбой чтения бросаем: «неизвестно» не должно
 * превращаться ни в терминальный статус базы, ни в повтор платной сборки
 * (воркер этот бросок ловит сам и базу не трогает).
 */
export async function liveHeJobBaseIds(
  supabase: SupabaseClient,
  projectId: string,
): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('he_jobs')
    .select('id, payload')
    .eq('project_id', projectId)
    .in('status', ['pending', 'running']);
  if (error) throw new HeAutopilotReadError(`he_jobs live-jobs read: ${error.message}`);
  return liveBaseIdsFromJobs(data ?? []);
}

/** Тот же набор base_id из УЖЕ прочитанного снапшота активных джоб. */
export function liveBaseIdsFromJobs(jobs: { payload?: unknown }[]): Set<string> {
  const ids = new Set<string>();
  for (const row of jobs) {
    const baseId = (row.payload as { base_id?: unknown } | null)?.base_id;
    if (typeof baseId === 'string' && baseId.length > 0) ids.add(baseId);
  }
  return ids;
}

/**
 * Итог ремонта осиротевшей 'analyzing'-базы: 'reanalyzed' — у базы ЕСТЬ
 * поставленный анализ (вставили сейчас, он уже был, см. дедуп ниже, или
 * вставка «упала», но перечитывание нашло её строку), 'failed' — АНАЛИЗИРОВАТЬ
 * НЕЧЕГО (refill, нет строк или колонок), и база переведена в терминальный
 * статус. Только этот исход разрешает вызывающему новую сборку.
 *
 * Третьего вердикта нет намеренно: «не смогли поставить анализ» — это БРОСОК,
 * а не значение. Значение 'failed' на этом месте до волны правок аудита
 * означало две разные новости, и каждый вызывающий читал его как «нечего
 * анализировать» и ставил новую платную сборку поверх оплаченных строк.
 */
export type HeAnalyzingBaseRepair = 'reanalyzed' | 'failed';

/**
 * Ремонт осиротевшей 'analyzing'-базы — ОДИН на все три контура.
 *
 * В 'analyzing' harvest УЖЕ прошёл: строки собраны, конструктор оплачен, умерла
 * только вставка base_analyze (stages/baseCollect.ts делает её отдельным
 * запросом после перевода базы в 'analyzing'), а ретраи сборки после этого
 * доводят пару до конца сами (start-guard стадии узнаёт 'analyzing' с непустыми
 * row_count/columns и бесплатно доставляет анализ), поэтому сюда доезжают
 * только базы, чья сборка до повтора не дожила. Значит база ГОДНА к анализу, и
 * правильный ремонт — доставить пропавшую джобу анализа, а не выбросить
 * оплаченные строки в 'failed' и собрать их заново за новые деньги. Вставка в
 * he_jobs бесплатна, дальше конвейер ведёт автопилот (base_analyze done →
 * template), а кабинет всё это время честно показывает «analyzing the base…».
 *
 * 'failed' (CAS по 'analyzing') остаётся ровно там, где анализ невозможен:
 * анализировать нечего (нет строк или колонок — base_analyze сходил бы к LLM по
 * нулю строк и выставил 'analyzed' пустышке) или в этом конвейере анализа не
 * бывает вовсе (refill: долив лидов в кампанию, его терминальные статусы пишет
 * stages/baseCollectRefill.ts).
 *
 * СБОЙ ПОСТАНОВКИ — НЕ 'failed', а бросок, и база остаётся в 'analyzing'.
 * Раньше отвергнутая вставка валила базу с оплаченными строками в 'failed' и
 * возвращала тот же вердикт, что и «нечего анализировать», — и все вызывающие
 * (дочейн после chain, реконсилер по кнопке и ночью) ставили на это НОВУЮ
 * платную сборку: компании базы выпадали из исключений (`.neq('status',
 * 'failed')`) и покупались заново. А при ПОТЕРЯННОМ ответе (вставка
 * закоммитилась, шлюз ответил 502) живая джоба анализа затем сама переписывала
 * базу в 'analyzing' → 'analyzed', и у вертикали оказывались две платные базы.
 * Поэтому после отказа вставки строка перечитывается тем же дедупом: нашлась —
 * 'reanalyzed'; не нашлась или перечитать не удалось — бросок с базой в
 * 'analyzing'. Зависнуть она так не может: без живой джобы её снова видят
 * осиротевшей и дочейн после следующего chain, и кнопка «Start outreach», и
 * ночной проход — каждый повторит БЕСПЛАТНУЮ вставку. RU-инструмент (autopilot
 * = false) этих контуров не имеет, и там база остаётся 'analyzing' — ровно как
 * до ветки, где 'analyzing' ремонт не трогал вовсе.
 *
 * Живость базы проверяет ВЫЗЫВАЮЩИЙ (isAnalyzingBaseLive), но СВОЙ дедуп у
 * вставки тоже есть: снапшот живости вызывающего отделён от этой вставки
 * запросами (а у роута — ещё и обходом остальных вертикалей), и двух гонящихся
 * контуров или одного устаревшего снапшота хватает, чтобы по одной базе ушло
 * два base_analyze — то есть платный анализ дважды. Сбой записи и постановки
 * бросаем: вызывающий сам решает, что с этим делать, но ни один из трёх не
 * имеет права принять «не смогли починить» за «нечего анализировать» и
 * запустить сборку.
 */
export async function repairOrphanAnalyzingBase(
  supabase: SupabaseClient,
  args: {
    projectId: string;
    base: HeAnalyzingBase;
    /** Причина для he_bases.error, если анализ невозможен. */
    reason: string;
    /** Refill-конвейер (payload.refill джобы сборки); по filename виден и так. */
    refill?: boolean;
  },
): Promise<HeAnalyzingBaseRepair> {
  const { projectId, base, reason, refill } = args;

  /** Терминальная запись с CAS: пишем только из 'analyzing'. */
  const markFailed = async (error: string) => {
    const { error: failErr } = await supabase
      .from('he_bases')
      .update({
        status: 'failed',
        error: error.slice(0, 500),
        updated_at: new Date().toISOString(),
      })
      .eq('id', base.id)
      .eq('status', 'analyzing');
    if (failErr) throw new Error(`he_bases orphan base repair: ${failErr.message}`);
  };

  const isRefill = refill === true || String(base.filename ?? '').startsWith('auto-refill');
  const rowCount = typeof base.row_count === 'number' ? base.row_count : 0;
  const columns = Array.isArray(base.columns) ? base.columns : [];
  if (isRefill || rowCount <= 0 || columns.length === 0) {
    await markFailed(reason);
    return 'failed';
  }

  // Дедуп ровно той же формы, что у остальных постановок движка (ручной роут
  // bases/[id]/template, template-дочейн ниже): активная джоба этой стадии по
  // этой базе уже есть → второй не ставим. Читать ошибку нельзя молча: без
  // списка активных джоб вставка ушла бы «на догадке», а это платный анализ.
  const { data: activeAnalyze, error: activeErr } = await supabase
    .from('he_jobs')
    .select('id, payload')
    .eq('project_id', projectId)
    .eq('stage', 'base_analyze')
    .in('status', ['pending', 'running']);
  if (activeErr) {
    throw new HeAutopilotReadError(`he_jobs base_analyze dedup read: ${activeErr.message}`);
  }
  const alreadyQueued = (activeAnalyze ?? []).some(
    (j) => (j.payload as { base_id?: string } | null)?.base_id === base.id,
  );
  // Анализ уже стоит — база не осиротевшая, а живая: ремонтировать нечего, и в
  // 'failed' её ронять тем более нельзя (под ней идёт работа).
  if (alreadyQueued) return 'reanalyzed';

  const { error: enqueueErr } = await supabase.from('he_jobs').insert({
    project_id: projectId,
    stage: 'base_analyze',
    status: 'pending',
    payload: { base_id: base.id },
  });
  // 23505 — сработал he_jobs_one_active_base_analyze_per_base
  // (20261008_0001_he_active_job_unique.sql): между дедупом выше и вставкой
  // анализ этой базы поставил кто-то другой. Это ровно 'reanalyzed' — у базы
  // ЕСТЬ поставленный анализ, — и перечитывать ради этого нечего. Других
  // уникальных ограничений, способных ответить 23505 на вставку base_analyze, у
  // he_jobs нет (PK — gen_random_uuid, остальные partial-индексы — по другим
  // стадиям).
  if (enqueueErr?.code === '23505') return 'reanalyzed';
  if (enqueueErr) {
    // «Отвергнута» ≠ «не легла»: ответ шлюза мог потеряться при закоммиченной
    // вставке. Перечитываем тем же дедупом; базу в 'failed' не роняем ни при
    // каком исходе — см. докблок: строки оплачены, а 'failed' для вызывающего
    // означает «собирай заново».
    const { data: landed, error: landedErr } = await supabase
      .from('he_jobs')
      .select('id, payload')
      .eq('project_id', projectId)
      .eq('stage', 'base_analyze')
      .in('status', ['pending', 'running']);
    if (!landedErr && (landed ?? []).some((j) => jobBaseId((j as { payload?: unknown }).payload) === base.id)) {
      return 'reanalyzed';
    }
    throw new Error(
      `he_jobs base_analyze enqueue: ${enqueueErr.message}`
        + (landedErr ? `; he_jobs base_analyze re-read: ${landedErr.message}` : '')
        + ` (he_bases ${base.id} left 'analyzing')`,
    );
  }
  return 'reanalyzed';
}

/** Причина ремонта: base_analyze не был поставлен, живой джобы по базе нет. */
export const ORPHAN_ANALYZING_REASON =
  'he_jobs base_analyze не поставлен: база осталась в analyzing без активной джобы';

/* ───────────── «Эту стадию уже пробовали»: последний неуспешный исход ───────────── */

/** Неуспешный терминальный исход джобы: отказ движка или отмена клиентом. */
export type HeJobEndedOutcome = 'failed' | 'cancelled';

/**
 * base_id → исход ПОСЛЕДНЕЙ упавшей или отменённой джобы из `stages` по этой
 * базе. Строки — уже прочитанные he_jobs (status, stage, payload, created_at,
 * id) в любом порядке; 'done', активные и чужие стадии пропускаются.
 *
 * ПОСЛЕДНЯЯ, а не «любая»: у одной базы бывают оба исхода (клиент отменил
 * анализ, потом нажал «Start outreach» и новый анализ упал — или наоборот), и
 * правду о ней говорит тот, что случился позже. Порядок — created_at, тайбрейк
 * id: ровно так выбирает «последнюю джобу базы» и SQL автоподъёма
 * (20260929_0001_he_base_transient_resume.sql).
 *
 * Отдельной функцией, а не внутри каждого контура: «уже пробовали» читают и
 * дочейн после chain (endedBaseAnalyzeOutcomes ниже), и ночной реконсилер из
 * своего снапшота — два экземпляра правила разъехались бы молча.
 */
export function latestEndedJobByBase(
  rows: ReadonlyArray<Record<string, unknown>>,
  stages: readonly string[],
): Map<string, HeJobEndedOutcome> {
  const ended = rows
    .filter((row) => (row.status === 'failed' || row.status === 'cancelled')
      && typeof row.stage === 'string' && stages.includes(row.stage)
      && jobBaseId(row.payload) !== null)
    .map((row) => ({
      baseId: jobBaseId(row.payload) as string,
      outcome: row.status as HeJobEndedOutcome,
      // Нечитаемая метка — самой старой: «позже» про неё сказать нечего.
      at: typeof row.created_at === 'string' ? Date.parse(row.created_at) || 0 : 0,
      id: typeof row.id === 'string' ? row.id : '',
    }))
    .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const byBase = new Map<string, HeJobEndedOutcome>();
  for (const row of ended) byBase.set(row.baseId, row.outcome);
  return byBase;
}

/**
 * Исход последнего упавшего/отменённого base_analyze по каждой из `baseIds`
 * (нет ключа — анализ этой базы не падал и не отменялся).
 *
 * Зачем. Финальный фейл анализа НЕ трогает he_bases: failJob воркера лечит базу
 * только после base_collect, а стадия ставит 'analyzing' на входе и 'analyzed'
 * лишь на успехе. Отменённый анализ — тоже 'analyzing', если запись стадии
 * опередила роут отмены. Значит такая база выглядит ОСИРОТЕВШЕЙ по общему
 * предикату, и ремонт без этого чтения ставил бы ей новый ПЛАТНЫЙ анализ —
 * которого никто не просил.
 *
 * Сбой чтения — HeAutopilotReadError: «не знаю, падал ли анализ» не равно «не
 * падал», и платную постановку на догадке не делаем.
 */
export async function endedBaseAnalyzeOutcomes(
  supabase: SupabaseClient,
  projectId: string,
  baseIds: readonly string[],
): Promise<Map<string, HeJobEndedOutcome>> {
  if (baseIds.length === 0) return new Map();
  const { data, error } = await supabase
    .from('he_jobs')
    .select('id, stage, status, payload, created_at')
    .eq('project_id', projectId)
    .eq('stage', 'base_analyze')
    .in('status', ['failed', 'cancelled'])
    .in('payload->>base_id', [...baseIds]);
  if (error) throw new HeAutopilotReadError(`he_jobs base_analyze ended read: ${error.message}`);
  const wanted = new Set(baseIds);
  const rows = ((data ?? []) as Array<Record<string, unknown>>).filter((row) => {
    const baseId = jobBaseId(row.payload);
    return baseId !== null && wanted.has(baseId);
  });
  return latestEndedJobByBase(rows, ['base_analyze']);
}

/* ───────────── Почему шаг не понадобился: причина вместо молчания ───────────── */

/**
 * Причины, по которым шаг конвейера НЕ ставился, — закрытый список.
 *
 * Раньше все они возвращались одним словом 'skipped', и отличить «вертикали
 * ничего не нужно» от «джоба пришла без цели» или «писать письма уже не по
 * чему» было нельзя ни в логе, ни в данных. Список внутренний: наружу (в
 * кабинет) из него уезжает не сама причина, а её сворачивание в паузу
 * (pauseForHeAutopilotSkip) — у клиента другой словарь и другие действия.
 *
 * Читатели: лог воркера (`collect=skipped:base_ready`), лог ночного крона и
 * строка причины на проекте.
 */
export const HE_AUTOPILOT_SKIP_REASONS = [
  /** Решения — конвейеру здесь делать нечего. */
  'not_selected',        // у вертикали нет ни одной accepted-гипотезы: клиент её не выбирал
  'chain_running',       // цепочка писем ещё генерируется
  'base_ready',          // у вертикали уже есть проанализированная база
  'base_in_progress',    // база собирается или анализируется (живая)
  'collect_existing',    // сборка уже стояла (дедуп enqueueHeBaseCollect)
  'base_not_analyzed',   // база ещё не 'analyzed' — шаблон строить рано
  'template_ready',      // шаблон по базе уже есть
  'template_running',    // генерация шаблона уже идёт
  'autopilot_off',       // автопилот выключили между входом и постановкой (isHeAutopilotStillOn)
  /** Отказы — работа дальше не пойдёт сама. */
  'no_vertical_in_job',  // в payload джобы нет vertical_id
  'vertical_missing',    // строки вертикали больше нет
  'no_base_in_job',      // в payload джобы нет base_id
  'base_missing',        // строки базы больше нет
  'base_failed',         // база в терминальном отказе
  'chain_failed_before', // цепочка уже падала; автоматически за неё не платим
  'collect_failed_before', // сборка уже падала; автоматически за неё не платим
  'analysis_failed_before', // анализ базы уже падал; автоматически за него не платим
  'letters_exhausted',   // засчитанные прогоны писем на это поколение анализа дошли до порога
  'spend_ceiling',       // потолок расхода us-проекта достигнут (spendCeiling.ts; по умолчанию выключен)
  /**
   * Достигнут ОБЩИЙ потолок ENG (HE_US_ENG_DAY_SPEND_CAP_USD, по умолчанию
   * выключен): шаг не поставлен, но паузы проекта НЕТ — порог общий и
   * скользящий, отпускает сам (spendCeiling.ts, шапка «ОБЩИЙ потолок ENG»);
   * шаг двигает «Launch» клиента, следующий дочейн или ночной проход.
   */
  'spend_ceiling_global',
  /**
   * Решение по брифу КЛИЕНТА: поле, которое промпт писем берёт дословно
   * (подпись, оффер, описание бизнеса), называет наш бренд, а клиент не мы
   * (letterBrandGuard.heBrandInputsBeforeEnqueue). Генерация писем откажет до
   * первого вызова модели, поэтому её не ставим вовсе. Паузы проекта не даёт:
   * что поправить, говорит карточка рынка шага 3 (проекция
   * letters_brand_inputs), ответ «Launch» и — у дочейна после анализа, где
   * клиента рядом нет, — письмо об остановке рынка (recordHeBrandInputRefusal);
   * снимает это сам клиент правкой поля и «Launch».
   */
  'brand_input',
  /**
   * Решения КЛИЕНТА, а не отказы. Кнопка «Cancel all jobs» переводит джобы в
   * 'cancelled', и ночью за такую работу не платим заново: клиент её только
   * что остановил. Паузы кабинету эти причины НЕ дают — клиент знает, что
   * нажал, а карточка «платный шаг остановился с ошибкой» была бы неправдой;
   * возобновляет он сам кнопкой «Start outreach».
   */
  'chain_cancelled',     // цепочку писем отменил клиент
  'collect_cancelled',   // сборку (или анализ) последней базы вертикали отменил клиент
  'analysis_cancelled',  // анализ базы отменил клиент
  'template_cancelled',  // генерацию писем по базе отменил клиент
  /**
   * Решение СОТРУДНИКА: владелец us-проекта заблокирован (readHeEngOwnerHold —
   * отметка блокировки или бан, роль, демо). Паузы проекта не даёт: войти и
   * увидеть её клиент не может, а после разблокировки этап запускает его
   * «Launch».
   */
  'account_blocked',
  'orphan_repair_failed',      // ремонт осиротевшей базы не удался (запись)
  'orphan_repair_read_failed', // ремонт осиротевшей базы не удался (чтение)
] as const;

export type HeAutopilotSkipReason = (typeof HE_AUTOPILOT_SKIP_REASONS)[number];

/**
 * Причина пропуска → пауза проекта (null — здоровое решение, паузы нет).
 *
 * ЕДИНСТВЕННОЕ место, где решается, что из внутренних причин видит кабинет:
 * два словаря разъезжаются ровно тогда, когда у них две таблицы соответствия.
 */
export function pauseForHeAutopilotSkip(
  reason: HeAutopilotSkipReason,
): HeAutopilotPauseReason | null {
  switch (reason) {
    case 'not_selected':
    case 'chain_running':
    case 'base_ready':
    case 'base_in_progress':
    case 'collect_existing':
    case 'base_not_analyzed':
    case 'template_ready':
    case 'template_running':
      return null;
    // Выключил клиент (отмена): это его решение, а не сбой, — паузы нет.
    case 'autopilot_off':
      return null;
    case 'no_vertical_in_job':
    case 'vertical_missing':
    case 'no_base_in_job':
    case 'base_missing':
      return 'setup_incomplete';
    case 'base_failed':
    case 'chain_failed_before':
    case 'collect_failed_before':
    case 'analysis_failed_before':
      return 'stage_failed';
    case 'chain_cancelled':
    case 'collect_cancelled':
    case 'analysis_cancelled':
    case 'template_cancelled':
      return null;
    // Блокировка — решение сотрудника, а не сбой платного шага.
    case 'account_blocked':
      return null;
    case 'letters_exhausted':
      return 'letters_exhausted';
    case 'spend_ceiling':
      return 'spend_ceiling';
    // Общий потолок ENG — без паузы (см. причину выше).
    case 'spend_ceiling_global':
      return null;
    // Поле брифа клиента: поправить его может только он, и карточка рынка
    // называет поле — паузы «платный шаг остановился» здесь нет.
    case 'brand_input':
      return null;
    case 'orphan_repair_failed':
      return 'enqueue_failed';
    case 'orphan_repair_read_failed':
      return 'read_failed';
  }
}

/* ───────────── Тормоз бесконечной платной генерации писем ───────────── */

/**
 * Порог тормоза писем: новая генерация по поколению анализа базы НЕ СТАВИТСЯ,
 * когда засчитанных прогонов (heTemplateGenerationBudget) уже столько.
 *
 * ЭТО ПОРОГ ПОСТАНОВКИ, А НЕ ПОТОЛОК РАСХОДА — и «три платных прогона на
 * поколение» он не означает, по двум причинам:
 *  - тормоз не даёт НАЧАТЬ строку, но не укорачивает уже начатую. Строка,
 *    поставленная при двух засчитанных прогонах, проходит все свои
 *    MAX_ATTEMPTS = 3 (worker/hypothesisEngine.ts), так что по счётчику
 *    поколение доходит до (3 − 1) + 3 = 5 засчитанных прогонов;
 *  - засчитываются ПОПЫТКИ (he_jobs.attempts), а не вызовы модели. Бесплатное
 *    прерывание (рестарт пода, сторож простоя) попытку не тратит, хотя
 *    прерванный прогон мог уже оплатить модель (воркер даже записывает этот
 *    расход в he_jobs.cost_usd). Перед каждой засчитанной попыткой воркер
 *    допускает до HE_JOB_FREE_INTERRUPTIONS = 5 прерываний подряд, то есть одна
 *    строка — это до 3 × (1 + 5) = 18 прогонов стадии, а сколько из них было
 *    прервано, строка не хранит: payload.interruptions — серия ПОДРЯД, её
 *    снимает следующий обычный фейл или done.
 * Худший случай машинного пути на одно поколение — три строки (две по одному
 * засчитанному прогону, третья на все три попытки): до 5 засчитанных попыток
 * и до 6 + 6 + 18 = 30 прогонов стадии с прерываниями. Строки, отменённые
 * клиентом, сюда не входят: их attempts обычно 0, и их число задаёт человек.
 * Граница КОНЕЧНА — ради этого тормоз и стоит; строже (ровно три) её сделала
 * бы только постановка «paidRuns + MAX_ATTEMPTS ≤ порог», а она при этих числах
 * оставляет одну строку на поколение — это решение о продукте, а не правка.
 *
 * Три — столько же, сколько MAX_ATTEMPTS воркера даёт одной строке. Константу
 * не импортируем: она живёт в воркере, а этот модуль тянут и роуты Next.
 */
export const HE_TEMPLATE_PAID_RUNS_PER_ANALYSIS = 3;

/** Остаток бюджета писем по базе. */
export interface HeTemplateGenerationBudget {
  /** Можно ли ставить ещё одну генерацию. */
  allowed: boolean;
  /**
   * Сколько прогонов засчитано этому поколению: попытки строк (он же счётчик
   * he_jobs.attempts), закончившейся строке — минимум одна (кроме done-строки,
   * вернувшей уже готовый шаблон без модели, и failed-строки, закрытой
   * бесплатным отказом за наш бренд в поле брифа, — им только их attempts).
   * Бесплатно прерванные прогоны сюда не попадают (см.
   * HE_TEMPLATE_PAID_RUNS_PER_ANALYSIS).
   */
  paidRuns: number;
  /** created_at последней done-джобы base_analyze этой базы (null — её нет). */
  generationAt: string | null;
}

function jobBaseId(payload: unknown): string | null {
  const id = (payload as { base_id?: unknown } | null)?.base_id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * ТОРМОЗ: сколько засчитанных генераций писем уже съело текущее поколение
 * анализа.
 *
 * ЗАЧЕМ. Упавшая стадия template не оставляет после себя ничего: строка джобы
 * терминальна, he_templates нет, база остаётся 'analyzed'. Поэтому всякий, кто
 * периодически доставляет недостающие стадии (кнопка Start outreach, ночной
 * реконсилер), видит «база готова, шаблона нет» и ставит генерацию ЗАНОВО — и
 * так каждый раз, без всякой границы: MAX_ATTEMPTS считает попытки ОДНОЙ
 * строки, а строк становится по новой каждый тик.
 *
 * ПРИВЯЗКА К ПОКОЛЕНИЮ — половина, без которой тормоз вреден. Поколение — это
 * created_at последней 'done'-джобы base_analyze той же базы. Новый анализ
 * (специалист перезапустил разбор, движок доставил пропавший base_analyze)
 * начинает поколение заново, и законный повтор писем по НОВОМУ анализу
 * проходит. Без привязки тормоз запретил бы и его — а это живая продуктовая
 * потребность, ради которой ручная кнопка и существует. «Повтор» здесь — это
 * генерация там, где шаблона у базы НЕТ (прошлое поколение писем упало):
 * базу с готовым шаблоном ни дочейн, ни реконсилер, ни клиентский роут в
 * генерацию не ставят вовсе, а их джобы ENG несут payload.reuse — стадия с ним
 * вернула бы готовый шаблон (stages/template.ts, findReusableTemplate).
 * Пересобрать письма поверх готовых может специалист (staff-роут, payload.force)
 * и «Rewrite letters» кабинета, снявший готовые письма.
 *
 * СЧИТАЕМ ПОПЫТКИ, А НЕ СТРОКИ — и попытка здесь приближение денег, а не
 * деньги. attempts в этом движке инкрементируется только на ЗАСЧИТАННОМ фейле:
 * бесплатное прерывание (рестарт пода, сторож простоя) его не трогает. Поэтому
 * строка, убитая деплоем и не потратившая попытки, порог не приближает —
 * следующая генерация разрешена, хотя прерванный прогон мог уже оплатить
 * модель; насколько это расходится с деньгами — в докблоке
 * HE_TEMPLATE_PAID_RUNS_PER_ANALYSIS. Закончившейся строке (done/failed)
 * засчитываем минимум один прогон: она дошла до конца, значит модель звали хотя
 * бы раз, даже если счётчик этого не записал. Исключение — done-строка, которая
 * вернула уже готовый шаблон (result.reused, stages/template.ts): модель она не
 * звала, и засчитываются ей только её attempts — упавшие попытки до этого
 * возврата (форс-джоба, чья первая попытка оплатила и вставила шаблон, а
 * done-запись не легла). Второе исключение — failed-строка с пометкой
 * бесплатного отказа (letterBrandGuard.heJobUnpaidBrandInput: поле брифа
 * называет наш бренд, стадия отказала до первого вызова модели, воркер
 * попытку не засчитал): ей тоже только её attempts — платные попытки той же
 * строки до этого отказа. Так клиент, поправивший поле, пишет письма с полным
 * бюджетом, сколько бы таких отказов ни было.
 *
 * Сбой чтения БРОСАЕТСЯ HeAutopilotReadError: «не знаю, сколько потрачено» —
 * это не «не потрачено ничего». Вызывающий на этом останавливается и пробует
 * в следующий раз; никакой терминальный статус при этом не пишется.
 */
export async function heTemplateGenerationBudget(
  supabase: SupabaseClient,
  args: { projectId: string; baseId: string },
): Promise<HeTemplateGenerationBudget> {
  const { projectId, baseId } = args;

  // Отбор по base_id идёт и в БД (`payload->>base_id`, как в staff-роуте
  // загрузки CSV), и в JS: серверный фильтр режет выборку до нужных строк, а
  // проверка в коде остаётся единственным, что решает, ЧЕЙ это прогон.
  const { data: analyzeRows, error: analyzeErr } = await supabase
    .from('he_jobs')
    .select('created_at, payload')
    .eq('project_id', projectId)
    .eq('stage', 'base_analyze')
    .eq('status', 'done')
    .eq('payload->>base_id', baseId)
    .order('created_at', { ascending: false });
  if (analyzeErr) {
    throw new HeAutopilotReadError(`he_jobs base_analyze generation read: ${analyzeErr.message}`);
  }
  const generationAt = (analyzeRows ?? [])
    .filter((row) => jobBaseId((row as { payload?: unknown }).payload) === baseId)
    .map((row) => (row as { created_at?: unknown }).created_at)
    .find((value): value is string => typeof value === 'string' && value.length > 0) ?? null;

  let templateQuery = supabase
    .from('he_jobs')
    .select('status, attempts, payload, reused:result->>reused')
    .eq('project_id', projectId)
    .eq('stage', 'template')
    .eq('payload->>base_id', baseId);
  // Поколения нет (анализ не оставил done-джобы) — считаем ВСЕ генерации этой
  // базы: бюджет обязан остаться конечным и там, где поколение не опознано.
  if (generationAt) templateQuery = templateQuery.gte('created_at', generationAt);
  const { data: templateRows, error: templateErr } = await templateQuery;
  if (templateErr) {
    throw new HeAutopilotReadError(`he_jobs template budget read: ${templateErr.message}`);
  }

  let paidRuns = 0;
  for (const row of (templateRows ?? []) as Array<Record<string, unknown>>) {
    if (jobBaseId(row.payload) !== baseId) continue;
    const attempts = typeof row.attempts === 'number' && row.attempts > 0 ? row.attempts : 0;
    const ended = row.status === 'done' || row.status === 'failed';
    // `->>` отдаёт текст: 'true' у строки, вернувшей готовый шаблон без модели.
    const reused = row.status === 'done' && row.reused === 'true';
    // Строку закрыл бесплатный отказ (наш бренд в поле брифа — пометка воркера,
    // letterBrandGuard.heJobUnpaidBrandInput): последний прогон модель не звал,
    // и «минимум один» ему не положен — засчитываются только платные попытки
    // до него (attempts этот отказ не трогает).
    const unpaid = row.status === 'failed' && heJobUnpaidBrandInput(row.payload) !== null;
    paidRuns += ended && !reused && !unpaid ? Math.max(attempts, 1) : attempts;
  }

  return { allowed: paidRuns < HE_TEMPLATE_PAID_RUNS_PER_ANALYSIS, paidRuns, generationAt };
}

/**
 * Итог одного дочейна: поставили новое ('enqueued'), уже стояло ('existing'),
 * вместо новой платной сборки вылечили осиротевшую базу постановкой пропавшего
 * анализа ('reanalyzed') или не потребовалось — и тогда С ПРИЧИНОЙ
 * ('skipped:<reason>'). Молчаливого 'skipped' больше нет: причина едет в логе
 * воркера тем же словом и сворачивается в паузу проекта.
 */
export type AutopilotFollowup =
  | 'enqueued'
  | 'existing'
  | 'reanalyzed'
  | `skipped:${HeAutopilotSkipReason}`;

/** Собрать итог-пропуск с причиной (одно место, чтобы префикс не разъехался). */
function skipped(reason: HeAutopilotSkipReason): AutopilotFollowup {
  return `skipped:${reason}`;
}

/** Причина паузы по итогу дочейна (прогресс — паузы нет). */
function pauseForFollowup(outcome: AutopilotFollowup): HeAutopilotPauseReason | null {
  if (!outcome.startsWith('skipped:')) return null;
  return pauseForHeAutopilotSkip(outcome.slice('skipped:'.length) as HeAutopilotSkipReason);
}

export interface AutopilotFollowupsResult {
  /** Итог после chain done (нет ключа — стадия не chain). */
  collect?: AutopilotFollowup;
  /** Итог после base_analyze done (нет ключа — стадия не base_analyze). */
  template?: AutopilotFollowup;
  /**
   * Причина, записанная на проект этим дочейном (нет ключа — писать было
   * нечего). Ключ есть и в логе воркера: он печатает весь объект парами
   * «ключ=значение».
   */
  pause?: HeAutopilotPauseReason;
}

/** chain done → постановка сборки базы вертикали. */
async function afterChainDone(
  supabase: SupabaseClient,
  job: HeJob,
  spendGate: HeSpendGate | undefined,
): Promise<AutopilotFollowup> {
  const verticalId = typeof job.payload?.vertical_id === 'string' ? job.payload.vertical_id : null;
  if (!verticalId) return skipped('no_vertical_in_job');

  // Имя вертикали — в filename авто-базы; accepted-гипотезы — вход плана сборки.
  const [verticalRes, hypothesesRes] = await Promise.all([
    supabase.from('he_verticals').select('id, name').eq('id', verticalId).maybeSingle(),
    supabase.from('he_hypotheses').select('id').eq('vertical_id', verticalId).eq('status', 'accepted'),
  ]);
  if (verticalRes.error) {
    throw new HeAutopilotReadError(`autopilot vertical read: ${verticalRes.error.message}`);
  }
  if (hypothesesRes.error) {
    throw new HeAutopilotReadError(`autopilot hypotheses read: ${hypothesesRes.error.message}`);
  }
  if (!verticalRes.data) return skipped('vertical_missing');

  const hypothesisIds = (hypothesesRes.data ?? [])
    .map((h) => (h as { id?: string }).id)
    .filter((v): v is string => typeof v === 'string' && v.length > 0);

  // Re-chain (перегенерация/правка писем) не должен запускать новую сборку:
  // готовая или анализируемая auto-база вертикали остаётся основной. Иначе
  // каждая регенерация цепочки жгла бы часы конструктора на дубль базы.
  const { data: preparedBases, error: doneBaseErr } = await supabase
    .from('he_bases')
    .select(HE_ANALYZING_BASE_FIELDS)
    .eq('vertical_id', verticalId)
    .eq('source', 'auto')
    .in('status', ['analyzing', 'analyzed'])
    // Свежая — первой: вертикали нужна ОДНА база, и лечится первая годная.
    .order('created_at', { ascending: false });
  if (doneBaseErr) throw new HeAutopilotReadError(`autopilot done-base read: ${doneBaseErr.message}`);
  const prepared = (preparedBases ?? []) as unknown as HeAnalyzingBase[];
  if (prepared.some((b) => b.status === 'analyzed')) return skipped('base_ready');

  // 'analyzing' сама по себе больше НЕ считается подготовленной. База, которой
  // стадия успела выставить статус, но не успела поставить base_analyze, висит
  // так, пока её не вылечат (сама сборка закрывает пару первым же повтором, но
  // повтора могло не быть вовсе, а финальный фейл до этой правки базу не
  // валил) — и раньше НАВСЕГДА
  // останавливала автопилот вертикали: каждый следующий re-chain становился
  // no-op, а кабинет показывал «analyzing». Живую базу от осиротевшей отличаем
  // ОБЩИМ предикатом isAnalyzingBaseLive (активная джоба на её base_id плюс
  // окно ANALYZING_ORPHAN_GRACE_MS): под идущим анализом вторую платную сборку
  // запускать нельзя.
  const analyzing = prepared.filter((b) => b.status === 'analyzing');
  if (analyzing.length > 0) {
    const liveBaseIds = await liveHeJobBaseIds(supabase, job.project_id);
    const orphans = analyzing.filter((b) => !isAnalyzingBaseLive(b, liveBaseIds));
    if (orphans.length < analyzing.length) return skipped('base_in_progress');

    // Осиротевшую базу НЕ выбрасываем в 'failed' ради новой сборки: строки уже
    // собраны и оплачены (конструктор, провайдеры), умерла только постановка
    // анализа. Лечим тем же repairOrphanAnalyzingBase, что воркер после
    // финального фейла base_collect: годной базе доставляем base_analyze —
    // тогда «analyzing the base…» в кабинете снова правда, а новая платная
    // сборка не нужна. В 'failed' уходит только то, что анализировать нечем, и
    // лишь тогда ниже идёт сборка; не удавшаяся постановка БРОСАЕТ (база
    // остаётся 'analyzing'), и сборки тоже нет.
    //
    // Но «осиротевшая» по предикату ≠ «анализ не ставили». Анализ, который уже
    // ЗАПУСКАЛСЯ и упал (failJob базу не трогает — она так и висит в
    // 'analyzing') или был отменён клиентом, этот дочейн не переоплачивает: он
    // автоматический, и правило у него то же, что у ночного прохода, — за
    // упавшую или отменённую платную стадию машина второй раз не платит.
    // Такая база вертикаль ЗАНИМАЕТ (иначе ниже пошла бы новая платная сборка
    // или анализ соседней сироты); повтор — кнопка «Start outreach» или
    // специалист. Порядок и остановка — как у реконсилера: свежая база первой,
    // и вопрос вертикали закрывает первая же база, занятая или вылеченная.
    const ended = await endedBaseAnalyzeOutcomes(supabase, job.project_id, orphans.map((b) => b.id));
    for (const orphan of orphans) {
      const end = ended.get(orphan.id);
      if (end) return skipped(end === 'cancelled' ? 'analysis_cancelled' : 'analysis_failed_before');
      // Ремонт ставит ПЛАТНЫЙ анализ — флаг перечитываем прямо перед ним.
      if (!(await isHeAutopilotStillOn(supabase, job.project_id))) return skipped('autopilot_off');
      const verdict = await repairOrphanAnalyzingBase(supabase, {
        projectId: job.project_id,
        base: orphan,
        reason: ORPHAN_ANALYZING_REASON,
      });
      // Вертикали нужна ОДНА база: вылеченная первой закрывает вопрос, вторую
      // сироту анализировать незачем — это второй платный анализ.
      if (verdict === 'reanalyzed') return 'reanalyzed';
    }
  }

  // Сборка — часы конструктора и SMTP-пробы: флаг перечитываем прямо перед ней.
  if (!(await isHeAutopilotStillOn(supabase, job.project_id))) return skipped('autopilot_off');
  // Потолок расхода — последним, прямо перед постановкой: пауза пишется только
  // там, где действительно было что ставить. Ремонт осиротевшей базы выше
  // ворот не спрашивает НАМЕРЕННО: анализ базы, строки которой уже куплены, —
  // хвост оплаченной сборки, и ни один путь к base_analyze потолок не проверяет
  // (сборка ставит его сама; см. отчёт лейна потолка).
  if (spendGate && !(await spendGate('base_collect'))) return skipped(spendGateSkip(spendGate));
  const res = await enqueueHeBaseCollect(supabase, {
    verticalId,
    projectId: job.project_id,
    verticalName: (verticalRes.data as { name?: string }).name ?? 'vertical',
    limit: AUTOPILOT_BASE_LIMIT,
    hypothesisIds: hypothesisIds.length > 0 ? hypothesisIds : null,
  });
  if (!res.ok) throw new Error(`autopilot base_collect enqueue: ${res.message}`);
  return res.created ? 'enqueued' : 'existing';
}

/**
 * base_analyze done → постановка генерации шаблона по проанализированной базе.
 * Вместе с итогом отдаёт вертикаль базы (null — не прочиталась): по ней
 * enqueueAutopilotFollowups решает, вправе ли он СНЯТЬ паузу проекта.
 */
async function afterBaseAnalyzeDone(
  supabase: SupabaseClient,
  job: HeJob,
  spendGate: HeSpendGate | undefined,
): Promise<{ outcome: AutopilotFollowup; verticalId: string | null }> {
  const baseId = typeof job.payload?.base_id === 'string' ? job.payload.base_id : null;
  if (!baseId) return { outcome: skipped('no_base_in_job'), verticalId: null };

  const { data: base, error: baseErr } = await supabase
    .from('he_bases')
    .select('id, status, vertical_id')
    .eq('id', baseId)
    .maybeSingle();
  if (baseErr) throw new HeAutopilotReadError(`autopilot base read: ${baseErr.message}`);
  // Шаблон строится только по проанализированной базе (контракт ручной кнопки).
  if (!base) return { outcome: skipped('base_missing'), verticalId: null };
  const rawVerticalId = (base as { vertical_id?: unknown }).vertical_id;
  const verticalId = typeof rawVerticalId === 'string' && rawVerticalId.length > 0 ? rawVerticalId : null;
  const baseStatus = (base as { status?: unknown }).status;
  // Этот же гейт держит базу, которую анализ НЕ записал: финальная запись
  // stages/baseAnalyze.ts — CAS, и после отмены (база 'failed') она не задевает
  // строку, база 'analyzed' не становится, и шаблон здесь не ставится.
  if (baseStatus !== 'analyzed') {
    return { outcome: skipped(baseStatus === 'failed' ? 'base_failed' : 'base_not_analyzed'), verticalId };
  }

  // Дедуп — как у ручного роута bases/[id]/template: активная template-джоба
  // этой базы уже есть → новую не ставим.
  const { data: active, error: activeErr } = await supabase
    .from('he_jobs')
    .select('id, payload')
    .eq('project_id', job.project_id)
    .eq('stage', 'template')
    .in('status', ['pending', 'running']);
  if (activeErr) {
    throw new HeAutopilotReadError(`autopilot template dedup read: ${activeErr.message}`);
  }
  const existing = (active ?? []).find(
    (j) => (j.payload as { base_id?: string } | null)?.base_id === baseId,
  );
  if (existing) return { outcome: 'existing', verticalId };

  // Шаблон у базы УЖЕ ЕСТЬ — новый не ставим, как реконсилер
  // (autopilotReconcile.ts, 'template_ready') и клиентский роут шаблона
  // (TEMPLATE_EXISTS). Сюда это доезжает на ВТОРОМ done-анализе той же базы
  // (специалист перезапустил разбор, ремонт доставил анализ базе, у которой
  // шаблон уже лёг): раньше каждый такой анализ платил за новые письма поверх
  // готовых и оставлял базе второй готовый шаблон — то есть вторую кампанию по
  // тем же людям на шаге запуска. Стадия template с payload.reuse (его эта
  // постановка ставит у проекта 'us', ниже) вернула бы готовый шаблон и сама
  // (stages/template.ts, findReusableTemplate), но пустая джоба съела бы
  // прогон бюджета и строку в очереди — не ставим её вовсе.
  // Любой статус строки шаблона считается: стадия пишет только 'ready'.
  const { data: templates, error: templatesErr } = await supabase
    .from('he_templates')
    .select('id')
    .eq('base_id', baseId)
    .limit(1);
  if (templatesErr) {
    throw new HeAutopilotReadError(`autopilot template existence read: ${templatesErr.message}`);
  }
  if ((templates ?? []).length > 0) return { outcome: skipped('template_ready'), verticalId };

  // ТОРМОЗ платной генерации писем: бюджет поколения анализа (см.
  // heTemplateGenerationBudget). Здесь он почти всегда пропускает — эта
  // постановка идёт сразу после done-джобы base_analyze, то есть поколение
  // только что началось и потрачено по нему ноль. Правило всё равно одно на оба
  // входа: второй экземпляр тормоза разъехался бы с первым.
  const budget = await heTemplateGenerationBudget(supabase, {
    projectId: job.project_id,
    baseId,
  });
  if (!budget.allowed) return { outcome: skipped('letters_exhausted'), verticalId };

  // Наш бренд в поле брифа, которое промпт писем берёт дословно: стадия
  // откажет до первого вызова модели (HeLetterBrandInputError), и постановка
  // была бы пустой строкой очереди — не ставим вовсе. Тот же отказ на каждом
  // пути постановки писем (letterBrandGuard.heBrandInputsBeforeEnqueue);
  // клиенту поле называет карточка рынка шага 3. Сбой чтения — «не знаю», а
  // не «можно» (HeAutopilotReadError, как у чтений выше).
  const { data: projectRow, error: projectErr } = await supabase
    .from('he_projects')
    .select('market, website_url, brief, created_by')
    .eq('id', job.project_id)
    .maybeSingle();
  if (projectErr) throw new HeAutopilotReadError(`autopilot project brief read: ${projectErr.message}`);
  const briefProject = (projectRow ?? {}) as { market?: unknown; website_url?: unknown; brief?: unknown; created_by?: unknown };
  let brandInputs;
  try {
    const baseFirst = await readHeEngBaseFirst(supabase, briefProject);
    brandInputs = await heBrandInputsBeforeEnqueue(supabase, {
      market: normalizeHeMarket(briefProject.market),
      project: briefProject,
      // Без chain общий читатель языка возвращает ru. Итоговые письма
      // подтверждённого ENG-клиента всегда en; staff/legacy — как раньше.
      ...(baseFirst ? { language: 'en' } : verticalId ? { verticalId } : {}),
    });
  } catch (e) {
    throw new HeAutopilotReadError(`autopilot letters language read: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (brandInputs.length > 0) {
    await recordHeBrandInputRefusal(supabase, { projectId: job.project_id, baseId, inputs: brandInputs });
    return { outcome: skipped('brand_input'), verticalId };
  }

  // Письма — платная генерация: флаг перечитываем прямо перед постановкой.
  if (!(await isHeAutopilotStillOn(supabase, job.project_id))) {
    return { outcome: skipped('autopilot_off'), verticalId };
  }
  // Потолок расхода — прямо перед постановкой писем (см. afterChainDone).
  if (spendGate && !(await spendGate('template'))) return { outcome: skipped(spendGateSkip(spendGate)), verticalId };
  // reuse — только у 'us' (ENG): шаблон, легший между проверкой выше и
  // исполнением, стадия вернёт, а не оплатит заново. Джоба проекта другого
  // рынка (staff-инструмент) пишет письма, как до переиспользования.
  const { error: jobErr } = await supabase.from('he_jobs').insert({
    project_id: job.project_id,
    stage: 'template',
    status: 'pending',
    payload: normalizeHeMarket(briefProject.market) === 'us' ? { base_id: baseId, reuse: true } : { base_id: baseId },
  });
  // 23505 — he_jobs_one_active_template_per_base: между дедупом выше и вставкой
  // шаблон этой базы поставил кто-то другой (клиент, кнопка «Start outreach»).
  // Это тот же итог, что у дедупа, — 'existing', а не сбой постановки.
  if (jobErr?.code === '23505') return { outcome: 'existing', verticalId };
  if (jobErr) throw new Error(`autopilot template enqueue: ${jobErr.message}`);
  return { outcome: 'enqueued', verticalId };
}

/**
 * Отказ дочейна за поле брифа — СТРОКОЙ, а не только словом в логе: клиента
 * рядом нет (дочейн идёт после done-джобы base_analyze), и сказать ему, какое
 * поле шага 1 поправить, может только письмо об остановке рынка
 * (engClientMail, остановки стадий по упавшим джобам), а оно читает he_jobs.
 * Поэтому пишется сразу закрытая строка template: status 'failed', attempts 0,
 * he_jobs.error — тот же текст сотруднику, что у стадии
 * (HeLetterBrandInputError), payload — base_id и пометка бесплатного отказа с
 * полями (как у воркера, writeJobFailure). Воркер её не берёт (не 'pending'),
 * бюджет писем её не считает (heJobUnpaidBrandInput), письмо называет поле
 * ('edit_brief'). Одна строка на done-джобу анализа — писем не больше, чем
 * анализов. Запись не легла — пропуск тот же (поле называет карточка рынка
 * шага 3), только письма не будет; не бросает.
 */
async function recordHeBrandInputRefusal(
  supabase: SupabaseClient,
  args: { projectId: string; baseId: string; inputs: HeBrandInputLeak[] },
): Promise<void> {
  const nowIso = new Date().toISOString();
  try {
    await supabase.from('he_jobs').insert({
      project_id: args.projectId,
      stage: 'template',
      status: 'failed',
      attempts: 0,
      payload: {
        base_id: args.baseId,
        [HE_JOB_UNPAID_REFUSAL_KEY]: HE_JOB_UNPAID_BRAND_INPUT,
        [HE_JOB_BRAND_INPUTS_KEY]: args.inputs,
      },
      error: new HeLetterBrandInputError('template', args.inputs).message.slice(0, 500),
      finished_at: nowIso,
      updated_at: nowIso,
    });
  } catch {
    // Не бросает: см. докблок.
  }
}

/** Итог дочейна, при котором конвейер ЭТОЙ вертикали пошёл дальше. */
function isFollowupProgress(outcome: AutopilotFollowup): boolean {
  return outcome === 'enqueued' || outcome === 'existing' || outcome === 'reanalyzed';
}

/**
 * Вправе ли дочейн вертикали `verticalId` СНЯТЬ причину паузы проекта.
 *
 * Причина — ОДНО поле на проект, а дочейн видит одну вертикаль. Снимая её по
 * своему здоровому итогу, он стирал паузу, которую записал кто-то по ДРУГОЙ
 * вертикали (у B исчерпаны письма, у A после chain поставилась сборка — и
 * кабинет говорил «autopilot has not flagged anything», хотя B ждёт
 * менеджера). Поэтому снимать можно, только когда других вертикалей, способных
 * держать паузу, у проекта нет: каждая вертикаль с accepted-гипотезой — это
 * ровно та, что разбирает реконсилер (остальные он пропускает как
 * 'not_selected' без паузы). Иначе снятие оставлено пути, который видит все
 * вертикали сразу, — reconcileHeAutopilotProject (кнопка «Start outreach» и
 * ночной проход).
 *
 * Сбой чтения → «нельзя»: устаревшая пауза безопаснее ложного «всё чисто» —
 * кнопка, которую она называет, идемпотентна и пересчитает причину заново.
 */
async function followupMayClearPause(
  supabase: SupabaseClient,
  projectId: string,
  verticalId: string | null,
): Promise<boolean> {
  if (!verticalId) return false;
  try {
    const { data, error } = await supabase
      .from('he_hypotheses')
      .select('vertical_id')
      .eq('project_id', projectId)
      .eq('status', 'accepted');
    if (error) return false;
    return (data ?? []).every((row) => (row as { vertical_id?: unknown }).vertical_id === verticalId);
  } catch {
    return false;
  }
}

/**
 * Дочейнить следующую стадию конвейера автопилота после done-джобы.
 * Бросает ошибку наверх — воркер логирует и продолжает (done уже записан).
 *
 * Перед броском и после итога-пропуска на строку проекта пишется ПРИЧИНА
 * (recordHeAutopilotPause): сбой чтения — 'read_failed', сбой постановки —
 * 'enqueue_failed', пропуск — то, во что его сворачивает
 * pauseForHeAutopilotSkip (поверх прежней: последняя запись выигрывает, а
 * какая из причин проекта важнее, решает реконсилер, видящий все вертикали).
 * СНИМАЕТ причину дочейн только при ПРОГРЕССЕ своей вертикали и только когда
 * других выбранных клиентом вертикалей у проекта нет (followupMayClearPause);
 * здоровый пропуск («база уже готова», «анализ отменён») причину не трогает
 * вовсе — у дочейна нет полного вида, чтобы сказать «стоять не на чем».
 * Ни один из этих путей не пишет статус: «не прочитали» терминалом не бывает.
 *
 * Причина — сигнал кабинету и след специалисту, а НЕ состояние, из которого
 * движок делает выводы: ночной реконсилер (autopilotReconcile.ts) решает по
 * самим данным конвейера, поэтому неудавшаяся запись причины ничего не ломает.
 *
 * Владелец us-проекта заблокирован (readHeEngOwnerHold) — ничего не ставится:
 * 'skipped:account_blocked', паузы нет. Отметку блокировки читают у любого
 * владельца, аккаунт (бан, роль, демо) — только у клиента английского
 * кабинета: проект сотрудника идёт как раньше.
 *
 * `opts.spendGate` — ворота потолка расхода (spendCeiling.createHeSpendGate),
 * спрашиваются прямо перед платной постановкой сборки и писем. НЕОБЯЗАТЕЛЬНЫ, и
 * без них поведение прежнее; вызывающий этой функции один — воркер
 * (worker/hypothesisEngine.ts: deliverDoneRow и finishLandedDoneRow), и он
 * передаёт ворота в обоих местах. Сам потолок по умолчанию выключен: тогда
 * ворота отвечают «можно» без единого запроса.
 */
export async function enqueueAutopilotFollowups(
  supabase: SupabaseClient,
  job: HeJob,
  opts: { spendGate?: HeSpendGate } = {},
): Promise<AutopilotFollowupsResult> {
  // Только входные точки конвейера; research-стадии ведёт enqueueNextResearchStage,
  // base_collect сама ставит base_analyze, template — терминальная.
  if (job.stage !== 'chain' && job.stage !== 'base_analyze') return {};

  const { data: project, error: projErr } = await supabase
    .from('he_projects')
    .select('id, autopilot, market, created_by')
    .eq('id', job.project_id)
    .maybeSingle();
  // Причину тут НЕ пишем: автопилот проекта ещё не подтверждён (это и есть
  // непрочитанное поле), а метить паузой ручной RU-проект незачем. Сбой уедет
  // в лог воркера, а ночной проход разберётся по данным.
  if (projErr) throw new HeAutopilotReadError(`autopilot project read: ${projErr.message}`);
  if (!project || (project as { autopilot?: boolean }).autopilot !== true) return {};
  const { market, created_by: owner } = project as { market?: unknown; created_by?: unknown };

  let result: AutopilotFollowupsResult;
  let verticalId: string | null;
  try {
    // Владелец us-проекта заблокирован (S3b) — следующую платную стадию не
    // ставим. Блокировка сама выключает автопилот проекта (engProjectStop),
    // так что сюда доходит только то, что та запись не накрыла: её сбой или
    // бан мимо карточки клиента. Аккаунт читается только у клиента
    // английского кабинета ('eng_client'): у us-проекта сотрудника его роль —
    // не блокировка. Не прочиталось — как любой сбой чтения дочейна: причина
    // 'read_failed' и бросок (см. catch).
    if (market === 'us' && typeof owner === 'string' && owner.length > 0) {
      const hold = await readHeEngOwnerHold(supabase, owner, { standing: 'eng_client' });
      if (hold.kind === 'unavailable') throw new HeAutopilotReadError(`autopilot owner block read: ${hold.detail}`);
      if (hold.kind === 'blocked') {
        return job.stage === 'chain' ? { collect: skipped('account_blocked') } : { template: skipped('account_blocked') };
      }
    }
    if (job.stage === 'chain') {
      result = { collect: await afterChainDone(supabase, job, opts.spendGate) };
      verticalId = typeof job.payload?.vertical_id === 'string' && job.payload.vertical_id.length > 0
        ? job.payload.vertical_id
        : null;
    } else {
      const step = await afterBaseAnalyzeDone(supabase, job, opts.spendGate);
      result = { template: step.outcome };
      verticalId = step.verticalId;
    }
  } catch (e) {
    await recordHeAutopilotPause(
      supabase,
      job.project_id,
      isHeAutopilotReadError(e) ? 'read_failed' : 'enqueue_failed',
    );
    throw e;
  }

  const outcome = result.collect ?? result.template ?? null;
  const pause = outcome ? pauseForFollowup(outcome) : null;
  if (pause) {
    await recordHeAutopilotPause(supabase, job.project_id, pause);
  } else if (
    outcome
    && isFollowupProgress(outcome)
    && await followupMayClearPause(supabase, job.project_id, verticalId)
  ) {
    await recordHeAutopilotPause(supabase, job.project_id, null);
  }
  return pause ? { ...result, pause } : result;
}
