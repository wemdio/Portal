/**
 * TG Outreach: per-proxy health tracking + автосвап прокси у аккаунта.
 *
 * Контекст. С момента перехода на mobile-pool proxy.market воркер регулярно
 * ловит connect timeout / зависание getDialogs через прокси, у которых TCP
 * жив. Это silent throttle Telegram через мобильный IP, помеченный шумной
 * активностью соседей по пулу. У нас в каждой кампании ~70% прокси
 * простаивает (101 в пуле / ~30 заняты 1:1 с аккаунтами) — резерв для
 * автосвапа есть. Этот модуль — единая точка работы с health:
 *
 *   - recordProxyError: воркер вызывает при connect timeout / wedged socket
 *   - recordProxySuccess: сбрасывает counters при успешном круге
 *   - findFreeProxy: ищет свободный прокси в той же кампании для свапа
 *   - swapAccountProxy: атомарно (через RPC) меняет proxy_id у аккаунта,
 *     пишет audit-row в tg_outreach_proxy_swaps
 *   - markAccountDegraded: 3 РАЗНЫХ прокси подряд провалились → не прокси
 *     виноват, а сессия (shadow-ban / auth issue); auto-cooldown 24h
 *
 * Защита от антифрода Telegram:
 *   - max-2-свапа на аккаунт в сутки (через дневной счётчик в RPC)
 *   - cooldown 30 мин на аккаунт после свапа (даём Telegram стабилизироваться)
 *   - свежие аккаунты (created < ACCOUNT_FRESH_DAYS дней) — не свапаем
 *     автоматически (у них нет «анамнеза» на разных IP, риск выше)
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { OutreachAccount } from './types';

// ---- Constants -------------------------------------------------------------

/**
 * Сколько подряд timeout/«мёртвый сокет» на одном прокси должно произойти,
 * прежде чем мы автоматом ставим cooldown.
 *
 * 3 — компромисс. 1 = слишком чувствительно (один сетевой моргалец — и
 * прокси выкинут). 5+ = аккаунт простоит >30 мин на мёртвом прокси, пока
 * мы будем «терпеть». 3 ≈ один глобальный таймстамп + 2 retry окна
 * подтверждают что это не разовый flake.
 */
export const CONSECUTIVE_ERROR_THRESHOLD = Number(
  process.env.TG_OUTREACH_PROXY_ERROR_THRESHOLD ?? '3',
);

/** Сколько минут прокси «отлёживается» после авто-cooldown'a. */
export const PROXY_COOLDOWN_MINUTES = Number(
  process.env.TG_OUTREACH_PROXY_COOLDOWN_MIN ?? '30',
);

/** Сколько минут аккаунт «отлёживается» после автосвапа прокси. */
export const ACCOUNT_AFTER_SWAP_COOLDOWN_MINUTES = Number(
  process.env.TG_OUTREACH_ACCOUNT_AFTER_SWAP_COOLDOWN_MIN ?? '30',
);

/** Максимум автосвапов на один аккаунт в сутки. */
export const MAX_SWAPS_PER_ACCOUNT_PER_DAY = Number(
  process.env.TG_OUTREACH_MAX_SWAPS_PER_DAY ?? '2',
);

/**
 * Аккаунт считается «свежим» (и не свапаем его автоматически) если создан
 * меньше N дней назад. У свежих сессий нет анамнеза на разных IP, и резкая
 * смена IP сильнее триггерит антифрод Telegram.
 */
export const ACCOUNT_FRESH_DAYS = Number(
  process.env.TG_OUTREACH_ACCOUNT_FRESH_DAYS ?? '7',
);

/**
 * Сколько РАЗНЫХ прокси подряд должно провалиться у одного аккаунта,
 * прежде чем мы пометим аккаунт degraded и перестанем свапать. После
 * 3 разных прокси очевидно что проблема в самом аккаунте (shadow-ban,
 * AUTH_KEY_INVALID, шумная сессия), а не в IP.
 */
