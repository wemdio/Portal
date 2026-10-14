/**
 * Ядро запуска авто-сборки базы под вертикаль «Движка вертикалей» (стадия
 * base_collect: план источников → коллекторы → harvest в he_bases).
 *
 * Вынесено из POST api/tools/hypothesis-engine/verticals/[id]/collect —
 * клиентский ENG-контур запускает сборку тем же кодом (со своими лимитами).
 * Здесь: дедупы и вставки. Валидация тела, загрузка вертикали (со скоупом
 * владельца в клиентском контуре) и аудит остаются в роутах.
 *
 * Создаёт he_bases (source='auto', status='collecting') + he_jobs
 * (stage='base_collect'). Лимит и непустой hypothesis_ids едут в payload
 * джобы (их читают totalRowsCap и buildPlan в стадии) и в
 * he_bases.collect_info (его показывает UI).
 *
 * Дедуп: активная (pending/running) base_collect-задача этой вертикали или
 * собирающаяся auto-база уже есть → outcome 'existing' (UI показывает «уже
 * собирается», а не молча продолжает; collect_info в выборке — ради
 * collect_info.limit в этом уведомлении).
 * Гонку двух параллельных запусков (оба прошли проверки до insert) закрывает
 * partial unique index he_bases_one_collecting_per_vertical: проигравший
 * insert получает 23505 и тоже отвечает 'existing' с чужой collecting-базой.
 *
 * Исключение из дедупа — ОСИРОТЕВШАЯ 'collecting'-база проекта market='us'
 * (по ней не было ни одной джобы сборки): ей доставляется пропавшая джоба, а
 * если её проект отменили после её создания — она закрывается так, как её
 * закрыл бы роут отмены, и постановка идёт дальше обычным путём. Условия и
 * доказательство «живая джоба не задваивается» — repairHeOrphanCollectingBase.
 *
 * Сбой вставки джобы ПОСЛЕ вставки базы компенсируется (см. хвост функции):
 * база уводится в 'failed', иначе осиротевшая 'collecting'-строка держит
 * дедуп и уникальный индекс вертикали. Компенсация срабатывает только
 * когда удалось УБЕДИТЬСЯ, что джобы нет: сбой самой проверки — отдельный
 * исход, статус базы в нём не пишется («неизвестно» ≠ «джобы нет»); такую
 * базу позже чинит тот же ремонт сирот.
 *
 * Здесь же резолвится лимит «адресов на компанию»: значение проекта
 * снимается ОДИН раз, на постановке, и дальше живёт на строке базы (см.
 * normalizeHeMaxEmailsPerCompany).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizeHeMarket } from './market';
import { readHeProjectCancelMarker } from './projectCancelMarker';

/*
 * ───────────── «До N адресов одной компании» (he_*) ─────────────
 *
 * Лимит применяет шаг конструктора cap_emails_per_company: он оставляет не
 * больше N СТРОК на компанию, ранжируя их по вердикту валидации. До 26.09.2026
 * стадия base_collect передавала ему константу 5, и при этом в ENG-сетке не
 * было шага split_emails — все адреса компании жили в одной ячейке, строка на
 * компанию была одна, и лимит не делал ничего. С разносом адресов по строкам
 * он начинает работать, поэтому значение стало данными: колонка проекта
 * (дефолт для новых сборок) → колонка базы (действует на эту сборку) → дефолт
 * движка. Миграция — supabase/migrations/20260926_0001_he_emails_per_company.sql.
 *
 * Константы живут в этом модуле, а не в стадии: он лёгкий (тип SupabaseClient
 * и два модуля без зависимостей — market.ts и projectCancelMarker.ts), поэтому
 * его безопасно тянуть и из роутов Next, и из воркера. Обратный импорт — роут
 * за собой утащил бы весь граф стадии.
 */

/** Границы значения; обязаны совпадать с check-ограничениями миграции. */
export const HE_MAX_EMAILS_PER_COMPANY_MIN = 1;
export const HE_MAX_EMAILS_PER_COMPANY_MAX = 100;
/**
 * Значение, захардкоженное в step_config до 26.09.2026. Остаётся дефолтом:
 * проект без настройки собирается ровно как раньше.
 */
