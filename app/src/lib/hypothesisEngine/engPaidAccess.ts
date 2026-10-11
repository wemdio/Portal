/**
 * Один гейт платных шагов клиентского ENG-кабинета (self-serve):
 * requireEngPaidAccess(supabase, userId, { action }).
 *
 * Ставится в роуте ПОСЛЕ requireClientAuth (демо там уже отрезано для
 * мутаций), requireEngMarket и проверки владельца — и ДО постановки платной
 * работы. Отвечает { ok: true, limits } либо отказом с кодом, HTTP-статусом и
 * английской фразой с действием (engPaidAccessResponse отдаёт их телом
 * `{ error, code, retry_after_seconds? }`).
 *
 * ЧТО ПРОВЕРЯЕТ — по действию (порядок проверок = порядок строк):
 *
 *   действие          почта  один сайт  исследований/сутки  расход клиента
 *   create_project      ✓        ✓                                 ✓
 *   research            ✓                       ✓                  ✓
 *   start_outreach      ✓                                          ✓
 *   collect             ✓                                          ✓
 *   letters             ✓                                          ✓
 *   resume_refill       ✓                                          ✓
 *   launch              ✓                                          ✓
 *
 * create_project — только создание НОВОГО проекта (POST api/client/eng/
 * projects). Исследование уже существующего проекта в любом статусе, в том
 * числе повтор упавшего, — действие 'research': проект в счёт «одного сайта»
 * уже входит, и повтор его не добавляет. Лимит стартов исследования у
 * create_project не проверяется: создать проект может только клиент без
 * проектов, а у него нет ни одной джобы site_profile.
 *
 * Запуск — тоже платный шаг: у шаблона с сегментными вариантами писем ядро
 * запуска зовёт классификатор сегментов (модель по всей аудитории запуска,
 * launchTemplate.ts, шаг 5c), поэтому потолок расхода клиента проверяется и
 * здесь. Цена этого: клиент сверх потолка не запустит и шаблон без сегментов
 * (такой запуск модель не зовёт) — потолок выключен по умолчанию, а включённый
 * и достигнутый значит «платные шаги стоят, пока Support не поднимет лимит».
 * Почта у запуска проверяется: это момент, когда письма уходят живым людям.
 * Повторы запуска, отказанного классификатором, роут кабинета ограничивает
 * отдельно (api/client/eng/templates/[id]/launch).
 *
 * КОМУ. Только роли 'client'. Сотрудник (admin), которого requireEngMarket
 * пускает в ENG-кабинет для отладки, проходит без проверок.
 *
 * ПРОВЕРКИ И ИХ ДЕГРАДАЦИЯ:
 *  - почта (he_eng_email_verifications, миграция 20261010_0001): нет таблицы
 *    — проверка пропускается (как до этой правки), строка warn; сбой чтения —
 *    503 'unavailable'. Нет адреса в профиле — отказ с `emailMissing`: ссылку
 *    послать некуда, и кабинет не рисует кнопку отправки;
 *  - один сайт (решение владельца 10.10.2026: «один аккаунт — один сайт»):
 *    у клиента уже есть строка he_projects (created_by = клиент) — любого
 *    рынка и любого статуса, упавший тоже: его повторяют, а не заменяют, —
 *    отказ create_project. Удалить проект клиент сам не может (такого роута
 *    нет), сменить сайт — только через Support. Сбой чтения — 503;
 *  - исследований: джобы he_jobs стадии site_profile (первая стадия
 *    исследования; повтор упавшей стадии — та же строка, attempts+1, а не
 *    новая) по us-проектам клиента, созданные с 00:00 UTC, не больше
 *    HE_US_MAX_RESEARCH_PER_DAY (дефолт 5). Считаются и старты сотрудника по
 *    этим проектам. Сбой чтения — 503;
 *  - расход: engClientSpend (ПО УМОЛЧАНИЮ ВЫКЛЮЧЕН, тогда ноль запросов).
 *    Неизвестный расход (нет функции, сбой, срок) — пускаем, строка warn.
 *
 * ГОНКА. Сами проверки здесь читают, а не бронируют: N одновременных
 * запросов одного клиента прошли бы «один сайт» или лимит исследований на
 * N−1 сверх него (двойной клик «Create & start research» — два проекта и два
 * исследования). Поэтому для роли 'client' результат несёт `limits`, и роуты
 * создания проекта и исследования решают свою проверку повторно ПОД ЗАМКОМ на
 * клиента — createEngProjectLocked / startEngResearchLocked ниже (функции
 * he_eng_create_project / he_eng_start_research, миграция 20261010_0002):
 * пересчёт и вставка одной транзакцией, второй запрос видит то, что вставил
 * первый. Чтение здесь остаётся предпроверкой: роут исследования по нему
 * отказывает ещё до потолка проекта, который пишет паузу и шлёт алерт. Пока
 * миграция не применена: создание проекта клиенту отказывает 503 (ничего не
 * вставив — «один сайт» без замка не держится,
 * engCreateProjectUnavailableRefusal), а роут исследования идёт прежним путём
 * (чтение, затем вставка) с открытой гонкой лимита исследований, как до этой
 * правки; строка warn у обоих.
 *
 * Пути без пользователя (воркер, реконсилер, ночной добор) этот гейт не зовут
 * — для них расход клиента по id проекта: engClientSpend.
 * checkHeClientSpendCeilingForProject.
 */

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logAudit, logWarn } from '@/lib/loggerServer';
import { readHeEngEmailStatus } from './engEmailVerification';
import { checkHeClientSpendCeiling, readHeClientSpendCaps } from './engClientSpend';
import { HE_RESEARCH_STAGES } from './researchJob';