export const DEGRADED_PROXY_FAILURE_THRESHOLD = Number(
  process.env.TG_OUTREACH_DEGRADED_PROXY_THRESHOLD ?? '3',
);

/** Часов на отлёжку для degraded-аккаунта. */
export const DEGRADED_COOLDOWN_HOURS = Number(
  process.env.TG_OUTREACH_DEGRADED_COOLDOWN_HOURS ?? '24',
);

// ---- Types -----------------------------------------------------------------

/**
 * Категории ошибок, которые triggers per-proxy counter. Совпадает с
 * tg_outreach_proxies.last_error_reason. UI решает как рендерить.
 */
export type ProxyErrorReason =
  | 'connect_timeout'    // первичное подключение к Telegram через прокси упало по таймауту
  | 'getDialogs_hung'    // MTProto зашёл, но getDialogs завис на 180с
  | 'reconnect_failed'   // и переподключение не помогло
  | 'tcp_dead';          // TCP до прокси не отвечает

/** Категории degraded-причин для аккаунта. */
export type AccountDegradedReason =
  | 'multiple_proxies_failed'
  | 'auth_key_invalid'
  | 'manual';

interface ProxyHealthRow {
  id: string;
  campaign_id: string;
  url: string;
  is_active: boolean;
  consecutive_errors: number;
  cooldown_until: string | null;
  total_uses: number | null;
  total_errors: number | null;
  last_used_at: string | null;
}

// ---- Public API ------------------------------------------------------------

/**
 * Зарегистрировать ошибку прокси. Инкрементит consecutive_errors и
 * total_errors. Если consecutive достиг порога — ставит cooldown.
 *
 * Возвращает обновлённое состояние, чтобы caller сразу понял, можно ли
 * продолжать на этом прокси или нужно свапать.
 */
export async function recordProxyError(
  db: SupabaseClient,
  proxyId: string,
  reason: ProxyErrorReason,
): Promise<{
  consecutiveErrors: number;
  cooldownSet: boolean;
  cooldownUntil: string | null;
}> {
  // Используем UPDATE … RETURNING, чтобы получить актуальное значение
  // counters после инкремента (Postgres-нативный путь, не race-condition).
  // supabase-js не умеет .update().returning() напрямую — используем rpc-like
  // SELECT с CTE через .rpc() было бы чище, но добавлять SQL-функцию ради
  // одного места избыточно. Два запроса — приемлемо: ошибки прокси редки
  // (несколько в час), не bottleneck.
  const { data: row, error: selErr } = await db
    .from('tg_outreach_proxies')
    .select('consecutive_errors, total_errors')
    .eq('id', proxyId)
    .maybeSingle();
  if (selErr || !row) {
    return { consecutiveErrors: 0, cooldownSet: false, cooldownUntil: null };
  }
  const r = row as { consecutive_errors: number; total_errors: number | null };
  const next = (r.consecutive_errors ?? 0) + 1;
  const shouldCooldown = next >= CONSECUTIVE_ERROR_THRESHOLD;
  const now = new Date();
  const cooldownUntil = shouldCooldown
    ? new Date(now.getTime() + PROXY_COOLDOWN_MINUTES * 60_000).toISOString()
    : null;

  const patch: Record<string, unknown> = {
    consecutive_errors: next,
    total_errors: (r.total_errors ?? 0) + 1,
    last_error_at: now.toISOString(),
    last_error_reason: reason,
  };
  if (shouldCooldown) {
    patch.cooldown_until = cooldownUntil;
    patch.cooldown_reason = 'auto_consecutive_errors';
  }

  await db.from('tg_outreach_proxies').update(patch).eq('id', proxyId);

  return {
    consecutiveErrors: next,
    cooldownSet: shouldCooldown,
    cooldownUntil,
  };
}

