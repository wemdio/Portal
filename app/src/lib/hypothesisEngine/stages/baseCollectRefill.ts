/**
 * Refill-ветка стадии base_collect (ENG auto-pipeline Движка вертикалей):
 * ежедневный добор лидов в УЖЕ запущенную кампанию us-проекта.
 *
 * Срабатывает только при payload.refill джобы (такую джобу ставит крон
 * app/worker/heAutoPipelineCron.ts через enqueueHeBaseCollect с refill-полями).
 * Отличия от обычного пути base_collect:
 *   - base_analyze и template НЕ ставятся — собранные строки не идут в мастер,
 *     а мапятся в лиды и доливаются в существующую кампанию Instantly;
 *   - кампания: collect_info.campaign_id (снапшот на постановке), фолбэк —
 *     последний по дате запуска шаблон вертикали с launch_info; маппинг
 *     колонок → переменные — operator_mapping того же шаблона (как при
 *     первичном запуске, mapBaseRowsToLeads из launchHandoff);
 *   - лиды: только строки с email И ДОПУЩЕННЫМ вердиктом валидации. Список
 *     допущенных вердиктов и их ранжирование здесь НЕ дублируются — вердикт
 *     считает heLaunchEmailVerdict (launchHandoff.ts), тот же, что у ручного
 *     запуска: два контура обязаны допускать ровно одно и то же, иначе
 *     ночной долив разойдётся с проверенным руками запуском;
 *   - вердикт ОБЯЗАТЕЛЕН (fail-closed). Строка без вердикта («Email Статус»
 *     пуст или колонки нет вовсе: конструктор упал после split_emails, не
 *     дойдя до validate_emails, и его частичная сетка импортирована) в
 *     кампанию НЕ идёт. Раньше такая строка проходила как проверенная, и
 *     непроверенные адреса уезжали в живую рассылку без человека рядом —
 *     баунсы бьют по доменам ящиков клиента, обратной связи по ним у движка
 *     нет. Сколько строк так снято — stats.unverified, отдельно от
 *     отклонённых;
 *   - кап daily_leads_cap конфига — на ПРОЕКТ в сутки (UTC): уже долитое
 *     сегодня другими refill'ами вычитается;
 *   - кап считает СТРОКИ (после split_emails строка = один адрес = один лид), а
 *     сборка считает КОМПАНИИ, и одна компания даёт до max_emails_per_company
 *     строк. Разные единицы у бюджета и у сборки — это оплаченный краул сайта и
 *     SMTP-проба на каждый адрес, который кап потом выбросит, причём компания
 *     остаётся выжженной (база уходит в 'analyzed' и её компании исключены из
 *     будущих сборок проекта). Поэтому размер сборки обязан считаться ИЗ капа:
 *     heRefillCompanyTarget / resolveHeRefillCollectCompanies ниже, разошедшиеся
 *     единицы видны в stats.company_target против stats.company_limit;
 *   - blocklist владельца пресета и чанкование — внутри
 *     appendLeadsToClientCampaign (тот же путь, что у RU auto-pipeline), но с
 *     entitlementMode='managed_contract': объём режет серверный daily_leads_cap,
 *     а не self-serve тариф клиента (см. комментарий у вызова);
 *   - терминальный статус базы — 'analyzed' (не 'analyzing': анализа не
 *     будет), итог — в collect_info.refill_result и he_auto_pipeline_runs;
 *     ИСКЛЮЧЕНИЕ: долив упал, не отдав провайдеру ни одной строки — база
 *     уходит в 'failed', иначе её компании выжигаются навсегда (см.
 *     refillLeadsReachedProvider и loadOtherBaseExclusionKeys). Возврат даётся
 *     только разовому отказу: со второго подряд (REFILL_RELEASE_FAIL_STREAK_LIMIT,
 *     refillFailStreak) база снова 'analyzed' — иначе ночной крон собирал бы
 *     один и тот же срез каждую ночь;
 *   - пустой harvest — ШТАТНЫЙ исход добора («новых компаний нет»): база
 *     НЕ failed, прогон 'no_new', джоба завершается успешно;
 *   - строки собрались, но НИ У ОДНОЙ нет вердикта валидации — это не пустой
 *     рынок, а недоработавшая валидация: прогон 'failed' с причиной, а не
 *     'no_new'. Иначе оплаченный срез выжигался бы под отчётом «новых
 *     компаний нет», и ночь за ночью было бы не видно, что долив уже неделю
 *     не отправляет ничего. Компании при этом возвращаются в пул по общему
 *     правилу отказа (ниже) — завтрашняя сборка проверит их заново;
 *   - ошибка долива (Instantly/пресет/лимиты воркспейса) — НЕ валит джобу:
 *     собранная база сохраняется, прогон 'failed' с текстом ошибки, а
 *     завтрашний тик крона поставит новую refill-сборку. Повторный прогон
 *     ЭТОЙ базы невозможен — стадия работает только из статуса 'collecting'.
 */

import { AppendLeadsPartialError, appendLeadsToClientCampaign } from '@/lib/clientLaunch/appendLeads';
import { filterBlockedLeads, getBlockedEmailSet } from '@/lib/clientBlocklist/blockedContacts';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import {
  HE_MAX_EMAILS_PER_COMPANY_DEFAULT,
  normalizeHeMaxEmailsPerCompany,
} from '../baseCollectEnqueue';
import { heLaunchEmailVerdict, mapBaseRowsToLeads, parseLaunchInfo } from '../launchHandoff';
import type { HeJob, HeOperatorMapping } from '../types';
import { stageLog, type HeStageContext, type HeStageResult, type HeUsage } from './shared';
import {
  SAMPLE_ROWS,
  type HeCollectInfo,
  type HeUnifiedRow,
} from './baseCollect';

