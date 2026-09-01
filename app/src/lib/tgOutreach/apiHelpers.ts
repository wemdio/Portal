import { NextResponse } from 'next/server';
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import { isInternalUser } from '@/lib/auth/internalGuard';

export function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Normalize a proxy URL for storage in tg_outreach_proxies.
 *
 * History: original code force-rewrote `http://` -> `socks5://` because we
 * briefly tried SOCKS as the default transport. Then we built a custom
 * HttpConnectSocket that tunnels MTProto over HTTP CONNECT on port 443
 * (the only path that doesn't trip Infatica's err_protocol DPI on :80 and
 * get our prod IP banned). All running campaigns use `http://` and the
 * SOCKS code path is effectively unused — but the create/import endpoints
 * were still rewriting fresh user input back to `socks5://`, which silently
 * broke every newly-created campaign with `connect timeout (15s)`.
 *
 * Поддерживаемые форматы (в порядке проверки):
 *   1. `<scheme>://...`     — http/https/socks4/socks5 → как есть.
 *   2. `host:port:user:pass` — типичный экспорт от Infatica/Proxy6/AstroProxy.
 *      Раньше попадал в `http://host:port:user:pass`, который new URL() не
 *      парсит — INSERT в БД проходил, но gramClient.parseProxyUrl()
 *      возвращал undefined, кампания подключалась без прокси и сразу банилась.
 *      Теперь конвертим в `http://user:pass@host:port` — валидный URL.
 *   3. `user:pass@host:port` → `http://user:pass@host:port` (стандарт).
 *   4. `host:port@user:pass` → `http://user:pass@host:port`.
 *      Pool.proxy.market и аналогичные провайдеры экспортируют именно так:
 *      сначала host:port, потом учётка. Если оставить как `http://host:port@user:pass`,
 *      то `new URL()` принимает строку, но трактует `host:port` как userInfo,
 *      а `user:pass` как hostname:port — реальный коннект уходит в никуда.
 *   5. `host:port`           → `http://host:port`.
 */
// Провайдеры (Infatica, pool.proxy.market и т.п.) иногда экспортируют тип
// прокси как последний сегмент: `host:port:user:pass:HTTP`. Без этого guard'а
// хвостовой `HTTP` склеивался с паролем в split на 4+ части, и в БД уходил
// URL с `%3AHTTP` в user-info — коннект летел с невалидной учёткой (см. фикс
// 402 строк в tg_outreach_proxies 2026-07-02). Тип тут отбрасываем: URL-путь
// поддерживает только http:// (см. коммент выше про HttpConnectSocket).
const PROXY_TYPE_SUFFIX = /:(?:HTTP|HTTPS|SOCKS4|SOCKS5)$/i;

/**
 * Имя прокси по умолчанию — `хост:порт`.
 *
 * Массовая загрузка раньше подписывала строки как «Прокси 1», «Прокси 2», и
 * нумерация начиналась заново на каждой загрузке: в кампании с 140 адресами
 * половина имён повторялась, а по имени нельзя было понять, какой канал пула
 * перед тобой. Хост с портом отличает строки друг от друга и совпадает с тем,
 * как их называет сам провайдер.
 */
export interface ProxyImportRow {
  campaign_id: string;
  url: string;
  name: string;
  is_active: boolean;
}

/**
 * Строки массовой загрузки прокси — в готовые записи, без дублей.
 *
 * Отсекаем двойников дважды: против уже заведённых в кампании адресов и внутри
 * самого списка. Дубль прокси — это не лишняя строка в таблице, а два аккаунта
 * на одном канале пула, то есть на одном устройстве с точки зрения Telegram;
 * ровно за это он и блокирует. На момент правки в базе лежало 598 записей на
 * 532 уникальных адреса — накопилось повторными загрузками одного списка.
 *
 * Сравниваем нормализованные адреса: провайдеры отдают один и тот же прокси в
 * разных написаниях (`host:port@user:pass` и `user:pass@host:port`), и без
 * нормализации они выглядят как две разные строки.
 */