/**
 * Причины отказа, которые пишет ручная проверка прокси оператором
 * (см. proxyCheck.ts). Префикс `check_` обязателен: в колонке
 * `last_error_reason` иначе не отличить сигнал воркера, полученный на боевом
 * трафике, от результата кнопки «Проверить».
 */
export type ProxyCheckFailureReason =
  | 'check_proxy_dead'
  | 'check_proxy_rejected'
  | 'check_telegram_unreachable';

/**
 * Сохранить результат ручной проверки в здоровье прокси.
 *
 * Пишем ТОЛЬКО метки последней ошибки — `last_error_at` и `last_error_reason`,
 * никаких счётчиков и cooldown. Причины две.
 *
 * Первая: счётчики `consecutive_errors` кормят автосвап, а он — операция над
 * боевыми аккаунтами. Нажатие кнопки в интерфейсе не должно перекладывать
 * аккаунты по прокси, иначе проверка сама становится вмешательством.
 *
 * Вторая, более важная: успешная проверка НЕ является успехом прокси в смысле
 * воркера. Ровно тот сбой, из-за которого всё это затевалось (silent throttle
 * Telegram через мобильный IP), выглядит как живой TCP и открывающийся
 * туннель — при мёртвом MTProto. Сбрасывать по такой проверке счётчики
 * значило бы стирать единственный настоящий сигнал. Поэтому успех не пишем
 * вообще: его видно в ответе ручки.
 *
 * Никогда не бросает: результат проверки оператор уже получил, и провал записи
 * в базу не повод отдавать ему ошибку вместо вердиктов.
 */
export async function recordProxyCheckFailures(
  db: SupabaseClient,
  failures: { id: string; reason: ProxyCheckFailureReason }[],
): Promise<void> {
  const now = new Date().toISOString();
  for (const f of failures) {
    try {
      await db
        .from('tg_outreach_proxies')
        .update({ last_error_at: now, last_error_reason: f.reason })
        .eq('id', f.id);
    } catch {
      /* здоровье прокси — побочная запись, вердикты уже посчитаны */
    }
  }
}

/**
 * Зарегистрировать успешный круг через прокси. Сбрасывает consecutive_errors,
 * инкрементит total_uses, обновляет last_used_at. Cooldown НЕ снимаем — если
 * прокси успешно отработал, значит cooldown уже истёк и мы попали в окно,
 * пока он был жив.
 */
export async function recordProxySuccess(
  db: SupabaseClient,
  proxyId: string,
): Promise<void> {
  const { data: row } = await db
    .from('tg_outreach_proxies')
    .select('total_uses')
    .eq('id', proxyId)
    .maybeSingle();
  const total = (row as { total_uses: number | null } | null)?.total_uses ?? 0;
  await db
    .from('tg_outreach_proxies')
    .update({
      consecutive_errors: 0,
      total_uses: total + 1,
      last_used_at: new Date().toISOString(),
    })
    .eq('id', proxyId);
}

/**
 * Прокси «здоров» в данный момент: не в cooldown, не отключён вручную.
 * Чистая утилита-функция (без БД) — caller передаёт row.
 */
export function isProxyHealthy(p: { is_active: boolean; cooldown_until: string | null }): boolean {
  if (!p.is_active) return false;
  if (p.cooldown_until && new Date(p.cooldown_until).getTime() > Date.now()) return false;
  return true;
}

/**
 * Найти свободный прокси в той же кампании для свапа.
 *
 * «Свободный» = (а) активен, (б) не в cooldown, (в) не привязан к другому
 * аккаунту (если includeAssigned=false, это default). Берём прокси с
 * минимальным total_errors и старейшим last_used_at — даём шанс «отдохнувшим».
 *
 * Возвращает null, если в кампании нет ни одного подходящего прокси —
 * caller должен залогировать «нечего свапать» и просто пропустить аккаунт.
 */