/** Дефолт дневного капа лидов на проект — зеркало DEFAULT миграции 20260804_0005. */
export const HE_AUTO_DEFAULT_DAILY_LEADS_CAP = 50;

/**
 * Сколько ДОПУЩЕННЫХ адресов ждём с одной собранной компании.
 *
 * Единственная оценка в расчёте размера сборки (heRefillCompanyTarget) и
 * единственное место, где её править. Меряется по факту любого прогона долива:
 * stats.valid / stats.companies_total сборки.
 *
 * Почему не max_emails_per_company: потолок «до N адресов на компанию»
 * достижим только у компании с живым сайтом и несколькими рабочими адресами, а
 * в среднем по срезу часть компаний не даёт ни одного допущенного адреса (сайта
 * нет; на страницах адресов нет; единственный найденный — catch_all, который
 * слать нельзя). Ночной долив не запускался в production ни разу, поэтому любое
 * значение здесь — оценка, и выбрана она в сторону НЕДОбора: недобор до капа
 * виден в той же воронке (capped=0 при daily_remaining>0) и лечится этой
 * константой, а лишние компании — это уже оплаченные краул и SMTP-пробы плюс
 * выжженные из будущих сборок компании, назад их не вернуть.
 */
export const HE_REFILL_ACCEPTED_PER_COMPANY = 2;

/**
 * Минимум компаний в refill-сборке — зеркало MIN_ROWS_LIMIT стадии
 * (stages/baseCollect.ts): totalRowsCap всё равно поднимает любой меньший limit
 * до 100, и просить меньше значило бы писать в collect_info число, которого
 * стадия не придерживается.
 */
const HE_REFILL_MIN_COMPANIES = 100;

/**
 * Сколько КОМПАНИЙ собирать под дневной кап лидов, который считает СТРОКИ.
 *
 * Перевод единиц — через HE_REFILL_ACCEPTED_PER_COMPANY, но не больше
 * contactCap: при «до 1 адреса на компанию» компания даёт максимум один лид, и
 * компаний нужно столько же, сколько лидов.
 *
 * Потолка здесь НЕТ — его ставит вызывающий своим лимитом
 * (resolveHeRefillCollectCompanies берёт min): расчёт может только УМЕНЬШИТЬ
 * сборку против уже запланированной, но никогда не увеличить. Рост сборки —
 * это новые деньги и решение владельца, а не функции.
 */
export function heRefillCompanyTarget(input: { dailyLeadsCap: number; contactCap: number }): number {
  const perCompany = Math.max(1, Math.min(input.contactCap, HE_REFILL_ACCEPTED_PER_COMPANY));
  const cap = Number.isFinite(input.dailyLeadsCap) ? Math.max(0, input.dailyLeadsCap) : 0;
  return Math.max(HE_REFILL_MIN_COMPANIES, Math.ceil(cap / perCompany));
}

/**
 * Лимит компаний для refill-сборки: min(уже запланированный лимит, расчёт из
 * дневного капа проекта). Вызывать ДО сбора — за краул и SMTP-пробы платит
 * сборка, а не эта ветка (см. шапку файла).
 *
 * Best-effort как и сам loadRefillConfig: кап не прочитался или конфига нет —
 * берётся дефолт движка, тот же, по которому долив ниже будет резать объём,
 * поэтому расчёт и кап остаются в одних единицах даже на транзиентной ошибке
 * чтения. Ошибка в меньшую сторону: недобор — не потраченные деньги.
 */
export async function resolveHeRefillCollectCompanies(
  ctx: HeStageContext,
  input: { projectId: string; payloadLimit: number; contactCap: number },
): Promise<number> {
  const config = await loadRefillConfig(ctx, input.projectId);
  const dailyLeadsCap = config?.dailyLeadsCap ?? HE_AUTO_DEFAULT_DAILY_LEADS_CAP;
  return Math.min(
    input.payloadLimit,
    heRefillCompanyTarget({ dailyLeadsCap, contactCap: input.contactCap }),
  );
}

/**
 * Сколько подряд упавших доливов вертикали ещё возвращают её компании в пул.
 *
 * Возврат компаний (база 'failed' → HARVEST снова видит их как новые) нужен
 * ровно для разового отказа: собрали, письмо не ушло не по вине компаний,
 * незачем выжигать срез. Но крон ставит refill вертикали КАЖДУЮ НОЧЬ, и при
 * устойчивой причине (пропавший пресет, снятая кампания, исчерпанный лимит
 * воркспейса, сменившийся Instantly-аккаунт) возврат
 * превращается в цикл: те же компании собираются заново, падают на том же
 * месте и снова возвращаются — каждую ночь за деньги сбора. Поэтому возврат
 * даётся только первому отказу; со второго подряд срез остаётся исключённым,
 * и цикл по одному и тому же набору прекращается. Причина решения — в
 * refill_result (companies_released/fail_streak).
 */
const REFILL_RELEASE_FAIL_STREAK_LIMIT = 1;

