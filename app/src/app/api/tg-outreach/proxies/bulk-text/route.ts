import { NextResponse } from 'next/server';
import { withTgOutreachAuth } from '@/lib/tgOutreach/apiHelper';
import { normalizeProxyUrl } from '@/lib/tgOutreach/apiHelpers';

export const dynamic = 'force-dynamic';

type ProxyType = 'HTTP' | 'SOCKS4' | 'SOCKS5';

function toProxyType(value: string): ProxyType {
  const v = value.trim().toUpperCase();
  if (v === 'SOCKS4' || v === 'SOCKS5') return v;
  return 'HTTP';
}

function parseProxyUrl(value: string) {
  try {
    const url = new URL(value);
    const type = toProxyType(url.protocol.replace(':', ''));
    const port = Number(url.port);
    if (!url.hostname || !port) return null;
    return {
      ip: url.hostname,
      port,
      login: decodeURIComponent(url.username || ''),
      password: decodeURIComponent(url.password || ''),
      type,
    };
  } catch {
    return null;
  }
}

function parseProxyLine(value: string) {
  const line = value.trim();
  if (!line || line.startsWith('#')) return null;
  if (line.includes('://')) return parseProxyUrl(line);

  // Нестандартные форматы (host:port:user:pass, host:port@user:pass,
  // user:pass@host:port, host:port) — нормализуем единой утилитой и пускаем
  // через тот же URL-парсер. Раньше тут был свой split(':') который ломался
  // на формате pool.proxy.market: `host:port@user:pass` (port парсился как
  // `10989@vvCcRyAQjR` и улетал в NaN).
  const normalized = normalizeProxyUrl(line);
  if (normalized.includes('://')) {
    const parsed = parseProxyUrl(normalized);
    if (parsed) return parsed;
  }

  // Defensive fallback: чистый `host:port` мог не пройти normalizeProxyUrl
  // (теоретически), но это валидный прокси без креденшлов — пытаемся
  // распарсить как раньше split'ом.
  const chunks = line.split(':').map((s) => s.trim()).filter(Boolean);
  if (chunks.length < 2) return null;
  const [ip, rawPort, login = '', password = ''] = chunks;
  const port = Number(rawPort);
  if (!ip || !port) return null;
  return { ip, port, login, password, type: 'HTTP' as ProxyType };
}

export const POST = withTgOutreachAuth(async (req, { supabase, userId }) => {
  const body = await req.json();
  const text = typeof body.text === 'string' ? body.text : '';

  const lines = text.split(/\r?\n/).filter((l: string) => l.trim());
  if (!lines.length) {
    return NextResponse.json({ error: 'Вставьте хотя бы одну строку с прокси' }, { status: 400 });
  }

  const parsed: Array<{ ip: string; port: number; login: string; password: string; type: ProxyType; line: string }> = [];
  const failed: string[] = [];

  for (const line of lines) {
    const result = parseProxyLine(line);
    if (result) {
      parsed.push({ ...result, line: line.trim() });
    } else {
      failed.push(line.trim());
    }
  }

  if (!parsed.length) {
    return NextResponse.json({
      error: 'Не удалось распознать ни одной строки прокси',
      failed,
    }, { status: 400 });
  }

  const rows = parsed.map(({ line, ...rest }) => ({
    ...rest,
    notes: line,
    created_by: userId,
  }));

  const { data, error } = await supabase
    .from('tg_pool_proxies')
    .insert(rows)
    .select('*');

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    items: data ?? [],
    count: data?.length ?? 0,
    failed,
  }, { status: 201 });
});
