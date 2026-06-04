import { NextResponse } from 'next/server';
import { getBearerToken, createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';

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
export function normalizeProxyUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  if (trimmed.includes('://')) return trimmed;

  // host:port:user:pass — четыре сегмента через двоеточие, без `@`.
  // Допускаем что в pass могут встречаться `:` — поэтому split на максимум 4
  // не подойдёт, но split с лимитом 4 даёт нам ['host', 'port', 'user', 'rest'],
  // где rest может содержать `:` (для редких паролей с двоеточием).
  if (!trimmed.includes('@')) {
    const parts = trimmed.split(':');
    if (parts.length >= 4) {
      const [host, port, user, ...passParts] = parts;
      const pass = passParts.join(':');
      if (host && /^\d+$/.test(port) && user && pass) {
        return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
      }
    }
    return `http://${trimmed}`;
  }

  // Дальше есть `@`. Два формата с одной точкой разделения:
  //   а) user:pass@host:port — стандартный URL userinfo.
  //   б) host:port@user:pass — pool.proxy.market и т.п.
  //
  // Разница в том, на какой стороне от `@` лежит «:<число>» (порт). Если
  // справа — это (а), оборачиваем в http://. Если слева — это (б),
  // переставляем стороны местами. lastIndexOf('@') страхует от редкого случая
  // когда пароль содержит `@` в стандартном формате (а).
  const atIdx = trimmed.lastIndexOf('@');
  const left = trimmed.slice(0, atIdx);
  const right = trimmed.slice(atIdx + 1);
  const endsWithPort = /:\d+$/;

  if (endsWithPort.test(right)) {
    // user:pass@host:port — отдаём «как есть» под http://. Кодировать
    // user/pass смысла нет: если они уже встретили `@`, значит пользователь
    // подразумевает именно такой формат, и percent-encoding только сломает то,
    // что уже валидно.
    return `http://${trimmed}`;
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

  return `http://${trimmed}`;
}

export async function authenticateRequest(authHeader: string | null) {
  const token = getBearerToken(authHeader);
  if (!token) return { error: jsonError('Необходима авторизация', 401) } as const;

  const supabase = createAuthedSupabaseClient(token);
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { error: jsonError('Необходима авторизация', 401) } as const;
    return { supabase, user } as const;
  } catch (error) {
    console.error('[auth] supabase getUser failed', error);
    return { error: jsonError('Сервис авторизации временно недоступен', 503) } as const;
  }
}