export type EngPaidAction =
  | 'create_project'
  | 'research'
  | 'start_outreach'
  | 'collect'
  | 'letters'
  | 'launch'
  | 'resume_refill';

export type EngPaidAccessCode =
  | 'email_not_verified'
  | 'project_limit'
  | 'research_limit'
  | 'spend_limit'
  | 'spend_day_limit'
  | 'unavailable';

export interface EngPaidAccessRefusal {
  code: EngPaidAccessCode;
  status: number;
  /** Английская фраза для клиента — с действием, без внутренних имён. */
  message: string;
  /** Только research_limit: секунд до 00:00 UTC. */
  retryAfterSeconds?: number;
  /**
   * Только email_not_verified: в профиле нет адреса — ссылку послать некуда,
   * кабинет не рисует «Send confirmation link».
   */
  emailMissing?: boolean;
}

/**
 * `limits` — лимиты клиента для повторного решения под замком
 * (createEngProjectLocked / startEngResearchLocked); null — у аккаунта лимитов
 * нет (сотрудник, 'not_required').
 */
export type EngPaidAccessResult =
  | { ok: true; limits: EngPaidAccessLimits | null }
  | { ok: false; refusal: EngPaidAccessRefusal };

export const HE_US_MAX_RESEARCH_PER_DAY_ENV = 'HE_US_MAX_RESEARCH_PER_DAY';
export const HE_US_MAX_RESEARCH_PER_DAY_DEFAULT = 5;

export interface EngPaidAccessLimits {
  maxResearchPerDay: number;
  /** Переменные с нечитаемым значением — взят дефолт. */
  rejected: string[];
}

/** Целое ≥ 1; пусто — дефолт; «0», минус, дробь, мусор — дефолт с пометкой. */
export function readEngPaidAccessLimits(env: NodeJS.ProcessEnv = process.env): EngPaidAccessLimits {
  const rejected: string[] = [];
  const read = (name: string, fallback: number): number => {
    const text = (env[name] ?? '').trim();
    if (!text) return fallback;
    const value = Number(text);
    if (Number.isSafeInteger(value) && value >= 1) return value;
    rejected.push(name);
    return fallback;
  };
  return {
    maxResearchPerDay: read(HE_US_MAX_RESEARCH_PER_DAY_ENV, HE_US_MAX_RESEARCH_PER_DAY_DEFAULT),
    rejected,
  };
}