export async function findFreeProxy(
  db: SupabaseClient,
  campaignId: string,
  opts?: { excludeProxyIds?: string[]; includeAssigned?: boolean },
): Promise<{ id: string; url: string } | null> {
  // Шаг 1: все активные прокси кампании, не в cooldown.
  const nowIso = new Date().toISOString();
  let q = db
    .from('tg_outreach_proxies')
    .select('id, url, total_errors, total_uses, last_used_at, cooldown_until, is_active')
    .eq('campaign_id', campaignId)
    .eq('is_active', true)
    .or(`cooldown_until.is.null,cooldown_until.lt.${nowIso}`);
  if (opts?.excludeProxyIds?.length) {
    q = q.not('id', 'in', `(${opts.excludeProxyIds.map((id) => `"${id}"`).join(',')})`);
  }
  const { data: candidates, error } = await q;
  if (error || !candidates?.length) return null;

  // Шаг 2: убрать те, что уже привязаны к другому аккаунту (если не
  // includeAssigned). Один прокси на один аккаунт — соблюдаем 1:1 модель.
  let pool = candidates as ProxyHealthRow[];
  if (!opts?.includeAssigned) {
    const { data: assigned } = await db
      .from('tg_outreach_accounts')
      .select('proxy_id')
      .eq('campaign_id', campaignId)
      .not('proxy_id', 'is', null);
    const assignedSet = new Set(
      (assigned ?? [])
        .map((r) => (r as { proxy_id: string | null }).proxy_id)
        .filter(Boolean) as string[],
    );
    pool = pool.filter((p) => !assignedSet.has(p.id));
  }
  if (!pool.length) return null;

  // Шаг 3: tie-break. Меньше ошибок → лучше. Equal errors → дольше не
  // использовался → лучше (даём «отдохнувшим»).
  pool.sort((a, b) => {
    const aErr = a.total_errors ?? 0;
    const bErr = b.total_errors ?? 0;
    if (aErr !== bErr) return aErr - bErr;
    const aTs = a.last_used_at ? new Date(a.last_used_at).getTime() : 0;
    const bTs = b.last_used_at ? new Date(b.last_used_at).getTime() : 0;
    return aTs - bTs;
  });

  return { id: pool[0].id, url: pool[0].url };
}

/**
 * Атомарный свап прокси у аккаунта через RPC + аудит. Дневной лимит и
 * insert в tg_outreach_proxy_swaps выполняется внутри SQL-функции, чтобы
 * было невозможно записать «свап без audit-row» или превысить лимит из-за
 * race condition между параллельными воркерами.
 *
 * Возвращает результат RPC. Caller должен сам вызвать setAccountCooldown
 * после успешного свапа, чтобы дать сессии 30 мин на стабилизацию.
 */
export async function swapAccountProxy(
  db: SupabaseClient,
  params: {
    accountId: string;
    fromProxyId: string | null;
    toProxyId: string;
    reason: string;
  },
): Promise<{
  swapped: boolean;
  swapsToday: number;
  refusalReason: string | null;
}> {
  const { data, error } = await db.rpc('tg_outreach_swap_proxy', {
    p_account_id: params.accountId,
    p_from_proxy_id: params.fromProxyId,
    p_to_proxy_id: params.toProxyId,
    p_reason: params.reason,
    p_max_per_day: MAX_SWAPS_PER_ACCOUNT_PER_DAY,
  });
  if (error || !data || (Array.isArray(data) && !data.length)) {
    return {
      swapped: false,
      swapsToday: 0,
      refusalReason: error?.message ?? 'rpc_empty_result',
    };
  }
  // RPC returns RETURNS TABLE — в зависимости от драйвера приходит как массив
  // или одиночная строка. Нормализуем.
  const row = (Array.isArray(data) ? data[0] : data) as {
    swapped: boolean;
    swap_id: number | null;
    swaps_today: number;
    refusal_reason: string | null;
  };
  return {
    swapped: row.swapped,
    swapsToday: row.swaps_today,
    refusalReason: row.refusal_reason,
  };
}