/** Статистика воронки долива (he_auto_pipeline_runs.stats + refill_result). */
export interface HeRefillStats {
  /** Строк собрано сборкой (после импорта конструктора). */
  collected: number;
  /** Строк с непустым email. */
  with_email: number;
  /** Строк с email и допущенным вердиктом валидации — кандидаты в лиды. */
  valid: number;
  /**
   * Строк с email, снятых из-за ОТСУТСТВИЯ вердикта. Отдельным счётчиком от
   * отклонённых (with_email - valid - unverified): «адрес не проверен» лечится
   * пересборкой базы, «адрес отклонён» — ничем, и в отчёте это разные строки.
   */
  unverified: number;
  /** Принято Instantly. */
  appended: number;
  /** Отрезано blocklist'ом владельца пресета. */
  skipped_blocklist: number;
  /** Отсеяно Instantly при загрузке (дубли кампании и пр.). */
  skipped_instantly: number;
  /** Не влезло в дневной кап daily_leads_cap (уйдёт в отчёт, не в кампанию). */
  capped: number;
  /**
   * Почему строки не ушли, когда capped > 0. Одно значение, но пишется явно:
   * «отрезано» без причины читается как брак адресов, а это бюджет проекта.
   */
  capped_reason?: 'daily_leads_cap';
  /** Дневной кап лидов проекта (СТРОК), действовавший в прогоне. */
  daily_cap: number;
  /**
   * Сколько от капа осталось к моменту долива (кап минус долитое сегодня).
   * Нет ключа — долив упал до расчёта бюджета: остаток не измерен, а нулём его
   * писать нельзя, это прочиталось бы как «бюджет исчерпан».
   */
  daily_remaining?: number;
  /**
   * Компаний, под которые кап просит собирать (heRefillCompanyTarget), и лимит
   * компаний, с которым сборка реально шла (collect_info.limit; null — лимита в
   * снапшоте нет). company_limit > company_target — постановка сборки ещё
   * считает объём в строках: разница компаний уже оплачена краулом и пробами, а
   * кап её строки выбросит. Оба числа в воронке затем, чтобы первый ночной счёт
   * объяснялся из журнала, а не из догадок.
   */
  company_target: number;
  company_limit: number | null;
}

/** Итог refill-ветки: он же collect_info.refill_result и (по полям) runs-запись. */
export interface HeRefillResult {
  status: 'appended' | 'no_new' | 'failed';
  campaign_id?: string;
  stats?: HeRefillStats;
  error?: string;
  /**
   * Только для status='failed': успел ли долив отдать хотя бы одну строку
   * провайдеру. От этого зависит терминальный статус базы (см.
   * runHeRefillAppend), поэтому признак сохраняется в collect_info — иначе
   * решение «выжигать компании или нет» нельзя перепроверить по факту.
   */
  delivery_attempted?: boolean;
  /**
   * Только для status='failed': вернулись ли компании базы в пул сборки
   * (status='failed' у базы) или остались исключёнными ('analyzed'). false при
   * доставленных строках и при серии отказов
   * (REFILL_RELEASE_FAIL_STREAK_LIMIT) — по этому полю видно, почему срез
   * больше не поднимается ночными прогонами.
   */
  companies_released?: boolean;
  /**
   * Сколько refill-прогонов вертикали упало подряд ДО этого (0 — первый отказ).
   * Считается до предела, нужного решению (REFILL_RELEASE_FAIL_STREAK_LIMIT + 1),
   * а не по всей истории — см. refillFailStreak.
   */
  fail_streak?: number;
  completed_at: string;
}

interface RefillConfigRow {
  id: string;
  dailyLeadsCap: number;
}