/* ─────────────── Тексты ─────────────── */

/** Что именно ждёт подтверждения — тем же словом, что действие в кабинете. */
const ACTION_PHRASE: Record<EngPaidAction, string> = {
  create_project: 'start research',
  research: 'start research',
  start_outreach: 'start outreach',
  collect: 'collect contacts',
  letters: 'write letters',
  launch: 'launch campaigns',
  // «Turn on» под «Daily top-up» и «Resume daily top-up» шага 2.
  resume_refill: 'turn on the daily top-up',
};

export const ENG_PAID_UNAVAILABLE_TEXT = 'Service temporarily unavailable — refresh the page';

/**
 * Создание проекта клиентом без функции под замком (he_eng_create_project,
 * миграция 20261010_0002 не применена). «Обновите страницу» здесь было бы
 * неправдой: перезагрузка функцию не создаст, чинит выкатка. Поэтому — сбой у
 * нас и Support («Support» кабинет рисует ссылкой, EngSupportText).
 */
export const ENG_CREATE_PROJECT_UNAVAILABLE_TEXT =
  'A new project cannot be created right now because of a problem on our side. Message Support.';

/**
 * Почта не подтверждена. Две формы — по тому, лежит ли у клиента ДЕЙСТВУЮЩАЯ
 * ссылка на ТЕКУЩИЙ адрес (readHeEngEmailStatus.lastSentAt — только у ссылки,
 * срок которой не вышел): «мы отправили — откройте» говорим, только если её
 * ещё можно открыть; после 48 ч — «отправьте ссылку».
 *
 * Адреса в профиле нет — ни отправить ссылку, ни подтвердить её нечем (новую
 * ссылку роут отправки откажет), поэтому та же фраза, что у полосы кабинета
 * (EngVerifyEmailBanner), и отказ несёт emailMissing — без кнопки отправки.
 */
export const ENG_EMAIL_MISSING_TEXT =
  'Your account has no email address on file, so we cannot send a confirmation link. Contact Support.';

export function engEmailNotVerifiedText(action: EngPaidAction, email: string | null, linkSent: boolean): string {
  const head = `Confirm your email to ${ACTION_PHRASE[action]}.`;
  if (!email) return `${head} ${ENG_EMAIL_MISSING_TEXT}`;
  return linkSent
    ? `${head} We sent a confirmation link to ${email} — open it, or send a new link.`
    : `${head} Send a confirmation link to ${email} and open it.`;
}

/**
 * «Один аккаунт — один сайт» (решение владельца 10.10.2026). «Has a project»,
 * а не «its project»: аккаунт, создавший несколько проектов до этого правила,
 * получает тот же отказ. «Support» кабинет рисует ссылкой на чат
 * (EngSupportText). Число проектов — в аудите отказа, не в тексте.
 */
export const ENG_PROJECT_LIMIT_TEXT =
  'Each account works with one website, and this account already has a project. '
  + 'To work on a different website, message Support.';

export function engResearchLimitText(started: number, max: number): string {
  return (
    `Research has been started ${started} time${started === 1 ? '' : 's'} today and the daily limit is ${max}. `
    + 'You can start it again after midnight UTC.'
  );
}

export const ENG_SPEND_LIMIT_TEXT =
  'Your account has reached its usage limit, so this step cannot start. Contact Support to raise the limit.';
export const ENG_SPEND_DAY_LIMIT_TEXT =
  'Your account has reached its usage limit for the last 24 hours, so this step cannot start right now. '
  + 'Try again later, or contact Support to raise the limit.';

/* ─────────────── Логи деградации ─────────────── */

/** Одна строка warn на причину в окно — гейт стоит на каждом нажатии. */
const DEGRADED_LOG_WINDOW_MS = 10 * 60 * 1000;
const degradedLoggedAt = new Map<string, number>();