/**
 * Можно ли свапать прокси у этого аккаунта прямо сейчас?
 * Проверяет три гейта: (а) аккаунт не degraded, (б) не свежий, (в) дневной
 * лимит не превышен. Дневной лимит дополнительно проверяется в RPC —
 * здесь pre-check, чтобы не делать лишний поиск свободного прокси и не
 * писать INFO-лог про bестолковый «попытка свапа».
 */
export function canAutoSwap(
  account: {
    created_at: string;
    degraded: boolean;
    last_proxy_swap_at: string | null;
    proxy_swaps_today: number;
  },
  opts?: { fullOutage?: boolean },
): { ok: true } | { ok: false; reason: string } {
  if (account.degraded) return { ok: false, reason: 'account_degraded' };

  // Правило «свежим не меняем IP» защищает от лишнего повода для антифрода, но
  // при полном отвале подключения защищать уже нечего: аккаунт вообще не в
  // Telegram и не греется. Инцидент 05.08.2026 — вся партия, залитая накануне,
  // просидела сутки на мёртвых портах пула при 24 свободных живых.
  const createdMs = new Date(account.created_at).getTime();
  const ageDays = (Date.now() - createdMs) / (24 * 3600 * 1000);
  if (ageDays < ACCOUNT_FRESH_DAYS && !opts?.fullOutage) {
    return { ok: false, reason: `account_too_fresh_${ageDays.toFixed(1)}d` };
  }

  // Сравниваем счётчик с лимитом, но если последняя смена прокси была вчера —
  // считаем 0 (RPC переставит реально). Здесь pre-check на «не делаем
  // лишнюю работу», поэтому грубо.
  if (account.last_proxy_swap_at) {
    const lastSwap = new Date(account.last_proxy_swap_at);
    const isToday = lastSwap.toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10);
    if (isToday && account.proxy_swaps_today >= MAX_SWAPS_PER_ACCOUNT_PER_DAY) {
      return { ok: false, reason: 'daily_limit_reached' };
    }
  }

  return { ok: true };
}

/**
 * Зафиксировать «провал прокси у аккаунта». Если РАЗНЫХ прокси подряд
 * провалилось столько же, сколько DEGRADED_PROXY_FAILURE_THRESHOLD —
 * пометить degraded и поставить cooldown 24ч.
 *
 * Это вызывается из campaignLoop ПОСЛЕ того, как мы попытались свапнуть
 * прокси (или решили не свапать). Совершенно отдельно от per-proxy
 * counters: один и тот же прокси может «отлежаться» и вернуться,
 * но если у аккаунта подряд 3 разных прокси провалились — проблема в
 * аккаунте, не в прокси.
 *
 * Ключевой момент — «РАЗНЫХ». Считаем провал только когда провалился прокси,
 * отличный от прошлого (last_failed_proxy_id). Повторный провал того же IP
 * счётчик не двигает: это не «ещё один прокси не помог», это один и тот же
 * плохой прокси моргает второй раз.
 *
 * Инцидент 03.08.2026 (кампания TG_VBI). Счётчик инкрементился на ЛЮБОЙ
 * ошибке, а автосвап на свежих аккаунтах запрещён (ACCOUNT_FRESH_DAYS).
 * Прокси физически не менялся ни разу, но при фоновом браке пула ~30%
 * три неудачных круга подряд выпадали по теории вероятностей — и 11 из 17
 * живых аккаунтов получили degraded с текстом «3 разных прокси не помогли»
 * и вредным советом перевыпустить session_data. Разбор:
 * docs/incidents/2026-08-03-tg-outreach-false-degraded.md.
 */