export function buildProxyImportRows(
  lines: string[],
  existingUrls: string[],
  campaignId: string,
): { rows: ProxyImportRow[]; skipped: number } {
  const known = new Set(existingUrls.map((u) => normalizeProxyUrl((u ?? '').trim())).filter(Boolean));
  const rows: ProxyImportRow[] = [];
  for (const raw of lines) {
    const url = normalizeProxyUrl((raw ?? '').trim());
    if (!url || known.has(url)) continue;
    known.add(url);
    rows.push({ campaign_id: campaignId, url, name: proxyDisplayName(url), is_active: true });
  }
  return { rows, skipped: lines.length - rows.length };
}

export function proxyDisplayName(url: string): string {
  try {
    const u = new URL(url);
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return url.slice(0, 80);
  }
}

export function normalizeProxyUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  if (trimmed.includes('://')) return trimmed;

  const working = trimmed.replace(PROXY_TYPE_SUFFIX, '');

  // host:port:user:pass — четыре сегмента через двоеточие, без `@`.
  // Допускаем что в pass могут встречаться `:` — поэтому split на максимум 4
  // не подойдёт, но split с лимитом 4 даёт нам ['host', 'port', 'user', 'rest'],
  // где rest может содержать `:` (для редких паролей с двоеточием).
  if (!working.includes('@')) {
    const parts = working.split(':');
    if (parts.length >= 4) {
      const [host, port, user, ...passParts] = parts;
      const pass = passParts.join(':');
      if (host && /^\d+$/.test(port) && user && pass) {
        return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
      }
    }
    return `http://${working}`;
  }

  // Дальше есть `@`. Два формата с одной точкой разделения:
  //   а) user:pass@host:port — стандартный URL userinfo.
  //   б) host:port@user:pass — pool.proxy.market и т.п.
  //
  // Разница в том, на какой стороне от `@` лежит «:<число>» (порт). Если
  // справа — это (а), оборачиваем в http://. Если слева — это (б),
  // переставляем стороны местами. lastIndexOf('@') страхует от редкого случая
  // когда пароль содержит `@` в стандартном формате (а).
  const atIdx = working.lastIndexOf('@');
  const left = working.slice(0, atIdx);
  const right = working.slice(atIdx + 1);
  const endsWithPort = /:\d+$/;

  if (endsWithPort.test(right)) {
    // user:pass@host:port — отдаём «как есть» под http://. Кодировать
    // user/pass смысла нет: если они уже встретили `@`, значит пользователь
    // подразумевает именно такой формат, и percent-encoding только сломает то,
    // что уже валидно.
    return `http://${working}`;
  }

  if (endsWithPort.test(left)) {
    // host:port@user:pass — переставляем стороны.
    const colonIdx = left.lastIndexOf(':');
    const host = left.slice(0, colonIdx);
    const port = left.slice(colonIdx + 1);
    const credIdx = right.indexOf(':');
    if (credIdx >= 0) {
      const user = right.slice(0, credIdx);
      const pass = right.slice(credIdx + 1);
      return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
    }
    // Только user без пароля справа — нетипично, но не теряем данные.
    return `http://${encodeURIComponent(right)}@${host}:${port}`;
  }

  return `http://${working}`;
}

export async function authenticateRequest(authHeader: string | null) {
  const token = getBearerToken(authHeader);
  if (!token) return { error: jsonError('Необходима авторизация', 401) } as const;

  const supabase = createAuthedSupabaseClient(token);
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { error: jsonError('Необходима авторизация', 401) } as const;
    // /api/tools/* are internal (staff) tools — not reachable from the client
    // portal UI, but middleware doesn't gate /api/* by role. Enforce staff-only
    // here so a client/demo JWT can't drive real outreach via crafted requests.
    if (!(await isInternalUser(supabase, user.id))) {
      return { error: jsonError('Доступ только для сотрудников', 403) } as const;
    }
    return { supabase, user } as const;
  } catch (error) {
    console.error('[auth] supabase getUser failed', error);
    return { error: jsonError('Сервис авторизации временно недоступен', 503) } as const;
  }
}