function warnDegraded(key: string, message: string, context: Record<string, unknown>): void {
  const now = Date.now();
  if (now - (degradedLoggedAt.get(key) ?? 0) < DEGRADED_LOG_WINDOW_MS) return;
  if (degradedLoggedAt.size >= 100) degradedLoggedAt.clear();
  degradedLoggedAt.set(key, now);
  void logWarn('client.eng.paid_access.degraded', message, context);
}

function logRefusal(userId: string, action: EngPaidAction, refusal: EngPaidAccessRefusal, extra: Record<string, unknown> = {}): EngPaidAccessRefusal {
  if (refusal.code === 'unavailable') {
    void logWarn('client.eng.paid_access.unavailable', 'ENG paid-access check could not read its data', { userId, action, ...extra });
  } else {
    void logAudit('client.eng.paid_access.refused', `ENG paid step refused: ${refusal.code}`, { userId, action, code: refusal.code, ...extra });
  }
  return refusal;
}

function refuse(userId: string, action: EngPaidAction, refusal: EngPaidAccessRefusal, extra: Record<string, unknown> = {}): EngPaidAccessResult {
  return { ok: false, refusal: logRefusal(userId, action, refusal, extra) };
}

function unavailable(userId: string, action: EngPaidAction, reason: string): EngPaidAccessResult {
  return refuse(userId, action, { code: 'unavailable', status: 503, message: ENG_PAID_UNAVAILABLE_TEXT }, { reason });
}

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * 503 создания проекта клиентом, когда функции под замком нет (роут
 * api/client/eng/projects, createEngProjectLocked → 'rpc_missing'). Пишется
 * строкой warn 'unavailable', как остальные 503 гейта.
 */
export function engCreateProjectUnavailableRefusal(userId: string): EngPaidAccessRefusal {
  return logRefusal(
    userId,
    'create_project',
    { code: 'unavailable', status: 503, message: ENG_CREATE_PROJECT_UNAVAILABLE_TEXT },
    { reason: `${HE_ENG_CREATE_PROJECT_RPC} missing` },
  );
}

function projectLimitRefusal(): EngPaidAccessRefusal {
  return { code: 'project_limit', status: 409, message: ENG_PROJECT_LIMIT_TEXT };
}

function researchLimitRefusal(started: number, max: number, dayStart: Date, now: Date): EngPaidAccessRefusal {
  const nextDay = dayStart.getTime() + 24 * 60 * 60 * 1000;
  return {
    code: 'research_limit',
    status: 429,
    message: engResearchLimitText(started, max),
    retryAfterSeconds: Math.max(1, Math.ceil((nextDay - now.getTime()) / 1000)),
  };
}

/* ─────────────── Гейт ─────────────── */

const PROJECT_ID_BATCH = 150;

const CHECKS_ONE_SITE: ReadonlySet<EngPaidAction> = new Set(['create_project']);
const CHECKS_RESEARCH: ReadonlySet<EngPaidAction> = new Set(['research']);
const CHECKS_SPEND: ReadonlySet<EngPaidAction> = new Set([
  'create_project',
  'research',
  'start_outreach',
  'collect',
  'letters',
  'resume_refill',
  'launch',
]);