export async function recordAccountProxyFailure(
  db: SupabaseClient,
  accountId: string,
  proxyId: string | null,
): Promise<{
  consecutiveProxyFailures: number;
  markedDegraded: boolean;
  counted: boolean;
}> {
  const { data: row } = await db
    .from('tg_outreach_accounts')
    .select('consecutive_proxy_failures, last_failed_proxy_id')
    .eq('id', accountId)
    .maybeSingle();
  const r = row as {
    consecutive_proxy_failures: number | null;
    last_failed_proxy_id: string | null;
  } | null;
  const prev = r?.consecutive_proxy_failures ?? 0;
  const lastFailedProxyId = r?.last_failed_proxy_id ?? null;

  // Нечего атрибутировать (прокси не назначен) или тот же самый прокси упал
  // повторно — счётчик «разных прокси» не двигаем.
  if (!proxyId || proxyId === lastFailedProxyId) {
    return { consecutiveProxyFailures: prev, markedDegraded: false, counted: false };
  }

  const next = prev + 1;
  const shouldDegrade = next >= DEGRADED_PROXY_FAILURE_THRESHOLD;
  const now = new Date();

  const patch: Record<string, unknown> = {
    consecutive_proxy_failures: next,
    last_failed_proxy_id: proxyId,
  };
  if (shouldDegrade) {
    patch.degraded = true;
    patch.degraded_at = now.toISOString();
    patch.degraded_reason = 'multiple_proxies_failed';
    patch.cooldown_until = new Date(now.getTime() + DEGRADED_COOLDOWN_HOURS * 3600 * 1000).toISOString();
  }
  await db.from('tg_outreach_accounts').update(patch).eq('id', accountId);

  return { consecutiveProxyFailures: next, markedDegraded: shouldDegrade, counted: true };
}

/**
 * Зафиксировать успешный круг аккаунта — сбросить consecutive_proxy_failures.
 * Сбрасываем и last_failed_proxy_id: серия «разных прокси» началась заново,
 * иначе прокси, упавший до успешного круга, больше никогда не засчитался бы.
 * НЕ снимает degraded автоматически (это всегда ручная операция оператора).
 *
 * Здесь же обновляем итог проверки аккаунта на «жив».
 *
 * Проверка кнопкой требует остановленной кампании: воркер держит сессию, и
 * второе подключение к ней — это AUTH_KEY_DUPLICATED и выключенный аккаунт.
 * Из-за этого на работающей кампании «жив/не жив» устаревал неделями, а
 * оператор смотрел на позавчерашние данные. Но успешный круг — это и есть
 * проверка: аккаунт подключился, Telegram отдал диалоги. Диагноз сбоя воркер
 * пишет сюда же (см. campaignLoop), поэтому теперь колонка живёт сама,
 * без остановки кампании и без единого лишнего подключения.
 */
export async function recordAccountSuccess(
  db: SupabaseClient,
  accountId: string,
): Promise<void> {
  await db
    .from('tg_outreach_accounts')
    .update({ consecutive_proxy_failures: 0, last_failed_proxy_id: null })
    .eq('id', accountId);

  /**
   * «Жив» пишем всем, КРОМЕ ограниченных и забаненных.
   *
   * Подключиться и получить диалоги умеет и аккаунт под спам-блоком: блок
   * закрывает переписку с незнакомыми, а не вход. Пока эта отметка ставилась
   * всем подряд, она затирала диагноз со спам-блоком на «жив» в ту же минуту,
   * когда его поставили. В списке аккаунтов стояло зелёное «жив» рядом с
   * суточной паузой, и проверка через @SpamBot после этого не запускалась
   * вовсе — она идёт только к тем, кто числится ограниченным.
   *
   * Обратно в «жив» ограниченный аккаунт возвращает не круг, а факт ушедшего
   * первого касания — см. `clearRestrictionAfterSend`.
   */
  await db
    .from('tg_outreach_accounts')
    .update({
      check_status: 'ok',
      check_detail: 'круг рассылки прошёл: аккаунт подключился и получил диалоги',
      checked_at: new Date().toISOString(),
    })
    .eq('id', accountId)
    .or('check_status.is.null,check_status.not.in.(restricted,banned)');
}