export const HE_MAX_EMAILS_PER_COMPANY_DEFAULT = 5;

/**
 * null = «значения нет» (нужен дефолт движка). Всё, что не целое в границах, —
 * тоже «нет»: угадывать чужой лимит нельзя, а мусор в колонке не должен
 * превращаться в кап 0 и обнулять базу.
 */
export function normalizeHeMaxEmailsPerCompany(value: unknown): number | null {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= HE_MAX_EMAILS_PER_COMPANY_MIN
    && value <= HE_MAX_EMAILS_PER_COMPANY_MAX
    ? value
    : null;
}

export interface HeBaseCollectInput {
  verticalId: string;
  projectId: string;
  /** Имя вертикали — в filename авто-базы («auto: <name>»). */
  verticalName: string;
  /** Лимит строк сборки (практический предохранитель от раздутого data jsonb). */
  limit: number;
  /** Выбранные в UI гипотезы; null — собирать по всем. */
  hypothesisIds: string[] | null;
  /**
   * Переопределение filename авто-базы (по умолчанию «auto: <name>»).
   * ENG auto-pipeline пишет «auto-refill: <name> · <дата>».
   */
  filename?: string;
  /**
   * Refill-режим (ENG auto-pipeline): после сборки и конструктора стадия
   * НЕ ставит base_analyze/template, а доливает валидные строки лидaми в
   * уже запущенную кампанию campaignId (см. stages/baseCollectRefill.ts).
   * campaign_id дублируется в collect_info — на момент постановки это
   * снапшот launch_info, стадия умеет и фолбэк на последний launched шаблон.
   */
  refill?: { campaignId: string };
}

export type HeBaseCollectResult =
  /**
   * Сборка стартовала: создана новая база + джоба, либо (repaired) осиротевшей
   * 'collecting'-базе вертикали поставлена пропавшая джоба — для вызывающего
   * это та же поставленная платная сборка, только на старой строке базы и с её
   * собственным лимитом и выбором гипотез (вход этого вызова не применяется).
   */
  | { ok: true; created: true; repaired?: true; base: Record<string, unknown> }
  /** Дедуп: сборка уже идёт (существующая collecting-база). */
  | { ok: true; created: false; base: Record<string, unknown> }
  | { ok: false; message: string };