export async function requireEngPaidAccess(
  supabase: SupabaseClient,
  userId: string,
  opts: { action: EngPaidAction; now?: Date; env?: NodeJS.ProcessEnv },
): Promise<EngPaidAccessResult> {
  const { action } = opts;
  const now = opts.now ?? new Date();
  const env = opts.env ?? process.env;

  // 1. Почта.
  const email = await readHeEngEmailStatus(supabase, userId, now.getTime());
  if (email.state === 'error') return unavailable(userId, action, email.message);
  if (email.state === 'not_required') return { ok: true, limits: null };
  if (email.state === 'table_missing') {
    warnDegraded('email_table_missing', 'he_eng_email_verifications is missing (migration 20261010_0001 not applied) — email check skipped', { action });
  } else if (email.state === 'pending') {
    return refuse(userId, action, {
      code: 'email_not_verified',
      status: 403,
      message: engEmailNotVerifiedText(action, email.email, email.lastSentAt !== null),
      ...(email.email ? {} : { emailMissing: true }),
    });
  }

  const limits = readEngPaidAccessLimits(env);
  if (limits.rejected.length > 0) {
    warnDegraded(`limits_rejected:${limits.rejected.join(',')}`, `unreadable ${limits.rejected.join(', ')} — default used`, { action });
  }

  // 2. Один сайт: любой проект клиента — любого рынка и статуса. Тот же
  // фильтр, что у списка проектов кабинета (GET api/client/eng/projects):
  // проект, который клиент видит, в счёт входит.
  if (CHECKS_ONE_SITE.has(action)) {
    const { count: projects, error: projectsErr } = await supabase
      .from('he_projects')
      .select('id', { count: 'exact', head: true })
      .eq('created_by', userId);
    if (projectsErr || typeof projects !== 'number') {
      return unavailable(userId, action, `he_projects count: ${projectsErr?.code ?? 'no count'}`);
    }
    if (projects > 0) return refuse(userId, action, projectLimitRefusal(), { projects });
  }

  // 3. Исследования: стартов site_profile по us-проектам клиента за UTC-сутки.
  if (CHECKS_RESEARCH.has(action)) {
    const { data: projects, error: projectsErr } = await supabase
      .from('he_projects')
      .select('id')
      .eq('created_by', userId)
      .eq('market', 'us')
      .limit(1000);
    if (projectsErr) return unavailable(userId, action, `he_projects read: ${projectsErr.code ?? 'error'}`);
    const rows = (projects ?? []) as Array<{ id: string }>;

    if (rows.length > 0) {
      const dayStart = startOfUtcDay(now);
      // Пачками по 150 id: длинный список в `in` упёрся бы в длину строки
      // запроса у клиента со многими упавшими проектами.
      let count = 0;
      for (let i = 0; i < rows.length; i += PROJECT_ID_BATCH) {
        const { count: batchCount, error: jobsErr } = await supabase
          .from('he_jobs')
          .select('id', { count: 'exact', head: true })
          .in('project_id', rows.slice(i, i + PROJECT_ID_BATCH).map((p) => p.id))
          .eq('stage', 'site_profile')
          .gte('created_at', dayStart.toISOString());
        if (jobsErr || typeof batchCount !== 'number') {
          return unavailable(userId, action, `he_jobs count: ${jobsErr?.code ?? 'no count'}`);
        }
        count += batchCount;
      }
      if (count >= limits.maxResearchPerDay) {
        return refuse(userId, action, researchLimitRefusal(count, limits.maxResearchPerDay, dayStart, now), {
          started: count,
          max: limits.maxResearchPerDay,
        });
      }
    }
  }

  // 4. Расход клиента (по умолчанию выключен — ноль запросов).
  if (CHECKS_SPEND.has(action)) {
    const caps = readHeClientSpendCaps(env);
    if (caps.rejected.length > 0) {
      warnDegraded(`spend_rejected:${caps.rejected.join(',')}`, `unreadable ${caps.rejected.join(', ')} — this cap is treated as off`, { action });
    }
    const spend = await checkHeClientSpendCeiling(supabase, { userId, caps, now });
    const verdict = spend.verdict;
    if (verdict.kind === 'over') {
      return refuse(userId, action, verdict.cap === 'total'
        ? { code: 'spend_limit', status: 409, message: ENG_SPEND_LIMIT_TEXT }
        : { code: 'spend_day_limit', status: 429, message: ENG_SPEND_DAY_LIMIT_TEXT },
      { cap: verdict.cap, spendUsd: verdict.spendUsd, capUsd: verdict.capUsd });
    }
    if (verdict.kind === 'unknown') {
      warnDegraded(`spend_unknown:${spend.failure ?? verdict.cap}`, `client spend unknown (${spend.failure ?? verdict.cap}) — paid step allowed (fail-open)`, { action, userId });
    }
  }

  return { ok: true, limits };
}

