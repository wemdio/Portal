import { NextResponse } from 'next/server';
import { withTgOutreachAuth } from '@/lib/tgOutreach/apiHelper';

export const dynamic = 'force-dynamic';

type ProxyType = 'HTTP' | 'SOCKS4' | 'SOCKS5';

function toText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function toProxyType(value: unknown): ProxyType {
  const v = toText(value).toUpperCase();
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
      notes: '',
    };
  } catch {
    return null;
  }
}

function parseProxyLine(value: string) {
  const line = value.trim();
  if (!line || line.startsWith('#')) return null;
  if (line.includes('://')) {
    return parseProxyUrl(line);
  }

  const chunks = line.split(':').map((part) => part.trim()).filter(Boolean);
  if (chunks.length < 2) return null;

  const [ip, rawPort, login = '', password = ''] = chunks;
  const port = Number(rawPort);
  if (!ip || !port) return null;
  return { ip, port, login, password, type: 'HTTP' as ProxyType, notes: '' };
}

function parseProxyObject(raw: Record<string, unknown>) {
  const url = toText(raw.url);
  if (url) {
    const fromUrl = parseProxyUrl(url);
    if (fromUrl) {
      return { ...fromUrl, notes: toText(raw.notes) || fromUrl.notes };
    }
  }

  const ip = toText(raw.ip) || toText(raw.host);
  const port = Number(raw.port);
  if (!ip || !port) return null;

  return {
    ip,
    port,
    login: toText(raw.login) || toText(raw.username),
    password: toText(raw.password),
    type: toProxyType(raw.type),
    notes: toText(raw.notes),
  };
}

function parseProxyJson(text: string) {
  const parsed = JSON.parse(text) as unknown;
  const items = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).items)
      ? (parsed as { items: unknown[] }).items
      : [parsed];

  return items.flatMap((item) => {
    if (typeof item === 'string') {
      const parsedLine = parseProxyLine(item);
      return parsedLine ? [parsedLine] : [];
    }
    if (item && typeof item === 'object') {
      const parsedObj = parseProxyObject(item as Record<string, unknown>);
      return parsedObj ? [parsedObj] : [];
    }
    return [];
  });
}

export const POST = withTgOutreachAuth(async (req, { supabase, userId }) => {
  const formData = await req.formData();
  const files = formData.getAll('files') as File[];
  if (!files.length) {
    return NextResponse.json({ error: 'Добавьте файлы с прокси' }, { status: 400 });
  }

  const rows: Array<Record<string, unknown>> = [];

  for (const file of files) {
    const filename = file.name.trim();
    const lower = filename.toLowerCase();
    const text = await file.text();
    let parsedItems: Array<{ ip: string; port: number; login: string; password: string; type: ProxyType; notes: string }> = [];

    try {
      if (lower.endsWith('.json')) {
        parsedItems = parseProxyJson(text);
      } else {
        parsedItems = text
          .split(/\r?\n/g)
          .flatMap((line) => {
            const parsed = parseProxyLine(line);
            return parsed ? [parsed] : [];
          });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Ошибка чтения файла';
      return NextResponse.json({ error: `Ошибка в ${filename}: ${msg}` }, { status: 400 });
    }

    parsedItems.forEach((item) => {
      rows.push({
        ...item,
        notes: item.notes || `Импортировано из ${filename}`,
        created_by: userId,
      });
    });
  }

  if (!rows.length) {
    return NextResponse.json({ error: 'Не найдено валидных прокси в выбранных файлах' }, { status: 400 });
  }

  const { data, error } = await supabase
    .from('tg_pool_proxies')
    .insert(rows)
    .select('*');

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ items: data ?? [], count: data?.length ?? 0 }, { status: 201 });
});