export async function enqueueHeBaseCollect(
  supabase: SupabaseClient,
  input: HeBaseCollectInput,
): Promise<HeBaseCollectResult> {
  const { verticalId, projectId, verticalName, limit, hypothesisIds, filename, refill } = input;

  // Дедуп 1: уже собирающаяся auto-база этой вертикали (не больше одной —
  // he_bases_one_collecting_per_vertical). Осиротевшую чинит ремонт сирот;
  // created_at/updated_at/filename в выборке — ради него.
  const { data: collecting, error: collErr } = await supabase
    .from('he_bases')
    .select('id, status, collect_info, filename, created_at, updated_at')
    .eq('vertical_id', verticalId)
    .eq('source', 'auto')
    .eq('status', 'collecting')
    .limit(1)
    .maybeSingle();
  if (collErr) return { ok: false, message: collErr.message };
  if (collecting) {
    const collectingRow = collecting as Record<string, unknown>;
    const repair = await repairHeOrphanCollectingBase(supabase, {
      projectId,
      base: collectingRow,
      refillCampaignId: refill?.campaignId ?? null,
    });
    if (repair.outcome === 'repaired') return { ok: true, created: true, repaired: true, base: collectingRow };
    if (repair.outcome === 'failed') return { ok: false, message: repair.message };
    if (repair.outcome !== 'closed_cancelled') return { ok: true, created: false, base: collectingRow };
    // 'closed_cancelled': сирота закрыта как отменённая — слот вертикали
    // свободен, и этот вызов (сделанный ПОСЛЕ отмены) идёт обычным путём ниже.
  }

  // Дедуп 2: pending/running base_collect-задача на базу этой вертикали
  // (база могла уже выйти из collecting, пока джоба ещё активна).
  const { data: active, error: activeErr } = await supabase
    .from('he_jobs')
    .select('id, payload')
    .eq('project_id', projectId)
    .eq('stage', 'base_collect')
    .in('status', ['pending', 'running']);
  if (activeErr) return { ok: false, message: activeErr.message };
  const baseIds = (active ?? [])
    .map((j) => (j.payload as { base_id?: string } | null)?.base_id)
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
  if (baseIds.length > 0) {
    const { data: existingBase, error: baseErr } = await supabase
      .from('he_bases')
      .select('id, status, collect_info')
      .eq('vertical_id', verticalId)
      .in('id', baseIds)
      // Упавшая сборка не блокирует повторный запуск: failed-базу
      // не считаем конфликтом, даём создать новую.
      .neq('status', 'failed')
      .limit(1)
      .maybeSingle();
    if (baseErr) return { ok: false, message: baseErr.message };
    if (existingBase) return { ok: true, created: false, base: existingBase as Record<string, unknown> };
  }

  // collect_info/payload джобы: у refill-сборки свой снапшот полей (кампания
  // долива), hypothesis_ids в нём не используется — план строится по
  // неотклонённым гипотезам, как без явного выбора.
  const collectInfo: Record<string, unknown> = refill
    ? { limit, refill: true, campaign_id: refill.campaignId }
    : hypothesisIds
      ? { limit, hypothesis_ids: hypothesisIds }
      : { limit };
  const jobPayload: Record<string, unknown> = refill
    ? { limit, refill: true }
    : hypothesisIds
      ? { limit, hypothesis_ids: hypothesisIds }
      : { limit };

  // Лимит «адресов на компанию» снимается с проекта ЗДЕСЬ и штампуется на
  // строку базы: правка проектной настройки после постановки не должна менять
  // уже идущую (и тем более уже собранную) базу под ней — стадия читает
  // значение своей базы, а не проекта.
  //
  // Сбой чтения (включая инсталляцию, где миграция ещё не применена, — код
  // 42703) трактуется как «значения нет»: стадия подставит
  // HE_MAX_EMAILS_PER_COMPANY_DEFAULT, то есть сегодняшнее поведение. Валить
  // постановку сборки из-за необязательной настройки нельзя, а угадывать лимит
  // — тем более. Колонка уходит в insert только когда значение ЕСТЬ: непустое
  // значение доказывает, что колонка в базе есть, и insert не упадёт на
  // неизвестном поле.
  let contactCap: number | null = null;
  try {
    const { data: projectRow, error: projectErr } = await supabase
      .from('he_projects')
      .select('max_emails_per_company')
      .eq('id', projectId)
      .maybeSingle();
    if (!projectErr) {
      contactCap = normalizeHeMaxEmailsPerCompany(
        (projectRow as { max_emails_per_company?: unknown } | null)?.max_emails_per_company,
      );
    }
  } catch { /* значения нет → дефолт движка */ }

  const { data: base, error: baseInsertErr } = await supabase
    .from('he_bases')
    .insert({
      project_id: projectId,
      vertical_id: verticalId,
      source: 'auto',
      status: 'collecting',
      filename: filename ?? `auto: ${verticalName}`,
      row_count: 0,
      columns: [],
      data: [],
      ...(contactCap !== null ? { max_emails_per_company: contactCap } : {}),
      // Лимит и выбранные гипотезы — сразу в collect_info: прогресс-карта
      // показывает лимит, пока стадия ещё не перезаписала collect_info
      // планом (поля живут дальше — стадия мержит collect_info, а не
      // заменяет).
      collect_info: collectInfo,
    })
    .select('id, status')
    .single();
  if (baseInsertErr || !base) {
    // 23505 = unique_violation на he_bases_one_collecting_per_vertical:
    // параллельный запуск успел вставить collecting-базу раньше. Это тот же
    // дедуп, только пойманный индексом, — отвечаем 'existing' с чужой базой.
    if (baseInsertErr?.code === '23505') {
      const { data: conflict, error: conflictErr } = await supabase
        .from('he_bases')
        .select('id, status, collect_info')
        .eq('vertical_id', verticalId)
        .eq('source', 'auto')
        .eq('status', 'collecting')
        .limit(1)
        .maybeSingle();
      if (conflictErr) return { ok: false, message: conflictErr.message };
      if (conflict) return { ok: true, created: false, base: conflict as Record<string, unknown> };
    }
    return { ok: false, message: baseInsertErr?.message ?? 'base insert failed' };
  }

  const { error: jobErr } = await supabase
    .from('he_jobs')
    .insert({
      project_id: projectId,
      stage: 'base_collect',
      status: 'pending',
      payload: { base_id: base.id, ...jobPayload },
    });
  if (jobErr) {
    // Компенсация fail-closed. Новая база без джобы воркера — осиротевшая
    // 'collecting'-строка: failJob воркера валит базу только по своей джобе, а
    // джобы нет. Она занимает и дедуп 1 выше, и partial unique index
    // he_bases_one_collecting_per_vertical — ручная кнопка, автопилот и ночной
    // refill вертикали отвечают «уже собирается», пока её не подхватит ремонт
    // сирот (только market='us', не раньше HE_COLLECTING_ORPHAN_GRACE_MS).
    // Раз здесь уже известно, что джоба не легла, сирота не создаётся вовсе.
    // Решение скопировано из V2
    // (verticalEngineV2/baseCollectEnqueue: перечитать, иначе база в failed).
    //
    // Сначала перечитываем активные base_collect-джобы: ответ мог не доехать
    // при состоявшейся вставке, и тогда сборка на самом деле идёт.
    const { data: rescueJobs, error: rescueErr } = await supabase
      .from('he_jobs')
      .select('id, payload')
      .eq('project_id', projectId)
      .eq('stage', 'base_collect')
      .in('status', ['pending', 'running']);
    if (rescueErr) {
      // Сбой САМОГО спасательного чтения — отдельный исход, а не «джобы нет».
      // Легла вставка или нет — неизвестно, и писать по «неизвестно»
      // терминальный статус нельзя: если легла, воркер придёт на живую сборку,
      // а стадия умрёт в своём start-guard («сборка уже завершена») из-за
      // чужой ошибки — оплаченный прогон превратится в базу без строк. Поэтому
      // статус базы не трогаем и называем состояние в ответе. Цена: если
      // вставка всё же не легла, 'collecting'-строка держит дедуп вертикали,
      // пока её не подхватит ремонт сирот (repairHeOrphanCollectingBase ниже) —
      // на первой постановке этой вертикали после HE_COLLECTING_ORPHAN_GRACE_MS
      // и только у проекта market='us'; у RU-проекта она висит, как и раньше.
      return {
        ok: false,
        message:
          `${jobErr.message}; he_jobs rescue read: ${rescueErr.message} ` +
          `(he_bases ${base.id} left as-is: enqueue outcome unknown)`,
      };
    }
    const alive = (rescueJobs ?? []).some(
      (j) => (j.payload as { base_id?: unknown } | null)?.base_id === base.id,
    );
    if (alive) return { ok: true, created: true, base: base as Record<string, unknown> };
    // CAS по 'collecting': если базу уже увели (cancel, параллельный ремонт) —
    // её статус не перетираем.
    const { error: cleanupErr } = await supabase
      .from('he_bases')
      .update({
        status: 'failed',
        error: `he_jobs base_collect enqueue: ${jobErr.message}`.slice(0, 500),
        updated_at: new Date().toISOString(),
      })
      .eq('id', base.id)
      .eq('status', 'collecting');
    if (cleanupErr) {
      return {
        ok: false,
        message: `${jobErr.message}; he_bases orphan cleanup: ${cleanupErr.message}`,
      };
    }
    return { ok: false, message: jobErr.message };
  }

  return { ok: true, created: true, base: base as Record<string, unknown> };
}