/* ─────────────── Лимиты под замком ─────────────── */

// Функции миграции 20261010_0002 (её шапка — что они делают и почему так).
const HE_ENG_CREATE_PROJECT_RPC = 'he_eng_create_project';
const HE_ENG_START_RESEARCH_RPC = 'he_eng_start_research';

type LockedCall =
  | { kind: 'answer'; answer: Record<string, unknown> }
  | { kind: 'rpc_missing' }
  | { kind: 'error'; message: string };

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * Вызов функции под замком. НЕ БРОСАЕТ. Функции нет (42883 / PGRST202 —
 * миграция 20261010_0002 не применена) — 'rpc_missing' и строка warn раз в
 * окно; любой другой отказ или ответ без outcome — 'error'. Ошибка Postgres
 * откатывает функцию целиком (она — одна транзакция), а ответ, потерянный
 * транспортом после коммита, оставляет вставленное — как и на прежнем пути.
 */
async function callLocked(
  supabase: SupabaseClient,
  rpc: string,
  args: Record<string, unknown>,
  action: EngPaidAction,
): Promise<LockedCall> {
  try {
    const { data, error } = await supabase.rpc(rpc, args);
    if (error) {
      if (error.code === '42883' || error.code === 'PGRST202') {
        warnDegraded(
          `${rpc}_missing`,
          rpc === HE_ENG_CREATE_PROJECT_RPC
            ? `${rpc} is missing (migration 20261010_0002 not applied) — client project creation is refused (503)`
            : `${rpc} is missing (migration 20261010_0002 not applied) — the research limit is read without a lock`,
          { action },
        );
        return { kind: 'rpc_missing' };
      }
      return { kind: 'error', message: `${rpc} rpc: ${error.code ?? 'error'} ${String(error.message ?? '').slice(0, 200)}` };
    }
    const answer = asObject(data);
    if (answer && typeof answer.outcome === 'string') return { kind: 'answer', answer };
    return { kind: 'error', message: `${rpc}: unexpected answer` };
  } catch (e) {
    return { kind: 'error', message: `${rpc} threw: ${e instanceof Error ? e.message.slice(0, 200) : 'unknown'}` };
  }
}

