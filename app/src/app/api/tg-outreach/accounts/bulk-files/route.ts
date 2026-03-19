import { NextResponse } from 'next/server';
import { withTgOutreachAuth } from '@/lib/tgOutreach/apiHelper';

export const dynamic = 'force-dynamic';

type AccountStatus = 'active' | 'banned' | 'frozen' | 'limited';

function basename(filename: string): string {
  const name = filename.replace(/\.(json|session)$/i, '');
  return name || filename;
}

function toText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeStatus(value: unknown): AccountStatus {
  const status = toText(value);
  if (status === 'banned' || status === 'frozen' || status === 'limited') return status;
  return 'active';
}

function parseAccountObj(raw: Record<string, unknown>, sessionBuffer?: ArrayBuffer) {
  const format = toText(raw.format) === 'tdata' ? 'tdata' : 'session_json';
  const explicitSessionData = raw.session_data;
  const sessionString =
    toText(raw.session_string) ||
    toText(raw.session_data) ||
    toText((raw.session_data as Record<string, unknown> | undefined)?.session_string);

  const sessionData: Record<string, unknown> =
    explicitSessionData && typeof explicitSessionData === 'object' && !Array.isArray(explicitSessionData)
      ? { ...(explicitSessionData as Record<string, unknown>) }
      : {};

  if (sessionString) {
    sessionData.session_string = sessionString;
  }
  if (sessionBuffer) {
    sessionData.session_file_base64 = Buffer.from(sessionBuffer).toString('base64');
  }

  const phone = toText(raw.phone);
  const firstName = toText(raw.first_name);
  const lastName = toText(raw.last_name);
  const username = toText(raw.username);

  return {
    format,
    session_data: sessionData,
    phone,
    first_name: firstName,
    last_name: lastName,
    username,
    bio: toText(raw.bio),
    notes: toText(raw.notes),
    status: normalizeStatus(raw.status),
  };
}

function parseAccountJson(text: string, sessionBuffer?: ArrayBuffer) {
  const parsed = JSON.parse(text) as unknown;
  if (Array.isArray(parsed)) {
    return parsed
      .filter((item) => item && typeof item === 'object')
      .map((item, idx) => parseAccountObj(item as Record<string, unknown>, idx === 0 ? sessionBuffer : undefined));
  }
  if (parsed && typeof parsed === 'object') {
    return [parseAccountObj(parsed as Record<string, unknown>, sessionBuffer)];
  }
  return [];
}

export const POST = withTgOutreachAuth(async (req, { supabase, userId }) => {
  const formData = await req.formData();
  const files = formData.getAll('files') as File[];
  if (!files.length) {
    return NextResponse.json({ error: 'Добавьте файлы с аккаунтами' }, { status: 400 });
  }

  const byBase = new Map<string, { json?: string; session?: ArrayBuffer }>();
  for (const file of files) {
    const name = file.name.trim();
    const base = basename(name);
    const entry = byBase.get(base) ?? {};
    if (name.toLowerCase().endsWith('.json')) {
      entry.json = await file.text();
    } else if (name.toLowerCase().endsWith('.session')) {
      entry.session = await file.arrayBuffer();
    }
    byBase.set(base, entry);
  }

  const rows: Array<Record<string, unknown>> = [];
  for (const [base, item] of byBase) {
    if (!item.json) continue;
    try {
      const parsed = parseAccountJson(item.json, item.session);
      parsed.forEach((row) => {
        rows.push({
          ...row,
          notes: row.notes || `Импортировано из ${base}.json`,
          created_by: userId,
        });
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Неверный JSON';
      return NextResponse.json({ error: `Ошибка в ${base}.json: ${msg}` }, { status: 400 });
    }
  }

  if (!rows.length) {
    return NextResponse.json({ error: 'Не найдено валидных JSON файлов с аккаунтами' }, { status: 400 });
  }

  const { data, error } = await supabase
    .from('tg_pool_accounts')
    .insert(rows)
    .select('*');

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ items: data ?? [], count: data?.length ?? 0 }, { status: 201 });
});