/* ───────────── Ремонт осиротевшей 'collecting'-базы ───────────── */

/**
 * Сколько 'collecting'-база должна простоять НЕТРОНУТОЙ, прежде чем её можно
 * считать осиротевшей.
 *
 * Постановка выше пишет базу и её джобу ДВУМЯ запросами (транзакции у PostgREST
 * нет). Между ними база уже 'collecting', а джобы ещё нет, и параллельный вызов
 * (двойной клик «Collect base», «Start outreach» поверх дочейна воркера) видит
 * ровно то же, что видел бы у настоящей сироты. Окно между двумя запросами —
 * миллисекунды; десять минут — с запасом на любой ответ, который вообще
 * доходит. Часы — he_bases.updated_at: строку базы, по которой не было ни одной
 * джобы, не пишет никто (стадия пишет collect_info только под своей джобой),
 * значит updated_at и есть момент постановки — или момент захвата ремонтом
 * (см. шаг 6 repairHeOrphanCollectingBase). Тот же размер и те же часы, что у
 * 'analyzing'-сироты (ANALYZING_ORPHAN_GRACE_MS в autopilotNext.ts).
 */
export const HE_COLLECTING_ORPHAN_GRACE_MS = 10 * 60 * 1000;

/**
 * Текст he_bases.error у базы, остановленной отменой клиента. Тот же, что
 * пишут клиентский роут отмены (CANCELLED_BY_USER), долив и воркер
 * (HE_BASE_CANCELLED_ERROR_EN): кабинет сверяет его полным совпадением, а
 * he_transient_collect_error (автоподъём) такой текст не поднимает.
 */