/** Число из ответа функции: целое ≥ 0, иначе `fallback`. */
function answerCount(answer: Record<string, unknown>, key: string, fallback: number): number {
  const value = Number(answer[key]);
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

export type EngCreateProjectLockedResult =
  /** Проект и его site_profile вставлены одной транзакцией; строки целиком. */
  | { kind: 'created'; project: Record<string, unknown>; job: Record<string, unknown> }
  | { kind: 'refused'; refusal: EngPaidAccessRefusal }
  /** Миграции нет — роут отказывает клиенту 503 (engCreateProjectUnavailableRefusal). */
  | { kind: 'rpc_missing' }
  | { kind: 'error'; message: string };

/**
 * Создание проекта клиента (действие 'create_project') под замком
 * (he_eng_create_project): «один сайт» пересчитывается по ВСЕМ проектам
 * клиента, и проект с брифом и его site_profile вставляется одной
 * транзакцией. `brief` — бриф нового проекта (buildHeEngCreateBrief,
 * projectBriefPatch.ts) или null — колонка остаётся пустой, как у проекта,
 * созданного без ответов. Зовётся только для клиента — после
 * requireEngPaidAccess, вернувшего limits.
 */
export async function createEngProjectLocked(
  supabase: SupabaseClient,
  userId: string,
  opts: { name: string; websiteUrl: string; brief: Record<string, unknown> | null },
): Promise<EngCreateProjectLockedResult> {
  const call = await callLocked(supabase, HE_ENG_CREATE_PROJECT_RPC, {
    p_user_id: userId,
    p_name: opts.name,
    p_website_url: opts.websiteUrl,
    p_brief: opts.brief,
  }, 'create_project');
  if (call.kind !== 'answer') return call;
  if (call.answer.outcome === 'project_limit') {
    const projects = answerCount(call.answer, 'projects', 1);
    return { kind: 'refused', refusal: logRefusal(userId, 'create_project', projectLimitRefusal(), { projects, locked: true }) };
  }
  const project = asObject(call.answer.project);
  const job = asObject(call.answer.job);
  if (call.answer.outcome === 'created' && project && typeof project.id === 'string' && job) {
    return { kind: 'created', project, job };
  }
  return { kind: 'error', message: `${HE_ENG_CREATE_PROJECT_RPC}: unexpected outcome ${String(call.answer.outcome).slice(0, 40)}` };
}

export type EngStartResearchLockedResult =
  /** site_profile вставлена, проект переведён в 'researching'; строка джобы целиком. */
  | { kind: 'started'; job: Record<string, unknown> }
  | { kind: 'refused'; refusal: EngPaidAccessRefusal }
  /** research этого проекта уже идёт — ничего не вставлено. */
  | { kind: 'conflict' }
  /** Проекта с таким id у клиента нет (удалён между проверкой владельца и замком). */
  | { kind: 'not_found' }
  /** Миграции нет — роут идёт прежним путём (enqueueHeResearchJob без брони). */
  | { kind: 'rpc_missing' }
  | { kind: 'error'; message: string };

/**
 * Старт исследования проекта клиента под замком (he_eng_start_research):
 * лимит исследований, дедуп активной research-стадии (HE_RESEARCH_STAGES),
 * вставка site_profile и перевод проекта в 'researching' — одной транзакцией.
 * «Один сайт» здесь не проверяется: проект уже есть и в счёт уже входит,
 * исследование его не добавляет. `action` — тот же, с которым роут звал
 * requireEngPaidAccess (для журнала отказа).
 */
export async function startEngResearchLocked(
  supabase: SupabaseClient,
  userId: string,
  opts: { projectId: string; action: EngPaidAction; limits: EngPaidAccessLimits; now?: Date },
): Promise<EngStartResearchLockedResult> {
  const now = opts.now ?? new Date();
  const dayStart = startOfUtcDay(now);
  const call = await callLocked(supabase, HE_ENG_START_RESEARCH_RPC, {
    p_user_id: userId,
    p_project_id: opts.projectId,
    p_research_stages: HE_RESEARCH_STAGES,
    p_max_research_per_day: opts.limits.maxResearchPerDay,
    p_day_start: dayStart.toISOString(),
  }, opts.action);
  if (call.kind !== 'answer') return call;
  if (call.answer.outcome === 'research_limit') {
    const started = answerCount(call.answer, 'started', opts.limits.maxResearchPerDay);
    return {
      kind: 'refused',
      refusal: logRefusal(userId, opts.action, researchLimitRefusal(started, opts.limits.maxResearchPerDay, dayStart, now), {
        started,
        max: opts.limits.maxResearchPerDay,
        locked: true,
      }),
    };
  }
  if (call.answer.outcome === 'conflict') return { kind: 'conflict' };
  if (call.answer.outcome === 'not_found') return { kind: 'not_found' };
  const job = asObject(call.answer.job);
  if (call.answer.outcome === 'started' && job && typeof job.id === 'string') return { kind: 'started', job };
  return { kind: 'error', message: `${HE_ENG_START_RESEARCH_RPC}: unexpected outcome ${String(call.answer.outcome).slice(0, 40)}` };
}

/** Тело отказа для роута: `{ error, code, retry_after_seconds?, email_missing? }`. */
export function engPaidAccessResponse(refusal: EngPaidAccessRefusal): NextResponse {
  return NextResponse.json(
    {
      error: refusal.message,
      code: refusal.code,
      ...(refusal.retryAfterSeconds !== undefined ? { retry_after_seconds: refusal.retryAfterSeconds } : {}),
      ...(refusal.emailMissing ? { email_missing: true } : {}),
    },
    {
      status: refusal.status,
      ...(refusal.retryAfterSeconds !== undefined ? { headers: { 'Retry-After': String(refusal.retryAfterSeconds) } } : {}),
    },
  );
}
