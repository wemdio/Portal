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
export function canAutoSwap(account: {
  created_at: string;
  degraded: boolean;
  last_proxy_swap_at: string | null;
  proxy_swaps_today: number;
}): { ok: true } | { ok: false; reason: string } {
  if (account.degraded) return { ok: false, reason: 'account_degraded' };

  const createdMs = new Date(account.created_at).getTime();
  const ageDays = (Date.now() - createdMs) / (24 * 3600 * 1000);
  if (ageDays < ACCOUNT_FRESH_DAYS) {
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
 * Зафиксировать «провал прокси у аккаунта». Если consecutive_proxy_failures
 * достиг порога — пометить degraded и поставить cooldown 24ч.
 *
 * Это вызывается из campaignLoop ПОСЛЕ того, как мы попытались свапнуть
 * прокси (или решили не свапать). Совершенно отдельно от per-proxy
 * counters: один и тот же прокси может «отлежаться» и вернуться,
 * но если у аккаунта подряд 3 разных прокси провалились — проблема в
 * аккаунте, не в прокси.
 */
export async function recordAccountProxyFailure(
  db: SupabaseClient,
  accountId: string,
): Promise<{
  consecutiveProxyFailures: number;
  markedDegraded: boolean;
}> {
  const { data: row } = await db
    .from('tg_outreach_accounts')
    .select('consecutive_proxy_failures')
    .eq('id', accountId)
    .maybeSingle();
  const prev = (row as { consecutive_proxy_failures: number | null } | null)?.consecutive_proxy_failures ?? 0;
  const next = prev + 1;
  const shouldDegrade = next >= DEGRADED_PROXY_FAILURE_THRESHOLD;
  const now = new Date();

  const patch: Record<string, unknown> = {
    consecutive_proxy_failures: next,
  };
  if (shouldDegrade) {
    patch.degraded = true;
    patch.degraded_at = now.toISOString();
    patch.degraded_reason = 'multiple_proxies_failed';
    patch.cooldown_until = new Date(now.getTime() + DEGRADED_COOLDOWN_HOURS * 3600 * 1000).toISOString();
  }
  await db.from('tg_outreach_accounts').update(patch).eq('id', accountId);

  return { consecutiveProxyFailures: next, markedDegraded: shouldDegrade };
}

/**
 * Зафиксировать успешный круг аккаунта — сбросить consecutive_proxy_failures.
 * НЕ снимает degraded автоматически (это всегда ручная операция оператора).
 */
export async function recordAccountSuccess(
  db: SupabaseClient,
  accountId: string,
): Promise<void> {
  await db
    .from('tg_outreach_accounts')
    .update({ consecutive_proxy_failures: 0 })
    .eq('id', accountId);
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