/**
 * Установить аккаунту cooldown после автосвапа прокси — даём сессии
 * стабилизироваться на новом IP, прежде чем снова стучаться в Telegram.
 */
export async function setAccountAfterSwapCooldown(
  db: SupabaseClient,
  accountId: string,
): Promise<void> {
  const until = new Date(Date.now() + ACCOUNT_AFTER_SWAP_COOLDOWN_MINUTES * 60_000).toISOString();
  await db
    .from('tg_outreach_accounts')
    .update({ cooldown_until: until })
    .eq('id', accountId);
}

/**
 * Когда у аккаунта вылетела сетевая ошибка через прокси — в круге боевого
 * цикла или на самом подключении
 * (connect_timeout / getDialogs_hung / reconnect_failed):
 *  1) бьём счётчик на прокси, при достижении порога ставим cooldown
 *  2) бьём счётчик на аккаунте — если 3 разных прокси подряд провалились,
 *     помечаем degraded и ставим 24h cooldown
 *  3) если прокси ушёл в cooldown И аккаунту разрешён автосвап
 *     (см. canAutoSwap), ищем свободный прокси в той же кампании и
 *     атомарно свапаем + кладём аккаунт на 30 мин стабилизироваться
 *
 * Живёт здесь, а не в campaignLoop: с 05.08.2026 его зовёт ещё и buildClients,
 * то есть автосвап наконец работает и на падениях подключения, и в прогреве —
 * раньше сдохший модем в пуле чинили руками, каждый день заново.
 *
 * Возвращает прокси, на который свапнули, чтобы вызывающий мог тут же
 * переподключиться, не дожидаясь следующего круга.
 *
 * Никогда не throw — вызывающий код продолжает свой error-handling
 * как раньше (skip account this round, log, etc.). Эта функция — только
 * запись state и попытка swap, никакой бизнес-логики цикла.
 */