const HE_BASE_CANCELLED_BY_USER = 'Cancelled by user';

/**
 * Живая ли 'collecting'-база по уже прочитанному снапшоту — тот же вопрос, что
 * задаёт ремонт, но без чтений (для реконсилера автопилота, который решает,
 * вести ли вертикаль к постановке): по базе есть активная джоба любой стадии
 * (liveBaseIds — liveBaseIdsFromJobs) ИЛИ её строку писали в пределах
 * HE_COLLECTING_ORPHAN_GRACE_MS. Нечитаемый updated_at — «жива»: на догадке
 * сироту не объявляем. Решает всё равно ремонт — он перечитывает джобы сам.
 */
export function isHeCollectingBaseLive(
  base: { id: string; updated_at?: unknown },
  liveBaseIds: ReadonlySet<string>,
  now: number = Date.now(),
): boolean {
  if (liveBaseIds.has(base.id)) return true;
  const updatedAt = typeof base.updated_at === 'string' ? Date.parse(base.updated_at) : NaN;
  if (Number.isNaN(updatedAt)) return true;
  return now - updatedAt <= HE_COLLECTING_ORPHAN_GRACE_MS;
}

/**
 * payload пропавшей джобы — ТОЛЬКО из снапшота постановки в collect_info, ровно
 * той формы, что пишет enqueueHeBaseCollect выше: refill → {limit, refill};
 * выбранные гипотезы → {limit, hypothesis_ids}; иначе {limit}. Вход того, кто
 * чинит, сюда не подмешивается: он мог прийти с другим лимитом или другим
 * режимом, а база собирает то, что было заказано при её создании.
 *
 * null — снапшот не читается (нет целого положительного limit, или
 * hypothesis_ids есть, но это не непустой массив непустых строк). Угадывать
 * нельзя: без limit стадия взяла бы свой дефолт 10 000 строк (totalRowsCap),
 * то есть впятеро больше лимита кабинета по умолчанию, а без выбора гипотез —
 * собирала бы по всем принятым вместо выбранных.
 */
export function heOrphanCollectPayload(info: Record<string, unknown>): Record<string, unknown> | null {
  const limit = info.limit;
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit <= 0) return null;
  if (info.refill === true) return { limit, refill: true };
  if (!('hypothesis_ids' in info)) return { limit };
  const ids = info.hypothesis_ids;
  if (!Array.isArray(ids) || ids.length === 0 || ids.some((v) => typeof v !== 'string' || v.length === 0)) {
    return null;
  }
  return { limit, hypothesis_ids: ids as string[] };
}

export type HeOrphanCollectRepair =
  /** Не сирота: по базе есть активная base_collect-джоба, или её строку писали в пределах окна. */
  | { outcome: 'live' }
  /** Базе поставлена пропавшая джоба base_collect (payload — heOrphanCollectPayload). */
  | { outcome: 'repaired' }
  /** База создана не позже отметки отмены проекта и закрыта так, как её закрыл бы роут отмены. */
  | { outcome: 'closed_cancelled' }
  /** Сирота, но этот вызов её не трогает (почему — в докблоке функции); база как была. */
  | { outcome: 'left' }
  /** Захват выигран, а джоба не встала; message — для лога вызывающего. */
  | { outcome: 'failed'; message: string };