/** Начало текущих UTC-суток — дневной бюджет daily_leads_cap считается по ним. */
function utcDayStart(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

/**
 * Конфиг auto-pipeline проекта. Best-effort: таблицы миграции может ещё не
 * быть на окружении (воркер выкатили раньше миграции) — тогда долив идёт с
 * дефолтным капом, а runs-запись пишется без config_id.
 */
async function loadRefillConfig(ctx: HeStageContext, projectId: string): Promise<RefillConfigRow | null> {
  try {
    const { data, error } = await ctx.supabase
      .from('he_auto_pipeline_configs')
      .select('id, daily_leads_cap')
      .eq('project_id', projectId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    const row = data as { id?: unknown; daily_leads_cap?: unknown };
    const cap =
      typeof row.daily_leads_cap === 'number' && Number.isFinite(row.daily_leads_cap)
        ? row.daily_leads_cap
        : HE_AUTO_DEFAULT_DAILY_LEADS_CAP;
    return { id: String(row.id), dailyLeadsCap: cap };
  } catch (e) {
    stageLog(
      ctx,
      `[base_collect] refill: he_auto_pipeline_configs read: ${e instanceof Error ? e.message : String(e)} — кап по умолчанию`,
    );
    return null;
  }
}

/**
 * Финал прогона в he_auto_pipeline_runs: крон пишет строку 'collecting' при
 * постановке — обновляем её по base_id; не нашли (refill поставлен вручную) —
 * вставляем финальную строку целиком. Best-effort: журнал — аудит, падение
 * записи не должно валить стадию после уже случившегося долива.
 */
async function writeRefillRun(
  ctx: HeStageContext,
  write: {
    configId: string | null;
    projectId: string;
    verticalId: string;
    baseId: string;
    result: HeRefillResult;
  },
): Promise<void> {
  const patch = {
    status: write.result.status,
    stats: (write.result.stats ?? {}) as Record<string, unknown>,
    error: write.result.error ?? null,
    completed_at: write.result.completed_at,
  };
  try {
    const { data: existing, error: findErr } = await ctx.supabase
      .from('he_auto_pipeline_runs')
      .select('id')
      .eq('base_id', write.baseId)
      .eq('status', 'collecting')
      .maybeSingle();
    if (findErr) throw new Error(findErr.message);
    if (existing) {
      const { error } = await ctx.supabase
        .from('he_auto_pipeline_runs')
        .update(patch)
        .eq('id', (existing as { id: string }).id);
      if (error) throw new Error(error.message);
    } else {
      const { error } = await ctx.supabase.from('he_auto_pipeline_runs').insert({
        config_id: write.configId,
        project_id: write.projectId,
        vertical_id: write.verticalId,
        base_id: write.baseId,
        ...patch,
      });
      if (error) throw new Error(error.message);
    }
  } catch (e) {
    stageLog(
      ctx,
      `[base_collect] refill: запись he_auto_pipeline_runs не удалась: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * Терминальный апдейт refill-базы: строки как в обычном пути, статус —
 * 'analyzed' при доливе и 'failed' у недоставленного разового отказа, компании
 * которого возвращаются в пул (см. runHeRefillAppend).
 * Строки сохраняются в любом случае: отчёт и разбор причины идут по ним.
 */
async function persistRefillBase(
  ctx: HeStageContext,
  baseId: string,
  args: {
    columns: string[];
    rows: HeUnifiedRow[];
    info: HeCollectInfo;
    stats: HeCollectInfo['stats'];
    refillResult: HeRefillResult;
    status: 'analyzed' | 'failed';
    /** Текст в he_bases.error (кабинет сворачивает его в машинный код). */
    error?: string;
  },
): Promise<void> {
  const { error } = await ctx.supabase
    .from('he_bases')
    .update({
      columns: args.columns,
      sample_rows: args.rows.slice(0, SAMPLE_ROWS),
      data: args.rows,
      row_count: args.rows.length,
      status: args.status,
      ...(args.error === undefined ? {} : { error: args.error }),
      collect_info: { ...args.info, stats: args.stats, refill_result: args.refillResult },
      updated_at: new Date().toISOString(),
    })
    .eq('id', baseId);
  if (error) throw new Error(`he_bases refill update: ${error.message}`);
}

/**
 * Дошла ли до провайдера хотя бы одна строка упавшего долива.
 *
 * Зачем: loadOtherBaseExclusionKeys (stages/baseCollect.ts) исключает из
 * будущих сборок проекта компании всех баз, КРОМЕ 'failed'. Пока упавший
 * долив сохранялся в 'analyzed', его компании выжигались навсегда: сбор
 * оплачен, письма не ушли, второй раз эти компании не соберутся. Отдавать их
 * обратно в сборку можно только когда Instantly точно ничего не получил —
 * повторное письмо уже написанному лиду хуже потерянного лида.
 *
 * AppendLeadsPartialError несёт снимок результата; attemptedIndexes
 * заполняется в onRequestAttempt ПЕРЕД HTTP-запросом, поэтому непустой
 * список означает «запрос мог долететь, даже если ответ потерян». Остальные
 * отказы долива (нет кампании или пресета, сменившийся воркспейс, исчерпанный
 * лимит контактов, blocklist) бросаются до первого запроса в Instantly.
 *
 * Отсюда инвариант: доставленная база НИКОГДА не уходит в 'failed' решением
 * этой стадии, поэтому в released-базе не может быть компании, которой уже
 * писали (её собственный сбор исключал все не-'failed' базы проекта, а
 * доставленные базы остаются 'analyzed'). Единственный путь, где база с
 * доставкой всё же может стать 'failed', — ремонт воркера после ФИНАЛЬНОГО
 * фейла base_collect (repairBaseAfterCollectFinalFail, CAS по 'collecting'):
 * он сработает, если упадёт сама запись базы уже ПОСЛЕ долива. Второе письмо
 * при этом всё равно не уйдёт: долив идёт со skipIfInCampaign=true (Instantly
 * отсеет лида, который уже в кампании), а start-guard стадии
 * (`status !== 'collecting'` → throw) не даёт повторно собрать базу с
 * терминальным статусом.
 */
function refillLeadsReachedProvider(e: unknown): boolean {
  if (!(e instanceof AppendLeadsPartialError)) return false;
  const partial = e.partialResult;
  return partial.accepted > 0 || partial.attemptedIndexes.length > 0;
}

/**
 * Сколько refill-прогонов этой вертикали упало ПОДРЯД перед текущим.
 *
 * Журнал he_auto_pipeline_runs: строку 'collecting' пишет крон при постановке,
 * финал — эта стадия по base_id. Поэтому считаем только завершённые прогоны
 * ДРУГИХ баз (своя строка сейчас ещё 'collecting'); любой успех
 * ('appended'/'no_new') серию обрывает. Строки без base_id — отказы САМОЙ
 * постановки крона (сбора не было), они про срез ничего не говорят и в серию
 * не идут.
 *
 * Никогда не бросает: вызывается из catch-ветки долива, где падать нельзя
 * (см. шапку файла). Непрочитанная история = 0, то есть отказ считается
 * разовым и компании возвращаются в пул — из двух исходов это обратимый:
 * вернуть срез можно ещё раз, а выжженный назад не достать.
 *
 * Возвращаемое число ограничено окном чтения (LIMIT + 1): решение бинарное
 * («серия достигла лимита или нет»), полная длина истории для него не нужна.
 */
async function refillFailStreak(
  ctx: HeStageContext,
  verticalId: string,
  currentBaseId: string,
): Promise<number> {
  try {
    const { data, error } = await ctx.supabase
      .from('he_auto_pipeline_runs')
      .select('status')
      .eq('vertical_id', verticalId)
      // Отбор делает запрос, а не JS: раньше пропускаемые строки (своя
      // 'collecting', зависшие 'collecting' прошлых постановок, отказы крона
      // без base_id) занимали место в окне и серия читалась короче, чем есть.
      // base_id IS NULL отсекает и сам neq (SQL: NULL <> id → NULL), условие
      // оставлено явным — оно про смысл строки, а не про трёхзначную логику.
      .not('base_id', 'is', null)
      .neq('base_id', currentBaseId)
      .neq('status', 'collecting')
      // Порядок — по завершению: у всех незавершённых строк статус
      // 'collecting', он уже отсечён, а completed_at ставят и стадия, и крон.
      // nullsFirst=false — чтобы гипотетическая строка без даты не съела окно.
      .order('completed_at', { ascending: false, nullsFirst: false })
      // Ровно столько, сколько нужно решению: LIMIT подряд упавших прогонов
      // уже запрещают возврат, +1 строка отличает «серия ровно на лимите» от
      // «длиннее» в журнале.
      .limit(REFILL_RELEASE_FAIL_STREAK_LIMIT + 1);
    if (error) throw new Error(error.message);
    let streak = 0;
    for (const row of (data ?? []) as Array<{ status?: unknown }>) {
      // Любой успех ('appended'/'no_new') серию обрывает.
      if (row.status !== 'failed') break;
      streak += 1;
    }
    return streak;
  } catch (e) {
    stageLog(
      ctx,
      `[base_collect] refill: he_auto_pipeline_runs серия отказов не прочитана: ` +
        `${e instanceof Error ? e.message : String(e)} — считаем отказ разовым`,
    );
    return 0;
  }
}

interface RefillTemplatePick {
  campaignId: string;
  presetId: string;
  operatorMapping: HeOperatorMapping[] | undefined;
}

/**
 * Шаблон для долива: среди шаблонов вертикали с launch_info — точное
 * совпадение по campaign_id из collect_info (снапшот постановки), иначе
 * последний по дате запуска (force-перезапуск создаёт НОВУЮ кампанию и
 * перезаписывает launch_info — доливать надо в неё).
 */
export function pickRefillTemplate(
  templates: Array<Record<string, unknown>>,
  preferredCampaignId: string | null,
): RefillTemplatePick | null {
  const launched = templates
    .map((t) => {
      const launch = parseLaunchInfo(t.launch_info);
      if (!launch) return null;
      const plan = t.personalization_plan as { operator_mapping?: HeOperatorMapping[] } | null;
      const ts =
        Date.parse(launch.created_at) ||
        Date.parse(typeof t.created_at === 'string' ? t.created_at : '') ||
        0;
      return { launch, operatorMapping: plan?.operator_mapping, ts };
    })
    .filter((t): t is NonNullable<typeof t> => t !== null);
  if (launched.length === 0) return null;

  const toPick = (t: (typeof launched)[number]): RefillTemplatePick | null => {
    // При сплите запуска по сегментам доливаем ТОЛЬКО в основную кампанию
    // (segment=null): новые лиды refill не классифицированы по сегментам.
    // Сплит без основной кампании (все лиды попали в сегменты) → доливать
    // некуда: null, а не фолбэк на сегментную.
    if (t.launch.campaigns?.length) {
      const main = t.launch.campaigns.find((c) => c.segment === null);
      if (!main) return null;
      return { campaignId: main.campaign_id, presetId: t.launch.preset_id, operatorMapping: t.operatorMapping };
    }
    return {
      campaignId: t.launch.campaign_id,
      presetId: t.launch.preset_id,
      operatorMapping: t.operatorMapping,
    };
  };

  if (preferredCampaignId) {
    const exact = launched.find(
      (t) =>
        t.launch.campaign_id === preferredCampaignId ||
        (t.launch.campaigns ?? []).some((c) => c.campaign_id === preferredCampaignId),
    );
    if (exact) {
      const picked = toPick(exact);
      if (picked) return picked;
    }
  }
  for (const t of launched.slice().sort((a, b) => b.ts - a.ts)) {
    const picked = toPick(t);
    if (picked) return picked;
  }
  return null;
}

/**
 * Строки-кандидаты в лиды: непустой email И вердикт валидации 'accepted'.
 *
 * Вердикт считает heLaunchEmailVerdict (launchHandoff.ts) — тот же список
 * допущенных статусов, что у ручного запуска шаблона, и тот же разбор
 * регистра/пробелов. Здесь он НЕ переписан осознанно: два пути допуска
 * адресов, которые можно поправить по отдельности, рано или поздно разойдутся,
 * а расхождение видно только по баунсам, то есть уже по репутации доменов.
 * Почему catch_all не допущен — в докблоке HE_LAUNCH_ACCEPTED_EMAIL_STATUSES.
 *
 * 'missing' (вердикта нет вовсе) отклоняется, как и 'rejected', но считается
 * отдельно: ночной долив идёт без человека рядом, и «валидация не доработала»
 * обязано быть видно в воронке, а не выглядеть как «адреса плохие».
 */
export function selectRefillLeadRows(
  rows: HeUnifiedRow[],
  emailStatuses: Array<string | null> | null,
): { leadRows: HeUnifiedRow[]; withEmail: number; valid: number; unverified: number } {
  const leadRows: HeUnifiedRow[] = [];
  let withEmail = 0;
  let unverified = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (row.email.trim() === '') continue;
    // Строки вне вертикали (релевант-гейт base_collect) в долив не идут.
    if ((row as { _low_relevance?: boolean })._low_relevance === true) continue;
    withEmail += 1;
    const verdict = heLaunchEmailVerdict(emailStatuses?.[i] ?? null);
    if (verdict === 'missing') unverified += 1;
    if (verdict !== 'accepted') continue;
    leadRows.push(row);
  }
  return { leadRows, withEmail, valid: leadRows.length, unverified };
}

/**
 * Пустой harvest refill-сборки — штатный «no_new»: база в терминальный
 * 'analyzed' (НЕ failed), прогон 'no_new', джоба завершится успешно.
 */
export async function completeHeRefillNoNew(args: {
  ctx: HeStageContext;
  job: HeJob;
  baseId: string;
  verticalId: string;
  info: HeCollectInfo;
  stats: HeCollectInfo['stats'];
}): Promise<HeRefillResult> {
  const { ctx, job, baseId, verticalId, info, stats } = args;
  const refillResult: HeRefillResult = { status: 'no_new', completed_at: new Date().toISOString() };

  const { error } = await ctx.supabase
    .from('he_bases')
    .update({
      status: 'analyzed',
      collect_info: { ...info, stats, refill_result: refillResult },
      updated_at: new Date().toISOString(),
    })
    .eq('id', baseId);
  if (error) throw new Error(`he_bases refill no_new update: ${error.message}`);

  const config = await loadRefillConfig(ctx, job.project_id);
  await writeRefillRun(ctx, {
    configId: config?.id ?? null,
    projectId: job.project_id,
    verticalId,
    baseId,
    result: refillResult,
  });
  stageLog(ctx, '[base_collect] refill: новых компаний нет — прогон no_new, база analyzed');
  return refillResult;
}

/**
 * Долив собранной базы в запущенную кампанию (вызывается вместо финального
 * блока «analyzing + base_analyze»). Никогда не бросает refill-ошибки наружу
 * (см. шапку); бросает только ошибку финального апдейта самой базы — как
 * обычный путь стадии.
 */
export async function runHeRefillAppend(args: {
  ctx: HeStageContext;
  job: HeJob;
  base: { id: string; project_id: string; vertical_id: string };
  info: HeCollectInfo;
  stats: HeCollectInfo['stats'];
  finalRows: HeUnifiedRow[];
  finalColumns: string[];
  /**
   * Вердикты валидации по индексам finalRows. null вместо массива (валидации
   * не было вовсе) или null в элементе (у строки вердикта нет) — такая строка
   * в долив НЕ идёт и попадает в stats.unverified, см. selectRefillLeadRows.
   */
  emailStatuses: Array<string | null> | null;
  usage: HeUsage;
}): Promise<HeStageResult> {
  const { ctx, job, base, info, stats, finalRows, finalColumns, emailStatuses, usage } = args;

  const done = (refill: HeRefillResult): HeStageResult => ({
    result: { base_id: base.id, rows: finalRows.length, refill },
    tokensUsed: usage.tokensUsed,
    costUsd: usage.costUsd,
  });

  const config = await loadRefillConfig(ctx, job.project_id);
  const dailyLeadsCap = config?.dailyLeadsCap ?? HE_AUTO_DEFAULT_DAILY_LEADS_CAP;
  // Кап адресов на компанию ЭТОЙ сборки: он же уехал конструктору в
  // step_config.cap_emails_per_company (collect_info.construct.contact_cap есть
  // всегда, в том числе там, где миграция 20260926_0001 не применена). Читаем
  // снапшот, а не колонку проекта: лимит мог измениться после постановки, а
  // оплачены пробы по тому, с которым сборка шла.
  const contactCap =
    normalizeHeMaxEmailsPerCompany(info.construct?.contact_cap) ?? HE_MAX_EMAILS_PER_COMPANY_DEFAULT;
  const companyTarget = heRefillCompanyTarget({ dailyLeadsCap, contactCap });
  const companyLimit =
    typeof info.limit === 'number' && Number.isFinite(info.limit) ? info.limit : null;
  // Сборка оплачена ДО этой ветки. Если её объём считали не из капа, лишние
  // краулы и SMTP-пробы уже потрачены: кап выбросит их строки, а компании
  // останутся выжженными (база уйдёт в 'analyzed'). Называем это вслух в
  // журнале сборки — иначе первый ночной счёт объяснять будет нечем. Строка
  // исчезнет сама, когда постановка начнёт считать объём в компаниях
  // (resolveHeRefillCollectCompanies).
  if (companyLimit !== null && companyLimit > companyTarget) {
    stageLog(
      ctx,
      `[base_collect] refill: сборка шла на ${companyLimit} компаний при капе ${dailyLeadsCap} ` +
        `лидов (хватило бы ${companyTarget}) — до ` +
        `${(companyLimit - companyTarget) * (contactCap + 1)} адресов проверено впустую; ` +
        'объём сборки должен считаться из капа (resolveHeRefillCollectCompanies)',
    );
  }
  /** Отдали ли строки провайдеру — решает судьбу компаний при отказе. */
  let providerTouched = false;
  const runStats: HeRefillStats = {
    collected: finalRows.length,
    with_email: 0,
    valid: 0,
    unverified: 0,
    appended: 0,
    skipped_blocklist: 0,
    skipped_instantly: 0,
    capped: 0,
    daily_cap: dailyLeadsCap,
    company_target: companyTarget,
    company_limit: companyLimit,
  };

  try {
    // 1. Кампания и маппинг — из запущенного шаблона вертикали.
    const { data: templateRows, error: tErr } = await ctx.supabase
      .from('he_templates')
      .select('id, launch_info, personalization_plan, created_at')
      .eq('vertical_id', base.vertical_id)
      .not('launch_info', 'is', null);
    if (tErr) throw new Error(`he_templates read: ${tErr.message}`);
    const preferredCampaignId =
      typeof info.campaign_id === 'string' && info.campaign_id ? info.campaign_id : null;
    const pick = pickRefillTemplate((templateRows ?? []) as Array<Record<string, unknown>>, preferredCampaignId);
    if (!pick) {
      throw new Error('у вертикали нет запущенной кампании (he_templates.launch_info) — доливать некуда');
    }

    // 2. Владелец пресета — чей Instantly-аккаунт, blocklist и тариф (как у
    //    клиентского auto-pipeline: appendLeadsToClientCampaign по userId).
    if (!supabaseInstantly) {
      throw new Error('supabaseInstantly не сконфигурирован (INSTANTLY_SUPABASE_URL)');
    }
    const { data: presetRow, error: pErr } = await supabaseInstantly
      .from('client_campaign_presets')
      .select('client_user_id')
      .eq('id', pick.presetId)
      .maybeSingle();
    if (pErr) throw new Error(`client_campaign_presets read: ${pErr.message}`);
    const ownerUserId = (presetRow as { client_user_id?: unknown } | null)?.client_user_id;
    if (typeof ownerUserId !== 'string' || !ownerUserId) {
      throw new Error(`пресет ${pick.presetId} не найден — владелец кампании неизвестен`);
    }

    // 3. Лиды: email + допущенный вердикт валидации, маппинг колонок →
    //    переменные шаблона.
    const { leadRows, withEmail, valid, unverified } = selectRefillLeadRows(finalRows, emailStatuses);
    runStats.with_email = withEmail;
    runStats.valid = valid;
    runStats.unverified = unverified;
    // Ни одного проверенного адреса, а непроверенные есть — валидация не
    // доработала. Уходим в общий отказ долива (catch ниже): прогон 'failed' с
    // причиной, компании возвращаются в пул по тому же правилу, что и у
    // недоставленного отказа, и завтрашняя сборка проверит их заново. Тихий
    // 'no_new' здесь означал бы «новых компаний нет» — отчёт, по которому
    // неделю неотправки не отличить от исчерпанного рынка.
    //
    // Статус фазы конструктора в тексте не для красоты: he_bases.error кабинет
    // сворачивает в машинный код причины (clientErrors.classifyHeClientError),
    // и по этой формулировке ENG-клиент получает «валидация почт не
    // доработала» вместо обобщённого технического сбоя. Переформулировать —
    // только сверившись с тем классификатором.
    if (valid === 0 && unverified > 0) {
      throw new Error(
        `валидация почт не дала вердиктов: ${unverified} стр. с адресом не проверено ` +
          `(конструктор завершился со статусом ${info.construct?.status ?? 'неизвестным'}) — ` +
          'долив остановлен',
      );
    }
    const { leads } = mapBaseRowsToLeads({
      rows: leadRows,
      columns: finalColumns,
      operatorMapping: pick.operatorMapping,
    });

    // 4. Blocklist владельца (сами считаем — число нужно в журнале;
    //    appendLeadsToClientCampaign продублирует фильтр внутри, это дёшево).
    const blockedSet = await getBlockedEmailSet(supabaseInstantly, ownerUserId);
    const { kept, blockedCount } = filterBlockedLeads(leads, blockedSet);
    runStats.skipped_blocklist = blockedCount;

    // 5. Дневной кап проекта: минус уже долитое сегодня (UTC) всеми refill'ами конфига.
    let spent = 0;
    if (config) {
      const { data: spentRows, error: spentErr } = await ctx.supabase
        .from('he_auto_pipeline_runs')
        .select('stats')
        .eq('config_id', config.id)
        .eq('status', 'appended')
        .gte('completed_at', utcDayStart());
      if (spentErr) throw new Error(`he_auto_pipeline_runs daily spent: ${spentErr.message}`);
      for (const row of spentRows ?? []) {
        const appended = (row as { stats?: { appended?: unknown } }).stats?.appended;
        if (typeof appended === 'number' && Number.isFinite(appended)) spent += appended;
      }
    }
    const remaining = Math.max(0, dailyLeadsCap - spent);
    const toSend = kept.slice(0, remaining);
    runStats.capped = kept.length - toSend.length;
    runStats.daily_remaining = remaining;
    // Причина отреза — рядом с числом: воронка обязана отличать «бюджет
    // проекта на сутки» от брака адресов (unverified/отклонённые выше).
    if (runStats.capped > 0) runStats.capped_reason = 'daily_leads_cap';

    // 6. Долив. valid===0 — 'no_new': сюда доходит только случай «вердикты
    //    есть, но ни один адрес не допущен» (или адресов не нашли вовсе), то
    //    есть добор действительно нечего отправлять; непроверенные адреса
    //    отсеялись отказом на шаге 3. Валидные были, но всё съели
    //    blocklist/кап — 'appended' с appended=0 (воронка в stats).
    if (toSend.length > 0) {
      const appended = await appendLeadsToClientCampaign({
        userId: ownerUserId,
        campaignId: pick.campaignId,
        leads: toSend,
        contextLabel: `HE auto-refill · ${base.id}`,
        skipIfInCampaign: true,
        // Ночной долив — доверенный серверный оркестратор, а не браузер
        // клиента: объём уже срезан серверным `daily_leads_cap` (шаг 5 выше),
        // поэтому self-serve тарифный гейт к нему не применяется. Без этой
        // строки ENG-клиент получал 403 «Подписка не активна» ПОСЛЕ оплаченного
        // сбора (у него тариф неактивен или отсутствует), тогда как ручной
        // запуск ENG-кампании гейта не имеет вовсе. Ветка ENG-only по
        // построению: payload.refill ставит только крон autoPipeline, который
        // берёт лишь конфиги проектов he_projects.market='us'.
        //
        // Флаг снимает гейт ЦЕЛИКОМ (appendLeads.ts:245) — вместе с «подписка
        // не активна» отключаются удержание на прогреве почт, «оформлена, но
        // не оплачена» и тарифный лимит контактов. Для ENG это осознанно:
        // ящики, прогрев и расписание ведёт студия по договору, а не тариф
        // клиента; объём режет daily_leads_cap. НЕ затрагиваются (они вне
        // гейта): blocklist владельца, доменная политика, отказ Instantly по
        // лимитам воркспейса и журнал отправок. Вторая возможная опция —
        // `agency_managed` у ENG-пресета при провижининге, см. TODO(tariffs)
        // в autoPipeline.ts.
        entitlementMode: 'managed_contract',
      });
      runStats.appended = appended.accepted;
      runStats.skipped_instantly = appended.skipped;
      // Провайдер уже видел строки. Если дальше упадёт запись базы, компании
      // обратно в сборку отдавать нельзя (см. refillLeadsReachedProvider).
      providerTouched = appended.accepted > 0 || appended.attemptedIndexes.length > 0;
    }
    const outcome: HeRefillResult['status'] = valid === 0 ? 'no_new' : 'appended';

    const refillResult: HeRefillResult = {
      status: outcome,
      campaign_id: pick.campaignId,
      stats: runStats,
      completed_at: new Date().toISOString(),
    };
    await persistRefillBase(ctx, base.id, {
      columns: finalColumns, rows: finalRows, info, stats, refillResult, status: 'analyzed',
    });
    await writeRefillRun(ctx, {
      configId: config?.id ?? null,
      projectId: job.project_id,
      verticalId: base.vertical_id,
      baseId: base.id,
      result: refillResult,
    });
    stageLog(
      ctx,
      `[base_collect] refill ${outcome}: кампания ${pick.campaignId}, лидов ${runStats.appended} ` +
        `(valid ${runStats.valid}, без вердикта ${runStats.unverified}, ` +
        `blocklist ${runStats.skipped_blocklist}, кап-отрез ${runStats.capped} ` +
        // Остаток капа при нулевом отрезе — признак НЕДОбора: компаний собрали
        // меньше, чем нужно капу (см. HE_REFILL_ACCEPTED_PER_COMPANY).
        `при остатке ${runStats.daily_remaining ?? 0} из ${runStats.daily_cap})`,
    );
    return done(refillResult);
  } catch (e) {
    // Ошибка долива НЕ валит джобу (см. шапку): база сохраняется с
    // refill_result.error, прогон журналируется 'failed'.
    const message = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    // Провайдер ничего не получил → база терминально 'failed', и её компании
    // остаются доступны следующей сборке проекта. Успел получить (или мы не
    // знаем наверняка) → прежнее 'analyzed': компании считаются отработанными,
    // второе письмо тому же лиду дороже потерянного лида.
    const delivered = providerTouched || refillLeadsReachedProvider(e);
    // Второй отказ подряд компании уже не возвращает: иначе ночной крон
    // собирал бы тот же срез снова и снова (см. REFILL_RELEASE_FAIL_STREAK_LIMIT).
    const failStreak = delivered ? 0 : await refillFailStreak(ctx, base.vertical_id, base.id);
    const released = !delivered && failStreak < REFILL_RELEASE_FAIL_STREAK_LIMIT;
    const refillResult: HeRefillResult = {
      status: 'failed',
      stats: runStats,
      error: message,
      delivery_attempted: delivered,
      companies_released: released,
      // Серию читаем только когда от неё зависит решение: у доставленного
      // отказа компании не возвращаются независимо от истории, и записанный
      // здесь ноль был бы неизмеренным.
      ...(delivered ? {} : { fail_streak: failStreak }),
      completed_at: new Date().toISOString(),
    };
    await persistRefillBase(ctx, base.id, {
      columns: finalColumns,
      rows: finalRows,
      info,
      stats,
      refillResult,
      status: released ? 'failed' : 'analyzed',
      // Причина видна в карточке базы, а не только в журнале прогонов.
      // Пишем её только вместе со статусом 'failed': у 'analyzed'-базы
      // непустой error означал бы для UI сломанную базу.
      ...(released ? { error: message } : {}),
    });
    await writeRefillRun(ctx, {
      configId: config?.id ?? null,
      projectId: job.project_id,
      verticalId: base.vertical_id,
      baseId: base.id,
      result: refillResult,
    });
    stageLog(
      ctx,
      `[base_collect] refill failed: ${message}` +
        (delivered
          ? ' — строки уже у провайдера, база остаётся analyzed'
          : released
            ? ' — провайдер строк не получил, база failed (компании не выжигаем)'
            : ` — отказ ${failStreak + 1}-й подряд, компании остаются исключёнными ` +
              '(база analyzed): иначе ночной прогон собрал бы тот же срез заново'),
    );
    return done(refillResult);
  }
}