export async function handleProxyError(args: {
  db: SupabaseClient;
  account: OutreachAccount;
  reason: ProxyErrorReason;
  log: (level: 'info' | 'warning' | 'error', msg: string) => void;
}): Promise<{ swappedTo: { id: string; url: string } | null }> {
  const { db, account, reason, log } = args;
  if (!account.proxy_id) return { swappedTo: null }; // прокси не назначен, нечего обновлять

  // 1) per-proxy
  let cooldownSet = false;
  try {
    const r = await recordProxyError(db, account.proxy_id, reason);
    cooldownSet = r.cooldownSet;
    if (cooldownSet) {
      log(
        'warning',
        `Прокси аккаунта ${account.session_name}: ${r.consecutiveErrors} ошибок подряд (${reason}) — ставлю cooldown до ${new Date(r.cooldownUntil ?? '').toLocaleTimeString('ru-RU')}.`,
      );
    } else {
      // До порога эта ветка молчала совсем: аккаунт не подключился, свап не
      // сделан, и в логе после ошибки — тишина. Читалось как «дальше всё
      // само», хотя аккаунт до следующего запуска кампании просто выпал.
      log(
        'info',
        `Прокси аккаунта ${account.session_name}: ошибка ${r.consecutiveErrors} из ${CONSECUTIVE_ERROR_THRESHOLD} подряд (${reason}) — свап пока не делаю, жду подтверждения, что это не разовый сбой.`,
      );
    }
  } catch (e) {
    log('warning', `Не смог записать ошибку прокси в БД (${e instanceof Error ? e.message : String(e)}) — продолжаю.`);
  }

  // 2) per-account «не помог N РАЗНЫХ прокси подряд». Повторный провал того
  //    же прокси счётчик не двигает (см. recordAccountProxyFailure) — иначе на
  //    аккаунте, которому свап запрещён, degraded выпадает по теории
  //    вероятностей на любом сыром пуле, а не по состоянию сессии.
  let degradedMarked = false;
  try {
    const a = await recordAccountProxyFailure(db, account.id, account.proxy_id);
    degradedMarked = a.markedDegraded;
    if (degradedMarked) {
      log(
        'error',
        `Аккаунт ${account.session_name}: ${a.consecutiveProxyFailures} разных прокси подряд не помогли — помечаю degraded, отлёжка 24ч. Сначала проверьте здоровье пула прокси кампании: если брак массовый и на других аккаунтах тоже, дело в пуле. Если пул чистый — похоже на shadow-ban или битую сессию, тогда перевыпустите session_data и снимите degraded в UI.`,
      );
    }
  } catch (e) {
    log('warning', `Не смог записать degraded-стат аккаунта (${e instanceof Error ? e.message : String(e)}).`);
  }

  // 3) автосвап имеет смысл только если прокси действительно ушёл в cooldown
  //    (а не разовый flake) и аккаунт прошёл guard'ы
  if (!cooldownSet || degradedMarked) return { swappedTo: null };

  // Полный отвал: аккаунт вообще не смог войти в Telegram (эти reason приходят
  // только из buildClients). В этом состоянии запрет на свап свежему аккаунту
  // не защищает его, а держит на мёртвом прокси — см. canAutoSwap.
  const fullOutage = reason === 'connect_timeout' || reason === 'tcp_dead';
  const swapGate = canAutoSwap(
    {
      created_at: account.created_at,
      degraded: degradedMarked,
      last_proxy_swap_at: (account as { last_proxy_swap_at?: string | null }).last_proxy_swap_at ?? null,
      proxy_swaps_today: (account as { proxy_swaps_today?: number }).proxy_swaps_today ?? 0,
    },
    { fullOutage },
  );
  if (!swapGate.ok) {
    log('info', `Автосвап прокси для аккаунта ${account.session_name} пропущен: ${swapGate.reason}.`);
    return { swappedTo: null };
  }

  let free: { id: string; url: string } | null = null;
  try {
    free = await findFreeProxy(db, account.campaign_id, {
      excludeProxyIds: [account.proxy_id],
    });
  } catch (e) {
    log('warning', `Не смог найти свободный прокси (${e instanceof Error ? e.message : String(e)}).`);
    return { swappedTo: null };
  }
  if (!free) {
    log(
      'warning',
      `Нет свободного прокси в кампании для свапа у аккаунта ${account.session_name} (все либо в cooldown, либо заняты другими аккаунтами). Аккаунт продолжит на текущем прокси после истечения cooldown.`,
    );
    return { swappedTo: null };
  }

  try {
    const res = await swapAccountProxy(db, {
      accountId: account.id,
      fromProxyId: account.proxy_id,
      toProxyId: free.id,
      reason: `auto:${reason}`,
    });
    if (res.swapped) {
      // даём сессии стабилизироваться на новом IP
      await setAccountAfterSwapCooldown(db, account.id);
      log(
        'warning',
        `Автосвап прокси: аккаунт ${account.session_name} переведён на ${free.url} (${res.swapsToday}-й свап сегодня, причина ${reason}${fullOutage ? ', полный отвал подключения' : ''}). Аккаунт на 30-мин паузе, чтобы Telegram стабилизировался на новом IP.`,
      );
      // Обновляем in-memory state, чтобы следующие итерации видели новый proxy_id
      // и не повторили цикл «свап → ещё ошибка → ещё свап».
      account.proxy_id = free.id;
      return { swappedTo: free };
    } else {
      log(
        'info',
        `Автосвап прокси для аккаунта ${account.session_name} не выполнен: ${res.refusalReason ?? 'unknown'}.`,
      );
    }
  } catch (e) {
    log('warning', `Не смог свапнуть прокси через RPC (${e instanceof Error ? e.message : String(e)}).`);
  }

  return { swappedTo: null };
}