/**
 * Ремонт осиротевшей 'collecting'-базы — ЕДИНСТВЕННОЕ место, где он делается.
 * Зовёт его только дедуп 1 enqueueHeBaseCollect; значит чинят ровно те пути,
 * что ставят сборку, и каждый — после СВОИХ ворот (потолок расхода, флаг
 * автопилота, пауза и предполёт долива): клиентская кнопка «Collect base»
 * (api/client/eng/verticals/[id]/collect), staff-кнопка
 * (api/tools/hypothesis-engine/verticals/[id]/collect — действует только на
 * проекты 'us'), дочейн автопилота после готовой цепочки (autopilotNext,
 * afterChainDone), реконсилер автопилота — кнопка «Start outreach» и ночной
 * проход (autopilotReconcile), ночной долив (autoPipeline, только refill-сирот).
 *
 * СОСТОЯНИЯ базы, которая пришла сюда ('collecting', source='auto'), и что с
 * каждым:
 *  0. updated_at в пределах HE_COLLECTING_ORPHAN_GRACE_MS (или нечитаем) →
 *     'live' без единого чтения: это может быть постановка, чья джоба ещё в
 *     пути.
 *  1. Проект не 'us', отметка отмены не читается (нет колонки — миграция
 *     20261009_0002 не применена; сбой чтения) → 'left'. RU-инструмент живёт как
 *     раньше; без отметки нельзя доказать, что отмена не выиграла, — ремонт
 *     ждёт миграцию.
 *  2. По базе есть pending/running base_collect → 'live'.
 *  3. По базе была ЛЮБАЯ завершённая base_collect ('done', 'failed',
 *     'cancelled') → 'left'. Эту базу ведёт кто-то другой: финальный фейл —
 *     ремонт воркера (repairBaseAfterCollectFinalFail, у долива — с решением о
 *     компаниях), отмена — роут отмены, а повтор оплаченной стадии ночью без
 *     человека — ровно то, чего этот контур не делает. Сирота здесь — только
 *     база, по которой джобы НЕ БЫЛО НИКОГДА (вставка джобы при постановке не
 *     легла, а спасательное чтение тоже упало — хвост enqueueHeBaseCollect).
 *     he_jobs не удаляются (кроме каскада вместе с проектом), так что «ни одной
 *     строки» значит именно это.
 *  4. Проект отменён НЕ РАНЬШЕ создания базы (created_at <= cancelled_at;
 *     сравнение в миллисекундах, равенство — в пользу отмены) → база закрывается
 *     'failed' «Cancelled by user» — та же запись, что сделал бы роут отмены,
 *     чей апдейт баз по ней не лёг, → 'closed_cancelled'. Платной работы у неё
 *     не было (шаг 3), снимать нечего. Отмена выигрывает: такую базу не
 *     ремонтирует никто.
 *  5. Режим базы не совпал с режимом вызывающего → 'left': refill-сироту чинит
 *     только ночной долив (его ворота — пауза, предполёт ёмкости, потолок,
 *     письма — проверены именно для этой ночи), обычную — только постановки
 *     обычной сборки. У refill-сироты вдобавок кампания снапшота обязана
 *     совпасть с кампанией этой ночи: ворота долива проверены для неё.
 *     Расхождение collect_info.refill и имени «auto-refill: …» — тоже 'left'.
 *  6. Снапшот payload не читается (heOrphanCollectPayload → null) → 'left'.
 *  7. ЗАХВАТ: CAS по (id, status='collecting', updated_at = прочитанному) с
 *     записью updated_at = сейчас. Проиграли → 'left'.
 *  8. Вставка джобы: легла → 'repaired'; 23505 (если когда-нибудь появится
 *     уникальный индекс активной base_collect на базу — сегодня его нет,
 *     20261008_0001 покрывает только template и base_analyze) → 'live'; иначе
 *     спасательное чтение: джоба нашлась → 'repaired', чтение упало →
 *     'failed' без записи базы («неизвестно» ≠ «джобы нет»), джобы нет → база
 *     'failed' с причиной `he_jobs base_collect re-enqueue: …` (CAS по
 *     захвату) и 'failed'. Кабинет такой текст не печатает: проекция
 *     сворачивает he_bases.error в код ('internal'), а автоподъём его не
 *     поднимает (не временный отказ провайдера, и джобы у базы нет).
 *
 * ЧТО ЭТО СТОИТ. Сирота шага 3 не исполнялась ни разу, и collect_info у неё —
 * только снапшот постановки. Ремонт покупает ту сборку, что была заказана и не
 * началась, — первый и единственный раз. Если бы чекпойнты в collect_info всё
 * же были, стадия продолжила бы с них: план (`if (!info.plan)`), задачи
 * (DISPATCH берёт только 'pending', WAIT — только 'dispatched'), мемо
 * релевант-гейта (`relevance_gate.ran`), зарезервированный id джобы
 * конструктора (`construct.bc_job_id`, вставка upsert'ом по нему) — то есть
 * только неоплаченный остаток.
 *
 * ПОЧЕМУ ЖИВАЯ ДЖОБА НЕ ЗАДВАИВАЕТСЯ. Джобу base_collect для 'collecting'-базы
 * ставят только (а) хвост постановки этой же базы и (б) этот ремонт;
 * автоподъём (he_auto_resume_transient_bases) берёт только 'failed'-базы с
 * упавшей джобой и сам переводит их в 'collecting' вместе с вставкой джобы в
 * одной транзакции, а воркер новых строк сборки не вставляет (возврат в
 * очередь двигает ту же строку). Порядок ремонта: прочитать базу → прочитать
 * все джобы её сборки → захватить CAS по прочитанному updated_at → вставить.
 *  - Второй ремонт, прочитавший базу ДО нашего захвата, проигрывает свой CAS
 *    (updated_at уже наш). Прочитавший ПОСЛЕ — видит updated_at в пределах окна
 *    и отвечает 'live' (шаг 0), а если окно уже прошло — его чтение джоб видит
 *    нашу вставку, или база уже 'failed' компенсацией.
 *  - Хвост постановки (а) идёт следующим запросом за вставкой базы, а ремонт
 *    трогает только базу старше окна. Задвоение возможно лишь если запрос
 *    вставки джобы дошёл до БД позже, чем через HE_COLLECTING_ORPHAN_GRACE_MS
 *    после вставки базы; и даже тогда воркер исполняет строки по одной, а
 *    стадия идёт по чекпойнтам collect_info, и вторая строка не покупает
 *    оплаченное первой.
 *
 * Не бросает.
 */
export async function repairHeOrphanCollectingBase(
  supabase: SupabaseClient,
  input: {
    projectId: string;
    /** Строка he_bases из дедупа 1: id, status, collect_info, filename, created_at, updated_at. */
    base: Record<string, unknown>;
    /** Кампания ночного долива, если ставит он; null — постановка обычной сборки. */
    refillCampaignId: string | null;
  },
): Promise<HeOrphanCollectRepair> {
  const { projectId, base, refillCampaignId } = input;
  const left: HeOrphanCollectRepair = { outcome: 'left' };
  const baseId = typeof base.id === 'string' ? base.id : '';
  try {
    const seenUpdatedAt = typeof base.updated_at === 'string' ? base.updated_at : '';
    if (!baseId || base.status !== 'collecting') return left;
    // 0. Окно постановки.
    if (isHeCollectingBaseLive({ id: baseId, updated_at: seenUpdatedAt }, new Set())) return { outcome: 'live' };

    // 1. Рынок и отметка отмены — первым чтением: RU-проект дальше не читается.
    const marker = await readHeProjectCancelMarker(supabase, projectId);
    if (marker.kind !== 'ok' || normalizeHeMarket(marker.market) !== 'us') return left;

    // 2–3. Вся история сборки этой базы — ПОСЛЕ чтения базы (см. докблок).
    const { data: jobs, error: jobsErr } = await supabase
      .from('he_jobs')
      .select('status')
      .eq('project_id', projectId)
      .eq('stage', 'base_collect')
      .eq('payload->>base_id', baseId);
    if (jobsErr) return left;
    const statuses = (jobs ?? []).map((j) => (j as { status?: unknown }).status);
    if (statuses.some((s) => s === 'pending' || s === 'running')) return { outcome: 'live' };
    if (statuses.length > 0) return left;

    // 4. Отмена выигрывает.
    if (marker.cancelledAt) {
      const cancelledMs = Date.parse(marker.cancelledAt);
      const createdMs = typeof base.created_at === 'string' ? Date.parse(base.created_at) : NaN;
      if (Number.isFinite(cancelledMs) && (!Number.isFinite(createdMs) || createdMs <= cancelledMs)) {
        const { data: closed, error: closeErr } = await supabase
          .from('he_bases')
          .update({ status: 'failed', error: HE_BASE_CANCELLED_BY_USER, updated_at: new Date().toISOString() })
          .eq('id', baseId)
          .eq('status', 'collecting')
          .eq('source', 'auto')
          .eq('updated_at', seenUpdatedAt)
          .select('id');
        return !closeErr && (closed ?? []).length > 0 ? { outcome: 'closed_cancelled' } : left;
      }
    }

    // 5. Режим базы и режим вызывающего.
    const rawInfo = base.collect_info;
    const info: Record<string, unknown> =
      rawInfo && typeof rawInfo === 'object' && !Array.isArray(rawInfo) ? (rawInfo as Record<string, unknown>) : {};
    const baseIsRefill = info.refill === true;
    const namedRefill = typeof base.filename === 'string' && base.filename.startsWith('auto-refill');
    if (baseIsRefill !== namedRefill) return left;
    if (baseIsRefill !== (refillCampaignId !== null)) return left;
    if (baseIsRefill && info.campaign_id !== refillCampaignId) return left;

    // 6. payload — из снапшота.
    const payload = heOrphanCollectPayload(info);
    if (!payload) return left;

    // 7. Захват.
    const claimAt = new Date().toISOString();
    const { data: claimed, error: claimErr } = await supabase
      .from('he_bases')
      .update({ updated_at: claimAt })
      .eq('id', baseId)
      .eq('status', 'collecting')
      .eq('source', 'auto')
      .eq('updated_at', seenUpdatedAt)
      .select('id');
    if (claimErr || (claimed ?? []).length === 0) return left;

    // 8. Пропавшая джоба.
    const { error: jobErr } = await supabase.from('he_jobs').insert({
      project_id: projectId,
      stage: 'base_collect',
      status: 'pending',
      payload: { base_id: baseId, ...payload },
    });
    if (!jobErr) return { outcome: 'repaired' };
    if (jobErr.code === '23505') return { outcome: 'live' };
    const { data: rescue, error: rescueErr } = await supabase
      .from('he_jobs')
      .select('id')
      .eq('project_id', projectId)
      .eq('stage', 'base_collect')
      .in('status', ['pending', 'running'])
      .eq('payload->>base_id', baseId);
    if (rescueErr) {
      return {
        outcome: 'failed',
        message:
          `${jobErr.message}; he_jobs rescue read: ${rescueErr.message} ` +
          `(he_bases ${baseId} left as-is: re-enqueue outcome unknown)`,
      };
    }
    if ((rescue ?? []).length > 0) return { outcome: 'repaired' };
    const { error: cleanupErr } = await supabase
      .from('he_bases')
      .update({
        status: 'failed',
        error: `he_jobs base_collect re-enqueue: ${jobErr.message}`.slice(0, 500),
        updated_at: new Date().toISOString(),
      })
      .eq('id', baseId)
      .eq('status', 'collecting')
      .eq('updated_at', claimAt);
    return {
      outcome: 'failed',
      message: cleanupErr ? `${jobErr.message}; he_bases orphan cleanup: ${cleanupErr.message}` : jobErr.message,
    };
  } catch (e) {
    // Бросок (сеть, сбой клиента): исход неизвестен. Каждая запись этого
    // вызова — CAS по 'collecting', поэтому, какая бы из них ни легла, база
    // либо получила джобу, либо закрыта, либо осталась сиротой — и тогда через
    // окно её подхватит следующая постановка вертикали.
    return {
      outcome: 'failed',
      message: `orphan repair of he_bases ${baseId} interrupted: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
